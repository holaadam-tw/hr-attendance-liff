#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { execFileSync, spawnSync } = require('child_process');
const { pathToFileURL } = require('url');

const root = path.join(__dirname, '..');
const target = process.env.PLANB2B_OVERVIEW_FILE || path.join(root, 'attendance_overview.html');
let html = fs.readFileSync(target, 'utf8');
if (process.env.PLANB2B_DIRECT_RPC === '1') {
  html = html.replace("callVerifiedRpc('get_line_push_status'", "sb.rpc('get_line_push_status'");
}
const handlerPath = path.join(root, 'supabase', 'functions', 'line-push', 'handler.ts');

let pass = 0;
let fail = 0;
function check(name, ok, detail = '') {
  ok ? pass++ : fail++;
  console.log(`  ${ok ? '✅' : '❌'} ${name}${detail ? ` — ${detail}` : ''}`);
}

function inlinePage(source) {
  const blocks = [...source.matchAll(/<script(?![^>]*src=)[^>]*>([\s\S]*?)<\/script>/g)].map(m => m[1]);
  if (!blocks[1]) throw new Error('attendance_overview.html 找不到第二段 inline script');
  return blocks[1];
}

function makeElement(id) {
  return {
    id,
    style: { display: '', cssText: '' },
    innerHTML: '',
    textContent: '',
    value: '',
    disabled: false,
  };
}

function makeHarness() {
  const nodes = {};
  const calls = [];
  const alerts = [];
  const toasts = [];
  const elements = id => (nodes[id] ||= makeElement(id));
  const ctx = {
    console,
    JSON,
    Math,
    Date,
    Number,
    String,
    Array,
    Object,
    Set,
    Promise,
    isNaN,
    parseInt,
    parseFloat,
    setInterval: () => 0,
    clearInterval: () => {},
    setTimeout: () => 0,
    document: {
      getElementById: elements,
      addEventListener: () => {},
      querySelectorAll: () => [],
      querySelector: () => null,
      body: { style: {} },
    },
    window: { currentCompanyId: '10000000-0000-0000-0000-000000000001', addEventListener: () => {} },
    localStorage: { getItem: () => null, setItem: () => {} },
    liff: {},
    liffProfile: { userId: 'Uverified' },
    officeLocations: [],
    currentCompanyFeatures: {},
    XLSX: {},
    alert: message => alerts.push(String(message)),
    showToast: message => toasts.push(String(message)),
    confirm: () => true,
    writeAuditLog: () => {},
    escapeHTML: value => String(value ?? '')
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#039;'),
    calculateDistance: () => 0,
    getTaiwanDate: () => '2026-11-28',
    getCachedSetting: () => null,
  };
  ctx.window.window = ctx.window;
  ctx.globalThis = ctx;
  ctx.callVerifiedRpc = async (fn, args) => {
    calls.push({ fn, args });
    return { data: [], error: null };
  };
  vm.createContext(ctx);
  vm.runInContext(inlinePage(html), ctx);
  return { ctx, nodes, calls, alerts, toasts, elements };
}

// 比對基準：本機有 origin/main 就用它；CI（PR merge commit、淺 clone）沒有時改用 merge commit 的第一個 parent（＝main）；都沒有就比 HEAD
const gitOk = (args) => spawnSync('git', args, { cwd: root }).status === 0;
const diffBase = gitOk(['rev-parse', '--verify', '--quiet', 'origin/main']) ? 'origin/main'
  : (gitOk(['rev-parse', '--verify', '--quiet', 'HEAD^2']) ? 'HEAD^1' : 'HEAD');
function gitUnchanged(file) {
  return spawnSync('git', ['diff', '--quiet', diffBase, '--', file], { cwd: root }).status === 0;
}

(async () => {
  console.log('\n=== Plan B 第二批 2b 打卡總覽 ===');
  const handler = await import(pathToFileURL(handlerPath).href);
  const specs = handler.ADMIN_RPC_SPECS;
  const adminFns = Object.keys(specs);
  check('後續批次擴充後 ADMIN_RPC_SPECS 仍恰為 29 支', adminFns.length === 29, String(adminFns.length));

  const direct = adminFns.filter(fn => new RegExp(`sb\\.rpc\\(\\s*['"]${fn}['"]`).test(html));
  check('29 支 ADMIN_RPC_SPECS 在頁面直接 sb.rpc 為 0', direct.length === 0, direct.join(', '));

  const calls = [...html.matchAll(/callVerifiedRpc\(\s*['"]([^'"]+)['"]\s*,\s*\{([\s\S]*?)\}\s*\)/g)];
  check('頁面共有 16 處 callVerifiedRpc', calls.length === 16, String(calls.length));
  const unknownFns = calls.map(m => m[1]).filter(fn => !Object.prototype.hasOwnProperty.call(specs, fn));
  check('所有 callVerifiedRpc 函式都在 Edge 白名單', unknownFns.length === 0, unknownFns.join(', '));
  for (const match of calls) {
    const fn = match[1];
    const args = [...match[2].matchAll(/\b(p_\w+)\s*:/g)].map(m => m[1]);
    const unknown = args.filter(name => name !== 'p_line_user_id' && !Object.prototype.hasOwnProperty.call(specs[fn].params, name));
    check(`${fn} 參數名均在白名單`, unknown.length === 0, unknown.join(', '));
  }

  const commonPos = html.indexOf('common.js?v=20261127-lunchsum');
  const helperPos = html.indexOf('modules/verified-rpc.js?v=20261128-planb162');
  const pagePos = html.indexOf('        let dailyData = []');
  check('載入順序為 common.js → verified-rpc.js → inline script',
    commonPos >= 0 && commonPos < helperPos && helperPos < pagePos);

  const protectedFiles = [
    'common.js', 'checkin.html', 'index.html', 'kiosk.html', 'records.html',
    'modules/attendance-read-columns.js', 'modules/audit.js', 'modules/auth.js',
    'modules/employee-read-columns.js', 'modules/employees.js', 'modules/index.js',
    'modules/leave.js', 'modules/payroll.js', 'modules/schedules.js', 'modules/settings.js',
    'modules/store.js', 'supabase/migrations',
  ];
  for (const file of protectedFiles) check(`受保護檔 ${file} 與 ${diffBase} 無差異`, gitUnchanged(file));

  const h = makeHarness();
  const { ctx, elements, calls: rpcCalls, toasts } = h;
  elements('dailyDatePicker').value = '2026-11-28';
  elements('filterDept').value = '';
  elements('filterStatus').value = '';
  const quiet = ['loadCheckoutDistances', 'loadLunchStats', 'loadAnomalyData', 'loadCheckinFailures', 'loadOvertimeConfirm', 'loadLegacyGaps'];
  quiet.forEach(name => { ctx[name] = async () => {}; });

  ctx.callVerifiedRpc = async (fn, args) => {
    rpcCalls.push({ fn, args });
    if (fn === 'get_company_daily_attendance') return { data: [{ employee_id: 'E1', employee_name: '王員工', status: 'working' }], error: null };
    if (fn === 'get_company_holidays') return { data: [], error: null };
    return { data: [], error: null };
  };
  await ctx.loadDailyData();
  check('每日總覽成功時更新統計與表格', elements('dExpected').textContent === 1 && elements('dailyTableBody').innerHTML.includes('王員工'));
  check('每日總覽走 verified RPC', rpcCalls.some(c => c.fn === 'get_company_daily_attendance'));

  ctx.callVerifiedRpc = async (fn, args) => {
    rpcCalls.push({ fn, args });
    if (fn === 'get_company_daily_attendance') return { data: null, error: { code: 'db_not_migrated', message: '資料庫尚未套用 migration 162' } };
    return { data: [], error: null };
  };
  await ctx.loadDailyData();
  check('每日總覽 verified 錯誤顯示可讀提示且不丟例外', elements('dailyTableBody').innerHTML.includes('資料庫尚未套用 migration 162'));

  vm.runInContext(`otPendingRows = [{ employeeId:'20000000-0000-0000-0000-000000000001', date:'2026-11-27', name:'王員工', estimateMin:60 }];`, ctx);
  elements('otMin_20000000-0000-0000-0000-000000000001|2026-11-27').value = '60';
  ctx.callVerifiedRpc = async (fn, args) => {
    rpcCalls.push({ fn, args });
    return { data: { success: true }, error: null };
  };
  await ctx.submitOvertimeDecision('20000000-0000-0000-0000-000000000001|2026-11-27', 'confirm');
  check('加班確認成功維持成功提示', toasts.some(m => m.includes('已確認加班')));
  const overtimeCall = rpcCalls.findLast(c => c.fn === 'confirm_daily_overtime');
  check('加班確認參數維持整數分鐘與原確認流程', overtimeCall?.args.p_minutes === 60 && overtimeCall.args.p_decision === 'confirm');

  ctx.callVerifiedRpc = async (fn, args) => {
    rpcCalls.push({ fn, args });
    return { data: null, error: { code: 'access_denied', message: '需要管理員權限' } };
  };
  await ctx.submitOvertimeDecision('20000000-0000-0000-0000-000000000001|2026-11-27', 'confirm');
  check('加班確認 verified 錯誤顯示提示且不丟例外', toasts.some(m => m.includes('確認失敗：需要管理員權限')));

  ctx.callVerifiedRpc = async (fn, args) => {
    rpcCalls.push({ fn, args });
    return { data: { success: true }, error: null };
  };
  await ctx.resolveAnomaly('30000000-0000-0000-0000-000000000001');
  check('異常處理成功維持成功提示', toasts.some(m => m.includes('已結案')));

  ctx.callVerifiedRpc = async (fn, args) => {
    rpcCalls.push({ fn, args });
    return { data: null, error: { code: 'access_denied', message: '需要管理員權限' } };
  };
  await ctx.resolveAnomaly('30000000-0000-0000-0000-000000000001');
  check('異常處理 verified 錯誤顯示提示且不丟例外', toasts.some(m => m.includes('結案失敗：需要管理員權限')));

  // 成功寫入後的重載以獨立流程驗過；此處避免 fire-and-forget 重載干擾錯誤案例輸出。
  ctx.loadDailyData = async () => {};

  vm.runInContext(`amEmployees = [{ id:'40000000-0000-0000-0000-000000000001', name:'李員工' }];`, ctx);
  elements('amEmployee').value = '40000000-0000-0000-0000-000000000001';
  elements('amDate').value = '2026-11-27';
  elements('amType').value = 'clock_out';
  elements('amTime').value = '17:00';
  elements('amNote').value = '';
  ctx.callVerifiedRpc = async (fn, args) => {
    rpcCalls.push({ fn, args });
    return { data: { success: true, overwrote: false }, error: null };
  };
  await ctx.submitAdminMakeup();
  check('代補打卡成功維持成功提示與按鈕復原',
    toasts.some(m => m.includes('已補登下班')) && elements('amSubmitBtn').disabled === false && elements('amSubmitBtn').textContent === '確定補登');
  const makeupCall = rpcCalls.findLast(c => c.fn === 'admin_makeup_punch');
  check('代補打卡時間格式符合 Edge time 白名單', makeupCall?.args.p_punch_time === '17:00');

  ctx.callVerifiedRpc = async (fn, args) => {
    rpcCalls.push({ fn, args });
    return { data: null, error: { code: 'db_not_migrated', message: '資料庫尚未套用 migration 162' } };
  };
  await ctx.submitAdminMakeup();
  check('代補打卡 verified 錯誤顯示提示且按鈕仍復原',
    toasts.some(m => m.includes('補登失敗：資料庫尚未套用 migration 162'))
      && elements('amSubmitBtn').disabled === false && elements('amSubmitBtn').textContent === '確定補登');

  console.log(`\n結果：${pass} 通過，${fail} 失敗`);
  process.exitCode = fail ? 1 : 0;
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
