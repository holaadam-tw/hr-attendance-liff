// ============================================================
// P1 Phase 2 前端：帶 p_line_user_id 的 RPC 在有 LINE session 時改用 session client 呼叫（jsdom 實跑 common.js 原文）
//
//   - 名單與 scripts/line-auth/wrapped_rpcs.json 逐一相同
//   - session 未建立／建立失敗／換帳號／登出／關閉開關 → 照舊用 anon 的 sb
//   - 只影響名單內的 RPC；from() 查詢與其他 RPC 不動
//   - 另用「真的」supabase-js 驗證：切換後請求帶使用者 access token，名單外仍只帶 anon key
// 反向對照：COMMON_JS_FILE 指向舊版 common.js（PR #7）→ 失敗
// ============================================================
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');
const { createClient } = require('@supabase/supabase-js');

const commonSrc = fs.readFileSync(process.env.COMMON_JS_FILE || path.join(__dirname, '..', 'common.js'), 'utf8').replace(/\r\n/g, '\n');
const wrapped = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'scripts', 'line-auth', 'wrapped_rpcs.json'), 'utf8'));

let pass = 0, fail = 0;
function check(name, condition, detail = '') {
  if (condition) { pass++; console.log(`  ✅ ${name}${detail ? `  → ${detail}` : ''}`); }
  else { fail++; console.log(`  ❌ ${name}${detail ? `  → ${detail}` : ''}`); }
}
function braceBlock(source, start) {
  if (start < 0) return '';
  let depth = 0, opened = false;
  for (let i = start; i < source.length; i++) {
    if (source[i] === '{') { depth++; opened = true; }
    if (source[i] === '}' && opened && --depth === 0) return source.slice(start, i + 1);
  }
  return '';
}
const CONFIG_SRC = braceBlock(commonSrc, commonSrc.indexOf('const CONFIG = {'));
const p2a = commonSrc.indexOf('// ===== P1 身分根治 Phase 2');
const p2b = commonSrc.indexOf('// 全域變數');
const P2 = p2a > 0 && p2b > p2a ? commonSrc.slice(p2a, p2b) : '';
const p1a = commonSrc.indexOf('// ===== P1 身分根治 Phase 1');
const p1b = commonSrc.indexOf('// ===== 核心工具函數 =====');
const P1 = p1a > 0 && p1b > p1a ? commonSrc.slice(p1a, p1b) : '';
const TOKEN_FN = braceBlock(commonSrc, commonSrc.indexOf('function getLiffAccessTokenSafe('));

const LINE = 'U' + 'ab12'.repeat(8);
const OTHER = 'U' + 'f'.repeat(32);
const userOf = (line, id = 'auth-1') => ({ id, app_metadata: { line_user_id: line } });
const okSession = { ok: true, mode: 'session', created: true, session: { access_token: 'at', refresh_token: 'rt' }, user: { id: 'auth-1', line_user_id: LINE } };

function page({ session = null, reply = okSession, setUser, mode, rpcMode, storage = {}, serverKnows = true } = {}) {
  const dom = new JSDOM('<!doctype html><body></body>', { url: 'https://example.test/index.html', runScripts: 'outside-only' });
  const w = dom.window;
  for (const [k, v] of Object.entries(storage)) w.localStorage.setItem(k, v);
  const log = { anonRpc: [], sessionRpc: [], anonFrom: [], created: 0 };
  const exp = () => Math.floor(Date.now() / 1000) + 3600;
  let current = session && !('expires_at' in session) ? { ...session, expires_at: exp() } : session;
  let authListener = null;
  const builder = (who, fn) => ({ who, fn, then: (res) => Promise.resolve({ data: who, error: null }).then(res) });
  const anonClient = {
    rpc: (fn, args, opts) => { log.anonRpc.push({ fn, args, opts }); return builder('anon', fn); },
    from: (t) => { log.anonFrom.push(t); return { select: () => ({}) }; },
  };
  const sessionClient = {
    auth: {
      getSession: async () => ({ data: { session: current }, error: null }),
      getUser: async () => (serverKnows && current ? { data: { user: current.user }, error: null } : { data: { user: null }, error: { status: 401 } }),
      setSession: async () => { const u = setUser === undefined ? userOf(LINE) : setUser; current = { user: u, expires_at: exp() }; return { data: { user: u, session: current }, error: null }; },
      verifyOtp: async () => { const u = userOf(LINE); current = { user: u, expires_at: exp() }; return { data: { user: u, session: current }, error: null }; },
      signOut: async () => { current = null; if (authListener) authListener('SIGNED_OUT'); return { error: null }; },
      onAuthStateChange: (cb) => { authListener = cb; return { data: { subscription: { unsubscribe() {} } } }; },
    },
    rpc: (fn, args, opts) => { if (fn !== 'line_auth_whoami') log.sessionRpc.push({ fn, args, opts }); return builder('session', fn); },
  };
  w.supabase = { createClient: (url, key, opts) => { log.created++; return opts && opts.auth && opts.auth.storageKey === 'hr-line-auth-v1' ? sessionClient : anonClient; } };
  w.liff = { getAccessToken: () => 'liff-at' };
  w.fetch = async () => ({ status: reply.status || 200, json: async () => reply });
  w.console.info = () => {};
  w.eval(`${CONFIG_SRC}
${mode ? `CONFIG.LINE_AUTH_MODE = '${mode}';` : ''}
${rpcMode ? `CONFIG.LINE_AUTH_RPC = '${rpcMode}';` : ''}
const sb = window.supabase.createClient(CONFIG.SUPABASE_URL, CONFIG.SUPABASE_ANON_KEY);
window.sb = sb;
${P2}
var liffProfile = { userId: '${LINE}' };
${TOKEN_FN}
${P1}
window.__establish = establishLineAuthSession;`);
  w.__signOutEvent = () => authListener && authListener('SIGNED_OUT');
  w.__refreshedEvent = (expiresAt) => authListener && authListener('TOKEN_REFRESHED', { expires_at: expiresAt });
  return { w, log, sb: w.sb, anonClient };
}

(async () => {
  console.log('\n═══════════════════════════════════════');
  console.log('  P1 Phase 2 前端：RPC 有 session 時改用 session client（jsdom＋真 supabase-js）');
  console.log('═══════════════════════════════════════');

  check('common.js 有 Phase 2 區塊（在 sb 建立之後、Phase 1 區塊之前）', !!P2 && !!P1 && p2a < p1a);
  if (!P2 || !P1) { console.log(`\n結果：${pass} 通過、${fail} 失敗`); process.exit(1); }
  const listSrc = (P2.match(/new Set\(\[([\s\S]*?)\]\)/) || [])[1] || '';
  const names = [...listSrc.matchAll(/'([a-z0-9_]+)'/g)].map(m => m[1]);
  check(`名單與產生器輸出（wrapped_rpcs.json）逐一相同：${wrapped.rpc_names.length} 個名稱`, JSON.stringify([...names].sort()) === JSON.stringify(wrapped.rpc_names),
    `多出 ${names.filter(n => !wrapped.rpc_names.includes(n))}；缺少 ${wrapped.rpc_names.filter(n => !names.includes(n))}`);
  check('Phase 2 區塊只包 sb.rpc，不動 from() 查詢', !/sb\.from\s*=/.test(P2) && /sb\.rpc = function/.test(P2));
  check('Phase 1 區塊仍不碰資料 client（sb）', !/\bsb\./.test(P1));
  check("CONFIG.LINE_AUTH_RPC 預設 'session'", /LINE_AUTH_RPC: 'session'/.test(CONFIG_SRC));

  const args = { p_line_user_id: LINE, p_year: 2026, p_month: 10 };
  console.log('\n=== session 建立前後 ===');
  {
    const { w, log, sb } = page();
    let r = sb.rpc('get_my_payslip', args);
    check('session 建立前：名單內 RPC 照舊走 anon', log.anonRpc.length === 1 && log.sessionRpc.length === 0 && r.who === 'anon');
    await w.__establish();
    r = sb.rpc('get_my_payslip', args, { count: 'exact' });
    check('session 建立後：名單內 RPC 改走 session client，參數與選項原樣傳入、回傳的就是該 client 的 builder',
      log.sessionRpc.length === 1 && log.sessionRpc[0].fn === 'get_my_payslip' && log.sessionRpc[0].args === args && log.sessionRpc[0].opts.count === 'exact' && r.who === 'session' && log.anonRpc.length === 1);
    const res = await sb.rpc('quick_check_in', { p_line_user_id: LINE, p_latitude: 1, p_longitude: 2 });
    check('await 結果來自 session client（then 鏈照常）', res.data === 'session');
    sb.rpc('kiosk_check_in', { p_kiosk_line_user_id: LINE });
    sb.rpc('line_auth_whoami');
    check('名單外的 RPC（kiosk_check_in 等）仍走 anon', log.anonRpc.filter(x => x.fn === 'kiosk_check_in').length === 1 && log.sessionRpc.every(x => x.fn !== 'kiosk_check_in'));
    sb.from('employees');
    check('from() 查詢仍走 anon', log.anonFrom.length === 1);
    check('統計（開發者主控台可看）：session／anon 次數', w.lineAuthRpcCounts.session === 2 && w.lineAuthRpcCounts.anon === 1, JSON.stringify(w.lineAuthRpcCounts));
    w.__signOutEvent();
    sb.rpc('get_my_payslip', args);
    check('session 被登出（SIGNED_OUT，例如 refresh 失效）：回到 anon', log.sessionRpc.length === 2 && log.anonRpc.filter(x => x.fn === 'get_my_payslip').length === 2);
  }
  {
    const { w, log, sb } = page({ session: { user: userOf(LINE) } });
    const r = await w.__establish();
    sb.rpc('get_weekly_schedules', {});
    check('沿用既有 session（reused）：切到 session client', r.reason === 'reused' && log.sessionRpc.length === 1);
  }

  {
    const past = Math.floor(Date.now() / 1000) - 10;
    const { w, log, sb } = page({ session: { user: userOf(LINE), expires_at: past } });
    const r = await w.__establish();
    sb.rpc('get_weekly_schedules', {});
    check('access token 已過期（例如 refresh 失敗）：照舊 anon，不會送出過期的 JWT', r.reason === 'reused' && log.sessionRpc.length === 0 && log.anonRpc.length === 1);
    w.__refreshedEvent(Math.floor(Date.now() / 1000) + 3600);
    sb.rpc('get_weekly_schedules', {});
    check('之後 refresh 成功（TOKEN_REFRESHED）：恢復走 session client', log.sessionRpc.length === 1);
    w.__refreshedEvent(Math.floor(Date.now() / 1000) + 20);
    sb.rpc('get_weekly_schedules', {});
    check('剩不到 30 秒就到期：先走 anon', log.sessionRpc.length === 1 && log.anonRpc.length === 2);
  }

  console.log('\n=== 不切換的情況 ===');
  const stays = async (name, opts) => {
    const { w, log, sb } = page(opts);
    const r = await w.__establish();
    sb.rpc('get_my_payslip', args);
    check(name, log.sessionRpc.length === 0 && log.anonRpc.length === 1, JSON.stringify(r));
  };
  await stays('line-auth 失敗（not_linked）：照舊 anon', { reply: { ok: false, status: 403, code: 'not_linked' } });
  await stays('拿到的 session 不是這個 LINE 帳號：照舊 anon', { setUser: userOf(OTHER) });
  await stays('本機 session 伺服器已不認、重新換也失敗：照舊 anon', { session: { user: userOf(LINE) }, serverKnows: false, reply: { ok: false, status: 503, code: 'disabled' } });
  await stays("CONFIG.LINE_AUTH_RPC = 'anon'：照舊 anon（session 仍建立）", { rpcMode: 'anon' });
  await stays('單機 localStorage line_auth_rpc=anon：照舊 anon', { storage: { line_auth_rpc: 'anon' } });
  await stays("CONFIG.LINE_AUTH_MODE = 'off'：不建立 session、照舊 anon", { mode: 'off' });
  {
    const { w, log, sb } = page({ session: { user: userOf(OTHER, 'auth-2') } });
    const p = w.__establish();
    sb.rpc('get_my_payslip', args);
    await p;
    check('換了 LINE 帳號、新 session 建立完成前：照舊 anon（不會用舊帳號的 session）', log.anonRpc.length === 1 && log.sessionRpc.length === 0);
  }

  console.log('\n=== 真 supabase-js（實際送出的 Authorization）===');
  {
    const URL_ = 'https://proj.supabase.test';
    const ANON = 'anon-key-jwt';
    const b64 = o => Buffer.from(JSON.stringify(o)).toString('base64url');
    const now = Math.floor(Date.now() / 1000);
    const ACCESS = `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({ sub: 'auth-1', role: 'authenticated', exp: now + 3600, app_metadata: { line_user_id: LINE } })}.sig`;
    const calls = [];
    const fakeFetch = async (input, init = {}) => {
      const url = typeof input === 'string' ? input : input.url;
      const headers = new Headers(init.headers || (typeof input !== 'string' ? input.headers : undefined));
      calls.push({ url, auth: headers.get('authorization'), body: init.body });
      if (url.includes('/auth/v1/user')) return new Response(JSON.stringify({ id: 'auth-1', aud: 'authenticated', role: 'authenticated', app_metadata: { line_user_id: LINE } }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      if (url.includes('/rest/v1/')) return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      return new Response('{}', { status: 404 });
    };
    const mem = new Map();
    const storage = { getItem: k => (mem.has(k) ? mem.get(k) : null), setItem: (k, v) => { mem.set(k, v); }, removeItem: k => { mem.delete(k); } };
    const realCreate = (url, key, opts = {}) => createClient(URL_, ANON, { ...opts, global: { fetch: fakeFetch }, auth: { ...(opts.auth || {}), storage, autoRefreshToken: false } });
    const env = {
      window: { supabase: { createClient: realCreate } }, localStorage: { getItem: () => null },
      console: { info() {} },
    };
    const f = new Function('window', 'localStorage', 'console', `${CONFIG_SRC}
const sb = window.supabase.createClient(CONFIG.SUPABASE_URL, CONFIG.SUPABASE_ANON_KEY);
window.sb = sb;
${P2}
var liffProfile = null;
function getLiffAccessTokenSafe() { return null; }
${P1}
return { sb, client: getLineAuthClient, setReady: (v, e) => { _lineAuthRpcReady = v; _lineAuthExpiresAt = e; } };`);
    const h = f(env.window, env.localStorage, env.console);
    await h.sb.rpc('get_my_payslip', args);
    check('真 supabase-js：session 前，名單內 RPC 只帶 anon key', calls.at(-1).auth === `Bearer ${ANON}` && /\/rpc\/get_my_payslip$/.test(calls.at(-1).url));
    const { error } = await h.client().auth.setSession({ access_token: ACCESS, refresh_token: 'refresh-1' });
    h.setReady(true, now + 3600);
    await h.sb.rpc('get_my_payslip', args);
    check('真 supabase-js：session 後，名單內 RPC 帶使用者 access token、參數不變', !error && calls.at(-1).auth === `Bearer ${ACCESS}` && JSON.parse(calls.at(-1).body).p_line_user_id === LINE, error?.message);
    await h.sb.rpc('kiosk_check_in', {});
    check('真 supabase-js：名單外 RPC 仍只帶 anon key', calls.at(-1).auth === `Bearer ${ANON}`);
    await h.sb.from('employees').select('id');
    check('真 supabase-js：from() 查詢仍只帶 anon key', calls.at(-1).auth === `Bearer ${ANON}` && /\/rest\/v1\/employees/.test(calls.at(-1).url));
    await h.client().auth.signOut({ scope: 'local' });
    await h.sb.rpc('get_my_payslip', args);
    check('真 supabase-js：登出後回到 anon key', calls.at(-1).auth === `Bearer ${ANON}`);
  }

  console.log(`\n結果：${pass} 通過、${fail} 失敗`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('  ❌ 中途失敗：' + (e.stack || e.message)); console.log(`\n結果：${pass} 通過、${fail + 1} 失敗`); process.exit(1); });
