// ============================================================
// 薪資頁加班時數來源測試
//
// 測的是「真實檔案裡的真實程式碼」：把 modules/payroll.js 的兩處 otMap
// 區塊原樣抽出來執行，不另抄一份被測邏輯。
//
// 執行：npm run test:payroll-ot（或 npm test 一併跑）
//
// 為什麼要有這支：
//   modules/payroll.js 原本兩處都有
//     if ((o.source_type || 'manual') === 'late_close_auto') return;
//   把系統來源的加班排除在薪資之外。migration 108 之後 late_close_auto 是
//   主管在打卡總覽逐筆確認的結果，業主 2026-08-05 指示一併計入，該排除已
//   拿掉。這支測試防止它被改回去，也防止有人反過來把 pending/rejected 也算進去。
//
// 注意：查詢端本來就 filter status='approved'，所以這裡不測狀態過濾；
//       otMap 是 calcEmployeePayroll 加班時數的唯一來源（本頁沒有另一條
//       從 attendance 推估加班的路），所以不會重複計算。
// ============================================================

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
// PAYROLL_FILE 供反向對照用（指向刻意改壞的副本，驗證測試真的擋得住）
const SRC = process.env.PAYROLL_FILE || path.join(ROOT, 'modules', 'payroll.js');
const lines = fs.readFileSync(SRC, 'utf8').split('\n');

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  ✅ ' + name + (extra ? '  → ' + extra : '')); }
  else { fail++; console.log('  ❌ ' + name + (extra ? '  → ' + extra : '')); }
}

console.log('\n═══════════════════════════════════════');
console.log('  薪資頁加班時數來源測試');
console.log('═══════════════════════════════════════');

console.log('\n=== 1. 抽出真實程式碼 ===');
const starts = [];
lines.forEach((l, i) => { if (l.trim() === 'const otMap = {};') starts.push(i); });
check('modules/payroll.js 內找到 2 處 otMap 區塊', starts.length === 2, '實得 ' + starts.length);
if (starts.length !== 2) { console.log('\n  結果：❌ 抽取失敗，無法繼續'); process.exit(1); }

const blocks = starts.map(s => {
  const end = lines.findIndex((l, i) => i > s && l.trim() === '});');
  return lines.slice(s, end + 1).join('\n');
});
const build = blocks.map(b => new Function('otRes', b + '\nreturn otMap;'));
check('兩處區塊都可執行', typeof build[0] === 'function' && typeof build[1] === 'function');

console.log('\n=== 2. 加班時數加總（各來源都要算） ===');
const otRes = { data: [
  { employee_id: 'E1', source_type: 'late_close_auto', status: 'approved', final_hours: 3.0 },  // 主管確認
  { employee_id: 'E1', source_type: 'manual', status: 'approved', final_hours: 2.0 },           // 員工自送
  { employee_id: 'E2', source_type: 'late_close_auto', status: 'approved', final_hours: 1.5 },
  { employee_id: 'E3', source_type: undefined, status: 'approved', hours: 4.0 },                // 舊資料無 source_type
] };
[['薪資頁主表', build[0]], ['薪資頁明細', build[1]]].forEach(([label, fn]) => {
  const m = fn(otRes);
  check(label + '：E1 = 主管確認 3.0 + 員工申請 2.0 = 5.0', Math.abs(m.E1 - 5.0) < 1e-9, m.E1);
  check(label + '：E2 只有主管確認 1.5（拿掉排除前會是 0）', Math.abs(m.E2 - 1.5) < 1e-9, m.E2);
  check(label + '：E3 無 source_type 的舊資料仍照算 4.0', Math.abs(m.E3 - 4.0) < 1e-9, m.E3);
});

console.log('\n=== 3. 防止 late_close_auto 排除被改回去 ===');
const src = fs.readFileSync(SRC, 'utf8');
check('modules/payroll.js 不得再出現 late_close_auto 的 early return',
  !/=== *'late_close_auto'\) *return/.test(src));
check('欄位優先序仍為 final_hours → approved_hours → …（核認後時數優先）',
  blocks.every(b => b.includes('final_hours ?? ') && b.indexOf('final_hours') < b.indexOf('hours ?? 0')));

console.log('\n=== 4. 欄位缺漏時的退讓 ===');
[['只有 approved_hours', { approved_hours: 2.5 }, 2.5],
 ['只有 actual_hours', { actual_hours: 1.25 }, 1.25],
 ['只有 planned_hours', { planned_hours: 3.5 }, 3.5],
 ['只有 hours', { hours: 0.75 }, 0.75],
 ['全部缺 → 0', {}, 0]].forEach(([label, extra, want]) => {
  const row = Object.assign({ employee_id: 'X', source_type: 'late_close_auto', status: 'approved' }, extra);
  const m = build[0]({ data: [row] });
  check(label + ' → ' + want, Math.abs((m.X || 0) - want) < 1e-9, String(m.X));
});

console.log('\n═══════════════════════════════════════');
console.log('  結果：✅ ' + pass + ' 通過  ❌ ' + fail + ' 失敗');
console.log('═══════════════════════════════════════\n');
process.exit(fail > 0 ? 1 : 0);
