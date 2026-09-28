// ============================================================
// P1 Phase 1：用「真的」@supabase/supabase-js（package.json 的版本）驗證前端做法可行且不影響現有查詢
//
//   1. 獨立 storageKey 的 client 用 setSession 接 line-auth 回傳的 token（不需要 JWT secret）
//   2. 之後該 client 的 PostgREST 呼叫帶「使用者 access token」；現有資料 client（預設 storageKey）仍只帶 anon key
//   3. 兩個 client 的 session 互不外洩
// fetch 是假的（攔 /auth/v1/user 與 /rest/v1/rpc），不連線。
// ============================================================
const { createClient } = require('@supabase/supabase-js');

let pass = 0, fail = 0;
function check(name, condition, detail = '') {
  if (condition) { pass++; console.log(`  ✅ ${name}${detail ? `  → ${detail}` : ''}`); }
  else { fail++; console.log(`  ❌ ${name}${detail ? `  → ${detail}` : ''}`); }
}

const URL_ = 'https://proj.supabase.test';
const ANON = 'anon-key-jwt';
const LINE = 'U' + 'ab12'.repeat(8);
const b64 = o => Buffer.from(JSON.stringify(o)).toString('base64url');
// 假 access token：結構是 JWT（supabase-js 只解碼 exp／sub，不驗簽；驗簽是 PostgREST／GoTrue 的事）
const now = Math.floor(Date.now() / 1000);
const ACCESS = `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({ sub: 'auth-1', role: 'authenticated', exp: now + 3600, app_metadata: { line_user_id: LINE } })}.sig`;

function memStorage() {
  const m = new Map();
  return { m, getItem: k => (m.has(k) ? m.get(k) : null), setItem: (k, v) => { m.set(k, v); }, removeItem: k => { m.delete(k); } };
}

(async () => {
  console.log('\n═══════════════════════════════════════');
  console.log('  line-auth × 真 supabase-js（Phase 1 前端做法）');
  console.log('═══════════════════════════════════════');

  const calls = [];
  const fakeFetch = async (input, init = {}) => {
    const url = typeof input === 'string' ? input : input.url;
    const headers = new Headers(init.headers || (typeof input !== 'string' ? input.headers : undefined));
    calls.push({ url, auth: headers.get('authorization'), apikey: headers.get('apikey') });
    if (url.includes('/auth/v1/user')) {
      return new Response(JSON.stringify({ id: 'auth-1', aud: 'authenticated', role: 'authenticated', app_metadata: { line_user_id: LINE } }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    if (url.includes('/rest/v1/rpc/')) return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    return new Response('{}', { status: 404 });
  };
  const storage = memStorage();   // 兩個 client 共用同一個 localStorage（瀏覽器實況）
  const sb = createClient(URL_, ANON, { global: { fetch: fakeFetch }, auth: { storage, autoRefreshToken: false } });
  const lineAuth = createClient(URL_, ANON, {
    global: { fetch: fakeFetch },
    auth: { storage, storageKey: 'hr-line-auth-v1', persistSession: true, autoRefreshToken: false, detectSessionInUrl: false },
  });

  const { data, error } = await lineAuth.auth.setSession({ access_token: ACCESS, refresh_token: 'refresh-1' });
  check('setSession 接 line-auth 的 token 成功（不需要 JWT secret）', !error && data?.user?.app_metadata?.line_user_id === LINE, error?.message);
  check('session 存在獨立的 storageKey', storage.getItem('hr-line-auth-v1') !== null);
  check('現有資料 client 的 storageKey 沒有 session', [...storage.m.keys()].filter(k => k !== 'hr-line-auth-v1' && /auth-token$/.test(k)).length === 0, [...storage.m.keys()].join(','));
  const sbSession = (await sb.auth.getSession()).data.session;
  check('現有資料 client getSession() = null（仍是 anon）', sbSession === null);

  calls.length = 0;
  await sb.rpc('get_something', {});
  check('現有資料 client 的 RPC 仍只帶 anon key（行為不變）', calls.length === 1 && calls[0].auth === `Bearer ${ANON}`, calls[0]?.auth);
  calls.length = 0;
  await lineAuth.rpc('line_auth_whoami');
  check('LINE session client 的 RPC 帶使用者 access token（Phase 2 可用）', calls.length === 1 && calls[0].auth === `Bearer ${ACCESS}`);

  await lineAuth.auth.signOut({ scope: 'local' });
  check("signOut({ scope: 'local' }) 清掉本機 session、不動資料 client", storage.getItem('hr-line-auth-v1') === null && (await sb.auth.getSession()).data.session === null);

  console.log(`\n結果：${pass} 通過、${fail} 失敗`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('  ❌ 中途失敗：' + e.message); console.log(`\n結果：${pass} 通過、${fail + 1} 失敗`); process.exit(1); });
