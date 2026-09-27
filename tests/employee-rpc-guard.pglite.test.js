// ============================================================
// migration 128：124 員工 RPC 補強（公務機不能管員工、主管不能改管理員帳號）— PGlite 實跑
//
// 不連線、不寫正式庫。流程：base schema ＋ 正式庫 helper（fixtures）＋ 124 → 重現問題 → 套 128 → 驗證 → 回滾 → 重套
// 反向對照：MIGRATION128_FILE 指向空檔 → 套用後的情境應失敗
// ============================================================
const fs = require('fs');
const path = require('path');
const { PGlite } = require('@electric-sql/pglite');

const root = path.join(__dirname, '..');
const read = f => fs.readFileSync(f, 'utf8');
const baseSql = read(path.join(__dirname, 'fixtures', 'line_push_base_schema.sql'));
const prodRls = read(path.join(__dirname, 'fixtures', 'system_settings_prod_rls.sql'));
const m124 = read(path.join(root, 'migrations', '124_rls_employees_write_lock.sql'));
const m128 = read(process.env.MIGRATION128_FILE || path.join(root, 'migrations', '128_employee_rpc_kiosk_admin_guard.sql'));
const m128rb = read(path.join(root, 'migrations', '128_employee_rpc_kiosk_admin_guard_rollback.sql'));

let pass = 0, fail = 0;
function check(name, condition, detail = '') {
  if (condition) { pass++; console.log(`  ✅ ${name}${detail ? `  → ${detail}` : ''}`); }
  else { fail++; console.log(`  ❌ ${name}${detail ? `  → ${detail}` : ''}`); }
}

const A = '8a669e2c-7521-43e9-9300-5c004c57e9db';
const E = {
  admin: '00000000-0000-0000-0000-0000000000a1',
  mgr: '00000000-0000-0000-0000-0000000000a2',
  e1: '00000000-0000-0000-0000-0000000000e1',
  kiosk: '00000000-0000-0000-0000-0000000000c1',
  pending: '00000000-0000-0000-0000-0000000000d1',
};
const PA = '00000000-0000-0000-0000-00000000fa01';

(async () => {
  console.log('\n═══════════════════════════════════════');
  console.log('  124 員工 RPC 補強（migration 128，PGlite 實跑）');
  console.log('═══════════════════════════════════════');

  const db = new PGlite();
  const q = async (sql, params) => (await db.query(sql, params)).rows;
  await db.exec(baseSql);
  await db.exec(prodRls);
  // 124 的 UPDATE／INSERT 會用到的 employees 欄位（base schema 只有 LINE 通知用到的幾欄）
  await db.exec(`ALTER TABLE public.employees
    ADD COLUMN IF NOT EXISTS position TEXT, ADD COLUMN IF NOT EXISTS phone TEXT, ADD COLUMN IF NOT EXISTS hire_date DATE,
    ADD COLUMN IF NOT EXISTS employment_type TEXT, ADD COLUMN IF NOT EXISTS is_bound BOOLEAN, ADD COLUMN IF NOT EXISTS bound_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS can_schedule BOOLEAN, ADD COLUMN IF NOT EXISTS gps_relaxed BOOLEAN, ADD COLUMN IF NOT EXISTS shift_mode TEXT,
    ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'approved', ADD COLUMN IF NOT EXISTS resigned_date DATE, ADD COLUMN IF NOT EXISTS resign_reason TEXT,
    ADD COLUMN IF NOT EXISTS resign_note TEXT, ADD COLUMN IF NOT EXISTS emergency_contact TEXT, ADD COLUMN IF NOT EXISTS emergency_phone TEXT,
    ADD COLUMN IF NOT EXISTS id_card_last_4 TEXT, ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ, ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT now()`);
  await db.exec(m124);

  async function seed() {
    await db.exec(`
      DELETE FROM public.platform_admin_companies; DELETE FROM public.platform_admins;
      TRUNCATE public.attendance, public.leave_requests, public.makeup_punch_requests, public.overtime_requests,
               public.shift_swap_requests, public.attendance_anomalies CASCADE;
      DELETE FROM public.employees; DELETE FROM public.companies;
      INSERT INTO public.companies (id, name) VALUES ('${A}', '大正科技');
      INSERT INTO public.employees (id, company_id, employee_number, name, line_user_id, role, is_kiosk, is_active, status) VALUES
        ('${E.admin}', '${A}', 'A01', '主管甲', 'Uadmin', 'admin', false, true, 'approved'),
        ('${E.mgr}', '${A}', 'A02', '主管乙', 'Umgr', 'manager', false, true, 'approved'),
        ('${E.e1}', '${A}', 'E01', '員工一', 'U1', 'user', false, true, 'approved'),
        ('${E.kiosk}', '${A}', 'K01', '公務機', 'Ukiosk', 'user', true, true, 'approved'),
        ('${E.pending}', '${A}', 'P01', '待審', NULL, 'user', false, false, 'pending');
      INSERT INTO public.platform_admins (id, line_user_id, name) VALUES ('${PA}', 'Uplatform', '平台');
      INSERT INTO public.platform_admin_companies (platform_admin_id, company_id, role) VALUES ('${PA}', '${A}', 'owner');
    `);
  }
  const upd = async (caller, emp, updates) => (await q(`SELECT public.admin_update_employee($1, $2, $3, $4::jsonb) AS r`, [A, caller, emp, JSON.stringify(updates)]))[0].r;
  const create = async caller => (await q(`SELECT public.admin_create_employee($1, $2, $3::jsonb) AS r`, [A, caller, JSON.stringify({ name: '新人', employee_number: 'N' + Math.floor(Math.random() * 1e6), id_card_last_4: '1234' })]))[0].r;
  const del = async (caller, emp) => (await q(`SELECT public.admin_delete_pending_employee($1, $2, $3) AS r`, [A, caller, emp]))[0].r;
  const lineOf = async id => (await q(`SELECT line_user_id FROM public.employees WHERE id = $1`, [id]))[0].line_user_id;

  console.log('\n=== 套用前（124）：重現問題 ===');
  await seed();
  let r = await upd('Ukiosk', E.admin, { line_user_id: 'Uattacker' });
  check('現況重現：公務機可把 admin 的 LINE ID 改成別人的', r.success === true && await lineOf(E.admin) === 'Uattacker', JSON.stringify(r));
  await seed();
  r = await upd('Umgr', E.admin, { line_user_id: 'Uattacker' });
  check('現況重現：主管（manager）可把 admin 的 LINE ID 改掉（接管 admin）', r.success === true && await lineOf(E.admin) === 'Uattacker');

  console.log('\n=== 套用 128 ===');
  await seed();
  let applied = true;
  try { await db.exec(m128); } catch (e) { applied = false; check('128 可在 PostgreSQL 套用', false, e.message); }
  if (applied) check('128 可在 PostgreSQL 套用', true);

  r = await upd('Ukiosk', E.e1, { department: '生產部' });
  check('公務機改一般員工：拒絕', r.error_code === 'access_denied', JSON.stringify(r));
  r = await create('Ukiosk');
  check('公務機新增員工：拒絕', r.error_code === 'access_denied');
  r = await del('Ukiosk', E.pending);
  check('公務機刪待審登記：拒絕', r.error_code === 'access_denied');
  r = await upd('Umgr', E.admin, { line_user_id: 'Uattacker' });
  check('主管改 admin 的 LINE ID：拒絕（target_protected），admin 不變', r.error_code === 'target_protected' && await lineOf(E.admin) === 'Uadmin', JSON.stringify(r));
  r = await upd('Umgr', E.admin, { is_active: false });
  check('主管停用 admin：拒絕', r.error_code === 'target_protected');
  r = await upd('Umgr', E.e1, { department: '生產部' });
  check('主管改一般員工：照常成功', r.success === true);
  r = await upd('Umgr', E.e1, { role: 'admin' });
  check('主管改角色：仍然拒絕（124 原本的 role_denied 不變）', r.error_code === 'role_denied');
  r = await create('Umgr');
  check('主管新增一般員工：照常成功', r.success === true);
  r = await del('Umgr', E.pending);
  check('主管刪待審登記：照常成功', r.success === true);
  r = await upd('Uadmin', E.mgr, { department: '管理部' });
  check('admin 改主管：成功', r.success === true);
  r = await upd('Uadmin', E.admin, { phone: '0900' });
  check('admin 改自己：成功', r.success === true);
  r = await upd('Uplatform', E.admin, { phone: '0911' });
  check('平台管理員改 admin：成功', r.success === true);
  r = await upd('U1', E.e1, { department: 'x' });
  check('一般員工：拒絕', r.error_code === 'access_denied');
  r = await upd('Unobody', E.e1, { department: 'x' });
  check('不認識的 LINE ID：拒絕', r.error_code === 'access_denied');
  const helperGrant = await q(`SELECT has_function_privilege('anon', 'public.is_company_manager_caller(text, uuid)', 'EXECUTE') AS a`);
  check('新 helper 不開放給 anon（避免成為身分探測管道）', helperGrant[0].a === false);

  console.log('\n=== 回滾、重套 ===');
  await db.exec(m128rb);
  await seed();
  r = await upd('Ukiosk', E.e1, { department: '生產部' });
  check('128 回滾：回到 124 行為（公務機可改員工）', r.success === true);
  const helper = await q(`SELECT count(*)::int AS n FROM pg_proc WHERE proname = 'is_company_manager_caller'`);
  check('128 回滾：helper 移除', helper[0].n === 0);
  let reErr = '';
  try { await db.exec(m128); await db.exec(m128); } catch (e) { reErr = e.message; }
  check('128 可重複套用', reErr === '', reErr);

  console.log(`\n結果：${pass} 通過、${fail} 失敗`);
  process.exit(fail > 0 ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
