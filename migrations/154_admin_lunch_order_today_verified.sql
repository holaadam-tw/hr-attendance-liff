-- ============================================================
-- 154：管理員替同公司員工補訂當天便當
--
-- 安全邊界：
--   - 只允許 line-push 以 service_role 呼叫；呼叫者身分由 LINE 驗證結果提供。
--   - DB 以 is_company_manager_caller 再驗 admin／manager／platform_admin 權限。
--   - 目標員工必須同公司、在職且不是公務機帳號。
--   - 訂餐日期只由 DB 的台灣今日決定，不接受前端日期，也不套截止時間。
--   - 稽核姓名由 DB 查詢，不採信前端；notes 固定為「[管理員補訂：姓名]」。
--
-- 回滾：migrations/154_admin_lunch_order_today_verified_rollback.sql
-- 只建立 migration 檔，不得由開發流程直接套用正式資料庫。
-- ============================================================

BEGIN;

DO $$
BEGIN
  IF to_regprocedure('public.is_company_manager_caller(text,uuid)') IS NULL THEN
    RAISE EXCEPTION 'is_company_manager_caller(text,uuid) 不存在：請先核對管理員 RPC migration';
  END IF;
  IF to_regclass('public.lunch_orders') IS NULL THEN
    RAISE EXCEPTION 'lunch_orders 不存在：不可套用 154';
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.admin_order_lunch_today_verified(
    p_company_id UUID,
    p_line_user_id TEXT,
    p_employee_id UUID,
    p_choice TEXT
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public
AS $$
DECLARE
    v_admin_name TEXT;
    v_target_ok BOOLEAN := false;
    v_order_date DATE := (now() AT TIME ZONE 'Asia/Taipei')::date;
    v_status TEXT;
    v_is_vegetarian BOOLEAN;
BEGIN
    IF NOT public.is_company_manager_caller(p_line_user_id, p_company_id) THEN
        RETURN jsonb_build_object(
            'success', false,
            'error', '需要管理員權限',
            'error_code', 'access_denied'
        );
    END IF;

    IF p_choice IS NULL OR p_choice NOT IN ('regular', 'vegetarian', 'none') THEN
        RETURN jsonb_build_object(
            'success', false,
            'error', '便當選項不正確',
            'error_code', 'invalid_choice'
        );
    END IF;

    SELECT EXISTS (
        SELECT 1
        FROM public.employees e
        WHERE e.id = p_employee_id
          AND e.company_id = p_company_id
          AND e.is_active = true
          AND COALESCE(e.is_kiosk, false) = false
    )
    INTO v_target_ok;

    IF NOT v_target_ok THEN
        RETURN jsonb_build_object(
            'success', false,
            'error', '找不到同公司的在職員工',
            'error_code', 'invalid_target'
        );
    END IF;

    SELECT e.name
      INTO v_admin_name
      FROM public.employees e
     WHERE e.company_id = p_company_id
       AND e.line_user_id = p_line_user_id
       AND e.is_active = true
       AND COALESCE(e.is_kiosk, false) = false
     ORDER BY e.created_at
     LIMIT 1;

    IF v_admin_name IS NULL THEN
        SELECT pa.name
          INTO v_admin_name
          FROM public.platform_admins pa
          JOIN public.platform_admin_companies pac
            ON pac.platform_admin_id = pa.id
         WHERE pa.line_user_id = p_line_user_id
           AND pa.is_active = true
           AND pac.company_id = p_company_id
         LIMIT 1;
    END IF;

    v_admin_name := COALESCE(NULLIF(BTRIM(v_admin_name), ''), '管理員');
    v_status := CASE WHEN p_choice = 'none' THEN 'cancelled' ELSE 'ordered' END;
    v_is_vegetarian := p_choice = 'vegetarian';

    INSERT INTO public.lunch_orders (
        employee_id, order_date, is_vegetarian, status, updated_at, notes
    ) VALUES (
        p_employee_id, v_order_date, v_is_vegetarian, v_status, now(),
        '[管理員補訂：' || v_admin_name || ']'
    )
    ON CONFLICT (employee_id, order_date) DO UPDATE
       SET status = EXCLUDED.status,
           is_vegetarian = EXCLUDED.is_vegetarian,
           updated_at = now(),
           notes = EXCLUDED.notes;

    RETURN jsonb_build_object(
        'success', true,
        'order_date', v_order_date,
        'status', v_status,
        'is_vegetarian', v_is_vegetarian
    );
END;
$$;

REVOKE ALL ON FUNCTION public.admin_order_lunch_today_verified(UUID, TEXT, UUID, TEXT)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admin_order_lunch_today_verified(UUID, TEXT, UUID, TEXT)
  TO service_role;

-- 檔尾自我檢查：verified RPC 只能由 service_role 呼叫，且必須保留 SECURITY DEFINER。
DO $$
DECLARE
  f TEXT := 'public.admin_order_lunch_today_verified(uuid, text, uuid, text)';
  r TEXT;
BEGIN
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
END;
$$;

COMMIT;
