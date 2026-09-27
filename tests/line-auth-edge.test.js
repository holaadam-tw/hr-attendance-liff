// ============================================================
// line-auth Edge Function（P1 Phase 1：LIFF access token → Supabase Auth session）handler.ts 實跑
//
// Node 22.18+ 內建型別剝除，直接 import .ts；fetch 全部是假的（LINE、PostgREST、GoTrue admin／verify），不連線。
// 反向對照：LINE_AUTH_HANDLER 指向不存在或舊版檔案 → 失敗
// ============================================================
const path = require('path');
const { pathToFileURL } = require('url');

let pass = 0, fail = 0;
function check(name, condition, detail = '') {
  if (condition) { pass++; console.log(`  ✅ ${name}${detail ? `  → ${detail}` : ''}`); }
  else { fail++; console.log(`  ❌ ${name}${detail ? `  → ${detail}` : ''}`); }
}

const LINE_USER = 'U' + 'ab12'.repeat(8);
const AUTH_ID = '11111111-aaaa-4bbb-8ccc-000000000001';
const COMPANY = '8a669e2c-7521-43e9-9300-5c004c57e9db';
const SECRETS = ['liff-at-SECRET', 'service-key-SECRET', 'hashed-SECRET', 'access-SECRET', 'refresh-SECRET'];

// routes: [ [method, urlPart, responder], ... ]；responder 可以是函式 (body, url) => { status, body }
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
const env = key => ({ SUPABASE_URL: 'https://db.test', SUPABASE_SERVICE_ROLE_KEY: 'service-key-SECRET', SUPABASE_ANON_KEY: 'anon-key' })[key];
const post = body => new Request('https://fn/line-auth', { method: 'POST', body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } });

const session = (overrides = {}) => ({
  access_token: 'access-SECRET', refresh_token: 'refresh-SECRET', expires_in: 3600, expires_at: 1900000000, token_type: 'bearer',
  user: { id: AUTH_ID, app_metadata: { line_user_id: LINE_USER, company_ids: [COMPANY] } }, ...overrides,
});
function routes(o = {}) {
  return [
    ['GET', '/oauth2/v2.1/verify', o.verify || { body: { client_id: '2008962829', expires_in: 3600 } }],
    ['GET', '/v2/profile', o.profile || { body: { userId: LINE_USER } }],
    ['POST', '/rest/v1/rpc/line_auth_resolve', o.resolve || { body: { success: true, known: true, company_ids: [COMPANY], auth_user_id: AUTH_ID, auth_email: LINE_USER.toLowerCase() + '@line-auth.invalid' } }],
    ['POST', '/auth/v1/admin/users', o.create || { body: { id: AUTH_ID, email: LINE_USER.toLowerCase() + '@line-auth.invalid' } }],
    ['GET', '/auth/v1/admin/users/', o.getUser || { body: { id: AUTH_ID, app_metadata: { line_user_id: LINE_USER, company_ids: [COMPANY] } } }],
    ['PUT', '/auth/v1/admin/users/', o.update || { body: { id: AUTH_ID } }],
    ['POST', '/auth/v1/admin/generate_link', o.link || { body: { id: AUTH_ID, hashed_token: 'hashed-SECRET', verification_type: 'magiclink', action_link: 'https://x' } }],
    ['POST', '/auth/v1/verify', o.verifyOtp || { body: session() }],
  ];
}

(async () => {
  console.log('\n═══════════════════════════════════════');
  console.log('  line-auth Edge Function（handler.ts 實跑）');
  console.log('═══════════════════════════════════════');

  let mod;
  try {
    mod = await import(pathToFileURL(process.env.LINE_AUTH_HANDLER || path.join(__dirname, '..', 'supabase', 'functions', 'line-auth', 'handler.ts')).href);
  } catch (e) {
    if (e && e.code === 'ERR_UNKNOWN_FILE_EXTENSION') {
      console.log(`  ⚠️ 略過：Node ${process.version} 無法直接載入 .ts，請用 Node 22.18 以上執行`);
      process.exit(0);
    }
    check('找得到 line-auth handler', false, e.message);
    console.log(`\n結果：${pass} 通過、${fail} 失敗`);
    process.exit(1);
  }
  const logs = [];
  const run = async (body, o = {}) => {
    const f = fakeFetch(routes(o));
    const res = await mod.handleLineAuth(post(body), { fetch: f.fn, env, log: m => logs.push(m) });
    return { f, res, out: await res.json() };
  };
  const find = (f, m, part) => f.calls.find(c => c.method === m && c.url.includes(part));

  console.log('\n=== 既有帳號 ===');
  let t = await run({ liff_access_token: 'liff-at-SECRET', line_user_id: 'U' + '0'.repeat(32) });
  check('LIFF 驗證通過＋已有帳號：回傳 session（mode=session）', t.res.status === 200 && t.out.ok && t.out.mode === 'session'
    && t.out.session.access_token === 'access-SECRET' && t.out.session.refresh_token === 'refresh-SECRET' && t.out.user.id === AUTH_ID, JSON.stringify(t.out));
  check('身分用 LINE 驗證出的 userId，不採信前端夾帶的 line_user_id', find(t.f, 'POST', 'line_auth_resolve').body.p_line_user_id === LINE_USER && t.out.user.line_user_id === LINE_USER);
  check('已有帳號：不重建、公司沒變就不更新 app_metadata', !t.f.calls.some(c => c.method === 'POST' && /\/auth\/v1\/admin\/users$/.test(c.url)) && !find(t.f, 'PUT', '/auth/v1/admin/users/'));
  const gl = find(t.f, 'POST', 'generate_link');
  check('generate_link：type=magiclink、帳號 email、用 service role', gl && gl.body.type === 'magiclink' && gl.body.email === LINE_USER.toLowerCase() + '@line-auth.invalid'
    && gl.headers.Authorization === 'Bearer service-key-SECRET');
  const vf = find(t.f, 'POST', '/auth/v1/verify');
  check('verify：token_hash＋type=magiclink，只帶 anon apikey（不帶 service role）', vf && vf.body.token_hash === 'hashed-SECRET' && vf.body.type === 'magiclink'
    && vf.headers.apikey === 'anon-key' && !vf.headers.Authorization);
  check('LINE 驗證：client_id 白名單＋profile', !!find(t.f, 'GET', '/oauth2/v2.1/verify') && !!find(t.f, 'GET', '/v2/profile'));

  t = await run({ liff_access_token: 'liff-at-SECRET' }, { getUser: { body: { id: AUTH_ID, app_metadata: { line_user_id: LINE_USER, company_ids: [] } } } });
  const put = find(t.f, 'PUT', '/auth/v1/admin/users/');
  check('公司清單變了：更新 app_metadata（line_user_id＋company_ids）', t.out.ok && put && put.url.endsWith('/auth/v1/admin/users/' + AUTH_ID)
    && put.body.app_metadata.line_user_id === LINE_USER && put.body.app_metadata.company_ids[0] === COMPANY);

  console.log('\n=== 新帳號 ===');
  t = await run({ liff_access_token: 'liff-at-SECRET' }, { resolve: { body: { success: true, known: true, company_ids: [COMPANY], auth_user_id: null, auth_email: null } } });
  const cr = t.f.calls.find(c => c.method === 'POST' && /\/auth\/v1\/admin\/users$/.test(c.url));
  check('沒有帳號：admin 建立（email_confirm、app_metadata.line_user_id＋company_ids，不設密碼）', cr && cr.body.email_confirm === true
    && cr.body.app_metadata.line_user_id === LINE_USER && cr.body.app_metadata.company_ids[0] === COMPANY && !('password' in cr.body)
    && cr.body.email === LINE_USER.toLowerCase() + '@line-auth.invalid', JSON.stringify(cr?.body));
  check('建立後同樣換到 session、created=true', t.out.ok && t.out.created === true && t.out.session.access_token === 'access-SECRET');
  t = await run({ liff_access_token: 'liff-at-SECRET' }, { resolve: { body: { success: true, known: true, company_ids: [], auth_user_id: null } }, create: { status: 422, body: { error_code: 'email_exists' } } });
  check('email 已被別的帳號占用（再查一次仍對不上）：409 identity_conflict、不接管、不換 session', t.res.status === 409 && t.out.code === 'identity_conflict' && !find(t.f, 'POST', 'generate_link')
    && t.f.calls.filter(c => c.url.includes('line_auth_resolve')).length === 2);
  {
    let n = 0;
    t = await run({ liff_access_token: 'liff-at-SECRET' }, {
      resolve: () => (++n === 1 ? { body: { success: true, known: true, company_ids: [COMPANY], auth_user_id: null } }
        : { body: { success: true, known: true, company_ids: [COMPANY], auth_user_id: AUTH_ID, auth_email: LINE_USER.toLowerCase() + '@line-auth.invalid' } }),
      create: { status: 422, body: { error_code: 'email_exists' } },
    });
    check('兩個分頁同時第一次登入（另一個剛建好帳號）：再查一次就沿用，不誤報衝突', t.res.status === 200 && t.out.ok && t.out.user.id === AUTH_ID && t.out.created === false, JSON.stringify(t.out));
  }
  t = await run({ liff_access_token: 'liff-at-SECRET' }, { resolve: { body: { success: true, known: true, company_ids: [], auth_user_id: null } }, create: { status: 422, body: { error_code: 'email_address_invalid' } } });
  check('其他 422（例如 email 網域被限制）：503 create_user_rejected、log 記 error_code，不誤報身分衝突', t.res.status === 503 && t.out.code === 'create_user_rejected'
    && logs.some(l => /email_address_invalid/.test(l)));

  console.log('\n=== 拒絕 ===');
  t = await run({ liff_access_token: 'liff-at-SECRET' }, { resolve: { body: { success: true, known: false, company_ids: [], auth_user_id: null } } });
  check('LINE 帳號不是員工／平台管理員：403 not_linked、不建帳號', t.res.status === 403 && t.out.code === 'not_linked' && !t.f.calls.some(c => c.url.includes('/auth/v1/')));
  t = await run({ liff_access_token: 'liff-at-SECRET' }, { verify: { body: { client_id: '9999999999', expires_in: 3600 } } });
  check('別的 LINE channel 的 token：401、不查 DB', t.res.status === 401 && !t.f.calls.some(c => c.url.includes('db.test')));
  t = await run({ liff_access_token: 'liff-at-SECRET' }, { verify: { body: { client_id: '2008962829', expires_in: 0 } } });
  check('過期 token（expires_in=0）：401', t.res.status === 401);
  t = await run({ liff_access_token: 'liff-at-SECRET' }, { profile: { status: 401, body: {} } });
  check('profile 取不到：401', t.res.status === 401);
  t = await run({});
  check('沒帶 token：400', t.res.status === 400 && t.f.calls.length === 0);
  t = await run({ liff_access_token: 'liff-at-SECRET' }, { resolve: { body: { success: false, error_code: 'duplicate_auth_user' } } });
  check('同一個 LINE userId 對到兩個帳號：409、不換 session', t.res.status === 409 && !find(t.f, 'POST', 'generate_link'));
  t = await run({ liff_access_token: 'liff-at-SECRET' }, { resolve: { status: 404, body: { code: 'PGRST202' } } });
  check('135 未套：503「資料庫尚未更新（135）」', t.res.status === 503 && t.out.code === 'db_not_migrated');
  t = await run({ liff_access_token: 'liff-at-SECRET' }, { link: { body: { id: '99999999-aaaa-4bbb-8ccc-000000000009', hashed_token: 'hashed-SECRET' } } });
  check('generate_link 回來的是別的 user：409、不 verify', t.res.status === 409 && !find(t.f, 'POST', '/auth/v1/verify'));
  t = await run({ liff_access_token: 'liff-at-SECRET' }, { verifyOtp: { body: session({ user: { id: AUTH_ID, app_metadata: { line_user_id: 'U' + 'f'.repeat(32) } } }) } });
  check('verify 回來的 session 不是這個 LINE userId：409、不回 token', t.res.status === 409 && !JSON.stringify(t.out).includes('access-SECRET'));
  t = await run({ liff_access_token: 'liff-at-SECRET' }, { verifyOtp: { status: 403, body: { error_code: 'otp_expired' } } });
  check('verify 失敗：503、不回 token', t.res.status === 503 && !JSON.stringify(t.out).includes('SECRET'));
  t = await run({ liff_access_token: 'liff-at-SECRET' }, { link: { status: 500, body: {} } });
  check('generate_link 失敗：503', t.res.status === 503);

  console.log('\n=== /verify 被頻率限制（Edge Function 共用出口 IP）===');
  t = await run({ liff_access_token: 'liff-at-SECRET' }, { verifyOtp: { status: 429, body: { error_code: 'over_request_rate_limit' } } });
  check('429：改回傳 token_hash 讓前端自己 verifyOtp（mode=token_hash）', t.res.status === 200 && t.out.mode === 'token_hash' && t.out.token_hash === 'hashed-SECRET'
    && t.out.verify_type === 'magiclink' && t.out.user.id === AUTH_ID && !t.out.session);

  console.log('\n=== 其他 ===');
  const opt = await mod.handleLineAuth(new Request('https://fn/line-auth', { method: 'OPTIONS' }), { fetch: async () => { throw new Error('x'); }, env });
  check('OPTIONS：CORS', opt.status === 200 && opt.headers.get('Access-Control-Allow-Origin') === '*');
  const get = await mod.handleLineAuth(new Request('https://fn/line-auth', { method: 'GET' }), { fetch: async () => { throw new Error('x'); }, env });
  check('GET：405', get.status === 405);
  check('log 不含任何 token／金鑰', logs.length > 0 && !logs.some(l => SECRETS.some(s => l.includes(s))), logs.join(' | '));
  check('email 網域可用 LINE_AUTH_EMAIL_DOMAIN 覆寫、userId 轉小寫', mod.syntheticEmail('UABC', 'x.invalid') === 'uabc@x.invalid');

  console.log(`\n結果：${pass} 通過、${fail} 失敗`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('  ❌ 中途失敗：' + e.message); console.log(`\n結果：${pass} 通過、${fail + 1} 失敗`); process.exit(1); });
