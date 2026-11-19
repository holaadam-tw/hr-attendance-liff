-- ============================================================
-- 155：公務機員工自行重選台灣當天便當（截止前）
--
-- 安全邊界：
--   - 只允許 line-push 以 service_role 呼叫 verified RPC。
--   - 公務機公司由 kiosk_resolve_verified 依 LINE 身分決定，前端不帶公司或日期。
--   - 目標員工必須同公司、在職且不是公務機帳號。
--   - 截止時間與訂餐日期均由 DB 的台灣時間決定；截止後保證零寫入。
--   - 不修改 lunch_orders 的既有政策，也不改 migration 154 的函式。
--
-- 回滾：migrations/155_kiosk_lunch_today_verified_rollback.sql
-- 只建立 migration 檔，不得由開發流程直接套用正式資料庫。
-- ============================================================

BEGIN;

DO $$
BEGIN
  IF to_regprocedure('public.kiosk_resolve_verified(text)') IS NULL THEN
    RAISE EXCEPTION 'kiosk_resolve_verified(text) 不存在：請先套用 migration 142';
  END IF;
  IF to_regclass('public.system_settings') IS NULL THEN
    RAISE EXCEPTION 'system_settings 不存在：不可套用 155';
  END IF;
  IF to_regclass('public.lunch_orders') IS NULL THEN
    RAISE EXCEPTION 'lunch_orders 不存在：不可套用 155';
  END IF;
END;
$$;

-- internal：只供同 owner 的 verified RPC 呼叫，不是 Data API 入口。
-- 支援 JSONB 字串／數字的 "10:00"、"9"、10；無設定或格式不合法一律用 10:00。
CREATE OR REPLACE FUNCTION public.lunch_deadline_passed(p_company_id UUID)
RETURNS BOOLEAN
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO public
AS $$
DECLARE
    v_raw TEXT;
    v_hour INTEGER := 10;
    v_minute INTEGER := 0;
    v_parts TEXT[];
    v_now_tw TIMESTAMP := now() AT TIME ZONE 'Asia/Taipei';
BEGIN
    SELECT BTRIM(s.value #>> '{}')
      INTO v_raw
      FROM public.system_settings s
     WHERE s.company_id = p_company_id
       AND s.key = 'lunch_deadline'
     LIMIT 1;

    IF COALESCE(v_raw, '') ~ '^\d{1,2}(:\d{1,2})?$' THEN
        v_parts := string_to_array(v_raw, ':');
        IF v_parts[1]::INTEGER BETWEEN 0 AND 23
           AND COALESCE(v_parts[2]::INTEGER, 0) BETWEEN 0 AND 59 THEN
            v_hour := v_parts[1]::INTEGER;
            v_minute := COALESCE(v_parts[2]::INTEGER, 0);
        END IF;
    END IF;

    RETURN v_now_tw::TIME >= make_time(v_hour, v_minute, 0);
END;
$$;

REVOKE ALL ON FUNCTION public.lunch_deadline_passed(UUID)
  FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.kiosk_lunch_today_verified(
    p_line_user_id TEXT,
    p_employee_id UUID,
    p_choice TEXT
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public
AS $$
DECLARE
    v_kiosk_id UUID;
    v_company_id UUID;
    v_target_ok BOOLEAN := false;
    v_order_date DATE := (now() AT TIME ZONE 'Asia/Taipei')::DATE;
    v_status TEXT;
    v_is_vegetarian BOOLEAN;
BEGIN
    SELECT r.kiosk_id, r.company_id
      INTO v_kiosk_id, v_company_id
      FROM public.kiosk_resolve_verified(p_line_user_id) r;

    IF v_kiosk_id IS NULL THEN
        RETURN jsonb_build_object(
            'success', false,
            'error', '此帳號非公務機',
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
           AND e.company_id = v_company_id
           AND e.is_active = true
           AND COALESCE(e.is_kiosk, false) = false
    ) INTO v_target_ok;

    IF NOT v_target_ok THEN
        RETURN jsonb_build_object(
            'success', false,
            'error', '找不到同公司的在職員工',
            'error_code', 'invalid_target'
        );
    END IF;

    IF public.lunch_deadline_passed(v_company_id) THEN
        RETURN jsonb_build_object(
            'success', false,
            'error', '今日便當已截止，請找管理員補訂',
            'error_code', 'deadline_passed'
        );
    END IF;

    v_status := CASE WHEN p_choice = 'none' THEN 'cancelled' ELSE 'ordered' END;
    v_is_vegetarian := p_choice = 'vegetarian';

    INSERT INTO public.lunch_orders (
        employee_id, order_date, is_vegetarian, status, updated_at, notes
    ) VALUES (
        p_employee_id, v_order_date, v_is_vegetarian, v_status, now(), '[公務機]'
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

REVOKE ALL ON FUNCTION public.kiosk_lunch_today_verified(TEXT, UUID, TEXT)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.kiosk_lunch_today_verified(TEXT, UUID, TEXT)
  TO service_role;

CREATE OR REPLACE FUNCTION public.kiosk_lunch_today_status_verified(
    p_line_user_id TEXT,
    p_employee_id UUID
) RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO public
AS $$
DECLARE
    v_kiosk_id UUID;
    v_company_id UUID;
    v_target_ok BOOLEAN := false;
    v_order_date DATE := (now() AT TIME ZONE 'Asia/Taipei')::DATE;
    v_raw TEXT;
    v_hour INTEGER := 10;
    v_minute INTEGER := 0;
    v_parts TEXT[];
    v_order RECORD;
    v_choice TEXT := NULL;
BEGIN
    SELECT r.kiosk_id, r.company_id
      INTO v_kiosk_id, v_company_id
      FROM public.kiosk_resolve_verified(p_line_user_id) r;

    IF v_kiosk_id IS NULL THEN
        RETURN jsonb_build_object(
            'success', false,
            'error', '此帳號非公務機',
            'error_code', 'access_denied'
        );
    END IF;

    SELECT EXISTS (
        SELECT 1
          FROM public.employees e
         WHERE e.id = p_employee_id
           AND e.company_id = v_company_id
           AND e.is_active = true
           AND COALESCE(e.is_kiosk, false) = false
    ) INTO v_target_ok;

    IF NOT v_target_ok THEN
        RETURN jsonb_build_object(
            'success', false,
            'error', '找不到同公司的在職員工',
            'error_code', 'invalid_target'
        );
    END IF;

    SELECT BTRIM(s.value #>> '{}')
      INTO v_raw
      FROM public.system_settings s
     WHERE s.company_id = v_company_id
       AND s.key = 'lunch_deadline'
     LIMIT 1;

    IF COALESCE(v_raw, '') ~ '^\d{1,2}(:\d{1,2})?$' THEN
        v_parts := string_to_array(v_raw, ':');
        IF v_parts[1]::INTEGER BETWEEN 0 AND 23
           AND COALESCE(v_parts[2]::INTEGER, 0) BETWEEN 0 AND 59 THEN
            v_hour := v_parts[1]::INTEGER;
            v_minute := COALESCE(v_parts[2]::INTEGER, 0);
        END IF;
    END IF;

    SELECT lo.status, lo.is_vegetarian
      INTO v_order
      FROM public.lunch_orders lo
     WHERE lo.employee_id = p_employee_id
       AND lo.order_date = v_order_date
     LIMIT 1;

    IF FOUND THEN
        v_choice := CASE
            WHEN v_order.status = 'cancelled' THEN 'none'
            WHEN COALESCE(v_order.is_vegetarian, false) THEN 'vegetarian'
            ELSE 'regular'
        END;
    END IF;

    RETURN jsonb_build_object(
        'success', true,
        'order_date', v_order_date,
        'choice', v_choice,
        'deadline', to_char(make_time(v_hour, v_minute, 0), 'HH24:MI'),
        'deadline_passed', public.lunch_deadline_passed(v_company_id)
    );
END;
$$;

REVOKE ALL ON FUNCTION public.kiosk_lunch_today_status_verified(TEXT, UUID)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.kiosk_lunch_today_status_verified(TEXT, UUID)
  TO service_role;

-- 檔尾自我檢查：internal 無公開入口；verified 只能由 service_role 執行。
DO $$
DECLARE
  f TEXT;
  r TEXT;
BEGIN
  f := 'public.lunch_deadline_passed(uuid)';
  FOREACH r IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
    IF has_function_privilege(r, f, 'EXECUTE') THEN
      RAISE EXCEPTION '% 不應能直接執行 internal %', r, f;
    END IF;
  END LOOP;

  FOREACH f IN ARRAY ARRAY[
    'public.kiosk_lunch_today_verified(text, uuid, text)',
    'public.kiosk_lunch_today_status_verified(text, uuid)'
  ] LOOP
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
  END LOOP;
END;
$$;

COMMIT;
