// ============================================================
// migration 133／134／135：attendance／schedules 只能經伺服器端函式寫入 — PGlite 實跑
//
// 不連線、不寫正式庫。流程：
//   1. 載入正式庫快照（phase0_prod_snapshot.sql＋attendance_schedules_prod_snapshot.sql：
//      政策、grant、proacl、觸發器，寫入函式本體逐字取自正式庫；擁有者模擬正式庫的非 superuser postgres）
//   2. 以 PR #3 上線後的狀態（130／131／132 已套）為起點，先重現：anon／authenticated 可直接寫 attendance、schedules
//   3. 依上線順序套 133＋134 → 135，逐項驗證直接寫入被擋，而打卡（一般／公務機／補卡後下班）、補卡申請、
//      補卡核准、管理員補登、排班儲存、換班審核、缺卡異常自動結案照常
//   4. 順序防呆、回滾後政策／grant 與正式庫快照逐項相同、可重複套用
// 反向對照（證明測試在舊程式會失敗）：
//   MIGRATION133_FILE／MIGRATION134_FILE／MIGRATION135_FILE 指向空檔 → 套用後的情境應大量失敗
// ============================================================
const fs = require('fs');
const path = require('path');
const { PGlite } = require('@electric-sql/pglite');

const root = path.join(__dirname, '..');
const read = f => fs.readFileSync(f, 'utf8');
const snapshot = read(path.join(__dirname, 'fixtures', 'phase0_prod_snapshot.sql'))
  + '\n' + read(path.join(__dirname, 'fixtures', 'attendance_schedules_prod_snapshot.sql'));
const mig = n => read(path.join(root, 'migrations', n));
const m130 = mig('130_companies_binding_attempts_lock.sql');
const m131 = mig('131_verified_admin_rpcs.sql');
const m132 = mig('132_verified_admin_rpcs_revoke.sql');
const m133 = read(process.env.MIGRATION133_FILE || path.join(root, 'migrations', '133_shift_swap_verified_review.sql'));
const m134 = read(process.env.MIGRATION134_FILE || path.join(root, 'migrations', '134_attendance_write_lock.sql'));
const m135 = read(process.env.MIGRATION135_FILE || path.join(root, 'migrations', '135_schedules_write_lock.sql'));
const m133rb = mig('133_shift_swap_verified_review_rollback.sql');
const m134rb = mig('134_attendance_write_lock_rollback.sql');
const m135rb = mig('135_schedules_write_lock_rollback.sql');

let pass = 0, fail = 0;
function check(name, condition, detail = '') {
  if (condition) { pass++; console.log(`  ✅ ${name}${detail ? `  → ${detail}` : ''}`); }
  else { fail++; console.log(`  ❌ ${name}${detail ? `  → ${detail}` : ''}`); }
}

const A = '8a669e2c-7521-43e9-9300-5c004c57e9db';
const B = '11111111-2222-3333-4444-555555555555';
const E = {
  admin: '00000000-0000-0000-0000-0000000000a1',
  mgr: '00000000-0000-0000-0000-0000000000a2',
  e1: '00000000-0000-0000-0000-0000000000e1',
  e2: '00000000-0000-0000-0000-0000000000e2',
  e3: '00000000-0000-0000-0000-0000000000e3',
  e4: '00000000-0000-0000-0000-0000000000e4',
  e5: '00000000-0000-0000-0000-0000000000e5',
  sched: '00000000-0000-0000-0000-0000000000e9',
  kiosk: '00000000-0000-0000-0000-0000000000c1',
  bAdmin: '00000000-0000-0000-0000-0000000000b1',
  bUser: '00000000-0000-0000-0000-0000000000b2',
};
const PA = '00000000-0000-0000-0000-00000000fa01';
const ST = { day: '00000000-0000-0000-0000-00000000cd01', night: '00000000-0000-0000-0000-00000000cd02', b: '00000000-0000-0000-0000-00000000cd03' };
const SW = {
  ok: '00000000-0000-0000-0000-00000000ee01', notAgreed: '00000000-0000-0000-0000-00000000ee02', noSched: '00000000-0000-0000-0000-00000000ee03',
  cross: '00000000-0000-0000-0000-00000000ee04', rej: '00000000-0000-0000-0000-00000000ee05', b: '00000000-0000-0000-0000-00000000ee06',
  pa: '00000000-0000-0000-0000-00000000ee07', off: '00000000-0000-0000-0000-00000000ee08',
};
const OFF_DATE = '2026-10-07';
const MK = '00000000-0000-0000-0000-00000000aa01';
const SWAP_DATE = '2026-10-05';

(async () => {
  console.log('\n═══════════════════════════════════════');
  console.log('  attendance／schedules 只能經伺服器端函式寫入（133／134／135，PGlite 實跑）');
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
  // migration 以正式庫擁有者（非 superuser）的身分套用
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
  const today = (await one(`SELECT (now() AT TIME ZONE 'Asia/Taipei')::date::text AS d`)).d;
  const yesterday = (await one(`SELECT ((now() AT TIME ZONE 'Asia/Taipei')::date - 1)::text AS d`)).d;
  const attOf = (emp, d = today) => one(`SELECT * FROM public.attendance WHERE employee_id = $1 AND date = $2`, [emp, d]);
  const schedOf = (emp, d) => one(`SELECT shift_type_id, is_off_day, notes FROM public.schedules WHERE employee_id = $1 AND date = $2`, [emp, d]);

  // 正式庫快照（回滾比對用）
  const relAcl = async (t) => (await q(`SELECT coalesce(r.rolname, 'PUBLIC') AS g, a.privilege_type AS p
      FROM aclexplode((SELECT relacl FROM pg_class WHERE oid = $1::regclass)) a LEFT JOIN pg_roles r ON r.oid = a.grantee
      WHERE coalesce(r.rolname, 'PUBLIC') <> 'prod_postgres' ORDER BY 1, 2`, ['public.' + t])).map(x => x.g + ':' + x.p).join(',');
  const pols = async (t) => (await q(`SELECT policyname, permissive, roles::text AS roles, cmd, qual, with_check FROM pg_policies
      WHERE schemaname = 'public' AND tablename = $1 ORDER BY policyname`, [t])).map(x => JSON.stringify(x)).join('\n');
  const snap = {};
  for (const t of ['attendance', 'schedules']) snap[t] = { acl: await relAcl(t), pol: await pols(t) };
  // 打卡等寫入函式的本體（本 PR 不改）：套用後逐字比對
  const WRITERS = ['quick_check_in', 'quick_check_out_after_clock_in_makeup', 'kiosk_check_in', 'admin_makeup_punch', 'submit_makeup_punch',
    'approve_makeup_request', 'upsert_schedule', 'delete_schedule', 'calc_work_hours', 'resolve_anomaly_on_checkout'];
  const writerDefs = async () => (await q(`SELECT string_agg(pg_get_functiondef(p.oid), '
' ORDER BY p.proname) AS d FROM pg_proc p
      WHERE p.pronamespace = 'public'::regnamespace AND p.proname = ANY($1)`, [WRITERS]))[0].d;
  const writersBefore = await writerDefs();

  async function seed() {
    await db.exec(`
      DELETE FROM public.attendance_anomalies; DELETE FROM public.shift_swap_requests; DELETE FROM public.attendance;
      DELETE FROM public.schedules; DELETE FROM public.makeup_punch_requests; DELETE FROM public.system_settings;
      DELETE FROM public.shift_types; DELETE FROM public.platform_admin_companies; DELETE FROM public.platform_admins;
      DELETE FROM public.employees; DELETE FROM public.binding_attempts; DELETE FROM public.companies;
      INSERT INTO public.companies (id, code, name, status) VALUES ('${A}', 'ACO', '大正科技', 'active'), ('${B}', 'BCO', '別家公司', 'active');
      INSERT INTO public.employees (id, company_id, employee_number, name, line_user_id, role, is_kiosk, can_schedule, status, is_active, shift_mode) VALUES
        ('${E.admin}', '${A}', 'A01', '主管甲', 'Uadmin', 'admin', false, false, 'approved', true, 'fixed'),
        ('${E.mgr}', '${A}', 'A02', '主管乙', 'Umgr', 'manager', false, false, 'approved', true, 'fixed'),
        ('${E.e1}', '${A}', 'E01', '員工一', 'U1', 'user', false, false, 'approved', true, 'fixed'),
        ('${E.e2}', '${A}', 'E02', '員工二', 'U2', 'user', false, false, 'approved', true, 'fixed'),
        ('${E.e3}', '${A}', 'E03', '員工三', 'U3', 'user', false, false, 'approved', true, 'fixed'),
        ('${E.e4}', '${A}', 'E04', '員工四', 'U4', 'user', false, false, 'approved', true, 'scheduled'),
        ('${E.e5}', '${A}', 'E05', '員工五', 'U5', 'user', false, false, 'approved', true, 'scheduled'),
        ('${E.sched}', '${A}', 'E09', '排班員', 'U9', 'user', false, true, 'approved', true, 'fixed'),
        ('${E.kiosk}', '${A}', 'K01', '公務機', 'Ukiosk', 'user', true, false, 'approved', true, 'fixed'),
        ('${E.bAdmin}', '${B}', 'B01', '別家主管', 'UBadmin', 'admin', false, true, 'approved', true, 'fixed'),
        ('${E.bUser}', '${B}', 'B02', '別家員工', 'UB1', 'user', false, false, 'approved', true, 'fixed');
      INSERT INTO public.platform_admins (id, line_user_id, name) VALUES ('${PA}', 'Uplatform', '平台');
      INSERT INTO public.platform_admin_companies (platform_admin_id, company_id, role) VALUES ('${PA}', '${A}', 'owner');
      INSERT INTO public.shift_types (id, code, name, start_time, end_time, company_id) VALUES
        ('${ST.day}', 'D', '早班', '08:00', '17:00', '${A}'), ('${ST.night}', 'N', '晚班', '14:00', '23:00', '${A}'),
        ('${ST.b}', 'D', 'B 早班', '08:00', '17:00', '${B}');
      INSERT INTO public.schedules (employee_id, date, shift_type_id) VALUES
        ('${E.e4}', '${SWAP_DATE}', '${ST.day}'), ('${E.e5}', '${SWAP_DATE}', '${ST.night}'),
        ('${E.e4}', '${today}', '${ST.day}'), ('${E.bUser}', '${SWAP_DATE}', '${ST.b}'), ('${E.e1}', '${OFF_DATE}', '${ST.day}');
      INSERT INTO public.schedules (employee_id, date, shift_type_id, is_off_day, notes) VALUES ('${E.e2}', '${OFF_DATE}', NULL, true, '家中有事');
      INSERT INTO public.attendance (employee_id, date, check_in_time, check_out_time, is_late) VALUES
        ('${E.bUser}', '${yesterday}', now() - interval '1 day 9 hours', now() - interval '1 day', false);
      INSERT INTO public.shift_swap_requests (id, requester_id, target_id, swap_date, status, target_agreed, requester_original_shift, target_original_shift) VALUES
        ('${SW.ok}', '${E.e4}', '${E.e5}', '${SWAP_DATE}', 'pending_admin', true, '早班', '晚班'),
        ('${SW.notAgreed}', '${E.e4}', '${E.e5}', '${SWAP_DATE}', 'pending_target', NULL, '早班', '晚班'),
        ('${SW.noSched}', '${E.e1}', '${E.e2}', '${SWAP_DATE}', 'pending_admin', true, NULL, NULL),
        ('${SW.cross}', '${E.e4}', '${E.bUser}', '${SWAP_DATE}', 'pending_admin', true, '早班', 'B 早班'),
        ('${SW.rej}', '${E.e4}', '${E.e5}', '${SWAP_DATE}', 'pending_admin', true, '早班', '晚班'),
        ('${SW.b}', '${E.bUser}', '${E.bAdmin}', '${SWAP_DATE}', 'pending_admin', true, NULL, NULL),
        ('${SW.pa}', '${E.e4}', '${E.e5}', '${SWAP_DATE}', 'pending_admin', true, '早班', '晚班'),
        ('${SW.off}', '${E.e1}', '${E.e2}', '${OFF_DATE}', 'pending_admin', true, '早班', '休');
    `);
  }

  // ---------- 0. 起點：PR #3 上線後（130／131／132 已套） ----------
  let err = await apply(m130) || await apply(m131) || await apply(m132);
  check('起點：以正式庫擁有者身分套 130／131／132（PR #3 上線後的狀態）', err === '', err);

  // ---------- 1. 套用前：重現 ----------
  console.log('\n=== 套用前（PR #3 之後的正式庫）：重現直接寫表 ===');
  await seed();
  let r = await as('anon', `INSERT INTO public.attendance (employee_id, date, check_in_time, check_out_time, is_manual)
      VALUES ($1, $2, now() - interval '10 hours', now(), false) RETURNING id`, [E.bUser, today]);
  check('現況重現：anon 直接新增別家公司員工的出勤', !r.error && r.rows.length === 1, r.error);
  r = await as('anon', `UPDATE public.attendance SET is_late = true, check_in_time = check_in_time + interval '2 hours' WHERE employee_id = $1 AND date = $2 RETURNING id`, [E.bUser, yesterday]);
  check('現況重現：anon 直接改既有出勤（上班時間、遲到）', !r.error && r.rows.length === 1, r.error);
  r = await as('authenticated', `DELETE FROM public.attendance WHERE employee_id = $1 RETURNING id`, [E.bUser]);
  check('現況重現：authenticated 直接刪出勤', !r.error && r.rows.length === 2, r.error);
  r = await as('anon', `INSERT INTO public.schedules (employee_id, date, is_off_day) VALUES ($1, '2026-10-20', true) RETURNING id`, [E.bUser]);
  check('現況重現：anon 直接新增別家公司的排班', !r.error && r.rows.length === 1, r.error);
  r = await as('anon', `UPDATE public.schedules SET shift_type_id = NULL, is_off_day = true WHERE employee_id = $1 RETURNING id`, [E.e4]);
  check('現況重現：anon 直接改排班', !r.error && r.rows.length === 2, r.error);
  r = await one(`SELECT has_table_privilege('anon', 'public.attendance', 'TRUNCATE') AS a, has_table_privilege('anon', 'public.schedules', 'TRUNCATE') AS s`);
  check('現況重現：anon 對兩張表有 TRUNCATE 權限', r.a === true && r.s === true);
  r = await rpc('anon', 'review_shift_swap_request', { p_company_id: A, p_line_user_id: 'Uadmin', p_request_id: SW.ok, p_decision: 'approve', p_reason: null });
  check('套用前：review_shift_swap_request 不存在', /does not exist/.test(r?.error || ''), r?.error);

  // ---------- 2. 套 133＋134 ----------
  console.log('\n=== 套用 133（換班審核新路徑）＋134（attendance 寫入鎖）===');
  await seed();
  err = await apply(m133);
  check('133 可在 PostgreSQL 套用（正式庫擁有者身分）', err === '', err);
  err = await apply(m134);
  check('134 可在 PostgreSQL 套用（正式庫擁有者身分）', err === '', err);
  const attCount = async () => (await one(`SELECT count(*)::int AS n FROM public.attendance`)).n;
  const before = await attCount();
  for (const role of ['anon', 'authenticated']) {
    r = await as(role, `INSERT INTO public.attendance (employee_id, date, check_in_time) VALUES ($1, $2, now())`, [E.bUser, today]);
    check(`${role} 直接新增出勤：permission denied`, denied(r), r.error);
    r = await as(role, `UPDATE public.attendance SET is_late = true WHERE employee_id = $1`, [E.bUser]);
    check(`${role} 直接改出勤：permission denied`, denied(r), r.error);
    r = await as(role, `DELETE FROM public.attendance WHERE employee_id = $1`, [E.bUser]);
    check(`${role} 直接刪出勤：permission denied`, denied(r), r.error);
    r = await as(role, `TRUNCATE public.attendance`);
    check(`${role} TRUNCATE 出勤：permission denied`, denied(r), r.error);
    r = await as(role, `SELECT a.date, a.check_in_time FROM public.attendance a JOIN public.employees e ON e.id = a.employee_id WHERE e.company_id = $1`, [B]);
    check(`${role} 仍讀得到出勤（打卡紀錄、打卡總覽、薪資頁；讀取收斂另案）`, !r.error && r.rows.length === 1, r.error);
  }
  check('出勤資料沒被動到', (await attCount()) === before && (await attOf(E.bUser, yesterday)).is_late === false);
  r = await as('anon', `INSERT INTO public.schedules (employee_id, date, shift_type_id) VALUES ($1, '2026-10-21', $2) RETURNING id`, [E.e1, ST.day]);
  check('135 之前：舊頁面直接存排班仍可用（相容，等快取過期）', !r.error && r.rows.length === 1, r.error);
  await db.exec(`DELETE FROM public.schedules WHERE date = '2026-10-21'`);

  console.log('\n--- 134 之後：打卡與補卡流程（與前端相同，以 anon 呼叫正式庫原文函式）---');
  await db.exec(`INSERT INTO public.attendance_anomalies (company_id, employee_id, date, anomaly_type, status) VALUES ('${A}', '${E.e1}', '${today}', 'missing_checkout', 'pending')`);
  r = await rpc('anon', 'quick_check_in', { p_line_user_id: 'U1', p_latitude: 25.03, p_longitude: 121.56, p_photo_url: null, p_device_id: 'dev1', p_action: 'check_in' });
  let row = await attOf(E.e1);
  check('一般打卡：上班成功、寫入 attendance', r?.success === true && r.type === 'check_in' && !!row?.check_in_time, JSON.stringify(r));
  r = await rpc('anon', 'quick_check_in', { p_line_user_id: 'U1', p_latitude: 25.03, p_longitude: 121.56, p_photo_url: null, p_device_id: 'dev1', p_action: 'check_out' });
  row = await attOf(E.e1);
  const anomaly = await one(`SELECT status, resolution FROM public.attendance_anomalies WHERE employee_id = $1 AND date = $2`, [E.e1, today]);
  check('一般打卡：下班成功、工時觸發器照常計算', r?.success === true && r.type === 'check_out' && !!row.check_out_time && row.total_work_hours !== null, JSON.stringify(r));
  check('下班時缺卡異常自動結案（觸發器寫 attendance_anomalies）照常', anomaly.status === 'resolved' && anomaly.resolution === 'makeup', JSON.stringify(anomaly));
  r = await rpc('anon', 'quick_check_in', { p_line_user_id: 'U2', p_latitude: 25.03, p_longitude: 121.56, p_photo_url: null, p_device_id: null, p_action: null });
  check('一般打卡（不帶 action 自動判斷）：上班成功', r?.success === true && r.type === 'check_in', JSON.stringify(r));
  r = await rpc('anon', 'quick_check_in', { p_line_user_id: 'U4', p_latitude: 25.03, p_longitude: 121.56, p_photo_url: null, p_device_id: null, p_action: 'check_in' });
  row = await attOf(E.e4);
  check('排班制員工打卡：讀當天排班，出勤帶 schedule_id／shift_type_id', r?.success === true && row.shift_type_id === ST.day && !!row.schedule_id, JSON.stringify(r));
  r = await rpc('authenticated', 'quick_check_in', { p_line_user_id: 'U4', p_latitude: 25.03, p_longitude: 121.56, p_photo_url: null, p_device_id: null, p_action: 'check_in' });
  check('重複上班打卡：照舊回 already_checked_in_today（不是權限錯誤）', r?.success === false && r.error === 'already_checked_in_today', JSON.stringify(r));
  r = await rpc('anon', 'quick_check_in', { p_line_user_id: 'Ukiosk', p_latitude: 0, p_longitude: 0, p_photo_url: null, p_device_id: null, p_action: 'check_in' });
  check('公務機帳號不能用一般打卡（照舊）', r?.error === 'kiosk_employee_must_use_kiosk');
  r = await rpc('anon', 'kiosk_check_in', { p_kiosk_line_user_id: 'Ukiosk', p_employee_id: E.e3, p_action: 'check_in', p_photo_url: null, p_latitude: null, p_longitude: null });
  check('公務機代打上班：成功、寫入 attendance', r?.success === true && !!(await attOf(E.e3))?.check_in_time, JSON.stringify(r));
  r = await rpc('anon', 'kiosk_check_in', { p_kiosk_line_user_id: 'Ukiosk', p_employee_id: E.e3, p_action: 'check_out', p_photo_url: null, p_latitude: null, p_longitude: null });
  check('公務機代打下班：成功', r?.success === true && !!(await attOf(E.e3))?.check_out_time, JSON.stringify(r));
  r = await rpc('anon', 'kiosk_check_in', { p_kiosk_line_user_id: 'Ukiosk', p_employee_id: E.bUser, p_action: 'check_in', p_photo_url: null, p_latitude: null, p_longitude: null });
  check('公務機代打別家公司員工：照舊拒絕', r?.success === false && !(await attOf(E.bUser)));
  r = await rpc('anon', 'submit_makeup_punch', { p_line_user_id: 'U5', p_punch_date: today, p_punch_type: 'clock_in', p_punch_time: '00:00', p_reason: '忘記打卡', p_note: null, p_company_id: A });
  check('補卡申請（submit_makeup_punch）：成功', r?.success === true, JSON.stringify(r));
  r = await rpc('anon', 'quick_check_out_after_clock_in_makeup', { p_line_user_id: 'U5', p_latitude: 25.03, p_longitude: 121.56, p_photo_url: null, p_device_id: null, p_action: 'check_out' });
  row = await attOf(E.e5);
  check('上班補卡待審時仍可下班（quick_check_out_after_clock_in_makeup）：成功、先建空白列再寫下班', r?.success === true && !!row?.check_out_time, JSON.stringify(r));
  await db.exec(`INSERT INTO public.makeup_punch_requests (id, employee_id, punch_date, punch_type, punch_time, reason, status)
      VALUES ('${MK}', '${E.e2}', '${yesterday}', 'clock_in', '08:00', '忘記打卡', 'pending')`);
  r = await rpc('service_role', 'review_makeup_request', { p_company_id: A, p_line_user_id: 'Umgr', p_request_id: MK, p_decision: 'approve', p_reason: null });
  check('補卡核准（131 review_makeup_request → approve_makeup_request）：成功、寫入 attendance', r?.success === true && !!(await attOf(E.e2, yesterday))?.check_in_time, JSON.stringify(r));
  r = await rpc('anon', 'admin_makeup_punch', { p_company_id: A, p_line_user_id: 'Uadmin', p_employee_id: E.e3, p_punch_date: yesterday, p_punch_type: 'clock_in', p_punch_time: '08:00', p_note: '補登' });
  check('管理員補登（admin_makeup_punch）：成功、寫入 attendance', r?.success === true && !!(await attOf(E.e3, yesterday))?.check_in_time, JSON.stringify(r));

  console.log('\n--- 換班審核（review_shift_swap_request）---');
  const sw = (uid, id, decision, company = A, reason = null) => rpc('service_role', 'review_shift_swap_request', { p_company_id: company, p_line_user_id: uid, p_request_id: id, p_decision: decision, p_reason: reason });
  const swRow = id => one(`SELECT status, approver_id, rejection_reason FROM public.shift_swap_requests WHERE id = $1`, [id]);
  for (const role of ['anon', 'authenticated']) {
    r = await rpc(role, 'review_shift_swap_request', { p_company_id: A, p_line_user_id: 'Uadmin', p_request_id: SW.ok, p_decision: 'approve', p_reason: null });
    check(`${role} 不能直接呼叫 review_shift_swap_request（必須經 Edge Function 驗 LIFF）`, denied(r), r?.error);
  }
  r = await sw('Ukiosk', SW.ok, 'approve');
  check('公務機不能審換班', r?.error_code === 'access_denied');
  r = await sw('U1', SW.ok, 'approve');
  check('一般員工不能審換班', r?.error_code === 'access_denied');
  r = await sw('U9', SW.ok, 'approve');
  check('只有排班權限（can_schedule）的員工不能審換班（審核限主管）', r?.error_code === 'access_denied');
  r = await sw('UBadmin', SW.ok, 'approve', B);
  check('別家公司主管審 A 的換班：找不到（跨公司擋下）', r?.error_code === 'not_found' && (await swRow(SW.ok)).status === 'pending_admin');
  r = await sw('UBadmin', SW.ok, 'approve');
  check('別家公司主管自稱 A 公司：拒絕', r?.error_code === 'access_denied');
  r = await sw('Umgr', SW.cross, 'approve');
  check('對象是別家公司員工的換班：找不到，B 的排班不變', r?.error_code === 'not_found' && (await schedOf(E.bUser, SWAP_DATE)).shift_type_id === ST.b);
  r = await sw('Umgr', SW.notAgreed, 'approve');
  check('對方尚未同意（pending_target）：不能核准', r?.error_code === 'not_pending');
  await db.exec(`UPDATE public.shift_swap_requests SET status = 'pending_admin', target_agreed = false WHERE id = '${SW.notAgreed}'`);
  r = await sw('Umgr', SW.notAgreed, 'approve');
  check('狀態是 pending_admin 但對方未同意：不能核准', r?.error_code === 'not_agreed' && (await schedOf(E.e4, SWAP_DATE)).shift_type_id === ST.day);
  r = await sw('Umgr', SW.noSched, 'approve');
  check('一方當天沒有排班：不能核准、申請仍待審', r?.error_code === 'schedule_missing' && (await swRow(SW.noSched)).status === 'pending_admin');
  r = await sw('Umgr', SW.ok, 'maybe');
  check('審核動作不合法：拒絕', r?.error_code === 'invalid_value');
  r = await sw('Umgr', SW.ok, 'approve');
  let s4 = await schedOf(E.e4, SWAP_DATE), s5 = await schedOf(E.e5, SWAP_DATE), swr = await swRow(SW.ok);
  check('主管核准換班：兩人班別互換、申請 approved、審核人＝LINE 驗證的本人', r?.success === true && s4.shift_type_id === ST.night && s5.shift_type_id === ST.day
    && swr.status === 'approved' && swr.approver_id === E.mgr && r.requester_id === E.e4 && r.target_id === E.e5, JSON.stringify(r));
  r = await sw('Uadmin', SW.ok, 'reject');
  check('已處理過的換班不能再審', r?.error_code === 'not_pending' && (await swRow(SW.ok)).status === 'approved');
  r = await sw('Uadmin', SW.rej, 'reject', A, '人手不足');
  swr = await swRow(SW.rej);
  check('admin 拒絕換班：rejected、記錄原因、班表不動', r?.success === true && swr.status === 'rejected' && swr.rejection_reason === '人手不足' && swr.approver_id === E.admin
    && (await schedOf(E.e4, SWAP_DATE)).shift_type_id === ST.night);
  r = await sw('Uplatform', SW.pa, 'approve');
  swr = await swRow(SW.pa);
  check('綁 A 的平台管理員核准：成功（不在 employees 表，審核人為 NULL）', r?.success === true && swr.status === 'approved' && swr.approver_id === null
    && (await schedOf(E.e4, SWAP_DATE)).shift_type_id === ST.day);
  r = await sw('Umgr', SW.b, 'approve');
  check('A 主管審 B 公司內部的換班：找不到', r?.error_code === 'not_found');
  r = await sw('Umgr', SW.off, 'approve');
  const o1 = await schedOf(E.e1, OFF_DATE), o2 = await schedOf(E.e2, OFF_DATE);
  check('上班日與休假日互換：整格互換（班別＋休假標記），不會出現「有班別又標休假」', r?.success === true
    && o1.shift_type_id === null && o1.is_off_day === true && o2.shift_type_id === ST.day && o2.is_off_day === false, JSON.stringify([o1, o2]));
  check('換班不動備註', o2.notes === '家中有事' && o1.notes === null);

  // ---------- 3. 套 135 ----------
  console.log('\n=== 套用 135（schedules 寫入鎖）===');
  {
    const db2 = new PGlite();
    await db2.exec(snapshot);
    let e2 = '';
    try { await db2.exec(m135); } catch (e) { e2 = e.message; }
    check('沒套 131／133 就套 135：中止（避免排班、換班失去寫入路徑）', /131／133/.test(e2), e2);
    await db2.exec('ROLLBACK');
    // 以非擁有者身分套 134：REVOKE 只會警告不會報錯 → 必須由檔內自我檢查（或 DROP POLICY）整筆回復
    let e3 = '';
    try { await db2.exec('SET ROLE service_role'); await db2.exec(m134); } catch (e) { e3 = e.message; }
    try { await db2.exec('ROLLBACK'); } catch (_) { /* 無交易 */ }
    await db2.exec('RESET ROLE');
    const still = (await db2.query(`SELECT has_table_privilege('anon', 'public.attendance', 'INSERT') AS i,
      (SELECT count(*)::int FROM pg_policies WHERE tablename = 'attendance' AND policyname = '允許插入考勤記錄') AS p`)).rows[0];
    check('不是以表擁有者身分套 134：中止、整筆回復（不會出現「以為撤了其實沒撤」）', e3 !== '' && still.i === true && still.p === 1, e3);
    await db2.close();
  }
  await seed();
  err = await apply(m135);
  check('135 可在 PostgreSQL 套用（正式庫擁有者身分）', err === '', err);
  const schedCount = async () => (await one(`SELECT count(*)::int AS n FROM public.schedules`)).n;
  const sBefore = await schedCount();
  for (const role of ['anon', 'authenticated']) {
    r = await as(role, `INSERT INTO public.schedules (employee_id, date, is_off_day) VALUES ($1, '2026-10-20', true)`, [E.bUser]);
    check(`${role} 直接新增排班：permission denied`, denied(r), r.error);
    r = await as(role, `UPDATE public.schedules SET shift_type_id = NULL, is_off_day = true WHERE employee_id = $1`, [E.e4]);
    check(`${role} 直接改排班：permission denied`, denied(r), r.error);
    r = await as(role, `INSERT INTO public.schedules (employee_id, date, shift_type_id) VALUES ($1, $2, $3) ON CONFLICT (employee_id, date) DO UPDATE SET shift_type_id = EXCLUDED.shift_type_id`, [E.e4, SWAP_DATE, ST.night]);
    check(`${role} 直接 upsert 排班（原本 saveSchedule 的寫法）：permission denied`, denied(r), r.error);
    r = await as(role, `DELETE FROM public.schedules WHERE employee_id = $1`, [E.e4]);
    check(`${role} 直接刪排班：permission denied`, denied(r), r.error);
    r = await as(role, `TRUNCATE public.schedules`);
    check(`${role} TRUNCATE 排班：permission denied`, denied(r), r.error);
    r = await as(role, `SELECT s.date FROM public.schedules s JOIN public.employees e ON e.id = s.employee_id WHERE e.company_id = $1`, [A]);
    check(`${role} 仍讀得到排班（班表頁、薪資頁）`, !r.error && r.rows.length === 5, r.error);
  }
  check('排班資料沒被動到', (await schedCount()) === sBefore && (await schedOf(E.e4, SWAP_DATE)).shift_type_id === ST.day);
  r = await rpc('service_role', 'save_schedules_verified', { p_company_id: A, p_line_user_id: 'Uadmin', p_items: JSON.stringify([
    { employee_id: E.e1, date: '2026-10-06', shift_type_id: ST.day }, { employee_id: E.e2, date: '2026-10-06', is_off_day: true },
    { employee_id: E.e4, date: SWAP_DATE, shift_type_id: ST.night }]) });
  check('135 之後：後台排班儲存（schedule_save → save_schedules_verified）照常', r?.success === true && r.saved_count === 3
    && (await schedOf(E.e4, SWAP_DATE)).shift_type_id === ST.night && (await schedOf(E.e2, '2026-10-06')).is_off_day === true, JSON.stringify(r));
  r = await rpc('service_role', 'save_schedules_verified', { p_company_id: A, p_line_user_id: 'U9', p_items: JSON.stringify([{ employee_id: E.e1, date: '2026-10-06', delete: true }]) });
  check('135 之後：排班員刪除排班照常', r?.success === true && !(await schedOf(E.e1, '2026-10-06')));
  r = await rpc('service_role', 'save_schedules_verified', { p_company_id: A, p_line_user_id: 'Uadmin', p_items: JSON.stringify([
    { employee_id: E.e2, date: OFF_DATE, shift_type_id: ST.night, is_off_day: false, notes: '家中有事' }]) });
  check('排班儲存帶原本的備註（前端沿用）：備註保留', r?.success === true && (await schedOf(E.e2, OFF_DATE)).notes === '家中有事');
  r = await sw('Umgr', SW.rej, 'approve');
  check('135 之後：換班核准照常（兩人班別互換）', r?.success === true && (await schedOf(E.e4, SWAP_DATE)).shift_type_id === ST.night && (await schedOf(E.e5, SWAP_DATE)).shift_type_id === ST.night, JSON.stringify(r));
  r = await rpc('anon', 'quick_check_in', { p_line_user_id: 'U4', p_latitude: 25.03, p_longitude: 121.56, p_photo_url: null, p_device_id: null, p_action: 'check_in' });
  check('135 之後：排班制員工打卡照常（讀 schedules）', r?.success === true && (await attOf(E.e4)).shift_type_id === ST.day, JSON.stringify(r));
  r = await rpc('anon', 'kiosk_check_in', { p_kiosk_line_user_id: 'Ukiosk', p_employee_id: E.e1, p_action: 'check_in', p_photo_url: null, p_latitude: null, p_longitude: null });
  check('135 之後：公務機打卡照常', r?.success === true, JSON.stringify(r));
  // 已被打卡紀錄引用的排班（attendance.schedule_id，正式庫有外鍵）：刪除會讓整批失敗 → 前端事先略過並告知
  const refd = await one(`SELECT a.schedule_id FROM public.attendance a WHERE a.employee_id = $1 AND a.date = $2`, [E.e4, today]);
  r = await rpc('service_role', 'save_schedules_verified', { p_company_id: A, p_line_user_id: 'Uadmin', p_items: JSON.stringify([
    { employee_id: E.e1, date: '2026-10-09', shift_type_id: ST.day }, { employee_id: E.e4, date: today, delete: true }]) });
  check('（說明前端為何先檢查）刪除已有打卡紀錄的排班：DB 外鍵擋下、整批不存', !!refd?.schedule_id && r?.success === false && r.error_code === 'item_failed'
    && /foreign key/.test(r.error) && !!(await schedOf(E.e4, today)) && !(await schedOf(E.e1, '2026-10-09')), JSON.stringify(r));

  check('打卡／補卡／排班寫入函式（10 支）本體與正式庫原文逐字相同（本 PR 不改打卡路徑）', (await writerDefs()) === writersBefore);

  // ---------- 4. 回滾、重套 ----------
  console.log('\n=== 順序防呆、回滾、重套 ===');
  err = await apply(m133rb);
  check('135 還在時回滾 133：中止', /135/.test(err), err);
  err = await apply(m135rb);
  check('135 回滾可套用', err === '', err);
  check('135 回滾：schedules 的政策與 grant 與正式庫快照逐項相同', (await pols('schedules')) === snap.schedules.pol && (await relAcl('schedules')) === snap.schedules.acl,
    await relAcl('schedules'));
  err = await apply(m134rb);
  check('134 回滾可套用', err === '', err);
  check('134 回滾：attendance 的政策與 grant 與正式庫快照逐項相同', (await pols('attendance')) === snap.attendance.pol && (await relAcl('attendance')) === snap.attendance.acl,
    await relAcl('attendance'));
  err = await apply(m133rb);
  check('133 回滾：review_shift_swap_request 移除', err === '' && !(await one(`SELECT 1 AS x FROM pg_proc WHERE proname = 'review_shift_swap_request'`)), err);
  err = '';
  for (let i = 0; i < 2 && !err; i++) err = await apply(m133) || await apply(m134) || await apply(m135);
  check('133、134、135 可重複套用', err === '', err);
  r = await as('anon', `INSERT INTO public.attendance (employee_id, date) VALUES ($1, '2026-10-30')`, [E.bUser]);
  const r2 = await as('anon', `INSERT INTO public.schedules (employee_id, date) VALUES ($1, '2026-10-30')`, [E.bUser]);
  check('重套後仍擋直接寫入', denied(r) && denied(r2));

  console.log(`\n結果：${pass} 通過、${fail} 失敗`);
  process.exit(fail > 0 ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
