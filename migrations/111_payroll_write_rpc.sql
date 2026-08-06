-- ============================================================
-- 111: payroll / salary_settings 寫入改走 RPC（RLS 整治 P0 第二批）
--
-- 背景（2026-08-06 查證正式庫）：
--   payroll           RLS on，但 payroll_insert / payroll_update / payroll_delete
--                     三條政策角色都是 PUBLIC 且條件為 true
--   salary_settings   同上三條（salary_settings_insert/_update/_delete）
--   payroll_records   payroll_select / payroll_insert / payroll_update 全開，
--                     但該表 0 筆資料、前端完全沒有使用（只有兩支健康檢查腳本）
--
--   兩張表都**沒有** SELECT 政策——讀取本來就走 get_company_payroll 等 RPC。
--   真正開著的是寫入：任何人拿公開 anon key 就能偽造、竄改或刪光全公司的薪資
--   與薪資設定。以危害程度來說，這比「可以讀」更嚴重。
--
-- 本 migration 新增兩支寫入 RPC，取代前端 4 個直接寫入點：
--   1. save_payroll_records()   ← modules/payroll.js 的儲存草稿與發布（2 處 upsert）
--   2. upsert_salary_setting()  ← modules/payroll.js 批次設定、modules/employees.js
--                                 薪資設定 Modal（各 2 個語句、共 4 個）
--
-- **刻意不在這裡收政策**——順序必須是
--   111 建 RPC → 前端改呼叫 → 部署驗證 → 112 才 DROP POLICY。
--
-- 順帶修掉一個既有缺陷：
--   前端原本的 salary_settings 寫入是「先 UPDATE 舊的 is_current=false，
--   再 INSERT 新的」兩個獨立語句，中間沒有交易保護。第二步失敗時該員工會
--   變成「沒有任何生效中的薪資設定」，薪資計算會抓不到底薪。改成單一 RPC
--   之後兩步在同一個交易裡，要嘛都成功要嘛都不動。
--
-- 多租戶：兩支都逐筆驗證目標員工屬於 p_company_id。原本前端 upsert 是把整包
--   records 直接送進去，沒有任何伺服器端檢查，被竄改的 client 可以寫進別家
--   公司員工的薪資。
--
-- 注意事項：
--   - 呼叫者身分驗證沿用 092/099/105/109 模式（p_company_id 這家公司的 admin/manager）。
--     實測發現管理員身分是跨公司的，所以一定要用 p_company_id 比對，
--     不可用呼叫者自己的 company_id（見 docs/RLS_REMEDIATION_INVENTORY.md §4-2）
--   - payroll 的唯一鍵是 (employee_id, year, month)
--   - RECORD NULL 判斷用 v_xxx.id IS NOT NULL
-- ============================================================

-- ────────────────────────────────────────────────────────────
-- 1. save_payroll_records：儲存薪資草稿 / 發布
-- ────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION save_payroll_records(
    p_company_id UUID,
    p_line_user_id TEXT,
    p_year INTEGER,
    p_month INTEGER,
    p_records JSONB,
    p_is_published BOOLEAN DEFAULT false
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_operator RECORD;
    v_total INTEGER;
    v_foreign INTEGER;
    v_saved INTEGER := 0;
BEGIN
    IF p_line_user_id IS NULL OR p_line_user_id = '' THEN
        RETURN jsonb_build_object('success', false, 'error', '未提供身份驗證資訊');
    END IF;

    SELECT e.id, e.name INTO v_operator
    FROM employees e
    WHERE e.company_id = p_company_id
      AND e.line_user_id = p_line_user_id
      AND e.is_active = true
      AND e.role IN ('admin', 'manager')
    LIMIT 1;

    IF v_operator.id IS NULL THEN
        RETURN jsonb_build_object('success', false, 'error', '需要管理員權限');
    END IF;

    IF p_records IS NULL OR jsonb_typeof(p_records) <> 'array' THEN
        RETURN jsonb_build_object('success', false, 'error', 'invalid_records');
    END IF;

    SELECT count(*) INTO v_total FROM jsonb_array_elements(p_records);
    IF v_total = 0 THEN
        RETURN jsonb_build_object('success', true, 'saved', 0);
    END IF;

    IF p_year IS NULL OR p_month IS NULL OR p_month < 1 OR p_month > 12 THEN
        RETURN jsonb_build_object('success', false, 'error', 'invalid_period');
    END IF;

    -- === 多租戶：所有目標員工都必須屬於 p_company_id ===
    SELECT count(*) INTO v_foreign
    FROM jsonb_array_elements(p_records) r
    WHERE NOT EXISTS (
        SELECT 1 FROM employees e
        WHERE e.id = (r->>'employee_id')::uuid
          AND e.company_id = p_company_id
    );

    IF v_foreign > 0 THEN
        RETURN jsonb_build_object(
            'success', false,
            'error', '資料含非本公司員工，已全部拒絕',
            'code', 'foreign_employee',
            'foreign_count', v_foreign
        );
    END IF;

    INSERT INTO payroll (
        employee_id, year, month, salary_type, base_salary, overtime_pay, bonus,
        full_attendance_bonus, meal_allowance, position_allowance, night_allowance,
        late_deduction, absence_deduction, personal_leave_deduction,
        labor_insurance, health_insurance, pension_self, income_tax,
        manual_adjustment, adjustment_note, total_deduction, gross_salary, net_salary,
        calculation_details, is_published, updated_at
    )
    SELECT
        (r->>'employee_id')::uuid,
        p_year,
        p_month,
        r->>'salary_type',
        COALESCE((r->>'base_salary')::numeric, 0),
        COALESCE((r->>'overtime_pay')::numeric, 0),
        COALESCE((r->>'bonus')::numeric, 0),
        COALESCE((r->>'full_attendance_bonus')::numeric, 0),
        COALESCE((r->>'meal_allowance')::numeric, 0),
        COALESCE((r->>'position_allowance')::numeric, 0),
        COALESCE((r->>'night_allowance')::numeric, 0),
        COALESCE((r->>'late_deduction')::numeric, 0),
        COALESCE((r->>'absence_deduction')::numeric, 0),
        COALESCE((r->>'personal_leave_deduction')::numeric, 0),
        COALESCE((r->>'labor_insurance')::numeric, 0),
        COALESCE((r->>'health_insurance')::numeric, 0),
        COALESCE((r->>'pension_self')::numeric, 0),
        COALESCE((r->>'income_tax')::numeric, 0),
        COALESCE((r->>'manual_adjustment')::numeric, 0),
        r->>'adjustment_note',
        COALESCE((r->>'total_deduction')::numeric, 0),
        COALESCE((r->>'gross_salary')::numeric, 0),
        COALESCE((r->>'net_salary')::numeric, 0),
        r->'calculation_details',
        p_is_published,
        now()
    FROM jsonb_array_elements(p_records) r
    ON CONFLICT (employee_id, year, month) DO UPDATE
    SET salary_type = EXCLUDED.salary_type,
        base_salary = EXCLUDED.base_salary,
        overtime_pay = EXCLUDED.overtime_pay,
        bonus = EXCLUDED.bonus,
        full_attendance_bonus = EXCLUDED.full_attendance_bonus,
        meal_allowance = EXCLUDED.meal_allowance,
        position_allowance = EXCLUDED.position_allowance,
        night_allowance = EXCLUDED.night_allowance,
        late_deduction = EXCLUDED.late_deduction,
        absence_deduction = EXCLUDED.absence_deduction,
        personal_leave_deduction = EXCLUDED.personal_leave_deduction,
        labor_insurance = EXCLUDED.labor_insurance,
        health_insurance = EXCLUDED.health_insurance,
        pension_self = EXCLUDED.pension_self,
        income_tax = EXCLUDED.income_tax,
        manual_adjustment = EXCLUDED.manual_adjustment,
        adjustment_note = EXCLUDED.adjustment_note,
        total_deduction = EXCLUDED.total_deduction,
        gross_salary = EXCLUDED.gross_salary,
        net_salary = EXCLUDED.net_salary,
        calculation_details = EXCLUDED.calculation_details,
        is_published = EXCLUDED.is_published,
        updated_at = now();

    GET DIAGNOSTICS v_saved = ROW_COUNT;

    RETURN jsonb_build_object(
        'success', true,
        'saved', v_saved,
        'year', p_year,
        'month', p_month,
        'is_published', p_is_published
    );

EXCEPTION WHEN OTHERS THEN
    RETURN jsonb_build_object('success', false, 'error', SQLERRM);
END;
$$;

GRANT EXECUTE ON FUNCTION save_payroll_records(UUID, TEXT, INTEGER, INTEGER, JSONB, BOOLEAN)
    TO anon, authenticated;


-- ────────────────────────────────────────────────────────────
-- 2. upsert_salary_setting：新增一版薪資設定並讓舊版失效（同一交易）
-- ────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION upsert_salary_setting(
    p_company_id UUID,
    p_line_user_id TEXT,
    p_employee_id UUID,
    p_salary_type TEXT,
    p_base_salary NUMERIC,
    p_meal_allowance NUMERIC DEFAULT NULL,
    p_position_allowance NUMERIC DEFAULT NULL,
    p_full_attendance_bonus NUMERIC DEFAULT NULL,
    p_pension_self_rate NUMERIC DEFAULT NULL,
    p_sync_employee_rate BOOLEAN DEFAULT false
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_operator RECORD;
    v_target RECORD;
    v_hourly NUMERIC;
    v_superseded INTEGER := 0;
BEGIN
    IF p_line_user_id IS NULL OR p_line_user_id = '' THEN
        RETURN jsonb_build_object('success', false, 'error', '未提供身份驗證資訊');
    END IF;

    SELECT e.id, e.name INTO v_operator
    FROM employees e
    WHERE e.company_id = p_company_id
      AND e.line_user_id = p_line_user_id
      AND e.is_active = true
      AND e.role IN ('admin', 'manager')
    LIMIT 1;

    IF v_operator.id IS NULL THEN
        RETURN jsonb_build_object('success', false, 'error', '需要管理員權限');
    END IF;

    -- 多租戶：目標員工必須屬於同一家公司
    SELECT e.id, e.name INTO v_target
    FROM employees e
    WHERE e.id = p_employee_id AND e.company_id = p_company_id
    LIMIT 1;

    IF v_target.id IS NULL THEN
        RETURN jsonb_build_object('success', false, 'error', '找不到員工（或不屬於本公司）');
    END IF;

    IF p_salary_type IS NULL OR p_salary_type NOT IN ('monthly', 'daily', 'hourly') THEN
        RETURN jsonb_build_object('success', false, 'error', 'invalid_salary_type');
    END IF;

    IF p_base_salary IS NULL OR p_base_salary <= 0 THEN
        RETURN jsonb_build_object('success', false, 'error', '基本薪資必須大於 0', 'code', 'invalid_base_salary');
    END IF;

    -- 舊版失效與新版寫入在同一個交易裡：不會再出現「兩步之間失敗，
    -- 該員工變成沒有任何生效中設定」的狀況（前端原本是兩個獨立語句）
    UPDATE salary_settings
    SET is_current = false, updated_at = now()
    WHERE employee_id = v_target.id AND is_current = true;

    GET DIAGNOSTICS v_superseded = ROW_COUNT;

    INSERT INTO salary_settings (
        employee_id, salary_type, base_salary,
        meal_allowance, position_allowance, full_attendance_bonus,
        pension_self_rate, is_current, updated_at
    ) VALUES (
        v_target.id, p_salary_type, p_base_salary,
        COALESCE(p_meal_allowance, 0), COALESCE(p_position_allowance, 0),
        COALESCE(p_full_attendance_bonus, 0), COALESCE(p_pension_self_rate, 0),
        true, now()
    );

    -- 批次設定畫面會同步更新 employees 的 salary_type / hourly_rate
    IF p_sync_employee_rate THEN
        v_hourly := CASE p_salary_type
            WHEN 'hourly' THEN p_base_salary
            WHEN 'daily'  THEN ROUND(p_base_salary / 8.0, 2)
            ELSE ROUND(p_base_salary / 30.0 / 8.0, 2)
        END;

        UPDATE employees
        SET salary_type = p_salary_type, hourly_rate = v_hourly
        WHERE id = v_target.id AND company_id = p_company_id;
    END IF;

    RETURN jsonb_build_object(
        'success', true,
        'employee_name', v_target.name,
        'salary_type', p_salary_type,
        'base_salary', p_base_salary,
        'superseded', v_superseded,
        'hourly_rate', v_hourly
    );

EXCEPTION WHEN OTHERS THEN
    RETURN jsonb_build_object('success', false, 'error', SQLERRM);
END;
$$;

GRANT EXECUTE ON FUNCTION upsert_salary_setting(UUID, TEXT, UUID, TEXT, NUMERIC, NUMERIC, NUMERIC, NUMERIC, NUMERIC, BOOLEAN)
    TO anon, authenticated;
