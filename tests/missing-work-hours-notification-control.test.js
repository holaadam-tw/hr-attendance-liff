// 缺時 LINE 通知安全開關回歸測試（離線、不連線、不發通知）
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const migration = fs.readFileSync(path.join(root, 'migrations', '115_gate_missing_work_hours_notifications.sql'), 'utf8');
const overview = fs.readFileSync(path.join(root, 'attendance_overview.html'), 'utf8');

let pass = 0;
let fail = 0;
function check(name, condition) {
  if (condition) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; console.log(`  ❌ ${name}`); }
}

function sqlFunctionBody(name) {
  const start = migration.indexOf(`CREATE OR REPLACE FUNCTION public.${name}(`);
  if (start < 0) throw new Error(`找不到 SQL 函式：${name}`);
  const bodyStart = migration.indexOf('AS $$', start);
  const end = migration.indexOf('$$;', bodyStart + 5);
  if (bodyStart < 0 || end < 0) throw new Error(`SQL 函式不完整：${name}`);
  return migration.slice(start, end + 3);
}

function jsFunctionBody(name) {
  const start = overview.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`找不到前端函式：${name}`);
  let depth = 0;
  let opened = false;
  for (let i = start; i < overview.length; i++) {
    if (overview[i] === '{') { depth++; opened = true; }
    if (overview[i] === '}' && opened && --depth === 0) return overview.slice(start, i + 1);
  }
  throw new Error(`前端函式不完整：${name}`);
}

console.log('\n═══════════════════════════════════════');
console.log('  缺時 LINE 通知安全開關回歸測試');
console.log('═══════════════════════════════════════');

const getControl = sqlFunctionBody('get_missing_work_hours_notification_control');
const setControl = sqlFunctionBody('set_missing_work_hours_notification_enabled');
const preview = sqlFunctionBody('preview_company_missing_work_hours');
const daily = sqlFunctionBody('run_daily_missing_work_hours_audit');

check('設定不存在時回傳預設關閉', /v_enabled BOOLEAN := false/.test(getControl) && /'default_off', true/.test(getControl));
check('只有明確 JSON true 或字串 true 才算開啟', /value = 'true'::jsonb/.test(getControl) && /value = '"true"'::jsonb/.test(getControl));
check('設定讀取驗證公司管理權限', /has_missing_work_hours_notification_access\(p_line_user_id, p_company_id\)/.test(getControl));
check('設定更新驗證公司管理權限', /has_missing_work_hours_notification_access\(p_line_user_id, p_company_id\)/.test(setControl));
check('專屬管理權限明確排除公務機', /role IN \('admin', 'manager'\)[\s\S]*COALESCE\(e\.is_kiosk, false\) = false/.test(migration));
check('專屬管理權限 helper 不開放前端直接呼叫', /REVOKE ALL ON FUNCTION public\.has_missing_work_hours_notification_access\(TEXT, UUID\)[\s\S]*FROM PUBLIC, anon, authenticated/.test(migration));
check('平台管理員資料表不存在時安全退讓', /to_regclass\('public\.platform_admins'\) IS NOT NULL[\s\S]*to_regclass\('public\.platform_admin_companies'\) IS NOT NULL/.test(migration));
check('設定更新只鎖定指定公司與固定 key', /company_id = p_company_id/.test(setControl) && /missing_work_hours_line_notifications_enabled/.test(setControl));
check('三支管理 RPC 都有撤銷 PUBLIC 並只授權 anon/authenticated',
  (migration.match(/REVOKE ALL ON FUNCTION public\.(?:get_missing_work_hours_notification_control|set_missing_work_hours_notification_enabled|preview_company_missing_work_hours)/g) || []).length === 3 &&
  (migration.match(/GRANT EXECUTE ON FUNCTION public\.(?:get_missing_work_hours_notification_control|set_missing_work_hours_notification_enabled|preview_company_missing_work_hours)/g) || []).length === 3);

check('人工掃描驗證公司管理權限', /has_missing_work_hours_notification_access\(p_line_user_id, p_company_id\)/.test(preview));
check('人工掃描員工查詢限定 company_id', /e\.company_id = p_company_id/.test(preview));
check('人工掃描限制最近 1 至 7 天', /LEAST\(GREATEST\(COALESCE\(p_days_back, 3\), 1\), 7\)/.test(preview));
check('人工掃描沿用正式缺時計算函式', /calculate_missing_work_hours\(v_row\.employee_id, v_row\.audit_date\)/.test(preview));
check('人工掃描只寫 attendance_anomalies', /INSERT INTO public\.attendance_anomalies/.test(preview) && !/INSERT INTO public\.(?:attendance|leave_requests)\b/.test(preview));
check('人工掃描不呼叫 LINE 或 pg_net', !/net\.http_post|api\.line\.me/.test(preview));
check('人工掃描明確回傳通知 0 筆', /'notifications_sent', 0/.test(preview));
check('人工掃描可在資料補齊後自動結案', /resolution = 'system_reconciled'/.test(preview));

const gateIndex = daily.indexOf("missing_work_hours_line_notifications_enabled");
const tokenIndex = daily.indexOf("line_messaging_api");
const httpIndex = daily.indexOf('net.http_post');
check('每日函式先檢查開關，再讀 Token 與發 HTTP', gateIndex >= 0 && gateIndex < tokenIndex && tokenIndex < httpIndex);
check('每日函式關閉時直接略過公司', /v_companies_skipped := v_companies_skipped \+ 1;[\s\S]*CONTINUE;/.test(daily));
check('每日函式仍保留員工通知冪等', /notified_at AT TIME ZONE 'Asia\/Taipei'/.test(daily));
check('每日函式仍保留主管彙總冪等', /group_notified_date/.test(daily) && /v_group_should_notify/.test(daily));
check('每日函式維持 service_role only', /REVOKE ALL ON FUNCTION public\.run_daily_missing_work_hours_audit\(\) FROM PUBLIC, anon, authenticated/.test(migration));

check('考勤卡有通知狀態、掃描與開關按鈕', /missingWorkHoursNotifyStatus/.test(overview) && /missingWorkHoursScanBtn/.test(overview) && /missingWorkHoursToggleBtn/.test(overview));
check('介面白話說明每日 09:15 提醒內容', /每天 09:15 檢查前一天到最近 3 天/.test(overview));
check('介面明示不扣薪、不請假、不改打卡', /不會自動扣薪/.test(overview) && /不會自動請假/.test(overview) && /不會修改打卡紀錄/.test(overview));

const previewJs = jsFunctionBody('previewMissingWorkHours');
const toggleJs = jsFunctionBody('toggleMissingWorkHoursNotifications');
check('掃描按鈕呼叫公司限定 preview RPC', /preview_company_missing_work_hours/.test(previewJs));
check('掃描 RPC 帶公司、呼叫者與 3 天範圍', /p_company_id:\s*window\.currentCompanyId/.test(previewJs) && /p_line_user_id:\s*liffProfile\.userId/.test(previewJs) && /p_days_back:\s*3/.test(previewJs));
check('掃描前明示本次通知 0 筆', /不會發 LINE/.test(previewJs) && /本次通知 0 筆/.test(previewJs));
check('啟用通知前要求主管確認名單', /請先確認下方名單正確/.test(toggleJs) && /confirm\(/.test(toggleJs));
check('取消確認時不呼叫設定 RPC', /if \(nextEnabled && !confirm\([\s\S]*\)\) return;/.test(toggleJs));
check('開關使用管理 RPC，不直接寫 system_settings', /set_missing_work_hours_notification_enabled/.test(toggleJs) && !/saveSetting|\.from\(['"]system_settings/.test(toggleJs));
check('RPC 尚未就緒時按鈕保持停用且不會誤開', /available: false/.test(overview) && /!missingWorkHoursControl\.available/.test(overview));
check('沒有異常時仍顯示控制區供人工掃描', !/anomalyData\.length === 0\) \{ card\.style\.display = 'none'/.test(overview));

const inlineScripts = [...overview.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)].map(m => m[1]);
let syntaxOk = true;
for (const source of inlineScripts) {
  try { new Function(source); } catch (error) { syntaxOk = false; console.log(`     ${error.message}`); }
}
check('attendance_overview.html 全部 inline JavaScript 語法正確', syntaxOk);

console.log(`\n  結果：${pass} 通過，${fail} 失敗`);
if (fail > 0) process.exit(1);
