// 時數假起訖、請假調整遲到與隔日缺時提醒回歸測試（不連線、不寫 DB）
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const commonSrc = fs.readFileSync(path.join(root, 'common.js'), 'utf8');
const recordsSrc = fs.readFileSync(path.join(root, 'records.html'), 'utf8');
const payrollSrc = fs.readFileSync(path.join(root, 'modules', 'payroll.js'), 'utf8');
const publicSrc = fs.readFileSync(path.join(root, 'attendance_public.html'), 'utf8');
const migration113 = fs.readFileSync(path.join(root, 'migrations', '113_hourly_leave_time_range.sql'), 'utf8');
const migration114 = fs.readFileSync(path.join(root, 'migrations', '114_missing_work_hours_audit.sql'), 'utf8');

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

const helpers = new Function(`
  ${grab(commonSrc, 'leaveTimeToMinutes')}
  ${grab(commonSrc, 'getLeaveHoursForAudit')}
  ${grab(commonSrc, 'getTaiwanMinutesFromTimestamp')}
  ${grab(commonSrc, 'getLeaveAdjustedLateMinutes')}
  return { leaveTimeToMinutes, getLeaveHoursForAudit, getLeaveAdjustedLateMinutes };
`)();

const approved = extra => ({
  status: 'approved', start_date: '2026-08-10', end_date: '2026-08-10', ...extra
});

console.log('\n═══════════════════════════════════════');
console.log('  時數假與缺時稽核回歸測試');
console.log('═══════════════════════════════════════');

check('上午半天 12:40 到班不算遲到', helpers.getLeaveAdjustedLateMinutes(12 * 60 + 40, '2026-08-10', [approved({ leave_period: 'am' })]) === 0);
check('上午半天 13:05 到班算遲到 5 分鐘', helpers.getLeaveAdjustedLateMinutes(13 * 60 + 5, '2026-08-10', [approved({ leave_period: 'am' })]) === 5);
check('待審上午半天不調整遲到', helpers.getLeaveAdjustedLateMinutes(13 * 60 + 5, '2026-08-10', [{ ...approved({ leave_period: 'am' }), status: 'pending' }]) === 305);
check('08:00–10:00 時數假、10:12 到班算 12 分鐘', helpers.getLeaveAdjustedLateMinutes(10 * 60 + 12, '2026-08-10', [approved({ leave_period: 'hourly', leave_start_time: '08:00', leave_end_time: '10:00' })]) === 12);
check('未銜接上班起點的 10:00–12:00 時數假不抵早上遲到', helpers.getLeaveAdjustedLateMinutes(8 * 60 + 10, '2026-08-10', [approved({ leave_period: 'hourly', leave_start_time: '10:00', leave_end_time: '12:00' })]) === 10);
check('下午半天不抵早上遲到', helpers.getLeaveAdjustedLateMinutes(8 * 60 + 10, '2026-08-10', [approved({ leave_period: 'pm' })]) === 10);
check('核准全日假不計遲到', helpers.getLeaveAdjustedLateMinutes(15 * 60, '2026-08-10', [approved({ leave_period: 'full_day' })]) === 0);

check('時數假由 08:30–11:00 自動得到 2.5 小時', helpers.getLeaveHoursForAudit(approved({ leave_period: 'hourly', leave_start_time: '08:30', leave_end_time: '11:00', leave_hours: 9 })) === 2.5);
check('舊時數假沒有起訖時回退 leave_hours', helpers.getLeaveHoursForAudit(approved({ leave_period: 'hourly', leave_hours: 3 })) === 3);
check('整日假使用 DB days，不用曆日重算', helpers.getLeaveHoursForAudit(approved({ leave_period: 'full_day', days: 7, start_date: '2026-06-01', end_date: '2026-06-09' })) === 56);

check('員工表單已改為兩個 time 輸入', /id="leaveStartTime"[^>]*type="time"|type="time"[^>]*id="leaveStartTime"/.test(recordsSrc) && /id="leaveEndTime"[^>]*type="time"|type="time"[^>]*id="leaveEndTime"/.test(recordsSrc));
check('員工表單不再要求手填整數時數', !/id="leaveHours"/.test(recordsSrc));
check('送出 RPC 帶公司與實際起訖時間', /p_company_id:\s*window\.currentCompanyId/.test(commonSrc) && /p_leave_start_time/.test(commonSrc) && /p_leave_end_time/.test(commonSrc));

check('113 強制時數假同一天且結束晚於開始', /start_date\s*=\s*end_date/.test(migration113) && /leave_end_time\s*>\s*leave_start_time/.test(migration113));
check('113 由資料庫依起訖自動算時數', /EXTRACT\(EPOCH FROM \(p_leave_end_time - p_leave_start_time\)\)/.test(migration113));
check('113 保留時數假最低 1 小時規則', /v_hours\s*<\s*1/.test(migration113) && /至少 1 小時/.test(commonSrc));
check('113 員工身分以 company_id + LINE 隔離', /e\.company_id\s*=\s*p_company_id[\s\S]*e\.line_user_id\s*=\s*p_line_user_id/.test(migration113));
check('113 保留舊資料相容（NOT VALID）', /NOT VALID/.test(migration113));
check('113 管理報表透過公司與呼叫者驗證的只讀 RPC', /get_company_leave_requests_for_audit/.test(migration113) && /has_company_access\(p_line_user_id, p_company_id, true\)/.test(migration113));

check('114 涵蓋晚到、早退及整日無打卡', /'late_minutes'/.test(migration114) && /'early_minutes'/.test(migration114) && /'full_day_absence'/.test(migration114));
check('114 沿用公司遲到與早退容忍設定', /late_threshold_minutes/.test(migration114) && /early_leave_threshold_minutes/.test(migration114));
check('114 排除公司假日、免打卡、公務機與跨日班', /public\.holidays/.test(migration114) && /no_checkin/.test(migration114) && /is_kiosk/.test(migration114) && /overnight_shift/.test(migration114));
check('114 排除待審補卡與既有未下班異常', /makeup_pending/.test(migration114) && /missing_checkout_pending/.test(migration114));
check('114 只寫異常追蹤，不自動新增請假或考勤', !/INSERT\s+INTO\s+public\.(leave_requests|attendance)\b/i.test(migration114));
check('114 同時有員工 LINE 與主管群組通知', /v_row\.line_user_id/.test(migration114) && /v_group_id/.test(migration114) && /應上班時數不足彙總/.test(migration114));
check('114 員工與主管群組通知皆具每日冪等', /notified_at AT TIME ZONE 'Asia\/Taipei'/.test(migration114) && /group_notified_date/.test(migration114) && /v_group_should_notify/.test(migration114));
check('114 內部掃描 RPC 不開放 anon/authenticated', /REVOKE ALL ON FUNCTION public\.scan_missing_work_hours\(INTEGER\) FROM PUBLIC, anon, authenticated/.test(migration114));
check('114 管理查詢仍驗證公司管理權限', /has_company_access\(p_line_user_id, p_company_id, true\)/.test(migration114));
check('114 自動結案值已納入 constraint', /system_reconciled/.test(migration114) && /attendance_anomalies_resolution_check/.test(migration114));

check('薪資核對使用共用請假時數與遲到函式', /getLeaveHoursForAudit/.test(payrollSrc) && /getLeaveAdjustedLateMinutes/.test(payrollSrc));
check('公開考勤使用相同請假與遲到口徑', /function monthLeaveHoursOf/.test(publicSrc) && /monthLeaveAdjustedLateMinutes/.test(publicSrc) && /leave_start_time/.test(publicSrc));
check('本次兩個主管核對流程改走請假只讀 RPC', /get_company_leave_requests_for_audit/.test(payrollSrc) && /function loadMonthLeaveRequests\(\)[\s\S]{0,600}get_company_leave_requests_for_audit/.test(publicSrc));
check('公開考勤顯示應上班時數不足分鐘', /應上班時數不足/.test(publicSrc) && /missing_minutes/.test(publicSrc));

console.log(`\n  結果：${pass} 通過，${fail} 失敗`);
if (fail > 0) process.exit(1);
