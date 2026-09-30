// ============================================================
// migration 145／147：Phase 2／3 前置——caller_line_user_id() 每次現查在職、離職者停權對象、擋自設密碼的 Auth Hook — PGlite 實跑
//
// 不連線、不寫正式庫。流程：
//   1. 正式庫快照（phase0 fixture）＋ auth schema 替身（auth.users 含 banned_until／deleted_at；auth.jwt()／auth.uid() 與正式庫同定義）
//      ＋ supabase_auth_admin 角色替身
//   2. 套 138 → 記錄套用前狀態 → 套 145
//   3. caller_line_user_id()：在職 → 有身分；離職（is_active=false）、平台管理員停用、Auth 帳號停權／刪除／改綁／sub 對不上 → NULL；
//      回任 → 立即恢復；138 原有的 JWT 條件（anon、user_metadata、格式）照舊
//   4. caller_company_ids()：只回「現在」在職的公司（JWT 的 company_ids 不採信）
//   5. line_auth_reconcile_targets／needed：只列「未停權、已不在職」的 LINE 帳號；權限只給 service role
//   6. 與 141 相容：若有 141（repo 內或 MIGRATION141_FILE），取出 assert_caller 實跑：enforce 下離職當下就被擋
//   7. 零行為變更：除了 caller_line_user_id 與新增函式，其他 public 函式、政策、表權限完全不變；
//      回滾 → caller_line_user_id 回到 138 原文（定義 md5 相同）、其他逐項相同；可重套
//   8. 147 Hook：LINE 帳號 password 登入／refresh 帶 amr=password → 403；otp／magiclink／refresh 放行且 claims 不變；
//      非 LINE 帳號不動；非預期輸入不拋錯；權限只給 supabase_auth_admin；回滾
// 反向對照：MIGRATION145_FILE 指向 138 原文（或空檔）→ 現查相關案例失敗
// ============================================================
const fs = require('fs');
const path = require('path');
const { PGlite } = require('@electric-sql/pglite');
const { isDeepStrictEqual: same } = require('util');   // jsonb 會重排鍵的順序 → 用深度比較

const root = path.join(__dirname, '..');
const read = f => fs.readFileSync(f, 'utf8').replace(/\r\n/g, '\n');
const snapshot = read(path.join(__dirname, 'fixtures', 'phase0_prod_snapshot.sql'));
const mig = n => read(path.join(root, 'migrations', n));
const m138 = mig('138_line_auth_phase1.sql');
const m145 = read(process.env.MIGRATION145_FILE || path.join(root, 'migrations', '145_line_auth_live_identity.sql'));
const m145rb = mig('145_line_auth_live_identity_rollback.sql');
const m146 = mig('146_line_auth_reconcile_cron.sql');
const m146rb = mig('146_line_auth_reconcile_cron_rollback.sql');
const commonJs = read(path.join(root, 'common.js'));
const m147 = mig('147_line_auth_password_block_hooks.sql');
const m147rb = mig('147_line_auth_password_block_hooks_rollback.sql');
const f141 = process.env.MIGRATION141_FILE || path.join(root, 'migrations', '141_line_auth_rpc_wrappers.sql');
const m141 = fs.existsSync(f141) ? read(f141) : null;

let pass = 0, fail = 0;
function check(name, condition, detail = '') {
  if (condition) { pass++; console.log('  ✅ ' + name + (detail ? '  → ' + detail : '')); }
  else { fail++; console.log('  ❌ ' + name + (detail ? '  → ' + String(detail).slice(0, 400) : '')); }
}

const A = '8a669e2c-7521-43e9-9300-5c004c57e9db';
const B = '11111111-2222-3333-4444-555555555555';
const U = { e1: 'U' + '1'.repeat(32), quit: 'U' + '9'.repeat(32), pa: 'U' + 'b'.repeat(32), both: 'U' + 'c'.repeat(32) };
const AU = { e1: '00000000-0000-4000-8000-0000000000e1', quit: '00000000-0000-4000-8000-000000000009', pa: '00000000-0000-4000-8000-0000000000fa',
  both: '00000000-0000-4000-8000-0000000000cc', plain: '00000000-0000-4000-8000-000000000001' };
const PA_ID = '00000000-0000-0000-0000-00000000fa01';

const AUTH_STUB = `
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'supabase_auth_admin') THEN CREATE ROLE supabase_auth_admin NOLOGIN; END IF;
END $$;
CREATE SCHEMA IF NOT EXISTS auth;
CREATE TABLE IF NOT EXISTS auth.users (
  id UUID PRIMARY KEY, email TEXT, raw_app_meta_data JSONB, raw_user_meta_data JSONB, created_at TIMESTAMPTZ DEFAULT now(),
  banned_until TIMESTAMPTZ, deleted_at TIMESTAMPTZ
);
CREATE OR REPLACE FUNCTION auth.jwt() RETURNS jsonb LANGUAGE sql STABLE AS $f$
  select coalesce(nullif(current_setting('request.jwt.claim', true), ''), nullif(current_setting('request.jwt.claims', true), ''))::jsonb
$f$;
CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $f$
  select coalesce(nullif(current_setting('request.jwt.claim.sub', true), ''), (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub'))::uuid
$f$;
GRANT USAGE ON SCHEMA auth TO anon, authenticated, service_role, supabase_auth_admin;
GRANT EXECUTE ON FUNCTION auth.jwt(), auth.uid() TO anon, authenticated, service_role;
GRANT SELECT ON auth.users TO supabase_auth_admin;
`;

(async () => {
  console.log('\n═══════════════════════════════════════');
  console.log('  Phase 2／3 前置：現查在職、停權對象、擋自設密碼 Hook（145／147，PGlite 實跑）');
  console.log('═══════════════════════════════════════');

  const db = new PGlite();
  const q = async (sql, params) => (await db.query(sql, params)).rows;
  const one = async (sql, params) => (await q(sql, params))[0];
  await db.exec(snapshot);
  await db.exec(AUTH_STUB);

  async function as(role, claims, sql, params) {
    try {
      await db.exec('SET ROLE ' + role);
      await db.query(`SELECT set_config('request.jwt.claims', $1, false)`, [claims ? JSON.stringify(claims) : '']);
      return { rows: (await db.query(sql, params)).rows };
    } catch (e) {
      return { error: e.message, code: e.code };
    } finally {
      await db.exec('RESET ROLE');
      await db.query(`SELECT set_config('request.jwt.claims', '', false)`);
    }
  }
  const jwt = (sub, lid, extra = {}) => ({ role: 'authenticated', sub, app_metadata: { line_user_id: lid, company_ids: [A, B] }, ...extra });
  const caller = async (claims, role = 'authenticated') => {
    const r = await as(role, claims, 'SELECT public.caller_line_user_id() AS v');
    return r.error ? { error: r.error } : r.rows[0].v;
  };
  const companies = async (claims) => {
    const r = await as('authenticated', claims, 'SELECT public.caller_company_ids()::text[] AS v');
    return r.error ? { error: r.error } : r.rows[0].v;
  };
  const denied = r => typeof r?.error === 'string' && /permission denied/.test(r.error);
  const NEW_FNS = ['caller_line_user_id', 'line_auth_identity_is_active', 'caller_company_ids', 'line_auth_reconcile_targets', 'line_auth_reconcile_needed',
    'line_auth_access_token_hook', 'line_auth_password_verification_hook'];
  const state = async () => JSON.stringify({
    fns: await q(`SELECT p.oid::regprocedure::text AS sig, md5(pg_get_functiondef(p.oid)) AS def, coalesce(p.proacl::text, '') AS acl
                  FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname <> ALL($1) ORDER BY 1`, [NEW_FNS]),
    pols: await q('SELECT schemaname, tablename, policyname, cmd, roles::text, qual, with_check FROM pg_policies ORDER BY 1, 2, 3'),
    rels: await q(`SELECT c.oid::regclass::text AS t, coalesce(c.relacl::text, '') AS acl, c.relrowsecurity AS rls FROM pg_class c
                   WHERE c.relnamespace IN ('public'::regnamespace, 'auth'::regnamespace) AND c.relkind IN ('r','v','p') ORDER BY 1`),
  });
  const callerDef = async () => (await one(`SELECT md5(pg_get_functiondef('public.caller_line_user_id()'::regprocedure)) AS d,
      coalesce((SELECT proacl::text FROM pg_proc WHERE oid = 'public.caller_line_user_id()'::regprocedure), '') AS acl`));
  const x = s => db.exec(s);

  await x(`
    INSERT INTO public.companies (id, code, name) VALUES ('${A}', 'A', '大正科技'), ('${B}', 'B', '本米');
    INSERT INTO public.employees (company_id, employee_number, name, line_user_id, role, is_active) VALUES
      ('${A}', 'E01', '員工', '${U.e1}', 'user', true),
      ('${A}', 'E09', '離職', '${U.quit}', 'user', false),
      ('${A}', 'E10', '兩家都在', '${U.both}', 'user', true),
      ('${B}', 'B10', '兩家都在', '${U.both}', 'user', true);
    INSERT INTO public.platform_admins (id, line_user_id, name) VALUES ('${PA_ID}', '${U.pa}', '平台');
    INSERT INTO public.platform_admin_companies (platform_admin_id, company_id, role) VALUES ('${PA_ID}', '${B}', 'owner');
    INSERT INTO auth.users (id, email, raw_app_meta_data, created_at) VALUES
      ('${AU.e1}', 'e1@line-auth.invalid', '{"provider":"email","line_user_id":"${U.e1}"}', now() - interval '5 day'),
      ('${AU.quit}', 'quit@line-auth.invalid', '{"provider":"email","line_user_id":"${U.quit}"}', now() - interval '4 day'),
      ('${AU.pa}', 'pa@line-auth.invalid', '{"provider":"email","line_user_id":"${U.pa}"}', now() - interval '3 day'),
      ('${AU.both}', 'both@line-auth.invalid', '{"provider":"email","line_user_id":"${U.both}"}', now() - interval '2 day'),
      ('${AU.plain}', 'someone@example.com', '{"provider":"email"}', now() - interval '1 day');
  `);

  await x(m138);
  const before = await state();
  const def138 = await callerDef();
  console.log('\n=== 套用前（138 原文）===');
  let r = await caller(jwt(AU.quit, U.quit));
  check('反向對照基準：138 下離職者的 JWT 仍有身分（這正是要修的洞）', r === U.quit, String(r));

  console.log('\n=== 套 145 ===');
  let ok = true;
  try { await x(m145); } catch (e) { ok = false; check('145 可套用', false, e.message); }
  if (ok) check('145 可套用', true);
  check('其他 public 函式本體／權限、所有政策、表權限與 RLS 完全不變', (await state()) === before);
  const def145 = await callerDef();
  check('caller_line_user_id 權限與 138 相同（anon／authenticated／service_role 可執行）', def145.acl === def138.acl, def145.acl);
  r = await one(`SELECT p.prosecdef, pg_get_userbyid(p.proowner) AS owner FROM pg_proc p WHERE p.oid = 'public.caller_line_user_id()'::regprocedure`);
  check('caller_line_user_id 改為 SECURITY DEFINER、擁有者 postgres（才能現查 employees／auth.users）', r.prosecdef === true && r.owner === 'postgres', JSON.stringify(r));

  console.log('\n=== caller_line_user_id()：現查在職 ===');
  check('在職員工：回傳 LINE userId', (await caller(jwt(AU.e1, U.e1))) === U.e1);
  check('兩家公司都在職：回傳', (await caller(jwt(AU.both, U.both))) === U.both);
  check('啟用中的平台管理員（沒有員工資料）：回傳', (await caller(jwt(AU.pa, U.pa))) === U.pa);
  check('離職員工（is_active=false）的 JWT：NULL', (await caller(jwt(AU.quit, U.quit))) === null);
  await x(`UPDATE public.employees SET is_active = false, status = 'resigned' WHERE line_user_id = '${U.e1}'`);
  check('在職 → 設為離職：同一個 JWT 立刻 NULL（不必等 JWT 過期）', (await caller(jwt(AU.e1, U.e1))) === null);
  await x(`UPDATE public.employees SET is_active = true, status = 'approved' WHERE line_user_id = '${U.e1}'`);
  check('回任：立刻恢復', (await caller(jwt(AU.e1, U.e1))) === U.e1);
  await x(`UPDATE public.employees SET is_active = false WHERE line_user_id = '${U.both}' AND company_id = '${A}'`);
  check('兩家之一離職、另一家仍在職：仍有身分（公司層級授權用 caller_company_ids）', (await caller(jwt(AU.both, U.both))) === U.both);
  await x(`UPDATE public.platform_admins SET is_active = false WHERE id = '${PA_ID}'`);
  check('平台管理員停用：NULL', (await caller(jwt(AU.pa, U.pa))) === null);
  await x(`UPDATE public.platform_admins SET is_active = true WHERE id = '${PA_ID}'`);
  check('平台管理員重新啟用：恢復', (await caller(jwt(AU.pa, U.pa))) === U.pa);

  console.log('\n=== caller_line_user_id()：Auth 帳號狀態 ===');
  await x(`UPDATE auth.users SET banned_until = now() + interval '100 years' WHERE id = '${AU.e1}'`);
  check('Auth 帳號被停權（ban）：NULL', (await caller(jwt(AU.e1, U.e1))) === null);
  await x(`UPDATE auth.users SET banned_until = now() - interval '1 minute' WHERE id = '${AU.e1}'`);
  check('停權已到期：恢復', (await caller(jwt(AU.e1, U.e1))) === U.e1);
  await x(`UPDATE auth.users SET deleted_at = now() WHERE id = '${AU.e1}'`);
  check('Auth 帳號軟刪除：NULL', (await caller(jwt(AU.e1, U.e1))) === null);
  await x(`UPDATE auth.users SET deleted_at = NULL WHERE id = '${AU.e1}'`);
  check('JWT 的 sub 是別人的帳號（sub 與 line_user_id 對不上）：NULL', (await caller(jwt(AU.both, U.e1))) === null);
  check('JWT 的 sub 在 auth.users 不存在（帳號已刪）：NULL', (await caller(jwt('00000000-0000-4000-8000-00000000dead', U.e1))) === null);
  check('JWT 沒有 sub：NULL', (await caller({ role: 'authenticated', app_metadata: { line_user_id: U.e1 } })) === null);
  check('sub 不是 UUID（夾帶字元）：NULL、不報錯', (await caller(jwt('x-or-1=1;--', U.e1))) === null);
  await x(`UPDATE auth.users SET raw_app_meta_data = '{"provider":"email","line_user_id":"${U.both}"}' WHERE id = '${AU.e1}'`);
  check('Auth 帳號的 app_metadata 已被 admin 改成別的 LINE userId（舊 JWT）：NULL', (await caller(jwt(AU.e1, U.e1))) === null);
  await x(`UPDATE auth.users SET raw_app_meta_data = '{"provider":"email","line_user_id":"${U.e1}"}' WHERE id = '${AU.e1}'`);

  console.log('\n=== caller_line_user_id()：138 原有條件照舊 ===');
  check('anon：NULL', (await caller({ role: 'anon' }, 'anon')) === null);
  check('role=anon 帶 app_metadata：NULL', (await caller({ role: 'anon', sub: AU.e1, app_metadata: { line_user_id: U.e1 } }, 'anon')) === null);
  check('只有 user_metadata：NULL', (await caller({ role: 'authenticated', sub: AU.e1, user_metadata: { line_user_id: U.e1 } })) === null);
  check('格式不是 LINE userId：NULL', (await caller(jwt(AU.e1, 'Uabc'))) === null);
  check('沒有 JWT：NULL、不報錯', (await caller(null)) === null);
  check('service_role：NULL', (await caller({ role: 'service_role' }, 'service_role')) === null);
  r = await as('authenticated', jwt(AU.e1, U.e1), 'SELECT public.line_auth_whoami() AS v');
  check('138 的 line_auth_whoami 照常（在職者）', r.rows?.[0]?.v?.line_user_id === U.e1, JSON.stringify(r.rows?.[0]?.v || r.error));
  r = await as('authenticated', jwt(AU.quit, U.quit), 'SELECT public.line_auth_whoami() AS v');
  check('line_auth_whoami：離職者的 line_user_id 為 null（auth_uid 照實）', r.rows?.[0]?.v?.line_user_id === null && r.rows[0].v.auth_uid === AU.quit, JSON.stringify(r.rows?.[0]?.v || r.error));

  console.log('\n=== caller_company_ids()：現查公司 ===');
  r = await companies(jwt(AU.both, U.both));
  check('兩家之一已離職：只回仍在職的那家（JWT 說兩家也不採信）', JSON.stringify(r) === JSON.stringify([B]), JSON.stringify(r));
  await x(`UPDATE public.employees SET is_active = true WHERE line_user_id = '${U.both}'`);
  r = await companies(jwt(AU.both, U.both));
  check('兩家都在職：兩家', Array.isArray(r) && r.length === 2 && r.includes(A) && r.includes(B), JSON.stringify(r));
  r = await companies(jwt(AU.pa, U.pa));
  check('平台管理員：綁定的公司', JSON.stringify(r) === JSON.stringify([B]), JSON.stringify(r));
  r = await companies(jwt(AU.quit, U.quit));
  check('離職者：空陣列', Array.isArray(r) && r.length === 0, JSON.stringify(r));
  r = await as('anon', { role: 'anon' }, 'SELECT public.caller_company_ids()::text[] AS v');
  check('anon：空陣列、不報錯', Array.isArray(r.rows?.[0]?.v) && r.rows[0].v.length === 0, JSON.stringify(r.rows?.[0]?.v || r.error));

  console.log('\n=== 停權對象（line_auth_reconcile_targets／needed）===');
  const targets = async (role = 'service_role', lim = 50) => {
    const t = await as(role, { role }, 'SELECT public.line_auth_reconcile_targets($1) AS v', [lim]);
    return t.error ? { error: t.error } : t.rows[0].v;
  };
  const needed = async () => (await as('service_role', { role: 'service_role' }, 'SELECT public.line_auth_reconcile_needed() AS v')).rows?.[0]?.v;
  for (const role of ['anon', 'authenticated']) {
    check(role + ' 不能呼叫 line_auth_reconcile_targets', denied(await targets(role)));
    check(role + ' 不能呼叫 line_auth_reconcile_needed', denied(await as(role, { role }, 'SELECT public.line_auth_reconcile_needed()')));
    check(role + ' 不能呼叫 line_auth_identity_is_active（不能拿來查誰在職）', denied(await as(role, { role }, 'SELECT public.line_auth_identity_is_active($1)', [U.e1])));
  }
  r = await targets();
  check('只列離職者（在職、平台管理員、非 LINE 帳號都不列）', r?.success === true && r.total === 1 && JSON.stringify(r.targets) === JSON.stringify([AU.quit]), JSON.stringify(r));
  check('needed＝true', (await needed()) === true);
  await x(`UPDATE public.employees SET is_active = false WHERE line_user_id = '${U.e1}'`);
  await x(`UPDATE public.platform_admins SET is_active = false WHERE id = '${PA_ID}'`);
  r = await targets('service_role', 2);
  check('多人離職＋平台管理員停用：total 3，limit 2 只回最早建立的 2 筆', r?.total === 3 && JSON.stringify(r.targets) === JSON.stringify([AU.e1, AU.quit]), JSON.stringify(r));
  await x(`UPDATE auth.users SET banned_until = now() + interval '100 years' WHERE id IN ('${AU.e1}', '${AU.quit}')`);
  await x(`UPDATE auth.users SET deleted_at = now() WHERE id = '${AU.pa}'`);
  r = await targets();
  check('已停權、已刪除的不再列入（冪等）', r?.total === 0 && r.targets.length === 0, JSON.stringify(r));
  check('needed＝false（排程不會打 HTTP）', (await needed()) === false);
  await x(`UPDATE auth.users SET banned_until = NULL, deleted_at = NULL; UPDATE public.employees SET is_active = true WHERE line_user_id = '${U.e1}'; UPDATE public.platform_admins SET is_active = true WHERE id = '${PA_ID}';`);

  console.log('\n=== 146 排程（pg_cron 在 PGlite 不存在：靜態檢查＋以 pg_net 替身實跑排程指令）===');
  {
    const anon = (commonJs.match(/SUPABASE_ANON_KEY:\s*'([^']+)'/) || [])[1];
    const role = anon ? JSON.parse(Buffer.from(anon.split('.')[1], 'base64url').toString()).role : null;
    check('146 用的是前端已公開的 anon key（不是 service role）', !!anon && m146.includes('Bearer ' + anon) && role === 'anon' && !/service_role/.test(m146.replace(/--[^\n]*/g, '')), role);
    check('146 打的是本專案的 line-auth、body 是 reconcile', m146.includes("url := 'https://nssuisyvlrqnqfxupklb.supabase.co/functions/v1/line-auth'") && m146.includes("jsonb_build_object('action', 'reconcile')"));
    check('146 排程名稱與頻率：line-auth-reconcile、*/5', /cron\.schedule\(\s*'line-auth-reconcile',\s*'\*\/5 \* \* \* \*'/.test(m146));
    check('146 開頭檢查 145 已套、pg_cron／pg_net 已啟用、不重複排程', m146.includes("to_regprocedure('public.line_auth_reconcile_needed()') IS NULL") && m146.includes("extname = 'pg_net'") && m146.includes("jobname = 'line-auth-reconcile'"));
    check('146 回滾只 unschedule 這一個排程', /cron\.unschedule\('line-auth-reconcile'\)/.test(m146rb) && !/DROP|DELETE/i.test(m146rb.replace(/--[^\n]*/g, '')));
    const cmd = (m146.match(/\$cron\$([\s\S]*?)\$cron\$/) || [])[1];
    check('取得排程指令', !!cmd);
    await x(`CREATE SCHEMA net; CREATE TABLE net.test_calls (url text, body jsonb, headers jsonb, timeout int);
      CREATE FUNCTION net.http_post(url text, body jsonb DEFAULT '{}'::jsonb, params jsonb DEFAULT '{}'::jsonb, headers jsonb DEFAULT '{}'::jsonb, timeout_milliseconds integer DEFAULT 5000)
      RETURNS bigint LANGUAGE sql AS $n$ INSERT INTO net.test_calls VALUES (url, body, headers, timeout_milliseconds) RETURNING 1::bigint $n$;`);
    const calls = async () => (await one('SELECT count(*)::int AS n FROM net.test_calls')).n;
    await x(`UPDATE auth.users SET banned_until = now() + interval '1 day' WHERE id = '${AU.quit}'`);
    await x(cmd);
    check('沒有離職未停權的人：排程指令不打 HTTP', (await calls()) === 0);
    await x(`UPDATE auth.users SET banned_until = NULL WHERE id = '${AU.quit}'`);
    await x(cmd);
    const c1 = await one('SELECT * FROM net.test_calls');
    check('有對象：打一次 line-auth（anon key、reconcile、10 秒逾時）', (await calls()) === 1 && c1.body.action === 'reconcile' && c1.headers.Authorization === 'Bearer ' + anon && c1.timeout === 10000, JSON.stringify(c1));
    await x('DROP SCHEMA net CASCADE');
  }

  console.log('\n=== 與 141（Phase 2 wrapper）相容 ===');
  if (!m141) {
    console.log('  ⚠️ 略過：repo 內沒有 141（#8 尚未合併）；可用 MIGRATION141_FILE 指定 141 檔');
  } else {
    const sec = m141.slice(m141.indexOf('-- ===== A. 設定與紀錄 ====='), m141.indexOf('-- ===== C. wrapper'));
    check('141 的 assert_caller 直接呼叫 caller_line_user_id()（145 改這一支即對全部 wrapper 生效）',
      sec.includes('CREATE FUNCTION public.assert_caller') && sec.includes('public.caller_line_user_id()'));
    try {
      await x(sec);
      await x(`CREATE FUNCTION public.demo_rpc(p_line_user_id text) RETURNS text LANGUAGE plpgsql VOLATILE SECURITY DEFINER AS $w$
        BEGIN PERFORM public.assert_caller($1::text, 'demo_rpc'); RETURN 'ok:' || $1; END; $w$;
        GRANT EXECUTE ON FUNCTION public.demo_rpc(text) TO anon, authenticated;`);
      const demo = (claims, lid) => as('authenticated', claims, 'SELECT public.demo_rpc($1) AS v', [lid]);
      await x(`UPDATE public.line_auth_caller_settings SET mode = 'enforce' WHERE fn_name = '*'`);
      r = await demo(jwt(AU.e1, U.e1), U.e1);
      check('enforce：在職者本人 → 放行', r.rows?.[0]?.v === 'ok:' + U.e1, JSON.stringify(r));
      await x(`UPDATE public.employees SET is_active = false WHERE line_user_id = '${U.e1}'`);
      r = await demo(jwt(AU.e1, U.e1), U.e1);
      check('enforce：同一個 JWT、設為離職當下 → 42501 拒絕', r.code === '42501', JSON.stringify(r));
      await x(`UPDATE public.employees SET is_active = true WHERE line_user_id = '${U.e1}'`);
      await x(`UPDATE auth.users SET banned_until = now() + interval '1 day' WHERE id = '${AU.e1}'`);
      r = await demo(jwt(AU.e1, U.e1), U.e1);
      check('enforce：Auth 帳號被停權 → 拒絕', r.code === '42501', JSON.stringify(r));
      await x(`UPDATE auth.users SET banned_until = NULL WHERE id = '${AU.e1}'`);
      await x(`UPDATE public.line_auth_caller_settings SET mode = 'soft' WHERE fn_name = '*'`);
      r = await demo(jwt(AU.quit, U.quit), U.quit);
      const lg = await one('SELECT claim_present, caller_role FROM public.line_auth_caller_log ORDER BY id DESC LIMIT 1');
      check('soft：離職者照常放行、記一筆 claim_present=false（視為沒有身分）', r.rows?.[0]?.v === 'ok:' + U.quit && lg?.claim_present === false && lg.caller_role === 'authenticated', JSON.stringify({ r, lg }));
      await x('DROP FUNCTION public.demo_rpc(text); DROP FUNCTION public.assert_caller(text, text); DROP TABLE public.line_auth_caller_log; DROP TABLE public.line_auth_caller_settings;');
    } catch (e) { check('141 相容測試可執行', false, e.message); }
  }

  console.log('\n=== 145 回滾／重套 ===');
  try { await x(m145); check('重複套用 145：中止', false); } catch (e) { await x('ROLLBACK'); check('重複套用 145：中止（已套用過）', /已套用過/.test(e.message), e.message); }
  await x(m145rb);
  const defRb = await callerDef();
  check('回滾後 caller_line_user_id 與 138 原文完全相同（定義 md5、權限）', defRb.d === def138.d && defRb.acl === def138.acl, JSON.stringify({ defRb, def138 }));
  check('回滾後新增函式都不存在', (await one(`SELECT count(*)::int AS n FROM pg_proc WHERE proname IN ('line_auth_identity_is_active','caller_company_ids','line_auth_reconcile_targets','line_auth_reconcile_needed')`)).n === 0);
  check('回滾後其他狀態與套用前逐項相同', (await state()) === before);
  ok = true;
  try { await x(m145); } catch (e) { ok = false; check('回滾後可重套 145', false, e.message); }
  if (ok) check('回滾後可重套 145', true);
  check('重套後離職者仍是 NULL', (await caller(jwt(AU.quit, U.quit))) === null);

  console.log('\n=== 147：擋自設密碼的 Auth Hook ===');
  try { await x(m147); check('147 可套用', true); } catch (e) { check('147 可套用', false, e.message); }
  const hook = async (event, role = 'supabase_auth_admin') => {
    const h = await as(role, null, 'SELECT public.line_auth_access_token_hook($1::jsonb) AS v', [JSON.stringify(event)]);
    return h.error ? { error: h.error } : h.rows[0].v;
  };
  const claims = (lid, amr) => ({ aud: 'authenticated', exp: 1900000000, iat: 1899996400, sub: AU.e1, role: 'authenticated', aal: 'aal1',
    session_id: '5b2c6c8e-0000-4000-8000-000000000001', email: 'e1@line-auth.invalid', phone: '', is_anonymous: false,
    app_metadata: lid ? { provider: 'email', line_user_id: lid } : { provider: 'email' }, user_metadata: {}, amr });
  const at = 1899996400;
  let c = claims(U.e1, [{ method: 'otp', timestamp: at }]);
  r = await hook({ user_id: AU.e1, claims: c, authentication_method: 'otp' });
  check('LINE 帳號、line-auth 流程（otp）：放行，claims 一字不改', same(r, { claims: c }), JSON.stringify(r));
  r = await hook({ user_id: AU.e1, claims: c, authentication_method: 'magiclink' });
  check('authentication_method=magiclink：放行', same(r?.claims, c));
  r = await hook({ user_id: AU.e1, claims: c, authentication_method: 'token_refresh' });
  check('refresh（amr=otp）：放行', same(r?.claims, c));
  r = await hook({ user_id: AU.e1, claims: claims(U.e1, [{ method: 'password', timestamp: at }]), authentication_method: 'password' });
  check('LINE 帳號用密碼登入：403 拒絕（不回 claims）', r?.error?.http_code === 403 && typeof r.error.message === 'string' && !('claims' in r), JSON.stringify(r));
  r = await hook({ user_id: AU.e1, claims: claims(U.e1, [{ method: 'password', timestamp: at }]), authentication_method: 'token_refresh' });
  check('LINE 帳號 refresh 一個「用密碼建立的 session」（amr=password）：403 拒絕', r?.error?.http_code === 403, JSON.stringify(r));
  r = await hook({ user_id: AU.e1, claims: claims(U.e1, ['password']), authentication_method: 'token_refresh' });
  check('amr 是字串陣列形式也擋', r?.error?.http_code === 403, JSON.stringify(r));
  r = await hook({ user_id: AU.e1, claims: claims(U.e1, [{ method: 'otp', timestamp: at }, { method: 'totp', timestamp: at }]), authentication_method: 'totp' });
  check('amr 混入其他方法（非 otp／magiclink）：拒絕（白名單）', r?.error?.http_code === 403, JSON.stringify(r));
  c = claims(null, [{ method: 'password', timestamp: at }]);
  r = await hook({ user_id: AU.plain, claims: c, authentication_method: 'password' });
  check('非 LINE 帳號用密碼：不處理、claims 一字不改', same(r, { claims: c }), JSON.stringify(r));
  c = claims(U.e1, null); delete c.amr;
  r = await hook({ user_id: AU.e1, claims: c, authentication_method: 'otp' });
  check('沒有 amr 欄位：放行、不報錯', same(r?.claims, c), JSON.stringify(r));
  r = await hook({ user_id: AU.e1 });
  check('沒有 claims（非預期輸入）：原樣回傳、不報錯', JSON.stringify(r) === JSON.stringify({ user_id: AU.e1 }), JSON.stringify(r));
  r = await hook({ user_id: AU.e1, claims: 'x' });
  check('claims 不是物件：原樣回傳、不報錯', r?.claims === 'x', JSON.stringify(r));
  r = await hook({ user_id: AU.e1, claims: claims(U.e1, 'weird'), authentication_method: 'otp' });
  check('amr 不是陣列：放行、不報錯', r?.claims?.amr === 'weird', JSON.stringify(r));

  const pv = async (event, role = 'supabase_auth_admin') => {
    const h = await as(role, null, 'SELECT public.line_auth_password_verification_hook($1::jsonb) AS v', [JSON.stringify(event)]);
    return h.error ? { error: h.error } : h.rows[0].v;
  };
  r = await pv({ user_id: AU.e1, valid: true });
  check('Password Verification Hook：LINE 帳號密碼正確也 reject＋登出', r?.decision === 'reject' && r.should_logout_user === true, JSON.stringify(r));
  r = await pv({ user_id: AU.plain, valid: true });
  check('Password Verification Hook：非 LINE 帳號 continue', r?.decision === 'continue', JSON.stringify(r));
  r = await pv({ user_id: 'not-a-uuid', valid: false });
  check('Password Verification Hook：user_id 不是 UUID → continue、不報錯', r?.decision === 'continue', JSON.stringify(r));
  r = await pv({ user_id: '00000000-0000-4000-8000-00000000dead', valid: true });
  check('Password Verification Hook：找不到帳號 → continue', r?.decision === 'continue', JSON.stringify(r));

  for (const role of ['anon', 'authenticated', 'service_role']) {
    check(role + ' 不能呼叫 access token hook', denied(await hook({ claims: {} }, role)));
    check(role + ' 不能呼叫 password verification hook', denied(await pv({ user_id: AU.e1 }, role)));
  }
  check('147 不影響其他 public 函式／政策／表權限', (await state()) === before);
  await x(m147rb);
  check('147 回滾後兩支 Hook 函式都不存在', (await one(`SELECT count(*)::int AS n FROM pg_proc WHERE proname IN ('line_auth_access_token_hook','line_auth_password_verification_hook')`)).n === 0);
  try { await x(m147); check('147 回滾後可重套', true); } catch (e) { check('147 回滾後可重套', false, e.message); }

  console.log('\n結果：' + pass + ' 通過、' + fail + ' 失敗');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('  ❌ 中途失敗：' + e.message); console.log('\n結果：' + pass + ' 通過、' + (fail + 1) + ' 失敗'); process.exit(1); });
