#!/usr/bin/env node
// 公開出勤頁請假月曆回歸測試：從 attendance_public.html 原樣抽取函式執行。

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { JSDOM } = require('jsdom');

const ROOT = path.resolve(__dirname, '..');
const TARGET = process.env.AP_FILE || path.join(ROOT, 'attendance_public.html');
let source = fs.readFileSync(TARGET, 'utf8');
if (process.env.AP_MUTATION === 'draw-rest-days') {
  const original = "const shouldDraw = period !== 'full_day' || !excludeRestDays || !isRestDay(ds, d);";
  if (!source.includes(original)) throw new Error('找不到反向對照 mutation 目標');
  source = source.replace(original, 'const shouldDraw = true;');
}

function grabFunction(name) {
  const start = source.indexOf('function ' + name + '(');
  if (start < 0) throw new Error('attendance_public.html 找不到函式：' + name);
  let depth = 0;
  let started = false;
  for (let i = start; i < source.length; i++) {
    if (source[i] === '{') { depth++; started = true; }
    if (source[i] === '}' && started && --depth === 0) return source.slice(start, i + 1);
  }
  throw new Error('函式括號不對稱：' + name);
}

function grabConst(name) {
  const start = source.indexOf('const ' + name + ' =');
  const end = source.indexOf(';', start);
  if (start < 0 || end < 0) throw new Error('attendance_public.html 找不到常數：' + name);
  return source.slice(start, end + 1);
}

const dom = new JSDOM(`<!doctype html><body>
  <div id="leaveCalTitle"></div><div id="leaveCalLegend"></div>
  <div id="leaveCalSummary"></div><div id="leaveCalGrid"></div>
</body>`);
const translations = {
  leaveCalTitle: '請假月曆', dayUnit: '天', pendingShort: '待審', approvedShort: '核准',
  halfAmShort: '上', halfPmShort: '下',
  leaveCalEmpty: '本月無請假', leaveCalHint: '含待審', calendarHeaders: ['一', '二', '三', '四', '五', '六', '日'],
};
const context = {
  console, Date, Math, Number, String, Array, Object, Set, Map,
  document: dom.window.document,
  t: (key, vars) => key === 'leaveCalCount' ? `${vars.n} 位員工` : translations[key],
  esc: value => String(value ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;'),
  getTaiwanDate: () => '2026-11-19',
  isHiddenEmployeeName: () => false,
  leaveTypeLabel: type => type || '',
  leavePeriodLabel: period => period || 'full_day',
};
context.globalThis = context;
vm.createContext(context);
vm.runInContext([
  'let mYear = 2026, mMonth = 10, monthLeaveData = [], currentWeekendPolicy = "fixed", monthHolidayMap = {};',
  grabConst('LEAVE_COLOR_PALETTE'),
  ...['getMonthRange', 'leaveEmployeeName', 'leaveChipTitle', 'renderLeaveCalendar', 'parseLocalDate', 'addDays', 'fmtDate'].map(grabFunction),
  'globalThis.setCalendarState = value => { monthLeaveData = value.rows; currentWeekendPolicy = value.weekendPolicy || "fixed"; monthHolidayMap = value.holidays || {}; };',
  'globalThis.renderCalendar = renderLeaveCalendar;',
].join('\n'), context);

let pass = 0;
let fail = 0;
function check(name, condition, actual = '') {
  if (condition) { pass++; console.log('  ✅ ' + name); }
  else { fail++; console.log('  ❌ ' + name + (actual ? ' → ' + actual : '')); }
}
const full = (name, start, end, days, extra = {}) => ({ employee_name: name, start_date: start, end_date: end, days, leave_period: 'full_day', leave_type: 'annual', status: 'approved', ...extra });
const partial = (name, date, period, days, extra = {}) => ({ employee_name: name, start_date: date, end_date: date, days, leave_period: period, leave_type: 'annual', status: 'approved', ...extra });

const rows = [
  full('林駿璋', '2026-11-19', '2026-11-23', 3),
  partial('林駿璋', '2026-11-06', 'hourly', 0.1),
  partial('林駿璋', '2026-11-12', 'hourly', 0.3, { status: 'pending' }),
  partial('林駿璋', '2026-11-18', 'hourly', 0.1),
  full('豐豪', '2026-11-05', '2026-11-10', 4),
  full('李銘坤', '2026-11-12', '2026-11-20', 7),
  partial('宗元', '2026-11-26', 'am', 0.5),
  full('週末排班者', '2026-11-21', '2026-11-22', 2),
  full('國定假日者', '2026-11-24', '2026-11-26', 2),
  full('跨月者', '2026-10-30', '2026-11-03', 3),
];
context.setCalendarState({ rows, holidays: { '2026-11-25': '公司假日' } });
context.renderCalendar();

const dayElement = day => [...dom.window.document.querySelectorAll('.leave-cal-day')]
  .find(el => el.querySelector('.leave-cal-daynum')?.textContent === String(day));
const namesOn = day => [...dayElement(day).querySelectorAll('.leave-chip')].map(el => el.textContent);
const legend = () => dom.window.document.getElementById('leaveCalLegend').textContent;

console.log('\n=== 公開出勤頁請假月曆 ===');
check('林駿璋工作日 19、20、23 有畫', [19, 20, 23].every(day => namesOn(day).includes('林駿璋')));
check('林駿璋週末 21、22 不畫', [21, 22].every(day => !namesOn(day).includes('林駿璋')));
check('林駿璋圖例採實際扣假 3.5 天（含 pending）', legend().includes('林駿璋 · 3.5天'), legend());
check('豐豪週末 7、8 不畫且圖例 4 天', [7, 8].every(day => !namesOn(day).includes('豐豪')) && legend().includes('豐豪 · 4天'), legend());
check('李銘坤週末 14、15 不畫且圖例 7 天', [14, 15].every(day => !namesOn(day).includes('李銘坤')) && legend().includes('李銘坤 · 7天'), legend());
check('宗元 26 日上午照畫且圖例 0.5 天', namesOn(26).includes('宗元·上') && legend().includes('宗元 · 0.5天'), legend());
check('days 等於日曆天時保守退回：週末兩天都畫', [21, 22].every(day => namesOn(day).includes('週末排班者')) && legend().includes('週末排班者 · 2天'), legend());
check('平日公司假日已由 days 扣除時不畫', !namesOn(25).includes('國定假日者') && [24, 26].every(day => namesOn(day).includes('國定假日者')));
check('跨月假單只計本月畫出的 2 格', [2, 3].every(day => namesOn(day).includes('跨月者')) && legend().includes('跨月者 · 2天'), legend());
check('leave chip title 保留原 days 與狀態資訊', dayElement(19).querySelector('.leave-chip[title*="3天"]') !== null);

context.setCalendarState({ rows: [full('週末工作公司', '2026-11-21', '2026-11-22', 2)], weekendPolicy: 'working' });
context.renderCalendar();
check('currentWeekendPolicy=working 時六日不算休假日', [21, 22].every(day => namesOn(day).includes('週末工作公司')) && legend().includes('週末工作公司 · 2天'));

context.setCalendarState({ rows: [full('天數缺值者', '2026-11-21', '2026-11-22', null)] });
context.renderCalendar();
check('full_day 的 days=null 時保守退回全部畫', [21, 22].every(day => namesOn(day).includes('天數缺值者')) && legend().includes('天數缺值者 · 2天'));

console.log(`\n結果：✅ ${pass} 通過  ❌ ${fail} 失敗\n`);
process.exit(fail ? 1 : 0);
