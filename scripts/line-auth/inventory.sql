-- 唯讀查詢：列出正式庫 public schema 中所有帶 p_line_user_id 參數的函式（Phase 2 wrapper 產生器的輸入）
-- 用法（只讀）：supabase db query --linked -f scripts/line-auth/inventory.sql -o json
--   取回結果的 inv 陣列，放進 scripts/line-auth/rpc_inventory.json 的 functions，再跑 node scripts/line-auth/generate-rpc-wrappers.js

WITH f AS (
  SELECT p.oid, p.proname FROM pg_proc p WHERE p.pronamespace='public'::regnamespace AND p.prokind='f'
    AND 'p_line_user_id' = ANY(coalesce(p.proargnames, '{}'))
)
SELECT json_agg(json_build_object(
  'name', p.proname,
  'identity_args', pg_get_function_identity_arguments(p.oid),
  'args', pg_get_function_arguments(p.oid),
  'result', pg_get_function_result(p.oid),
  'retset', p.proretset,
  'secdef', p.prosecdef,
  'strict', p.proisstrict,
  'volatility', p.provolatile,
  'prosrc_md5', md5(p.prosrc),
  'parallel', p.proparallel,
  'lang', (SELECT lanname FROM pg_language WHERE oid=p.prolang),
  'config', p.proconfig,
  'acl', p.proacl::text,
  'owner', pg_get_userbyid(p.proowner),
  'argnames', p.proargnames,
  'argmodes', p.proargmodes,
  'nargs', p.pronargs,
  'nargdefaults', p.pronargdefaults,
  'anon_exec', has_function_privilege('anon', p.oid, 'EXECUTE'),
  'auth_exec', has_function_privilege('authenticated', p.oid, 'EXECUTE'),
  'uses_auth_schema', p.prosrc ~* 'auth\.(uid|jwt|role|email)\s*\(',
  'uses_role_guc', p.prosrc ~* '(current_user|session_user|current_role|current_setting\s*\(\s*''role)',
  'deps', (SELECT json_agg(DISTINCT d.classid::regclass::text) FROM pg_depend d WHERE d.refobjid = p.oid AND d.refclassid='pg_proc'::regclass AND d.deptype <> 'i'),
  'called_by', (SELECT json_agg(DISTINCT q.proname) FROM pg_proc q WHERE q.pronamespace='public'::regnamespace AND q.oid <> p.oid AND q.prosrc ~ ('\m' || p.proname || '\s*\('))
) ORDER BY p.proname, pg_get_function_identity_arguments(p.oid)) AS inv
FROM f JOIN pg_proc p ON p.oid = f.oid;
