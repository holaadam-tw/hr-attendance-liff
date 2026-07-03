-- ============================================================
-- 088: salary_settings / payroll 讀取 RPC + 收緊 RLS（Phase 1 止血）
--
-- 背景：正式庫缺 011（多租戶 RLS 從未部署），salary_settings / payroll
--       在 002 allow-all 下可被 anon key 直接 SELECT，跨公司薪資個資外洩。
--
-- 修正（對齊 071 shift_types 身份驗證模式）：
--   1. 新增 4 支 SECURITY DEFINER 讀取 RPC，收 p_line_user_id，
--      在函數內 resolve 呼叫者 → 公司 → 角色，只回該公司資料。
--   2. 收緊 salary_settings / payroll 的 SELECT policy（拒絕 anon 直接讀）。
--
-- ⚠️ RPC 不信任 client 傳入的 p_company_id：仍以 p_line_user_id 驗證
--    呼叫者確實屬於該公司（且為 admin/manager），避免重蹈 049 覆轍。
-- ⚠️ 僅收緊 SELECT；INSERT/UPDATE/DELETE policy 不動，薪資寫入照常
--    （前端寫入皆 return=minimal，不需 SELECT）。
-- ============================================================

-- ========================================================
-- 1a. 員工自查當前薪資設定（首頁徽章 index.html:499、
--     薪資試算帶入 salary.html:831）— 自身即可，不需管理權限
-- ========================================================
DROP FUNCTION IF EXISTS get_my_current_salary(text);

CREATE OR REPLACE FUNCTION get_my_current_salary(
    p_line_user_id TEXT
) RETURNS JSONB
LANGUAGE plpgsql STABLE SECURITY DEFINER AS $$
DECLARE
    v_row JSONB;
BEGIN
    IF p_line_user_id IS NULL OR p_line_user_id = '' THEN
        RETURN NULL;
    END IF;

    SELECT to_jsonb(ss) INTO v_row
    FROM salary_settings ss
    JOIN employees e ON e.id = ss.employee_id
    WHERE e.line_user_id = p_line_user_id
      AND e.is_active = true
      AND ss.is_current = true
    LIMIT 1;

    RETURN v_row;  -- 無資料時回 NULL
END;
$$;

-- ========================================================
-- 1b. 員工自查已發布薪資單（salary.html:554）
--     僅回自己、且 is_published 的當月薪資單
-- ========================================================
DROP FUNCTION IF EXISTS get_my_payslip(text, integer, integer);

CREATE OR REPLACE FUNCTION get_my_payslip(
    p_line_user_id TEXT,
    p_year INTEGER,
    p_month INTEGER
) RETURNS JSONB
LANGUAGE plpgsql STABLE SECURITY DEFINER AS $$
DECLARE
    v_row JSONB;
BEGIN
    IF p_line_user_id IS NULL OR p_line_user_id = '' THEN
        RETURN NULL;
    END IF;

    SELECT to_jsonb(p) INTO v_row
    FROM payroll p
    JOIN employees e ON e.id = p.employee_id
    WHERE e.line_user_id = p_line_user_id
      AND e.is_active = true
      AND p.year = p_year
      AND p.month = p_month
      AND p.is_published = true
    LIMIT 1;

    RETURN v_row;  -- 無資料時回 NULL
END;
$$;

-- ========================================================
-- 2. 公司當前薪資設定清單（需該公司 admin/manager）
--    取代 payroll.js:108 / 418 / 534
-- ========================================================
DROP FUNCTION IF EXISTS get_company_current_salaries(uuid, text);

CREATE OR REPLACE FUNCTION get_company_current_salaries(
    p_company_id UUID,
    p_line_user_id TEXT
) RETURNS JSONB
LANGUAGE plpgsql STABLE SECURITY DEFINER AS $$
BEGIN
    IF p_line_user_id IS NULL OR p_line_user_id = '' THEN
        RAISE EXCEPTION '未提供身份驗證資訊';
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM employees
        WHERE company_id = p_company_id
          AND line_user_id = p_line_user_id
          AND role IN ('admin', 'manager')
          AND is_active = true
    ) THEN
        RAISE EXCEPTION '需要管理員權限';
    END IF;

    RETURN COALESCE((
        SELECT jsonb_agg(to_jsonb(ss))
        FROM salary_settings ss
        JOIN employees e ON e.id = ss.employee_id
        WHERE e.company_id = p_company_id
          AND ss.is_current = true
    ), '[]'::jsonb);
END;
$$;

-- ========================================================
-- 3. 單一員工當前薪資設定（薪資編輯 modal，需 admin/manager）
--    取代 employees.js:251
-- ========================================================
DROP FUNCTION IF EXISTS get_employee_current_salary(uuid, text, uuid);

CREATE OR REPLACE FUNCTION get_employee_current_salary(
    p_company_id UUID,
    p_line_user_id TEXT,
    p_employee_id UUID
) RETURNS JSONB
LANGUAGE plpgsql STABLE SECURITY DEFINER AS $$
DECLARE
    v_row JSONB;
BEGIN
    IF p_line_user_id IS NULL OR p_line_user_id = '' THEN
        RAISE EXCEPTION '未提供身份驗證資訊';
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM employees
        WHERE company_id = p_company_id
          AND line_user_id = p_line_user_id
          AND role IN ('admin', 'manager')
          AND is_active = true
    ) THEN
        RAISE EXCEPTION '需要管理員權限';
    END IF;
    -- 目標員工必須屬於同公司
    IF NOT EXISTS (
        SELECT 1 FROM employees
        WHERE id = p_employee_id AND company_id = p_company_id
    ) THEN
        RAISE EXCEPTION '無權存取此員工資料';
    END IF;

    SELECT to_jsonb(ss) INTO v_row
    FROM salary_settings ss
    WHERE ss.employee_id = p_employee_id
      AND ss.is_current = true
    LIMIT 1;

    RETURN v_row;  -- 無資料時回 NULL
END;
$$;

-- ========================================================
-- 4. 公司月薪資單（需 admin/manager）
--    回傳含 employees 巢狀物件，對齊前端既有 r.employees?.name 讀法
--    取代 payroll.js:538 / audit.js:74
-- ========================================================
DROP FUNCTION IF EXISTS get_company_payroll(uuid, text, integer, integer);

CREATE OR REPLACE FUNCTION get_company_payroll(
    p_company_id UUID,
    p_line_user_id TEXT,
    p_year INTEGER,
    p_month INTEGER
) RETURNS JSONB
LANGUAGE plpgsql STABLE SECURITY DEFINER AS $$
BEGIN
    IF p_line_user_id IS NULL OR p_line_user_id = '' THEN
        RAISE EXCEPTION '未提供身份驗證資訊';
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM employees
        WHERE company_id = p_company_id
          AND line_user_id = p_line_user_id
          AND role IN ('admin', 'manager')
          AND is_active = true
    ) THEN
        RAISE EXCEPTION '需要管理員權限';
    END IF;

    RETURN COALESCE((
        SELECT jsonb_agg(
            to_jsonb(p) || jsonb_build_object(
                'employees', jsonb_build_object(
                    'name', e.name,
                    'employee_number', e.employee_number,
                    'department', e.department,
                    'company_id', e.company_id
                )
            )
        )
        FROM payroll p
        JOIN employees e ON e.id = p.employee_id
        WHERE e.company_id = p_company_id
          AND p.year = p_year
          AND p.month = p_month
    ), '[]'::jsonb);
END;
$$;

-- ========================================================
-- 5. 授權（系統透過 anon key 呼叫，須 GRANT 給 anon）
-- ========================================================
GRANT EXECUTE ON FUNCTION get_my_current_salary(text) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION get_my_payslip(text, integer, integer) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION get_company_current_salaries(uuid, text) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION get_employee_current_salary(uuid, text, uuid) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION get_company_payroll(uuid, text, integer, integer) TO anon, authenticated;

-- ========================================================
-- 6. 收緊 RLS：移除 salary_settings / payroll 的所有 SELECT policy
--    RLS 已啟用 + 無 SELECT policy = 拒絕 anon 直接 SELECT；
--    上述 SECURITY DEFINER RPC 以 owner 身份繞過 RLS 讀取。
--    保留 INSERT/UPDATE/DELETE policy → 薪資寫入不受影響。
-- ========================================================
DO $$
DECLARE
    pol RECORD;
BEGIN
    FOR pol IN
        SELECT policyname, tablename
        FROM pg_policies
        WHERE schemaname = 'public'
          AND tablename IN ('salary_settings', 'payroll')
          AND cmd = 'SELECT'
    LOOP
        EXECUTE format('DROP POLICY IF EXISTS %I ON %I', pol.policyname, pol.tablename);
    END LOOP;
END $$;

-- 確保 RLS 啟用（若先前未啟用，無 policy 也不會擋 → 這裡強制啟用）
ALTER TABLE salary_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE payroll ENABLE ROW LEVEL SECURITY;

-- ========================================================
-- 7. 堵住視圖旁路（rls-checker 發現）
--    v_employee_full（010:139-161）以視圖擁有者權限執行、不受表 RLS
--    policy 約束，anon key 可經 PostgREST 直讀跨公司 base_salary 等薪資
--    → 完全繞過上面收緊的 salary_settings RLS。已實測正式庫可讀。
--    v_today_attendance 為同類（出勤資料）旁路，一併堵。
--    全庫 grep 確認無任何前端/RPC 依賴這兩個視圖 → REVOKE 不影響功能。
--    採 REVOKE（非 DROP）：可逆、非破壞；PostgREST 無 grant 即不曝露。
-- ========================================================
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_views WHERE schemaname = 'public' AND viewname = 'v_employee_full') THEN
        REVOKE ALL ON public.v_employee_full FROM anon, authenticated;
    END IF;
    IF EXISTS (SELECT 1 FROM pg_views WHERE schemaname = 'public' AND viewname = 'v_today_attendance') THEN
        REVOKE ALL ON public.v_today_attendance FROM anon, authenticated;
    END IF;
END $$;

-- ========================================================
-- 記錄 migration
-- ========================================================
INSERT INTO _migrations (filename) VALUES ('088_salary_payroll_rpc_rls.sql')
ON CONFLICT (filename) DO NOTHING;
