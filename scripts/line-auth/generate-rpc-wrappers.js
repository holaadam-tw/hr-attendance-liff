#!/usr/bin/env node
// ============================================================
// P1 Phase 2 產生器：替「anon／authenticated 可執行、且帶 p_line_user_id 參數」的 RPC 產生 soft mode wrapper
//
// 輸入：scripts/line-auth/rpc_inventory.json（正式庫 pg_proc 唯讀快照，查詢見 inventory.sql）
//       migrations/130～140（非回滾檔）裡的 REVOKE … ON FUNCTION … FROM PUBLIC, anon, authenticated
//       → 這些在 141 之前就已經不是 anon 可執行，不包
// 輸出：migrations/141_line_auth_rpc_wrappers.sql、migrations/141_line_auth_rpc_wrappers_rollback.sql、
//       scripts/line-auth/wrapped_rpcs.json（前端 common.js 的名單要與它相同，測試會比對）
//
// 用法：node scripts/line-auth/generate-rpc-wrappers.js           產生／覆寫輸出檔
//       node scripts/line-auth/generate-rpc-wrappers.js --check   只比對，輸出檔與產生結果不同就 exit 1
//
// wrapper 形式（每支）：
//   原函式 RENAME 成 <name>_impl（本體、owner、設定不變；撤掉 PUBLIC／anon／authenticated 的執行權）
//   新的 <name>：同樣的參數（含預設值）、同樣的回傳型別、SECURITY DEFINER、VOLATILE（soft mode 要寫紀錄）
//     wrapper 不設 search_path：原函式（有些沒有自己的 search_path）照舊沿用呼叫端的 search_path，行為不變；
//     wrapper 本身只用完整限定名稱（public.assert_caller／public.<name>_impl）與 $n 參數。
//     ⚠️ 刻意不設 search_path：Supabase Advisor 的「function_search_path_mutable」警告是預期的，請勿「修正」
//     （設了會改變沒有自己 search_path 的原函式看到的 search_path）
// 不在範圍：kiosk_* 以 p_kiosk_line_user_id 當身分（參數名不同），本產生器不包；需另案處理
//     → PERFORM public.assert_caller(p_line_user_id, '<name>') → 原樣轉呼叫 <name>_impl
//   權限＝正式庫原函式的 proacl（逐項）
// ⚠️ 141 套用後，若要修改某支 RPC 的邏輯，請改 <name>_impl（CREATE OR REPLACE <name> 會把 wrapper 蓋掉）。
// ============================================================
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const MIG = '141';
const OUT_UP = path.join(ROOT, 'migrations', `${MIG}_line_auth_rpc_wrappers.sql`);
const OUT_DOWN = path.join(ROOT, 'migrations', `${MIG}_line_auth_rpc_wrappers_rollback.sql`);
const OUT_LIST = path.join(__dirname, 'wrapped_rpcs.json');
// 呼叫者可能「還沒有」LINE session 的 RPC（尚未綁定的新員工註冊、打卡失敗紀錄）：預先設為 soft，
// 之後把 '*' 切成 enforce 時不會被一起擋掉（要擋需另外設計，見 docs/LINE_AUTH_PHASE2.md）
const PRESEED_SOFT = ['register_employee', 'log_checkin_failure'];

const inv = JSON.parse(fs.readFileSync(path.join(__dirname, 'rpc_inventory.json'), 'utf8'));
const norm = s => s.toLowerCase().replace(/\s+/g, ' ').trim();
// identity_args「p_a uuid, p_b text」→ 只留型別「uuid, text」（參數名一律是單一識別字）
const typesOf = ident => ident.split(',').map(x => x.trim()).filter(Boolean).map(x => x.replace(/^\S+\s+/, '')).map(norm).join(', ');

// ---- 130～140 已撤 anon 執行權的函式 ----
const revoked = new Map();
for (const file of fs.readdirSync(path.join(ROOT, 'migrations')).sort()) {
  const m = file.match(/^(1[34]\d)_.*\.sql$/);
  if (!m || /_rollback\.sql$/.test(file) || Number(m[1]) < 130 || Number(m[1]) >= Number(MIG)) continue;
  const src = fs.readFileSync(path.join(ROOT, 'migrations', file), 'utf8').replace(/--[^\n]*/g, '');
  const re = /REVOKE\s+(?:EXECUTE|ALL)\s+ON\s+FUNCTION\s+public\.(\w+)\s*\(([^)]*)\)\s+FROM\s+([^;]+);/gi;
  let r;
  while ((r = re.exec(src))) {
    const from = r[3].toLowerCase();
    if (/\banon\b/.test(from) && /\bauthenticated\b/.test(from) && /\bpublic\b/.test(from)) {
      revoked.set(`${r[1]}(${norm(r[2])})`, m[1]);
    }
  }
}

const key = f => `${f.name}(${f.identity_args})`;
const wrapped = [], excluded = [];
for (const f of inv.functions) {
  const rk = `${f.name}(${typesOf(f.identity_args)})`;
  if (!f.anon_exec && !f.auth_exec) excluded.push({ f, reason: '正式庫已是 service role only' });
  else if (revoked.has(rk)) excluded.push({ f, reason: `${revoked.get(rk)} 已撤 anon／authenticated 執行權` });
  else wrapped.push(f);
}
wrapped.sort((a, b) => key(a).localeCompare(key(b)));
excluded.sort((a, b) => key(a.f).localeCompare(key(b.f)));

// ---- 檢查輸入 ----
const problems = [];
for (const f of wrapped) {
  if (!f.secdef) problems.push(`${key(f)} 不是 SECURITY DEFINER（包成 DEFINER 會改變行為）`);
  if (f.strict) problems.push(`${key(f)} 是 STRICT（wrapper 需另外處理）`);
  if (f.anon_exec !== f.auth_exec) problems.push(`${key(f)} anon 與 authenticated 權限不同（前端切換 client 會改變行為）`);
  if (f.uses_auth_schema || f.uses_role_guc) problems.push(`${key(f)} 本體用到 auth.*／角色（anon 與 authenticated 結果可能不同）`);
  if (f.deps && f.deps.length) problems.push(`${key(f)} 有其他物件依賴（${f.deps}）`);
  if (f.owner !== 'postgres') problems.push(`${key(f)} 擁有者不是 postgres`);
  if (!/^[0-9a-f]{32}$/.test(f.prosrc_md5 || '')) problems.push(`${key(f)} 缺少 prosrc_md5（請用新版 inventory.sql 重新查詢）`);
  if ((f.argmodes || []).some(m => !['i', 't'].includes(m))) problems.push(`${key(f)} 有 OUT／INOUT／VARIADIC 參數`);
  if (!/^[a-z_][a-z0-9_]*$/.test(f.name) || f.name.length > 58) problems.push(`${key(f)} 名稱不適合加 _impl`);
}
const aclGrantees = acl => (acl || '').replace(/^\{|\}$/g, '').split(',').filter(Boolean).map(e => {
  const [grantee, rest] = e.split('=');
  const [privs] = rest.split('/');
  return { grantee: grantee === '' ? 'PUBLIC' : grantee, privs };
}).filter(g => g.grantee !== 'postgres');
for (const f of wrapped) {
  for (const g of aclGrantees(f.acl)) {
    if (g.privs !== 'X') problems.push(`${key(f)} 的 acl 有非 EXECUTE 權限：${g.grantee}=${g.privs}`);
    if (!['PUBLIC', 'anon', 'authenticated', 'service_role'].includes(g.grantee)) problems.push(`${key(f)} 的 acl 有未預期角色：${g.grantee}`);
  }
}
// 撤權敘述裡的函式名稱若出現在清單中，型別也必須對得上（避免型別寫法不同而漏排除）
const invKeys = new Set(inv.functions.map(f => `${f.name}(${typesOf(f.identity_args)})`));
const invNames = new Set(inv.functions.map(f => f.name));
for (const k of revoked.keys()) {
  if (invNames.has(k.slice(0, k.indexOf('('))) && !invKeys.has(k)) problems.push(`撤權敘述 ${k} 對不到清單中的函式簽名`);
}
if (problems.length) { console.error('產生器中止：\n  ' + problems.join('\n  ')); process.exit(1); }

// ---- 產生 SQL ----
const q = s => `'${String(s).replace(/'/g, "''")}'`;
const grantSql = (fn, f) => aclGrantees(f.acl).map(g => `GRANT EXECUTE ON FUNCTION public.${fn}(${f.identity_args}) TO ${g.grantee};`).join('\n');
function inputArgs(f) {
  const modes = f.argmodes || f.argnames.map(() => 'i');
  return f.argnames.filter((_, i) => modes[i] === 'i');
}
function wrapperSql(f) {
  const ins = inputArgs(f);
  const pos = ins.indexOf('p_line_user_id') + 1;
  if (pos < 1) throw new Error(`${key(f)} 找不到 p_line_user_id`);
  const call = `public.${f.name}_impl(${ins.map((_, i) => '$' + (i + 1)).join(', ')})`;
  const body = f.retset ? `RETURN QUERY SELECT * FROM ${call};`
    : f.result === 'void' ? `PERFORM ${call};`
    : `RETURN ${call};`;
  return `-- ${key(f)}
ALTER FUNCTION public.${f.name}(${f.identity_args}) RENAME TO ${f.name}_impl;
REVOKE ALL ON FUNCTION public.${f.name}_impl(${f.identity_args}) FROM PUBLIC, anon, authenticated;
CREATE FUNCTION public.${f.name}(${f.args})
 RETURNS ${f.result}
 LANGUAGE plpgsql
 VOLATILE
 SECURITY DEFINER
AS $wrap$
BEGIN
  PERFORM public.assert_caller($${pos}::text, ${q(f.name)});
  ${body}
END;
$wrap$;
REVOKE ALL ON FUNCTION public.${f.name}(${f.identity_args}) FROM PUBLIC, anon, authenticated, service_role;
${grantSql(f.name, f)}
COMMENT ON FUNCTION public.${f.name}(${f.identity_args}) IS 'P1 Phase 2 wrapper (141): assert_caller then ${f.name}_impl. Edit ${f.name}_impl, not this function.';
`;
}
const expectedKeys = wrapped.map(key);
const arr = xs => `ARRAY[\n    ${xs.map(q).join(',\n    ')}\n  ]::text[]`;
const listSql = (fs_) => fs_.map(f => `--   ${key(f)}`).join('\n');
const LIVE_SET = `SELECT coalesce(array_agg(k ORDER BY k), '{}') FROM (
      SELECT p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')' AS k
      FROM pg_proc p
      WHERE p.pronamespace = 'public'::regnamespace AND p.prokind = 'f'
        AND 'p_line_user_id' = ANY (coalesce(p.proargnames, '{}'))
        AND (has_function_privilege('anon', p.oid, 'EXECUTE') OR has_function_privilege('authenticated', p.oid, 'EXECUTE'))
    ) s`;
const setCheck = (label) => `DO $$
DECLARE
  v_expected text[] := ${arr(expectedKeys)};
  v_live text[];
  v_extra text[];
  v_missing text[];
BEGIN
  v_live := (${LIVE_SET});
  v_extra := ARRAY(SELECT unnest(v_live) EXCEPT SELECT unnest(v_expected) ORDER BY 1);
  v_missing := ARRAY(SELECT unnest(v_expected) EXCEPT SELECT unnest(v_live) ORDER BY 1);
  IF cardinality(v_extra) > 0 OR cardinality(v_missing) > 0 OR cardinality(v_live) <> ${expectedKeys.length} THEN
    RAISE EXCEPTION '${label}：anon／authenticated 可執行、帶 p_line_user_id 的函式與產生時的清單不同（多出 %，缺少 %）；請重新產生 141', v_extra, v_missing;
  END IF;
END $$;`;

// 權限指紋：擁有者以外的 grantee:權限，依 C 排序（與 SQL 端 ORDER BY … COLLATE "C" 相同）
const aclFingerprint = f => aclGrantees(f.acl).map(g => `${g.grantee}:EXECUTE`).sort().join(',');
// 套用當下逐支比對正式庫快照的完整指紋：本體 md5、參數、回傳型別、proacl、proconfig、擁有者、STRICT、volatility、DEFINER
// 任何一項不同 → 中止（wrapper 的 GRANT 由快照產生，這裡保證與實際 proacl 相同）
// 擁有者：必須與 public.employees 的擁有者相同（正式庫＝postgres；產生器已確認快照 owner 為 postgres）
const sigCheck = `DO $$
DECLARE
  r record;
  p record;
  v_owner oid := (SELECT relowner FROM pg_class WHERE oid = 'public.employees'::regclass);
  v_acl text;
BEGIN
  FOR r IN SELECT * FROM (VALUES
${wrapped.map(f => `    (${q(f.name)}, ${q(f.identity_args)}, ${q(f.args)}, ${q(f.result)}, ${q(f.prosrc_md5)}, ${q(aclFingerprint(f))}, ${q((f.config || []).join(';'))}, ${q(f.volatility)})`).join(',\n')}
  ) v(n, ident, args, res, src_md5, acl, cfg, vol) LOOP
    SELECT pp.oid, pp.prosrc, pp.proowner, pp.proisstrict, pp.provolatile, pp.prosecdef, pp.proacl,
           coalesce(array_to_string(pp.proconfig, ';'), '') AS cfg
      INTO p
      FROM pg_proc pp
     WHERE pp.pronamespace = 'public'::regnamespace AND pp.proname = r.n AND pg_get_function_identity_arguments(pp.oid) = r.ident;
    IF p.oid IS NULL THEN
      RAISE EXCEPTION '找不到 %(%)', r.n, r.ident;
    END IF;
    SELECT coalesce(string_agg(coalesce(g.rolname, 'PUBLIC') || ':' || a.privilege_type, ',' ORDER BY coalesce(g.rolname, 'PUBLIC') || ':' || a.privilege_type COLLATE "C"), '')
      INTO v_acl
      FROM aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a LEFT JOIN pg_roles g ON g.oid = a.grantee
     WHERE a.grantee <> p.proowner;
    IF pg_get_function_arguments(p.oid) <> r.args OR pg_get_function_result(p.oid) <> r.res THEN
      RAISE EXCEPTION '%(%) 的參數／回傳型別與產生時不同；請重新產生 141', r.n, r.ident;
    END IF;
    IF md5(p.prosrc) <> r.src_md5 THEN
      RAISE EXCEPTION '%(%) 的函式本體與產生時不同（md5）；請重新查詢清單並重新產生 141', r.n, r.ident;
    END IF;
    IF v_acl <> r.acl THEN
      RAISE EXCEPTION '%(%) 的執行權限與產生時不同（現在 %，產生時 %）；請重新產生 141', r.n, r.ident, v_acl, r.acl;
    END IF;
    IF p.cfg <> r.cfg OR p.proowner <> v_owner OR p.proisstrict OR p.provolatile::text <> r.vol OR NOT p.prosecdef THEN
      RAISE EXCEPTION '%(%) 的設定／擁有者／STRICT／volatility／SECURITY DEFINER 與產生時不同；請重新產生 141', r.n, r.ident;
    END IF;
  END LOOP;
END $$;`;

// 回滾前：每支 wrapper 必須仍是 141 產生的 wrapper（有呼叫 assert_caller 與 <name>_impl），否則中止（避免把別人改過的函式刪掉）
const rbCheck = `DO $$
DECLARE
  r record;
  v_src text;
BEGIN
  FOR r IN SELECT * FROM (VALUES
${wrapped.map(f => `    (${q(f.name)}, ${q(f.identity_args)})`).join(',\n')}
  ) v(n, ident) LOOP
    SELECT pp.prosrc INTO v_src FROM pg_proc pp
     WHERE pp.pronamespace = 'public'::regnamespace AND pp.proname = r.n AND pg_get_function_identity_arguments(pp.oid) = r.ident;
    IF v_src IS NULL OR position('public.assert_caller(' IN v_src) = 0 OR position('public.' || r.n || '_impl(' IN v_src) = 0 THEN
      RAISE EXCEPTION '%(%) 已不是 141 的 wrapper（可能被 CREATE OR REPLACE 蓋掉）；請先人工確認再回滾', r.n, r.ident;
    END IF;
    IF to_regprocedure('public.' || r.n || '_impl(' || regexp_replace(r.ident, '(^|, )p_[a-z0-9_]+ ', '\\1', 'g') || ')') IS NULL THEN
      RAISE EXCEPTION '找不到 %_impl(%)', r.n, r.ident;
    END IF;
  END LOOP;
END $$;`;

const header = `-- ============================================================
-- 141: P1 身分根治 Phase 2 —— RPC 呼叫者身分 soft mode（只記錄、不擋）
-- ⚠️ 本檔由 scripts/line-auth/generate-rpc-wrappers.js 產生，請勿手改（改產生器或 rpc_inventory.json 後重新產生）
--
-- 做什麼：
--   A. line_auth_caller_settings：模式設定（'*' 預設 soft；可逐支覆寫；只有 service role 能改）
--      line_auth_caller_log：soft mode 下「呼叫者身分未驗證」的紀錄（函式名、p_line_user_id 的 SHA-256、JWT 有沒有 LINE claim、角色、時間）
--   B. assert_caller(p_line_user_id, fn)：只檢查 anon／authenticated 的呼叫（service role、pg_cron、DB 內部呼叫不檢查）
--      caller_line_user_id()（138）＝ p_line_user_id → 放行、不記錄
--      不符或沒有 session → soft：記一筆後放行（寫紀錄失敗也放行，例如唯讀交易）；enforce：拒絕（42501）
--   C. ${wrapped.length} 支 RPC 包 wrapper：原函式改名 <name>_impl（撤 PUBLIC／anon／authenticated 執行權），
--      新的 <name> 參數（含預設值）、回傳型別、權限與原函式相同，先 assert_caller 再原樣轉呼叫
--      （wrapper 一律 VOLATILE：soft mode 要寫紀錄；原本 STABLE 的函式行為不變，只是 PostgREST 改用讀寫交易）
--
-- 清單來源：正式庫 2026-09-28 唯讀查詢（scripts/line-auth/inventory.sql）帶 p_line_user_id 的函式 ${inv.functions.length} 支，扣除：
${excluded.map(e => `--   - ${key(e.f)}：${e.reason}`).join('\n')}
-- 包 wrapper 的 ${wrapped.length} 支：
${listSql(wrapped)}
--
-- 前提：138 已套（caller_line_user_id）；131、132 已套（上面「已撤」的函式）。本檔開頭會逐項檢查：
--   「anon／authenticated 可執行、帶 p_line_user_id 的函式」必須恰好是上面 ${wrapped.length} 支，
--   且每支的本體 md5、參數、回傳型別、proacl、proconfig、擁有者、STRICT、volatility、SECURITY DEFINER 與產生時的正式庫快照相同，否則中止。
-- 預設 soft：套用後任何呼叫的結果都與套用前相同（測試逐支比對）。切 enforce 前必須先看紀錄、並完成 docs/LINE_AUTH_PHASE2.md 的前置條件。
-- 回滾：migrations/141_line_auth_rpc_wrappers_rollback.sql（還原原函式名稱與權限、刪掉 wrapper／assert_caller／兩張表）
-- ⚠️ 套用後要改某支 RPC 的邏輯，請改 <name>_impl；對 <name> 做 CREATE OR REPLACE 會把 wrapper 蓋掉（身分檢查消失）。
--    tests/line-auth-phase2-guard.test.js 會擋下編號 > 141 的 migration 直接改 wrapper。
-- wrapper 刻意不設 search_path（Advisor 的 function_search_path_mutable 警告是預期的，請勿修正：設了會改變原函式的行為）。
-- 不在範圍：kiosk_* 以 p_kiosk_line_user_id 當身分，本檔不包。
-- 只建立 migration 檔，不得由開發流程直接套用正式資料庫。
-- ============================================================
`;

const up = `${header}
BEGIN;

-- ===== 0. 前提與清單檢查 =====
DO $$ BEGIN
  IF to_regprocedure('public.caller_line_user_id()') IS NULL THEN
    RAISE EXCEPTION '138 尚未套用（caller_line_user_id 不存在）：請先套 138，再套 141';
  END IF;
  IF to_regclass('public.line_auth_caller_log') IS NOT NULL OR to_regclass('public.line_auth_caller_settings') IS NOT NULL
     OR to_regprocedure('public.assert_caller(text, text)') IS NOT NULL THEN
    RAISE EXCEPTION '141 已套用過（line_auth_caller_log／assert_caller 已存在）';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname = ANY (${arr([...new Set(wrapped.map(f => f.name + '_impl'))])})) THEN
    RAISE EXCEPTION '已經有 *_impl 函式存在：141 可能已套用過，請先確認';
  END IF;
END $$;

${setCheck('套用前檢查')}

${sigCheck}

-- ===== A. 設定與紀錄 =====
CREATE TABLE public.line_auth_caller_settings (
  fn_name text PRIMARY KEY CHECK (fn_name = '*' OR fn_name ~ '^[a-z_][a-z0-9_]*$'),
  mode text NOT NULL CHECK (mode IN ('soft', 'enforce')),
  updated_at timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE public.line_auth_caller_settings IS 'P1 Phase 2 (141): caller identity mode per RPC; row * is the default. service role only.';
INSERT INTO public.line_auth_caller_settings (fn_name, mode) VALUES ('*', 'soft')${PRESEED_SOFT.map(n => `, (${q(n)}, 'soft')`).join('')};
ALTER TABLE public.line_auth_caller_settings ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.line_auth_caller_settings FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.line_auth_caller_settings TO service_role;

CREATE TABLE public.line_auth_caller_log (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  fn_name text NOT NULL,
  provided_id_hash text,
  claim_present boolean NOT NULL,
  claim_id_hash text,
  caller_role text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE public.line_auth_caller_log IS 'P1 Phase 2 (141): unverified RPC callers in soft mode (hashes only). service role only.';
CREATE INDEX line_auth_caller_log_created_idx ON public.line_auth_caller_log (created_at);
CREATE INDEX line_auth_caller_log_fn_idx ON public.line_auth_caller_log (fn_name, created_at);
ALTER TABLE public.line_auth_caller_log ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.line_auth_caller_log FROM PUBLIC, anon, authenticated;
REVOKE ALL ON SEQUENCE public.line_auth_caller_log_id_seq FROM PUBLIC, anon, authenticated;
GRANT SELECT, DELETE ON TABLE public.line_auth_caller_log TO service_role;

-- ===== B. assert_caller =====
CREATE FUNCTION public.assert_caller(p_line_user_id text, p_fn text)
RETURNS void
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_role text := coalesce(nullif(current_setting('role', true), ''), 'none');
  v_claim text;
  v_mode text;
BEGIN
  -- 只檢查 anon／authenticated（PostgREST 以 SET ROLE 切換；JWT 的 role 當備援）
  IF v_role NOT IN ('anon', 'authenticated') THEN
    v_role := coalesce(auth.jwt() ->> 'role', 'none');
  END IF;
  IF v_role NOT IN ('anon', 'authenticated') THEN
    RETURN;   -- service role、pg_cron、DB 內部呼叫
  END IF;

  v_claim := public.caller_line_user_id();
  IF v_claim IS NOT NULL AND v_claim = p_line_user_id THEN
    RETURN;   -- 身分已由 Supabase Auth 簽發的 JWT 證實
  END IF;

  SELECT s.mode INTO v_mode FROM public.line_auth_caller_settings s WHERE s.fn_name = p_fn;
  IF v_mode IS NULL THEN
    SELECT s.mode INTO v_mode FROM public.line_auth_caller_settings s WHERE s.fn_name = '*';
  END IF;

  IF v_mode = 'enforce' THEN
    RAISE EXCEPTION 'caller identity not verified' USING ERRCODE = '42501', HINT = 'line-auth session required';
  END IF;

  -- soft（含設定缺漏）：記錄後放行；寫紀錄失敗（例如唯讀交易）也放行
  BEGIN
    INSERT INTO public.line_auth_caller_log (fn_name, provided_id_hash, claim_present, claim_id_hash, caller_role)
    VALUES (
      left(p_fn, 100),
      CASE WHEN p_line_user_id IS NOT NULL THEN encode(sha256(convert_to(p_line_user_id, 'UTF8')), 'hex') END,
      v_claim IS NOT NULL,
      CASE WHEN v_claim IS NOT NULL THEN encode(sha256(convert_to(v_claim, 'UTF8')), 'hex') END,
      v_role
    );
  EXCEPTION WHEN OTHERS THEN
    NULL;
  END;
END;
$$;
REVOKE ALL ON FUNCTION public.assert_caller(text, text) FROM PUBLIC, anon, authenticated, service_role;

-- ===== C. wrapper（${wrapped.length} 支）=====
${wrapped.map(wrapperSql).join('\n')}
-- ===== 自我檢查（同一交易；不符就整筆回復）=====
${setCheck('套用後檢查')}

DO $$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT w.oid AS w_oid, i.oid AS i_oid, w.proname, w.proowner AS w_owner, i.proowner AS i_owner
    FROM pg_proc w
    JOIN pg_proc i ON i.pronamespace = w.pronamespace AND i.proname = w.proname || '_impl'
      AND pg_get_function_identity_arguments(i.oid) = pg_get_function_identity_arguments(w.oid)
    WHERE w.pronamespace = 'public'::regnamespace AND w.proname = ANY (${arr([...new Set(wrapped.map(f => f.name))])})
  LOOP
    IF has_function_privilege('anon', r.i_oid, 'EXECUTE') OR has_function_privilege('authenticated', r.i_oid, 'EXECUTE') THEN
      RAISE EXCEPTION '%_impl 仍可被 anon／authenticated 執行', r.proname;
    END IF;
    IF NOT (SELECT prosecdef FROM pg_proc WHERE oid = r.w_oid)
       OR pg_get_function_arguments(r.w_oid) <> pg_get_function_arguments(r.i_oid)
       OR pg_get_function_result(r.w_oid) <> pg_get_function_result(r.i_oid) THEN
      RAISE EXCEPTION '% 的 wrapper 與原函式簽名不同', r.proname;
    END IF;
    IF has_function_privilege('anon', r.w_oid, 'EXECUTE') <> true OR has_function_privilege('authenticated', r.w_oid, 'EXECUTE') <> true THEN
      RAISE EXCEPTION '% 的 wrapper 權限與原函式不同', r.proname;
    END IF;
    IF r.w_owner <> r.i_owner OR r.w_owner <> (SELECT relowner FROM pg_class WHERE oid = 'public.employees'::regclass) THEN
      RAISE EXCEPTION '% 的 wrapper 擁有者應與原函式、資料表相同（正式庫＝postgres）', r.proname;
    END IF;
  END LOOP;
  IF (SELECT count(*) FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname LIKE '%\\_impl' ESCAPE '\\'
        AND p.proname = ANY (${arr([...new Set(wrapped.map(f => f.name + '_impl'))])})) <> ${wrapped.length} THEN
    RAISE EXCEPTION '*_impl 數量不是 ${wrapped.length}';
  END IF;
  IF has_function_privilege('anon', 'public.assert_caller(text, text)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.assert_caller(text, text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'assert_caller 不應讓 anon／authenticated 直接呼叫';
  END IF;
  IF has_table_privilege('anon', 'public.line_auth_caller_log', 'SELECT') OR has_table_privilege('authenticated', 'public.line_auth_caller_log', 'SELECT')
     OR has_table_privilege('anon', 'public.line_auth_caller_settings', 'UPDATE') OR has_table_privilege('authenticated', 'public.line_auth_caller_settings', 'UPDATE')
     OR has_table_privilege('anon', 'public.line_auth_caller_settings', 'INSERT') OR has_table_privilege('authenticated', 'public.line_auth_caller_settings', 'INSERT') THEN
    RAISE EXCEPTION '設定／紀錄表不應讓 anon／authenticated 讀寫';
  END IF;
  IF (SELECT mode FROM public.line_auth_caller_settings WHERE fn_name = '*') IS DISTINCT FROM 'soft' THEN
    RAISE EXCEPTION '預設模式應為 soft';
  END IF;
END $$;

COMMIT;
`;

const down = `-- ============================================================
-- 141 回滾：還原 ${wrapped.length} 支 RPC 的原名稱與權限（正式庫 2026-09-28 proacl），刪掉 wrapper、assert_caller、設定與紀錄表
-- ⚠️ 本檔由 scripts/line-auth/generate-rpc-wrappers.js 產生，請勿手改
-- ⚠️ line_auth_caller_log 的紀錄會一起刪除；需要的話先匯出
-- 回滾前會確認每支 wrapper 仍是 141 產生的（有呼叫 assert_caller 與 <name>_impl），否則中止
-- ============================================================

BEGIN;

DO $$ BEGIN
  IF to_regclass('public.line_auth_caller_settings') IS NULL THEN
    RAISE EXCEPTION '141 未套用（line_auth_caller_settings 不存在），不需要回滾';
  END IF;
END $$;

${rbCheck}

${wrapped.map(f => `-- ${key(f)}
DROP FUNCTION public.${f.name}(${f.identity_args});
ALTER FUNCTION public.${f.name}_impl(${f.identity_args}) RENAME TO ${f.name};
REVOKE ALL ON FUNCTION public.${f.name}(${f.identity_args}) FROM PUBLIC, anon, authenticated, service_role;
${grantSql(f.name, f)}
`).join('\n')}
DROP FUNCTION public.assert_caller(text, text);
DROP TABLE public.line_auth_caller_log;
DROP TABLE public.line_auth_caller_settings;

${setCheck('回滾後檢查')}

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname = ANY (${arr([...new Set(wrapped.map(f => f.name + '_impl'))])})) THEN
    RAISE EXCEPTION '仍有 *_impl 函式';
  END IF;
END $$;

COMMIT;
`;

const list = JSON.stringify({
  generated_by: 'scripts/line-auth/generate-rpc-wrappers.js',
  migration: MIG,
  rpc_names: [...new Set(wrapped.map(f => f.name))].sort(),
  functions: wrapped.map(key),
  excluded: excluded.map(e => ({ function: key(e.f), reason: e.reason })),
  preseed_soft: PRESEED_SOFT,
}, null, 2) + '\n';

const outputs = [[OUT_UP, up], [OUT_DOWN, down], [OUT_LIST, list]];
if (process.argv.includes('--check')) {
  const stale = outputs.filter(([p, c]) => !fs.existsSync(p) || fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n') !== c).map(([p]) => path.relative(ROOT, p));
  if (stale.length) { console.error('輸出檔與產生結果不同：' + stale.join(', ')); process.exit(1); }
  console.log(`一致：wrapper ${wrapped.length} 支、排除 ${excluded.length} 支`);
} else {
  for (const [p, c] of outputs) fs.writeFileSync(p, c);
  console.log(`已產生：wrapper ${wrapped.length} 支、排除 ${excluded.length} 支（${outputs.map(([p]) => path.relative(ROOT, p)).join('、')}）`);
}
