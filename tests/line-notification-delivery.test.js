// LINE 通知結果回饋回歸測試（離線、不連線、不發通知）
// 126 起：前端不再持有／傳送 LINE Channel token，改帶 LIFF access token，由 line-push 伺服器端取 token。
// 反向對照：COMMON_JS_FILE／SETTINGS_JS_FILE 可指向舊版副本（git show origin/main:common.js）。
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const commonSrc = fs.readFileSync(process.env.COMMON_JS_FILE || path.join(root, 'common.js'), 'utf8');
const settingsSrc = fs.readFileSync(process.env.SETTINGS_JS_FILE || path.join(root, 'modules', 'settings.js'), 'utf8');
const leaveSrc = fs.readFileSync(path.join(root, 'modules', 'leave.js'), 'utf8');
const edgeSrc = fs.readFileSync(path.join(root, 'supabase', 'functions', 'line-push', 'handler.ts'), 'utf8');
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
function tryGrab(source, name) { try { return grabFunction(source, name); } catch (e) { return ''; } }
function grabConst(source, name) { return (source.match(new RegExp(`const ${name} = [\\[\\{][\\s\\S]*?[\\]\\}];`)) || [''])[0]; }

const TOKEN = 'channel-token-SECRET';

// 用 common.js 原文組出通知函式，注入假的 fetch／sb／liff
function buildLineHelpers({ response, fetchError, extraSettings = {}, liffToken = 'liff-at', rpcResult } = {}) {
  let fetchCalls = 0;
  const bodies = [];
  const sbCalls = [];
  const fetch = async (url, init = {}) => {
    fetchCalls++;
    if (init.body) bodies.push(JSON.parse(init.body));
    if (fetchError) throw fetchError;
    return response || { ok: true, status: 200, json: async () => ({ ok: true, status: 200 }) };
  };
  const settings = { line_messaging_api: { token: TOKEN, groupId: 'C123' }, ...extraSettings };
  const source = [grabConst(commonSrc, 'ADMIN_NOTIFY_DEFAULT_ROUTES'), grabConst(commonSrc, 'LINE_PUSH_DENY_MESSAGES'), grabConst(commonSrc, 'SECRET_SETTING_KEYS'), grabConst(commonSrc, 'FORM_DRAFT_SECRET_IDS'),
    ...['FORM_DRAFT_PREFIX', 'LIFF_RELOGIN_MARKER'].map(n => (commonSrc.match(new RegExp(`const ${n} = [^;]*;`)) || [''])[0])].join('\n') + '\n' + [
    'lineNotifyFailure', 'resolveAdminNotifyRoute', 'lineNotifyMessageForStatus', 'getLiffAccessTokenSafe',
    'requestLinePush', 'sendLineMessage', 'sendAdminNotify', 'sendUserNotify', 'saveLineMessagingConfig',
    'stripSecretSettings', 'saveSetting', 'adminCallerLineUserId', 'callVerifiedAction',
    'clearReloginMarker', 'handleLiffSessionExpired', 'formDraftKey', 'collectFormDraft', 'saveFormDraft'
  ].map(name => tryGrab(commonSrc, name)).join('\n');
  const factory = new Function(
    'getCachedSetting', 'fetch', 'CONFIG', 'console', 'window', 'sb', 'liff', 'invalidateSettingsCache', 'loadSettings', 'currentEmployee', 'liffProfile',
    `${source}; return {
      requestLinePush: typeof requestLinePush === 'function' ? requestLinePush : null,
      sendAdminNotify, sendUserNotify,
      saveLineMessagingConfig: typeof saveLineMessagingConfig === 'function' ? saveLineMessagingConfig : null,
      stripSecretSettings: typeof stripSecretSettings === 'function' ? stripSecretSettings : null,
      saveSetting: typeof saveSetting === 'function' ? saveSetting : null };`
  );
  const sb = {
    from(table) { sbCalls.push(['from', table]); throw new Error('前端不應直接查 ' + table); },
    rpc(fn, args) { sbCalls.push(['rpc', fn, args]); return Promise.resolve(rpcResult || { data: { success: true }, error: null }); }
  };
  const helpers = factory(
    (key) => settings[key],
    fetch,
    { SUPABASE_ANON_KEY: 'anon-key' },
    { error() {}, warn() {} },
    { currentCompanyId: 'company-a' },
    sb,
    liffToken === null ? undefined : { getAccessToken: () => liffToken },
    () => {}, async () => {},
    null, { userId: 'Uadmin' }
  );
  return { ...helpers, fetchCalls: () => fetchCalls, bodies, sbCalls };
}

(async () => {
  console.log('\n═══════════════════════════════════════');
  console.log('  LINE 通知結果回饋回歸測試');
  console.log('═══════════════════════════════════════');

  console.log('\n=== 126：前端不再傳 LINE Channel token ===');
  const grp = buildLineHelpers({ extraSettings: { line_admin_notify_routes: { leave: 'group' } } });
  const grpResult = await grp.sendAdminNotify('請假', { category: 'leave' });
  const b0 = grp.bodies[0] || {};
  check('主管通知：request 不含 token 欄位、也不含 token 值', grp.bodies.length === 1 && !('token' in b0) && !JSON.stringify(grp.bodies).includes(TOKEN), JSON.stringify(b0));
  check('主管通知：帶 LIFF access token＋公司＋target=admin_group（收件人由伺服器決定）', b0.liff_access_token === 'liff-at' && b0.company_id === 'company-a' && b0.target === 'admin_group' && !('to' in b0) && grpResult.ok === true);
  const usr = buildLineHelpers();
  await usr.sendUserNotify('employee-a', '核准', { category: 'leave_result' });
  const b1 = usr.bodies[0] || {};
  check('員工通知：target=employee＋employee_id，不帶 token、不帶 LINE ID', b1.target === 'employee' && b1.employee_id === 'employee-a' && b1.category === 'leave_result' && !('token' in b1) && !('to' in b1));
  check('員工通知：前端不再自己查員工 LINE ID（伺服器端限同公司）', !usr.sbCalls.some(c => c[0] === 'from'));
  const noLiff = buildLineHelpers({ liffToken: null, extraSettings: { line_admin_notify_routes: { leave: 'group' } } });
  const noLiffResult = await noLiff.sendAdminNotify('x', { category: 'leave' });
  check('沒有 LIFF 登入：不送出，回 unauthenticated', noLiffResult.code === 'unauthenticated' && noLiff.fetchCalls() === 0);
  const noTokenSetting = buildLineHelpers({ extraSettings: { line_messaging_api: undefined, line_admin_notify_routes: { leave: 'group' } } });
  const nts = await noTokenSetting.sendAdminNotify('x', { category: 'leave' });
  check('前端快取沒有 token（127 後讀不到）：照樣能送', nts.ok === true && noTokenSetting.fetchCalls() === 1);

  console.log('\n=== 伺服器回應 → 使用者看得懂的結果 ===');
  const r401 = buildLineHelpers({ response: { ok: true, status: 200, json: async () => ({ ok: false, status: 401, error: 'x' }) }, extraSettings: { line_admin_notify_routes: { leave: 'group' } } });
  const r401Result = await r401.sendAdminNotify('t', { category: 'leave' });
  check('LINE 回 401（包裝在 200 裡）判定失敗、顯示 Token 無效', r401Result.ok === false && r401Result.status === 401 && /Token 無效或已過期/.test(r401Result.message), r401Result.message);
  const d403 = buildLineHelpers({ response: { ok: false, status: 403, json: async () => ({ ok: false, status: 403, error: 'Forbidden' }) }, extraSettings: { line_admin_notify_routes: { leave: 'group' } } });
  const d403Result = await d403.sendAdminNotify('t', { category: 'leave' });
  check('HTTP 403 判定失敗', d403Result.ok === false && d403Result.status === 403);
  const noGroup = buildLineHelpers({ response: { ok: false, status: 409, json: async () => ({ ok: false, status: 409, code: 'missing_group' }) }, extraSettings: { line_admin_notify_routes: { leave: 'group' } } });
  const noGroupResult = await noGroup.sendAdminNotify('t', { category: 'leave' });
  check('伺服器回 missing_group：顯示「尚未設定主管 LINE 群組 ID」', noGroupResult.code === 'missing_group' && /群組 ID/.test(noGroupResult.message));
  const noTok = buildLineHelpers({ response: { ok: false, status: 409, json: async () => ({ ok: false, status: 409, code: 'missing_token' }) }, extraSettings: { line_admin_notify_routes: { leave: 'group' } } });
  const noTokResult = await noTok.sendAdminNotify('t', { category: 'leave' });
  check('伺服器回 missing_token：顯示尚未設定 Token', noTokResult.code === 'missing_token' && /Channel Access Token/.test(noTokResult.message));
  const noLine = buildLineHelpers({ response: { ok: false, status: 409, json: async () => ({ ok: false, status: 409, code: 'missing_user_line' }) } });
  const noLineResult = await noLine.sendUserNotify('employee-a', 't');
  check('伺服器回 missing_user_line：顯示員工尚未綁定 LINE', noLineResult.code === 'missing_user_line' && /尚未綁定 LINE/.test(noLineResult.message));
  const expired = buildLineHelpers({ response: { ok: false, status: 401, json: async () => ({ ok: false, status: 401, code: 'unauthenticated' }) } });
  const expiredResult = await expired.sendUserNotify('employee-a', 't');
  check('LIFF 過期（401）：提示重新開啟頁面', expiredResult.code === 'unauthenticated' && /重新開啟/.test(expiredResult.message));
  const net = buildLineHelpers({ fetchError: new Error('offline') });
  const netResult = await net.sendUserNotify('employee-a', 't');
  check('網路失敗回傳結構化結果而非假成功', netResult.ok === false && netResult.code === 'network_error');
  const invalid = buildLineHelpers({ response: { ok: true, status: 200, json: async () => { throw new Error('invalid json'); } } });
  const invalidResult = await invalid.sendUserNotify('employee-a', 't');
  check('無法解析 Edge 回傳時不顯示成功', invalidResult.ok === false && invalidResult.code === 'invalid_response');
  const budget = buildLineHelpers({ response: { ok: true, status: 200, json: async () => ({ ok: false, status: 429, code: 'budget_blocked', error: '本月…' }) } });
  const budgetResult = await budget.sendUserNotify('employee-a', 'x');
  check('Edge 回 budget_blocked → 明確失敗訊息（額度）', budgetResult.ok === false && budgetResult.code === 'budget_blocked' && /額度/.test(budgetResult.message));

  console.log('\n=== 125 主管通知路由（行為不變）===');
  const digest = buildLineHelpers({ extraSettings: { line_admin_notify_routes: null } });
  const digestResult = await digest.sendAdminNotify('請假', { category: 'leave' });
  check('請假通知預設列入每日彙總：不打網路、回 ok＋deferred', digestResult.ok === true && digestResult.deferred === true && digest.fetchCalls() === 0);
  for (const cat of ['makeup', 'gps_review', 'overtime', 'shift_swap', 'request']) {
    const h = buildLineHelpers({ extraSettings: { line_admin_notify_routes: null } });
    const r = await h.sendAdminNotify('x', { category: cat });
    check(`${cat} 預設列入彙總（不推群組）`, r.deferred === true && h.fetchCalls() === 0);
  }
  const urgent = buildLineHelpers({ extraSettings: { line_admin_notify_routes: null } });
  const urgentResult = await urgent.sendAdminNotify('🚨', { category: 'urgent_announcement', priority: 'high' });
  check('緊急公告照舊即時推群組、標高優先、帶公司與類別', urgentResult.ok === true && urgent.bodies[0].target === 'admin_group' && urgent.bodies[0].priority === 'high' && urgent.bodies[0].category === 'urgent_announcement' && urgent.bodies[0].company_id === 'company-a');
  const approver = buildLineHelpers({ extraSettings: { line_admin_notify_routes: { gps_review: 'approver' }, line_admin_approver_employee_id: 'emp-approver' } });
  const approverResult = await approver.sendAdminNotify('GPS', { category: 'gps_review' });
  check('approver 模式：請伺服器私訊指定審核人（沒綁 LINE 時伺服器退回群組）', approverResult.ok === true && approver.bodies.length === 1 && approver.bodies[0].target === 'admin_approver' && approver.bodies[0].category === 'gps_review');
  const offRoute = buildLineHelpers({ extraSettings: { line_admin_notify_routes: { request: 'off' } } });
  const offResult = await offRoute.sendAdminNotify('x', { category: 'request' });
  check('off 模式：不通知', offResult.code === 'disabled' && offRoute.fetchCalls() === 0);

  console.log('\n=== 設定：token 不進瀏覽器、寫入走 RPC ===');
  const strip = buildLineHelpers();
  const cache = strip.stripSecretSettings ? strip.stripSecretSettings({ line_messaging_api: { token: TOKEN }, office_locations: [] }) : { line_messaging_api: 1 };
  check('stripSecretSettings：快取丟掉 line_messaging_api、保留其他', !('line_messaging_api' in cache) && 'office_locations' in cache);
  const loadSrc = tryGrab(commonSrc, 'loadSettings');
  check('loadSettings 兩條路徑（sessionStorage、DB）都會先剝掉秘密設定', (loadSrc.match(/stripSecretSettings\(/g) || []).length >= 2);
  const saveCfg = buildLineHelpers();
  const saveCfgResult = saveCfg.saveLineMessagingConfig ? await saveCfg.saveLineMessagingConfig('new-token', 'Cnew') : { ok: false };
  const sb0 = saveCfg.bodies[0] || {};
  check('saveLineMessagingConfig：送到 Edge Function（action=save_config、帶 LIFF），不直接寫 DB', saveCfgResult.ok === true && sb0.action === 'save_config' && sb0.liff_access_token === 'liff-at' && sb0.channel_token === 'new-token' && sb0.group_id === 'Cnew' && !saveCfg.sbCalls.some(c => c[0] === 'from'));
  const ss = buildLineHelpers({ extraSettings: {} });
  let ssErr = null;
  try { await ss.saveSetting('office_locations', [{ name: 'x' }], '打卡地點'); } catch (e) { ssErr = e; }
  const ssBody = ss.bodies[0] || {};
  check('saveSetting 經 Edge Function 驗 LIFF（action=save_setting），不帶自報的 LINE ID、不直接寫表／呼叫 RPC',
    !ssErr && ssBody.action === 'save_setting' && ssBody.liff_access_token === 'liff-at' && ssBody.company_id === 'company-a'
    && ssBody.key === 'office_locations' && ssBody.value[0].name === 'x' && !('line_user_id' in ssBody) && !ss.sbCalls.length, ssErr && ssErr.message);
  const ssDenied = buildLineHelpers({ response: { ok: false, status: 403, json: async () => ({ ok: false, status: 403, code: 'access_denied', error: '需要管理員權限' }) } });
  let deniedErr = null;
  try { await ssDenied.saveSetting('office_locations', []); } catch (e) { deniedErr = e; }
  check('saveSetting 被拒時 throw（不再顯示假的「已儲存」）', deniedErr && /管理員權限/.test(deniedErr.message));
  const ssNoLiff = buildLineHelpers({ liffToken: null });
  let noLiffErr = null;
  try { await ssNoLiff.saveSetting('office_locations', []); } catch (e) { noLiffErr = e; }
  check('沒有 LIFF 登入：saveSetting 不送出、throw', !!noLiffErr && ssNoLiff.fetchCalls() === 0);
  const ssSecret = buildLineHelpers();
  let secretErr = null;
  try { await ssSecret.saveSetting('line_messaging_api', { token: 'x' }); } catch (e) { secretErr = e; }
  check('saveSetting 拒絕直接存 LINE token', !!secretErr && ssSecret.fetchCalls() === 0 && !ssSecret.sbCalls.length);
  const rl = buildLineHelpers({ response: { ok: false, status: 429, json: async () => ({ ok: false, status: 429, code: 'rate_limited' }) } });
  const rlResult = await rl.sendUserNotify('employee-a', 't');
  check('伺服器回 rate_limited：顯示「發送太多」提示', rlResult.code === 'rate_limited' && /太多/.test(rlResult.message));

  const loadTokSrc = grabFunction(settingsSrc.slice(settingsSrc.indexOf('export async function loadNotifyToken(')).replace(/^export\s+/, ''), 'loadNotifyToken');
  const saveTokSrc = grabFunction(settingsSrc.slice(settingsSrc.indexOf('export async function saveNotifyToken(')).replace(/^export\s+/, ''), 'saveNotifyToken');
  check('設定頁載入：經 Edge Function（get_line_config）讀，不把 token 填回輸入框、不直接呼叫 RPC', /callVerifiedAction\('get_line_config'/.test(loadTokSrc) && !/sb\.rpc/.test(loadTokSrc) && !/\.token\b/.test(loadTokSrc));
  check('設定頁儲存：走 saveLineMessagingConfig（token 留空＝沿用）', /saveLineMessagingConfig\(/.test(saveTokSrc) && !/saveSetting\('line_messaging_api'/.test(saveTokSrc));
  const frontFiles = [...fs.readdirSync(root).filter(n => /\.(html|js)$/.test(n) && n !== 'health-check.js'), ...fs.readdirSync(path.join(root, 'modules')).map(n => 'modules/' + n)];
  const leaks = frontFiles.filter(n => /getCachedSetting\(\s*['"]line_messaging_api['"]\s*\)/.test(fs.readFileSync(path.join(root, n), 'utf8')));
  check('前端已無任何地方讀取 line_messaging_api 設定', leaks.length === 0, leaks.join(', '));
  const rpcDirect = frontFiles.filter(n => /sb\.rpc\(\s*['"](admin_save_setting|get_line_messaging_config|platform_admin_save|platform_link_company_owner)['"]/.test(fs.readFileSync(path.join(root, n), 'utf8')));
  check('前端不直接呼叫 service-role-only 的 RPC', rpcDirect.length === 0, rpcDirect.join(', '));
  const paWrites = frontFiles.filter(n => /from\(\s*['"]platform_admin(s|_companies)['"]\s*\)\s*\.(insert|update|delete|upsert)\(/.test(fs.readFileSync(path.join(root, n), 'utf8').replace(/\s+/g, ' ')));
  check('前端已無直接寫 platform_admins／platform_admin_companies（129）', paWrites.length === 0, paWrites.join(', '));
  const platformSrc = fs.readFileSync(path.join(root, 'platform.html'), 'utf8');
  // 130：建公司改走 company_save（DB 在同一個交易裡把建立者綁成 owner），不再另外呼叫 platform_link_company
  check('平台頁新增／修改平台管理員、建公司（含自動綁 owner）改走 callVerifiedAction', /callVerifiedAction\('platform_admin_save'/.test(platformSrc) && /callVerifiedAction\('company_save'/.test(platformSrc) && /callVerifiedAction\('company_save'/.test(settingsSrc));
  check('line-test.html（手動貼 token 的除錯頁）已刪除', !fs.existsSync(path.join(root, 'line-test.html')));

  console.log('\n=== saveSetting 呼叫端都會顯示錯誤（L1）===');
  const employeesSrc = fs.readFileSync(path.join(root, 'modules', 'employees.js'), 'utf8');
  const bookingSrc = fs.readFileSync(path.join(root, 'booking_service_admin.html'), 'utf8');
  const exported = (src, name) => grabFunction(src.slice(src.indexOf('export async function ' + name + '(')).replace(/^export\s+/, ''), name);
  const guarded = (fnSrc) => /try\s*\{[\s\S]*saveSettings?\([\s\S]*\}\s*catch\s*\(\s*e\s*\)\s*\{[\s\S]*showToast\('❌/.test(fnSrc);
  check('saveLunchDeadline 有 try/catch＋錯誤提示', guarded(exported(leaveSrc, 'saveLunchDeadline')));
  check('saveAttendanceSettings 有 try/catch＋錯誤提示', guarded(exported(leaveSrc, 'saveAttendanceSettings')));
  check('addNewDepartment 有 try/catch＋錯誤提示', guarded(exported(employeesSrc, 'addNewDepartment')));
  check('booking_service_admin saveBsSettings 有 try/catch＋錯誤提示', guarded(grabFunction(bookingSrc, 'saveBsSettings')));
  check('savePayrollPassword 有 try/catch＋錯誤提示', /try \{\s*await saveSetting\('payroll_password'[\s\S]*?catch \(e\) \{\s*showToast\('❌/.test(commonSrc));

  console.log('\n=== 既有頁面行為 ===');
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
  check('本機 Edge Function 回傳不包含 Channel Token', !/json\(\{[^\n]*\btoken\b/.test(edgeSrc));
  check('本機 Edge Function 例外訊息不直接外洩', /LINE 推播服務暫時無法使用/.test(edgeSrc) && !/error:\s*e\.message/.test(edgeSrc));

  check('管理模組快取版本已更新', /settings\.js\?v=20260927-verified130/.test(moduleIndexSrc));
  const htmlFiles = fs.readdirSync(root).filter(name => name.endsWith('.html'));
  const commonRefs = htmlFiles
    .map(name => ({ name, src: fs.readFileSync(path.join(root, name), 'utf8') }))
    .filter(file => file.src.includes('common.js'));
  const staleRefs = commonRefs.filter(file => !file.src.includes('common.js?v=20260928-payroll136'));
  check('所有 common.js 引用已同步升版', staleRefs.length === 0, staleRefs.map(file => file.name).join(', '));

  console.log(`\n  結果：${pass} 通過，${fail} 失敗`);
  if (fail > 0) process.exit(1);
})().catch(error => {
  console.error('  ❌ 測試執行失敗', error);
  process.exit(1);
});
