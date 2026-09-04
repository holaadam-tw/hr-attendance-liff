-- ============================================================
-- 117: 請假重疊防呆 ＋ 移除正式庫殘留的「日曆天」觸發器
--
-- 背景（2026-09-04 稽核，依業主兩點反映）：
-- 1. 「連續請假含六日，六日不應算天數」：
--    migration 095/113 的 submit_leave_request 早已用 count_employee_workdays()
--    只算工作日，但正式庫存在一個 repo 從未納管的觸發器
--      calculate_leave_days_trigger BEFORE INSERT OR UPDATE OF start_date, end_date
--      → calculate_leave_days(): NEW.days := end_date - start_date + 1
--    每次 INSERT 都把 RPC 算好的 days 覆寫回純日曆天。結果：
--      半天假一律存 1.0（應 0.5）、跨週末假單多算 2 天。
--    2026-07-01 起 approved/pending 假單有 15 筆受影響（13 筆半天、2 筆跨週末）。
-- 2. 「同一個人同一天可以請假兩次，沒有阻擋」：
--    submit_leave_request / approve_leave_request 從未查過既有假單，
--    DB 也沒有 UNIQUE/EXCLUDE。正式庫已發生 2 組（E814 8/12 上午+下午、E809 8/21 特休+事假）。
--
-- 本檔做四件事：
-- A. DROP 殘留觸發器與函式（之後 days 唯一來源＝RPC）。
-- B. 新增 find_overlapping_leave() 內部函式（REVOKE anon）。
-- C. submit_leave_request 9 參數版：送出前查同員工、pending/approved、日期交集 → 拒絕。
--    規則採「同一天一律擋」（含上午＋下午、兩段時數假），這是業主的要求；
--    一天內要請兩種假別請改整天假或由主管處理。
--    approve_leave_request：只允許 pending → approved/rejected；核准時若同員工
--    同區間已有 approved 假單 → 拒絕（擋主管手動放行第二筆）。
-- D. 資料修正：2026-07-01 起 approved/pending 且 days 與應有值不符者，依現行規則重算。
--    不動 E809 8/21 那組重疊（兩筆 days 各 1.0 本身正確，重複問題需業主決定退哪筆）。
--
-- 部署方式：僅 migration 檔；正式庫套用需業主結構化授權，走 .codex 單一交易腳本＋事前備份。
-- ============================================================

-- ===== A. 移除正式庫殘留的日曆天觸發器 =====
DROP TRIGGER IF EXISTS calculate_leave_days_trigger ON public.leave_requests;
DROP FUNCTION IF EXISTS public.calculate_leave_days();

-- ===== B. 重疊查詢（內部用；呼叫者皆為 SECURITY DEFINER RPC） =====
CREATE OR REPLACE FUNCTION public.find_overlapping_leave(
    p_employee_id UUID,
    p_start DATE,
    p_end DATE,
    p_exclude_id UUID DEFAULT NULL,
    p_statuses TEXT[] DEFAULT ARRAY['pending', 'approved']
) RETURNS JSONB
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
    SELECT jsonb_build_object(
        'id', lr.id,
        'start_date', lr.start_date,
        'end_date', COALESCE(lr.end_date, lr.start_date),
        'leave_period', COALESCE(lr.leave_period, 'full_day'),
        'leave_type', lr.leave_type,
        'status', lr.status
    )
    FROM public.leave_requests lr
    WHERE lr.employee_id = p_employee_id
      AND lr.status = ANY(p_statuses)
      AND (p_exclude_id IS NULL OR lr.id <> p_exclude_id)
      AND lr.start_date <= p_end
      AND COALESCE(lr.end_date, lr.start_date) >= p_start
    ORDER BY lr.start_date, lr.created_at
    LIMIT 1;
$$;

REVOKE ALL ON FUNCTION public.find_overlapping_leave(UUID, DATE, DATE, UUID, TEXT[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.find_overlapping_leave(UUID, DATE, DATE, UUID, TEXT[]) TO service_role;

-- 衝突訊息（純函式，方便 RPC 與測試共用）
CREATE OR REPLACE FUNCTION public.leave_overlap_message(p_conflict JSONB, p_prefix TEXT)
RETURNS TEXT
LANGUAGE sql
STABLE
AS $$
    SELECT format(
        '%s（%s%s，%s，%s），請勿重複送出',
        p_prefix,
        to_char((p_conflict->>'start_date')::date, 'MM/DD'),
        CASE WHEN p_conflict->>'end_date' IS DISTINCT FROM p_conflict->>'start_date'
             THEN ' ~ ' || to_char((p_conflict->>'end_date')::date, 'MM/DD') ELSE '' END,
        CASE p_conflict->>'leave_period'
            WHEN 'am' THEN '上午半天'
            WHEN 'pm' THEN '下午半天'
            WHEN 'hourly' THEN '時數假'
            ELSE '全日' END,
        CASE p_conflict->>'status'
            WHEN 'approved' THEN '已核准'
            WHEN 'pending' THEN '待審核'
            ELSE COALESCE(p_conflict->>'status', '') END
    );
$$;

REVOKE ALL ON FUNCTION public.leave_overlap_message(JSONB, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.leave_overlap_message(JSONB, TEXT) TO service_role;

-- ===== C1. submit_leave_request（9 參數版，基於 113，僅新增重疊檢查） =====
CREATE OR REPLACE FUNCTION public.submit_leave_request(
    p_line_user_id TEXT,
    p_company_id UUID,
    p_leave_type VARCHAR,
    p_start_date DATE,
    p_end_date DATE,
    p_reason TEXT,
    p_leave_period TEXT,
    p_leave_start_time TIME,
    p_leave_end_time TIME
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_employee_id UUID;
    v_period TEXT := COALESCE(NULLIF(p_leave_period, ''), 'full_day');
    v_hours NUMERIC;
    v_days NUMERIC;
    v_workdays INTEGER;
    v_calendar_days INTEGER;
    v_conflict JSONB;
BEGIN
    IF p_company_id IS NULL OR p_line_user_id IS NULL OR p_line_user_id = '' THEN
        RETURN jsonb_build_object('success', false, 'error', '缺少公司或登入身分');
    END IF;

    SELECT e.id INTO v_employee_id
    FROM public.employees e
    WHERE e.company_id = p_company_id
      AND e.line_user_id = p_line_user_id
      AND e.is_active = true
    LIMIT 1;

    IF v_employee_id IS NULL THEN
        RETURN jsonb_build_object('success', false, 'error', '找不到此公司的有效員工資料');
    END IF;

    IF p_start_date IS NULL OR p_end_date IS NULL OR p_end_date < p_start_date THEN
        RETURN jsonb_build_object('success', false, 'error', '請假日期不正確');
    END IF;

    IF v_period NOT IN ('full_day', 'am', 'pm', 'hourly') THEN
        RETURN jsonb_build_object('success', false, 'error', '請假時段不正確');
    END IF;

    IF v_period IN ('am', 'pm', 'hourly') AND p_start_date <> p_end_date THEN
        RETURN jsonb_build_object('success', false, 'error', '半天與時數假只能申請同一天');
    END IF;

    IF v_period = 'hourly' THEN
        IF p_leave_start_time IS NULL OR p_leave_end_time IS NULL THEN
            RETURN jsonb_build_object('success', false, 'error', '時數假必須填寫開始與結束時間');
        END IF;
        IF p_leave_end_time <= p_leave_start_time THEN
            RETURN jsonb_build_object('success', false, 'error', '時數假結束時間必須晚於開始時間');
        END IF;
        v_hours := ROUND((EXTRACT(EPOCH FROM (p_leave_end_time - p_leave_start_time)) / 3600.0)::NUMERIC, 2);
        IF v_hours < 1 OR v_hours > 24 THEN
            RETURN jsonb_build_object('success', false, 'error', '時數假至少 1 小時');
        END IF;
    ELSE
        v_hours := NULL;
    END IF;

    -- 117：同員工、pending/approved、日期交集 → 一律拒絕（同一天不可重複請假）
    v_conflict := public.find_overlapping_leave(v_employee_id, p_start_date, p_end_date, NULL);
    IF v_conflict IS NOT NULL THEN
        RETURN jsonb_build_object(
            'success', false,
            'error', public.leave_overlap_message(v_conflict, '同一天已有請假申請'),
            'error_code', 'leave_overlap',
            'conflict', v_conflict
        );
    END IF;

    v_workdays := public.count_employee_workdays(v_employee_id, p_start_date, p_end_date);
    v_calendar_days := (p_end_date - p_start_date) + 1;
    IF v_workdays = 0 THEN
        RETURN jsonb_build_object('success', false, 'error', '所選日期沒有應上班日，無法申請');
    END IF;

    v_days := CASE
        WHEN v_period = 'hourly' THEN ROUND(v_hours / 8.0, 4)
        WHEN v_period IN ('am', 'pm') THEN 0.5
        ELSE v_workdays
    END;

    INSERT INTO public.leave_requests (
        employee_id, leave_type, leave_period, leave_hours,
        leave_start_time, leave_end_time,
        start_date, end_date, days, reason, status
    ) VALUES (
        v_employee_id, p_leave_type, v_period, v_hours,
        CASE WHEN v_period = 'hourly' THEN p_leave_start_time ELSE NULL END,
        CASE WHEN v_period = 'hourly' THEN p_leave_end_time ELSE NULL END,
        p_start_date, p_end_date, v_days, COALESCE(p_reason, ''), 'pending'
    );

    RETURN jsonb_build_object(
        'success', true,
        'days', v_days,
        'leave_period', v_period,
        'leave_hours', v_hours,
        'leave_start_time', CASE WHEN v_period = 'hourly' THEN p_leave_start_time ELSE NULL END,
        'leave_end_time', CASE WHEN v_period = 'hourly' THEN p_leave_end_time ELSE NULL END,
        'excluded_off_days', CASE WHEN v_period = 'full_day' THEN v_calendar_days - v_workdays ELSE 0 END
    );
EXCEPTION WHEN OTHERS THEN
    RETURN jsonb_build_object('success', false, 'error', SQLERRM);
END;
$$;

REVOKE ALL ON FUNCTION public.submit_leave_request(TEXT, UUID, VARCHAR, DATE, DATE, TEXT, TEXT, TIME, TIME) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.submit_leave_request(TEXT, UUID, VARCHAR, DATE, DATE, TEXT, TEXT, TIME, TIME) TO anon, authenticated;

-- ===== C2. approve_leave_request（基於 053，新增狀態與重疊檢查） =====
CREATE OR REPLACE FUNCTION public.approve_leave_request(
    p_request_id UUID,
    p_status TEXT,
    p_approver_id UUID,
    p_rejection_reason TEXT DEFAULT NULL
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_req RECORD;
    v_conflict JSONB;
BEGIN
    IF p_status NOT IN ('approved', 'rejected') THEN
        RETURN jsonb_build_object('success', false, 'error', '無效狀態');
    END IF;

    SELECT lr.*, e.name AS employee_name, e.id AS emp_id
    INTO v_req
    FROM public.leave_requests lr
    JOIN public.employees e ON e.id = lr.employee_id
    WHERE lr.id = p_request_id;

    IF v_req.id IS NULL THEN
        RETURN jsonb_build_object('success', false, 'error', '找不到申請');
    END IF;

    -- 117：只處理待審件，避免同一筆被重複核准／已核准改駁回
    IF v_req.status <> 'pending' THEN
        RETURN jsonb_build_object(
            'success', false,
            'error', format('此申請已處理過（目前狀態：%s）',
                CASE v_req.status WHEN 'approved' THEN '已核准' WHEN 'rejected' THEN '已拒絕' ELSE v_req.status END),
            'error_code', 'not_pending'
        );
    END IF;

    -- 117：核准時若同員工同區間已有核准假單 → 拒絕，擋主管手動放行第二筆
    IF p_status = 'approved' THEN
        v_conflict := public.find_overlapping_leave(
            v_req.employee_id, v_req.start_date, COALESCE(v_req.end_date, v_req.start_date),
            p_request_id, ARRAY['approved']
        );
        IF v_conflict IS NOT NULL THEN
            RETURN jsonb_build_object(
                'success', false,
                'error', public.leave_overlap_message(v_conflict, '該員工同一天已有核准假單') || '，請先退回其中一筆',
                'error_code', 'leave_overlap',
                'conflict', v_conflict
            );
        END IF;
    END IF;

    UPDATE public.leave_requests
    SET status = p_status,
        approver_id = p_approver_id,
        approved_at = now(),
        rejection_reason = CASE
            WHEN p_status = 'rejected' THEN COALESCE(p_rejection_reason, '不符合規定')
            ELSE rejection_reason
        END
    WHERE id = p_request_id
      AND status = 'pending';

    IF NOT FOUND THEN
        RETURN jsonb_build_object('success', false, 'error', '更新失敗');
    END IF;

    RETURN jsonb_build_object(
        'success', true,
        'employee_id', v_req.emp_id,
        'employee_name', v_req.employee_name,
        'leave_type', v_req.leave_type,
        'start_date', v_req.start_date,
        'end_date', v_req.end_date
    );
EXCEPTION WHEN OTHERS THEN
    RETURN jsonb_build_object('success', false, 'error', SQLERRM);
END;
$$;

-- 權限維持與正式庫現況一致（anon/authenticated 可呼叫；呼叫者驗證為既有議題，不在本檔範圍）
REVOKE ALL ON FUNCTION public.approve_leave_request(UUID, TEXT, UUID, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.approve_leave_request(UUID, TEXT, UUID, TEXT) TO anon, authenticated, service_role;

-- ===== D. 資料修正：2026-07-01 起被觸發器覆寫的 days 依現行規則重算 =====
-- 只動 approved/pending 且 days 與應有值不同者；不動 2026-07-01 之前（095 前規則本就是日曆天，薪資已結）。
-- 部署時單獨執行並保留 RETURNING 結果作為證據。
UPDATE public.leave_requests lr
SET days = calc.expected_days
FROM (
    SELECT l.id,
           CASE
               WHEN COALESCE(l.leave_period, 'full_day') = 'full_day'
                   THEN public.count_employee_workdays(l.employee_id, l.start_date, COALESCE(l.end_date, l.start_date))::numeric
               WHEN l.leave_period IN ('am', 'pm') THEN 0.5
               WHEN l.leave_period = 'hourly'
                   THEN ROUND(COALESCE(EXTRACT(EPOCH FROM (l.leave_end_time - l.leave_start_time)) / 3600.0, l.leave_hours) / 8.0, 4)
           END AS expected_days
    FROM public.leave_requests l
    WHERE l.status IN ('pending', 'approved')
      AND l.start_date >= DATE '2026-07-01'
) calc
WHERE lr.id = calc.id
  AND calc.expected_days IS NOT NULL
  AND calc.expected_days > 0
  AND lr.days IS DISTINCT FROM calc.expected_days
RETURNING lr.id, lr.employee_id, lr.start_date, lr.end_date, lr.leave_period, lr.days AS new_days;

-- ===== 部署後驗證（唯讀） =====
-- 1. 觸發器應不存在：
--    SELECT tgname FROM pg_trigger WHERE tgrelid='public.leave_requests'::regclass AND tgname='calculate_leave_days_trigger';  → 0 列
-- 2. anon 不可呼叫內部函式：
--    SELECT proacl FROM pg_proc WHERE proname='find_overlapping_leave';  → 無 anon
-- 3. 2026-07-01 起 days 與應有值不符應為 0 筆（重跑 D 的 SELECT 子查詢比對）。
