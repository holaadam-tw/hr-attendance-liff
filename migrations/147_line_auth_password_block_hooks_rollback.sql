-- ============================================================
-- 147 回滾：刪除兩支 Hook 函式
-- ⛔ 先在 Dashboard → Authentication → Hooks 把 Custom Access Token／Password Verification Attempt 停用（或改回其他函式），
--    再執行本檔。Hook 還指著這些函式時刪掉 → 所有登入與 token refresh 都會失敗。
-- ============================================================
BEGIN;
DROP FUNCTION IF EXISTS public.line_auth_password_verification_hook(JSONB);
DROP FUNCTION IF EXISTS public.line_auth_access_token_hook(JSONB);
COMMIT;
