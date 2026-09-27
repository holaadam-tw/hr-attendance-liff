// ============================================================
// P1 Phase 1 前端：LIFF 登入後在背景建立 Supabase Auth session（jsdom 實跑 common.js 原文）
//
//   - session 放在獨立的 supabase client（storageKey 不同），現有資料查詢用的 sb 不受影響（仍是 anon）
//   - 沿用／換帳號／失敗退避／token_hash 備援／關閉開關／永不 throw
// 反向對照：COMMON_JS_FILE 指向舊版 common.js → 失敗
// ============================================================
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const commonSrc = fs.readFileSync(process.env.COMMON_JS_FILE || path.join(__dirname, '..', 'common.js'), 'utf8');

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
const a = commonSrc.indexOf('// ===== P1 身分根治 Phase 1');
const b = commonSrc.indexOf('// ===== 核心工具函數 =====');
const BLOCK = a > 0 && b > a ? commonSrc.slice(a, b) : '';
const CONFIG_SRC = braceBlock(commonSrc, commonSrc.indexOf('const CONFIG = {'));
const TOKEN_FN = braceBlock(commonSrc, commonSrc.indexOf('function getLiffAccessTokenSafe('));

const LINE = 'U' + 'ab12'.repeat(8);
const OTHER = 'U' + 'f'.repeat(32);
const userOf = (line, id = 'auth-1') => ({ id, app_metadata: { line_user_id: line } });

function page({ session = null, reply, setUser, verifyUser, mode, liffToken = 'liff-at', storage = {}, fetchThrows = false } = {}) {
  const dom = new JSDOM('<!doctype html><body></body>', { url: 'https://example.test/index.html', runScripts: 'outside-only' });
  const w = dom.window;
  for (const [k, v] of Object.entries(storage)) w.localStorage.setItem(k, v);
  const log = { created: [], fetch: [], setSession: [], signOut: [], verifyOtp: [], rpc: [], sbTouched: 0 };
  let current = session;
  const authClient = {
    auth: {
      getSession: async () => ({ data: { session: current }, error: null }),
      setSession: async (s) => { log.setSession.push(s); const u = setUser === undefined ? userOf(LINE) : setUser; current = { user: u }; return { data: { user: u, session: current }, error: null }; },
      verifyOtp: async (p) => { log.verifyOtp.push(p); const u = verifyUser === undefined ? userOf(LINE) : verifyUser; current = { user: u }; return { data: { user: u, session: current }, error: null }; },
      signOut: async (o) => { log.signOut.push(o); current = null; return { error: null }; },
      onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }),
    },
    rpc: async (name) => { log.rpc.push(name); return { data: { line_user_id: LINE } }; },
  };
  w.supabase = { createClient: (url, key, opts) => { log.created.push({ url, key, opts }); return authClient; } };
  w.liff = { getAccessToken: () => liffToken };
  w.fetch = async (url, init) => {
    log.fetch.push({ url, body: JSON.parse(init.body), headers: init.headers });
    if (fetchThrows) throw new Error('network down');
    const r = typeof reply === 'function' ? reply() : reply;
    return { status: r.status || 200, json: async () => r };
  };
  w.console.info = () => {};
  w.eval(`${CONFIG_SRC}\n${mode ? `CONFIG.LINE_AUTH_MODE = '${mode}';` : ''}\nvar liffProfile = { userId: '${LINE}' };\n${TOKEN_FN}\n${BLOCK}\nwindow.__establish = establishLineAuthSession;`);
  return { w, log };
}
const okSession = { ok: true, mode: 'session', created: true, session: { access_token: 'at', refresh_token: 'rt' }, user: { id: 'auth-1', line_user_id: LINE } };

(async () => {
  console.log('\n═══════════════════════════════════════');
  console.log('  LINE 驗證 Supabase session（Phase 1 前端，jsdom 實跑）');
  console.log('═══════════════════════════════════════');

  check('common.js 有 Phase 1 區塊', !!BLOCK);
  check('initializeLiff 取得 profile 後背景啟動（不 await，不拖慢頁面）',
    /liffProfile = await liff\.getProfile\(\);[\s\S]{0,400}startLineAuthSession\(\);/.test(commonSrc) && !/await startLineAuthSession/.test(commonSrc));
  check('Phase 1 區塊完全不碰現有資料 client（sb）', !!BLOCK && !/\bsb\./.test(BLOCK) && !/window\.sb/.test(BLOCK));
  check('CONFIG.LINE_AUTH_MODE 預設 shadow', /LINE_AUTH_MODE: 'shadow'/.test(CONFIG_SRC));
  if (!BLOCK) { console.log(`\n結果：${pass} 通過、${fail} 失敗`); process.exit(1); }

  console.log('\n=== 第一次登入 ===');
  {
    const { w, log } = page({ reply: okSession });
    const r = await w.__establish();
    check('呼叫 line-auth、只帶 LIFF access token（不帶 line_user_id）', log.fetch.length === 1 && /\/functions\/v1\/line-auth$/.test(log.fetch[0].url)
      && log.fetch[0].body.liff_access_token === 'liff-at' && Object.keys(log.fetch[0].body).length === 1);
    check('setSession 用回傳的 access／refresh token', log.setSession.length === 1 && log.setSession[0].access_token === 'at' && log.setSession[0].refresh_token === 'rt');
    check('獨立 client：storageKey=hr-line-auth-v1、自動 refresh、不讀網址', log.created.length === 1 && log.created[0].opts.auth.storageKey === 'hr-line-auth-v1'
      && log.created[0].opts.auth.autoRefreshToken === true && log.created[0].opts.auth.persistSession === true && log.created[0].opts.auth.detectSessionInUrl === false);
    check('結果 established、狀態可觀察', r.ok && r.reason === 'established' && ['established', 'verified_in_db'].includes(w.lineAuthStatus.state));
    await new Promise(res => setTimeout(res, 0));
    check('記錄用：呼叫 line_auth_whoami 確認 DB 讀得到 line_user_id', log.rpc[0] === 'line_auth_whoami' && w.lineAuthStatus.state === 'verified_in_db');
  }

  console.log('\n=== 沿用／換帳號 ===');
  {
    const { w, log } = page({ session: { user: userOf(LINE) }, reply: okSession });
    const r = await w.__establish();
    check('已有同一個 LINE 帳號的 session：沿用、不打 line-auth（refresh 交給 supabase-js）', r.reason === 'reused' && log.fetch.length === 0 && log.signOut.length === 0);
  }
  {
    const { w, log } = page({ session: { user: userOf(OTHER, 'auth-2') }, reply: okSession });
    const r = await w.__establish();
    check('本機是別的 LINE 帳號的 session：先本機登出（scope=local）再換新的', r.ok && log.signOut.length === 1 && log.signOut[0].scope === 'local' && log.fetch.length === 1 && log.setSession.length === 1);
  }
  {
    const { w, log } = page({ reply: okSession, setUser: userOf(OTHER) });
    const r = await w.__establish();
    check('拿到的 session 不是這個 LINE 帳號：不留（登出）、回報 mismatch', !r.ok && r.reason === 'mismatch' && log.signOut.length === 1);
  }

  console.log('\n=== /verify 被限流：token_hash 備援 ===');
  {
    const { w, log } = page({ reply: { ok: true, mode: 'token_hash', token_hash: 'th', verify_type: 'magiclink', user: { id: 'auth-1' } } });
    const r = await w.__establish();
    check('mode=token_hash：前端自己 verifyOtp（token_hash＋magiclink），不呼叫 setSession', r.ok && log.verifyOtp.length === 1
      && log.verifyOtp[0].token_hash === 'th' && log.verifyOtp[0].type === 'magiclink' && log.setSession.length === 0);
  }

  console.log('\n=== 失敗都不影響頁面 ===');
  {
    const { w, log } = page({ reply: { ok: false, status: 403, code: 'not_linked' } });
    const r = await w.__establish();
    check('not_linked（還沒綁定）：不 throw、回報原因', !r.ok && r.reason === 'not_linked' && log.setSession.length === 0);
    const until = Number(w.sessionStorage.getItem('line_auth_backoff_until'));
    check('not_linked 退避約 1 小時', until > Date.now() + 55 * 60 * 1000);
    const r2 = await w.__establish();
    check('退避期間不再打 line-auth', r2.reason === 'backoff' && log.fetch.length === 1);
  }
  {
    const { w } = page({ reply: { ok: false, status: 404 } });
    const r = await w.__establish();
    check('line-auth 還沒部署（404）：不 throw、退避 10 分鐘', !r.ok && r.reason === 'http_404'
      && Number(w.sessionStorage.getItem('line_auth_backoff_until')) <= Date.now() + 10 * 60 * 1000 + 1000);
  }
  {
    const { w } = page({ fetchThrows: true });
    let threw = false, r;
    try { r = await w.__establish(); } catch (e) { threw = true; }
    check('網路錯誤：不 throw', !threw && r.reason === 'exception');
  }
  {
    const { w, log } = page({ reply: okSession, liffToken: null });
    const r = await w.__establish();
    check('拿不到 LIFF token：不打 line-auth', r.reason === 'no_liff_token' && log.fetch.length === 0);
  }

  console.log('\n=== 開關與去重 ===');
  {
    const { w, log } = page({ reply: okSession, mode: 'off' });
    const r = await w.__establish();
    check("CONFIG.LINE_AUTH_MODE='off'：完全不做（不建 client、不打 API）", r.reason === 'disabled' && log.fetch.length === 0 && log.created.length === 0);
  }
  {
    const { w, log } = page({ reply: okSession, storage: { line_auth_mode: 'off' } });
    const r = await w.__establish();
    check('單機 localStorage line_auth_mode=off：關閉', r.reason === 'disabled' && log.fetch.length === 0);
  }
  {
    const { w, log } = page({ reply: okSession });
    const p1 = w.startLineAuthSession(); const p2 = w.startLineAuthSession();
    await p1; await p2;
    check('同一頁呼叫兩次只跑一次', p1 === p2 && log.fetch.length === 1);
    const s = await w.getLineAuthSession();
    check('getLineAuthSession() 取得目前 session（Phase 2 用）', s && s.user.app_metadata.line_user_id === LINE);
  }

  console.log(`\n結果：${pass} 通過、${fail} 失敗`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('  ❌ 中途失敗：' + e.message); console.log(`\n結果：${pass} 通過、${fail + 1} 失敗`); process.exit(1); });
