// LINE 通知結果回饋回歸測試（離線、不連線、不發通知）
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const commonSrc = fs.readFileSync(path.join(root, 'common.js'), 'utf8');
const settingsSrc = fs.readFileSync(path.join(root, 'modules', 'settings.js'), 'utf8');
const leaveSrc = fs.readFileSync(path.join(root, 'modules', 'leave.js'), 'utf8');
const edgeSrc = fs.readFileSync(path.join(root, 'supabase', 'functions', 'line-push', 'index.ts'), 'utf8');
const moduleIndexSrc = fs.readFileSync(path.join(root, 'modules', 'index.js'), 'utf8');

let pass = 0;
let fail = 0;
function check(name, condition, detail = '') {
  if (condition) {
    pass++;
    console.log(`  ✅ ${name}${detail ? `  → ${detail}` : ''}`);
  } else {
    fail++;
    console.log(`  ❌ ${name}${detail ? `  → ${detail}` : ''}`);
  }
}

function grabFunction(source, name) {
  const asyncStart = source.indexOf(`async function ${name}(`);
  const start = asyncStart >= 0 ? asyncStart : source.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`找不到函式：${name}`);
  let depth = 0;
  let opened = false;
  for (let i = start; i < source.length; i++) {
    if (source[i] === '{') { depth++; opened = true; }
    if (source[i] === '}' && opened && --depth === 0) return source.slice(start, i + 1);
  }
  throw new Error(`函式括號不完整：${name}`);
}

function buildLineHelpers({ setting, response, fetchError, employeeResult } = {}) {
  let fetchCalls = 0;
  const fetch = async () => {
    fetchCalls++;
    if (fetchError) throw fetchError;
    return response || { ok: true, status: 200, json: async () => ({ status: 200 }) };
  };
  const filters = [];
  const chain = {
    select() { return chain; },
    eq(column, value) { filters.push([column, value]); return chain; },
    maybeSingle() { return Promise.resolve(employeeResult || { data: { line_user_id: 'U123' }, error: null }); }
  };
  const source = [
    'lineNotifyFailure',
    'lineNotifyMessageForStatus',
    'sendLineMessage',
    'sendAdminNotify',
    'sendUserNotify'
  ].map(name => grabFunction(commonSrc, name)).join('\n');
  const factory = new Function(
    'getCachedSetting', 'fetch', 'CONFIG', 'console', 'window', 'sb',
    `${source}; return { sendLineMessage, sendAdminNotify, sendUserNotify };`
  );
  const helpers = factory(
    () => setting === undefined ? { token: 'token-value', groupId: 'C123' } : setting,
    fetch,
    { SUPABASE_ANON_KEY: 'anon-key' },
    { error() {}, warn() {} },
    { currentCompanyId: 'company-a' },
    { from(table) { if (table !== 'employees') throw new Error('未預期資料表'); return chain; } }
  );
  return { ...helpers, fetchCalls: () => fetchCalls, filters };
}

(async () => {
  console.log('\n═══════════════════════════════════════');
  console.log('  LINE 通知結果回饋回歸測試');
  console.log('═══════════════════════════════════════');

  const legacyOk = buildLineHelpers({
    response: { ok: true, status: 200, json: async () => ({ status: 200, data: '' }) }
  });
  const legacyOkResult = await legacyOk.sendLineMessage('C123', 'test');
  check('相容舊 Edge Function 的 HTTP 200／包裝 status 200', legacyOkResult.ok === true && legacyOkResult.status === 200);

  const wrapped401 = buildLineHelpers({
    response: { ok: true, status: 200, json: async () => ({ status: 401, data: '{}' }) }
  });
  const wrapped401Result = await wrapped401.sendLineMessage('C123', 'test');
  check('HTTP 200 但包裝 status 401 會判定失敗', wrapped401Result.ok === false && wrapped401Result.status === 401);
  check('401 顯示 Token 無效的白話原因', /Token 無效或已過期/.test(wrapped401Result.message), wrapped401Result.message);

  const direct403 = buildLineHelpers({
    response: { ok: false, status: 403, json: async () => ({ ok: false, status: 403, error: 'Forbidden' }) }
  });
  const direct403Result = await direct403.sendLineMessage('C123', 'test');
  check('新 Edge Function 的 HTTP 403 會判定失敗', direct403Result.ok === false && direct403Result.status === 403);

  const missingToken = buildLineHelpers({ setting: { token: '', groupId: 'C123' } });
  const missingTokenResult = await missingToken.sendAdminNotify('test');
  check('缺少 Token 不送網路請求並回傳明確失敗', missingTokenResult.code === 'missing_token' && missingToken.fetchCalls() === 0);

  const missingGroup = buildLineHelpers({ setting: { token: 'token-value', groupId: '' } });
  const missingGroupResult = await missingGroup.sendAdminNotify('test');
  check('缺少主管群組 ID 回傳明確失敗', missingGroupResult.code === 'missing_group' && /群組 ID/.test(missingGroupResult.message));

  const networkFailure = buildLineHelpers({ fetchError: new Error('offline') });
  const networkResult = await networkFailure.sendLineMessage('C123', 'test');
  check('網路失敗回傳結構化結果而非假成功', networkResult.ok === false && networkResult.code === 'network_error');

  const invalidResponse = buildLineHelpers({
    response: { ok: true, status: 200, json: async () => { throw new Error('invalid json'); } }
  });
  const invalidResult = await invalidResponse.sendLineMessage('C123', 'test');
  check('無法解析 Edge 回傳時不顯示成功', invalidResult.ok === false && invalidResult.code === 'invalid_response');

  const userNotify = buildLineHelpers();
  const userResult = await userNotify.sendUserNotify('employee-a', 'test');
  check('員工通知正常成功回傳', userResult.ok === true);
  check('員工 LINE 查詢同時限定 employee_id 與 company_id',
    userNotify.filters.some(([key, value]) => key === 'id' && value === 'employee-a') &&
    userNotify.filters.some(([key, value]) => key === 'company_id' && value === 'company-a'));

  const submitLeaveSrc = grabFunction(commonSrc, 'submitLeave');
  const approveLeaveStart = leaveSrc.indexOf('export async function approveLeave(');
  const approveLeaveSrc = grabFunction(leaveSrc.slice(approveLeaveStart).replace(/^export\s+/, ''), 'approveLeave');
  const testNotifyStart = settingsSrc.indexOf('export async function testNotify(');
  const testNotifySrc = grabFunction(settingsSrc.slice(testNotifyStart).replace(/^export\s+/, ''), 'testNotify');
  check('請假申請等待主管通知結果並顯示獨立警告', /await sendAdminNotify/.test(submitLeaveSrc) && /請假已送出，但主管 LINE 通知失敗/.test(submitLeaveSrc));
  check('請假通知失敗不回滾既有申請 RPC', /申請資料已保留/.test(submitLeaveSrc) && (submitLeaveSrc.match(/submit_leave_request/g) || []).length >= 1);
  check('請假審核等待員工通知結果並保留審核成功訊息', /await sendUserNotify/.test(approveLeaveSrc) && /請假申請已\$\{actionText\}，但員工 LINE 通知失敗/.test(approveLeaveSrc));
  check('管理端測試推播只在 result.ok 時顯示成功', /if \(!result\?\.ok\)/.test(testNotifySrc) && /推播成功！請查看 LINE 群組/.test(testNotifySrc));

  check('本機 Edge Function 將 LINE HTTP 狀態向外傳遞', /status:\s*res\.status/.test(edgeSrc));
  check('本機 Edge Function 回傳不包含 Channel Token', !/JSON\.stringify\([^\n]*token/.test(edgeSrc));
  check('本機 Edge Function 例外訊息不直接外洩', /LINE 推播服務暫時無法使用/.test(edgeSrc) && !/error:\s*e\.message/.test(edgeSrc));

  check('管理模組快取版本已更新', /leave\.js\?v=20260901-linenotify/.test(moduleIndexSrc));
  const htmlFiles = fs.readdirSync(root).filter(name => name.endsWith('.html'));
  const commonRefs = htmlFiles
    .map(name => ({ name, src: fs.readFileSync(path.join(root, name), 'utf8') }))
    .filter(file => file.src.includes('common.js'));
  const staleRefs = commonRefs.filter(file => !file.src.includes('common.js?v=20260901-linenotify'));
  check('所有 common.js 引用已同步升版', staleRefs.length === 0, staleRefs.map(file => file.name).join(', '));

  console.log(`\n  結果：${pass} 通過，${fail} 失敗`);
  if (fail > 0) process.exit(1);
})().catch(error => {
  console.error('  ❌ 測試執行失敗', error);
  process.exit(1);
});
