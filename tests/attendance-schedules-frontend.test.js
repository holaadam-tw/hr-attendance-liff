// ============================================================
// 133／134／135 前端：attendance／schedules 不再由前端直接寫；排班儲存、換班審核改走 line-push 驗證動作
//
// 不連線。靜態掃描全部頁面＋用 modules/schedules.js 原文組出函式、注入假的 sb／callVerifiedAction 實跑。
// 反向對照：FRONTEND_ROOT 指向舊版 checkout（例如 PR #3 的 HEAD）→ 應失敗。
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
    if (source[i] === '}' && --depth === 0 && opened) return source.slice(start, i + 1).replace(/^export\s+/, '');
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

// 找出 sb.from('<table>') 之後、同一個敘述（到下一個分號）裡的寫入方法
function directWrites(table) {
  const hits = [];
  const re = new RegExp(`from\\(\\s*['"\`]${table}['"\`]\\s*\\)`, 'g');
  for (const f of files) {
    let m;
    while ((m = re.exec(f.src))) {
      const stmt = f.src.slice(m.index, f.src.indexOf(';', m.index) + 1 || undefined);
      const w = stmt.match(/\.(insert|update|upsert|delete)\s*\(/);
      if (w) hits.push(`${f.rel}:${f.src.slice(0, m.index).split('\n').length}(${w[1]})`);
    }
  }
  return hits;
}

console.log('\n═══════════════════════════════════════');
console.log('  前端不直接寫 attendance／schedules（133／134／135）');
console.log('═══════════════════════════════════════');

console.log('\n=== 靜態掃描：全部頁面 ===');
let hits = directWrites('attendance');
check('attendance：沒有頁面直接 insert／update／upsert／delete（134 撤權後不會壞）', hits.length === 0, hits.join(', '));
hits = directWrites('schedules');
check('schedules：沒有頁面直接 insert／update／upsert／delete（135 撤權的前提）', hits.length === 0, hits.join(', '));
const readsAtt = files.filter(f => /from\(\s*['"]attendance['"]\s*\)/.test(f.src)).length;
check('讀取照舊（134／135 只撤寫入）：仍有頁面讀 attendance', readsAtt > 0, `${readsAtt} 個檔案`);

const sched = read('modules/schedules.js');
const saveSrc = grab(sched, 'saveSchedule'), approveSrc = grab(sched, 'approveSwap'), rejectSrc = grab(sched, 'rejectSwap'), copySrc = grab(sched, 'copyLastWeek');
check('saveSchedule／approveSwap／rejectSwap／copyLastWeek 都找得到', !!(saveSrc && approveSrc && rejectSrc && copySrc));
check('載入／複製上週：不再把沒有班別的列當成不存在的 morning 班', !/\|\|\s*'morning'/.test(sched) && /is_off_day \? 'off'/.test(grab(sched, 'loadShiftMgr')));
check('換班審核不再送審核人（approver_id／currentAdminEmployee.id）', !/approver_id/.test(approveSrc + rejectSrc) && !/currentAdminEmployee\?\.id/.test(approveSrc + rejectSrc));
check('換班審核不再直接寫 shift_swap_requests', !/from\('shift_swap_requests'\)[^;]*\.update\(/.test(approveSrc + rejectSrc));

// 實跑：組出假的執行環境
// tables：假的 schedules／attendance 資料，in()／gte()／lte() 會照欄位過濾
function makeEnv({ reply = () => ({ ok: true, data: { ok: true, saved_count: 1, result: { success: true, swap_date: '2026-10-05' } } }), tables = {}, confirmAnswer = true } = {}) {
  const calls = [], sbCalls = [], toasts = [], audits = [], notifies = [], renders = [];
  const status = { style: {}, textContent: '' };
  const chain = (table) => {
    let rows = (tables[table] || []).slice();
    const q = {
      _t: table,
      select() { return q; }, eq() { return q; },
      in(col, vals) { rows = rows.filter(r => vals.includes(r[col])); return q; },
      gte(col, v) { rows = rows.filter(r => r[col] >= v); return q; },
      lte(col, v) { rows = rows.filter(r => r[col] <= v); return q; },
      single: async () => ({ data: { swap_date: '2026-10-05', requester_id: 'e4', target_id: 'e5', requester: { name: '甲', id: 'e4', company_id: 'co-a' }, target: { name: '乙', id: 'e5' } } }),
      maybeSingle: async () => ({ data: null }),
      then(res) { return Promise.resolve({ count: rows.length, data: rows, error: null }).then(res); },
    };
    for (const w of ['insert', 'update', 'upsert', 'delete']) q[w] = () => { sbCalls.push(`${table}.${w}`); return Promise.resolve({ error: null }); };
    return q;
  };
  const sb = { from: (t) => chain(t), rpc: async () => ({ data: [{ id: 'st-d', code: 'D' }, { id: 'st-n', code: 'N' }] }) };
  const env = {
    sb, window: { currentCompanyId: 'co-a', currentAdminEmployee: { id: 'emp-admin', line_user_id: 'Uadmin' } },
    document: { getElementById: () => status },
    callVerifiedAction: async (action, payload) => { calls.push({ action, payload }); return reply(action, payload); },
    confirm: () => confirmAnswer, prompt: () => '人手不足',
    showToast: (m) => toasts.push(m), friendlyError: (e) => e.message,
    writeAuditLog: (...a) => audits.push(a), sendUserNotify: (...a) => notifies.push(a), loadSwapApprovals: () => {},
    setTimeout: () => {}, renderShiftTable: () => renders.push(1),
    smEmployees: [{ id: '00000000-0000-0000-0000-0000000000e2', name: '員工二' }],
    fmtDate: (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`,
    getWeekDates: () => Array.from({ length: 7 }, (_, i) => new Date(2026, 9, 5 + i)),
  };
  return { env, calls, sbCalls, toasts, audits, notifies, status, renders };
}
function build(t, original, data) {
  const names = Object.keys(t.env);
  const f = new Function(...names, 'smScheduleOriginal', 'smScheduleData',
    `${saveSrc}\n${approveSrc}\n${rejectSrc}\n${copySrc}\nreturn { saveSchedule, approveSwap, rejectSwap, copyLastWeek, state: () => ({ smScheduleOriginal, smScheduleData }) };`);
  return f(...names.map(n => t.env[n]), original, data);
}

(async () => {
  if (!(saveSrc && approveSrc && rejectSrc && copySrc)) { finish(); return; }
  console.log('\n=== 後台排班儲存（saveSchedule，實跑）===');
  const K = (e, d) => `${e}_2026-10-0${d}`;
  const e1 = '00000000-0000-0000-0000-0000000000e1', e2 = '00000000-0000-0000-0000-0000000000e2', e3 = '00000000-0000-0000-0000-0000000000e3', e4 = '00000000-0000-0000-0000-0000000000e4';
  const baseRows = () => [
    { id: 's1', employee_id: e1, date: '2026-10-05', notes: '支援外場' },
    { id: 's2', employee_id: e2, date: '2026-10-05', notes: null },
    { id: 's3', employee_id: e3, date: '2026-10-05', notes: null },
  ];
  let t = makeEnv({ tables: { schedules: baseRows(), attendance: [] } });
  let h = build(t, { [K(e1, 5)]: 'D', [K(e2, 5)]: 'N', [K(e3, 5)]: 'D' }, { [K(e1, 5)]: 'N', [K(e2, 5)]: null, [K(e3, 5)]: 'D', [K(e4, 6)]: 'off' });
  await h.saveSchedule();
  const items = t.calls[0]?.payload?.items || [];
  const byEmp = Object.fromEntries(items.map(i => [i.employee_id, i]));
  check('只走 schedule_save（經 line-push 驗 LIFF），不再直接 upsert schedules', t.calls.length === 1 && t.calls[0].action === 'schedule_save' && t.sbCalls.length === 0, JSON.stringify(t.sbCalls));
  check('只送有變更的 3 格（沒動的不重寫）', items.length === 3 && !byEmp[e3], JSON.stringify(items));
  check('改班別 → shift_type_id；清成未排 → delete；休 → is_off_day',
    byEmp[e1]?.shift_type_id === 'st-n' && byEmp[e1]?.date === '2026-10-05' && byEmp[e2]?.delete === true && byEmp[e4]?.is_off_day === true && byEmp[e4]?.shift_type_id === null);
  check('改動的格子沿用原本的備註（畫面不能編輯備註，不會被清掉）', byEmp[e1]?.notes === '支援外場' && byEmp[e4]?.notes === null, JSON.stringify(byEmp[e1]));
  check('帶公司、不帶任何排班人／LINE ID', t.calls[0]?.payload?.company_id === 'co-a' && !/Uadmin|emp-admin|scheduler/.test(JSON.stringify(t.calls[0]?.payload)));
  check('成功後以目前班表為新基準（再按一次不會重送）', JSON.stringify(h.state().smScheduleOriginal) === JSON.stringify(Object.fromEntries(Object.entries(h.state().smScheduleData).filter(([, v]) => v))) && /已儲存 3 筆/.test(t.status.textContent));
  t.calls.length = 0;
  await h.saveSchedule();
  check('沒有變更：不呼叫伺服器', t.calls.length === 0 && /沒有排班變更/.test(t.status.textContent));

  t = makeEnv({ tables: { schedules: baseRows(), attendance: [] }, confirmAnswer: false });
  h = build(t, { [K(e1, 5)]: 'D' }, { [K(e1, 5)]: 'N' });
  await h.saveSchedule();
  check('覆蓋既有排班時按取消：不送出', t.calls.length === 0);

  // 已被打卡紀錄引用的排班（attendance.schedule_id）不能刪：保留該格、其餘照存、告知是哪幾格
  t = makeEnv({ tables: { schedules: baseRows(), attendance: [{ schedule_id: 's2' }] } });
  h = build(t, { [K(e1, 5)]: 'D', [K(e2, 5)]: 'N' }, { [K(e1, 5)]: 'N', [K(e2, 5)]: null });
  await h.saveSchedule();
  let sent = t.calls[0]?.payload?.items || [];
  check('清除已有打卡紀錄的排班：不送刪除、其餘照存（不會整批失敗）', sent.length === 1 && sent[0].employee_id === e1 && !sent.some(i => i.delete), JSON.stringify(sent));
  check('該格還原成原本的班別並告知（含員工與日期）', h.state().smScheduleData[K(e2, 5)] === 'N' && /1 格已有打卡紀錄，保留原排班未刪除（員工二 2026-10-05）/.test(t.status.textContent) && t.renders.length === 1, t.status.textContent);
  t = makeEnv({ tables: { schedules: baseRows(), attendance: [{ schedule_id: 's2' }] } });
  h = build(t, { [K(e2, 5)]: 'N' }, { [K(e2, 5)]: null });
  await h.saveSchedule();
  check('只有被引用的刪除：不呼叫伺服器、說明原因', t.calls.length === 0 && /沒有可儲存的變更.*已有打卡紀錄/.test(t.status.textContent), t.status.textContent);
  t = makeEnv({ tables: { schedules: baseRows(), attendance: [] }, reply: () => ({ ok: false, code: 'item_failed', message: 'update or delete on table "schedules" violates foreign key constraint' }) });
  h = build(t, { [K(e2, 5)]: 'N' }, { [K(e2, 5)]: null });
  await h.saveSchedule();
  check('送出後才遇到外鍵錯誤（同時有人打卡）：顯示看得懂的訊息，不是原始 SQL 錯誤', /已被打卡紀錄使用/.test(t.status.textContent) && !/foreign key/.test(t.status.textContent), t.status.textContent);

  // 班別已不存在的格子：不存、告知，而且下次仍算未存（不會假裝存好了）
  t = makeEnv({ tables: { schedules: [], attendance: [] } });
  h = build(t, {}, { [K(e1, 5)]: 'N', [K(e2, 6)]: 'morning' });
  await h.saveSchedule();
  check('班別已不存在的格子：不送、告知，基準不更新', (t.calls[0]?.payload?.items || []).length === 1 && /1 格的班別已不存在，未儲存/.test(t.status.textContent)
    && h.state().smScheduleOriginal[K(e2, 6)] === undefined && h.state().smScheduleOriginal[K(e1, 5)] === 'N', t.status.textContent);

  console.log('\n=== 複製上週（copyLastWeek，實跑）===');
  t = makeEnv({ tables: { schedules: [
    { employee_id: e1, date: '2026-09-28', is_off_day: false, shift_types: { code: 'D', name: '早班' } },
    { employee_id: e2, date: '2026-09-28', is_off_day: true, shift_types: null },
    { employee_id: e3, date: '2026-09-28', is_off_day: false, shift_types: null },
  ] } });
  h = build(t, {}, {});
  await h.copyLastWeek();
  const cd = h.state().smScheduleData;
  check('上週休假照抄成「休」、上班照抄班別、沒有班別的列不抄（不再變成不存在的 morning）',
    cd[K(e1, 5)] === 'D' && cd[K(e2, 5)] === 'off' && cd[K(e3, 5)] === undefined && /已複製上週 2 筆/.test(t.toasts.at(-1)), JSON.stringify(cd));

  t = makeEnv({ reply: () => ({ ok: false, code: 'access_denied', message: '沒有排班權限' }) });
  h = build(t, {}, { [K(e1, 5)]: 'D' });
  await h.saveSchedule();
  check('伺服器拒絕：顯示原因、基準不更新（可修正後重送）', /沒有排班權限/.test(t.status.textContent) && Object.keys(h.state().smScheduleOriginal).length === 0, t.status.textContent);

  t = makeEnv();
  const big = {};
  for (let i = 0; i < 450; i++) big[`${String(i).padStart(8, '0')}-0000-0000-0000-000000000000_2026-10-05`] = 'D';
  h = build(t, {}, big);
  await h.saveSchedule();
  check('超過 400 格：分批（400＋50）', t.calls.length === 2 && t.calls[0]?.payload?.items?.length === 400 && t.calls[1]?.payload?.items?.length === 50);

  console.log('\n=== 換班審核（approveSwap／rejectSwap，實跑）===');
  t = makeEnv();
  h = build(t, {}, {});
  await h.approveSwap('sw-1');
  check('核准：走 shift_swap_review（decision=approve），不再直接改 schedules／shift_swap_requests',
    t.calls.length === 1 && t.calls[0]?.action === 'shift_swap_review' && t.calls[0]?.payload?.request_id === 'sw-1' && t.calls[0]?.payload?.decision === 'approve'
    && t.calls[0]?.payload?.company_id === 'co-a' && t.sbCalls.length === 0, JSON.stringify(t.sbCalls));
  check('核准成功：寫稽核、通知雙方', t.audits.length === 1 && t.notifies.length === 2 && /已核准/.test(t.toasts.at(-1)));
  t = makeEnv({ reply: () => ({ ok: false, code: 'schedule_missing', message: '雙方當天都必須已有排班，才能核准換班' }) });
  h = build(t, {}, {});
  await h.approveSwap('sw-1');
  check('核准失敗：顯示伺服器原因、不寫稽核也不通知', t.notifies.length === 0 && t.audits.length === 0 && /雙方當天/.test(t.toasts.at(-1)), t.toasts.at(-1));
  t = makeEnv();
  h = build(t, {}, {});
  await h.rejectSwap('sw-2');
  check('拒絕：走 shift_swap_review（decision=reject、帶原因），不直接寫表',
    t.calls[0]?.action === 'shift_swap_review' && t.calls[0]?.payload?.decision === 'reject' && t.calls[0]?.payload?.reason === '人手不足' && t.sbCalls.length === 0);

  console.log('\n=== 快取版本 ===');
  const modIdx = read('modules/index.js');
  check('modules/index.js 的 schedules.js 版本已更新（不是 PR #3 的 verified130）', /schedules\.js\?v=/.test(modIdx) && !/schedules\.js\?v=20260927-verified130/.test(modIdx));
  check('admin.html 的 modules/index.js 版本已更新', !/modules\/index\.js\?v=20260927-verified130/.test(read('admin.html')));
  finish();
})().catch(e => { console.error(e); process.exit(1); });

function finish() {
  console.log(`\n結果：${pass} 通過、${fail} 失敗`);
  process.exit(fail > 0 ? 1 : 0);
}
