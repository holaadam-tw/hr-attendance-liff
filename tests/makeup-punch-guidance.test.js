// 補打卡日期導引與 17:00 預設值回歸測試
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const recordsSrc = fs.readFileSync(path.join(root, 'records.html'), 'utf8');
const commonSrc = fs.readFileSync(path.join(root, 'common.js'), 'utf8');
const migration116Src = fs.readFileSync(path.join(root, 'migrations', '116_include_no_checkin_partial_attendance.sql'), 'utf8');
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

const incompleteCode = grab(recordsSrc, 'getIncompletePunchStatus');
const conflictCode = [
  grab(recordsSrc, 'timeToMinutes'),
  grab(recordsSrc, 'formatAttendanceTime'),
  grab(recordsSrc, 'getMakeupPunchConflict')
].join('\n');

function incomplete(date, att, today = '2026-08-15') {
  return new Function('date', 'att', 'today', `${incompleteCode}; return getIncompletePunchStatus(date, att, today);`)(date, att, today);
}

function conflict(attendance, date, type, time) {
  return new Function('attendance', 'date', 'type', 'time', `
    const attData = attendance;
    ${conflictCode}
    return getMakeupPunchConflict(date, type, time);
  `)(attendance, date, type, time);
}

console.log('\n═══════════════════════════════════════');
console.log('  補打卡日期導引回歸測試');
console.log('═══════════════════════════════════════');

check('過去日期只有上班卡判定缺下班', incomplete('2026-08-10', {
  check_in_time: '2026-08-10T11:52:00Z', check_out_time: null
}) === 'missing_out');
check('過去日期只有下班卡判定缺上班', incomplete('2026-08-10', {
  check_in_time: null, check_out_time: '2026-08-10T09:00:00Z'
}) === 'missing_in');
check('完整上下班不列待補', incomplete('2026-08-10', {
  check_in_time: '2026-08-10T00:00:00Z', check_out_time: '2026-08-10T09:00:00Z'
}) === null);
check('今天只有上班卡不誤報缺下班', incomplete('2026-08-15', {
  check_in_time: '2026-08-15T00:00:00Z', check_out_time: null
}) === null);

const adam = [{ date: '2026-08-10', check_in_time: '2026-08-10T11:52:00Z', check_out_time: null }];
const adamConflict = conflict(adam, '2026-08-10', 'clock_out', '17:00');
check('Adam 19:52 上班、17:00 下班會被前端擋下', adamConflict?.code === 'checkout_before_checkin');
check('衝突提示包含兩個具體時間與主管指引', adamConflict?.message.includes('17:00')
  && adamConflict.message.includes('19:52') && adamConflict.message.includes('主管'));
check('08:00 上班、17:00 下班可繼續送出', conflict([{
  date: '2026-08-10', check_in_time: '2026-08-10T00:00:00Z', check_out_time: null
}], '2026-08-10', 'clock_out', '17:00') === null);

const defaultCode = grab(recordsSrc, 'getMpDefaultCheckoutTime');
function defaultTime(setting) {
  return new Function('setting', `const getCachedSetting = () => setting; ${defaultCode}; return getMpDefaultCheckoutTime();`)(setting);
}
check('公司下班設定有效時使用公司時間', defaultTime('18:30:00') === '18:30');
check('設定缺失時回退 17:00', defaultTime(null) === '17:00');
check('設定格式錯誤時回退 17:00', defaultTime('5:00') === '17:00');

const timeInputCode = [grab(recordsSrc, 'normalizeMpTimeValue'), grab(recordsSrc, 'isValidMpTime')].join('\n');
function normalizeTime(value) {
  return new Function('value', `${timeInputCode}; return { normalized: normalizeMpTimeValue(value), valid: isValidMpTime(normalizeMpTimeValue(value)) };`)(value);
}
check('手機欄位固定以 24 小時格式顯示 17:00', recordsSrc.includes('type="text" id="mpTime"')
  && recordsSrc.includes('inputmode="numeric"') && normalizeTime('1700').normalized === '17:00');
check('補打卡時間有不送出表單的時鐘入口', recordsSrc.includes('type="button" id="mpTimePickerButton"')
  && recordsSrc.includes('aria-label="開啟時鐘選擇實際打卡時間"'));
check('時鐘入口使用原生時間選取但不取代可見 24 小時欄位', recordsSrc.includes('type="time" id="mpTimeNativePicker"')
  && recordsSrc.includes('function openMpTimePicker()') && recordsSrc.includes('picker.showPicker()')
  && recordsSrc.includes('picker.focus();') && recordsSrc.includes('picker.click();'));

const timePickerCode = [
  grab(recordsSrc, 'getMpDefaultCheckoutTime'),
  grab(recordsSrc, 'markMpTimeManual'),
  grab(recordsSrc, 'normalizeMpTimeValue'),
  grab(recordsSrc, 'isValidMpTime'),
  grab(recordsSrc, 'openMpTimePicker'),
  grab(recordsSrc, 'applyMpTimePickerValue')
].join('\n');
function simulateTimePicker() {
  const elements = {
    conflictChecks: 0,
    pickerOpened: 0,
    mpTime: { value: '1700', dataset: { autoDefault: 'true' } },
    mpType: { value: 'clock_out' },
    mpTimeNativePicker: {
      value: '17:00',
      showPicker() { elements.pickerOpened++; },
      focus() {}, click() {}
    }
  };
  const document = { getElementById: id => elements[id] || null };
  return new Function('document', 'getCachedSetting', 'onMpFormChange', 'elements', `
    ${timePickerCode}
    openMpTimePicker();
    applyMpTimePickerValue();
    return { pickerValue: elements.mpTimeNativePicker.value, visibleValue: elements.mpTime.value,
      autoDefault: elements.mpTime.dataset.autoDefault, pickerOpened: elements.pickerOpened,
      conflictChecks: elements.conflictChecks };
  `)(document, () => null, () => { elements.conflictChecks++; }, elements);
}
const timePickerSimulation = simulateTimePicker();
check('時鐘選取會以 17:00 同步可見欄位', timePickerSimulation.pickerValue === '17:00'
  && timePickerSimulation.visibleValue === '17:00' && timePickerSimulation.pickerOpened === 1);
check('時鐘選取視同手動輸入並立即重跑衝突檢查', timePickerSimulation.autoDefault === 'false'
  && timePickerSimulation.conflictChecks === 1);
check('下午五點的 17:00 可通過格式檢查', normalizeTime('17:00').valid === true);
check('沒有補零的 5:00 會正規化為 05:00', normalizeTime('5:00').normalized === '05:00');
check('無效的 25:00 不可送出', normalizeTime('25:00').valid === false
  && commonSrc.includes('時間格式不正確，請用 24 小時格式'));

const scopedStatusCode = grab(recordsSrc, 'getScopedMakeupNeedStatus');
function scopedStatus(row) {
  return new Function('row', `${scopedStatusCode}; return getScopedMakeupNeedStatus(row);`)(row);
}
check('公司範圍資料把 Adam 8/10 只有上班卡列為缺下班', scopedStatus({
  check_in_time: '2026-08-10T11:52:00Z', check_out_time: null, status: 'working'
}) === 'missing_out');

const needTypesCode = grab(recordsSrc, 'getMakeupNeedTypes');
function needTypes(status, employee) {
  return new Function('status', 'employee', `${needTypesCode}; return getMakeupNeedTypes(status, employee);`)(status, employee);
}
check('免打卡人員不列整日無打卡日期', needTypes('absent', { role: 'admin', no_checkin: true }).length === 0);
check('免打卡人員已有上班卡時仍列補下班', JSON.stringify(needTypes('missing_out', {
  role: 'admin', no_checkin: true
})) === JSON.stringify(['clock_out']));
check('只有管理員角色但未勾免打卡仍列整日缺卡', JSON.stringify(needTypes('absent', {
  role: 'admin', no_checkin: false
})) === JSON.stringify(['clock_in', 'clock_out']));
check('migration 116 保留每日考勤 RPC 簽章', migration116Src.includes('public.get_company_daily_attendance(')
  && migration116Src.includes('p_company_id UUID')
  && migration116Src.includes('p_date DATE')
  && migration116Src.includes('p_line_user_id TEXT DEFAULT NULL'));
check('migration 116 保留公司與管理者驗權', migration116Src.includes('has_company_access(p_line_user_id, p_company_id, true)')
  && migration116Src.includes('e.company_id = p_company_id')
  && migration116Src.includes("RAISE EXCEPTION 'access_denied'"));
check('migration 116 只排除免打卡且整日無卡', /COALESCE\(e\.no_checkin, false\) = false\s+OR a\.check_in_time IS NOT NULL\s+OR a\.check_out_time IS NOT NULL/s.test(migration116Src));
check('migration 116 的 SECURITY DEFINER 固定 search_path', migration116Src.includes('SECURITY DEFINER')
  && migration116Src.includes('SET search_path = public'));
check('migration 116 不寫考勤、不建排程、不發 LINE', !/\b(?:INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+(?:public\.)?attendance\b/i.test(migration116Src)
  && !/cron\.schedule|net\.http|sendLine|line_messaging_api/i.test(migration116Src));

check('補打卡頁有待補日期清單', recordsSrc.includes('id="makeupNeededList"'));
check('下班預設提示明示下午 5:00', recordsSrc.includes('下午 5:00'));
check('提交按鈕可被衝突驗證停用', recordsSrc.includes("btn.disabled = !!conflict"));
check('月曆先判斷不完整打卡再判定正常', recordsSrc.indexOf("getIncompletePunchStatus(ds, att")
  < recordsSrc.indexOf("if (att.is_late && att.is_early_leave)"));
check('待補清單排除 pending／approved 重複申請', recordsSrc.includes("r.status === 'pending' || r.status === 'approved'"));
check('平台管理員改用具公司與呼叫者驗證的每日考勤 RPC', recordsSrc.includes('canUseCompanyScopedMakeupGuidance')
  && recordsSrc.includes("sb.rpc('get_company_daily_attendance'")
  && recordsSrc.includes('p_company_id: window.currentCompanyId')
  && recordsSrc.includes('p_line_user_id: liffProfile.userId'));
check('公司範圍考勤只保留目前員工資料', recordsSrc.includes('item.employee_id === currentEmployee.id'));
check('多公司帳號清空既有月考勤資料避免跨公司殘留', recordsSrc.includes('if (!makeupGuidanceScopeReady)')
  && recordsSrc.includes('attData = [];') && recordsSrc.includes('lvData = [];'));
check('多公司帳號顯示安全限制說明', recordsSrc.includes('為避免顯示錯誤公司的考勤'));
check('補打卡頁長錯誤提示允許完整換行', recordsSrc.includes('white-space: normal')
  && recordsSrc.includes('overflow-wrap: anywhere')
  && recordsSrc.includes('text-overflow: clip'));
check('錯誤提示寬度保留手機左右邊界', recordsSrc.includes('max-width: calc(100vw - 32px)')
  && recordsSrc.includes('env(safe-area-inset-bottom)'));
const toastCode = grab(commonSrc, 'showToast');
check('長訊息顯示時間延長到 6 秒', toastCode.includes('text.length > 32 ? 6000 : 3000')
  && toastCode.includes('displayMs - 500') && toastCode.includes('}, displayMs)'));
check('共用提交函式在 RPC 前執行已知衝突檢查', commonSrc.indexOf('window.getMakeupPunchConflict')
  < commonSrc.indexOf("sb.rpc('submit_makeup_punch'"));
check('後端 checkout_before_checkin 保護仍存在', fs.readFileSync(path.join(root, 'migrations', '106_makeup_punch_time_sanity.sql'), 'utf8')
  .includes("'code', 'checkout_before_checkin'"));

const guidanceFunctions = [
  grab(recordsSrc, 'getIncompletePunchStatus'),
  grab(recordsSrc, 'getMpDefaultCheckoutTime'),
  grab(recordsSrc, 'getMakeupPunchConflict'),
  grab(recordsSrc, 'renderMakeupNeededList')
].join('\n');
check('導引判斷本身沒有資料庫寫入或 LINE 推播', !/\.insert\(|\.update\(|\.upsert\(|\.delete\(|sendLine|sendAdminNotify|quick_check_in/i.test(guidanceFunctions));

const commonRefs = fs.readdirSync(root)
  .filter(name => name.endsWith('.html'))
  .map(name => ({ name, src: fs.readFileSync(path.join(root, name), 'utf8') }))
  .filter(file => /<script\s+src="common\.js/.test(file.src));
const staleRefs = commonRefs.filter(file => !file.src.includes('common.js?v=20260815-makeupguidance2'));
check('所有 common.js 引用已同步升版', staleRefs.length === 0, staleRefs.map(file => file.name).join(', '));

console.log(`\n  結果：✅ ${pass} 通過  ❌ ${fail} 失敗\n`);
process.exit(fail ? 1 : 0);
