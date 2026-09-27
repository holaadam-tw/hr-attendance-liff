// ============================================================
// 130／131／132 前端：管理動作一律經 line-push 驗 LIFF 身分，不再直接呼叫會被撤權的 RPC、不再直接寫 companies
//
// 不連線。靜態掃描全部頁面＋用 common.js／schedules.js 原文組出函式、注入假的 callVerifiedAction 實跑。
// 反向對照：FRONTEND_ROOT 指向舊版 checkout（例如 git worktree 的 origin/main）→ 應大量失敗。
// ============================================================
const fs = require('fs');
const path = require('path');

const root = process.env.FRONTEND_ROOT || path.join(__dirname, '..');
const read = f => fs.readFileSync(path.join(root, f), 'utf8');

let pass = 0, fail = 0;
function check(name, condition, detail = '') {
  if (condition) { pass++; console.log(`  ✅ ${name}${detail ? `  → ${detail}` : ''}`); }
  else { fail++; console.log(`  ❌ ${name}${detail ? `  → ${detail}` : ''}`); }
}
function grab(source, name) {
  const start = source.search(new RegExp('(async\\s+)?function ' + name + '\\('));
  if (start < 0) return '';
  let depth = 0, opened = false;
  for (let i = start; i < source.length; i++) {
    if (source[i] === '{') { depth++; opened = true; }
    if (source[i] === '}' && --depth === 0 && opened) return source.slice(start, i + 1);
  }
  return '';
}

// 前端檔案（排除測試、node_modules、文件）
function listFiles(dir, out = []) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    if (['node_modules', 'tests', '.git', 'docs', 'openspec', 'migrations', 'supabase', 'scripts', 'reports', '.claude', '.agents', '.codex'].includes(ent.name)) continue;
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) listFiles(p, out);
    else if (/\.(html|js)$/.test(ent.name)) out.push(p);
  }
  return out;
}
const files = listFiles(root).map(p => ({ rel: path.relative(root, p).replace(/\\/g, '/'), src: fs.readFileSync(p, 'utf8') }));

console.log('\n═══════════════════════════════════════');
console.log('  前端改走 LIFF 驗證動作（130／131／132）');
console.log('═══════════════════════════════════════');

console.log('\n=== 132 會撤權的 9 支 RPC：前端 0 處直接呼叫 ===');
for (const name of ['admin_create_employee', 'admin_update_employee', 'admin_delete_pending_employee', 'approve_makeup_request', 'reject_makeup_request',
  'approve_overtime_request', 'reject_overtime_request', 'upsert_schedule', 'delete_schedule']) {
  const hits = files.filter(f => new RegExp(`rpc\\(\\s*['"\`]${name}['"\`]`).test(f.src)).map(f => f.rel);
  check(`${name}：沒有頁面直接 sb.rpc`, hits.length === 0, hits.join(', '));
}

console.log('\n=== 131 撤權的 23 支舊 RPC：前端 0 引用 ===');
const DEAD = ['bind_employee', 'bind_employee_secure', 'bind_existing_employee', 'bind_line_id', 'calculate_all_payroll', 'check_schedule_permission',
  'check_user_status', 'generate_verification_code', 'get_all_year_end_stats', 'get_annual_stats', 'get_annual_summary', 'get_company_info',
  'get_daily_schedule', 'get_employee_payroll', 'get_lunch_summary', 'get_monthly_attendance_v2', 'order_lunch', 'quick_check_in_debug',
  'quick_check_in_debug2', 'quick_check_in_v2', 'sync_late_close_overtime_request', 'update_office_locations'];
const deadHits = DEAD.flatMap(n => files.filter(f => new RegExp(`['"\`]${n}['"\`]`).test(f.src)).map(f => `${n}@${f.rel}`));
check('22 個函式名（23 個簽名）沒有任何頁面引用', deadHits.length === 0, deadHits.join(', '));

console.log('\n=== 130：companies／binding_attempts 前端不直接寫 ===');
const compWrites = files.filter(f => /from\(\s*['"]companies['"]\s*\)\s*\.(insert|update|delete|upsert)\(/.test(f.src)).map(f => f.rel);
check('沒有頁面直接寫 companies', compWrites.length === 0, compWrites.join(', '));
// health-check*.js 只用 HEAD 探測表是否存在（401 也算存在），不讀寫內容
const baHits = files.filter(f => !/^health-check/.test(f.rel) && /['"]binding_attempts['"]/.test(f.src)).map(f => f.rel);
check('沒有頁面使用 binding_attempts（健康檢查腳本只探測存在）', baHits.length === 0, baHits.join(', '));
const platform = read('platform.html'), settings = read('modules/settings.js');
check('平台頁：新增／修改公司走 company_save', /callVerifiedAction\('company_save', \{ company_id: id \|\| null, fields: row \}\)/.test(platform));
check('平台頁：啟用／暫停、核准走 company_set_status；拒絕走 company_delete_pending',
  (platform.match(/callVerifiedAction\('company_set_status'/g) || []).length === 2 && /callVerifiedAction\('company_delete_pending'/.test(platform));
check('平台頁：重複代碼顯示「公司代碼已存在」', /res\.code === 'duplicate_code'/.test(platform));
check('admin 公司管理（settings.js）也走 company_save', /callVerifiedAction\('company_save'/.test(settings));

console.log('\n=== common.js 員工管理 helper（實跑）===');
const common = read('common.js');
const helperSrc = ['verifiedEmployeeCall', 'rpcUpdateEmployee', 'rpcCreateEmployee', 'rpcDeletePendingEmployee'].map(n => grab(common, n)).join('\n');
check('找得到 verifiedEmployeeCall 等 4 個 helper', helperSrc.split('function ').length - 1 === 4);
if (helperSrc.split('function ').length - 1 === 4) {
  const make = (reply) => {
    const calls = [];
    const callVerifiedAction = async (action, payload) => { calls.push({ action, payload }); return reply(action, payload); };
    const f = new Function('callVerifiedAction', 'window', `${helperSrc}; return { rpcUpdateEmployee, rpcCreateEmployee, rpcDeletePendingEmployee };`);
    return { calls, h: f(callVerifiedAction, { currentCompanyId: 'company-a', currentAdminEmployee: { line_user_id: 'Uadmin', id: 'emp-admin' } }) };
  };
  (async () => {
    let t = make(() => ({ ok: true, data: { ok: true, result: { success: true, id: 'e1', updated_keys: ['role'] } } }));
    let r = await t.h.rpcUpdateEmployee('e1', { role: 'manager' });
    check('rpcUpdateEmployee → employee_update，帶公司，不帶任何 line_user_id', t.calls[0].action === 'employee_update' && t.calls[0].payload.company_id === 'company-a'
      && t.calls[0].payload.employee_id === 'e1' && !JSON.stringify(t.calls[0].payload).includes('Uadmin') && r.error === null && r.data.id === 'e1', JSON.stringify(t.calls[0]));
    t = make(() => ({ ok: false, code: 'duplicate_number', message: '工號已存在：E01' }));
    r = await t.h.rpcUpdateEmployee('e1', { employee_number: 'E01' }, 'company-b');
    check('失敗時 error 帶訊息與 code，data.error_code 保留（核准待審員工的工號重試靠它）',
      t.calls[0].payload.company_id === 'company-b' && r.error instanceof Error && r.error.message === '工號已存在：E01' && r.error.code === 'duplicate_number' && r.data.error_code === 'duplicate_number');
    t = make(() => ({ ok: true, data: { ok: true, result: { success: true, id: 'n1' } } }));
    r = await t.h.rpcCreateEmployee({ name: '新人' });
    check('rpcCreateEmployee → employee_create', t.calls[0].action === 'employee_create' && t.calls[0].payload.data.name === '新人' && r.data.id === 'n1');
    t = make(() => ({ ok: true, data: { ok: true, result: { success: true, name: '待審' } } }));
    r = await t.h.rpcDeletePendingEmployee('p1');
    check('rpcDeletePendingEmployee → employee_delete_pending', t.calls[0].action === 'employee_delete_pending' && t.calls[0].payload.employee_id === 'p1' && r.error === null);
    rest();
  })().catch(e => { console.error(e); process.exit(1); });
} else rest();

function rest() {
  console.log('\n=== 補卡／加班審核（schedules.js）===');
  const sched = read('modules/schedules.js');
  const fns = ['approveMakeupPunch', 'batchApproveTodayGpsMakeups', 'rejectMakeupPunch', 'approveOt', 'rejectOt'].map(n => grab(sched, n));
  const body = fns.join('\n');
  check('5 個審核函式都找得到', fns.every(Boolean));
  check('審核一律走 makeup_review／overtime_review', (body.match(/callVerifiedAction\('makeup_review'/g) || []).length === 3 && (body.match(/callVerifiedAction\('overtime_review'/g) || []).length === 2);
  check('前端不再送核准人（approver_id／currentAdminEmployee.id）', !/approver(_id|Id)\s*[:,)]/.test(body) && !/p_approver_id/.test(body) && !/currentAdminEmployee/.test(body));
  check('一鍵全批：每批最多 50 筆、一次送出', /todays\.slice\(i, i \+ 50\)/.test(body) && /request_ids: chunk\.map\(r => r\.id\)/.test(body));
  check('一鍵全批中途失敗：仍依伺服器回報的每筆結果計數、已核准的寫稽核（含 approved_ids）',
    /const results = Array\.isArray\(res\.data\?\.results\)/.test(body) && /approvedIds\.push\(x\.id\)/.test(body)
    && /writeAuditLog\('batch_approve_gps'[^\n]*approved_ids: approvedIds/.test(body) && /已通過 \$\{ok\} 筆/.test(body));

  console.log('\n=== 打卡總覽（attendance_public.html）＋ index.html ===');
  const ap = read('attendance_public.html'), idx = read('index.html');
  check('工時模式改走 employee_update（經 line-push）', /callAttendanceVerifiedAction\('employee_update', \{ employee_id: empId, updates: updates \}\)/.test(ap));
  check('排班改走 schedule_save 批次（不再送 scheduler_id）', /callAttendanceVerifiedAction\('schedule_save'/.test(ap) && !/p_scheduler_id/.test(ap));
  check('送出的身分是 LIFF access token，不是 line_user_id', /liff_access_token: token/.test(grab(ap, 'callAttendanceVerifiedAction')) && !/line_user_id/.test(grab(ap, 'callAttendanceVerifiedAction')));
  check('token 過期／缺少：清掉並回 LINE 重新登入', /reloginAttendancePublic/.test(grab(ap, 'callAttendanceVerifiedAction')) && /buildAttendancePublicLiffUrl\(\)/.test(grab(ap, 'reloginAttendancePublic')));
  check('index.html：LIFF access token 只放 sessionStorage、key＝公司＋LINE 使用者、帶 expires_at',
    /sessionStorage\.setItem\(_pubTokenKey, JSON\.stringify\(\{ token: _pubToken, expires_at: Date\.now\(\) \+ /.test(idx)
    && /_pubTokenKey = 'attendance_public_liff_token_' \+ _pubCompany \+ '_' \+ liffProfile\.userId/.test(idx) && /getLiffAccessTokenSafe\(\)/.test(idx));
  check('token 不寫進 localStorage（任何頁面）', !files.some(f => /localStorage\.setItem\([^)]*liff_token/.test(f.src)));
  check('index.html 之後用 location.href 同分頁導過去（sessionStorage 才帶得過去）', /window\.location\.href = 'attendance_public\.html\?company=/.test(idx));
  const getTok = grab(ap, 'getCachedAttendanceLiffToken');
  check('打卡總覽讀 token：sessionStorage、key 含目前 LINE 使用者、過期就刪', /sessionStorage\.getItem\(attendanceLiffTokenKey\(\)\)/.test(getTok)
    && /currentLineUserId/.test(grab(ap, 'attendanceLiffTokenKey')) && /expires_at\) > Date\.now\(\)/.test(getTok) && /clearAttendanceLiffToken\(\)/.test(getTok));
  check('存檔成功後刪 token（工時模式、排班都是）', /callAttendanceVerifiedAction\('employee_update'[^;]*;[^;]*;\s*clearAttendanceLiffToken\(\);/.test(grab(ap, 'saveHumanMode'))
    && /clearAttendanceLiffToken\(\); showToast/.test(grab(ap, 'saveHumanSchedule')));
  check('token 失效時刪 token', /clearAttendanceLiffToken\(\)/.test(grab(ap, 'reloginAttendancePublic')));
  const head = ap.slice(0, ap.indexOf('</head>'));
  const scripts = [...head.matchAll(/<script[^>]*src="([^"]+)"[^>]*>/g)].map(m => m[0]);
  check('打卡總覽不再載入 LIFF SDK（本頁沒用到）', !scripts.some(t => /liff\/edge/.test(t)));
  check('打卡總覽外部腳本全部固定版本＋SRI＋crossorigin', scripts.length === 3 && scripts.every(t => /integrity="sha384-[A-Za-z0-9+/=]{64}"/.test(t) && /crossorigin="anonymous"/.test(t))
    && scripts.some(t => /supabase-js@\d+\.\d+\.\d+\//.test(t)) && !scripts.some(t => /supabase-js@2"/.test(t)), scripts.length + ' 支');

  // 實跑：用頁面原文組出 token 讀取函式，注入假的 storage
  try {
    const src = ['attendanceLiffTokenKey', 'clearAttendanceLiffToken', 'getCachedAttendanceLiffToken'].map(n => grab(ap, n)).join('\n');
    const mkStore = () => { const m = new Map(); return { getItem: k => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: k => m.delete(k), _m: m }; };
    const build = (company, user, ss, ls) => new Function('companyId', 'currentLineUserId', 'sessionStorage', 'localStorage',
      `${src}; return { get: getCachedAttendanceLiffToken, clear: clearAttendanceLiffToken, key: attendanceLiffTokenKey };`)(company, user, ss, ls);
    const ss = mkStore(), ls = mkStore();
    ss.setItem('attendance_public_liff_token_C1_Uaaa', JSON.stringify({ token: 'tok-a', expires_at: Date.now() + 60000 }));
    let f = build('C1', 'Uaaa', ss, ls);
    check('（實跑）同一位使用者、未過期：拿得到 token', f.get() === 'tok-a');
    f = build('C1', 'Ubbb', ss, ls);
    check('（實跑）同裝置換成另一位 LINE 使用者：拿不到上一位的 token', f.get() === null);
    f = build('C2', 'Uaaa', ss, ls);
    check('（實跑）換公司：拿不到', f.get() === null);
    ss.setItem('attendance_public_liff_token_C1_Uaaa', JSON.stringify({ token: 'tok-a', expires_at: Date.now() - 1 }));
    f = build('C1', 'Uaaa', ss, ls);
    check('（實跑）過期：拿不到且刪掉', f.get() === null && ss.getItem('attendance_public_liff_token_C1_Uaaa') === null);
    ss.setItem('attendance_public_liff_token_C1_Uaaa', JSON.stringify({ token: 'tok-a', expires_at: Date.now() + 60000 }));
    ls.setItem('attendance_public_liff_token_C1', 'legacy');
    f.clear();
    check('（實跑）clear：刪 sessionStorage 的 token 與舊版 localStorage key', ss.getItem('attendance_public_liff_token_C1_Uaaa') === null && ls.getItem('attendance_public_liff_token_C1') === null);
    ls.setItem('attendance_public_liff_token_C1', 'legacy-token');
    check('（實跑）不讀 localStorage（舊版存法不再採用）', f.get() === null);
    ss.setItem('attendance_public_liff_token_C1_Uaaa', 'not-json');
    check('（實跑）內容壞掉：當作沒有', f.get() === null);
  } catch (e) { check('（實跑）token 讀取函式可執行', false, e.message); }

  console.log('\n=== 快取版本 ===');
  const htmls = files.filter(f => f.rel.endsWith('.html') && /common\.js\?v=/.test(f.src));
  const versions = [...new Set(htmls.map(f => f.src.match(/common\.js\?v=([^"']+)/)[1]))];
  check('所有頁面的 common.js 版本一致且已更新（不是 PR #2 的 linesecure2）', versions.length === 1 && versions[0] !== '20260927-linesecure2', versions.join(','));
  const modIdx = read('modules/index.js');
  check('modules/index.js 的 schedules.js／settings.js 版本已更新', !/schedules\.js\?v=20260927-linebudget/.test(modIdx) && !/settings\.js\?v=20260927-linesecure2/.test(modIdx));
  check('admin.html 的 modules/index.js 版本已更新', !/modules\/index\.js\?v=20260927-linesecure2/.test(read('admin.html')));

  console.log(`\n結果：${pass} 通過、${fail} 失敗`);
  process.exit(fail > 0 ? 1 : 0);
}
