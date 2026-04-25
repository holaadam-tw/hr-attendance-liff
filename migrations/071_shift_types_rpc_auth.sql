-- ============================================================
-- 071: shift_types RPC 加入身份驗證
--
-- P1 安全漏洞：068 的 4 個 shift_types RPC 無身份驗證
-- anon 可用任意 company UUID 讀取/修改/刪除任何公司的班別
--
-- 修正：
--   1. DROP 舊簽名（無 p_line_user_id 的版本）
--   2. 重建 4 個 RPC，加 p_line_user_id 參數
--   3. READ: 驗證呼叫者是目標公司的 active 員工
--   4. WRITE: 驗證呼叫者是目標公司的 admin 或 manager
-- ============================================================

-- 移除舊版（無身份驗證的版本）
DROP FUNCTION IF EXISTS get_company_shift_types(uuid);
DROP FUNCTION IF EXISTS create_shift_type(uuid, text, text, time, time, boolean);
DROP FUNCTION IF EXISTS update_shift_type(uuid, uuid, text, text, time, time, boolean);
DROP FUNCTION IF EXISTS delete_shift_type(uuid, uuid);

-- 1. 查詢公司班別（需為該公司 active 員工）
CREATE OR REPLACE FUNCTION get_company_shift_types(
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
          AND is_active = true
    ) THEN
        RAISE EXCEPTION '無權限存取此公司班別';
    END IF;

    RETURN COALESCE((
        SELECT jsonb_agg(jsonb_build_object(
            'id', id, 'name', name, 'code', code,
            'start_time', start_time::text, 'end_time', end_time::text,
            'is_overnight', COALESCE(is_overnight, false),
            'company_id', company_id
        ) ORDER BY start_time)
        FROM shift_types
        WHERE (company_id = p_company_id OR company_id IS NULL)
          AND is_active = true
    ), '[]'::jsonb);
END;
$$;

-- 2. 新增班別（需為該公司 admin/manager）
CREATE OR REPLACE FUNCTION create_shift_type(
    p_company_id UUID,
    p_line_user_id TEXT,
    p_name TEXT,
    p_code TEXT,
    p_start_time TIME,
    p_end_time TIME,
    p_is_overnight BOOLEAN DEFAULT false
) RETURNS UUID
LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
    v_new_id UUID;
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
    IF NOT EXISTS (SELECT 1 FROM companies WHERE id = p_company_id) THEN
        RAISE EXCEPTION '無效的公司 ID';
    END IF;

    INSERT INTO shift_types (company_id, name, code, start_time, end_time, is_overnight, is_active)
    VALUES (p_company_id, p_name, COALESCE(NULLIF(p_code, ''), UPPER(LEFT(p_name, 10))), p_start_time, p_end_time, p_is_overnight, true)
    RETURNING id INTO v_new_id;

    RETURN v_new_id;
END;
$$;

-- 3. 更新班別（需為該公司 admin/manager）
CREATE OR REPLACE FUNCTION update_shift_type(
    p_id UUID,
    p_company_id UUID,
    p_line_user_id TEXT,
    p_name TEXT,
    p_code TEXT,
    p_start_time TIME,
    p_end_time TIME,
    p_is_overnight BOOLEAN DEFAULT false
) RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER AS $$
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

    UPDATE shift_types
    SET name = p_name,
        code = COALESCE(NULLIF(p_code, ''), UPPER(LEFT(p_name, 10))),
        start_time = p_start_time,
        end_time = p_end_time,
        is_overnight = p_is_overnight
    WHERE id = p_id AND company_id = p_company_id;
END;
$$;

-- 4. 刪除班別（軟刪除，需為該公司 admin/manager）
CREATE OR REPLACE FUNCTION delete_shift_type(
    p_id UUID,
    p_company_id UUID,
    p_line_user_id TEXT
) RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER AS $$
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

    UPDATE shift_types SET is_active = false
    WHERE id = p_id AND company_id = p_company_id;
END;
$$;

-- 授權（anon 需保留因系統透過 anon key 呼叫）
GRANT EXECUTE ON FUNCTION get_company_shift_types(uuid, text) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION create_shift_type(uuid, text, text, text, time, time, boolean) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION update_shift_type(uuid, uuid, text, text, text, time, time, boolean) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION delete_shift_type(uuid, uuid, text) TO anon, authenticated;
