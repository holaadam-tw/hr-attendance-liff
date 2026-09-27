// ============================================================
// migration 130／131／132：companies／binding_attempts 寫入鎖＋管理動作改由 LINE 驗證身分決定 — PGlite 實跑
//
// 不連線、不寫正式庫。流程：
//   1. 載入正式庫快照（tests/fixtures/phase0_prod_snapshot.sql：資料表、RLS、grant、proacl、函式本體逐字取自正式庫）
//   2. 套用前：逐一重現攻擊（跨公司核准補卡、冒充排班者改班表、冒充 admin 自升權限／換掉 admin 的 LINE ID、
//      anon 改／刪／新增公司、binding_attempts 可讀寫、沒人用的舊 RPC 仍可執行）
//   3. 依上線順序套 130 → 131 → 132，逐情境驗證攻擊被擋、正常流程照常
//   4. 順序防呆、回滾 132 → 131 → 130 後與正式庫快照逐項相同、可重複套用
// 反向對照（證明測試在舊程式會失敗）：
//   MIGRATION130_FILE／MIGRATION131_FILE／MIGRATION132_FILE 指向空檔 → 套用後的情境應大量失敗
// ============================================================
const fs = require('fs');
const path = require('path');
const { PGlite } = require('@electric-sql/pglite');

const root = path.join(__dirname, '..');
const read = f => fs.readFileSync(f, 'utf8');
const snapshot = read(path.join(__dirname, 'fixtures', 'phase0_prod_snapshot.sql'));
const m128 = read(path.join(root, 'migrations', '128_employee_rpc_kiosk_admin_guard.sql'));
const m130 = read(process.env.MIGRATION130_FILE || path.join(root, 'migrations', '130_companies_binding_attempts_lock.sql'));
const m131 = read(process.env.MIGRATION131_FILE || path.join(root, 'migrations', '131_verified_admin_rpcs.sql'));
const m132 = read(process.env.MIGRATION132_FILE || path.join(root, 'migrations', '132_verified_admin_rpcs_revoke.sql'));
const m130rb = read(path.join(root, 'migrations', '130_companies_binding_attempts_lock_rollback.sql'));
const m131rb = read(path.join(root, 'migrations', '131_verified_admin_rpcs_rollback.sql'));
const m132rb = read(path.join(root, 'migrations', '132_verified_admin_rpcs_revoke_rollback.sql'));

let pass = 0, fail = 0;
function check(name, condition, detail = '') {
  if (condition) { pass++; console.log(`  ✅ ${name}${detail ? `  → ${detail}` : ''}`); }
  else { fail++; console.log(`  ❌ ${name}${detail ? `  → ${detail}` : ''}`); }
}

const A = '8a669e2c-7521-43e9-9300-5c004c57e9db';
const B = '11111111-2222-3333-4444-555555555555';
const P = '22222222-3333-4444-5555-666666666666';   // 待審核、沒有員工的公司
const E = {
  admin: '00000000-0000-0000-0000-0000000000a1',
  mgr: '00000000-0000-0000-0000-0000000000a2',
  e1: '00000000-0000-0000-0000-0000000000e1',
  sched: '00000000-0000-0000-0000-0000000000e2',
  kiosk: '00000000-0000-0000-0000-0000000000c1',
  kioskAdmin: '00000000-0000-0000-0000-0000000000c2',
  pend: '00000000-0000-0000-0000-0000000000d1',
  bAdmin: '00000000-0000-0000-0000-0000000000b1',
  bUser: '00000000-0000-0000-0000-0000000000b2',
};
const PA = '00000000-0000-0000-0000-00000000fa01';
const MK = { a: '00000000-0000-0000-0000-00000000aa01', a2: '00000000-0000-0000-0000-00000000aa02', b: '00000000-0000-0000-0000-00000000bb01' };
const OT = { a: '00000000-0000-0000-0000-00000000ab01', a2: '00000000-0000-0000-0000-00000000ab02', b: '00000000-0000-0000-0000-00000000bc01' };
const ST = { a: '00000000-0000-0000-0000-00000000cd01', b: '00000000-0000-0000-0000-00000000cd02', global: '00000000-0000-0000-0000-00000000cd03' };
const U_ATTACKER = 'U' + 'f'.repeat(32);

const LEGACY9 = [
  'admin_create_employee(uuid, text, jsonb)', 'admin_update_employee(uuid, text, uuid, jsonb)', 'admin_delete_pending_employee(uuid, text, uuid)',
  'approve_makeup_request(uuid, uuid)', 'reject_makeup_request(uuid, uuid, text)',
  'approve_overtime_request(uuid, uuid, numeric, text, text)', 'reject_overtime_request(uuid, uuid, text, text, text)',
  'upsert_schedule(uuid, uuid, date, uuid, boolean, text)', 'delete_schedule(uuid, uuid, date)',
];
const DEAD23 = [
  'bind_employee(text, character varying, character varying, character varying, character varying)', 'bind_employee(text, text, text, text, text)',
  'bind_employee_secure(text, text, text, text, text)', 'bind_existing_employee(text, text, text)',
  'bind_line_id(character varying, character varying, character varying)', 'calculate_all_payroll(integer, integer)',
  'check_schedule_permission(text)', 'check_user_status(text)', 'generate_verification_code(character varying, integer)',
  'get_all_year_end_stats(integer)', 'get_annual_stats(integer, text)', 'get_annual_summary(text, integer)', 'get_company_info(text)',
  'get_daily_schedule(date)', 'get_employee_payroll(text, integer, integer)', 'get_lunch_summary(date)',
  'get_monthly_attendance_v2(text, integer, integer)', 'order_lunch(character varying, date, boolean, text)',
  'quick_check_in_debug(text)', 'quick_check_in_debug2(text)', 'quick_check_in_v2(text, double precision, double precision, text, text)',
  'sync_late_close_overtime_request(text, date)', 'update_office_locations(jsonb, text)',
];

(async () => {
  console.log('\n═══════════════════════════════════════');
  console.log('  companies 寫入鎖＋管理動作改由 LINE 驗證身分決定（130／131／132，PGlite 實跑）');
  console.log('═══════════════════════════════════════');

  const db = new PGlite();
  const q = async (sql, params) => (await db.query(sql, params)).rows;
  const one = async (sql, params) => (await q(sql, params))[0];
  await db.exec(snapshot);

  async function as(role, sql, params) {
    try {
      await db.exec(`SET ROLE ${role}`);
      const rows = (await db.query(sql, params)).rows;
      return { rows };
    } catch (e) {
      return { error: e.message };
    } finally {
      await db.exec(`RESET ROLE`);
    }
  }
  const rpc = async (role, fn, args) => {
    const keys = Object.keys(args);
    const r = await as(role, `SELECT public.${fn}(${keys.map((k, i) => `${k} => $${i + 1}`).join(', ')}) AS r`, keys.map(k => args[k]));
    return r.error ? { error: r.error } : r.rows[0].r;
  };
  const denied = r => typeof r?.error === 'string' && /permission denied/.test(r.error);
  const empRow = async id => one(`SELECT role, line_user_id, is_active, shift_mode FROM public.employees WHERE id = $1`, [id]);

  // 快照：之後用來比對回滾結果
  const aclSet = async (sig) => (await q(`SELECT coalesce(r.rolname, 'PUBLIC') AS g, a.privilege_type AS p
      FROM aclexplode((SELECT proacl FROM pg_proc WHERE oid = $1::regprocedure)) a LEFT JOIN pg_roles r ON r.oid = a.grantee
      ORDER BY 1, 2`, ['public.' + sig])).map(x => x.g + ':' + x.p).join(',');
  const relAcl = async (t) => (await q(`SELECT coalesce(r.rolname, 'PUBLIC') AS g, a.privilege_type AS p
      FROM aclexplode((SELECT relacl FROM pg_class WHERE oid = $1::regclass)) a LEFT JOIN pg_roles r ON r.oid = a.grantee
      ORDER BY 1, 2`, ['public.' + t])).map(x => x.g + ':' + x.p).join(',');
  const fnDef = async (sig) => (await one(`SELECT pg_get_functiondef($1::regprocedure) AS d`, ['public.' + sig])).d;
  const snap = { acl: {}, def: {}, rel: {} };
  for (const sig of [...LEGACY9, ...DEAD23]) snap.acl[sig] = await aclSet(sig);
  for (const sig of LEGACY9.slice(0, 3)) snap.def[sig] = await fnDef(sig);
  for (const t of ['companies', 'binding_attempts']) snap.rel[t] = await relAcl(t);

  async function seed() {
    await db.exec(`
      DELETE FROM public.schedules; DELETE FROM public.attendance; DELETE FROM public.makeup_punch_requests;
      DELETE FROM public.overtime_requests; DELETE FROM public.shift_types; DELETE FROM public.binding_attempts;
      DELETE FROM public.platform_admin_companies; DELETE FROM public.platform_admins;
      DELETE FROM public.employees; DELETE FROM public.companies;
      INSERT INTO public.companies (id, code, name, status) VALUES
        ('${A}', 'ACO', '大正科技', 'active'), ('${B}', 'BCO', '別家公司', 'active'), ('${P}', 'PEND', '待審公司', 'pending');
      INSERT INTO public.employees (id, company_id, employee_number, name, line_user_id, role, is_kiosk, can_schedule, status, is_active) VALUES
        ('${E.admin}', '${A}', 'A01', '主管甲', 'Uadmin', 'admin', false, false, 'approved', true),
        ('${E.mgr}', '${A}', 'A02', '主管乙', 'Umgr', 'manager', false, false, 'approved', true),
        ('${E.e1}', '${A}', 'E01', '員工一', 'U1', 'user', false, false, 'approved', true),
        ('${E.sched}', '${A}', 'E02', '排班員', 'U2', 'user', false, true, 'approved', true),
        ('${E.kiosk}', '${A}', 'K01', '公務機', 'Ukiosk', 'manager', true, true, 'approved', true),
        ('${E.kioskAdmin}', '${A}', 'K02', '公務機二', 'Ukioskadmin', 'admin', true, true, 'approved', true),
        ('${E.pend}', '${A}', 'P01', '待審員工', NULL, 'user', false, false, 'pending', false),
        ('${E.bAdmin}', '${B}', 'B01', '別家主管', 'UBadmin', 'admin', false, true, 'approved', true),
        ('${E.bUser}', '${B}', 'B02', '別家員工', 'UB1', 'user', false, false, 'approved', true);
      INSERT INTO public.platform_admins (id, line_user_id, name) VALUES ('${PA}', 'Uplatform', '平台');
      INSERT INTO public.platform_admin_companies (platform_admin_id, company_id, role) VALUES ('${PA}', '${A}', 'owner');
      INSERT INTO public.makeup_punch_requests (id, employee_id, punch_date, punch_type, punch_time, reason, status) VALUES
        ('${MK.a}', '${E.e1}', '2026-09-20', 'clock_in', '08:00', '忘記打卡', 'pending'),
        ('${MK.a2}', '${E.e1}', '2026-09-21', 'clock_out', '17:00', '忘記打卡', 'pending'),
        ('${MK.b}', '${E.bUser}', '2026-09-20', 'clock_in', '03:00', '攻擊測試', 'pending');
      INSERT INTO public.overtime_requests (id, employee_id, ot_date, planned_hours, reason, status) VALUES
        ('${OT.a}', '${E.e1}', '2026-09-20', 2, '收攤', 'pending'),
        ('${OT.a2}', '${E.e1}', '2026-09-21', 1, '收攤', 'pending'),
        ('${OT.b}', '${E.bUser}', '2026-09-20', 3, '收攤', 'pending');
      INSERT INTO public.shift_types (id, code, name, start_time, end_time, company_id) VALUES
        ('${ST.a}', 'D', 'A 早班', '08:00', '17:00', '${A}'), ('${ST.b}', 'D', 'B 早班', '08:00', '17:00', '${B}'),
        ('${ST.global}', 'G', '共用班', '09:00', '18:00', NULL);
    `);
  }

  // ---------- 1. 套用前：重現攻擊 ----------
  console.log('\n=== 套用前（正式庫快照）：重現攻擊 ===');
  await seed();
  let r = await rpc('anon', 'approve_makeup_request', { p_request_id: MK.b, p_approver_id: null });
  let att = await one(`SELECT count(*)::int AS n FROM public.attendance WHERE employee_id = $1`, [E.bUser]);
  check('現況重現：anon 不帶任何身分就核准 B 公司的補卡（寫進 attendance）', r?.success === true && att.n === 1, JSON.stringify(r));
  r = await rpc('anon', 'approve_overtime_request', { p_request_id: OT.b, p_approver_id: null, p_approved_hours: 12, p_reason_category: 'other', p_note: 'x' });
  check('現況重現：anon 把 B 公司加班核成 12 小時', r?.success === true && (await one(`SELECT final_hours FROM public.overtime_requests WHERE id = $1`, [OT.b])).final_hours == 12);
  let leaked = await as('anon', `SELECT id FROM public.employees WHERE company_id = $1 AND role = 'admin'`, [B]);
  r = await rpc('anon', 'upsert_schedule', { p_scheduler_id: leaked.rows[0].id, p_employee_id: E.bUser, p_date: '2026-10-01', p_shift_type_id: null, p_is_off_day: true, p_notes: 'hacked' });
  check('現況重現：anon 用讀得到的主管 uuid 冒充排班者改 B 的班表', r?.success === true, JSON.stringify(r));
  leaked = await as('anon', `SELECT line_user_id FROM public.employees WHERE company_id = $1 AND role = 'admin' AND is_kiosk = false`, [A]);
  check('現況重現：anon 讀得到 A 公司 admin 的 line_user_id', leaked.rows?.[0]?.line_user_id === 'Uadmin');
  r = await rpc('anon', 'admin_update_employee', { p_company_id: A, p_line_user_id: 'Uadmin', p_employee_id: E.e1, p_updates: JSON.stringify({ role: 'admin' }) });
  check('現況重現：員工一冒充 admin，把自己升成 admin', r?.success === true && (await empRow(E.e1)).role === 'admin', JSON.stringify(r));
  r = await rpc('anon', 'admin_update_employee', { p_company_id: A, p_line_user_id: 'Uadmin', p_employee_id: E.admin, p_updates: JSON.stringify({ line_user_id: U_ATTACKER }) });
  check('現況重現：冒充 admin 把 admin 帳號的 LINE ID 換成攻擊者的（之後可通過 LIFF 驗證）', r?.success === true && (await empRow(E.admin)).line_user_id === U_ATTACKER);
  await seed();
  r = await rpc('anon', 'admin_update_employee', { p_company_id: A, p_line_user_id: 'Ukiosk', p_employee_id: E.e1, p_updates: JSON.stringify({ is_active: false }) });
  check('現況重現：公務機帳號可以停用員工（has_company_access 放行公務機）', r?.success === true);
  r = await as('anon', `UPDATE public.companies SET status = 'suspended', features = '{}'::jsonb WHERE id = $1`, [B]);
  check('現況重現：anon 把 B 公司改成暫停、清空功能開關', !r.error && (await one(`SELECT status FROM public.companies WHERE id = $1`, [B])).status === 'suspended', r.error);
  r = await as('anon', `INSERT INTO public.companies (code, name) VALUES ('EVIL', '假公司')`);
  check('現況重現：anon 新增假公司', !r.error, r.error);
  r = await as('anon', `DELETE FROM public.companies WHERE id = $1`, [P]);
  check('現況重現：anon 刪掉沒有員工的公司', !r.error && !(await one(`SELECT 1 AS x FROM public.companies WHERE id = $1`, [P])), r.error);
  r = await one(`SELECT has_table_privilege('anon', 'public.companies', 'TRUNCATE') AS t, has_table_privilege('authenticated', 'public.companies', 'TRUNCATE') AS t2`);
  check('現況重現：anon/authenticated 對 companies 有 TRUNCATE 權限', r.t === true && r.t2 === true);
  r = await as('anon', `INSERT INTO public.binding_attempts (line_user_id) VALUES ('Ux')`);
  let r2 = await as('anon', `SELECT line_user_id FROM public.binding_attempts`);
  check('現況重現：binding_attempts anon 可寫可讀（RLS 關）', !r.error && r2.rows?.length === 1);
  r = await rpc('anon', 'calculate_all_payroll', { p_year: 2026, p_month: 9 });
  check('現況重現：沒人用的舊 RPC（calculate_all_payroll）anon 仍可執行', !r?.error, r?.error);

  // ---------- 2. 套 130 ----------
  console.log('\n=== 套用 130（companies／binding_attempts）===');
  await seed();
  let ok = true;
  try { await db.exec(m130); } catch (e) { ok = false; check('130 可在 PostgreSQL 套用', false, e.message); }
  if (ok) check('130 可在 PostgreSQL 套用', true);
  for (const role of ['anon', 'authenticated']) {
    r = await as(role, `UPDATE public.companies SET status = 'suspended' WHERE id = $1`, [B]);
    check(`${role} 不能改公司`, !!r.error, r.error);
    r = await as(role, `INSERT INTO public.companies (code, name) VALUES ('EVIL', '假公司')`);
    check(`${role} 不能新增公司`, !!r.error, r.error);
    r = await as(role, `DELETE FROM public.companies WHERE id = $1`, [P]);
    check(`${role} 不能刪公司`, !!r.error, r.error);
    r = await as(role, `TRUNCATE public.companies CASCADE`);
    check(`${role} 不能 TRUNCATE`, !!r.error && /permission denied/.test(r.error), r.error);
    r = await as(role, `SELECT id, name, code, features, status, industry FROM public.companies ORDER BY code`);
    check(`${role} 仍讀得到公司名稱／功能開關（員工頁、打卡總覽、客人頁）`, !r.error && r.rows.length === 3, r.error);
    r = await as(role, `SELECT * FROM public.binding_attempts`);
    check(`${role} 讀不到 binding_attempts`, !!r.error);
    r = await as(role, `INSERT INTO public.binding_attempts (line_user_id) VALUES ('Ux')`);
    check(`${role} 不能寫 binding_attempts`, !!r.error);
  }
  check('公司資料沒被動到', (await one(`SELECT count(*)::int AS n FROM public.companies WHERE status = 'active'`)).n === 2);
  r = await one(`SELECT has_table_privilege('anon', 'public.companies', 'TRUNCATE') AS t, has_table_privilege('anon', 'public.companies', 'SELECT') AS s,
    (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.companies'::regclass) AS rls, (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.binding_attempts'::regclass) AS rls2`);
  check('companies／binding_attempts RLS 開啟、anon 只剩 SELECT', r.t === false && r.s === true && r.rls === true && r.rls2 === true, JSON.stringify(r));
  const cSave = (caller, id, fields) => rpc('service_role', 'platform_company_save', { p_caller_line_user_id: caller, p_company_id: id, p_fields: JSON.stringify(fields) });
  r = await rpc('anon', 'platform_company_save', { p_caller_line_user_id: 'Uplatform', p_company_id: null, p_fields: '{"code":"X","name":"x"}' });
  check('anon 不能直接呼叫 platform_company_save（必須經 Edge Function 驗 LIFF）', denied(r), r?.error);
  r = await cSave('Uadmin', null, { code: 'NEW', name: '新公司' });
  check('公司 admin（非平台管理員）不能建立公司', r?.error_code === 'access_denied');
  r = await cSave('Uplatform', null, { code: 'new1', name: '新公司', plan_type: 'pro', features: { leave: true } });
  const newCo = r?.id;
  const link = newCo && await one(`SELECT role FROM public.platform_admin_companies WHERE platform_admin_id = $1 AND company_id = $2`, [PA, newCo]);
  check('平台管理員建立公司：成功、代碼轉大寫、自動綁成 owner', r?.success === true && r.company?.code === 'NEW1' && link?.role === 'owner', JSON.stringify(r));
  r = await cSave('Uplatform', null, { code: '本米', name: '本米' });
  check('中文公司代碼（正式庫已有「本米」）可建立', r?.success === true, JSON.stringify(r));
  r = await cSave('Uplatform', null, { code: 'NEW1', name: '重複' });
  check('重複代碼：duplicate_code', r?.error_code === 'duplicate_code');
  r = await cSave('Uplatform', null, { code: 'X2', name: 'x', id: B });
  check('不在白名單的欄位（id）：拒絕', r?.error_code === 'field_not_allowed');
  r = await cSave('Uplatform', null, { code: 'X3', name: 'x', plan_type: 'gold' });
  check('方案值不合法：invalid_value', r?.error_code === 'invalid_value');
  r = await cSave('Uplatform', B, { features: { leave: false } });
  const bRow = await one(`SELECT name, code, status, features FROM public.companies WHERE id = $1`, [B]);
  check('修改只更新帶來的欄位（只改 features，名稱／代碼／狀態不變）', r?.success === true && bRow.name === '別家公司' && bRow.code === 'BCO' && bRow.status === 'active' && bRow.features.leave === false);
  r = await cSave('Uplatform', '99999999-9999-9999-9999-999999999999', { name: 'x' });
  check('修改不存在的公司：not_found', r?.error_code === 'not_found');
  r = await rpc('service_role', 'platform_company_set_status', { p_caller_line_user_id: 'Uplatform', p_company_id: B, p_status: 'suspended' });
  check('平台管理員暫停公司：成功', r?.success === true && (await one(`SELECT status FROM public.companies WHERE id = $1`, [B])).status === 'suspended');
  r = await rpc('service_role', 'platform_company_set_status', { p_caller_line_user_id: 'UBadmin', p_company_id: B, p_status: 'active' });
  check('公司 admin 不能改公司狀態', r?.error_code === 'access_denied');
  r = await rpc('service_role', 'platform_company_set_status', { p_caller_line_user_id: 'Uplatform', p_company_id: B, p_status: 'deleted' });
  check('狀態值不合法：拒絕', r?.error_code === 'invalid_value');
  r = await rpc('service_role', 'platform_company_delete_pending', { p_caller_line_user_id: 'Uplatform', p_company_id: A });
  check('不能刪有員工的公司', r?.error_code === 'has_employees');
  r = await rpc('service_role', 'platform_company_delete_pending', { p_caller_line_user_id: 'Uplatform', p_company_id: newCo });
  check('不能刪非待審的公司', r?.error_code === 'not_pending');
  r = await rpc('service_role', 'platform_company_delete_pending', { p_caller_line_user_id: 'Uadmin', p_company_id: P });
  check('非平台管理員不能拒絕待審公司', r?.error_code === 'access_denied');
  r = await rpc('service_role', 'platform_company_delete_pending', { p_caller_line_user_id: 'Uplatform', p_company_id: P });
  check('平台管理員拒絕（刪除）待審公司：成功', r?.success === true && !(await one(`SELECT 1 AS x FROM public.companies WHERE id = $1`, [P])));
  r = await rpc('authenticated', 'platform_company_set_status', { p_caller_line_user_id: 'Uplatform', p_company_id: B, p_status: 'active' });
  check('authenticated 不能直接呼叫 platform_company_set_status', denied(r));

  // ---------- 3. 套 131 ----------
  console.log('\n=== 套用 131（新增驗證路徑、併入 128、撤 23 支沒人用的 RPC）===');
  await seed();
  ok = true;
  try { await db.exec(m131); } catch (e) { ok = false; check('131 可在 PostgreSQL 套用', false, e.message); }
  if (ok) check('131 可在 PostgreSQL 套用', true);
  r = await rpc('anon', 'admin_update_employee', { p_company_id: A, p_line_user_id: 'Uadmin', p_employee_id: E.e1, p_updates: JSON.stringify({ department: '外場' }) });
  check('131 之後、132 之前：舊頁面直接呼叫 admin_update_employee 仍可用（相容）', r?.success === true, JSON.stringify(r));
  r = await rpc('anon', 'approve_makeup_request', { p_request_id: MK.a2, p_approver_id: E.mgr });
  check('131 之後、132 之前：舊頁面直接核准補卡仍可用（相容）', r?.success === true);
  let deadOk = 0;
  for (const sig of DEAD23) {
    const x = await one(`SELECT has_function_privilege('anon', $1::regprocedure, 'EXECUTE') AS a, has_function_privilege('authenticated', $1::regprocedure, 'EXECUTE') AS b,
      has_function_privilege('service_role', $1::regprocedure, 'EXECUTE') AS s`, ['public.' + sig]);
    if (x.a === false && x.b === false && x.s === true) deadOk++;
  }
  check('23 支沒人用的舊 RPC：anon/authenticated 不能執行、service_role 保留', deadOk === 23, `${deadOk}/23`);
  r = await rpc('anon', 'calculate_all_payroll', { p_year: 2026, p_month: 9 });
  check('anon 呼叫 calculate_all_payroll：permission denied', denied(r));

  console.log('\n--- 員工管理（併入 128）---');
  const upd = (uid, emp, updates, company = A) => rpc('service_role', 'admin_update_employee', { p_company_id: company, p_line_user_id: uid, p_employee_id: emp, p_updates: JSON.stringify(updates) });
  r = await upd('Ukiosk', E.e1, { is_active: false });
  check('公務機不能改員工', r?.error_code === 'access_denied' && (await empRow(E.e1)).is_active === true);
  r = await upd('U1', E.e1, { role: 'admin' });
  check('一般員工不能改自己的角色', r?.error_code === 'access_denied' && (await empRow(E.e1)).role === 'user');
  r = await upd('Umgr', E.e1, { role: 'manager' });
  check('主管不能改角色（限 admin）', r?.error_code === 'role_denied');
  r = await upd('Umgr', E.admin, { line_user_id: U_ATTACKER });
  check('主管不能改 admin 帳號的 LINE ID', r?.error_code === 'target_protected' && (await empRow(E.admin)).line_user_id === 'Uadmin');
  r = await upd('Ukioskadmin', E.e1, { role: 'admin' });
  check('role=admin 的公務機也不能改角色（admin 判斷排除公務機）', r?.error_code === 'access_denied' && (await empRow(E.e1)).role === 'user');
  r = await upd('UBadmin', E.e1, { role: 'admin' });
  check('別家公司 admin 改 A 的員工：拒絕', r?.error_code === 'access_denied');
  r = await upd('Umgr', E.e1, { department: '內場', shift_mode: 'scheduled' });
  check('主管改一般員工資料：成功', r?.success === true && (await empRow(E.e1)).shift_mode === 'scheduled');
  r = await upd('Uadmin', E.e1, { role: 'manager' });
  check('admin 改角色：成功', r?.success === true && (await empRow(E.e1)).role === 'manager');
  r = await upd('Uplatform', E.e1, { role: 'user' });
  check('綁 A 的平台管理員改角色：成功', r?.success === true && (await empRow(E.e1)).role === 'user');
  r = await rpc('service_role', 'admin_create_employee', { p_company_id: A, p_line_user_id: 'Umgr', p_data: JSON.stringify({ name: '新人', employee_number: 'N01', id_card_last_4: '1234', role: 'manager' }) });
  check('主管不能新增主管', r?.error_code === 'role_denied');
  r = await rpc('service_role', 'admin_create_employee', { p_company_id: A, p_line_user_id: 'Umgr', p_data: JSON.stringify({ name: '新人', employee_number: 'N01', id_card_last_4: '1234' }) });
  check('主管新增一般員工：成功', r?.success === true);
  r = await rpc('service_role', 'admin_delete_pending_employee', { p_company_id: A, p_line_user_id: 'Ukiosk', p_employee_id: E.pend });
  check('公務機不能刪待審登記', r?.error_code === 'access_denied');
  r = await rpc('service_role', 'admin_delete_pending_employee', { p_company_id: A, p_line_user_id: 'Umgr', p_employee_id: E.e1 });
  check('不能刪在職員工', r?.error_code === 'not_pending');
  r = await rpc('service_role', 'admin_delete_pending_employee', { p_company_id: A, p_line_user_id: 'Umgr', p_employee_id: E.pend });
  check('主管刪待審登記：成功', r?.success === true);

  console.log('\n--- 補卡審核（review_makeup_request）---');
  await seed();
  const mk = (uid, id, decision, company = A, reason = null) => rpc('service_role', 'review_makeup_request', { p_company_id: company, p_line_user_id: uid, p_request_id: id, p_decision: decision, p_reason: reason });
  r = await rpc('anon', 'review_makeup_request', { p_company_id: A, p_line_user_id: 'Umgr', p_request_id: MK.a, p_decision: 'approve', p_reason: null });
  check('anon 不能直接呼叫 review_makeup_request', denied(r));
  r = await mk('Umgr', MK.b, 'approve');
  check('A 主管核准 B 公司的補卡：找不到（跨公司擋下），B 的申請仍待審', r?.error_code === 'not_found' && (await one(`SELECT status FROM public.makeup_punch_requests WHERE id = $1`, [MK.b])).status === 'pending');
  r = await mk('Umgr', MK.b, 'approve', B);
  check('A 主管自稱 B 公司：拒絕', r?.error_code === 'access_denied');
  r = await mk('Ukiosk', MK.a, 'approve');
  check('公務機不能核准', r?.error_code === 'access_denied');
  r = await mk('U1', MK.a, 'approve');
  check('一般員工不能核准', r?.error_code === 'access_denied');
  r = await mk('Umgr', MK.a, 'approve');
  let mkRow = await one(`SELECT status, approver_id FROM public.makeup_punch_requests WHERE id = $1`, [MK.a]);
  att = await one(`SELECT count(*)::int AS n FROM public.attendance WHERE employee_id = $1 AND date = '2026-09-20'`, [E.e1]);
  check('A 主管核准 A 的補卡：成功、寫入出勤、核准人＝LINE 驗證的本人', r?.success === true && mkRow.status === 'approved' && mkRow.approver_id === E.mgr && att.n === 1, JSON.stringify(r));
  r = await mk('Umgr', MK.a, 'reject');
  check('已處理過的申請不能再拒絕（避免出勤已寫入、狀態卻變拒絕）', r?.error_code === 'not_pending');
  r = await mk('Uplatform', MK.a2, 'reject', A, '時間不對');
  mkRow = await one(`SELECT status, approver_id, rejection_reason FROM public.makeup_punch_requests WHERE id = $1`, [MK.a2]);
  check('綁 A 的平台管理員拒絕：成功（不在 employees 表，核准人為 NULL）', r?.success === true && mkRow.status === 'rejected' && mkRow.approver_id === null && mkRow.rejection_reason === '時間不對');
  r = await mk('Umgr', MK.b, 'maybe');
  check('審核動作不合法：拒絕', r?.error_code === 'invalid_value');

  console.log('\n--- 加班認列（review_overtime_request）---');
  const ot = (uid, id, decision, extra = {}, company = A) => rpc('service_role', 'review_overtime_request', Object.assign({ p_company_id: company, p_line_user_id: uid, p_request_id: id, p_decision: decision,
    p_approved_hours: null, p_reason_category: null, p_note: null, p_reason: null }, extra));
  r = await ot('Umgr', OT.b, 'approve', { p_approved_hours: 12, p_reason_category: 'other', p_note: 'x' });
  check('A 主管認列 B 公司的加班：找不到（跨公司擋下）', r?.error_code === 'not_found' && (await one(`SELECT status FROM public.overtime_requests WHERE id = $1`, [OT.b])).status === 'pending');
  r = await ot('Ukiosk', OT.a, 'approve', { p_approved_hours: 2, p_reason_category: 'closing' });
  check('公務機不能認列', r?.error_code === 'access_denied');
  r = await ot('Umgr', OT.a, 'approve', { p_reason_category: 'closing' });
  check('認列沒帶時數：拒絕', r?.error_code === 'invalid_value');
  r = await ot('Umgr', OT.a, 'approve', { p_approved_hours: 1.5, p_reason_category: 'closing', p_note: '收攤' });
  let otRow = await one(`SELECT status, final_hours, approver_id FROM public.overtime_requests WHERE id = $1`, [OT.a]);
  check('A 主管認列 A 的加班：成功、核准人＝本人', r?.success === true && otRow.status === 'approved' && Number(otRow.final_hours) === 1.5 && otRow.approver_id === E.mgr, JSON.stringify(r));
  r = await ot('Uadmin', OT.a2, 'reject', { p_reason: '未達標準', p_reason_category: 'personal_delay', p_note: '拖延' });
  otRow = await one(`SELECT status, rejection_reason, approver_id FROM public.overtime_requests WHERE id = $1`, [OT.a2]);
  check('admin 不認列：成功', r?.success === true && otRow.status === 'rejected' && otRow.rejection_reason === '未達標準' && otRow.approver_id === E.admin);
  r = await ot('Uadmin', OT.a2, 'approve', { p_approved_hours: 1, p_reason_category: 'closing' });
  check('已處理過的加班不能再審', r?.error_code === 'not_pending');

  console.log('\n--- 排班（save_schedules_verified）---');
  const sv = (uid, items, company = A) => rpc('service_role', 'save_schedules_verified', { p_company_id: company, p_line_user_id: uid, p_items: JSON.stringify(items) });
  const schedCount = async () => (await one(`SELECT count(*)::int AS n FROM public.schedules`)).n;
  r = await sv('U2', [{ employee_id: E.e1, date: '2026-10-01', shift_type_id: ST.a }, { employee_id: E.mgr, date: '2026-10-01', is_off_day: true }, { employee_id: E.admin, date: '2026-10-02', shift_type_id: ST.global }]);
  const s1 = await one(`SELECT shift_type_id, scheduled_by FROM public.schedules WHERE employee_id = $1 AND date = '2026-10-01'`, [E.e1]);
  check('有排班權限的員工批次排 3 筆（含共用班別）：成功、排班人＝本人', r?.success === true && r.saved_count === 3 && s1.shift_type_id === ST.a && s1.scheduled_by === E.sched, JSON.stringify(r));
  r = await sv('U2', [{ employee_id: E.e1, date: '2026-10-01', delete: true }]);
  check('刪除排班：成功', r?.success === true && (await schedCount()) === 2);
  r = await sv('U1', [{ employee_id: E.e1, date: '2026-10-05', shift_type_id: ST.a }]);
  check('沒有排班權限的員工：拒絕', r?.error_code === 'access_denied');
  r = await sv('Ukiosk', [{ employee_id: E.e1, date: '2026-10-05', shift_type_id: ST.a }]);
  check('公務機（即使 can_schedule）：拒絕', r?.error_code === 'access_denied');
  r = await sv('Umgr', [{ employee_id: E.e1, date: '2026-10-05', shift_type_id: ST.a }]);
  check('主管沒有 can_schedule：照舊規則拒絕（排班權限＝can_schedule 或 admin）', r?.error_code === 'access_denied');
  r = await sv('Uadmin', [{ employee_id: E.e1, date: '2026-10-06', shift_type_id: ST.a }]);
  check('admin 排班：成功', r?.success === true);
  const before = await schedCount();
  r = await sv('U2', [{ employee_id: E.e1, date: '2026-10-07', shift_type_id: ST.a }, { employee_id: E.bUser, date: '2026-10-07', shift_type_id: ST.a }]);
  check('批次裡混一筆別家公司員工：整批不存（第 2 筆失敗、第 1 筆也回復）', r?.error_code === 'item_failed' && r.failed_index === 2 && (await schedCount()) === before, JSON.stringify(r));
  r = await sv('U2', [{ employee_id: E.e1, date: '2026-10-08', shift_type_id: ST.b }]);
  check('用別家公司的班別：拒絕', r?.error_code === 'item_failed' && (await schedCount()) === before);
  r = await sv('UBadmin', [{ employee_id: E.e1, date: '2026-10-08', shift_type_id: ST.a }]);
  check('別家公司 admin 排 A 的班：拒絕', r?.error_code === 'access_denied');
  r = await sv('U2', [{ employee_id: 'not-a-uuid', date: '2026-10-08' }]);
  check('格式錯誤：拒絕、不存', r?.success === false && (await schedCount()) === before);
  r = await sv('U2', []);
  check('空批次：拒絕', r?.error_code === 'invalid_value');

  // ---------- 4. 套 132 ----------
  console.log('\n=== 套用 132（撤前端直接呼叫 9 支管理 RPC）===');
  await seed();
  ok = true;
  try { await db.exec(m132); } catch (e) { ok = false; check('132 可在 PostgreSQL 套用', false, e.message); }
  if (ok) check('132 可在 PostgreSQL 套用', true);
  for (const role of ['anon', 'authenticated']) {
    r = await rpc(role, 'approve_makeup_request', { p_request_id: MK.b, p_approver_id: null });
    check(`${role} 跨公司核准補卡：permission denied`, denied(r) && (await one(`SELECT status FROM public.makeup_punch_requests WHERE id = $1`, [MK.b])).status === 'pending');
    r = await rpc(role, 'reject_makeup_request', { p_request_id: MK.b, p_approver_id: null, p_reason: 'x' });
    check(`${role} 直接拒絕補卡：permission denied`, denied(r));
    r = await rpc(role, 'approve_overtime_request', { p_request_id: OT.b, p_approver_id: null, p_approved_hours: 12, p_reason_category: 'other', p_note: 'x' });
    check(`${role} 直接核加班：permission denied`, denied(r));
    r = await rpc(role, 'reject_overtime_request', { p_request_id: OT.b, p_approver_id: null, p_reason: 'x', p_reason_category: null, p_note: null });
    check(`${role} 直接不認列加班：permission denied`, denied(r));
    r = await rpc(role, 'upsert_schedule', { p_scheduler_id: E.bAdmin, p_employee_id: E.bUser, p_date: '2026-10-01', p_shift_type_id: null, p_is_off_day: true, p_notes: 'hacked' });
    check(`${role} 冒充排班者改班表：permission denied`, denied(r));
    r = await rpc(role, 'delete_schedule', { p_scheduler_id: E.bAdmin, p_employee_id: E.bUser, p_date: '2026-10-01' });
    check(`${role} 冒充排班者刪班表：permission denied`, denied(r));
    r = await rpc(role, 'admin_update_employee', { p_company_id: A, p_line_user_id: 'Uadmin', p_employee_id: E.e1, p_updates: JSON.stringify({ role: 'admin' }) });
    check(`${role} 冒充 admin 自升權限：permission denied，角色不變`, denied(r) && (await empRow(E.e1)).role === 'user');
    r = await rpc(role, 'admin_update_employee', { p_company_id: A, p_line_user_id: 'Uadmin', p_employee_id: E.admin, p_updates: JSON.stringify({ line_user_id: U_ATTACKER }) });
    check(`${role} 冒充 admin 換掉 admin 的 LINE ID：permission denied`, denied(r) && (await empRow(E.admin)).line_user_id === 'Uadmin');
    r = await rpc(role, 'admin_create_employee', { p_company_id: A, p_line_user_id: 'Uadmin', p_data: JSON.stringify({ name: 'x', employee_number: 'X9', id_card_last_4: '1', role: 'admin' }) });
    check(`${role} 冒充 admin 新增 admin：permission denied`, denied(r));
    r = await rpc(role, 'admin_delete_pending_employee', { p_company_id: A, p_line_user_id: 'Uadmin', p_employee_id: E.pend });
    check(`${role} 冒充刪待審登記：permission denied`, denied(r));
  }
  r = await mk('Umgr', MK.a, 'approve');
  check('132 之後：經 Edge Function（service_role）核准補卡照常（內部呼叫已撤權的 approve_makeup_request）', r?.success === true);
  r = await ot('Umgr', OT.a, 'approve', { p_approved_hours: 2, p_reason_category: 'closing' });
  check('132 之後：加班認列照常', r?.success === true);
  r = await sv('U2', [{ employee_id: E.e1, date: '2026-10-01', shift_type_id: ST.a }, { employee_id: E.e1, date: '2026-10-01', delete: true }]);
  check('132 之後：排班儲存／刪除照常', r?.success === true && r.saved_count === 2);
  r = await upd('Uadmin', E.e1, { gps_relaxed: true });
  check('132 之後：admin 經 Edge Function 改員工照常', r?.success === true);
  r = await rpc('service_role', 'admin_create_employee', { p_company_id: A, p_line_user_id: 'Uadmin', p_data: JSON.stringify({ name: '新人', employee_number: 'N02', id_card_last_4: '5678', role: 'manager' }) });
  check('132 之後：admin 新增主管照常', r?.success === true);
  r = await upd('U1', E.e1, { role: 'admin' });
  check('攻擊者就算用自己真的 LINE 帳號（LIFF 驗證通過）也不能自升權限', r?.error_code === 'access_denied' && (await empRow(E.e1)).role === 'user');

  // ---------- 5. 順序防呆、回滾、重套 ----------
  console.log('\n=== 順序防呆、回滾、重套 ===');
  {
    const db2 = new PGlite();
    await db2.exec(snapshot);
    let err = '';
    try { await db2.exec(m132); } catch (e) { err = e.message; }
    check('沒套 131 就套 132：中止（避免前端失去審核／排班路徑）', /131/.test(err), err);
    await db2.exec('ROLLBACK');
    await db2.exec(m131);
    err = '';
    try { await db2.exec(m128); } catch (e) { err = e.message; }
    check('131 之後再套 128：中止（不會把函式蓋回舊版）', /131/.test(err), err);
    await db2.close();
  }
  let rbErr = '';
  try { await db.exec(m131rb); } catch (e) { rbErr = e.message; }
  check('132 還在時回滾 131：中止', /132/.test(rbErr), rbErr);
  await db.exec('ROLLBACK');
  await db.exec(m132rb);
  let same = 0;
  for (const sig of LEGACY9) if ((await aclSet(sig)) === snap.acl[sig]) same++;
  check('132 回滾：9 支 RPC 的 proacl 與正式庫快照相同', same === 9, `${same}/9`);
  await db.exec(m131rb);
  same = 0;
  for (const sig of DEAD23) if ((await aclSet(sig)) === snap.acl[sig]) same++;
  check('131 回滾：23 支舊 RPC 的 proacl 與正式庫快照相同', same === 23, `${same}/23`);
  same = 0;
  for (const sig of LEGACY9.slice(0, 3)) if ((await fnDef(sig)) === snap.def[sig]) same++;
  check('131 回滾：admin_* 三支函式本體與正式庫原文相同', same === 3, `${same}/3`);
  const gone = (await one(`SELECT count(*)::int AS n FROM pg_proc WHERE proname IN ('review_makeup_request','review_overtime_request','save_schedules_verified','is_company_manager_caller','is_company_admin_strict_caller')`)).n;
  check('131 回滾：新增的 5 支函式移除', gone === 0);
  await db.exec(m130rb);
  const relSame = (await relAcl('companies')) === snap.rel.companies && (await relAcl('binding_attempts')) === snap.rel.binding_attempts;
  const rls = await one(`SELECT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.companies'::regclass) AS a, (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.binding_attempts'::regclass) AS b,
    (SELECT count(*)::int FROM pg_policies WHERE tablename IN ('companies','binding_attempts')) AS pol,
    (SELECT count(*)::int FROM pg_proc WHERE proname LIKE 'platform_company_%') AS fns`);
  check('130 回滾：兩表 relacl 與正式庫相同、RLS 關、0 政策、RPC 移除', relSame && rls.a === false && rls.b === false && rls.pol === 0 && rls.fns === 0, JSON.stringify(rls));
  let reErr = '';
  try { for (let i = 0; i < 2; i++) { await db.exec(m130); await db.exec(m131); await db.exec(m132); } } catch (e) { reErr = e.message; }
  check('130、131、132 可重複套用', reErr === '', reErr);

  console.log(`\n結果：${pass} 通過、${fail} 失敗`);
  process.exit(fail > 0 ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
