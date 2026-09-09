// 121 補登的打卡不算遲到／早退 回歸測試（不連線、不寫 DB）
// 反向對照：MIGRATION121_FILE 環境變數可指向改壞的副本。
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const m121 = fs.readFileSync(process.env.MIGRATION121_FILE || path.join(root, 'migrations', '121_makeup_punch_not_late.sql'), 'utf8');
const code = m121.split('\n').filter(l => !/^\s*--/.test(l)).join('\n');

let pass = 0, fail = 0;
function check(name, condition, detail = '') {
  if (condition) { pass++; console.log(`  ✅ ${name}${detail ? `  → ${detail}` : ''}`); }
  else { fail++; console.log(`  ❌ ${name}${detail ? `  → ${detail}` : ''}`); }
}
function fn(name) {
  const re = new RegExp('CREATE OR REPLACE FUNCTION public\\.' + name + '\\([\\s\\S]*?\\n\\$(?:\\$|function\\$);', 'm');
  const m = code.match(re);
  return m ? m[0] : '';
}

console.log('\n=== A. is_makeup_location ===');
const im = fn('is_makeup_location');
check('三種補登標記', /IN \('makeup punch', 'admin makeup', '補打卡'\)/.test(im));
check('NULL 視為非補登（COALESCE）', /COALESCE\(p_location, ''\)/.test(im));
check('REVOKE anon', /REVOKE ALL ON FUNCTION public\.is_makeup_location\(TEXT\) FROM PUBLIC, anon, authenticated/.test(code));

console.log('\n=== B. calculate_missing_work_hours 側別歸零 ===');
const calc = fn('calculate_missing_work_hours');
check('上班側補登 → 遲到 0', /IF public\.is_makeup_location\(v_attendance\.check_in_location\) THEN v_late_minutes := 0; END IF;/.test(calc));
check('下班側補登 → 早退 0', /IF public\.is_makeup_location\(v_attendance\.check_out_location\) THEN v_early_minutes := 0; END IF;/.test(calc));
const iLateCalc = calc.indexOf('IF v_late_raw > v_late_tolerance'), iLateZero = calc.indexOf('v_late_minutes := 0; END IF;'), iSum = calc.indexOf('v_missing_minutes := v_late_minutes + v_early_minutes;');
check('歸零在容忍判斷之後、加總之前', iLateCalc > 0 && iLateZero > iLateCalc && iSum > iLateZero);
check('假日／請假邏輯保留', /company_holiday/.test(calc) && /covered_by_full_day_leave/.test(calc));
check('權限維持 service_role', /GRANT EXECUTE ON FUNCTION public\.calculate_missing_work_hours\(UUID, DATE\) TO service_role/.test(code));

console.log('\n=== C. 月統計次數排除補登側 ===');
const mo = fn('get_company_monthly_attendance');
check('遲到次排除補登上班卡', /a2\.is_late = true\s+AND NOT public\.is_makeup_location\(a2\.check_in_location\)\) AS late_days/.test(mo));
check('早退次排除補登下班卡', /a2\.is_early_leave = true\s+AND NOT public\.is_makeup_location\(a2\.check_out_location\)\) AS early_leave_days/.test(mo));
check('120 的小數請假邏輯保留', /SUM\(LEAST\(1\.0, x\.day_frac\)\)/.test(mo) && /leave_days double precision/.test(mo));
check('has_company_access 保留', /has_company_access\(p_line_user_id, p_company_id, true\)/.test(mo));

console.log('\n=== D. 補登 RPC 清旗標 ===');
const adm = fn('admin_makeup_punch');
check('管理員補上班卡清 is_late', /check_in_location = 'admin makeup',\s*is_manual = true,\s*is_late = false/.test(adm));
check('管理員補下班卡清 is_early_leave', /check_out_location = 'admin makeup',\s*is_manual = true,\s*is_early_leave = false/.test(adm));
check('管理員補登仍驗身分（092 模式）', /需要管理員權限/.test(adm) && /e\.role IN \('admin', 'manager'\)/.test(adm));
const apr = fn('approve_makeup_request');
check('員工補卡核准清 is_late', /check_in_location = 'makeup punch',\s*is_manual = true,\s*is_late = false/.test(apr));
check('員工補卡核准清 is_early_leave', /check_out_location = 'makeup punch',\s*is_manual = true,\s*is_early_leave = false/.test(apr));
check('不會誤清另一側（上班補登不動 is_early_leave）', !/check_in_location = 'admin makeup',[\s\S]{0,120}is_early_leave = false/.test(adm) && !/check_in_location = 'makeup punch',[\s\S]{0,120}is_early_leave = false/.test(apr));

console.log('\n=== E. 資料修正 ===');
check('清遲到只針對補登上班側', /SET is_late = false[\s\S]*?WHERE a\.is_late = true\s+AND public\.is_makeup_location\(a\.check_in_location\)/.test(code));
check('清早退只針對補登下班側', /SET is_early_leave = false[\s\S]*?WHERE a\.is_early_leave = true\s+AND public\.is_makeup_location\(a\.check_out_location\)/.test(code));
check('不動打卡時間本身', !/SET check_in_time/.test(code.slice(code.indexOf('===== E.'))) );

console.log(`\n結果：${pass} 通過 / ${fail} 失敗`);
process.exit(fail > 0 ? 1 : 0);
