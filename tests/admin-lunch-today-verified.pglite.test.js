// migration 154：管理員替員工補訂當天便當 verified RPC（純本機 PGlite）。
// 反向對照：MIGRATION154_NO_PERMISSION=1 會在記憶體移除權限檢查；權限案例必須失敗。
const fs = require('fs');
const path = require('path');
const { PGlite } = require('@electric-sql/pglite');

const root = path.join(__dirname, '..');
const read = file => fs.readFileSync(file, 'utf8');
let migration154 = read(process.env.MIGRATION154_FILE || path.join(root, 'migrations', '154_admin_lunch_order_today_verified.sql'));
if (process.env.MIGRATION154_NO_PERMISSION === '1') {
  migration154 = migration154.replace(
    /\n    IF NOT public\.is_company_manager_caller\(p_line_user_id, p_company_id\) THEN[\s\S]*?\n    END IF;/,
    ''
  );
}
const rollback154 = read(path.join(root, 'migrations', '154_admin_lunch_order_today_verified_rollback.sql'));

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
  target: '20000000-0000-0000-0000-000000000004',
  target2: '20000000-0000-0000-0000-000000000005',
  cross: '20000000-0000-0000-0000-000000000006',
  resigned: '20000000-0000-0000-0000-000000000007',
  kiosk: '20000000-0000-0000-0000-000000000008'
};
const PA = '50000000-0000-0000-0000-000000000001';

(async () => {
  console.log('\n═══════════════════════════════════════');
  console.log('  管理員補訂當天便當 verified RPC（154，PGlite 實跑）');
  console.log('═══════════════════════════════════════');

  const db = new PGlite();
  const q = async (sql, params) => (await db.query(sql, params)).rows;
  const one = async (sql, params) => (await q(sql, params))[0];
  async function as(role, sql, params = []) {
    try {
      await db.exec(`SET ROLE ${role}`);
      return { rows: await q(sql, params) };
    } catch (e) {
      return { error: e.message };
    } finally {
      await db.exec('RESET ROLE');
    }
  }
  async function apply(sql) {
    try {
      await db.exec('SET ROLE prod_postgres');
      await db.exec(sql);
      return '';
    } catch (e) {
      try { await db.exec('ROLLBACK'); } catch (_) { /* 無進行中交易 */ }
      return e.message;
    } finally {
      await db.exec('RESET ROLE');
    }
  }
  const rpc = async (role, line, employee, choice) => {
    const result = await as(role, `SELECT public.admin_order_lunch_today_verified(
      $1::uuid,$2::text,$3::uuid,$4::text) r`, [A, line, employee, choice]);
    return result.error ? { error: result.error } : result.rows[0].r;
  };
  const denied = result => /permission denied/.test(result?.error || '');
  const clearOrders = () => apply('DELETE FROM public.lunch_orders;');

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
      employee_number text, role text NOT NULL DEFAULT 'user', is_active boolean NOT NULL DEFAULT true,
      is_kiosk boolean NOT NULL DEFAULT false, created_at timestamptz DEFAULT now()
    );
    CREATE TABLE public.platform_admins (
      id uuid PRIMARY KEY, line_user_id text UNIQUE, name text NOT NULL, is_active boolean NOT NULL DEFAULT true
    );
    CREATE TABLE public.platform_admin_companies (
      platform_admin_id uuid REFERENCES public.platform_admins(id), company_id uuid NOT NULL,
      PRIMARY KEY(platform_admin_id, company_id)
    );
    CREATE TABLE public.lunch_orders (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), employee_id uuid NOT NULL REFERENCES public.employees(id),
      order_date date NOT NULL, is_vegetarian boolean DEFAULT false, special_requirements text,
      status varchar DEFAULT 'confirmed', created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now(),
      notes text, UNIQUE(employee_id, order_date)
    );

    CREATE FUNCTION public.is_company_manager_caller(p_line_user_id text, p_company_id uuid)
    RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public AS $$
      SELECT coalesce(p_line_user_id, '') <> '' AND p_company_id IS NOT NULL AND (
        EXISTS (SELECT 1 FROM public.employees e
          WHERE e.line_user_id=p_line_user_id AND e.company_id=p_company_id AND e.is_active=true
            AND e.role IN ('admin','manager','platform_admin') AND coalesce(e.is_kiosk,false)=false)
        OR EXISTS (SELECT 1 FROM public.platform_admins pa
          JOIN public.platform_admin_companies pac ON pac.platform_admin_id=pa.id
          WHERE pa.line_user_id=p_line_user_id AND pa.is_active=true AND pac.company_id=p_company_id)
      )
    $$;
    REVOKE ALL ON FUNCTION public.is_company_manager_caller(text,uuid) FROM PUBLIC, anon, authenticated;
    GRANT EXECUTE ON FUNCTION public.is_company_manager_caller(text,uuid) TO service_role;

    INSERT INTO public.employees(id,company_id,line_user_id,name,employee_number,role,is_active,is_kiosk,created_at) VALUES
      ('${E.admin}','${A}','Uadmin','王管理員','A01','admin',true,false,'2026-01-01'),
      ('${E.manager}','${A}','Umanager','李主管','M01','manager',true,false,'2026-01-02'),
      ('${E.user}','${A}','Uuser','一般員工','E01','user',true,false,'2026-01-03'),
      ('${E.target}','${A}',NULL,'補訂對象','E02','user',true,false,'2026-01-04'),
      ('${E.target2}','${A}',NULL,'第二位員工','E03','user',true,false,'2026-01-05'),
      ('${E.cross}','${B}','Ucross','別家公司','B01','user',true,false,'2026-01-06'),
      ('${E.resigned}','${A}',NULL,'離職員工','E04','user',false,false,'2026-01-07'),
      ('${E.kiosk}','${A}','Ukiosk','公務機','K01','user',true,true,'2026-01-08');
    INSERT INTO public.platform_admins(id,line_user_id,name,is_active) VALUES('${PA}','Uplatform','平台小編',true);
    INSERT INTO public.platform_admin_companies(platform_admin_id,company_id) VALUES('${PA}','${A}');
    RESET ROLE;
  `);

  let err = await apply(migration154);
  check('154 可套用且檔尾 ACL 自我檢查通過', err === '', err);

  console.log('\n=== 新增、更新、取消與台灣日期 ===');
  let r = await rpc('service_role', 'Uadmin', E.target, 'regular');
  let row = await one(`SELECT employee_id::text,order_date::text,status,is_vegetarian,notes FROM lunch_orders WHERE employee_id='${E.target}'`);
  const dbToday = (await one(`SELECT (now() AT TIME ZONE 'Asia/Taipei')::date::text d`)).d;
  check('admin 可新增同公司在職員工的葷食訂單', r?.success === true && row?.status === 'ordered'
    && row.is_vegetarian === false && row.employee_id === E.target, JSON.stringify(r));
  check('日期只由 DB 台灣今日決定', r?.order_date === dbToday && row?.order_date === dbToday, `${r?.order_date} / ${dbToday}`);
  check('notes 使用 DB 查得的管理員姓名', row?.notes === '[管理員補訂：王管理員]', row?.notes);

  r = await rpc('service_role', 'Uadmin', E.target, 'vegetarian');
  row = await one(`SELECT status,is_vegetarian,notes FROM lunch_orders WHERE employee_id='${E.target}'`);
  check('再補一次改為素食，不新增第二筆', r?.success === true && row?.status === 'ordered' && row.is_vegetarian === true
    && (await one(`SELECT count(*)::int n FROM lunch_orders WHERE employee_id='${E.target}'`)).n === 1, JSON.stringify(r));

  r = await rpc('service_role', 'Uadmin', E.target, 'none');
  row = await one(`SELECT status,is_vegetarian FROM lunch_orders WHERE employee_id='${E.target}'`);
  check('none 改為 cancelled 並清除素食旗標', r?.success === true && r.status === 'cancelled'
    && r.is_vegetarian === false && row?.status === 'cancelled' && row.is_vegetarian === false, JSON.stringify(r));

  await clearOrders();
  r = await rpc('service_role', 'Umanager', E.target2, 'regular');
  row = await one(`SELECT notes FROM lunch_orders LIMIT 1`);
  check('manager 可補訂且稽核姓名取自 DB', r?.success === true && row?.notes === '[管理員補訂：李主管]', row?.notes);

  await clearOrders();
  r = await rpc('service_role', 'Uplatform', E.target, 'vegetarian');
  row = await one(`SELECT notes FROM lunch_orders LIMIT 1`);
  check('綁定公司的 platform_admin 可補訂', r?.success === true && row?.notes === '[管理員補訂：平台小編]', row?.notes);

  console.log('\n=== 權限、目標員工、選項與 ACL ===');
  await clearOrders();
  r = await rpc('service_role', 'Uuser', E.target, 'regular');
  check('一般員工被拒 access_denied 且零寫入', r?.success === false && r.error_code === 'access_denied'
    && (await one('SELECT count(*)::int n FROM lunch_orders')).n === 0, JSON.stringify(r));

  for (const [name, employee] of [
    ['跨公司員工', E.cross], ['離職員工', E.resigned], ['公務機目標', E.kiosk]
  ]) {
    await clearOrders();
    r = await rpc('service_role', 'Uadmin', employee, 'regular');
    check(`${name}被拒且零寫入`, r?.success === false && r.error_code === 'invalid_target'
      && (await one('SELECT count(*)::int n FROM lunch_orders')).n === 0, JSON.stringify(r));
  }

  await clearOrders();
  r = await rpc('service_role', 'Uadmin', E.target, 'meat');
  check('錯誤 choice 被拒且零寫入', r?.success === false && r.error_code === 'invalid_choice'
    && (await one('SELECT count(*)::int n FROM lunch_orders')).n === 0, JSON.stringify(r));
  check('anon 無 EXECUTE', denied(await rpc('anon', 'Uadmin', E.target, 'regular')));
  check('authenticated 無 EXECUTE', denied(await rpc('authenticated', 'Uadmin', E.target, 'regular')));
  const acl = await one(`SELECT p.prosecdef, p.proacl::text acl
    FROM pg_proc p WHERE p.oid='public.admin_order_lunch_today_verified(uuid,text,uuid,text)'::regprocedure`);
  check('RPC 保留 SECURITY DEFINER 且 ACL 只有 owner/service_role', acl?.prosecdef === true
    && /prod_postgres=X\/prod_postgres/.test(acl.acl) && /service_role=X\/prod_postgres/.test(acl.acl)
    && !/anon|authenticated|PUBLIC/i.test(acl.acl), acl?.acl);

  console.log('\n=== rollback、重套與前提防呆 ===');
  err = await apply(rollback154);
  check('154 rollback 可套用', err === '', err);
  check('rollback 後函式不存在', (await one(`SELECT to_regprocedure(
    'public.admin_order_lunch_today_verified(uuid,text,uuid,text)') IS NULL gone`)).gone === true);
  err = await apply(migration154);
  check('rollback 後可重套 154', err === '', err);

  err = await apply(rollback154);
  await apply('DROP FUNCTION public.is_company_manager_caller(text,uuid);');
  err = await apply(migration154);
  check('缺少管理員驗權 helper 時 154 明確中止', /is_company_manager_caller/.test(err) && /不存在/.test(err), err);

  console.log(`\n結果：${pass} 通過、${fail} 失敗`);
  await db.close();
  process.exitCode = fail ? 1 : 0;
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
