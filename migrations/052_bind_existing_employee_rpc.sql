-- ============================================================
-- 052: 綁定現有員工 RPC + employees 加 verify_code 欄位
--
-- 情境：admin 手動新增員工（無 line_user_id）→ 員工從 LINE 進入
--       → 需要輸入工號+驗證碼綁定 LINE 帳號
--
-- 變更：
--   1. employees 加 verify_code TEXT 欄位（admin 設定，員工用來綁定）
--   2. bind_existing_employee RPC：驗證工號+驗證碼 → UPDATE line_user_id
-- ============================================================

-- 1. 加 verify_code 欄位
ALTER TABLE employees ADD COLUMN IF NOT EXISTS verify_code TEXT;

-- 2. 綁定現有員工 RPC
CREATE OR REPLACE FUNCTION bind_existing_employee(
    p_line_user_id TEXT,
    p_employee_number TEXT,
    p_verify_code TEXT
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_employee RECORD;
BEGIN
    -- 查員工（必須是已通過且在職）
    SELECT id, name, line_user_id, verify_code, is_active, status
    INTO v_employee
    FROM employees
    WHERE employee_number = p_employee_number
      AND is_active = true
      AND status = 'approved'
    LIMIT 1;

    IF v_employee.id IS NULL THEN
        RETURN jsonb_build_object('success', false, 'error', '找不到此工號的在職員工');
    END IF;

    -- 驗證碼檢查（verify_code 為空時不允許綁定，防止未設定驗證碼的員工被任意綁定）
    IF v_employee.verify_code IS NULL OR v_employee.verify_code = '' THEN
        RETURN jsonb_build_object('success', false, 'error', '此員工尚未設定驗證碼，請聯繫管理員');
    END IF;

    IF v_employee.verify_code != p_verify_code THEN
        RETURN jsonb_build_object('success', false, 'error', '驗證碼錯誤');
    END IF;

    -- 檢查是否已綁定其他 LINE 帳號
    IF v_employee.line_user_id IS NOT NULL AND v_employee.line_user_id != p_line_user_id THEN
        RETURN jsonb_build_object('success', false, 'error', '此員工已綁定其他 LINE 帳號');
    END IF;

    -- 檢查此 LINE 帳號是否已綁定其他員工
    IF EXISTS (
        SELECT 1 FROM employees
        WHERE line_user_id = p_line_user_id
          AND id != v_employee.id
          AND is_active = true
    ) THEN
        RETURN jsonb_build_object('success', false, 'error', '此 LINE 帳號已綁定其他員工');
    END IF;

    -- 更新綁定
    UPDATE employees
    SET line_user_id = p_line_user_id,
        is_bound = true,
        updated_at = now()
    WHERE id = v_employee.id;

    RETURN jsonb_build_object('success', true, 'employee_name', v_employee.name);

EXCEPTION WHEN OTHERS THEN
    RETURN jsonb_build_object('success', false, 'error', SQLERRM);
END;
$$;
