-- ============================================================
-- 159：權限收緊，管理端員工敏感欄位改走 LINE 驗證
--
-- 安全邊界：
--   - 只允許 line-push 以 service_role 呼叫；呼叫者身分由 LINE 驗證結果提供。
--   - DB 以 is_company_manager_caller 再驗 admin／manager／platform_admin 權限。
--   - 只回目前公司的指定員工，且只回本功能需要的 7 個欄位。
--   - employee_ids 最多 500 筆；NULL 代表目前公司全部員工（含待審與離職）。
--
-- 回滾：migrations/159_admin_employee_sensitive_verified_rollback.sql
-- 只建立 migration 檔，不得由開發流程直接套用正式資料庫。
-- ============================================================

BEGIN;

DO $$
BEGIN
  IF to_regprocedure('public.is_company_manager_caller(text,uuid)') IS NULL THEN
    RAISE EXCEPTION 'is_company_manager_caller(text,uuid) 不存在：請先核對管理員 RPC migration';
  END IF;
  IF to_regclass('public.employees') IS NULL THEN
    RAISE EXCEPTION 'employees 不存在：不可套用 159';
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.admin_get_employee_sensitive_verified(
    p_line_user_id TEXT,
    p_company_id UUID,
    p_employee_ids UUID[] DEFAULT NULL
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $$
DECLARE
    v_rows JSONB;
BEGIN
    IF NOT public.is_company_manager_caller(p_line_user_id, p_company_id) THEN
        RETURN jsonb_build_object(
            'success', false,
            'error', '需要管理員權限',
            'error_code', 'access_denied'
        );
    END IF;

    IF p_employee_ids IS NOT NULL AND (
        cardinality(p_employee_ids) > 500
        OR array_position(p_employee_ids, NULL::UUID) IS NOT NULL
    ) THEN
        RETURN jsonb_build_object(
            'success', false,
            'error', '員工清單不正確',
            'error_code', 'invalid_employee_ids'
        );
    END IF;

    SELECT COALESCE(
        jsonb_agg(
            jsonb_build_object(
                'employee_id', e.id,
                'phone', e.phone,
                'email', e.email,
                'emergency_contact', e.emergency_contact,
                'emergency_phone', e.emergency_phone,
                'id_card_last_4', e.id_card_last_4,
                'salary_type', e.salary_type
            ) ORDER BY e.created_at, e.id
        ),
        '[]'::JSONB
    )
      INTO v_rows
      FROM public.employees e
     WHERE e.company_id = p_company_id
       AND (p_employee_ids IS NULL OR e.id = ANY(p_employee_ids));

    RETURN jsonb_build_object(
        'success', true,
        'employees', v_rows
    );
END;
$$;

REVOKE ALL ON FUNCTION public.admin_get_employee_sensitive_verified(TEXT, UUID, UUID[])
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admin_get_employee_sensitive_verified(TEXT, UUID, UUID[])
  TO service_role;

-- 檔尾自我檢查：verified RPC 只能由 service_role 呼叫，且必須保留 SECURITY DEFINER。
DO $$
DECLARE
  f TEXT := 'public.admin_get_employee_sensitive_verified(text, uuid, uuid[])';
  r TEXT;
BEGIN
  -- anon／authenticated 會繼承 PUBLIC；兩者皆 false 也能攔住漏撤 PUBLIC 的情況。
  FOREACH r IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF has_function_privilege(r, f, 'EXECUTE') THEN
      RAISE EXCEPTION '% 不應能執行 %', r, f;
    END IF;
  END LOOP;
  IF NOT has_function_privilege('service_role', f, 'EXECUTE') THEN
    RAISE EXCEPTION 'service_role 無法執行 %', f;
  END IF;
  IF NOT (SELECT p.prosecdef FROM pg_proc p WHERE p.oid = f::regprocedure) THEN
    RAISE EXCEPTION '% 必須是 SECURITY DEFINER', f;
  END IF;
  IF (SELECT p.proconfig FROM pg_proc p WHERE p.oid = f::regprocedure)
      IS DISTINCT FROM ARRAY['search_path=""']::TEXT[] THEN
    RAISE EXCEPTION '% 必須固定空白 search_path', f;
  END IF;
END;
$$;

COMMIT;
