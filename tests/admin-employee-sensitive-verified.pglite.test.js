// migration 159：管理端員工敏感欄位 verified RPC（純本機 PGlite）。
// 反向對照：MIGRATION159_NO_PERMISSION=1 會移除管理權檢查；非主管拒絕案例必須失敗。
const fs = require('fs');
const path = require('path');
const { PGlite } = require('@electric-sql/pglite');

const root = path.join(__dirname, '..');
const read = file => fs.readFileSync(file, 'utf8');
let migration159 = read(process.env.MIGRATION159_FILE || path.join(root, 'migrations', '159_admin_employee_sensitive_verified.sql'));
if (process.env.MIGRATION159_NO_PERMISSION === '1') {
  migration159 = migration159.replace(
    /\n    IF NOT public\.is_company_manager_caller\(p_line_user_id, p_company_id\) THEN[\s\S]*?\n    END IF;/,
    ''
  );
}
const rollback159 = read(path.join(root, 'migrations', '159_admin_employee_sensitive_verified_rollback.sql'));

let pass = 0, fail = 0;
function check(name, ok, detail = '') {
  if (ok) pass++; else fail++;
  console.log(`  ${ok ? '✅' : '❌'} ${name}${detail ? ` → ${detail}` : ''}`);
}

const A = '10000000-0000-0000-0000-000000000001';
const B = '10000000-0000-0000-0000-000000000002';
const E = {
  admin: '20000000-0000-0000-0000-000000000001',
  manager: '20000000-0000-0000-0000-000000000002',
  user: '20000000-0000-0000-0000-000000000003',
  active: '20000000-0000-0000-0000-000000000004',
  pending: '20000000-0000-0000-0000-000000000005',
  resigned: '20000000-0000-0000-0000-000000000006',
  cross: '20000000-0000-0000-0000-000000000007'
};
const EXPECTED_KEYS = ['email', 'emergency_contact', 'emergency_phone', 'employee_id', 'id_card_last_4', 'phone', 'salary_type'];

(async () => {
  console.log('\n═══════════════════════════════════════');
  console.log('  管理端員工敏感欄位 verified RPC（159，PGlite 實跑）');
  console.log('═══════════════════════════════════════');

  const db = new PGlite();
  const q = async (sql, params) => (await db.query(sql, params)).rows;
  const one = async (sql, params) => (await q(sql, params))[0];
  async function as(role, sql, params = []) {
    try {
      await db.exec(`SET ROLE ${role}`);
      return { rows: await q(sql, params) };
    } catch (error) {
      return { error: error.message };
    } finally {
      await db.exec('RESET ROLE');
    }
  }
  async function apply(sql) {
    try {
      await db.exec('SET ROLE prod_postgres');
      await db.exec(sql);
      return '';
    } catch (error) {
      try { await db.exec('ROLLBACK'); } catch (_) { /* 無進行中交易 */ }
      return error.message;
    } finally {
      await db.exec('RESET ROLE');
    }
  }
  const idsSql = ids => ids === null ? 'NULL::uuid[]'
    : `ARRAY[${ids.map(id => `'${id}'::uuid`).join(',')}]::uuid[]`;
  const rpc = async (role, line, company, ids) => {
    const result = await as(role, `SELECT public.admin_get_employee_sensitive_verified(
      '${line}'::text,'${company}'::uuid,${idsSql(ids)}) r`);
    return result.error ? { error: result.error } : result.rows[0].r;
  };
  const denied = result => /permission denied/i.test(result?.error || '');

  await db.exec(`
    CREATE ROLE anon NOLOGIN;
    CREATE ROLE authenticated NOLOGIN;
    CREATE ROLE service_role NOLOGIN;
    CREATE ROLE prod_postgres NOLOGIN;
    GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
    GRANT USAGE, CREATE ON SCHEMA public TO prod_postgres;
    SET ROLE prod_postgres;

    CREATE TABLE public.employees (
      id uuid PRIMARY KEY, company_id uuid NOT NULL, line_user_id text, name text NOT NULL,
      role text NOT NULL DEFAULT 'user', is_active boolean NOT NULL DEFAULT true,
      is_kiosk boolean NOT NULL DEFAULT false, created_at timestamptz DEFAULT now(),
      status text DEFAULT 'approved', phone text, email text, emergency_contact text,
      emergency_phone text, id_card_last_4 text, salary_type text, hourly_rate numeric,
      verify_code text, id_last_four text, device_info jsonb,
      check_in_lat numeric, check_in_lng numeric, max_distance_meters numeric
    );

    CREATE FUNCTION public.is_company_manager_caller(p_line_user_id text, p_company_id uuid)
    RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public AS $$
      SELECT coalesce(p_line_user_id, '') <> '' AND p_company_id IS NOT NULL AND EXISTS (
        SELECT 1 FROM public.employees e
        WHERE e.line_user_id=p_line_user_id AND e.company_id=p_company_id AND e.is_active=true
          AND e.role IN ('admin','manager','platform_admin') AND coalesce(e.is_kiosk,false)=false
      )
    $$;
    REVOKE ALL ON FUNCTION public.is_company_manager_caller(text,uuid) FROM PUBLIC, anon, authenticated;
    GRANT EXECUTE ON FUNCTION public.is_company_manager_caller(text,uuid) TO service_role;

    INSERT INTO public.employees(
      id,company_id,line_user_id,name,role,is_active,is_kiosk,created_at,status,
      phone,email,emergency_contact,emergency_phone,id_card_last_4,salary_type,hourly_rate,verify_code
    ) VALUES
      ('${E.admin}','${A}','Uadmin','王管理員','admin',true,false,'2026-01-01','approved','0900000001','admin@test','家人','0900000091','1001','monthly',999,'SECRET1'),
      ('${E.manager}','${A}','Umanager','李主管','manager',true,false,'2026-01-02','approved','0900000002',NULL,NULL,NULL,'1002','monthly',888,'SECRET2'),
      ('${E.user}','${A}','Uuser','一般員工','user',true,false,'2026-01-03','approved','0900000003',NULL,NULL,NULL,'1003','hourly',777,'SECRET3'),
      ('${E.active}','${A}',NULL,'在職員工','user',true,false,'2026-01-04','approved','0900000004','active@test','甲','0900000094','1004','daily',666,'SECRET4'),
      ('${E.pending}','${A}',NULL,'待審員工','user',false,false,'2026-01-05','pending','0900000005',NULL,'乙','0900000095','1005','hourly',555,'SECRET5'),
      ('${E.resigned}','${A}',NULL,'離職員工','user',false,false,'2026-01-06','resigned','0900000006',NULL,NULL,NULL,'1006','monthly',444,'SECRET6'),
      ('${E.cross}','${B}','Ucross','別家公司','admin',true,false,'2026-01-07','approved','0900000007','cross@test','丙','0900000097','1007','monthly',333,'SECRET7');
    RESET ROLE;
  `);

  let err = await apply(migration159);
  check('159 可套用且檔尾 ACL 自我檢查通過', err === '', err);

  console.log('\n=== 管理權、公司隔離與回傳欄位 ===');
  let r = await rpc('service_role', 'Umanager', A, [E.active, E.cross]);
  check('manager 可讀同公司指定員工，跨公司 ID 不回傳', r?.success === true
    && r.employees?.length === 1 && r.employees[0].employee_id === E.active, JSON.stringify(r));
  check('每列只回工作單指定的 7 欄', JSON.stringify(Object.keys(r.employees[0]).sort()) === JSON.stringify(EXPECTED_KEYS),
    Object.keys(r.employees[0]).sort().join(','));
  check('不回 hourly_rate／verify_code／GPS 等其他欄位', !('hourly_rate' in r.employees[0])
    && !('verify_code' in r.employees[0]) && !('check_in_lat' in r.employees[0]));

  r = await rpc('service_role', 'Uuser', A, [E.active]);
  check('一般員工被拒 access_denied', r?.success === false && r.error_code === 'access_denied', JSON.stringify(r));
  r = await rpc('service_role', 'Uadmin', B, [E.cross]);
  check('A 公司管理員以 B 公司參數呼叫被拒', r?.success === false && r.error_code === 'access_denied', JSON.stringify(r));

  r = await rpc('service_role', 'Uadmin', A, null);
  const returnedIds = new Set((r?.employees || []).map(row => row.employee_id));
  check('employee_ids=NULL 回目前公司全部狀態', r?.success === true
    && [E.admin, E.manager, E.user, E.active, E.pending, E.resigned].every(id => returnedIds.has(id))
    && !returnedIds.has(E.cross), JSON.stringify([...returnedIds]));
  r = await rpc('service_role', 'Uadmin', A, []);
  check('空陣列回成功空清單', r?.success === true && r.employees?.length === 0, JSON.stringify(r));
  r = await rpc('service_role', 'Uadmin', A, Array(501).fill(E.active));
  check('employee_ids 超過 500 筆被拒', r?.success === false && r.error_code === 'invalid_employee_ids', JSON.stringify(r));

  console.log('\n=== ACL、rollback 與前提防呆 ===');
  check('anon 無 EXECUTE', denied(await rpc('anon', 'Uadmin', A, [E.active])));
  check('authenticated 無 EXECUTE', denied(await rpc('authenticated', 'Uadmin', A, [E.active])));
  const acl = await one(`SELECT p.prosecdef, p.proacl::text acl, p.proconfig
    FROM pg_proc p WHERE p.oid='public.admin_get_employee_sensitive_verified(text,uuid,uuid[])'::regprocedure`);
  check('RPC 保留 SECURITY DEFINER 且 ACL 只有 owner/service_role', acl?.prosecdef === true
    && /prod_postgres=X\/prod_postgres/.test(acl.acl) && /service_role=X\/prod_postgres/.test(acl.acl)
    && !/anon|authenticated|PUBLIC/i.test(acl.acl)
    && JSON.stringify(acl.proconfig) === JSON.stringify(['search_path=""']),
    `${acl?.acl} / ${JSON.stringify(acl?.proconfig)}`);

  err = await apply(rollback159);
  check('159 rollback 可套用', err === '', err);
  check('rollback 後函式不存在', (await one(`SELECT to_regprocedure(
    'public.admin_get_employee_sensitive_verified(text,uuid,uuid[])') IS NULL gone`)).gone === true);
  err = await apply(migration159);
  check('rollback 後可重套 159', err === '', err);

  err = await apply(rollback159);
  await apply('DROP FUNCTION public.is_company_manager_caller(text,uuid);');
  err = await apply(migration159);
  check('缺少管理員驗權 helper 時 159 明確中止', /is_company_manager_caller/.test(err) && /不存在/.test(err), err);

  console.log(`\n結果：${pass} 通過、${fail} 失敗`);
  await db.close();
  process.exitCode = fail ? 1 : 0;
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
