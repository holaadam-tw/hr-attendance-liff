// ============================================================
// 142／143 前端：公務機（kiosk.html）改走 line-push 驗證動作，不再自報公務機 LINE ID
//
// 不連線。靜態掃描全部頁面＋用 kiosk.html 原文取出函式、注入假的 liff／fetch 實跑。
// 反向對照：FRONTEND_ROOT 指向舊版 checkout（例如 origin/main）→ 應失敗。
// ============================================================
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = process.env.FRONTEND_ROOT || path.join(__dirname, '..');
const read = f => fs.readFileSync(path.join(root, f), 'utf8');

let pass = 0, fail = 0;
function check(name, condition, detail = '') {
  if (condition) { pass++; console.log(`  ✅ ${name}${detail ? `  → ${detail}` : ''}`); }
  else { fail++; console.log(`  ❌ ${name}${detail ? `  → ${detail}` : ''}`); }
}
function grab(source, name) {
  const start = source.search(new RegExp('(async\\s+)?function ' + name + '\\('));
  if (start < 0) return '';
  let depth = 0, opened = false;
  for (let i = start; i < source.length; i++) {
    if (source[i] === '{') { depth++; opened = true; }
    if (source[i] === '}' && --depth === 0 && opened) return source.slice(start, i + 1);
  }
  return '';
}
function listFiles(dir, out = []) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    if (['node_modules', 'tests', '.git', 'docs', 'openspec', 'migrations', 'supabase', 'scripts', 'reports', '.claude', '.agents', '.codex'].includes(ent.name)) continue;
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) listFiles(p, out);
    else if (/\.(html|js)$/.test(ent.name)) out.push(p);
  }
  return out;
}
const files = listFiles(root).map(p => ({ rel: path.relative(root, p).replace(/\\/g, '/'), src: fs.readFileSync(p, 'utf8') }));

console.log('\n═══════════════════════════════════════');
console.log('  公務機前端改走 LIFF 驗證（142／143）');
console.log('═══════════════════════════════════════');

console.log('\n=== 靜態掃描：全部頁面 ===');
const rpcHits = [];
for (const f of files) {
  const re = /\.rpc\(\s*['"`](kiosk_[a-z_]+)['"`]/g;
  let m;
  while ((m = re.exec(f.src))) rpcHits.push(`${f.rel}:${f.src.slice(0, m.index).split('\n').length}(${m[1]})`);
}
check('沒有頁面直接呼叫 kiosk_* RPC（143 撤權的前提）', rpcHits.length === 0, rpcHits.join(', '));
const idHits = files.filter(f => /p_kiosk_line_user_id/.test(f.src)).map(f => f.rel);
check('前端不再送 p_kiosk_line_user_id', idHits.length === 0, idHits.join(', '));

const page = read('kiosk.html');
const fnNames = ['kioskHandleSessionExpired', 'callVerifiedAction', 'lookupEmployee', 'doCheckin', 'formatKioskError'];
const src = fnNames.map(n => grab(page, n));
check('kiosk.html 找得到 callVerifiedAction／lookupEmployee／doCheckin', src.every(Boolean), fnNames.filter((n, i) => !src[i]).join(','));
check('三個公務機動作都走 callVerifiedAction', ['kiosk_get_company', 'kiosk_lookup', 'kiosk_check_in'].every(a => page.includes(`callVerifiedAction('${a}'`)));
check('打 line-push（不是 PostgREST rpc）', /\/functions\/v1\/line-push/.test(grab(page, 'callVerifiedAction')));

function makeEnv({ token = 'liff-at', reply, inClient = true } = {}) {
  const fetches = [], errors = [], reloads = [], logins = [], results = [];
  const store = {};
  const nodes = {};
  const el = id => (nodes[id] = nodes[id] || { id, textContent: '', innerHTML: '', style: {}, classList: { add() {}, remove() {}, contains: () => false } });
  const ctx = {
    console, JSON, Math, Date, Number, String, Object, Promise, Array,
    SUPABASE_URL: 'https://proj.supabase.co', SUPABASE_KEY: 'anon-key', KIOSK_RELOGIN_MARKER: 'kiosk_liff_relogin_at',
    liff: { getAccessToken: () => token, isInClient: () => inClient, login: (o) => logins.push(o) },
    sessionStorage: { getItem: k => store[k] ?? null, setItem: (k, v) => { store[k] = String(v); }, removeItem: k => { delete store[k]; } },
    window: { location: { href: 'https://x/kiosk.html', reload: () => reloads.push(1) } },
    fetch: async (url, init) => {
      const body = JSON.parse(init.body);
      fetches.push({ url, body, headers: init.headers });
      const r = reply ? reply(body) : { status: 200, body: { ok: true, status: 200, result: { success: true } } };
      return { status: r.status, json: async () => r.body };
    },
    document: { getElementById: el, querySelector: () => null },
    navigator: {},
    inputStr: '', currentEmployee: null, photoBlob: null, isPunching: false,
    tk: k => k, showError: m => errors.push(m), showEmployeeStep: () => {}, setKioskLanguage: () => {},
    setActionButtonsBusy: () => {}, getOptionalKioskPosition: async () => ({ coords: { latitude: 24.08, longitude: 120.54 } }),
    showResult: async d => results.push(d), stopCamera: () => {},
    sb: { rpc: () => { throw new Error('不應再直接呼叫 sb.rpc'); }, storage: { from: () => ({ upload: async () => ({ error: null }), getPublicUrl: () => ({ data: { publicUrl: 'https://proj.supabase.co/storage/v1/object/public/selfies/a.jpg' } }) }) } },
  };
  ctx.window.sessionStorage = ctx.sessionStorage;
  vm.createContext(ctx);
  vm.runInContext(src.join('\n'), ctx);
  return { ctx, fetches, errors, reloads, logins, results, store };
}

(async () => {
  console.log('\n=== callVerifiedAction ===');
  let t = makeEnv({ reply: () => ({ status: 200, body: { ok: true, status: 200, result: { success: true, name: '大正科技' } } }) });
  let r = await t.ctx.callVerifiedAction('kiosk_get_company', {});
  check('帶 LIFF access token、anon key 打 line-push', t.fetches.length === 1 && t.fetches[0].url === 'https://proj.supabase.co/functions/v1/line-push'
    && t.fetches[0].body.liff_access_token === 'liff-at' && t.fetches[0].body.action === 'kiosk_get_company' && t.fetches[0].headers.Authorization === 'Bearer anon-key');
  check('成功 → ok、data.result', r.ok === true && r.data.result.name === '大正科技');
  t = makeEnv({ token: null });
  r = await t.ctx.callVerifiedAction('kiosk_lookup', { identifier: 'E03' });
  check('沒有 token → 不打 API、在 LINE 內重新整理一次', t.fetches.length === 0 && r.code === 'relogin_redirect' && t.reloads.length === 1);
  r = await t.ctx.callVerifiedAction('kiosk_lookup', { identifier: 'E03' });
  check('2 分鐘內再過期 → 不再重整（避免無限重整）', r.code === 'unauthenticated' && t.reloads.length === 1);
  t = makeEnv({ inClient: false, reply: () => ({ status: 401, body: { ok: false, status: 401, code: 'unauthenticated', error: 'x' } }) });
  r = await t.ctx.callVerifiedAction('kiosk_check_in', {});
  check('外部瀏覽器 token 過期（401）→ liff.login 重新登入', r.code === 'relogin_redirect' && t.logins.length === 1);
  t = makeEnv({ reply: () => ({ status: 403, body: { ok: false, status: 403, code: 'access_denied', error: '此帳號非公務機' } }) });
  r = await t.ctx.callVerifiedAction('kiosk_get_company', {});
  check('403 → 訊息照傳', r.ok === false && r.code === 'access_denied' && r.message === '此帳號非公務機');

  console.log('\n=== 查員工 ===');
  t = makeEnv({ reply: () => ({ status: 200, body: { ok: true, status: 200, result: { success: true, employee_id: 'e3', name: '員工三' } } }) });
  vm.runInContext(`inputStr = '0911000003'`, t.ctx);
  t.ctx.document.getElementById('confirmBtn');
  await t.ctx.lookupEmployee();
  check('查員工：送 identifier、不送公務機 LINE ID', t.fetches[0]?.body.action === 'kiosk_lookup' && t.fetches[0].body.identifier === '0911000003'
    && !('kiosk_line_user_id' in t.fetches[0].body) && !('p_kiosk_line_user_id' in t.fetches[0].body), JSON.stringify(t.fetches[0]?.body));
  check('查員工成功：設定 currentEmployee', vm.runInContext('currentEmployee && currentEmployee.employee_id', t.ctx) === 'e3');
  t = makeEnv({ reply: () => ({ status: 400, body: { ok: false, status: 400, code: 'not_found', error: '查無此員工。請輸入工號、手機或身分證後4碼' } }) });
  vm.runInContext(`inputStr = '0000'`, t.ctx);
  await t.ctx.lookupEmployee();
  check('查無此人：顯示伺服器訊息', t.errors[0] === '查無此員工。請輸入工號、手機或身分證後4碼', t.errors.join());

  console.log('\n=== 代打卡 ===');
  t = makeEnv({ reply: () => ({ status: 200, body: { ok: true, status: 200, result: { success: true, type: 'check_in', name: '員工三' } } }) });
  vm.runInContext(`currentEmployee = { employee_id: 'e3', employee_number: 'E03' }; photoBlob = {}`, t.ctx);
  await t.ctx.doCheckin('check_in');
  const b = t.fetches[0]?.body || {};
  check('打卡：送 employee_id／kiosk_action／照片／定位', b.action === 'kiosk_check_in' && b.employee_id === 'e3' && b.kiosk_action === 'check_in'
    && b.photo_url === 'https://proj.supabase.co/storage/v1/object/public/selfies/a.jpg' && b.latitude === 24.08 && b.longitude === 120.54, JSON.stringify(b));
  check('打卡：不送公務機 LINE ID', !Object.keys(b).some(k => /kiosk_line_user_id/.test(k)));
  check('打卡成功：顯示結果', t.results[0]?.type === 'check_in' && t.errors.length === 0);
  t = makeEnv({ reply: () => ({ status: 400, body: { ok: false, status: 400, code: 'failed', error: '今日已完成上班打卡' } }) });
  vm.runInContext(`currentEmployee = { employee_id: 'e3', employee_number: 'E03' }`, t.ctx);
  await t.ctx.doCheckin('check_in');
  check('打卡被拒：顯示伺服器訊息', t.errors[0] === '今日已完成上班打卡' && t.results.length === 0, t.errors.join());
  check('打卡結束後解除忙碌狀態', vm.runInContext('isPunching', t.ctx) === false);

  console.log(`\n結果：${pass} 通過、${fail} 失敗`);
  process.exit(fail > 0 ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
