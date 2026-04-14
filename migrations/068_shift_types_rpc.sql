-- ============================================================
-- 068: shift_types CRUD 改用 SECURITY DEFINER RPC
--
-- shift_types 表有 RLS，anon key 直接 INSERT/UPDATE/DELETE → 401
-- 建立 4 個 RPC 繞過 RLS
-- ============================================================

-- 1. 查詢公司班別
DROP FUNCTION IF EXISTS get_company_shift_types(uuid);
CREATE OR REPLACE FUNCTION get_company_shift_types(p_company_id UUID)
RETURNS JSONB
LANGUAGE plpgsql STABLE SECURITY DEFINER AS $$
BEGIN
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

-- 2. 新增班別
DROP FUNCTION IF EXISTS create_shift_type(uuid, text, text, time, time, boolean);
CREATE OR REPLACE FUNCTION create_shift_type(
    p_company_id UUID,
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
    IF NOT EXISTS (SELECT 1 FROM companies WHERE id = p_company_id) THEN
        RAISE EXCEPTION '無效的公司 ID';
    END IF;

    INSERT INTO shift_types (company_id, name, code, start_time, end_time, is_overnight, is_active)
    VALUES (p_company_id, p_name, COALESCE(NULLIF(p_code, ''), UPPER(LEFT(p_name, 10))), p_start_time, p_end_time, p_is_overnight, true)
    RETURNING id INTO v_new_id;

    RETURN v_new_id;
END;
$$;

-- 3. 更新班別
DROP FUNCTION IF EXISTS update_shift_type(uuid, uuid, text, text, time, time, boolean);
CREATE OR REPLACE FUNCTION update_shift_type(
    p_id UUID,
    p_company_id UUID,
    p_name TEXT,
    p_code TEXT,
    p_start_time TIME,
    p_end_time TIME,
    p_is_overnight BOOLEAN DEFAULT false
) RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
    UPDATE shift_types
    SET name = p_name,
        code = COALESCE(NULLIF(p_code, ''), UPPER(LEFT(p_name, 10))),
        start_time = p_start_time,
        end_time = p_end_time,
        is_overnight = p_is_overnight
    WHERE id = p_id AND company_id = p_company_id;
END;
$$;

-- 4. 刪除班別（軟刪除）
DROP FUNCTION IF EXISTS delete_shift_type(uuid, uuid);
CREATE OR REPLACE FUNCTION delete_shift_type(
    p_id UUID,
    p_company_id UUID
) RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
    UPDATE shift_types SET is_active = false
    WHERE id = p_id AND company_id = p_company_id;
END;
$$;

-- 授權 anon / authenticated
GRANT EXECUTE ON FUNCTION get_company_shift_types(uuid) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION create_shift_type(uuid, text, text, time, time, boolean) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION update_shift_type(uuid, uuid, text, text, time, time, boolean) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION delete_shift_type(uuid, uuid) TO anon, authenticated;
