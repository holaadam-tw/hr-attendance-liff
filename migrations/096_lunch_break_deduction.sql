-- ============================================================
-- 096: 午休不計工時（公司層級設定）
--
-- 需求：業主確認 08:00–17:00 的班中午休息 12:00–13:00 不計入工時
--       （例：08:00 上班卡、17:00 下班卡 → 工時 8h，非 9h）。
--
-- 設計：
--   - 午休時段做成公司層級設定 system_settings：
--       lunch_break_start / lunch_break_end（TEXT 'HH:MM'）
--     兩個都有設定才會扣；未設定的公司行為完全不變。
--   - 本 migration 只幫「大正科技」設定 12:00–13:00。
--     本米是餐飲業，12:00–13:00 是午餐尖峰（員工在上班），不啟用；
--     之後要啟用只需 INSERT 兩筆 system_settings。
--
-- 扣除規則：工作區間與午休時段的「重疊部分」才扣——
--   半天班 08:00–12:00 → 不扣；12:30 打下班 → 只扣 0.5h；
--   13:00 後才上班 → 不扣。跨日班另檢查翌日午休視窗。
--
-- 修改點（工時的單一事實來源）：
--   1. 新增 lunch_overlap_hours() 助手（吃台北牆鐘時間）
--   2. calc_work_hours() trigger 函數（010 建立，attendance 的
--      check_in_time/check_out_time 一變就重算 total_work_hours）。
--      quick_check_in(073)、kiosk_check_in(082)、
--      approve_makeup_request(086)、quick_check_out_after_clock_in_makeup(080)
--      的寫入全部經過此 trigger，改這一處即全路徑生效，
--      各 RPC 內的 total_work_hours 計算式不需改（會被 trigger 覆蓋）。
--   3. calc_payable_work_hours()（077，月度統計用）：
--      夾限後的有效區間再扣午休重疊。
--   4. 大正歷史 attendance 回溯重算（touch update 觸發 trigger），
--      確保每日總覽新舊日期工時口徑一致。
--      092 的 resolve_anomaly_on_checkout 有 OLD.check_out_time IS NULL
--      保護，touch update 不會誤觸自動結案。
--
-- 薪資影響：月薪制無金額影響（底薪固定）；時薪制月薪 = 時薪×工時，
--   大正若有時薪制員工實拿會反映午休扣除（業主已於 2026-07-16 確認全面實作）。
-- ============================================================

-- ===== 1. 午休重疊時數助手 =====
-- p_start / p_end 必須是台北牆鐘時間（timestamp without time zone）
CREATE OR REPLACE FUNCTION lunch_overlap_hours(
    p_company_id UUID,
    p_date DATE,
    p_start TIMESTAMP,
    p_end TIMESTAMP
) RETURNS NUMERIC
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
AS $$
DECLARE
    v_lunch_start TIME;
    v_lunch_end TIME;
    v_overlap NUMERIC := 0;
BEGIN
    IF p_company_id IS NULL OR p_date IS NULL
       OR p_start IS NULL OR p_end IS NULL OR p_end <= p_start THEN
        RETURN 0;
    END IF;

    SELECT NULLIF(value #>> '{}', '')::TIME INTO v_lunch_start
    FROM system_settings
    WHERE company_id = p_company_id AND key = 'lunch_break_start';

    SELECT NULLIF(value #>> '{}', '')::TIME INTO v_lunch_end
    FROM system_settings
    WHERE company_id = p_company_id AND key = 'lunch_break_end';

    IF v_lunch_start IS NULL OR v_lunch_end IS NULL OR v_lunch_end <= v_lunch_start THEN
        RETURN 0;
    END IF;

    -- 當日午休視窗重疊 + 翌日午休視窗重疊（跨日班）
    v_overlap :=
        GREATEST(0, EXTRACT(EPOCH FROM (
            LEAST(p_end, p_date + v_lunch_end) - GREATEST(p_start, p_date + v_lunch_start)
        )) / 3600.0)
      + GREATEST(0, EXTRACT(EPOCH FROM (
            LEAST(p_end, (p_date + 1) + v_lunch_end) - GREATEST(p_start, (p_date + 1) + v_lunch_start)
        )) / 3600.0);

    RETURN v_overlap::numeric;
END;
$$;

-- 僅供 trigger / SECURITY DEFINER RPC 內部使用；
-- service_role 保留權限（管理端 REST 直改 attendance 時 trigger 仍需執行）
REVOKE ALL ON FUNCTION lunch_overlap_hours(UUID, DATE, TIMESTAMP, TIMESTAMP) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION lunch_overlap_hours(UUID, DATE, TIMESTAMP, TIMESTAMP) TO service_role;

-- ===== 2. 工時計算 trigger（基於 010，加午休扣除） =====
CREATE OR REPLACE FUNCTION calc_work_hours()
RETURNS TRIGGER AS $$
DECLARE
    v_company_id UUID;
    v_lunch NUMERIC := 0;
BEGIN
    IF NEW.check_in_time IS NOT NULL AND NEW.check_out_time IS NOT NULL THEN
        SELECT e.company_id INTO v_company_id
        FROM employees e
        WHERE e.id = NEW.employee_id;

        v_lunch := lunch_overlap_hours(
            v_company_id,
            NEW.date,
            (NEW.check_in_time AT TIME ZONE 'Asia/Taipei'),
            (NEW.check_out_time AT TIME ZONE 'Asia/Taipei')
        );

        NEW.total_work_hours := GREATEST(0, ROUND(
            (EXTRACT(EPOCH FROM (NEW.check_out_time - NEW.check_in_time)) / 3600.0 - v_lunch)::numeric,
            2
        ));
    END IF;
    NEW.updated_at := now();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- trigger 本體（010 已建立）不需重建：
-- BEFORE INSERT OR UPDATE OF check_in_time, check_out_time ON attendance

-- 衛生性收斂：trigger 函數本來就不能被 rpc() 直接呼叫，明確 REVOKE 做防禦深度
REVOKE ALL ON FUNCTION calc_work_hours() FROM PUBLIC, anon, authenticated;

-- ===== 3. 月度統計工時（基於 077，夾限後再扣午休） =====
CREATE OR REPLACE FUNCTION calc_payable_work_hours(
    p_attendance_id UUID
) RETURNS NUMERIC
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
AS $$
DECLARE
    v_rec RECORD;
    v_shift_start TIME;
    v_shift_end TIME;
    v_is_overnight BOOLEAN := false;
    v_setting_val TEXT;
    v_start_ts TIMESTAMP;
    v_end_ts TIMESTAMP;
    v_check_in_ts TIMESTAMP;
    v_check_out_ts TIMESTAMP;
    v_effective_start TIMESTAMP;
    v_effective_end TIMESTAMP;
    v_lunch NUMERIC := 0;
BEGIN
    SELECT
        a.id,
        a.date,
        a.check_in_time,
        a.check_out_time,
        COALESCE(a.total_work_hours, 0) AS raw_total_work_hours,
        e.company_id,
        e.fixed_shift_start,
        e.fixed_shift_end,
        st.start_time AS schedule_start,
        st.end_time AS schedule_end,
        COALESCE(st.is_overnight, false) AS schedule_is_overnight
    INTO v_rec
    FROM attendance a
    JOIN employees e ON e.id = a.employee_id
    LEFT JOIN schedules s
        ON s.employee_id = a.employee_id
       AND s.date = a.date
       AND COALESCE(s.is_off_day, false) = false
    LEFT JOIN shift_types st ON st.id = s.shift_type_id
    WHERE a.id = p_attendance_id;

    IF v_rec.id IS NULL THEN
        RETURN 0;
    END IF;

    IF v_rec.check_in_time IS NULL OR v_rec.check_out_time IS NULL THEN
        RETURN COALESCE(v_rec.raw_total_work_hours, 0);
    END IF;

    v_shift_start := COALESCE(v_rec.schedule_start, v_rec.fixed_shift_start);
    v_shift_end := COALESCE(v_rec.schedule_end, v_rec.fixed_shift_end);
    v_is_overnight := COALESCE(v_rec.schedule_is_overnight, false);

    IF v_shift_start IS NULL THEN
        SELECT value #>> '{}' INTO v_setting_val
        FROM system_settings
        WHERE company_id = v_rec.company_id
          AND key = CASE
                WHEN EXTRACT(DOW FROM v_rec.date) IN (0, 6) THEN 'default_weekend_work_start'
                ELSE 'default_weekday_work_start'
              END;

        IF COALESCE(v_setting_val, '') = '' THEN
            SELECT value #>> '{}' INTO v_setting_val
            FROM system_settings
            WHERE company_id = v_rec.company_id
              AND key = 'default_work_start';
        END IF;

        v_shift_start := COALESCE(v_setting_val, '08:00')::time;
    END IF;

    IF v_shift_end IS NULL THEN
        SELECT value #>> '{}' INTO v_setting_val
        FROM system_settings
        WHERE company_id = v_rec.company_id
          AND key = CASE
                WHEN EXTRACT(DOW FROM v_rec.date) IN (0, 6) THEN 'default_weekend_work_end'
                ELSE 'default_weekday_work_end'
              END;

        IF COALESCE(v_setting_val, '') = '' THEN
            SELECT value #>> '{}' INTO v_setting_val
            FROM system_settings
            WHERE company_id = v_rec.company_id
              AND key = 'default_work_end';
        END IF;

        v_shift_end := COALESCE(v_setting_val, '17:00')::time;
    END IF;

    IF v_shift_end < v_shift_start THEN
        v_is_overnight := true;
    END IF;

    v_start_ts := v_rec.date::timestamp + v_shift_start;
    v_end_ts := v_rec.date::timestamp + v_shift_end;
    IF v_is_overnight THEN
        v_end_ts := v_end_ts + interval '1 day';
    END IF;

    v_check_in_ts := v_rec.check_in_time AT TIME ZONE 'Asia/Taipei';
    v_check_out_ts := v_rec.check_out_time AT TIME ZONE 'Asia/Taipei';

    v_effective_start := GREATEST(v_check_in_ts, v_start_ts);
    v_effective_end := LEAST(v_check_out_ts, v_end_ts);

    IF v_effective_end <= v_effective_start THEN
        RETURN 0;
    END IF;

    -- 096：夾限後的有效工作區間再扣午休重疊
    v_lunch := lunch_overlap_hours(v_rec.company_id, v_rec.date, v_effective_start, v_effective_end);

    RETURN GREATEST(0, ROUND(
        (EXTRACT(EPOCH FROM (v_effective_end - v_effective_start)) / 3600 - v_lunch)::numeric,
        2
    ));
END;
$$;

-- ===== 4. 大正科技啟用午休 12:00–13:00 =====
DO $$
DECLARE
    v_company_id CONSTANT UUID := '8a669e2c-7521-43e9-9300-5c004c57e9db';
BEGIN
    UPDATE system_settings
    SET value = to_jsonb('12:00'::text), description = '午休開始（此時段不計工時）', updated_at = now()
    WHERE company_id = v_company_id AND key = 'lunch_break_start';
    IF NOT FOUND THEN
        INSERT INTO system_settings (company_id, key, value, description)
        VALUES (v_company_id, 'lunch_break_start', to_jsonb('12:00'::text), '午休開始（此時段不計工時）');
    END IF;

    UPDATE system_settings
    SET value = to_jsonb('13:00'::text), description = '午休結束（此時段不計工時）', updated_at = now()
    WHERE company_id = v_company_id AND key = 'lunch_break_end';
    IF NOT FOUND THEN
        INSERT INTO system_settings (company_id, key, value, description)
        VALUES (v_company_id, 'lunch_break_end', to_jsonb('13:00'::text), '午休結束（此時段不計工時）');
    END IF;
END $$;

-- ===== 5. 大正歷史工時回溯重算 =====
-- touch update 觸發 calc_work_hours trigger 以新規則重算 total_work_hours。
-- 只動大正（本米未啟用午休設定，重算結果不變，不需白跑）。
UPDATE attendance a
SET check_out_time = a.check_out_time
FROM employees e
WHERE e.id = a.employee_id
  AND e.company_id = '8a669e2c-7521-43e9-9300-5c004c57e9db'
  AND a.check_in_time IS NOT NULL
  AND a.check_out_time IS NOT NULL;
