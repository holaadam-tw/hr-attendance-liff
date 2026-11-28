#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { spawnSync } = require('child_process');
const { pathToFileURL } = require('url');

const root = path.join(__dirname, '..');
const pagePath = path.join(root, 'attendance_public.html');
const handlerPath = path.join(root, 'supabase', 'functions', 'line-push', 'handler.ts');
let html = fs.readFileSync(pagePath, 'utf8');
const mutation = process.env.PLANB2C_MUTATION || '';
if (mutation === 'direct') {
  html = html.replace("callVerifiedRpc('get_company_daily_attendance'", "sb.rpc('get_company_daily_attendance'");
}
if (mutation === 'no_loop') {
  html = html.replace('if (!force && lastStarted > 0 && now - lastStarted < ATTENDANCE_RELOGIN_COOLDOWN_MS)', 'if (false && lastStarted > 0 && now - lastStarted < ATTENDANCE_RELOGIN_COOLDOWN_MS)');
}

let passed = 0;
let failed = 0;
function check(name, ok, detail = '') {
  if (ok) passed++; else failed++;
  console.log(`  ${ok ? '✅' : '❌'} ${name}${detail ? ` — ${detail}` : ''}`);
}

function inlineScript(source) {
  const match = source.match(/<script>\s*([\s\S]*?)<\/script>\s*<\/body>/);
  if (!match) throw new Error('找不到 attendance_public.html 的主 inline script');
  return match[1].replace(/\ninit\(\);\s*$/, '');
}

function extractFunction(source, name) {
  const start = source.indexOf(`async function ${name}(`);
  if (start < 0) throw new Error(`找不到 ${name}`);
  const brace = source.indexOf(') {', start) + 2;
  if (brace < 2) throw new Error(`${name} 找不到函式主體`);
  let depth = 0;
  for (let i = brace; i < source.length; i++) {
    if (source[i] === '{') depth++;
    if (source[i] === '}' && --depth === 0) return source.slice(start, i + 1);
  }
  throw new Error(`${name} 大括號未閉合`);
}

function parseVerifiedCalls(source) {
  const calls = [];
  const needle = 'callVerifiedRpc(';
  let cursor = 0;
  while ((cursor = source.indexOf(needle, cursor)) >= 0) {
    const open = cursor + needle.length - 1;
    let depth = 0;
    let quote = '';
    let escaped = false;
    let end = -1;
    for (let i = open; i < source.length; i++) {
      const ch = source[i];
      if (quote) {
        if (escaped) escaped = false;
        else if (ch === '\\') escaped = true;
        else if (ch === quote) quote = '';
        continue;
      }
      if (ch === "'" || ch === '"' || ch === '`') { quote = ch; continue; }
      if (ch === '(') depth++;
      if (ch === ')' && --depth === 0) { end = i; break; }
    }
    if (end < 0) throw new Error('callVerifiedRpc 括號未閉合');
    const body = source.slice(open + 1, end);
    const fnMatch = body.match(/^\s*['"]([^'"]+)['"]\s*,/);
    if (fnMatch) {
      const params = [...body.matchAll(/\b(p_\w+)\s*:/g)].map(m => m[1]);
      if (/\bargs\b/.test(body)) {
        const before = source.slice(Math.max(0, cursor - 1200), cursor);
        const defs = [...before.matchAll(/const\s+args\s*=\s*\{([\s\S]*?)\};/g)];
        const latest = defs.at(-1);
        if (latest) params.push(...[...latest[1].matchAll(/\b(p_\w+)\s*:/g)].map(m => m[1]));
      }
      calls.push({ fn: fnMatch[1], params: [...new Set(params)], index: cursor });
    }
    cursor = end + 1;
  }
  return calls;
}

function makeStorage() {
  const data = new Map();
  return {
    getItem: key => data.has(String(key)) ? data.get(String(key)) : null,
    setItem: (key, value) => data.set(String(key), String(value)),
    removeItem: key => data.delete(String(key)),
  };
}

function makeHarness(source) {
  const nodes = {};
  const noticeWrites = [];
  const redirects = [];
  const confirms = [];
  function element(id = '') {
    let text = '';
    let markup = '';
    const el = {
      id,
      style: { display: '', cssText: '' },
      value: '', disabled: false, checked: false, dataset: {}, options: [], className: '',
      classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
      appendChild() {}, addEventListener() {}, querySelector() { return null; }, querySelectorAll() { return []; },
      setAttribute() {}, getAttribute() { return null; }, remove() {},
    };
    Object.defineProperty(el, 'textContent', {
      get: () => text,
      set: value => { text = String(value ?? ''); if (id === 'attendanceLoginMessage') noticeWrites.push(text); },
    });
    Object.defineProperty(el, 'innerHTML', {
      get: () => markup || text,
      set: value => { markup = String(value ?? ''); },
    });
    return el;
  }
  const get = id => (nodes[id] ||= element(id));
  const query = new Proxy({}, {
    get(_target, prop) {
      if (prop === 'then') return resolve => Promise.resolve({ data: [], error: null }).then(resolve);
      return () => query;
    },
  });
  const localStorage = makeStorage();
  const sessionStorage = makeStorage();
  const location = { search: '', pathname: '/attendance_public.html', href: '', replace(url) { redirects.push(String(url)); } };
  const ctx = {
    console,
    JSON, Math, Date, Number, String, Array, Object, Set, Map, Promise, URLSearchParams,
    parseInt, parseFloat, isNaN,
    setTimeout: () => 0, clearTimeout() {}, setInterval: () => 0, clearInterval() {},
    localStorage, sessionStorage, location,
    navigator: { userAgent: 'planb2c-test' },
    fetch: async () => { throw new Error('無 token 讀取不應呼叫 fetch'); },
    confirm: message => { confirms.push(String(message)); return false; },
    alert() {},
  };
  ctx.document = {
    documentElement: { lang: '' }, title: '', body: get('body'),
    getElementById: get, querySelector: () => null, querySelectorAll: () => [],
    createElement: () => element(), addEventListener() {},
  };
  ctx.window = {
    supabase: { createClient: () => ({ rpc: async () => ({ data: [], error: null }), from: () => query }) },
    location, addEventListener() {}, open() {},
  };
  ctx.window.window = ctx.window;
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(inlineScript(source), ctx);
  vm.runInContext(`
    companyId = DACHENG_COMPANY_ID;
    companyName = '測試公司';
    currentLineUserId = 'U00000000000000000000000000000000';
    currentUserRole = 'admin';
    schedWeekStart = new Date('2026-11-23T00:00:00+08:00');
    humanWeekStart = new Date('2026-11-23T00:00:00+08:00');
  `, ctx);
  get('dailyDatePicker').value = '2026-11-28';
  get('filterDept').value = '';
  get('filterStatus').value = '';
  return { ctx, get, noticeWrites, redirects, confirms };
}

const gitOk = args => spawnSync('git', args, { cwd: root }).status === 0;
const diffBase = gitOk(['rev-parse', '--verify', '--quiet', 'origin/main']) ? 'origin/main'
  : (gitOk(['rev-parse', '--verify', '--quiet', 'HEAD^2']) ? 'HEAD^1' : 'HEAD');
function unchangedFromBase(file) {
  return spawnSync('git', ['diff', '--quiet', diffBase, '--', file], { cwd: root }).status === 0;
}

(async () => {
  console.log('\n=== Plan B 第二批 2c attendance_public LINE 驗證 ===');
  const handler = await import(pathToFileURL(handlerPath).href);
  const specs = handler.ADMIN_RPC_SPECS;
  const adminFns = Object.keys(specs);
  check('後續批次擴充後 ADMIN_RPC_SPECS 仍恰為 29 支', adminFns.length === 29, String(adminFns.length));

  const direct = adminFns.filter(fn => new RegExp(`sb\\.rpc\\(\\s*['"]${fn}['"]`).test(html));
  check('ADMIN_RPC_SPECS 名單沒有直接 sb.rpc', direct.length === 0, direct.join(', '));
  const calls = parseVerifiedCalls(html).filter(call => adminFns.includes(call.fn));
  check('13 支函式的 16 個靜態呼叫式全部改走 callVerifiedRpc', calls.length === 16, String(calls.length));
  const expectedCounts = { get_weekly_schedules: 2, create_shift_type: 2, update_shift_type: 2 };
  for (const fn of ['get_makeup_review_requests', 'get_pending_makeup_requests', 'get_attendance_anomalies', 'resolve_attendance_anomaly', 'get_company_daily_attendance', 'get_company_holidays', 'get_company_leave_requests_for_audit', 'get_company_monthly_attendance', 'get_weekly_schedules', 'get_company_shift_types', 'create_shift_type', 'update_shift_type', 'delete_shift_type']) {
    const count = calls.filter(call => call.fn === fn).length;
    check(`${fn} 呼叫數正確`, count === (expectedCounts[fn] || 1), String(count));
  }
  for (const call of calls) {
    const unknown = call.params.filter(name => name !== 'p_line_user_id' && !Object.prototype.hasOwnProperty.call(specs[call.fn].params, name));
    check(`${call.fn} 參數都在 Edge 白名單`, unknown.length === 0, unknown.join(', '));
  }
  check('公開請假 RPC 維持原直接呼叫', /sb\.rpc\('get_public_today_leave_employees'/.test(html));

  const helperContext = { captured: [], console, Set, companyId: 'company-fallback' };
  helperContext.callAttendanceVerifiedAction = async (action, payload, options) => {
    helperContext.captured.push({ action, payload, options });
    return { ok: true, data: { result: [{ id: 1 }] } };
  };
  vm.createContext(helperContext);
  vm.runInContext(`const ATTENDANCE_VERIFIED_WRITE_FNS = new Set(['create_shift_type']);\n${extractFunction(html, 'callVerifiedRpc')}`, helperContext);
  const originalArgs = { p_company_id: 'company-explicit', p_line_user_id: 'Ufake', p_year: 2026 };
  helperContext.__args = originalArgs;
  const helperOk = await vm.runInContext('callVerifiedRpc("get_company_monthly_attendance", __args)', helperContext);
  check('本地 helper 解開 result 並回傳 {data,error}', helperOk.error === null && helperOk.data?.[0]?.id === 1);
  check('本地 helper 不改動原 args', originalArgs.p_line_user_id === 'Ufake');
  check('本地 helper 複製後刪 p_line_user_id', !Object.prototype.hasOwnProperty.call(helperContext.captured[0].payload.args, 'p_line_user_id'));
  check('本地 helper 採 args 的公司', helperContext.captured[0].payload.company_id === 'company-explicit');
  await vm.runInContext('callVerifiedRpc("get_company_shift_types", {})', helperContext);
  check('本地 helper 無 p_company_id 時採頁面公司', helperContext.captured[1].payload.company_id === 'company-fallback');
  helperContext.callAttendanceVerifiedAction = async () => ({ ok: false, code: 'access_denied', message: '拒絕存取' });
  const helperDenied = await vm.runInContext('callVerifiedRpc("get_company_shift_types", {})', helperContext);
  check('本地 helper 轉換非成功錯誤', helperDenied.data === null && helperDenied.error?.code === 'access_denied' && helperDenied.error?.message === '拒絕存取');
  helperContext.callAttendanceVerifiedAction = async () => { throw Object.assign(new Error('網路中斷'), { code: 'network_down' }); };
  const helperThrown = await vm.runInContext('callVerifiedRpc("get_company_shift_types", {})', helperContext);
  check('本地 helper 轉換例外', helperThrown.data === null && helperThrown.error?.code === 'network_down' && helperThrown.error?.message === '網路中斷');

  const h = makeHarness(html);
  const settled = await Promise.allSettled([h.ctx.loadDailyData(), h.ctx.loadMonthlyData(), h.ctx.loadScheduleData(), h.ctx.loadHumanManagement(), h.ctx.loadAnomalyData()]);
  check('無 token 多區塊並行讀取沒有未捕捉例外', settled.every(result => result.status === 'fulfilled'), settled.map(result => result.status).join(', '));
  check('無 token 讀取不跳 confirm', h.confirms.length === 0, String(h.confirms.length));
  check('整次並行載入提示只寫入一次', h.noticeWrites.filter(text => text.includes('LINE')).length === 1, String(h.noticeWrites.length));
  check('頁面上方顯示重新登入提示列', h.get('attendanceLoginNotice').style.display === 'flex' && h.get('attendanceReloginButton').disabled === false);
  for (const id of ['dailyTableBody', 'monthlyTableBody', 'schedBody', 'humanBody', 'anomalyList']) {
    check(`${id} 顯示可讀登入訊息`, h.get(id).innerHTML.includes('需要重新以 LINE 登入'), h.get(id).innerHTML);
  }

  h.ctx.startAttendanceReadRelogin();
  h.ctx.startAttendanceReadRelogin();
  check('重新登入按鈕的冷卻鎖防止重複轉址', h.redirects.length === 1, String(h.redirects.length));
  const saveHarness = makeHarness(html);
  const saveResult = await saveHarness.ctx.callVerifiedRpc('create_shift_type', { p_company_id: 'x', p_name: '早班' });
  check('存檔路徑無 token 維持 confirm', saveHarness.confirms.length === 1 && saveResult.error?.code === 'unauthenticated', String(saveHarness.confirms.length));

  for (const file of [
    'common.js', 'checkin.html', 'index.html', 'kiosk.html', 'records.html', 'attendance_overview.html',
    'modules/attendance-read-columns.js', 'modules/audit.js', 'modules/auth.js',
    'modules/employee-read-columns.js', 'modules/employees.js', 'modules/index.js',
    'modules/leave.js', 'modules/payroll.js', 'modules/schedules.js', 'modules/settings.js',
    'modules/store.js', 'supabase/migrations',
  ]) {
    check(`受保護檔 ${file} 對 ${diffBase} 無差異`, unchangedFromBase(file));
  }

  if (!mutation) {
    for (const kind of ['direct', 'no_loop']) {
      const child = spawnSync(process.execPath, [__filename], { cwd: root, encoding: 'utf8', env: { ...process.env, PLANB2C_MUTATION: kind } });
      check(`反向突變 ${kind} 會被測試攔截`, child.status !== 0, `exit=${child.status}`);
    }
  }

  console.log(`\n結果：${passed} 通過，${failed} 失敗`);
  process.exitCode = failed ? 1 : 0;
})().catch(error => { console.error(error); process.exitCode = 1; });
