// ============================================================
// migration 142／143：公務機（kiosk）改由 LINE 驗證身分決定 — PGlite 實跑
//
// 不連線、不寫正式庫。流程：
//   1. 載入正式庫快照（phase0＋attendance_schedules＋kiosk_prod_snapshot；kiosk_* 原文與 proacl 取自正式庫）
//      以 130～135 已套用為起點，先重現：anon 只要報公務機的 LINE ID 就能查員工、代打卡
//   2. 順序防呆：142 之前套 143 → 中止
//   3. 套 142：新函式只給 service_role；身分（恰好 1 個在職公務機帳號）／查員工／代打卡各情境；
//      舊函式本體不變、補上 search_path；舊頁面仍可用（相容期）
//   4. 套 143：舊函式 anon／authenticated 被擋；LINE 驗證路徑照常
//   5. 回滾順序防呆、回滾後 proacl 與正式庫快照逐項相同、可重複套用
// 反向對照（證明測試在舊程式會失敗）：MIGRATION142_FILE／MIGRATION143_FILE 指向空檔 → 大量失敗
// ============================================================
const fs = require('fs');
const path = require('path');
const { PGlite } = require('@electric-sql/pglite');

const root = path.join(__dirname, '..');
const read = f => fs.readFileSync(f, 'utf8');
const snapshot = ['phase0_prod_snapshot.sql', 'attendance_schedules_prod_snapshot.sql', 'kiosk_prod_snapshot.sql']
  .map(f => read(path.join(__dirname, 'fixtures', f))).join('\n');
const mig = n => read(path.join(root, 'migrations', n));
const base = ['130_companies_binding_attempts_lock.sql', '131_verified_admin_rpcs.sql', '132_verified_admin_rpcs_revoke.sql',
  '133_shift_swap_verified_review.sql', '134_attendance_write_lock.sql', '135_schedules_write_lock.sql'].map(mig);
const m142 = read(process.env.MIGRATION142_FILE || path.join(root, 'migrations', '142_kiosk_verified_calls.sql'));
const m143 = read(process.env.MIGRATION143_FILE || path.join(root, 'migrations', '143_kiosk_legacy_revoke.sql'));
const m142rb = mig('142_kiosk_verified_calls_rollback.sql');
const m143rb = mig('143_kiosk_legacy_revoke_rollback.sql');

let pass = 0, fail = 0;
function check(name, condition, detail = '') {
  if (condition) { pass++; console.log(`  ✅ ${name}${detail ? `  → ${detail}` : ''}`); }
  else { fail++; console.log(`  ❌ ${name}${detail ? `  → ${detail}` : ''}`); }
}

const A = '8a669e2c-7521-43e9-9300-5c004c57e9db';
const B = '11111111-2222-3333-4444-555555555555';
const E = {
  admin: '00000000-0000-0000-0000-0000000000a1',
  e1: '00000000-0000-0000-0000-0000000000e1', e2: '00000000-0000-0000-0000-0000000000e2',
  e3: '00000000-0000-0000-0000-0000000000e3', e4: '00000000-0000-0000-0000-0000000000e4',
  quit: '00000000-0000-0000-0000-0000000000e8',
  kiosk: '00000000-0000-0000-0000-0000000000c1', kioskOff: '00000000-0000-0000-0000-0000000000c2',
  dupA: '00000000-0000-0000-0000-0000000000c3', dupB: '00000000-0000-0000-0000-0000000000c4',
  bKiosk: '00000000-0000-0000-0000-0000000000c5', bUser: '00000000-0000-0000-0000-0000000000b2',
};
const OLD = ['kiosk_get_company(text)', 'kiosk_lookup_employee(text, text)',
  'kiosk_check_in(text, uuid, text, text, double precision, double precision)'].map(f => 'public.' + f);
const NEW = ['kiosk_resolve_verified(text)', 'kiosk_get_company_verified(text)', 'kiosk_lookup_employee_verified(text, text)',
  'kiosk_check_in_verified(text, uuid, text, text, double precision, double precision)'].map(f => 'public.' + f);

(async () => {
  console.log('\n═══════════════════════════════════════');
  console.log('  公務機改由 LINE 驗證身分（142／143，PGlite 實跑）');
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
  const procAcl = async f => (await q(`SELECT coalesce(r.rolname, 'PUBLIC') AS g, a.privilege_type AS p
      FROM aclexplode((SELECT coalesce(proacl, acldefault('f', proowner)) FROM pg_proc WHERE oid = $1::regprocedure)) a
      LEFT JOIN pg_roles r ON r.oid = a.grantee
      WHERE coalesce(r.rolname, 'PUBLIC') <> 'prod_postgres' ORDER BY 1, 2`, [f])).map(x => x.g + ':' + x.p).join(',');
  const oldAcl = async () => (await Promise.all(OLD.map(procAcl))).join(' | ');
  const oldSrc = async () => (await Promise.all(OLD.map(f => one(`SELECT prosrc FROM pg_proc WHERE oid = $1::regprocedure`, [f])))).map(x => x.prosrc).join('\n');
  const oldConf = async () => (await Promise.all(OLD.map(f => one(`SELECT coalesce(array_to_string(proconfig, ','), '') AS c FROM pg_proc WHERE oid = $1::regprocedure`, [f])))).map(x => x.c);
  const today = (await one(`SELECT (now() AT TIME ZONE 'Asia/Taipei')::date::text AS d`)).d;
  const attOf = emp => one(`SELECT * FROM public.attendance WHERE employee_id = $1 AND date = $2`, [emp, today]);
  const attCount = async () => (await one(`SELECT count(*)::int AS n FROM public.attendance`)).n;

  async function seed() {
    await db.exec(`
      DELETE FROM public.attendance_anomalies; DELETE FROM public.shift_swap_requests; DELETE FROM public.attendance;
      DELETE FROM public.schedules; DELETE FROM public.makeup_punch_requests; DELETE FROM public.system_settings;
      DELETE FROM public.shift_types; DELETE FROM public.platform_admin_companies; DELETE FROM public.platform_admins;
      DELETE FROM public.employees; DELETE FROM public.binding_attempts; DELETE FROM public.companies;
      INSERT INTO public.companies (id, code, name, status) VALUES ('${A}', 'ACO', '大正科技', 'active'), ('${B}', 'BCO', '別家公司', 'active');
      INSERT INTO public.employees (id, company_id, employee_number, name, line_user_id, phone, id_card_last_4, role, is_kiosk, status, is_active, shift_mode) VALUES
        ('${E.admin}', '${A}', 'A01', '主管甲', 'Uadmin', NULL, NULL, 'admin', false, 'approved', true, 'fixed'),
        ('${E.e1}', '${A}', 'E01', '員工一', 'U1', '0911000001', '1111', 'user', false, 'approved', true, 'fixed'),
        ('${E.e2}', '${A}', 'E02', '員工二', 'U2', '0911000002', '2222', 'user', false, 'approved', true, 'fixed'),
        ('${E.e3}', '${A}', 'E03', '員工三', NULL, '0911000003', '3333', 'user', false, 'approved', true, 'fixed'),
        ('${E.e4}', '${A}', 'E04', '員工四', NULL, '0911000004', '4444', 'user', false, 'approved', true, 'fixed'),
        ('${E.quit}', '${A}', 'E08', '已離職', NULL, '0911000008', '8888', 'user', false, 'resigned', false, 'fixed'),
        ('${E.kiosk}', '${A}', 'K01', '公務機', 'Ukiosk', NULL, NULL, 'user', true, 'approved', true, 'fixed'),
        ('${E.kioskOff}', '${A}', 'K02', '停用公務機', 'UkioskOff', NULL, NULL, 'user', true, 'approved', false, 'fixed'),
        ('${E.dupA}', '${A}', 'K03', '重複公務機甲', 'Udup', NULL, NULL, 'user', true, 'approved', true, 'fixed'),
        ('${E.dupB}', '${B}', 'K04', '重複公務機乙', 'Udup', NULL, NULL, 'user', true, 'approved', true, 'fixed'),
        ('${E.bKiosk}', '${B}', 'K05', '別家公務機', 'UBkiosk', NULL, NULL, 'user', true, 'approved', true, 'fixed'),
        ('${E.bUser}', '${B}', 'B02', '別家員工', 'UB1', '0922000002', '9999', 'user', false, 'approved', true, 'fixed');
    `);
  }

  // ---------- 0. 起點：130～135 已套用 ----------
  let err = '';
  for (const m of base) { err = err || await apply(m); }
  check('基底 130～135 可套用', err === '', err);
  const snapAcl = await oldAcl();
  const srcBefore = await oldSrc();
  check('快照：舊 kiosk_* 三支 PUBLIC／anon／authenticated 皆可執行（與正式庫 proacl 相同）',
    (snapAcl.match(/PUBLIC:EXECUTE/g) || []).length === 3 && (snapAcl.match(/anon:EXECUTE/g) || []).length === 3
      && (snapAcl.match(/authenticated:EXECUTE/g) || []).length === 3, snapAcl);
  await seed();

  console.log('\n=== 1. 重現：前端自報公務機 LINE ID 就能用 ===');
  let r = await rpc('anon', 'kiosk_lookup_employee', { p_kiosk_line_user_id: 'Ukiosk', p_identifier: '0911000003' });
  check('anon 報公務機 ID → 可用手機查到員工資料（修正前）', r?.success === true && r.employee_id === E.e3, JSON.stringify(r));
  r = await rpc('anon', 'kiosk_check_in', { p_kiosk_line_user_id: 'Ukiosk', p_employee_id: E.e4, p_action: 'check_in', p_photo_url: null, p_latitude: null, p_longitude: null });
  check('anon 報公務機 ID → 可代任何同公司員工打卡（修正前）', r?.success === true && !!(await attOf(E.e4)), JSON.stringify(r));
  await seed();

  console.log('\n=== 2. 順序防呆 ===');
  err = await apply(m143);
  check('142 之前套 143：中止', /142/.test(err), err);
  check('中止後舊函式權限不變', (await oldAcl()) === snapAcl);

  console.log('\n=== 3. 套 142 ===');
  err = await apply(m142);
  check('142 可套用', err === '', err);
  for (const f of NEW) {
    const fn = f.replace('public.', '').replace(/\(.*/, '');
    const acl = await procAcl(f);
    check(`${fn}：只有 service_role 可執行`, acl === 'service_role:EXECUTE', acl);
  }
  check('舊函式本體逐字不變', (await oldSrc()) === srcBefore);
  check('舊函式補上 search_path=public', (await oldConf()).every(c => c === 'search_path=public'), JSON.stringify(await oldConf()));

  // 直接以 anon／authenticated 呼叫新函式 → 權限錯誤
  r = await rpc('anon', 'kiosk_get_company_verified', { p_line_user_id: 'Ukiosk' });
  check('anon 不能呼叫 kiosk_get_company_verified', denied(r), r.error);
  r = await rpc('authenticated', 'kiosk_check_in_verified', { p_line_user_id: 'Ukiosk', p_employee_id: E.e1, p_action: 'check_in', p_photo_url: null, p_latitude: null, p_longitude: null });
  check('authenticated 不能呼叫 kiosk_check_in_verified', denied(r) && !(await attOf(E.e1)), r.error);

  // 身分
  r = await rpc('service_role', 'kiosk_get_company_verified', { p_line_user_id: 'Ukiosk' });
  check('公務機帳號：取得公司名稱與 ID', r?.success === true && r.name === '大正科技' && r.company_id === A, JSON.stringify(r));
  for (const [who, id] of [['一般員工', 'U1'], ['主管', 'Uadmin'], ['停用的公務機', 'UkioskOff'], ['同一 LINE 綁兩個公務機', 'Udup'], ['不存在', 'Unobody'], ['空字串', ''], ['NULL', null]]) {
    r = await rpc('service_role', 'kiosk_get_company_verified', { p_line_user_id: id });
    check(`${who} → access_denied`, r?.success === false && r.error_code === 'access_denied', JSON.stringify(r));
  }

  // 查員工
  r = await rpc('service_role', 'kiosk_lookup_employee_verified', { p_line_user_id: 'Ukiosk', p_identifier: 'E03' });
  check('查員工（工號）：成功', r?.success === true && r.employee_id === E.e3 && r.name === '員工三', JSON.stringify(r));
  r = await rpc('service_role', 'kiosk_lookup_employee_verified', { p_line_user_id: 'Ukiosk', p_identifier: ' 3333 ' });
  check('查員工（身分證後 4 碼，前後空白）：成功', r?.success === true && r.employee_id === E.e3, JSON.stringify(r));
  r = await rpc('service_role', 'kiosk_lookup_employee_verified', { p_line_user_id: 'Ukiosk', p_identifier: 'B02' });
  check('查別家公司員工 → not_found', r?.success === false && r.error_code === 'not_found', JSON.stringify(r));
  r = await rpc('service_role', 'kiosk_lookup_employee_verified', { p_line_user_id: 'Ukiosk', p_identifier: 'E08' });
  check('查已離職員工 → not_found', r?.success === false && r.error_code === 'not_found', JSON.stringify(r));
  r = await rpc('service_role', 'kiosk_lookup_employee_verified', { p_line_user_id: 'Ukiosk', p_identifier: '   ' });
  check('空白輸入 → invalid_value', r?.success === false && r.error_code === 'invalid_value', JSON.stringify(r));
  r = await rpc('service_role', 'kiosk_lookup_employee_verified', { p_line_user_id: 'Ukiosk', p_identifier: '1'.repeat(40) });
  check('過長輸入 → invalid_value', r?.success === false && r.error_code === 'invalid_value', JSON.stringify(r));
  r = await rpc('service_role', 'kiosk_lookup_employee_verified', { p_line_user_id: 'U1', p_identifier: 'E03' });
  check('非公務機查員工 → access_denied（不回傳員工資料）', r?.success === false && r.error_code === 'access_denied' && !r.employee_id, JSON.stringify(r));
  r = await rpc('service_role', 'kiosk_lookup_employee_verified', { p_line_user_id: 'UBkiosk', p_identifier: 'E03' });
  check('別家公務機查本公司員工 → not_found', r?.success === false && r.error_code === 'not_found', JSON.stringify(r));

  // 代打卡
  r = await rpc('service_role', 'kiosk_check_in_verified', { p_line_user_id: 'Ukiosk', p_employee_id: E.e3, p_action: 'check_in', p_photo_url: 'https://x/selfies/a.jpg', p_latitude: 24.08, p_longitude: 120.54 });
  let row = await attOf(E.e3);
  check('代打上班：成功，寫入公務機打卡、照片、座標', r?.success === true && r.type === 'check_in' && row?.check_in_location === '公務機打卡'
    && row.photo_url === 'https://x/selfies/a.jpg' && Number(row.latitude) === 24.08 && row.device_id === 'kiosk', JSON.stringify(r));
  r = await rpc('service_role', 'kiosk_check_in_verified', { p_line_user_id: 'Ukiosk', p_employee_id: E.e3, p_action: 'check_in', p_photo_url: null, p_latitude: null, p_longitude: null });
  check('重複上班：照舊拒絕（打卡規則沿用舊函式）', r?.success === false && /已完成上班打卡/.test(r.error || ''), JSON.stringify(r));
  r = await rpc('service_role', 'kiosk_check_in_verified', { p_line_user_id: 'Ukiosk', p_employee_id: E.e3, p_action: 'check_out', p_photo_url: null, p_latitude: null, p_longitude: null });
  check('代打下班：成功', r?.success === true && r.type === 'check_out' && !!(await attOf(E.e3))?.check_out_time, JSON.stringify(r));
  let n0 = await attCount();
  r = await rpc('service_role', 'kiosk_check_in_verified', { p_line_user_id: 'Ukiosk', p_employee_id: E.bUser, p_action: 'check_in', p_photo_url: null, p_latitude: null, p_longitude: null });
  check('代打別家公司員工：拒絕、不寫入', r?.success === false && (await attCount()) === n0, JSON.stringify(r));
  r = await rpc('service_role', 'kiosk_check_in_verified', { p_line_user_id: 'Ukiosk', p_employee_id: E.e1, p_action: 'bogus', p_photo_url: null, p_latitude: null, p_longitude: null });
  check('action 不是 check_in／check_out → invalid_value、不寫入（舊函式會當成上班卡）', r?.error_code === 'invalid_value' && !(await attOf(E.e1)), JSON.stringify(r));
  r = await rpc('service_role', 'kiosk_check_in_verified', { p_line_user_id: 'Ukiosk', p_employee_id: null, p_action: 'check_in', p_photo_url: null, p_latitude: null, p_longitude: null });
  check('沒帶員工 → invalid_value', r?.error_code === 'invalid_value', JSON.stringify(r));
  for (const [who, id] of [['一般員工自己的 LINE', 'U1'], ['停用的公務機', 'UkioskOff'], ['同一 LINE 綁兩個公務機', 'Udup']]) {
    n0 = await attCount();
    r = await rpc('service_role', 'kiosk_check_in_verified', { p_line_user_id: id, p_employee_id: E.e2, p_action: 'check_in', p_photo_url: null, p_latitude: null, p_longitude: null });
    check(`${who}代打 → access_denied、不寫入`, r?.error_code === 'access_denied' && (await attCount()) === n0, JSON.stringify(r));
  }

  // 相容期：舊頁面仍可用
  r = await rpc('anon', 'kiosk_check_in', { p_kiosk_line_user_id: 'Ukiosk', p_employee_id: E.e4, p_action: 'check_in', p_photo_url: null, p_latitude: null, p_longitude: null });
  check('相容期（142 後、143 前）：舊頁面 anon 呼叫舊函式仍可打卡', r?.success === true, JSON.stringify(r));
  r = await rpc('anon', 'kiosk_get_company', { p_kiosk_line_user_id: 'Ukiosk' });
  check('相容期：舊 kiosk_get_company 仍可用', r?.success === true && r.company_id === A, JSON.stringify(r));

  err = await apply(m142);
  check('142 可重複套用', err === '', err);

  console.log('\n=== 4. 套 143（撤舊權限）===');
  await seed();
  err = await apply(m143);
  check('143 可套用', err === '', err);
  for (const role of ['anon', 'authenticated']) {
    r = await rpc(role, 'kiosk_check_in', { p_kiosk_line_user_id: 'Ukiosk', p_employee_id: E.e1, p_action: 'check_in', p_photo_url: null, p_latitude: null, p_longitude: null });
    check(`${role} 呼叫舊 kiosk_check_in：權限錯誤、不寫入`, denied(r) && !(await attOf(E.e1)), r.error);
    r = await rpc(role, 'kiosk_lookup_employee', { p_kiosk_line_user_id: 'Ukiosk', p_identifier: '0911000001' });
    check(`${role} 呼叫舊 kiosk_lookup_employee：權限錯誤`, denied(r), r.error);
    r = await rpc(role, 'kiosk_get_company', { p_kiosk_line_user_id: 'Ukiosk' });
    check(`${role} 呼叫舊 kiosk_get_company：權限錯誤`, denied(r), r.error);
  }
  check('舊函式只剩 service_role', (await oldAcl()) === 'service_role:EXECUTE | service_role:EXECUTE | service_role:EXECUTE', await oldAcl());
  r = await rpc('service_role', 'kiosk_lookup_employee_verified', { p_line_user_id: 'Ukiosk', p_identifier: 'E02' });
  check('143 後 LINE 驗證路徑：查員工照常', r?.success === true && r.employee_id === E.e2, JSON.stringify(r));
  r = await rpc('service_role', 'kiosk_check_in_verified', { p_line_user_id: 'Ukiosk', p_employee_id: E.e2, p_action: 'check_in', p_photo_url: null, p_latitude: null, p_longitude: null });
  check('143 後 LINE 驗證路徑：代打卡照常', r?.success === true && !!(await attOf(E.e2)), JSON.stringify(r));
  r = await rpc('service_role', 'kiosk_get_company_verified', { p_line_user_id: 'Ukiosk' });
  check('143 後 LINE 驗證路徑：取公司照常', r?.success === true, JSON.stringify(r));

  console.log('\n=== 5. 回滾、重套 ===');
  err = await apply(m142rb);
  check('143 還在時回滾 142：中止', /143/.test(err), err);
  check('中止後新函式仍在', !!(await one(`SELECT 1 AS x FROM pg_proc WHERE proname = 'kiosk_check_in_verified'`)));
  err = await apply(m143rb);
  check('143 回滾可套用', err === '', err);
  check('143 回滾：舊函式 proacl 與正式庫快照逐項相同', (await oldAcl()) === snapAcl, await oldAcl());
  err = await apply(m142rb);
  check('142 回滾可套用', err === '', err);
  check('142 回滾：四支新函式移除', !(await one(`SELECT 1 AS x FROM pg_proc WHERE proname LIKE 'kiosk\\_%\\_verified' OR proname = 'kiosk_resolve_verified'`)));
  check('142 回滾：舊函式 search_path 還原為未設定、本體不變', (await oldConf()).every(c => c === '') && (await oldSrc()) === srcBefore, JSON.stringify(await oldConf()));
  err = '';
  for (let i = 0; i < 2 && !err; i++) err = await apply(m142) || await apply(m143);
  check('142、143 可重複套用', err === '', err);
  r = await rpc('anon', 'kiosk_check_in', { p_kiosk_line_user_id: 'Ukiosk', p_employee_id: E.e4, p_action: 'check_in', p_photo_url: null, p_latitude: null, p_longitude: null });
  check('重套後舊函式仍擋 anon', denied(r), r.error);

  console.log(`\n結果：${pass} 通過、${fail} 失敗`);
  process.exit(fail > 0 ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
