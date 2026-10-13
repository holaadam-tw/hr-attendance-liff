// ============================================================
// 149-B 管理端 leave_requests 讀取 RPC 測試
//
// 靜態驗證指定 8 個讀取點不再直查 leave_requests，且每個 RPC 都帶
// company_id 與管理員 LINE ID。薪資兩處則抽取 modules/payroll.js 的
// 真實計算區塊執行，證明 RPC 回傳同形狀資料後，請假天數結果不變。
// ============================================================

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8');
const files = {
  'attendance_overview.html': read('attendance_overview.html'),
  'modules/audit.js': read('modules/audit.js'),
  'modules/leave.js': read('modules/leave.js'),
  'modules/payroll.js': read('modules/payroll.js'),
  'modules/schedules.js': read('modules/schedules.js')
};

let pass = 0, fail = 0;
function check(name, condition, extra = '') {
  if (condition) { pass++; console.log(`  ✅ ${name}${extra ? `  → ${extra}` : ''}`); }
  else { fail++; console.log(`  ❌ ${name}${extra ? `  → ${extra}` : ''}`); }
}

function callWindows(source, needle, size = 700) {
  const windows = [];
  let at = -1;
  while ((at = source.indexOf(needle, at + 1)) !== -1) windows.push(source.slice(at, at + size));
  return windows;
}

function between(source, start, end) {
  const from = source.indexOf(start);
  if (from < 0) throw new Error(`找不到區塊起點：${start}`);
  const to = source.indexOf(end, from + start.length);
  if (to < 0) throw new Error(`找不到區塊終點：${end}`);
  return source.slice(from, to);
}

console.log('\n═══════════════════════════════════════');
console.log('  149-B 管理端請假讀取 RPC 測試');
console.log('═══════════════════════════════════════');

console.log('\n=== 1. 指定 8 處不再直接讀 leave_requests ===');
Object.entries(files).forEach(([name, source]) => {
  check(`${name} 無 from('leave_requests')`, !source.includes("from('leave_requests')"));
});

const rpcNeedle = "sb.rpc('get_company_leave_requests'";
const allCalls = Object.entries(files).flatMap(([name, source]) =>
  callWindows(source, rpcNeedle).map(code => ({ name, code }))
);
check('管理端恰有 8 個 get_company_leave_requests 呼叫', allCalls.length === 8, `實得 ${allCalls.length}`);
allCalls.forEach(({ name, code }, index) => {
  check(`#${index + 1} ${name} 帶 p_company_id`, code.includes('p_company_id: window.currentCompanyId'));
  check(`#${index + 1} ${name} 帶 p_line_user_id`, code.includes('p_line_user_id:'));
  check(`#${index + 1} ${name} 明確限制 p_limit`, code.includes('p_limit:'));
});

check('反向對照：還原任一直接查表會被靜態規則抓到',
  files['modules/payroll.js'].replace(rpcNeedle, "sb.from('leave_requests')").includes("from('leave_requests')"));

console.log('\n=== 2. RPC 欄位形狀與錯誤處理 ===');
const migration = read('migrations/149_leave_requests_read_rpcs.sql');
['days NUMERIC', 'leave_period TEXT', 'leave_hours NUMERIC', 'employees JSONB', "'name', e.name", "'employee_number', e.employee_number", "'department', e.department", "'company_id', e.company_id"]
  .forEach(field => check(`149-A 契約保留 ${field}`, migration.includes(field)));

const audit = files['modules/audit.js'];
const payroll = files['modules/payroll.js'];
check('薪資彙總報表請假 RPC 失敗會中止匯出', /if \(lvRes\.error\) throw lvRes\.error/.test(audit));
check('請假 CSV RPC 失敗會中止匯出', /if \(error\) throw error;[\s\S]{0,300}const tm =/.test(audit));
check('年度獎金請假 RPC 失敗會中止載入', /loadHybridBonusData[\s\S]*?if \(leaveRes\.error\) throw leaveRes\.error/.test(payroll));
check('月薪資請假 RPC 失敗會中止計算', /loadPayrollData[\s\S]*?if \(leaveRes\.error\) throw leaveRes\.error/.test(payroll));

console.log('\n=== 3. 薪資兩處請假天數行為（抽取真實程式碼） ===');
const calcSource = between(payroll, 'function calcLeaveOverlapDays', 'export function clearPayrollState');
const calcLeaveOverlapDays = new Function(`${calcSource}; return calcLeaveOverlapDays;`)();

const annualFunction = between(payroll, 'export async function loadHybridBonusData()', 'function calculateBonus');
const annualBlock = between(annualFunction, '        const leaveMap = {};', '        const yearEnd');
const runAnnual = (block, leaveRes, year) => new Function(
  'leaveRes', 'calcLeaveOverlapDays', 'year', `${block}\nreturn leaveMap;`
)(leaveRes, calcLeaveOverlapDays, year);

const annualRows = { data: [
  { employee_id: 'E1', start_date: '2025-12-30', end_date: '2026-01-03', days: 5 },
  { employee_id: 'E1', start_date: '2026-06-15', end_date: '2026-06-15', days: 0.5 },
  { employee_id: 'E2', start_date: '2026-12-31', end_date: '2027-01-02', days: 3 }
] };
const annualResult = runAnnual(annualBlock, annualRows, 2026);
check('年度獎金：跨年按重疊比例＋半天維持 3.5 天', Math.abs(annualResult.E1 - 3.5) < 1e-9, String(annualResult.E1));
check('年度獎金：年底跨年 3 天假只計當年 1 天', Math.abs(annualResult.E2 - 1) < 1e-9, String(annualResult.E2));

const monthlyFunction = between(payroll, 'export async function loadPayrollData()', 'function prLookupBracket');
const monthlyBlock = between(monthlyFunction, '        const leaveMap = {};', '        // 同上：不分 source_type');
const runMonthly = (block, leaveRes, startDate, endDate) => new Function(
  'leaveRes', 'calcLeaveOverlapDays', 'startDate', 'endDate', `${block}\nreturn leaveMap;`
)(leaveRes, calcLeaveOverlapDays, startDate, endDate);

const monthlyRows = { data: [
  { employee_id: 'E1', leave_type: 'personal', start_date: '2026-02-28', end_date: '2026-03-02', days: 3 },
  { employee_id: 'E1', leave_type: 'annual', start_date: '2026-03-10', end_date: '2026-03-10', days: 0.5 },
  { employee_id: 'E2', leave_type: 'sick', start_date: '2026-03-31', end_date: '2026-03-31', days: 1 }
] };
const monthlyResult = runMonthly(monthlyBlock, monthlyRows, '2026-03-01', '2026-03-31');
check('月薪資：跨月事假 2 天＋特休半天＝總請假 2.5 天', Math.abs(monthlyResult.E1.total - 2.5) < 1e-9, JSON.stringify(monthlyResult.E1));
check('月薪資：只有 personal 累加到扣薪用 personal 2 天', Math.abs(monthlyResult.E1.personal - 2) < 1e-9, JSON.stringify(monthlyResult.E1));
check('月薪資：病假計總請假但不計 personal', monthlyResult.E2.total === 1 && monthlyResult.E2.personal === 0, JSON.stringify(monthlyResult.E2));

const brokenAnnual = annualBlock.replace(
  'leaveMap[l.employee_id] += calcLeaveOverlapDays',
  'leaveMap[l.employee_id] += 0 * calcLeaveOverlapDays'
);
const brokenMonthly = monthlyBlock.replace(
  'const overlapDays = calcLeaveOverlapDays(l, startDate, endDate);',
  'const overlapDays = 0;'
);
check('反向對照：破壞年度請假累加會偏離既有 3.5 天', runAnnual(brokenAnnual, annualRows, 2026).E1 !== 3.5);
check('反向對照：破壞月薪資重疊天數會偏離既有 2.5 天', runMonthly(brokenMonthly, monthlyRows, '2026-03-01', '2026-03-31').E1.total !== 2.5);

console.log(`\n  結果：${pass} 通過，${fail} 失敗`);
if (fail > 0) process.exit(1);
