// ============================================================
// migration 139／140：shift_swap_requests 只能經伺服器端函式寫入 — PGlite 實跑
//
// 不連線、不寫正式庫。流程：
//   1. 載入正式庫快照（phase0_prod_snapshot.sql＋attendance_schedules_prod_snapshot.sql；
//      shift_swap_requests 的政策「Allow all for authenticated」FOR ALL TO public、grant 全開，皆取自正式庫）
//   2. 以 PR #3／#5 上線後的狀態（130～135 已套）為起點，先重現：anon／authenticated 可直接新增、改、刪任何人的換班申請
//   3. 套 139：員工申請（申請人＝LINE 驗證的本人）、對方同意／拒絕（只有對象本人）各種情境；舊頁面仍可直接寫（相容期）
//   4. 套 140：直接寫入全部被擋、讀取照常；申請 → 同意 → 主管核准（133）整條流程照常
//   5. 順序防呆、回滾後政策／grant 與正式庫快照逐項相同、可重複套用
// 反向對照（證明測試在舊程式會失敗）：MIGRATION139_FILE／MIGRATION140_FILE 指向空檔 → 大量失敗
// ============================================================
const fs = require('fs');
const path = require('path');
const { PGlite } = require('@electric-sql/pglite');

const root = path.join(__dirname, '..');
const read = f => fs.readFileSync(f, 'utf8');
const snapshot = read(path.join(__dirname, 'fixtures', 'phase0_prod_snapshot.sql'))
  + '\n' + read(path.join(__dirname, 'fixtures', 'attendance_schedules_prod_snapshot.sql'));
const mig = n => read(path.join(root, 'migrations', n));
const base = ['130_companies_binding_attempts_lock.sql', '131_verified_admin_rpcs.sql', '132_verified_admin_rpcs_revoke.sql',
  '133_shift_swap_verified_review.sql', '134_attendance_write_lock.sql', '135_schedules_write_lock.sql'].map(mig);
const m139 = read(process.env.MIGRATION139_FILE || path.join(root, 'migrations', '139_shift_swap_verified_requests.sql'));
const m140 = read(process.env.MIGRATION140_FILE || path.join(root, 'migrations', '140_shift_swap_write_lock.sql'));
const m139rb = mig('139_shift_swap_verified_requests_rollback.sql');
const m140rb = mig('140_shift_swap_write_lock_rollback.sql');

let pass = 0, fail = 0;
function check(name, condition, detail = '') {
  if (condition) { pass++; console.log(`  ✅ ${name}${detail ? `  → ${detail}` : ''}`); }
  else { fail++; console.log(`  ❌ ${name}${detail ? `  → ${detail}` : ''}`); }
}

const A = '8a669e2c-7521-43e9-9300-5c004c57e9db';
const B = '11111111-2222-3333-4444-555555555555';
const E = {
  admin: '00000000-0000-0000-0000-0000000000a1', mgr: '00000000-0000-0000-0000-0000000000a2',
  e1: '00000000-0000-0000-0000-0000000000e1', e2: '00000000-0000-0000-0000-0000000000e2',
  e4: '00000000-0000-0000-0000-0000000000e4', e5: '00000000-0000-0000-0000-0000000000e5',
  quit: '00000000-0000-0000-0000-0000000000e8', pend: '00000000-0000-0000-0000-0000000000e7',
  kiosk: '00000000-0000-0000-0000-0000000000c1', bAdmin: '00000000-0000-0000-0000-0000000000b1', bUser: '00000000-0000-0000-0000-0000000000b2',
};
const ST = { day: '00000000-0000-0000-0000-00000000cd01', night: '00000000-0000-0000-0000-00000000cd02', b: '00000000-0000-0000-0000-00000000cd03' };
// 日期以「今天（台北）」往後推，測試不會因日期過去而失效（139 拒絕過去的日期）
const taipeiPlus = n => { const d = new Date(Date.now() + 8 * 3600 * 1000); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const D1 = taipeiPlus(7), D2 = taipeiPlus(8), OFF = taipeiPlus(9), D3 = taipeiPlus(10), PAST = taipeiPlus(-1);
const FAKE = '00000000-0000-0000-0000-00000000ff01';

(async () => {
  console.log('\n═══════════════════════════════════════');
  console.log('  shift_swap_requests 只能經伺服器端函式寫入（139／140，PGlite 實跑）');
  console.log('═══════════════════════════════════════');

  const db = new PGlite();
  const q = async (sql, params) => (await db.query(sql, params)).rows;
  const one = async (sql, params) => (await q(sql, params))[0];
  await db.exec(snapshot);

  async function as(role, sql, params) {
    try {
      await db.exec(`SET ROLE ${role}`);
      return { rows: (await db.query(sql, params)).rows };
    } catch (e) {
      return { error: e.message };
    } finally {
      await db.exec('RESET ROLE');
    }
  }
  const rpc = async (role, fn, args) => {
    const keys = Object.keys(args);
    const r = await as(role, `SELECT public.${fn}(${keys.map((k, i) => `${k} => $${i + 1}`).join(', ')}) AS r`, keys.map(k => args[k]));
    return r.error ? { error: r.error } : r.rows[0].r;
  };
  async function apply(sql) {
    try {
      await db.exec('SET ROLE prod_postgres');
      await db.exec(sql);
      return '';
    } catch (e) {
      try { await db.exec('ROLLBACK'); } catch (_) { /* 沒有進行中的交易 */ }
      return e.message;
    } finally {
      await db.exec('RESET ROLE');
    }
  }
  const denied = r => typeof r?.error === 'string' && /permission denied/.test(r.error);
  const relAcl = async (t) => (await q(`SELECT coalesce(r.rolname, 'PUBLIC') AS g, a.privilege_type AS p
      FROM aclexplode((SELECT relacl FROM pg_class WHERE oid = $1::regclass)) a LEFT JOIN pg_roles r ON r.oid = a.grantee
      WHERE coalesce(r.rolname, 'PUBLIC') <> 'prod_postgres' ORDER BY 1, 2`, ['public.' + t])).map(x => x.g + ':' + x.p).join(',');
  const pols = async (t) => (await q(`SELECT policyname, permissive, roles::text AS roles, cmd, qual, with_check FROM pg_policies
      WHERE schemaname = 'public' AND tablename = $1 ORDER BY policyname`, [t])).map(x => JSON.stringify(x)).join('\n');
  const snap = { acl: await relAcl('shift_swap_requests'), pol: await pols('shift_swap_requests') };
  const swCount = async () => (await one(`SELECT count(*)::int AS n FROM public.shift_swap_requests`)).n;
  const swRow = id => one(`SELECT *, swap_date::text AS d FROM public.shift_swap_requests WHERE id = $1`, [id]);
  const schedOf = (emp, d) => one(`SELECT shift_type_id, is_off_day FROM public.schedules WHERE employee_id = $1 AND date = $2`, [emp, d]);

  async function seed() {
    await db.exec(`
      DELETE FROM public.attendance_anomalies; DELETE FROM public.shift_swap_requests; DELETE FROM public.attendance;
      DELETE FROM public.schedules; DELETE FROM public.makeup_punch_requests;
      DELETE FROM public.shift_types; DELETE FROM public.platform_admin_companies; DELETE FROM public.platform_admins;
      DELETE FROM public.employees; DELETE FROM public.binding_attempts; DELETE FROM public.companies;
      INSERT INTO public.companies (id, code, name, status) VALUES ('${A}', 'ACO', '大正科技', 'active'), ('${B}', 'BCO', '別家公司', 'active');
      INSERT INTO public.employees (id, company_id, employee_number, name, line_user_id, role, is_kiosk, status, is_active) VALUES
        ('${E.admin}', '${A}', 'A01', '主管甲', 'Uadmin', 'admin', false, 'approved', true),
        ('${E.mgr}', '${A}', 'A02', '主管乙', 'Umgr', 'manager', false, 'approved', true),
        ('${E.e1}', '${A}', 'E01', '員工一', 'U1', 'user', false, 'approved', true),
        ('${E.e2}', '${A}', 'E02', '員工二', 'U2', 'user', false, 'approved', true),
        ('${E.e4}', '${A}', 'E04', '員工四', 'U4', 'user', false, 'approved', true),
        ('${E.e5}', '${A}', 'E05', '員工五', 'U5', 'user', false, 'approved', true),
        ('${E.quit}', '${A}', 'E08', '已離職', 'Uquit', 'user', false, 'resigned', false),
        ('${E.pend}', '${A}', 'E07', '待審核', 'Upend', 'user', false, 'pending', true),
        ('${E.kiosk}', '${A}', 'K01', '公務機', 'Ukiosk', 'user', true, 'approved', true),
        ('${E.bAdmin}', '${B}', 'B01', '別家主管', 'UBadmin', 'admin', false, 'approved', true),
        ('${E.bUser}', '${B}', 'B02', '別家員工', 'UB1', 'user', false, 'approved', true);
      INSERT INTO public.shift_types (id, code, name, start_time, end_time, company_id) VALUES
        ('${ST.day}', 'D', '早班', '08:00', '17:00', '${A}'), ('${ST.night}', 'N', '晚班', '14:00', '23:00', '${A}'),
        ('${ST.b}', 'D', 'B 早班', '08:00', '17:00', '${B}');
      INSERT INTO public.schedules (employee_id, date, shift_type_id) VALUES
        ('${E.e4}', '${D1}', '${ST.day}'), ('${E.e5}', '${D1}', '${ST.night}'),
        ('${E.e4}', '${D2}', '${ST.day}'), ('${E.e5}', '${D2}', '${ST.night}'),
        ('${E.e1}', '${D1}', '${ST.day}'), ('${E.e1}', '${OFF}', '${ST.day}'),
        ('${E.quit}', '${D1}', '${ST.day}'), ('${E.pend}', '${D1}', '${ST.day}'), ('${E.kiosk}', '${D1}', '${ST.day}'),
        ('${E.bUser}', '${D1}', '${ST.b}'), ('${E.e4}', '${PAST}', '${ST.day}'), ('${E.e5}', '${PAST}', '${ST.night}'),
        ('${E.e1}', '${D3}', '${ST.day}'), ('${E.e2}', '${D3}', '${ST.night}');
      INSERT INTO public.schedules (employee_id, date, shift_type_id, is_off_day) VALUES ('${E.e2}', '${OFF}', NULL, true);
    `);
  }

  // ---------- 0. 起點：PR #3／#5 上線後（130～135 已套） ----------
  let err = '';
  for (const m of base) err = err || await apply(m);
  check('起點：以正式庫擁有者身分套 130～135（PR #3／#5 上線後的狀態）', err === '', err);
  await seed();

  // ---------- 1. 套用前：重現 ----------
  console.log('\n=== 套用前：重現直接寫表 ===');
  let r = await as('anon', `INSERT INTO public.shift_swap_requests (id, requester_id, target_id, swap_date, status, target_agreed)
      VALUES ($1, $2, $3, $4, 'pending_admin', true) RETURNING id`, [FAKE, E.e4, E.e5, D1]);
  check('現況重現：anon 以別人的名義新增「對方已同意」的換班申請（跳過對方同意）', !r.error && r.rows.length === 1, r.error);
  r = await as('authenticated', `UPDATE public.shift_swap_requests SET status = 'approved', target_agreed = true WHERE id = $1 RETURNING id`, [FAKE]);
  check('現況重現：authenticated 直接把申請改成已核准', !r.error && r.rows.length === 1, r.error);
  r = await as('anon', `DELETE FROM public.shift_swap_requests WHERE id = $1 RETURNING id`, [FAKE]);
  check('現況重現：anon 直接刪申請', !r.error && r.rows.length === 1, r.error);
  r = await one(`SELECT has_table_privilege('anon', 'public.shift_swap_requests', 'TRUNCATE') AS t`);
  check('現況重現：anon 有 TRUNCATE 權限', r.t === true);
  r = await rpc('service_role', 'shift_swap_request_create', { p_company_id: A, p_line_user_id: 'U4', p_target_id: E.e5, p_swap_date: D1, p_reason: null });
  check('套用前：shift_swap_request_create 不存在', /does not exist/.test(r?.error || ''), r?.error);
  err = await apply(m140);
  check('順序防呆：139 未套時套 140 → 中止（不會先撤權把換班申請弄壞）', /139/.test(err), err);
  check('中止後政策／grant 未變', (await pols('shift_swap_requests')) === snap.pol && (await relAcl('shift_swap_requests')) === snap.acl);

  // ---------- 2. 套 139 ----------
  console.log('\n=== 套用 139（員工端換班新路徑）===');
  err = await apply(m139);
  check('139 可在 PostgreSQL 套用（正式庫擁有者身分）', err === '', err);
  const create = (uid, target, date, company = A, reason = null) => rpc('service_role', 'shift_swap_request_create',
    { p_company_id: company, p_line_user_id: uid, p_target_id: target, p_swap_date: date, p_reason: reason });
  const respond = (uid, id, decision, company = A) => rpc('service_role', 'shift_swap_request_respond',
    { p_company_id: company, p_line_user_id: uid, p_request_id: id, p_decision: decision });
  for (const role of ['anon', 'authenticated']) {
    r = await rpc(role, 'shift_swap_request_create', { p_company_id: A, p_line_user_id: 'U4', p_target_id: E.e5, p_swap_date: D1, p_reason: null });
    check(`${role} 不能直接呼叫 shift_swap_request_create（必須經 Edge Function 驗 LIFF）`, denied(r), r?.error);
    r = await rpc(role, 'shift_swap_request_respond', { p_company_id: A, p_line_user_id: 'U5', p_request_id: FAKE, p_decision: 'agree' });
    check(`${role} 不能直接呼叫 shift_swap_request_respond`, denied(r), r?.error);
  }
  const acl = await one(`SELECT
      (SELECT proacl::text FROM pg_proc WHERE oid = to_regprocedure('public.shift_swap_request_create(uuid, text, uuid, date, text)')) AS c,
      (SELECT proacl::text FROM pg_proc WHERE oid = to_regprocedure('public.shift_swap_request_respond(uuid, text, uuid, text)')) AS r`);
  check('兩支函式只有擁有者與 service_role 可執行（沒有 PUBLIC）', !!acl.c && !!acl.r && !/(^|[{,])=X/.test(acl.c) && !/anon|authenticated/.test(acl.c + acl.r) && /service_role=X/.test(acl.c) && /service_role=X/.test(acl.r), JSON.stringify(acl));

  console.log('\n--- 申請（shift_swap_request_create）---');
  let n0 = await swCount();
  r = await create('Ukiosk', E.e5, D1);
  check('公務機帳號不能申請換班', r?.error_code === 'access_denied');
  r = await create('Uquit', E.e5, D1);
  check('離職員工不能申請換班', r?.error_code === 'access_denied');
  r = await create('Upend', E.e5, D1);
  check('待審核員工不能申請換班', r?.error_code === 'access_denied');
  r = await create('Ustranger', E.e5, D1);
  check('陌生 LINE 帳號不能申請換班', r?.error_code === 'access_denied');
  r = await create('UB1', E.e5, D1);
  check('別家公司員工帶本公司 ID 申請：找不到員工資料', r?.error_code === 'access_denied');
  r = await create('U4', E.e5, D1, B);
  check('本公司員工帶別家公司 ID：找不到員工資料', r?.error_code === 'access_denied');
  r = await create('U4', E.bUser, D1);
  check('對象是別家公司員工：拒絕', r?.error_code === 'invalid_target');
  r = await create('U4', E.kiosk, D1);
  check('對象是公務機：拒絕', r?.error_code === 'invalid_target');
  r = await create('U4', E.quit, D1);
  check('對象已離職：拒絕', r?.error_code === 'invalid_target');
  r = await create('U4', E.pend, D1);
  check('對象待審核：拒絕', r?.error_code === 'invalid_target');
  r = await create('U4', E.e4, D1);
  check('對象是自己：拒絕', r?.error_code === 'invalid_target');
  r = await create('U4', E.e2, D1);
  check('對象當天沒有排班：拒絕', r?.error_code === 'schedule_missing');
  r = await create('U2', E.e4, D2);
  check('申請人當天沒有排班：拒絕', r?.error_code === 'schedule_missing');
  r = await create('U4', null, D1);
  check('沒選對象：拒絕', r?.error_code === 'invalid_value');
  r = await create('U4', E.e5, PAST);
  check('過去的日期：拒絕（雙方當天都有排班也一樣）', r?.error_code === 'past_date');
  await db.exec(`INSERT INTO public.employees (id, company_id, employee_number, name, line_user_id, role, is_kiosk, status, is_active) VALUES
    ('00000000-0000-0000-0000-0000000000d1', '${A}', 'D01', '重複一', 'Udup', 'user', false, 'approved', true),
    ('00000000-0000-0000-0000-0000000000d2', '${A}', 'D02', '重複二', 'Udup', 'user', false, 'approved', true)`);
  r = await create('Udup', E.e5, D1);
  check('同一公司同一個 LINE 帳號對到兩位在職員工：拒絕（不猜是哪一位）', r?.error_code === 'ambiguous_employee');
  check('以上被拒的申請都沒有寫入', (await swCount()) === n0);

  r = await create('U4', E.e5, D1, A, '  家裡有事  ');
  const req1 = r?.id || FAKE;
  let row = req1 && await swRow(req1);
  check('正常申請：申請人＝LINE 驗證的本人、對象、日期、狀態 pending_target、對方尚未同意',
    r?.success === true && row?.requester_id === E.e4 && row.target_id === E.e5 && row.d === D1, JSON.stringify(r));
  check('正常申請：班別名稱由 DB 依排班現查（早班 ↔ 晚班）、原因去頭尾空白',
    row?.requester_original_shift === '早班' && row.target_original_shift === '晚班' && row.reason === '家裡有事'
    && row.status === 'pending_target' && row.target_agreed === null && row.approver_id === null && r.target_shift === '晚班', JSON.stringify(row));
  r = await create('U4', E.e5, D1);
  check('同一對象同一天已有進行中的申請：不重複建立', r?.error_code === 'duplicate' && (await swCount()) === n0 + 1);
  r = await create('U5', E.e4, D1);
  check('反方向重複（對方已向我提出同一天的申請）：不重複建立', r?.error_code === 'duplicate' && (await swCount()) === n0 + 1);
  r = await q(`SELECT 1`).then(() => as('service_role', `INSERT INTO public.shift_swap_requests (requester_id, target_id, swap_date, status) VALUES ($1, $2, $3, 'pending_target')`, [E.e5, E.e4, D1]));
  check('唯一索引：同兩人同一天第二筆進行中的申請（例如同時送出）寫不進去', /unique|duplicate key/.test(r.error || ''), r.error);
  r = await create('U1', E.e2, OFF);
  row = r?.id && await swRow(r.id);
  check('對方當天是休假：可以申請、班別顯示「休假」', r?.success === true && row?.target_original_shift === '休假' && row.requester_original_shift === '早班', JSON.stringify(row));
  r = await create('U4', E.e5, D2, A, 'x'.repeat(800));
  const req2 = r?.id || FAKE;
  check('原因超過 500 字：截斷', r?.success === true && (await swRow(req2))?.reason?.length === 500);

  console.log('\n--- 對方回覆（shift_swap_request_respond）---');
  r = await respond('U4', req1, 'agree');
  check('申請人自己按同意：拒絕（只有對象本人能回覆）', r?.error_code === 'access_denied' && (await swRow(req1)).status === 'pending_target');
  r = await respond('U1', req1, 'agree');
  check('第三人按同意：拒絕', r?.error_code === 'access_denied' && (await swRow(req1)).status === 'pending_target');
  r = await respond('Uadmin', req1, 'agree');
  check('主管也不能代替對象同意（主管走 133 審核）', r?.error_code === 'access_denied');
  r = await respond('UBadmin', req1, 'agree', B);
  check('別家公司帶自己公司 ID：找不到申請', r?.error_code === 'not_found');
  r = await respond('UB1', req1, 'agree');
  check('別家公司員工帶本公司 ID：找不到員工資料', r?.error_code === 'access_denied');
  r = await respond('U5', req1, 'approve');
  check('動作只能 agree／decline', r?.error_code === 'invalid_value' && (await swRow(req1)).status === 'pending_target');
  r = await create('U1', E.e2, D3);
  const reqDup = r?.id || FAKE;
  await db.exec(`UPDATE public.employees SET line_user_id = 'U2' WHERE id = '00000000-0000-0000-0000-0000000000d1'`);
  r = await respond('U2', reqDup, 'agree');
  check('對象的 LINE 帳號同時對到另一位員工：仍以申請列的對象比對、同意成功（不會因先對到別人而被拒）', r?.success === true && (await swRow(reqDup)).status === 'pending_admin', JSON.stringify(r));
  await db.exec(`UPDATE public.employees SET line_user_id = 'Udup' WHERE id = '00000000-0000-0000-0000-0000000000d1'`);
  r = await respond('U5', FAKE, 'agree');
  check('不存在的申請：not_found', r?.error_code === 'not_found');
  await db.exec(`UPDATE public.employees SET is_active = false WHERE id = '${E.e5}'`);
  r = await respond('U5', req1, 'agree');
  check('對象已停用：不能回覆', r?.error_code === 'access_denied' && (await swRow(req1)).status === 'pending_target');
  await db.exec(`UPDATE public.employees SET is_active = true WHERE id = '${E.e5}'`);
  r = await respond('U5', req1, 'agree');
  row = await swRow(req1);
  check('對象本人同意：pending_admin、target_agreed = true', r?.success === true && row.status === 'pending_admin' && row.target_agreed === true, JSON.stringify(r));
  r = await respond('U5', req1, 'decline');
  check('已回覆過：不能再改（not_pending）', r?.error_code === 'not_pending' && (await swRow(req1)).status === 'pending_admin');
  r = await respond('U5', req2, 'decline');
  row = await swRow(req2);
  check('對象本人拒絕：rejected、原因「對方不同意」', r?.success === true && row.status === 'rejected' && row.target_agreed === false && row.rejection_reason === '對方不同意', JSON.stringify(row));

  r = await as('anon', `INSERT INTO public.shift_swap_requests (requester_id, target_id, swap_date, status) VALUES ($1, $2, $3, 'pending_target') RETURNING id`, [E.e1, E.e2, D1]);
  check('140 之前：舊頁面直接寫入仍可用（相容，等快取過期）', !r.error && r.rows.length === 1, r.error);
  await db.exec(`DELETE FROM public.shift_swap_requests WHERE requester_id = '${E.e1}' AND swap_date = '${D1}'`);

  // ---------- 3. 套 140 ----------
  console.log('\n=== 套用 140（撤直接寫入）===');
  err = await apply(m140);
  check('140 可在 PostgreSQL 套用（正式庫擁有者身分）', err === '', err);
  const n1 = await swCount();
  for (const role of ['anon', 'authenticated']) {
    r = await as(role, `INSERT INTO public.shift_swap_requests (requester_id, target_id, swap_date, status, target_agreed) VALUES ($1, $2, $3, 'pending_admin', true)`, [E.e4, E.e5, D2]);
    check(`${role} 直接新增換班申請：permission denied`, denied(r), r.error);
    r = await as(role, `UPDATE public.shift_swap_requests SET status = 'approved', target_agreed = true WHERE id = $1`, [req1]);
    check(`${role} 直接改換班申請（改成已核准）：permission denied`, denied(r), r.error);
    r = await as(role, `DELETE FROM public.shift_swap_requests WHERE id = $1`, [req1]);
    check(`${role} 直接刪換班申請：permission denied`, denied(r), r.error);
    r = await as(role, `TRUNCATE public.shift_swap_requests`);
    check(`${role} TRUNCATE：permission denied`, denied(r), r.error);
    r = await as(role, `SELECT r.id, r.status, req.name AS requester, tgt.name AS target FROM public.shift_swap_requests r
        JOIN public.employees req ON req.id = r.requester_id JOIN public.employees tgt ON tgt.id = r.target_id
        WHERE r.requester_id = $1 OR r.target_id = $1 ORDER BY r.created_at DESC`, [E.e4]);
    check(`${role} 仍讀得到換班申請（班表頁、後台換班列表；讀取收斂另案）`, !r.error && r.rows.length === 2, r.error);
  }
  row = await swRow(req1);
  check('資料沒被動到', (await swCount()) === n1 && row?.status === 'pending_admin');

  console.log('\n--- 140 之後：申請 → 對方同意 → 主管核准（133）整條流程 ---');
  await db.exec(`DELETE FROM public.shift_swap_requests WHERE id = '${req2}'`);
  r = await create('U5', E.e4, D2, A, '想換早班');
  const req3 = r?.id || FAKE;
  check('140 之後：申請照常', r?.success === true && (await swRow(req3)).status === 'pending_target', JSON.stringify(r));
  r = await respond('U4', req3, 'agree');
  check('140 之後：對方同意照常', r?.success === true && (await swRow(req3)).status === 'pending_admin', JSON.stringify(r));
  r = await rpc('service_role', 'review_shift_swap_request', { p_company_id: A, p_line_user_id: 'Umgr', p_request_id: req3, p_decision: 'approve', p_reason: null });
  const s4 = await schedOf(E.e4, D2), s5 = await schedOf(E.e5, D2);
  row = await swRow(req3);
  check('140 之後：主管核准（133）照常、兩人班別互換、申請結案',
    r?.success === true && s4.shift_type_id === ST.night && s5.shift_type_id === ST.day && row.status === 'approved' && row.approver_id === E.mgr, JSON.stringify(r));
  r = await rpc('service_role', 'review_shift_swap_request', { p_company_id: A, p_line_user_id: 'Uadmin', p_request_id: req1, p_decision: 'reject', p_reason: '人手不足' });
  check('140 之後：主管拒絕照常', r?.success === true && (await swRow(req1)).status === 'rejected');
  r = await create('U4', E.e5, D1);
  check('被拒絕後可以重新申請（不算重複）', r?.success === true, JSON.stringify(r));

  // ---------- 4. 回滾、重套 ----------
  console.log('\n=== 順序防呆、回滾、重套 ===');
  err = await apply(m139rb);
  check('140 還在時回滾 139：中止', /140/.test(err), err);
  err = await apply(m140rb);
  check('140 回滾可套用', err === '', err);
  check('140 回滾：政策與 grant 與正式庫快照逐項相同', (await pols('shift_swap_requests')) === snap.pol && (await relAcl('shift_swap_requests')) === snap.acl,
    await relAcl('shift_swap_requests'));
  err = await apply(m139rb);
  check('139 回滾：兩支函式移除', err === '' && !(await one(`SELECT 1 AS x FROM pg_proc WHERE proname IN ('shift_swap_request_create', 'shift_swap_request_respond')`)), err);
  err = '';
  for (let i = 0; i < 2 && !err; i++) err = await apply(m139) || await apply(m140);
  check('139、140 可重複套用', err === '', err);
  r = await as('anon', `INSERT INTO public.shift_swap_requests (requester_id, target_id, swap_date) VALUES ($1, $2, $3)`, [E.e4, E.e5, taipeiPlus(30)]);
  check('重套後仍擋直接寫入', denied(r), r.error);
  check('重套後政策恰好 1 條（SELECT）', (await q(`SELECT cmd FROM pg_policies WHERE tablename = 'shift_swap_requests'`)).map(x => x.cmd).join(',') === 'SELECT');

  console.log(`\n結果：${pass} 通過、${fail} 失敗`);
  process.exit(fail > 0 ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
