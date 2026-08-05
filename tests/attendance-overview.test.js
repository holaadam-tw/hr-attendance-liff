// ============================================================
// 打卡總覽回歸測試（vm sandbox）
//
// 測的是「真實檔案裡的真實程式碼」，不是副本：
//   - attendance_overview.html 的 inline script 原樣載入 vm context
//   - calculateDistance / escapeHTML / getTaiwanDate 直接從 common.js 取真本
//   只補 DOM 與 supabase 的替身，被測邏輯一行都沒有另外抄。
//
// 執行：npm run test:overview（或 npm test 一併跑）
//
// 涵蓋範圍：
//   1. 下班定位距離判定（evaluateCheckoutDistance 座標邊界）
//   2. 定位點分群（clusterPoints）
//   3. 分群渲染（重複標示、排序、XSS 逃逸）
//   4. 90 天窗期計算（跨月／跨年／閏年／DST）
//   5. 空狀態不殘留舊清單
//   6. fmtDistance 邊界
//   7. 換日期時 90 天快取失效
//   8. 代補打卡時間預設值（下班 17:00／上班 08:00）
//   9. 加班確認清單（門檻、推估、排除、多租戶 filter）
//  10. 加班確認送出的防呆
//
// 注意：
//   - inline script 用 let 宣告的變數（checkoutRangeHistory / clusterLoaded
//     等）不會成為 vm context 的屬性，從外部指派會建出另一個變數而測不到
//     真的東西。需要碰它們的段落必須用 vm.runInContext 在同一個詞法作用域跑。
//   - 時間相關斷言一律固定「今天」，不可依賴系統時鐘。
// ============================================================

const fs = require('fs');
const vm = require('vm');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const TARGET = process.env.AO_FILE || path.join(ROOT, 'attendance_overview.html');
const html = fs.readFileSync(TARGET, 'utf8');
const common = fs.readFileSync(path.join(ROOT, 'common.js'), 'utf8');

// 從 common.js 取真正的函式本體（不是自己寫一份）
function grab(src, name) {
  const i = src.indexOf('function ' + name + '(');
  if (i < 0) throw new Error('common.js 找不到函式：' + name);
  let depth = 0, started = false;
  for (let j = i; j < src.length; j++) {
    if (src[j] === '{') { depth++; started = true; }
    else if (src[j] === '}') { depth--; if (started && depth === 0) return src.slice(i, j + 1); }
  }
  throw new Error('括號不對稱：' + name);
}
const commonFns = ['calculateDistance', 'escapeHTML', 'getTaiwanDate'].map(n => grab(common, n)).join('\n');

const blocks = [...html.matchAll(/<script(?![^>]*src=)[^>]*>([\s\S]*?)<\/script>/g)].map(m => m[1]);
const page = blocks[1];
if (!page) throw new Error('attendance_overview.html 找不到第二段 inline script');

// ---- DOM 替身 ----
const nodes = {};
function el(id) {
  if (!nodes[id]) nodes[id] = { id, style: { display: '', cssText: '' }, innerHTML: '', textContent: '', value: '' };
  return nodes[id];
}
const ctx = {
  console, JSON, Math, Date, Number, String, Array, Object, Set, Promise, isNaN, parseInt, parseFloat,
  setInterval: () => 0, clearInterval: () => {}, setTimeout: () => 0,
  document: { getElementById: el, addEventListener: () => {}, querySelectorAll: () => [], querySelector: () => null, body: { style: {} } },
  window: { currentCompanyId: 'COMPANY-A', addEventListener: () => {} },
  localStorage: { getItem: () => null, setItem: () => {} },
  liff: {}, liffProfile: { userId: 'U1' },
  officeLocations: [{ name: '大正工廠', lat: 24.0800, lng: 120.5400, radius: 600 }],
  XLSX: {}, alert: () => {}, showToast: () => {}, confirm: () => true, writeAuditLog: () => {},
};
ctx.globalThis = ctx;
vm.createContext(ctx);
vm.runInContext(commonFns, ctx);
vm.runInContext(page, ctx);

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  ✅ ' + name + (extra ? '  → ' + extra : '')); }
  else { fail++; console.log('  ❌ ' + name + (extra ? '  → ' + extra : '')); }
}
ctx.__check = check;

const OFFICE = ctx.officeLocations[0];
const north = (m) => OFFICE.lat + m / 111320;   // 往北位移 m 公尺（緯度 1 度 ≈ 111320 公尺）
ctx.__north = north;
ctx.__OFFICE = OFFICE;

console.log('\n═══════════════════════════════════════');
console.log('  打卡總覽回歸測試');
console.log('═══════════════════════════════════════');

console.log('\n=== 1. 下班定位距離判定 ===');
check('null 座標 → null', ctx.evaluateCheckoutDistance(null, null) === null);
check('空字串 → null（不可被當成 (0,0) 算出假範圍外）', ctx.evaluateCheckoutDistance('', '') === null);
check('undefined → null', ctx.evaluateCheckoutDistance(undefined, 120.54) === null);
const inRange = ctx.evaluateCheckoutDistance(north(120), OFFICE.lng);
check('範圍內 120m（半徑 600）isOutside=false', inRange && !inRange.isOutside, Math.round(inRange.distance) + 'm');
const outRange = ctx.evaluateCheckoutDistance(north(1200), OFFICE.lng);
check('範圍外 1200m isOutside=true', outRange && outRange.isOutside, Math.round(outRange.distance) + 'm');
check('字串座標可正確轉數字', (() => {
  const a = ctx.evaluateCheckoutDistance(String(north(1200)), String(OFFICE.lng));
  return a && Math.abs(a.distance - outRange.distance) < 0.001;
})());
check('radius 未設定 → fallback 100m（與 quick_check_in 的 COALESCE(radius,100) 對齊）', (() => {
  const saved = ctx.officeLocations;
  ctx.officeLocations = [{ name: 'X', lat: OFFICE.lat, lng: OFFICE.lng }];
  const r = ctx.evaluateCheckoutDistance(north(150), OFFICE.lng);
  ctx.officeLocations = saved;
  return r.radius === 100 && r.isOutside === true;
})());
check('無打卡地點設定 → null', (() => {
  const saved = ctx.officeLocations;
  ctx.officeLocations = [];
  const r = ctx.evaluateCheckoutDistance(north(1200), OFFICE.lng);
  ctx.officeLocations = saved;
  return r === null;
})());

console.log('\n=== 2. 定位點分群 ===');
const mk = (lat, lng, date, name) => ({ lat, lng, date, name, employeeNumber: 'E999',
  checkOutTime: date + 'T10:00:00Z', info: ctx.evaluateCheckoutDistance(lat, lng) });
const pts = [
  mk(north(5000), OFFICE.lng, '2026-06-01', '甲君'),
  mk(north(5000) + 0.0004, OFFICE.lng, '2026-06-10', '甲君'),
  mk(north(5000) + 0.0007, OFFICE.lng, '2026-06-20', '甲君'),
  mk(north(9000), OFFICE.lng, '2026-07-02', '乙君'),
  mk(north(9000) + 0.0002, OFFICE.lng, '2026-07-09', '丙君'),
  mk(north(1500), OFFICE.lng + 0.02, '2026-07-15', '丁君'),
];
const clusters = ctx.clusterPoints(pts);
check('分成 3 群', clusters.length === 3, '實得 ' + clusters.length);
check('群大小為 [3,2,1]', JSON.stringify(clusters.map(c => c.items.length).sort((a, b) => b - a)) === '[3,2,1]');
const big = clusters.find(c => c.items.length === 3);
check('3 點群的群心介於成員之間', big.lat > pts[0].lat && big.lat < pts[2].lat);
check('spread 為對「最終群心」的最大距離（非加入當下）', (() => {
  const truth = Math.max(...big.items.map(p => ctx.calculateDistance(p.lat, p.lng, big.lat, big.lng)));
  return Math.abs(big.spread - truth) < 1e-9;
})(), '最大偏移 ' + big.spread.toFixed(2) + 'm');
check('群內最大偏移不超過分群門檻', big.spread < 100, big.spread.toFixed(1) + 'm < 100m');
check('單點群 spread = 0', clusters.find(c => c.items.length === 1).spread === 0);
check('空輸入 → 空陣列', ctx.clusterPoints([]).length === 0);

console.log('\n=== 3. 分群渲染 ===');
ctx.renderCheckoutClusters(clusters, '2026-05-08', '2026-08-05', 620);
const out = nodes['clusterPanel'].innerHTML;
check('標示重複 3 次', out.includes('重複 3 次'));
check('標示重複 2 次', out.includes('重複 2 次'));
check('單次者標示 1 次', out.includes('· 1 次'));
check('重複群排在單次群前面', out.indexOf('重複 3 次') < out.indexOf('· 1 次'));
check('顯示掃描筆數', out.includes('掃描 620 筆'));
check('同群同一人不重複列名', (out.match(/甲君/g) || []).length === 1);
check('顯示群內最大偏移', out.includes('群內最大偏移'));
check('無異常時顯示空訊息', (() => {
  ctx.renderCheckoutClusters([], '2026-05-08', '2026-08-05', 0);
  return nodes['clusterPanel'].innerHTML.includes('沒有範圍外的下班卡');
})());
check('XSS：員工姓名含 < > 會被逃逸', (() => {
  const evil = [{ lat: north(5000), lng: OFFICE.lng, spread: 0,
    items: [Object.assign({}, pts[0], { name: '<img src=x onerror=alert(1)>' })] }];
  ctx.renderCheckoutClusters(evil, '2026-05-08', '2026-08-05', 1);
  const h = nodes['clusterPanel'].innerHTML;
  return h.includes('&lt;img') && !h.includes('<img');
})());

console.log('\n=== 4. 90 天窗期計算 ===');
const spanOf = (dateStr, days) => {
  const fromMs = Date.parse(dateStr + 'T00:00:00+08:00') - (days - 1) * 86400000;
  const fromStr = new Date(fromMs).toLocaleDateString('en-CA', { timeZone: 'Asia/Taipei' });
  return { fromStr, span: Math.round((Date.parse(dateStr + 'T00:00:00+08:00') - Date.parse(fromStr + 'T00:00:00+08:00')) / 86400000) };
};
[['2026-08-05', '一般'], ['2026-01-15', '跨年'], ['2026-03-10', '跨年'], ['2024-05-01', '閏年'],
 ['2026-12-31', '年末'], ['2026-11-05', '美國 DST 週']].forEach(([d, label]) => {
  const r = spanOf(d, 90);
  check('90 天窗期 ' + d + '（' + label + '）→ ' + r.fromStr, r.span === 89, 'span=' + r.span);
});

// checkoutRangeHistory / clusterLoaded / officeLocations 是 let 宣告，必須同作用域
vm.runInContext(`
console.log('\\n=== 5. 空狀態不殘留舊清單 ===');
document.getElementById('dailyDatePicker').value = '2026-08-05';
const _detail = document.getElementById('checkoutRangeDetail');
const _badge = document.getElementById('checkoutRangeBadge');
const _card = document.getElementById('checkoutRangeCard');

checkoutRangeHistory = [{ date: '2026-08-01', name: '甲君', employeeNumber: 'E900',
  checkOutTime: '2026-08-01T10:18:00Z', info: evaluateCheckoutDistance(__north(18100), __OFFICE.lng) }];
renderCheckoutRangeCard();
__check('有異常時卡片列出該筆', _detail.innerHTML.includes('甲君'));
__check('有異常時 badge 顯示近 30 天筆數', _badge.textContent.includes('近 30 天 1 筆'), _badge.textContent);

checkoutRangeHistory = [];
renderCheckoutRangeCard();
__check('空狀態 badge 改為無異常', _badge.textContent.includes('無異常'), _badge.textContent);
__check('空狀態卡片仍顯示（90 天統計按鈕要有地方按）', _card.style.display === 'block');
__check('空狀態已清空舊清單（點開不會看到上一個窗期的資料）', _detail.innerHTML === '',
  _detail.innerHTML === '' ? '已清空' : '殘留：' + _detail.innerHTML.slice(0, 40));

const _saved = officeLocations;
officeLocations = [];
renderCheckoutRangeCard();
__check('無打卡地點設定 → 整張卡片隱藏', _card.style.display === 'none');
officeLocations = _saved;
`, ctx);

console.log('\n=== 6. fmtDistance ===');
check('120 → 120m', ctx.fmtDistance(120) === '120m', ctx.fmtDistance(120));
check('999.5 不顯示成 1000m', ctx.fmtDistance(999.5) === '1.0km', ctx.fmtDistance(999.5));
check('18100 → 18.1km', ctx.fmtDistance(18100) === '18.1km', ctx.fmtDistance(18100));
check('非數字 → -', ctx.fmtDistance(NaN) === '-');

vm.runInContext(`
console.log('\\n=== 7. 換日期時 90 天快取失效 ===');
let _reloadCalled = 0;
loadCheckoutClusters = async function () { _reloadCalled++; };
loadDailyData = async function () {};

clusterLoaded = true;
document.getElementById('clusterPanel').style.display = 'none';
onDailyDateChange();
__check('換日期後 clusterLoaded 重置為 false', clusterLoaded === false);
__check('面板收合中不主動重查（省一次 90 天查詢）', _reloadCalled === 0, '重查 ' + _reloadCalled + ' 次');

clusterLoaded = true;
document.getElementById('clusterPanel').style.display = 'block';
onDailyDateChange();
__check('面板展開中換日期會立即重查（不留舊窗期資料）', _reloadCalled === 1, '重查 ' + _reloadCalled + ' 次');
`, ctx);

console.log('\n=== 8. 代補打卡時間預設值 ===');
const amType = el('amType'), amTime = el('amTime'), amHint = el('amTimeHint');

ctx.getCachedSetting = () => null;
amType.value = 'clock_out'; ctx.applyAmDefaultTime();
check('下班預設 17:00（無設定時 fallback）', amTime.value === '17:00', amTime.value);
amType.value = 'clock_in'; ctx.applyAmDefaultTime();
check('上班預設 08:00（無設定時 fallback）', amTime.value === '08:00', amTime.value);

ctx.getCachedSetting = (k) => ({ default_work_start: '08:30', default_work_end: '18:00' })[k];
amType.value = 'clock_out'; ctx.applyAmDefaultTime();
check('下班改讀 system_settings 的 default_work_end', amTime.value === '18:00', amTime.value);
amType.value = 'clock_in'; ctx.applyAmDefaultTime();
check('上班改讀 system_settings 的 default_work_start', amTime.value === '08:30', amTime.value);

[['17:00:00', '17:00', '含秒數會被截成 HH:MM'],
 ['5pm', '17:00', '非 HH:MM 字串 → fallback'],
 ['25:00', '17:00', '不存在的小時 → fallback'],
 ['17:99', '17:00', '不存在的分鐘 → fallback'],
 ['', '17:00', '空字串 → fallback'],
 [null, '17:00', 'null → fallback']].forEach(([val, want, label]) => {
  ctx.getCachedSetting = () => val;
  amType.value = 'clock_out'; ctx.applyAmDefaultTime();
  check(label, amTime.value === want, JSON.stringify(val) + ' → ' + amTime.value);
});

ctx.getCachedSetting = () => null;
amType.value = 'clock_out'; ctx.applyAmDefaultTime();
amTime.value = '19:30';
amType.value = 'clock_in'; ctx.applyAmDefaultTime();
check('換類型一定重設（不留下 19:30，避免把上班時間送成下班時間）', amTime.value === '08:00', amTime.value);

amType.value = 'clock_out'; ctx.applyAmDefaultTime();
check('下班提示說明「沒有加班就算到這個時間」', amHint.textContent.includes('沒有加班就算到這個時間'));
check('提示帶出實際預設值', amHint.textContent.includes('17:00'));
check('submitAdminMakeup 仍保有「請填寫時間」檢查（沒因為有預設值就繞過）',
  html.includes("if (!time) return showToast('❌ 請填寫時間')"));

// ---- 加班確認：需要可鏈式呼叫的 supabase 替身 ----
function makeSb(tables) {
  const calls = [];
  return {
    calls,
    from(t) {
      const rec = { table: t, chain: [] };
      calls.push(rec);
      const api = {};
      ['select', 'gte', 'lte', 'eq', 'not', 'limit', 'order'].forEach(m => {
        api[m] = (...a) => { rec.chain.push(m + '(' + a.join(',') + ')'); return api; };
      });
      api.then = (res) => res({ data: tables[t] || [], error: null });
      return api;
    },
    rpc: async () => ({ data: { success: true }, error: null })
  };
}

ctx.getTaiwanDate = () => '2026-08-06';    // 固定「今天」，昨天 = 08-05
const utc = (d, hhmm) => new Date(d + 'T' + hhmm + ':00+08:00').toISOString();
const ATT = [
  { employee_id: 'E1', date: '2026-08-05', check_out_time: utc('2026-08-05', '20:30'), employees: { company_id: 'COMPANY-A', name: '甲君', employee_number: 'E801' } },
  { employee_id: 'E2', date: '2026-08-05', check_out_time: utc('2026-08-05', '18:18'), employees: { company_id: 'COMPANY-A', name: '乙君', employee_number: 'E802' } },
  { employee_id: 'E3', date: '2026-08-05', check_out_time: utc('2026-08-05', '17:05'), employees: { company_id: 'COMPANY-A', name: '丙君', employee_number: 'E803' } },
  { employee_id: 'E4', date: '2026-08-01', check_out_time: utc('2026-08-01', '19:00'), employees: { company_id: 'COMPANY-A', name: '丁君', employee_number: 'E804' } },
  { employee_id: 'E5', date: '2026-08-02', check_out_time: utc('2026-08-02', '19:30'), employees: { company_id: 'COMPANY-A', name: '戊君', employee_number: 'E805' } },
  { employee_id: 'E6', date: '2026-08-03', check_out_time: utc('2026-08-03', '21:00'), employees: { company_id: 'COMPANY-A', name: '己君', employee_number: 'E806' } },
];
const OTR = [
  { employee_id: 'E4', ot_date: '2026-08-01', status: 'approved', source_type: 'late_close_auto', final_hours: 1.5, employees: { company_id: 'COMPANY-A', name: '丁君', employee_number: 'E804' } },
  { employee_id: 'E6', ot_date: '2026-08-03', status: 'pending', source_type: 'manual', hours: 3, employees: { company_id: 'COMPANY-A', name: '己君', employee_number: 'E806' } },
];

(async () => {
  console.log('\n=== 9. 加班確認清單 ===');
  ctx.sb = makeSb({ attendance: ATT, overtime_requests: OTR });
  ctx.getCachedSetting = (k) => ({ default_work_end: '17:00' })[k];

  const otDetail = el('otConfirmDetail'), otBadge = el('otConfirmBadge'), otCard = el('otConfirmCard');
  await ctx.loadOvertimeConfirm();
  const h = otDetail.innerHTML;

  check('20:30 列入待確認', h.includes('E801'));
  check('18:18 列入待確認', h.includes('E802'));
  check('17:05 不列入待確認（門檻 18:00，屬正常收工）', !h.includes('E803'));
  check('已確認過的不再出現在待確認列', !h.includes('E804'));
  check('已確認者仍出現在「已核准加班」區塊', h.includes('丁君'));
  check('漏看幾天的仍在清單（不掉件）', h.includes('E805'));
  check('員工自送 manual 申請者不列入（不覆蓋員工申請）', !h.includes('E806'));
  check('badge 標示昨天筆數', otBadge.textContent.includes('昨天 2 筆'), otBadge.textContent);
  check('badge 標示總待確認筆數', otBadge.textContent.includes('待確認 3 筆'), otBadge.textContent);
  check('昨天的列標「昨天」標籤', h.includes('>昨天<'));
  check('推估 180 分鐘（20:30 − 17:30）', h.includes('value="180"'));
  check('推估 48 分鐘（18:18 − 17:30）', h.includes('value="48"'));
  check('說明寫明從 17:30 起算', h.includes('17:30'));
  check('說明寫明只有確認過的才計薪', h.includes('只有確認過的才會進薪資彙總'));

  const attQ = ctx.sb.calls.find(c => c.table === 'attendance');
  const otQ = ctx.sb.calls.find(c => c.table === 'overtime_requests');
  check('attendance 查詢帶 employees.company_id（多租戶）', attQ.chain.some(s => s === 'eq(employees.company_id,COMPANY-A)'));
  check('overtime_requests 查詢帶 employees.company_id（多租戶）', otQ.chain.some(s => s === 'eq(employees.company_id,COMPANY-A)'));
  check('只查到昨天為止（今天還沒過完，不該叫主管確認）', attQ.chain.some(s => s === 'lte(date,2026-08-05)'));
  check('回看 14 天（起日 2026-07-23）', attQ.chain.some(s => s === 'gte(date,2026-07-23)'));

  ctx.getCachedSetting = (k) => ({ default_work_end: '18:00' })[k];
  check('起算時間跟著 system_settings 走（18:00 → 18:30 起算）', ctx.otEstimateMinutes(20 * 60 + 30) === 120, ctx.otEstimateMinutes(20 * 60 + 30) + ' 分鐘');
  ctx.getCachedSetting = (k) => ({ default_work_end: '17:00' })[k];

  ctx.window.currentCompanyId = null;
  await ctx.loadOvertimeConfirm();
  check('無 company context 時卡片隱藏且不查詢', otCard.style.display === 'none');
  ctx.window.currentCompanyId = 'COMPANY-A';

  console.log('\n=== 10. 加班確認送出的防呆 ===');
  let toastMsg = '', rpcArgs = null;
  ctx.showToast = (m) => { toastMsg = m; };
  ctx.confirm = () => true;
  ctx.sb = makeSb({ attendance: ATT, overtime_requests: OTR });
  ctx.sb.rpc = async (name, args) => { rpcArgs = { name, args }; return { data: { success: true }, error: null }; };
  await ctx.loadOvertimeConfirm();

  const K1 = 'E1|2026-08-05', K2 = 'E2|2026-08-05';
  check('輸入框以 employeeId|date 為 id（非陣列索引，避免重載後錯位）', el('otMin_' + K1).id === 'otMin_' + K1);

  el('otMin_' + K1).value = '0';
  toastMsg = ''; rpcArgs = null;
  await ctx.submitOvertimeDecision(K1, 'confirm');
  check('0 分鐘被擋下且不送 RPC', toastMsg.includes('必須大於 0') && rpcArgs === null, toastMsg);

  el('otMin_' + K1).value = '800';
  toastMsg = ''; rpcArgs = null;
  await ctx.submitOvertimeDecision(K1, 'confirm');
  check('超過 720 分鐘被擋下且不送 RPC', toastMsg.includes('12 小時') && rpcArgs === null, toastMsg);

  el('otMin_' + K1).value = '180';
  toastMsg = ''; rpcArgs = null;
  await ctx.submitOvertimeDecision(K1, 'confirm');
  check('合法值送出 confirm_daily_overtime', rpcArgs && rpcArgs.name === 'confirm_daily_overtime');
  check('RPC 帶 company_id（多租戶）', rpcArgs && rpcArgs.args.p_company_id === 'COMPANY-A');
  check('RPC 帶 decision=confirm 與分鐘數', rpcArgs && rpcArgs.args.p_decision === 'confirm' && rpcArgs.args.p_minutes === 180);
  check('RPC 帶對的員工與日期', rpcArgs && rpcArgs.args.p_employee_id === 'E1' && rpcArgs.args.p_ot_date === '2026-08-05');

  toastMsg = ''; rpcArgs = null;
  await ctx.submitOvertimeDecision(K2, 'reject');
  check('不算加班送出 decision=reject 且分鐘為 0', rpcArgs && rpcArgs.args.p_decision === 'reject' && rpcArgs.args.p_minutes === 0);
  check('reject 也送對員工（不會因清單重載而錯位）', rpcArgs && rpcArgs.args.p_employee_id === 'E2', rpcArgs && rpcArgs.args.p_employee_id);

  toastMsg = ''; rpcArgs = null;
  await ctx.submitOvertimeDecision('NOT|EXIST', 'confirm');
  check('找不到該列時提示重新確認且不送 RPC', toastMsg.includes('清單已更新') && rpcArgs === null, toastMsg);

  ctx.confirm = () => false;
  rpcArgs = null;
  await ctx.submitOvertimeDecision(K1, 'confirm');
  check('確認對話框按取消不送 RPC', rpcArgs === null);

  console.log('\n═══════════════════════════════════════');
  console.log('  結果：✅ ' + pass + ' 通過  ❌ ' + fail + ' 失敗');
  console.log('═══════════════════════════════════════\n');
  process.exit(fail > 0 ? 1 : 0);
})();
