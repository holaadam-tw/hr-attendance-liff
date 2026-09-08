// 120 月統計請假天數小數化 ＋ 喪假假別 回歸測試（不連線、不寫 DB）
// 反向對照：MIGRATION120_FILE 環境變數可指向改壞的副本。
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const m120 = fs.readFileSync(process.env.MIGRATION120_FILE || path.join(root, 'migrations', '120_leave_numeric_days_and_bereavement.sql'), 'utf8');
const m120Code = m120.split('\n').filter(l => !/^\s*--/.test(l)).join('\n');
const read = f => fs.readFileSync(path.join(root, f), 'utf8');
const leaveSrc = read('modules/leave.js'), commonSrc = read('common.js'), auditSrc = read('modules/audit.js');
const publicSrc = read('attendance_public.html'), aoSrc = read('attendance_overview.html'), recordsSrc = read('records.html'), i18nSrc = read('i18n.js');

let pass = 0, fail = 0;
function check(name, condition, detail = '') {
  if (condition) { pass++; console.log(`  ✅ ${name}${detail ? `  → ${detail}` : ''}`); }
  else { fail++; console.log(`  ❌ ${name}${detail ? `  → ${detail}` : ''}`); }
}

console.log('\n=== migration 120：喪假假別 ===');
check('先卸舊約束再建新約束', /DROP CONSTRAINT IF EXISTS valid_leave_type/.test(m120Code) && /ADD CONSTRAINT valid_leave_type CHECK/.test(m120Code));
check('新約束含既有六種＋bereavement', /'annual', 'sick', 'personal', 'compensatory', 'maternity', 'marriage', 'bereavement'/.test(m120Code));

console.log('\n=== migration 120：月統計請假小數 ===');
check('改回傳型別前先 DROP FUNCTION', /DROP FUNCTION IF EXISTS public\.get_company_monthly_attendance\(uuid, integer, integer, text\)/.test(m120Code));
const dropIdx = m120Code.indexOf('DROP FUNCTION IF EXISTS public.get_company_monthly_attendance');
const createIdx = m120Code.indexOf('CREATE FUNCTION public.get_company_monthly_attendance(');
check('DROP 在 CREATE 之前、且不是 CREATE OR REPLACE', dropIdx > 0 && createIdx > dropIdx && !/CREATE OR REPLACE FUNCTION public\.get_company_monthly_attendance/.test(m120Code));
check('leave_days／absent_days 回 double precision（JSON 數字）', /leave_days double precision, absent_days double precision/.test(m120Code));
check('半天 0.5', /WHEN 'am' THEN 0\.5/.test(m120Code) && /WHEN 'pm' THEN 0\.5/.test(m120Code));
check('時數假 hours/8（優先用起訖時間）', /EXTRACT\(EPOCH FROM \(lr\.leave_end_time - lr\.leave_start_time\)\) \/ 3600\.0,\s*lr\.leave_hours, 0\) \/ 8\.0/.test(m120Code));
check('同一天多張假單上限 1', /SUM\(LEAST\(1\.0, x\.day_frac\)\)/.test(m120Code));
check('仍只算工作日（含假日排除）', /WHERE ed\.is_workday/.test(m120Code) && /is_company_holiday\(p_company_id, d::DATE\)/.test(m120Code));
check('仍只算 approved', /lr\.status = 'approved'/.test(m120Code));
check('缺勤欄同步小數且不為負', /GREATEST\(0, COALESCE\(exp\.days, 0\) - COALESCE\(act\.days, 0\) - COALESCE\(lv\.days, 0\)\)::double precision/.test(m120Code));
check('排班制（本米）缺勤仍回 NULL', /WHEN v_is_scheduled_payroll THEN NULL::double precision/.test(m120Code));
check('has_company_access 驗證保留', /has_company_access\(p_line_user_id, p_company_id, true\)/.test(m120Code));
check('GRANT anon/authenticated/service_role', /GRANT EXECUTE ON FUNCTION public\.get_company_monthly_attendance\(UUID, INTEGER, INTEGER, TEXT\) TO anon, authenticated, service_role/.test(m120Code));
check('欄位順序維持（前端依欄位名讀取）', /employee_id uuid, employee_name text, department text, "position" text, expected_days integer, actual_days integer, late_days integer, early_leave_days integer, leave_days double precision, absent_days double precision, total_work_hours numeric/.test(m120Code));

console.log('\n=== 前端喪假標籤 ===');
check('leave.js 兩處 typeMap 含喪假', (leaveSrc.match(/bereavement: '喪假'|'bereavement': '喪假'/g) || []).length === 2);
check('common.js typeNames 含喪假', /bereavement:'喪假'/.test(commonSrc));
check('audit.js 報表含喪假', /bereavement: '喪假'/.test(auditSrc));
check('attendance_public 含喪假', /bereavement:'喪假'/.test(publicSrc));
check('attendance_overview 含喪假', /bereavement:'喪假'/.test(aoSrc));
check('records.html 請假頁可選喪假', /<option value="bereavement" data-i18n="leaveBereavement">喪假<\/option>/.test(recordsSrc));
check('i18n zh／vi 都有 leaveBereavement', /leaveBereavement: '喪假'/.test(i18nSrc) && /leaveBereavement: 'Nghỉ tang'/.test(i18nSrc));

console.log('\n=== 前端加總對小數安全 ===');
check('attendance_overview 請假加總不做字串拼接（欄位為數字）', /totLeave \+= r\.leave_days;/.test(aoSrc));

console.log(`\n結果：${pass} 通過 / ${fail} 失敗`);
process.exit(fail > 0 ? 1 : 0);
