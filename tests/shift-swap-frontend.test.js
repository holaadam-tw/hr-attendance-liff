// ============================================================
// 139／140 前端：員工端換班（申請、對方同意／拒絕）改走 line-push 驗證動作，不再直接寫 shift_swap_requests
//
// 不連線。靜態掃描全部頁面＋用 schedule.html 原文組出函式、注入假的 sb／callVerifiedAction 實跑。
// 反向對照：FRONTEND_ROOT 指向舊版 checkout（例如 PR #6 的 HEAD）→ 應失敗。
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
console.log('  前端不直接寫 shift_swap_requests（139／140）');
console.log('═══════════════════════════════════════');

console.log('\n=== 靜態掃描：全部頁面 ===');
const hits = [];
for (const f of files) {
  const re = /from\(\s*['"`]shift_swap_requests['"`]\s*\)/g;
  let m;
  while ((m = re.exec(f.src))) {
    const stmt = f.src.slice(m.index, f.src.indexOf(';', m.index) + 1 || undefined);
    const w = stmt.match(/\.(insert|update|upsert|delete)\s*\(/);
    if (w) hits.push(`${f.rel}:${f.src.slice(0, m.index).split('\n').length}(${w[1]})`);
  }
}
check('shift_swap_requests：沒有頁面直接 insert／update／upsert／delete（140 撤權的前提）', hits.length === 0, hits.join(', '));
const reads = files.filter(f => /from\(\s*['"]shift_swap_requests['"]\s*\)/.test(f.src)).map(f => f.rel);
check('讀取照舊（140 只撤寫入）：班表頁與後台仍讀換班申請', reads.includes('schedule.html') && reads.includes('modules/schedules.js'), reads.join(', '));

const page = read('schedule.html');
const submitSrc = grab(page, 'submitSwapRequest'), agreeSrc = grab(page, 'agreeSwap'), declineSrc = grab(page, 'declineSwap');
check('submitSwapRequest／agreeSwap／declineSwap 都找得到', !!(submitSrc && agreeSrc && declineSrc));
check('不再由前端決定申請人（requester_id）或狀態（status／target_agreed）', !/requester_id|target_agreed|status:\s*'/.test(submitSrc + agreeSrc + declineSrc));

function makeEnv({ reply = (action, payload) => ({ ok: true, data: { ok: true, result: action === 'shift_swap_create'
  ? { success: true, id: 'sw-new', requester_shift: '早班', target_shift: '晚班' }
  : { success: true, status: payload.decision === 'agree' ? 'pending_admin' : 'rejected' } } }), confirmAnswer = true } = {}) {
  const calls = [], sbCalls = [], toasts = [], notifies = [], adminNotifies = [], reloads = [];
  const inputs = { swapDate: { value: '2026-10-05' }, swapTarget: { value: '00000000-0000-0000-0000-0000000000e5' }, swapReason: { value: '家裡有事' }, swapModal: { style: {} } };
  const chain = (table) => {
    const q = {
      select() { return q; }, eq() { return q; }, or() { return q; }, order() { return q; }, limit() { return q; }, neq() { return q; },
      maybeSingle: async () => ({ data: table === 'schedules' ? { shift_types: { name: '晚班' } } : null }),
      then(res) { return Promise.resolve({ data: [], error: null }).then(res); },
    };
    for (const w of ['insert', 'update', 'upsert', 'delete']) q[w] = () => { sbCalls.push(`${table}.${w}`); const p = Promise.resolve({ error: null }); p.eq = () => p; return p; };
    return q;
  };
  const env = {
    sb: { from: (t) => chain(t) },
    window: { currentCompanyId: 'co-a' },
    document: { getElementById: (id) => inputs[id] || { style: {}, value: '' } },
    currentEmployee: { id: '00000000-0000-0000-0000-0000000000e4', name: '員工四' },
    scheduleData: { '2026-10-05': { name: '早班' } },
    callVerifiedAction: async (action, payload) => { calls.push({ action, payload }); return reply(action, payload); },
    confirm: () => confirmAnswer,
    showToast: (m) => toasts.push(m), friendlyError: (e) => e.message,
    sendUserNotify: (...a) => notifies.push(a), sendAdminNotify: (...a) => adminNotifies.push(a),
    closeSwapModal: () => { inputs.swapModal.style.display = 'none'; }, loadSwapRequests: () => reloads.push(1),
  };
  return { env, calls, sbCalls, toasts, notifies, adminNotifies, reloads };
}
function build(t) {
  const names = Object.keys(t.env);
  const f = new Function(...names, `${submitSrc}\n${agreeSrc}\n${declineSrc}\nreturn { submitSwapRequest, agreeSwap, declineSwap };`);
  return f(...names.map(n => t.env[n]));
}

(async () => {
  if (!(submitSrc && agreeSrc && declineSrc)) return finish();

  console.log('\n=== 送出換班申請（submitSwapRequest，實跑）===');
  let t = makeEnv(), h = build(t);
  await h.submitSwapRequest();
  const c = t.calls[0];
  check('走 shift_swap_create（經 line-push 驗 LIFF），不再直接 insert shift_swap_requests',
    t.calls.length === 1 && c?.action === 'shift_swap_create' && t.sbCalls.length === 0, JSON.stringify(t.sbCalls));
  check('只送公司、對象、日期、原因（不送申請人／狀態／班別名稱）',
    c?.payload?.company_id === 'co-a' && c.payload.target_id === '00000000-0000-0000-0000-0000000000e5' && c.payload.swap_date === '2026-10-05'
    && c.payload.reason === '家裡有事' && Object.keys(c.payload).sort().join(',') === 'company_id,reason,swap_date,target_id', JSON.stringify(c?.payload));
  check('成功：提示、關閉視窗、重新載入、通知對方（班別用伺服器回傳的名稱）',
    /已送出/.test(t.toasts.at(-1)) && t.reloads.length === 1 && t.notifies.length === 1 && /晚班 → 早班/.test(t.notifies[0][1]), JSON.stringify(t.notifies));

  t = makeEnv({ reply: () => ({ ok: false, code: 'duplicate', message: '這一天已經向同一位同事提出換班，請等待對方或主管處理' }) });
  h = build(t);
  await h.submitSwapRequest();
  check('伺服器拒絕：顯示原因、不通知對方、不寫表', /申請失敗：這一天已經/.test(t.toasts.at(-1)) && t.notifies.length === 0 && t.sbCalls.length === 0, t.toasts.at(-1));
  t = makeEnv({ reply: () => ({ ok: false, code: 'relogin_redirect', message: 'LINE 登入已過期，正在重新登入' }) });
  h = build(t);
  await h.submitSwapRequest();
  check('LINE 登入過期：提示重新登入、不通知', /重新登入/.test(t.toasts.at(-1)) && t.notifies.length === 0);

  console.log('\n=== 對方回覆（agreeSwap／declineSwap，實跑）===');
  t = makeEnv(); h = build(t);
  await h.agreeSwap('sw-1');
  check('同意：走 shift_swap_respond（decision=agree），不直接 update',
    t.calls.length === 1 && t.calls[0].action === 'shift_swap_respond' && t.calls[0].payload.request_id === 'sw-1' && t.calls[0].payload.decision === 'agree'
    && t.calls[0].payload.company_id === 'co-a' && t.sbCalls.length === 0, JSON.stringify(t.calls));
  check('同意成功：通知主管審核', t.adminNotifies.length === 1 && /等待主管審核/.test(t.toasts.at(-1)));
  t = makeEnv({ confirmAnswer: false }); h = build(t);
  await h.agreeSwap('sw-1');
  check('同意時按取消：不送出', t.calls.length === 0);
  t = makeEnv({ reply: () => ({ ok: false, code: 'access_denied', message: '只有被邀請換班的同事本人可以回覆' }) }); h = build(t);
  await h.agreeSwap('sw-1');
  check('伺服器拒絕同意：顯示原因、不通知主管（舊版會誤報成功）', /操作失敗：只有被邀請/.test(t.toasts.at(-1)) && t.adminNotifies.length === 0, t.toasts.at(-1));
  t = makeEnv(); h = build(t);
  await h.declineSwap('sw-2');
  check('拒絕：走 shift_swap_respond（decision=decline），不直接 update',
    t.calls.length === 1 && t.calls[0].action === 'shift_swap_respond' && t.calls[0].payload.decision === 'decline' && t.sbCalls.length === 0 && /已拒絕/.test(t.toasts.at(-1)));
  t = makeEnv({ reply: () => ({ ok: false, code: 'not_pending', message: '此申請已處理過' }) }); h = build(t);
  await h.declineSwap('sw-2');
  check('伺服器拒絕拒絕動作：顯示原因（舊版會誤報已拒絕）', /操作失敗：此申請已處理過/.test(t.toasts.at(-1)), t.toasts.at(-1));

  const common = read('common.js');
  check('common.js 的 callVerifiedAction 說明列出 shift_swap_create／shift_swap_respond', /shift_swap_create／shift_swap_respond/.test(common));
  finish();
})().catch(e => { console.error(e); process.exit(1); });

function finish() {
  console.log(`\n結果：${pass} 通過、${fail} 失敗`);
  process.exit(fail > 0 ? 1 : 0);
}
