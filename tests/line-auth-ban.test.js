// ============================================================
// line-auth：離職／停用者停權（ban）、回任解除、reconcile 動作（Phase 2／3 前置，145／146）handler.ts 實跑
//
// fetch 全部是假的（LINE、PostgREST、GoTrue admin／verify），不連線。
//   - reconcile：依 line_auth_reconcile_targets 逐一 PUT ban（ban_duration＋app_metadata.line_auth_banned），不需要 LIFF token；
//     回應不含 user id；關閉開關；145 未套 → 503；目標格式不對不處理
//   - 登入時 not_linked 但已有 Auth 帳號 → 停權（已停權的不動，保留人工停權）→ 403
//   - 在職者登入、帳號是本機制停權的 → 解除停權（ban_duration=none、清標記）再發 session；人工停權 → 403 account_disabled
// 反向對照：LINE_AUTH_HANDLER 指向 main 舊版 handler → 失敗
// ============================================================
const path = require('path');
const { pathToFileURL } = require('url');

let pass = 0, fail = 0;
function check(name, condition, detail = '') {
  if (condition) { pass++; console.log('  ✅ ' + name + (detail ? '  → ' + detail : '')); }
  else { fail++; console.log('  ❌ ' + name + (detail ? '  → ' + String(detail).slice(0, 400) : '')); }
}

const LINE_USER = 'U' + 'ab12'.repeat(8);
const AUTH_ID = '11111111-aaaa-4bbb-8ccc-000000000001';
const AUTH_ID2 = '11111111-aaaa-4bbb-8ccc-000000000002';
const COMPANY = '8a669e2c-7521-43e9-9300-5c004c57e9db';
const EMAIL = LINE_USER.toLowerCase() + '@line-auth.invalid';

function fakeFetch(routes) {
  const calls = [];
  const fn = async (url, init = {}) => {
    const method = (init.method || 'GET').toUpperCase();
    const body = init.body ? JSON.parse(init.body) : null;
    calls.push({ method, url, body, headers: init.headers || {} });
    for (const [m, part, responder] of routes) {
      if (m === method && url.includes(part)) {
        const r = typeof responder === 'function' ? responder(body, url) : responder;
        return new Response(JSON.stringify(r.body ?? {}), { status: r.status || 200, headers: { 'Content-Type': 'application/json' } });
      }
    }
    throw new Error('unexpected fetch ' + method + ' ' + url);
  };
  return { fn, calls };
}
const baseEnv = { SUPABASE_URL: 'https://db.test', SUPABASE_SERVICE_ROLE_KEY: 'service-key-SECRET', SUPABASE_ANON_KEY: 'anon-key' };
const post = body => new Request('https://fn/line-auth', { method: 'POST', body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } });
const future = () => new Date(Date.now() + 86400000 * 365).toISOString();
const past = () => new Date(Date.now() - 60000).toISOString();
const session = () => ({ access_token: 'access-SECRET', refresh_token: 'refresh-SECRET', expires_in: 3600, expires_at: 1900000000, token_type: 'bearer',
  user: { id: AUTH_ID, app_metadata: { line_user_id: LINE_USER, company_ids: [COMPANY] } } });
function routes(o = {}) {
  return [
    ['GET', '/oauth2/v2.1/verify', { body: { client_id: '2008962829', expires_in: 3600 } }],
    ['GET', '/v2/profile', { body: { userId: LINE_USER } }],
    ['POST', '/rest/v1/rpc/line_auth_reconcile_targets', o.targets || { body: { success: true, total: 0, targets: [] } }],
    ['POST', '/rest/v1/rpc/line_auth_resolve', o.resolve || { body: { success: true, known: true, company_ids: [COMPANY], auth_user_id: AUTH_ID, auth_email: EMAIL } }],
    ['GET', '/auth/v1/admin/users/', o.getUser || { body: { id: AUTH_ID, app_metadata: { line_user_id: LINE_USER, company_ids: [COMPANY] } } }],
    ['PUT', '/auth/v1/admin/users/', o.update || { body: { id: AUTH_ID } }],
    ['POST', '/auth/v1/admin/generate_link', { body: { id: AUTH_ID, hashed_token: 'hashed-SECRET' } }],
    ['POST', '/auth/v1/verify', { body: session() }],
  ];
}

(async () => {
  console.log('\n═══════════════════════════════════════');
  console.log('  line-auth：離職停權／回任解除／reconcile（handler.ts 實跑）');
  console.log('═══════════════════════════════════════');

  let mod;
  try {
    mod = await import(pathToFileURL(process.env.LINE_AUTH_HANDLER || path.join(__dirname, '..', 'supabase', 'functions', 'line-auth', 'handler.ts')).href);
  } catch (e) {
    if (e && e.code === 'ERR_UNKNOWN_FILE_EXTENSION') {
      console.log('  ⚠️ 略過：Node ' + process.version + ' 無法直接載入 .ts，請用 Node 22.18 以上執行');
      process.exit(0);
    }
    check('找得到 line-auth handler', false, e.message);
    console.log('\n結果：' + pass + ' 通過、' + fail + ' 失敗');
    process.exit(1);
  }
  const logs = [];
  const run = async (body, o = {}, extraEnv = {}) => {
    const f = fakeFetch(routes(o));
    const env = key => (key in extraEnv ? extraEnv[key] : baseEnv[key]);
    const res = await mod.handleLineAuth(post(body), { fetch: f.fn, env, log: m => logs.push(m) });
    return { f, res, out: await res.json() };
  };
  const puts = f => f.calls.filter(c => c.method === 'PUT' && c.url.includes('/auth/v1/admin/users/'));
  const tgt = f => f.calls.find(c => c.url.includes('line_auth_reconcile_targets'));

  console.log('\n=== reconcile ===');
  let t = await run({ action: 'reconcile' }, { targets: { body: { success: true, total: 2, targets: [AUTH_ID, AUTH_ID2] } } });
  let p = puts(t.f);
  check('逐一停權：PUT admin/users/{id}、ban_duration＝約 100 年、app_metadata 標 line_auth_banned', t.res.status === 200 && t.out.banned === 2 && t.out.failed === 0 && t.out.remaining === 0
    && p.length === 2 && p[0].url.endsWith('/' + AUTH_ID) && p[1].url.endsWith('/' + AUTH_ID2)
    && p.every(c => c.body.ban_duration === '876000h' && c.body.app_metadata.line_auth_banned === true && typeof c.body.app_metadata.line_auth_banned_at === 'string'), JSON.stringify(t.out));
  check('停權只加標記，不覆寫 line_user_id／company_ids', p.every(c => Object.keys(c.body.app_metadata).sort().join(',') === 'line_auth_banned,line_auth_banned_at'));
  check('用 service role 呼叫 admin API 與 targets', p.every(c => c.headers.Authorization === 'Bearer service-key-SECRET') && tgt(t.f).headers.Authorization === 'Bearer service-key-SECRET');
  check('reconcile 不需要 LIFF token、不打 LINE', !t.f.calls.some(c => c.url.includes('api.line.me')));
  check('回應不含 user id', !JSON.stringify(t.out).includes(AUTH_ID) && !JSON.stringify(t.out).includes(AUTH_ID2));
  check('targets 每次最多 50', tgt(t.f).body.p_limit === 50);
  t = await run({ action: 'reconcile' });
  check('沒有對象：200、banned 0、不呼叫 admin API', t.res.status === 200 && t.out.banned === 0 && puts(t.f).length === 0);
  const failSecond = (body, url) => (url.endsWith(AUTH_ID2) ? { status: 500, body: {} } : { body: {} });
  t = await run({ action: 'reconcile' }, { targets: { body: { success: true, total: 3, targets: [AUTH_ID, AUTH_ID2] } }, update: failSecond });
  check('部分失敗：banned 1、failed 1、remaining 2（下一輪再試）', t.out.banned === 1 && t.out.failed === 1 && t.out.remaining === 2, JSON.stringify(t.out));
  t = await run({ action: 'reconcile' }, { targets: { body: { success: true, total: 2, targets: ['not-a-uuid', 42] } } });
  check('目標不是 UUID：不處理', puts(t.f).length === 0 && t.out.banned === 0);
  t = await run({ action: 'reconcile' }, { targets: { status: 404, body: { code: 'PGRST202' } } });
  check('145 未套：503 db_not_migrated', t.res.status === 503 && t.out.code === 'db_not_migrated');
  t = await run({ action: 'reconcile' }, { targets: { status: 500, body: {} } });
  check('targets 失敗：503、不停權', t.res.status === 503 && puts(t.f).length === 0);
  t = await run({ action: 'reconcile' }, { targets: { body: { success: true, total: 1, targets: [AUTH_ID] } } }, { LINE_AUTH_RECONCILE_DISABLED: 'true' });
  check('LINE_AUTH_RECONCILE_DISABLED=true：503、完全不發請求', t.res.status === 503 && t.out.code === 'reconcile_disabled' && t.f.calls.length === 0);
  t = await run({ action: 'reconcile' }, {}, { LINE_AUTH_DISABLED: 'true' });
  check('LINE_AUTH_DISABLED=true：reconcile 也停', t.res.status === 503 && t.out.code === 'disabled' && t.f.calls.length === 0);

  console.log('\n=== 登入時：已不在職但有 Auth 帳號 ===');
  const notLinked = { resolve: { body: { success: true, known: false, company_ids: [], auth_user_id: AUTH_ID, auth_email: EMAIL } } };
  const LIFF = { liff_access_token: 'liff-at-SECRET' };
  const noLink = f => !f.calls.some(c => c.url.includes('generate_link'));
  t = await run(LIFF, notLinked);
  p = puts(t.f);
  check('403 not_linked＋停權該帳號（ban＋標記）、不換 session', t.res.status === 403 && t.out.code === 'not_linked' && p.length === 1 && p[0].url.endsWith('/' + AUTH_ID)
    && p[0].body.ban_duration === '876000h' && p[0].body.app_metadata.line_auth_banned === true && noLink(t.f));
  t = await run(LIFF, { ...notLinked, getUser: { body: { id: AUTH_ID, banned_until: future(), app_metadata: { line_user_id: LINE_USER } } } });
  check('已停權（可能是人工停權）：不再 PUT（保留人工停權、不加本機制標記）', t.res.status === 403 && puts(t.f).length === 0);
  t = await run(LIFF, { ...notLinked, update: { status: 500, body: {} } });
  check('停權失敗：仍回 403 not_linked（不因此放行）', t.res.status === 403 && t.out.code === 'not_linked');
  t = await run(LIFF, { resolve: { body: { success: true, known: false, company_ids: [], auth_user_id: null } } });
  check('沒有 Auth 帳號的陌生人：403、不碰 Auth', t.res.status === 403 && !t.f.calls.some(c => c.url.includes('/auth/v1/')));

  console.log('\n=== 登入時：在職但帳號被停權 ===');
  const bannedByUs = { body: { id: AUTH_ID, banned_until: future(), app_metadata: { line_user_id: LINE_USER, company_ids: [COMPANY], line_auth_banned: true } } };
  t = await run(LIFF, { getUser: bannedByUs });
  p = puts(t.f);
  check('本機制停權（回任）：解除停權（ban_duration=none、清標記、帶回 line_user_id／company_ids）再發 session', t.res.status === 200 && t.out.mode === 'session'
    && p.length === 1 && p[0].body.ban_duration === 'none' && p[0].body.app_metadata.line_auth_banned === null && p[0].body.app_metadata.line_auth_banned_at === null
    && p[0].body.app_metadata.line_user_id === LINE_USER && p[0].body.app_metadata.company_ids[0] === COMPANY, JSON.stringify(p.map(c => c.body)));
  check('解除在 generate_link 之前', t.f.calls.findIndex(c => c.method === 'PUT') < t.f.calls.findIndex(c => c.url.includes('generate_link')));
  t = await run(LIFF, { getUser: { body: { id: AUTH_ID, banned_until: future(), app_metadata: { line_user_id: LINE_USER, company_ids: [COMPANY] } } } });
  check('人工停權（沒有標記）：403 account_disabled、不解除、不換 session', t.res.status === 403 && t.out.code === 'account_disabled' && puts(t.f).length === 0 && noLink(t.f));
  t = await run(LIFF, { getUser: bannedByUs, update: { status: 500, body: {} } });
  check('解除失敗：503、不換 session', t.res.status === 503 && noLink(t.f));
  t = await run(LIFF, { getUser: { body: { id: AUTH_ID, banned_until: past(), app_metadata: { line_user_id: LINE_USER, company_ids: [COMPANY] } } } });
  check('停權已到期：照常發 session、不 PUT', t.res.status === 200 && t.out.mode === 'session' && puts(t.f).length === 0);
  t = await run(LIFF);
  check('一般在職者：照常發 session、不 PUT（既有行為不變）', t.res.status === 200 && t.out.mode === 'session' && puts(t.f).length === 0);

  check('log 不含 token／金鑰／user id', logs.length > 0 && !logs.some(l => /SECRET/.test(l) || l.includes(AUTH_ID)), logs.join(' | '));

  console.log('\n結果：' + pass + ' 通過、' + fail + ' 失敗');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('  ❌ 中途失敗：' + e.message); console.log('\n結果：' + pass + ' 通過、' + (fail + 1) + ' 失敗'); process.exit(1); });
