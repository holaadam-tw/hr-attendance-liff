-- ============================================================
-- 142: 公務機（kiosk）打卡改由 LINE 驗證身分決定（新路徑；舊函式仍可用＝相容期）
--
-- 背景（2026-09-30 正式庫唯讀查詢 pg_proc）：
--   kiosk_get_company(text)、kiosk_lookup_employee(text, text)、
--   kiosk_check_in(text, uuid, text, text, float8, float8) 皆 SECURITY DEFINER，
--   EXECUTE 開給 PUBLIC／anon／authenticated，且未設定 search_path。
--   公務機身分＝呼叫端傳入的 p_kiosk_line_user_id（Phase 0 沒涵蓋）。
--   呼叫點只有 kiosk.html（repo 全文搜尋）。
--
-- 公務機的身分怎麼對應（查 kiosk.html 與 060）：
--   公務機是一台共用平板，用「公務機專用的 LINE 帳號」開 LIFF（與員工同一個 LINE Login channel）；
--   employees 表裡有一列 is_kiosk = true 的「公務機帳號」，其 line_user_id 就是這個 LINE 帳號。
--   員工本人不登入：在平板上輸入工號／手機／身分證後 4 碼，由公務機帳號代為打卡。
--   所以 line-push 驗 LIFF access token 得到的 userId＝公務機帳號的 line_user_id，
--   直接當成本檔函式的 p_line_user_id；員工 ID 仍由平板送出，但只能是同公司在職員工（沿用舊函式的檢查）。
--
-- 新增（只給 service_role，由 line-push 驗 LIFF 後以 LINE 回傳的 userId 呼叫）：
--   A. kiosk_get_company_verified(p_line_user_id)
--   B. kiosk_lookup_employee_verified(p_line_user_id, p_identifier)
--   C. kiosk_check_in_verified(p_line_user_id, p_employee_id, p_action, p_photo_url, p_latitude, p_longitude)
--   共同規則：該 LINE 帳號必須恰好對到 1 列「在職、is_kiosk = true」的公務機帳號（0 列或多列都拒絕，不猜）；
--             拒絕時回 error_code = 'access_denied'（line-push 轉 403）。
--   B、C 通過身分檢查後委派給原本的 kiosk_lookup_employee／kiosk_check_in（打卡規則一行都不改）。
--   C 另外檢查 p_action 只能是 check_in／check_out（舊函式把其他值都當上班卡）。
--   D. 舊三支函式加上 SET search_path = public（只改設定、不改內容）。
--
-- 本檔不撤舊權限：舊頁面（LINE 內建瀏覽器快取）在相容期仍可用。撤權在 143。
-- 上線順序：套 142 → 部署 line-push → merge 前端 → 等至少 1 個工作天 → 套 143（撤舊函式的 anon／authenticated 權限）
-- 回滾：migrations/142_kiosk_verified_calls_rollback.sql（必須先回滾 143）
-- 只建立 migration 檔，不得由開發流程直接套用正式資料庫。
-- ============================================================

BEGIN;

DO $$ BEGIN
  IF to_regprocedure('public.kiosk_get_company(text)') IS NULL
     OR to_regprocedure('public.kiosk_lookup_employee(text, text)') IS NULL
     OR to_regprocedure('public.kiosk_check_in(text, uuid, text, text, double precision, double precision)') IS NULL THEN
    RAISE EXCEPTION '找不到舊的 kiosk_* 函式：本檔只適用於已有公務機功能的資料庫';
  END IF;
END $$;

-- ===== 共用：LINE 驗證過的 userId → 公務機帳號（恰好 1 列才算數）=====
CREATE OR REPLACE FUNCTION public.kiosk_resolve_verified(p_line_user_id TEXT)
RETURNS TABLE(kiosk_id UUID, company_id UUID)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_n INTEGER;
BEGIN
    IF COALESCE(p_line_user_id, '') = '' THEN
        RETURN;
    END IF;
    SELECT COUNT(*)::INTEGER INTO v_n
    FROM public.employees e
    WHERE e.line_user_id = p_line_user_id
      AND e.is_active = true
      AND COALESCE(e.is_kiosk, false) = true;
    IF v_n <> 1 THEN
        RETURN;   -- 0 列＝不是公務機；多列＝同一個 LINE 帳號綁了多個公務機帳號 → 不猜
    END IF;
    RETURN QUERY
    SELECT e.id, e.company_id
    FROM public.employees e
    WHERE e.line_user_id = p_line_user_id
      AND e.is_active = true
      AND COALESCE(e.is_kiosk, false) = true;
END;
$$;

REVOKE ALL ON FUNCTION public.kiosk_resolve_verified(TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.kiosk_resolve_verified(TEXT) TO service_role;

-- ===== A. 公務機開機：取得公司名稱 =====
CREATE OR REPLACE FUNCTION public.kiosk_get_company_verified(p_line_user_id TEXT)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_kiosk_id UUID;
    v_company_id UUID;
    v_name TEXT;
BEGIN
    SELECT r.kiosk_id, r.company_id INTO v_kiosk_id, v_company_id
    FROM public.kiosk_resolve_verified(p_line_user_id) r;
    IF v_kiosk_id IS NULL THEN
        RETURN jsonb_build_object('success', false, 'error', '此帳號非公務機', 'error_code', 'access_denied');
    END IF;

    SELECT c.name INTO v_name FROM public.companies c WHERE c.id = v_company_id;

    RETURN jsonb_build_object(
        'success', true,
        'name', COALESCE(v_name, ''),
        'company_id', v_company_id
    );
END;
$$;

REVOKE ALL ON FUNCTION public.kiosk_get_company_verified(TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.kiosk_get_company_verified(TEXT) TO service_role;

-- ===== B. 查員工（工號／手機／身分證後 4 碼）=====
CREATE OR REPLACE FUNCTION public.kiosk_lookup_employee_verified(p_line_user_id TEXT, p_identifier TEXT)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_kiosk_id UUID;
    v_result JSONB;
BEGIN
    SELECT r.kiosk_id INTO v_kiosk_id FROM public.kiosk_resolve_verified(p_line_user_id) r;
    IF v_kiosk_id IS NULL THEN
        RETURN jsonb_build_object('success', false, 'error', '此帳號非公務機', 'error_code', 'access_denied');
    END IF;
    IF COALESCE(TRIM(p_identifier), '') = '' OR length(p_identifier) > 32 THEN
        RETURN jsonb_build_object('success', false, 'error', '請輸入工號、手機或身分證後4碼', 'error_code', 'invalid_value');
    END IF;

    v_result := public.kiosk_lookup_employee(p_line_user_id, p_identifier);
    IF COALESCE((v_result->>'success')::BOOLEAN, false) = false AND NOT (v_result ? 'error_code') THEN
        v_result := v_result || jsonb_build_object('error_code', 'not_found');
    END IF;
    RETURN v_result;
END;
$$;

REVOKE ALL ON FUNCTION public.kiosk_lookup_employee_verified(TEXT, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.kiosk_lookup_employee_verified(TEXT, TEXT) TO service_role;

-- ===== C. 代打卡 =====
CREATE OR REPLACE FUNCTION public.kiosk_check_in_verified(
    p_line_user_id TEXT,
    p_employee_id UUID,
    p_action TEXT,
    p_photo_url TEXT DEFAULT NULL,
    p_latitude DOUBLE PRECISION DEFAULT NULL,
    p_longitude DOUBLE PRECISION DEFAULT NULL
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_kiosk_id UUID;
BEGIN
    SELECT r.kiosk_id INTO v_kiosk_id FROM public.kiosk_resolve_verified(p_line_user_id) r;
    IF v_kiosk_id IS NULL THEN
        RETURN jsonb_build_object('success', false, 'error', '此帳號非公務機', 'error_code', 'access_denied');
    END IF;
    IF p_employee_id IS NULL OR p_action IS NULL OR p_action NOT IN ('check_in', 'check_out') THEN
        RETURN jsonb_build_object('success', false, 'error', '打卡資料不正確', 'error_code', 'invalid_value');
    END IF;

    -- 打卡規則（同公司、在職、遲到早退、重複打卡）全部沿用原函式
    RETURN public.kiosk_check_in(p_line_user_id, p_employee_id, p_action, p_photo_url, p_latitude, p_longitude);
END;
$$;

REVOKE ALL ON FUNCTION public.kiosk_check_in_verified(TEXT, UUID, TEXT, TEXT, DOUBLE PRECISION, DOUBLE PRECISION) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.kiosk_check_in_verified(TEXT, UUID, TEXT, TEXT, DOUBLE PRECISION, DOUBLE PRECISION) TO service_role;

-- ===== D. 舊函式補 search_path（內容不變）=====
ALTER FUNCTION public.kiosk_get_company(text) SET search_path = public;
ALTER FUNCTION public.kiosk_lookup_employee(text, text) SET search_path = public;
ALTER FUNCTION public.kiosk_check_in(text, uuid, text, text, double precision, double precision) SET search_path = public;

-- 自我檢查（同一交易）：新函式只給 service_role
DO $$ DECLARE r text; f text; BEGIN
  FOREACH f IN ARRAY ARRAY[
    'public.kiosk_resolve_verified(text)',
    'public.kiosk_get_company_verified(text)',
    'public.kiosk_lookup_employee_verified(text, text)',
    'public.kiosk_check_in_verified(text, uuid, text, text, double precision, double precision)'] LOOP
    FOREACH r IN ARRAY ARRAY['anon', 'authenticated'] LOOP
      IF has_function_privilege(r, f, 'EXECUTE') THEN
        RAISE EXCEPTION '% 不應能執行 %', r, f;
      END IF;
    END LOOP;
    IF NOT has_function_privilege('service_role', f, 'EXECUTE') THEN
      RAISE EXCEPTION 'service_role 無法執行 %', f;
    END IF;
  END LOOP;
END $$;

COMMIT;
