// 123 遲到／早退以分為單位（秒數捨去） 回歸測試（不連線、不寫 DB）
// 反向對照：MIGRATION123_FILE 環境變數可指向改壞的副本。
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const m123 = fs.readFileSync(process.env.MIGRATION123_FILE || path.join(root, 'migrations', '123_late_early_minute_granularity.sql'), 'utf8');
const code = m123.split('\n').filter(l => !/^\s*--/.test(l)).join('\n');

let pass = 0, fail = 0;
function check(name, condition, detail = '') {
  if (condition) { pass++; console.log(`  ✅ ${name}${detail ? `  → ${detail}` : ''}`); }
  else { fail++; console.log(`  ❌ ${name}${detail ? `  → ${detail}` : ''}`); }
}

console.log('\n=== quick_check_in 秒數捨去 ===');
check('v_tw_time 以 date_trunc minute 重設', /v_tw_time := date_trunc\('minute', \(now\(\) AT TIME ZONE 'Asia\/Taipei'\)\)::time;/.test(code));
const iTrunc = code.indexOf("v_tw_time := date_trunc('minute'");
const iLate = code.indexOf("v_tw_time > (v_shift_start + (v_late_threshold || ' minutes')::interval)");
const iEarly = code.indexOf("v_tw_time < (v_shift_end - (v_early_threshold || ' minutes')::interval)");
check('捨秒在遲到判定之前', iTrunc > 0 && iLate > iTrunc);
check('捨秒在早退判定之前', iTrunc > 0 && iEarly > iTrunc);
check('遲到判定仍是「> 班表開始＋容忍」（08:01 起）', iLate > 0);
check('122 的早退規則（無 2 小時窗口）保留', !/interval '2 hours'/.test(code) && iEarly > 0);
check('免打卡／公務機／GPS 防呆保留', /employee_no_checkin/.test(code) && /kiosk_employee_must_use_kiosk/.test(code) && /outside_allowed_location/.test(code));
check('GRANT 維持', /GRANT EXECUTE ON FUNCTION public\.quick_check_in\(TEXT, DOUBLE PRECISION, DOUBLE PRECISION, TEXT, TEXT, TEXT\) TO anon, authenticated, service_role/.test(code));

console.log('\n=== 回填 ===');
const bf = code.slice(code.indexOf('UPDATE public.attendance a'));
check('限大正、2026-09-09 起（容忍改 0 之後）', /company_id = '8a669e2c-7521-43e9-9300-5c004c57e9db'::uuid/.test(bf) && /a\.date >= DATE '2026-09-09'/.test(bf));
check('只清缺時計算為 0 分的（FLOOR 分鐘＝事實不遲到）', /late_minutes'\)::INTEGER, -1\) = 0/.test(bf));
check('補登上班卡不在此回填（121 已處理）', /NOT public\.is_makeup_location\(a\.check_in_location\)/.test(bf));
check('只改旗標', /SET is_late = false, updated_at = now\(\)/.test(bf) && !/SET check_in_time/.test(bf));

// 用 JS 模擬同一規則，確認語意：分鐘捨去後與 08:00 比較
console.log('\n=== 規則語意 ===');
const isLate = (hhmmss, tol = 0) => { const [h, m] = hhmmss.split(':').map(Number); return h * 60 + m > 8 * 60 + tol; };
check('08:00:04 不遲到', !isLate('08:00:04'));
check('08:00:59 不遲到', !isLate('08:00:59'));
check('08:01:00 遲到', isLate('08:01:00'));
check('07:59:59 不遲到', !isLate('07:59:59'));

console.log(`\n結果：${pass} 通過 / ${fail} 失敗`);
process.exit(fail > 0 ? 1 : 0);
