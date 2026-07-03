-- ============================================================
-- 090: 薪資讀取 RPC 收緊為「僅平台管理員」（只有本人可讀）
--
-- 背景：088 的 3 支 admin 類薪資 RPC 檢查 role IN ('admin','manager')，
--   代表同公司任何 admin/manager 都能經 RPC 讀全公司薪資。實際上大正
--   科技除業主本人外還有其他 role='admin' 員工（如 E006），業主希望
--   薪資「只有我看得到」。
--
-- 修正：把 get_company_current_salaries / get_employee_current_salary /
--   get_company_payroll 的權限檢查改為「呼叫者須為 platform_admins 表中
--   的 active 平台管理員」。目前 platform_admins 僅業主一人 → 等同鎖定
--   只有本人。員工自查 RPC（get_my_current_salary / get_my_payslip）不變。
--
-- ⚠️ 殘留限制（與 088 相同）：無真正 auth session 下 p_line_user_id 仍可
--   偽造；且 platform_admins / employees 目前 anon 可讀（Phase 3 才鎖），
--   攻擊者仍可取得平台管理員 line_user_id 冒用。本 migration 縮小「合法
--   讀取者」為本人，但完整封閉冒用需 Phase 3（鎖 employees/platform_admins）
--   或改走真 auth session。
-- ============================================================

-- 1. 公司當前薪資設定清單
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
        SELECT 1 FROM platform_admins
        WHERE line_user_id = p_line_user_id AND is_active = true
    ) THEN
        RAISE EXCEPTION '需要平台管理員權限';
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

-- 2. 單一員工當前薪資設定
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
        SELECT 1 FROM platform_admins
        WHERE line_user_id = p_line_user_id AND is_active = true
    ) THEN
        RAISE EXCEPTION '需要平台管理員權限';
    END IF;
    -- 目標員工必須屬於指定公司
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

    RETURN v_row;
END;
$$;

-- 3. 公司月薪資單
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
        SELECT 1 FROM platform_admins
        WHERE line_user_id = p_line_user_id AND is_active = true
    ) THEN
        RAISE EXCEPTION '需要平台管理員權限';
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

-- GRANT 不變（函式簽名相同，權限沿用；此處冪等重申）
GRANT EXECUTE ON FUNCTION get_company_current_salaries(uuid, text) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION get_employee_current_salary(uuid, text, uuid) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION get_company_payroll(uuid, text, integer, integer) TO anon, authenticated;

INSERT INTO _migrations (filename) VALUES ('090_salary_rpc_platform_admin_only.sql')
ON CONFLICT (filename) DO NOTHING;
