// migration 161：薪資／請假核准 verified wrapper（純本機 PGlite，不連正式庫）。
// 反向對照：PLANB161_SPOOF_LINE=1 會讓其中一支 wrapper 固定冒用管理員；
// PLANB161_EMPTY_PATH=1 會重現 wrapper 空白 search_path 無法委派正式舊函式的缺陷。
const fs = require('fs');
const path = require('path');
const { PGlite } = require('@electric-sql/pglite');

const root = path.join(__dirname, '..');
const read = file => fs.readFileSync(file, 'utf8');
let migration = read(path.join(root, 'migrations', '161_planb_batch1_payroll_leave_verified.sql'));
if (process.env.PLANB161_SPOOF_LINE === '1') {
  migration = migration.replace(
    'SELECT public.get_company_current_salaries(p_company_id, p_line_user_id);',
    "SELECT public.get_company_current_salaries(p_company_id, 'Uadmin');"
  );
}
if (process.env.PLANB161_EMPTY_PATH === '1') {
  migration = migration
    .replaceAll('SET search_path TO pg_catalog, public, pg_temp', "SET search_path TO ''")
    .replaceAll("ARRAY['search_path=pg_catalog, public, pg_temp']", "ARRAY['search_path=\"\"']");
}
const rollback = read(path.join(root, 'migrations', '161_planb_batch1_payroll_leave_verified_rollback.sql'));

let pass = 0, fail = 0;
function check(name, ok, detail = '') {
  ok ? pass++ : fail++;
  console.log(`  ${ok ? '✅' : '❌'} ${name}${detail ? ` → ${detail}` : ''}`);
}

const A = '10000000-0000-0000-0000-000000000001';
const B = '10000000-0000-0000-0000-000000000002';
const EMP = '20000000-0000-0000-0000-000000000001';
const REQ = '30000000-0000-0000-0000-000000000001';

(async () => {
  console.log('\n═══════════════════════════════════════');
  console.log('  Plan B Batch 1 verified RPC（161，PGlite 實跑）');
  console.log('═══════════════════════════════════════');

  const db = new PGlite();
  const rows = async (sql, params) => (await db.query(sql, params)).rows;
  const one = async (sql, params) => (await rows(sql, params))[0];
  async function as(role, sql) {
    try {
      await db.exec(`SET ROLE ${role}`);
      return { rows: await rows(sql) };
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
      try { await db.exec('ROLLBACK'); } catch (_) { /* no transaction */ }
      return error.message;
    } finally {
      await db.exec('RESET ROLE');
    }
  }

  await db.exec(`
    CREATE ROLE anon NOLOGIN;
    CREATE ROLE authenticated NOLOGIN;
    CREATE ROLE service_role NOLOGIN;
    CREATE ROLE prod_postgres NOLOGIN;
    GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
    GRANT USAGE, CREATE ON SCHEMA public TO prod_postgres;
    SET ROLE prod_postgres;

    CREATE TABLE public.salary_settings(employee_id uuid, company_id uuid, base_salary numeric, is_current boolean);
    CREATE TABLE public.payroll(employee_id uuid, company_id uuid, year integer, month integer);
    INSERT INTO public.salary_settings VALUES ('${EMP}', '${A}', 42000, true);
    INSERT INTO public.payroll VALUES ('${EMP}', '${A}', 2026, 11);

    CREATE FUNCTION public.assert_manager(p_company_id uuid, p_line_user_id text)
    RETURNS void LANGUAGE plpgsql AS $$
    BEGIN
      IF NOT ((p_company_id='${A}' AND p_line_user_id IN ('Uadmin','Umanager'))
          OR (p_company_id='${B}' AND p_line_user_id='Ucross')) THEN
        RAISE EXCEPTION '需要管理員權限';
      END IF;
    END $$;

    CREATE FUNCTION public.assert_legacy_leave_manager(p_company_id uuid, p_line_user_id text)
    RETURNS void LANGUAGE plpgsql AS $$
    BEGIN
      IF NOT ((p_company_id='${A}' AND p_line_user_id IN ('Uadmin','Umanager','Ukiosk'))
          OR (p_company_id='${B}' AND p_line_user_id='Ucross')) THEN
        RAISE EXCEPTION '需要管理員權限';
      END IF;
    END $$;

    CREATE FUNCTION public.is_company_manager_caller(p_line_user_id text, p_company_id uuid)
    RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public AS $$
      SELECT (p_company_id='${A}' AND p_line_user_id IN ('Uadmin','Umanager'))
          OR (p_company_id='${B}' AND p_line_user_id='Ucross')
    $$;

    CREATE FUNCTION public.get_company_payroll(p_company_id uuid,p_line_user_id text,p_year integer,p_month integer)
    RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER AS $$
    BEGIN PERFORM public.assert_manager(p_company_id,p_line_user_id);
      RETURN COALESCE((SELECT jsonb_agg(jsonb_build_object('company_id',company_id,'year',year,'month',month))
        FROM payroll WHERE company_id=p_company_id AND year=p_year AND month=p_month), '[]'::jsonb); END $$;
    CREATE FUNCTION public.get_company_current_salaries(p_company_id uuid,p_line_user_id text)
    RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER AS $$
    BEGIN PERFORM public.assert_manager(p_company_id,p_line_user_id);
      RETURN COALESCE((SELECT jsonb_agg(jsonb_build_object('employee_id',employee_id,'base_salary',base_salary))
        FROM salary_settings WHERE company_id=p_company_id AND is_current=true), '[]'::jsonb); END $$;
    CREATE FUNCTION public.get_employee_current_salary(p_company_id uuid,p_line_user_id text,p_employee_id uuid)
    RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER AS $$
    BEGIN PERFORM public.assert_manager(p_company_id,p_line_user_id);
      RETURN (SELECT jsonb_build_object('employee_id',employee_id,'base_salary',base_salary)
        FROM salary_settings WHERE company_id=p_company_id AND employee_id=p_employee_id AND is_current=true LIMIT 1); END $$;
    CREATE FUNCTION public.upsert_salary_setting(p_company_id uuid,p_line_user_id text,p_employee_id uuid,p_salary_type text,
      p_base_salary numeric,p_meal_allowance numeric,p_position_allowance numeric,p_full_attendance_bonus numeric,
      p_pension_self_rate numeric,p_sync_employee_rate boolean)
    RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
    BEGIN PERFORM public.assert_manager(p_company_id,p_line_user_id);
      RETURN jsonb_build_object('success',true,'employee_id',p_employee_id,'base_salary',p_base_salary,'sync',p_sync_employee_rate); END $$;
    CREATE FUNCTION public.save_payroll_records(p_company_id uuid,p_line_user_id text,p_year integer,p_month integer,
      p_records jsonb,p_is_published boolean)
    RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
    BEGIN PERFORM public.assert_manager(p_company_id,p_line_user_id);
      RETURN jsonb_build_object('success',true,'count',jsonb_array_length(p_records),'published',p_is_published); END $$;
    CREATE FUNCTION public.approve_leave_request(p_company_id uuid,p_line_user_id text,p_request_id uuid,p_status text,p_rejection_reason text)
    RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
    BEGIN PERFORM public.assert_legacy_leave_manager(p_company_id,p_line_user_id);
      RETURN jsonb_build_object('success',true,'request_id',p_request_id,'status',p_status,'reason',p_rejection_reason); END $$;
    CREATE FUNCTION public.approve_leave_request(p_company_id uuid,p_line_user_id text,p_request_id uuid,p_status text)
    RETURNS jsonb LANGUAGE sql SECURITY DEFINER SET search_path=public AS $$
      SELECT public.approve_leave_request(p_company_id,p_line_user_id,p_request_id,p_status,NULL)
    $$;

    GRANT EXECUTE ON FUNCTION public.get_company_payroll(uuid,text,integer,integer),
      public.get_company_current_salaries(uuid,text), public.get_employee_current_salary(uuid,text,uuid),
      public.upsert_salary_setting(uuid,text,uuid,text,numeric,numeric,numeric,numeric,numeric,boolean),
      public.save_payroll_records(uuid,text,integer,integer,jsonb,boolean),
      public.approve_leave_request(uuid,text,uuid,text,text), public.approve_leave_request(uuid,text,uuid,text)
      TO anon, authenticated, service_role;
    RESET ROLE;
  `);

  const legacyAclBefore = await one(`SELECT jsonb_object_agg(sig, jsonb_build_array(a,u,s)) acl FROM (
    SELECT f::text sig, has_function_privilege('anon',f,'EXECUTE') a,
      has_function_privilege('authenticated',f,'EXECUTE') u, has_function_privilege('service_role',f,'EXECUTE') s
    FROM unnest(ARRAY[
      'public.get_company_payroll(uuid,text,integer,integer)'::regprocedure,
      'public.get_company_current_salaries(uuid,text)'::regprocedure,
      'public.get_employee_current_salary(uuid,text,uuid)'::regprocedure,
      'public.upsert_salary_setting(uuid,text,uuid,text,numeric,numeric,numeric,numeric,numeric,boolean)'::regprocedure,
      'public.save_payroll_records(uuid,text,integer,integer,jsonb,boolean)'::regprocedure,
      'public.approve_leave_request(uuid,text,uuid,text,text)'::regprocedure,
      'public.approve_leave_request(uuid,text,uuid,text)'::regprocedure]) f) x`);

  let error = await apply(migration);
  check('161 可套用且檔尾 ACL 自我檢查通過', error === '', error);

  const inheritedSearchPath = await one(`SELECT bool_and(proconfig IS NULL) ok FROM pg_proc
    WHERE oid IN ('public.get_company_payroll(uuid,text,integer,integer)'::regprocedure,
      'public.get_company_current_salaries(uuid,text)'::regprocedure,
      'public.get_employee_current_salary(uuid,text,uuid)'::regprocedure)`);
  check('三支正式型唯讀舊函式未自訂 search_path', inheritedSearchPath.ok === true);

  const pairs = [
    [`SELECT public.get_company_payroll('${A}','Uadmin',2026,11) old,
       public.get_company_payroll_verified('Uadmin','${A}',2026,11) verified`],
    [`SELECT public.get_company_current_salaries('${A}','Uadmin') old,
       public.get_company_current_salaries_verified('Uadmin','${A}') verified`],
    [`SELECT public.get_employee_current_salary('${A}','Uadmin','${EMP}') old,
       public.get_employee_current_salary_verified('Uadmin','${A}','${EMP}') verified`],
    [`SELECT public.upsert_salary_setting('${A}','Uadmin','${EMP}','monthly',42000,1000,2000,3000,6,true) old,
       public.upsert_salary_setting_verified('Uadmin','${A}','${EMP}','monthly',42000,1000,2000,3000,6,true) verified`],
    [`SELECT public.save_payroll_records('${A}','Uadmin',2026,11,'[{"employee_id":"${EMP}"}]',false) old,
       public.save_payroll_records_verified('Uadmin','${A}',2026,11,'[{"employee_id":"${EMP}"}]',false) verified`],
    [`SELECT public.approve_leave_request('${A}','Uadmin','${REQ}','approved',NULL) old,
       public.approve_leave_request_verified('Uadmin','${A}','${REQ}','approved',NULL) verified`],
  ];
  for (const [sql] of pairs) {
    const result = await as('service_role', sql);
    check('verified 與現行函式回傳完全相同', !result.error && JSON.stringify(result.rows[0].old) === JSON.stringify(result.rows[0].verified), result.error || JSON.stringify(result.rows[0]));
  }

  let result = await as('service_role', `SELECT public.get_company_current_salaries_verified('Uemployee','${A}')`);
  check('一般員工不能藉 verified wrapper 讀薪資', /管理員權限/.test(result.error || ''), result.error);
  result = await as('service_role', `SELECT public.get_company_current_salaries_verified('Uadmin','${B}')`);
  check('A 公司管理員不能以 B 公司參數跨租戶讀取', /管理員權限/.test(result.error || ''), result.error);
  result = await as('service_role', `SELECT public.approve_leave_request('${A}','Ukiosk','${REQ}','approved',NULL) old,
    public.approve_leave_request_verified('Ukiosk','${A}','${REQ}','approved',NULL) verified`);
  check('公務機舊路徑雖放行，verified 核准仍以非主管拒絕', !result.error
    && result.rows[0].old.success === true
    && result.rows[0].verified.success === false
    && result.rows[0].verified.error_code === 'access_denied', result.error || JSON.stringify(result.rows[0]));

  const wrapperAcl = await one(`SELECT bool_and(p.prosecdef
      AND p.proconfig=ARRAY['search_path=pg_catalog, public, pg_temp']::text[]
      AND has_function_privilege('service_role',p.oid,'EXECUTE')
      AND NOT has_function_privilege('anon',p.oid,'EXECUTE')
      AND NOT has_function_privilege('authenticated',p.oid,'EXECUTE')) ok
    FROM pg_proc p WHERE p.proname LIKE '%\\_verified' ESCAPE '\\'
      AND p.proname IN ('get_company_payroll_verified','get_company_current_salaries_verified',
      'get_employee_current_salary_verified','upsert_salary_setting_verified','save_payroll_records_verified','approve_leave_request_verified')`);
  check('六支 wrapper 均為固定 search_path 的 SECURITY DEFINER，且只給 service_role', wrapperAcl.ok === true);
  const legacyAclAfter = await one(`SELECT jsonb_object_agg(sig, jsonb_build_array(a,u,s)) acl FROM (
    SELECT f::text sig, has_function_privilege('anon',f,'EXECUTE') a,
      has_function_privilege('authenticated',f,'EXECUTE') u, has_function_privilege('service_role',f,'EXECUTE') s
    FROM unnest(ARRAY[
      'public.get_company_payroll(uuid,text,integer,integer)'::regprocedure,
      'public.get_company_current_salaries(uuid,text)'::regprocedure,
      'public.get_employee_current_salary(uuid,text,uuid)'::regprocedure,
      'public.upsert_salary_setting(uuid,text,uuid,text,numeric,numeric,numeric,numeric,numeric,boolean)'::regprocedure,
      'public.save_payroll_records(uuid,text,integer,integer,jsonb,boolean)'::regprocedure,
      'public.approve_leave_request(uuid,text,uuid,text,text)'::regprocedure,
      'public.approve_leave_request(uuid,text,uuid,text)'::regprocedure]) f) x`);
  check('161 不提前改動七支舊函式 ACL', JSON.stringify(legacyAclBefore.acl) === JSON.stringify(legacyAclAfter.acl));

  error = await apply(rollback);
  check('rollback 可套用', error === '', error);
  check('rollback 後六支 wrapper 全部不存在', Number((await one(`SELECT count(*) n FROM pg_proc WHERE proname IN (
    'get_company_payroll_verified','get_company_current_salaries_verified','get_employee_current_salary_verified',
    'upsert_salary_setting_verified','save_payroll_records_verified','approve_leave_request_verified')`)).n) === 0);
  error = await apply(migration);
  check('rollback 後可重套 161', error === '', error);

  console.log(`\n結果：${pass} 通過、${fail} 失敗`);
  await db.close();
  process.exitCode = fail ? 1 : 0;
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
