#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { spawnSync, execFileSync } = require('child_process');
const { pathToFileURL } = require('url');

const root = path.join(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
const mutation = process.env.PLANB3C2_MUTATION || '';
let common = read('common.js');
const helper = read('modules/verified-rpc.js');
let records = read('records.html');
const index = read('index.html');
const i18n = read('i18n.js');
const admin = read('admin.html');
const services = read('services.html');

if (mutation === 'direct_rpc') {
  records = records.replace("callSelfRpc('get_monthly_attendance'", "sb.rpc('get_monthly_attendance'");
}
if (mutation === 'deferred_rpc') {
  common = common.replace(/p_limit: 50,(\r?\n\s+p_company_id)/, 'p_limit: 51,$1');
}
if (mutation === 'relogin_read') {
  common = common.replace('const autoRelogin = options.autoRelogin === true;', 'const autoRelogin = true;');
}

let passed = 0;
let failed = 0;
function check(name, ok, detail = '') {
  if (ok) passed++; else failed++;
  console.log(`  ${ok ? '✅' : '❌'} ${name}${detail ? ` — ${detail}` : ''}`);
}

function gitOk(args) {
  return spawnSync('git', args, { cwd: root }).status === 0;
}
const diffBase = gitOk(['rev-parse', '--verify', '--quiet', 'origin/main']) ? 'origin/main'
  : (gitOk(['rev-parse', '--verify', '--quiet', 'HEAD^2']) ? 'HEAD^1' : 'HEAD');
function gitText(args) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8' });
}
function baseFile(file) {
  return gitText(['show', `${diffBase}:${file}`]).replace(/\r\n/g, '\n');
}
function unchangedFromBase(file) {
  return spawnSync('git', ['diff', '--quiet', diffBase, '--', file], { cwd: root }).status === 0;
}

function extractFunction(source, name) {
  const patterns = [`async function ${name}(`, `function ${name}(`];
  const starts = patterns.map(pattern => source.indexOf(pattern)).filter(index => index >= 0);
  if (!starts.length) throw new Error(`找不到 ${name}`);
  const start = Math.min(...starts);
  const brace = source.indexOf('{', start);
  let depth = 0;
  let quote = '';
  let escaped = false;
  for (let i = brace; i < source.length; i++) {
    const ch = source[i];
    if (quote) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === quote) quote = '';
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') { quote = ch; continue; }
    if (ch === '{') depth++;
    if (ch === '}' && --depth === 0) return source.slice(start, i + 1).replace(/\r\n/g, '\n');
  }
  throw new Error(`${name} 大括號未閉合`);
}

function parseStringCalls(source, callee) {
  const calls = [];
  const re = new RegExp(`${callee}\\(\\s*['"]([^'"]+)['"]`, 'g');
  let match;
  while ((match = re.exec(source))) {
    const open = source.indexOf('(', match.index);
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
      if (ch === ')' && --depth === 0) { end = i + 1; break; }
    }
    if (end < 0) throw new Error(`${callee} 括號未閉合`);
    const expression = source.slice(match.index, end);
    calls.push({
      fn: match[1],
      expression,
      params: [...expression.matchAll(/\b(p_\w+)\s*:/g)].map(item => item[1]),
    });
    re.lastIndex = end;
  }
  return calls;
}

function makeCommonHarness(source = common, token = 'token-c2') {
  const fetches = [];
  const actions = [];
  const toasts = [];
  let reloads = 0;
  const document = {
    hidden: false,
    addEventListener() {},
    removeEventListener() {},
    getElementById() { return null; },
    querySelector() { return null; },
    querySelectorAll() { return []; },
    createElement() { return { style: {}, appendChild() {}, setAttribute() {}, addEventListener() {} }; },
    body: { appendChild() {}, innerHTML: '' },
    head: { appendChild() {} },
    documentElement: { lang: 'zh-TW' },
  };
  const context = {
    window: null,
    globalThis: null,
    document,
    location: { search: '', pathname: '/index.html', hash: '', reload() { reloads++; } },
    sessionStorage: { getItem() { return null; }, setItem() {}, removeItem() {} },
    localStorage: { getItem() { return null; }, setItem() {}, removeItem() {} },
    navigator: {},
    console,
    setTimeout, clearTimeout, setInterval, clearInterval,
    MutationObserver: class { observe() {} disconnect() {} },
    CustomEvent: class { constructor(type, init) { this.type = type; this.detail = init?.detail; } },
    fetch: async (url, init) => {
      fetches.push({ url, body: JSON.parse(init.body) });
      return { json: async () => ({ ok: true, result: { source: 'common' } }) };
    },
    supabase: { createClient: () => ({}) },
    addEventListener() {},
    dispatchEvent() {},
    showToast(message) { toasts.push(String(message)); },
  };
  context.window = context;
  context.globalThis = context;
  context.window.supabase = context.supabase;
  vm.createContext(context);
  vm.runInContext(source, context, { filename: 'common.js' });
  context.currentCompanyId = '10000000-0000-0000-0000-000000000001';
  context.getLiffAccessTokenSafe = () => token;
  context.callVerifiedAction = async (action, payload) => {
    actions.push({ action, payload });
    return { ok: true, data: { result: { source: 'action' } } };
  };
  return { context, fetches, actions, toasts, reloads: () => reloads };
}

(async () => {
  console.log('\n=== Plan B 第三批 C2 common／records／index／i18n 改走 LINE 驗證 ===');
  const handler = await import(pathToFileURL(path.join(root, 'supabase', 'functions', 'line-push', 'handler.ts')).href);
  const selfSpecs = handler.SELF_RPC_SPECS;
  const adminSpecs = handler.ADMIN_RPC_SPECS;
  const sources = { common, records, index, i18n };
  const combined = Object.values(sources).join('\n');
  const selfFns = [
    'get_company_leave_overlap', 'get_my_leave_requests', 'submit_leave_request', 'get_leave_history',
    'get_monthly_attendance', 'get_my_year_end_stats', 'submit_overtime_request',
    'get_my_overtime_requests', 'get_my_current_salary', 'set_my_preferred_language',
  ];
  const adminFns = ['get_company_holidays', 'upsert_company_holiday', 'delete_company_holiday', 'get_company_daily_attendance'];
  const direct = [...selfFns, ...adminFns].filter(fn => new RegExp(`sb\\.rpc\\(\\s*['"]${fn}['"]`).test(combined));
  check('C2 名單函式直接 sb.rpc 為 0', direct.length === 0, direct.join(', '));

  const selfCalls = Object.entries(sources).flatMap(([file, source]) => parseStringCalls(source, 'callSelfRpc').map(call => ({ ...call, file })));
  const adminCalls = Object.entries(sources).flatMap(([file, source]) => parseStringCalls(source, 'callVerifiedRpc').map(call => ({ ...call, file })));
  const expectedSelfCounts = {
    get_company_leave_overlap: 1, get_my_leave_requests: 3, submit_leave_request: 1,
    get_leave_history: 1, get_monthly_attendance: 2, get_my_year_end_stats: 1,
    submit_overtime_request: 1, get_my_overtime_requests: 1, get_my_current_salary: 1,
    set_my_preferred_language: 1,
  };
  for (const [fn, expected] of Object.entries(expectedSelfCounts)) {
    check(`${fn} self_rpc 呼叫點數正確`, selfCalls.filter(call => call.fn === fn).length === expected,
      String(selfCalls.filter(call => call.fn === fn).length));
  }
  check('C2 管理 RPC 共 4 個呼叫點', adminCalls.filter(call => adminFns.includes(call.fn)).length === 4,
    String(adminCalls.filter(call => adminFns.includes(call.fn)).length));

  for (const call of selfCalls.filter(call => selfFns.includes(call.fn))) {
    const allowed = new Set(selfSpecs[call.fn].signatures.flatMap(item => Object.keys(item.params)));
    const unknown = call.params.filter(name => !allowed.has(name));
    check(`${call.file} ${call.fn} 參數均在 SELF_RPC_SPECS`, unknown.length === 0, unknown.join(', '));
  }
  for (const call of adminCalls.filter(call => adminFns.includes(call.fn))) {
    const allowed = new Set(Object.keys(adminSpecs[call.fn].params));
    const unknown = call.params.filter(name => !allowed.has(name));
    check(`${call.file} ${call.fn} 參數均在 ADMIN_RPC_SPECS`, unknown.length === 0, unknown.join(', '));
  }

  const submitLeave = extractFunction(common, 'submitLeave');
  const leaveHistory = extractFunction(common, 'loadLeaveHistory');
  check('請假送出舊多載 fallback 已移除', !/fallbackPayload|schema cache|p_leave_hours/.test(submitLeave));
  check('請假紀錄舊多載 fallback 已移除', (leaveHistory.match(/callSelfRpc\(\s*['"]get_leave_history['"]/g) || []).length === 1
    && !/schema cache/.test(leaveHistory));
  check('請假送出錯誤仍走可讀提示', /friendlyError\(e\)/.test(submitLeave));
  check('請假紀錄錯誤仍顯示載入失敗', /載入失敗/.test(leaveHistory));

  const overlapContext = {
    currentEmployee: { id: 'employee' }, sb: {}, window: { currentCompanyId: 'company' },
    liffProfile: { userId: 'Utest' }, getCachedSetting: () => null, console, Date,
    callSelfRpc: async () => ({ data: null, error: { code: 'network_error', message: 'offline' } }),
  };
  vm.createContext(overlapContext);
  vm.runInContext(extractFunction(common, 'checkLeaveAvailability'), overlapContext);
  const overlapResult = await overlapContext.checkLeaveAvailability('2026-12-01', '2026-12-01');
  check('請假重疊查詢失敗仍允許交由送出 RPC 裁決', overlapResult.ok === true
    && overlapResult.availabilityUnknown === true && overlapResult.thresholdExceeded === false);

  const commonHarness = makeCommonHarness();
  check('只載 common.js 即提供 callSelfRpc／callVerifiedRpc', typeof commonHarness.context.callSelfRpc === 'function'
    && typeof commonHarness.context.callVerifiedRpc === 'function');
  const commonResult = await commonHarness.context.callSelfRpc('get_my_current_salary');
  check('common.js 單獨可完成 self_rpc 並保持 {data,error}', commonHarness.fetches[0]?.body.action === 'self_rpc'
    && commonResult.data?.source === 'common' && commonResult.error === null);
  const selfBefore = commonHarness.context.callSelfRpc;
  const adminBefore = commonHarness.context.callVerifiedRpc;
  vm.runInContext(helper, commonHarness.context, { filename: 'modules/verified-rpc.js' });
  check('同時載入 verified-rpc.js 不覆蓋 common.js adapter', commonHarness.context.callSelfRpc === selfBefore
    && commonHarness.context.callVerifiedRpc === adminBefore);

  const adminCompat = makeCommonHarness();
  const adminResult = await adminCompat.context.callVerifiedRpc('get_company_shift_types', {});
  check('既有 admin helper 預設仍沿用 callVerifiedAction', adminCompat.actions.length === 1
    && adminCompat.actions[0].action === 'admin_rpc' && adminCompat.fetches.length === 0
    && adminResult.data?.source === 'action');
  const noToken = makeCommonHarness(common, null);
  const readResult = await noToken.context.callSelfRpc('get_monthly_attendance', { p_year: 2026, p_month: 11 });
  check('self 讀取缺 token 不自動轉頁', readResult.error?.code === 'unauthenticated'
    && noToken.actions.length === 0 && noToken.reloads() === 0);
  check('管理型讀取明確停用自動重登', /get_company_holidays[\s\S]*?autoRelogin:\s*false/.test(common)
    && /get_company_daily_attendance[\s\S]*?autoRelogin:\s*false/.test(records));
  check('使用者主動寫入明確啟用表單保留重登', [
    /submit_leave_request[\s\S]{0,500}autoRelogin:\s*true/.test(common),
    /submit_overtime_request[\s\S]{0,500}autoRelogin:\s*true/.test(common),
    /upsert_company_holiday[\s\S]{0,500}autoRelogin:\s*true/.test(common),
    /delete_company_holiday[\s\S]{0,500}autoRelogin:\s*true/.test(common),
    /set_my_preferred_language[\s\S]{0,500}autoRelogin:\s*true/.test(i18n),
  ].every(Boolean));

  const baseCommon = baseFile('common.js');
  for (const name of ['loadTodayPendingMakeups', 'submitMakeupPunch', 'loadMakeupHistory']) {
    check(`第四批 ${name} 對 ${diffBase} 逐字不變`, extractFunction(common, name) === extractFunction(baseCommon, name));
  }
  for (const file of ['checkin.html', 'kiosk.html', 'attendance_overview.html', 'attendance_public.html', 'supabase', 'migrations']) {
    check(`受保護檔 ${file} 對 ${diffBase} 無差異`, unchangedFromBase(file));
  }
  const protectedModules = ['attendance-read-columns.js', 'audit.js', 'auth.js', 'employee-read-columns.js', 'employees.js',
    'index.js', 'leave.js', 'payroll.js', 'schedules.js', 'settings.js', 'store.js'];
  for (const file of protectedModules) check(`受保護模組 modules/${file} 無差異`, unchangedFromBase(`modules/${file}`));

  const adminDiffLines = gitText(['diff', '--unified=0', diffBase, '--', 'admin.html'])
    .split(/\r?\n/).filter(line => /^[+-](?![+-])/.test(line));
  check('admin.html 2a 行為只變更 common/helper 快取字串', adminDiffLines.length === 4
    && adminDiffLines.every(line => /(?:common\.js|modules\/verified-rpc\.js)\?v=/.test(line)));
  const servicesDiffLines = gitText(['diff', '--unified=0', diffBase, '--', 'services.html'])
    .split(/\r?\n/).filter(line => /^[+-](?![+-])/.test(line));
  check('services.html 只變更 common/i18n 快取字串', servicesDiffLines.length === 4
    && servicesDiffLines.every(line => /(?:common|i18n)\.js\?v=/.test(line)));

  const c2Cache = '20261128-planb163c2';
  for (const source of [admin, index, records, services]) check(`C2 common 快取 ${c2Cache}`, source.includes(`common.js?v=${c2Cache}`));
  for (const source of [index, records, services]) check(`C2 i18n 快取 ${c2Cache}`, source.includes(`i18n.js?v=${c2Cache}`));
  check('admin helper 快取與 C2 同步', admin.includes(`modules/verified-rpc.js?v=${c2Cache}`));
  const deferredCachePages = ['attendance_overview.html', 'booking_service_admin.html', 'checkin.html', 'fieldwork.html',
    'loyalty_admin.html', 'platform.html', 'requests.html', 'salary.html', 'schedule.html'];
  check('其餘 common 消費頁留待後續批次', deferredCachePages.every(file => read(file).includes('common.js?v=20261127-lunchsum')),
    deferredCachePages.filter(file => !read(file).includes('common.js?v=20261127-lunchsum')).join(', '));

  const changedProducts = gitText(['diff', '--name-only', diffBase, '--', '*.html', '*.js', 'modules/*.js'])
    .split(/\r?\n/).filter(Boolean).filter(file => !file.startsWith('tests/'));
  check('C2 產品檔未超過 8 個', changedProducts.length <= 8, `${changedProducts.length}: ${changedProducts.join(', ')}`);

  if (!mutation) {
    for (const kind of ['direct_rpc', 'deferred_rpc', 'relogin_read']) {
      const child = spawnSync(process.execPath, [__filename], {
        cwd: root, encoding: 'utf8', env: { ...process.env, PLANB3C2_MUTATION: kind },
      });
      check(`反向突變 ${kind} 會被測試攔截`, child.status !== 0, `exit=${child.status}`);
    }
  }

  console.log(`\n結果：${passed} 通過，${failed} 失敗`);
  process.exitCode = failed ? 1 : 0;
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
