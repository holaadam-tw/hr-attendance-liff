// 122 早退判定不限下班前 2 小時 ＋ 月統計遲到／早退次數改以缺工計算為準 回歸測試（不連線、不寫 DB）
// 反向對照：MIGRATION122_FILE / AO_FILE 環境變數可指向改壞的副本。
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const m122 = fs.readFileSync(process.env.MIGRATION122_FILE || path.join(root, 'migrations', '122_early_leave_any_time_before_shift_end.sql'), 'utf8');
const code = m122.split('\n').filter(l => !/^\s*--/.test(l)).join('\n');
const aoSrc = fs.readFileSync(process.env.AO_FILE || path.join(root, 'attendance_overview.html'), 'utf8');

let pass = 0, fail = 0;
function check(name, condition, detail = '') {
  if (condition) { pass++; console.log(`  ✅ ${name}${detail ? `  → ${detail}` : ''}`); }
  else { fail++; console.log(`  ❌ ${name}${detail ? `  → ${detail}` : ''}`); }
}
function grab(source, name) {
  const start = source.indexOf('function ' + name + '(');
  if (start < 0) throw new Error('找不到函式：' + name);
  let depth = 0, opened = false;
  for (let i = start; i < source.length; i++) {
    if (source[i] === '{') { depth++; opened = true; }
    if (source[i] === '}' && --depth === 0 && opened) return source.slice(start, i + 1);
  }
  throw new Error('函式括號不完整：' + name);
}

console.log('\n=== migration 122：quick_check_in 早退判定 ===');
check('不再有 2 小時窗口', !/interval '2 hours'/.test(code));
check('一般班：比下班時間（扣容忍）早就算早退', /IF v_tw_time < \(v_shift_end - \(v_early_threshold \|\| ' minutes'\)::interval\) THEN\s+v_is_early_leave := true;/.test(code));
check('跨日班分支保留', /IF v_is_overnight THEN[\s\S]*?v_tw_time < v_shift_end[\s\S]*?v_is_early_leave := true;/.test(code));
check('遲到判定未被動到', /v_tw_time > \(v_shift_start \+ \(v_late_threshold \|\| ' minutes'\)::interval\)/.test(code));
check('免打卡／公務機防呆保留', /employee_no_checkin/.test(code) && /kiosk_employee_must_use_kiosk/.test(code));
check('GRANT anon/authenticated 維持', /GRANT EXECUTE ON FUNCTION public\.quick_check_in\(TEXT, DOUBLE PRECISION, DOUBLE PRECISION, TEXT, TEXT, TEXT\) TO anon, authenticated, service_role/.test(code));

console.log('\n=== migration 122：回填 ===');
const bf = code.slice(code.indexOf('UPDATE public.attendance a'));
check('只回填大正、2026-06-01 起', /e\.company_id = '8a669e2c-7521-43e9-9300-5c004c57e9db'::uuid/.test(bf) && /a\.date >= DATE '2026-06-01'/.test(bf));
check('只針對完整上下班卡', /a\.check_in_time IS NOT NULL\s+AND a\.check_out_time IS NOT NULL/.test(bf));
check('補登下班卡不回填（對齊 121）', /NOT public\.is_makeup_location\(a\.check_out_location\)/.test(bf));
check('以缺工計算的早退分鐘為準（已扣請假）', /calculate_missing_work_hours\(a\.employee_id, a\.date\) ->> 'early_minutes'\)::INTEGER, 0\) > 0/.test(bf));
check('只改旗標不改時間', /SET is_early_leave = true, updated_at = now\(\)/.test(bf) && !/SET check_out_time/.test(bf));

console.log('\n=== attendance_overview 月統計次數來源 ===');
let lc = null, ec = null, bm = null;
try {
  lc = new Function(`${grab(aoSrc, 'monthlyLateCount')}; return monthlyLateCount;`)();
  ec = new Function(`${grab(aoSrc, 'monthlyEarlyCount')}; return monthlyEarlyCount;`)();
  bm = new Function(`${grab(aoSrc, 'buildMonthlyMissingMap')}; return buildMonthlyMissingMap;`)();
} catch (e) { check('抽得出輔助函式', false, e.message); }
if (lc && ec && bm) {
  const r = { late_days: 21, early_leave_days: 0 };
  check('有缺工計算 → 用 early_count（中午走人算早退）', ec(r, { early_count: 2 }) === 2);
  check('有缺工計算 → 用 late_count（請假／補登已扣）', lc(r, { late_count: 19 }) === 19);
  check('缺工計算失敗 → 退回打卡旗標', lc(r, undefined) === 21 && ec(r, null) === 0);
  const map = bm([{ employee_id: 'x', late_count: '3', early_count: null, late_minutes: 40, early_minutes: 0, missing_minutes: 40, full_absence_days: 0 }]);
  check('map 帶入 late_count／early_count', map.x.late_count === 3 && map.x.early_count === 0);
}
check('列與合計都用新的次數', /totLate \+= lateCnt;/.test(aoSrc) && /totEarly \+= earlyCnt;/.test(aoSrc) && /\+ lateCnt \+ '<\/td>'/.test(aoSrc) && /\+ earlyCnt \+ '<\/td>'/.test(aoSrc));
check('匯出用新的次數', /'遲到': monthlyLateCount\(r, monthlyMissingMap\[r\.employee_id\]\)/.test(aoSrc) && /'早退': monthlyEarlyCount\(r, monthlyMissingMap\[r\.employee_id\]\)/.test(aoSrc));
check('不再直接輸出 r.late_days 到欄位', !/\+ r\.late_days \+ '<\/td>'/.test(aoSrc) && !/\+ r\.early_leave_days \+ '<\/td>'/.test(aoSrc));

console.log(`\n結果：${pass} 通過 / ${fail} 失敗`);
process.exit(fail > 0 ? 1 : 0);
