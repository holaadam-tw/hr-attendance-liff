// ============================================================
// migration 135：P1 身分根治 Phase 1（caller_line_user_id／line_auth_resolve／line_auth_whoami）— PGlite 實跑
//
// 不連線、不寫正式庫。流程：
//   1. 正式庫快照（tests/fixtures/phase0_prod_snapshot.sql）＋ auth schema 最小替身（auth.users、auth.jwt()／auth.uid()
//      與正式庫定義逐字相同：讀 request.jwt.claim(s)）
//   2. 套用前：函式不存在（反向對照）
//   3. 套 135：JWT 取 LINE userId 的各種情境（authenticated／anon／user_metadata 偽造／格式不符）、
//      resolve 的權限與結果、whoami
//   4. 零行為變更：套用前後，既有 public 函式本體與權限、所有 RLS 政策、表權限逐項相同
//   5. 回滾 → 回到原狀 → 可重複套用
// 反向對照：MIGRATION135_FILE 指向空檔 → 大量失敗
// ============================================================
const fs = require('fs');
const path = require('path');
const { PGlite } = require('@electric-sql/pglite');

const root = path.join(__dirname, '..');
const read = f => fs.readFileSync(f, 'utf8');
const snapshot = read(path.join(__dirname, 'fixtures', 'phase0_prod_snapshot.sql'));
const m135 = read(process.env.MIGRATION135_FILE || path.join(root, 'migrations', '135_line_auth_phase1.sql'));
const m135rb = read(path.join(root, 'migrations', '135_line_auth_phase1_rollback.sql'));

let pass = 0, fail = 0;
function check(name, condition, detail = '') {
  if (condition) { pass++; console.log(`  ✅ ${name}${detail ? `  → ${detail}` : ''}`); }
  else { fail++; console.log(`  ❌ ${name}${detail ? `  → ${detail}` : ''}`); }
}

const A = '8a669e2c-7521-43e9-9300-5c004c57e9db';
const B = '11111111-2222-3333-4444-555555555555';
const U = { admin: 'U' + 'a'.repeat(32), e1: 'U' + '1'.repeat(32), quit: 'U' + '9'.repeat(32), pa: 'U' + 'b'.repeat(32), both: 'U' + 'c'.repeat(32), stranger: 'U' + 'd'.repeat(32) };
const AUTH1 = '00000000-0000-4000-8000-0000000000a1';

// auth schema 替身：auth.jwt()／auth.uid() 與正式庫定義相同（2026-09-28 pg_get_functiondef 唯讀取得）
const AUTH_STUB = `
CREATE SCHEMA IF NOT EXISTS auth;
CREATE TABLE IF NOT EXISTS auth.users (
  id UUID PRIMARY KEY, email TEXT, raw_app_meta_data JSONB, raw_user_meta_data JSONB, created_at TIMESTAMPTZ DEFAULT now()
);
CREATE OR REPLACE FUNCTION auth.jwt() RETURNS jsonb LANGUAGE sql STABLE AS $f$
  select coalesce(nullif(current_setting('request.jwt.claim', true), ''), nullif(current_setting('request.jwt.claims', true), ''))::jsonb
$f$;
CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $f$
  select coalesce(nullif(current_setting('request.jwt.claim.sub', true), ''), (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub'))::uuid
$f$;
GRANT USAGE ON SCHEMA auth TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION auth.jwt(), auth.uid() TO anon, authenticated, service_role;
`;

(async () => {
  console.log('\n═══════════════════════════════════════');
  console.log('  P1 Phase 1：caller_line_user_id／line_auth_resolve（135，PGlite 實跑）');
  console.log('═══════════════════════════════════════');

  const db = new PGlite();
  const q = async (sql, params) => (await db.query(sql, params)).rows;
  const one = async (sql, params) => (await q(sql, params))[0];
  await db.exec(snapshot);
  await db.exec(AUTH_STUB);

  async function as(role, claims, sql, params) {
    try {
      await db.exec(`SET ROLE ${role}`);
      await db.query(`SELECT set_config('request.jwt.claims', $1, false)`, [claims ? JSON.stringify(claims) : '']);
      return { rows: (await db.query(sql, params)).rows };
    } catch (e) {
      return { error: e.message };
    } finally {
      await db.exec(`RESET ROLE`);
      await db.query(`SELECT set_config('request.jwt.claims', '', false)`);
    }
  }
  const callerAs = async (role, claims) => {
    const r = await as(role, claims, `SELECT public.caller_line_user_id() AS v`);
    return r.error ? { error: r.error } : r.rows[0].v;
  };
  const resolve = async (role, uid) => {
    const r = await as(role, { role }, `SELECT public.line_auth_resolve($1) AS v`, [uid]);
    return r.error ? { error: r.error } : r.rows[0].v;
  };
  const denied = r => typeof r?.error === 'string' && /permission denied/.test(r.error);

  // 零行為變更用的快照：既有 public 函式（本體＋權限）、政策、表權限
  const state = async () => JSON.stringify({
    fns: await q(`SELECT p.oid::regprocedure::text AS sig, md5(pg_get_functiondef(p.oid)) AS def, coalesce(p.proacl::text, '') AS acl
                  FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace
                    AND p.proname NOT IN ('caller_line_user_id', 'line_auth_resolve', 'line_auth_whoami') ORDER BY 1`),
    pols: await q(`SELECT schemaname, tablename, policyname, cmd, roles::text, qual, with_check FROM pg_policies ORDER BY 1, 2, 3`),
    rels: await q(`SELECT c.oid::regclass::text AS t, coalesce(c.relacl::text, '') AS acl, c.relrowsecurity AS rls FROM pg_class c
                   WHERE c.relnamespace IN ('public'::regnamespace, 'auth'::regnamespace) AND c.relkind IN ('r','v','p') ORDER BY 1`),
  });

  await db.exec(`
    INSERT INTO public.companies (id, code, name) VALUES ('${A}', 'A', '大正科技'), ('${B}', 'B', '本米');
    INSERT INTO public.employees (company_id, employee_number, name, line_user_id, role, is_active) VALUES
      ('${A}', 'A01', '主管', '${U.admin}', 'admin', true),
      ('${A}', 'E01', '員工', '${U.e1}', 'user', true),
      ('${A}', 'E09', '離職', '${U.quit}', 'user', false),
      ('${A}', 'E10', '兩家都在', '${U.both}', 'user', true),
      ('${B}', 'B10', '兩家都在', '${U.both}', 'user', true);
    INSERT INTO public.platform_admins (id, line_user_id, name) VALUES ('00000000-0000-0000-0000-00000000fa01', '${U.pa}', '平台');
    INSERT INTO public.platform_admin_companies (platform_admin_id, company_id, role) VALUES ('00000000-0000-0000-0000-00000000fa01', '${B}', 'owner');
    INSERT INTO auth.users (id, email, raw_app_meta_data) VALUES ('${AUTH1}', '${U.e1.toLowerCase()}@line-auth.invalid', '{"provider":"email","line_user_id":"${U.e1}"}');
  `);

  console.log('\n=== 套用前 ===');
  let r = await callerAs('authenticated', { role: 'authenticated', app_metadata: { line_user_id: U.e1 } });
  check('套用前：caller_line_user_id 不存在（反向對照基準）', typeof r?.error === 'string');
  const before = await state();

  console.log('\n=== 套 135 ===');
  let ok = true;
  try { await db.exec(m135); } catch (e) { ok = false; check('135 可在 PostgreSQL 套用', false, e.message); }
  if (ok) check('135 可在 PostgreSQL 套用', true);
  check('零行為變更：既有 public 函式本體／權限、所有政策、表權限與 RLS 完全不變', (await state()) === before);

  console.log('\n=== caller_line_user_id() ===');
  r = await callerAs('authenticated', { role: 'authenticated', sub: AUTH1, app_metadata: { line_user_id: U.e1 } });
  check('authenticated＋app_metadata.line_user_id：回傳 LINE userId', r === U.e1, String(r));
  r = await callerAs('anon', { role: 'anon' });
  check('anon key（沒有 app_metadata）：NULL（anon 可呼叫、不報錯）', r === null);
  r = await callerAs('anon', { role: 'anon', app_metadata: { line_user_id: U.e1 } });
  check('role=anon 就算帶 app_metadata 也 NULL', r === null);
  r = await callerAs('authenticated', { role: 'authenticated', user_metadata: { line_user_id: U.admin } });
  check('只有 user_metadata（使用者自己改得到的欄位）：NULL（不採信）', r === null);
  r = await callerAs('authenticated', { role: 'authenticated', app_metadata: { line_user_id: 'Uadmin' } });
  check('格式不是 LINE userId：NULL', r === null);
  r = await callerAs('authenticated', { role: 'authenticated', app_metadata: { line_user_id: U.e1 + "' OR 1=1" } });
  check('夾帶字元：NULL', r === null);
  r = await callerAs('authenticated', null);
  check('沒有 JWT claims：NULL', r === null);
  r = await callerAs('service_role', { role: 'service_role' });
  check('service_role：NULL（身分只來自使用者 session）', r === null);

  console.log('\n=== line_auth_resolve()（只給 service role）===');
  for (const role of ['anon', 'authenticated']) {
    r = await resolve(role, U.e1);
    check(`${role} 不能呼叫 line_auth_resolve（不能拿來查誰是員工／帳號對應）`, denied(r), r?.error);
  }
  r = await resolve('service_role', U.e1);
  check('已有 Auth 帳號的在職員工：known、公司 A、帶回 auth_user_id／email', r?.success === true && r.known === true
    && JSON.stringify(r.company_ids) === JSON.stringify([A]) && r.auth_user_id === AUTH1 && r.auth_email === U.e1.toLowerCase() + '@line-auth.invalid', JSON.stringify(r));
  r = await resolve('service_role', U.admin);
  check('在職 admin、還沒有帳號：known、auth_user_id=null', r?.known === true && r.auth_user_id === null);
  r = await resolve('service_role', U.both);
  check('同一個 LINE 在兩家公司：company_ids 兩家', r?.known === true && r.company_ids.length === 2 && r.company_ids.includes(A) && r.company_ids.includes(B));
  r = await resolve('service_role', U.pa);
  check('平台管理員（沒有員工資料）：known、公司＝綁定的公司', r?.known === true && JSON.stringify(r.company_ids) === JSON.stringify([B]));
  r = await resolve('service_role', U.quit);
  check('離職員工：known=false（line-auth 不會發 session）', r?.success === true && r.known === false);
  r = await resolve('service_role', U.stranger);
  check('陌生 LINE 帳號：known=false', r?.success === true && r.known === false && r.company_ids.length === 0);
  r = await resolve('service_role', 'Uadmin');
  check('格式不符：invalid_line_user_id', r?.success === false && r.error_code === 'invalid_line_user_id');
  await db.exec(`INSERT INTO auth.users (id, email, raw_app_meta_data) VALUES ('00000000-0000-4000-8000-0000000000a2', 'dup@x.invalid', '{"line_user_id":"${U.e1}"}')`);
  r = await resolve('service_role', U.e1);
  check('同一個 LINE userId 對到兩個 Auth 帳號：duplicate_auth_user（不猜）', r?.success === false && r.error_code === 'duplicate_auth_user');
  await db.exec(`DELETE FROM auth.users WHERE id = '00000000-0000-4000-8000-0000000000a2'`);
  await db.exec(`INSERT INTO auth.users (id, email, raw_app_meta_data, raw_user_meta_data) VALUES ('00000000-0000-4000-8000-0000000000a3', 'spoof@x.invalid', '{}', '{"line_user_id":"${U.admin}"}')`);
  r = await resolve('service_role', U.admin);
  check('只在 user_metadata 寫 line_user_id 的帳號不會被當成對應帳號', r?.auth_user_id === null);

  console.log('\n=== line_auth_whoami() ===');
  r = await as('authenticated', { role: 'authenticated', sub: AUTH1, app_metadata: { line_user_id: U.e1 } }, `SELECT public.line_auth_whoami() AS v`);
  check('authenticated：回 role／auth_uid／line_user_id', r.rows?.[0]?.v?.line_user_id === U.e1 && r.rows[0].v.auth_uid === AUTH1 && r.rows[0].v.role === 'authenticated', JSON.stringify(r.rows?.[0]?.v || r.error));
  r = await as('anon', { role: 'anon' }, `SELECT public.line_auth_whoami() AS v`);
  check('anon 不能呼叫 whoami', denied(r), r.error);

  console.log('\n=== 回滾／重套 ===');
  await db.exec(m135rb);
  check('回滾後三個函式都不存在', !(await one(`SELECT count(*)::int AS n FROM pg_proc WHERE proname IN ('caller_line_user_id', 'line_auth_resolve', 'line_auth_whoami')`)).n);
  check('回滾後與套用前逐項相同', (await state()) === before);
  ok = true;
  try { await db.exec(m135); await db.exec(m135); } catch (e) { ok = false; check('135 可重複套用', false, e.message); }
  if (ok) check('135 可重複套用', true);

  console.log(`\n結果：${pass} 通過、${fail} 失敗`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('  ❌ 中途失敗：' + e.message); console.log(`\n結果：${pass} 通過、${fail + 1} 失敗`); process.exit(1); });
