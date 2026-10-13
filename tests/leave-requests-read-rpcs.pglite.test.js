// migration 149-A：leave_requests 四支讀取 RPC（純本機 PGlite）
const fs = require('fs');
const path = require('path');
const { PGlite } = require('@electric-sql/pglite');

const root = path.join(__dirname, '..');
const migrationPath = path.join(root, 'migrations', '149_leave_requests_read_rpcs.sql');
const migration = process.env.MIGRATION149_EMPTY === '1'
  ? ''
  : fs.readFileSync(process.env.MIGRATION149_FILE || migrationPath, 'utf8');
const rollback = fs.readFileSync(
  path.join(root, 'migrations', '149_leave_requests_read_rpcs_rollback.sql'), 'utf8');

let pass = 0;
let fail = 0;
function check(name, ok, detail = '') {
  (ok ? pass++ : fail++);
  console.log(`  ${ok ? '✅' : '❌'} ${name}${detail ? ` → ${detail}` : ''}`);
}

const COMPANY_A = '10000000-0000-0000-0000-000000000001';
const COMPANY_B = '10000000-0000-0000-0000-000000000002';
const EMPLOYEE_A1 = '20000000-0000-0000-0000-000000000001';
const EMPLOYEE_A2 = '20000000-0000-0000-0000-000000000002';
const MANAGER_A = '20000000-0000-0000-0000-000000000003';
const CROSS_MANAGER_A = '20000000-0000-0000-0000-000000000004';
const EMPLOYEE_B = '20000000-0000-0000-0000-000000000005';
const CROSS_USER_B = '20000000-0000-0000-0000-000000000006';
const ADMIN_B = '20000000-0000-0000-0000-000000000007';
const YESTERDAY_ONLY_A = '20000000-0000-0000-0000-000000000008';
const TOMORROW_ONLY_A = '20000000-0000-0000-0000-000000000009';
const REJECTED_ONLY_A = '20000000-0000-0000-0000-000000000010';
const FIXED_TODAY = '2026-10-13';
const CLOCK_EXPRESSION = "(now() AT TIME ZONE 'Asia/Taipei')::DATE";

const FULL_FIELDS = [
  'id', 'employee_id', 'leave_type', 'start_date', 'end_date', 'days', 'reason',
  'attachment_url', 'status', 'approver_id', 'approved_at', 'rejection_reason',
  'created_at', 'updated_at', 'leave_period', 'leave_hours', 'leave_start_time',
  'leave_end_time', 'employees'
].sort();
const OVERLAP_FIELDS = [
  'employee_id', 'employee_name', 'start_date', 'end_date', 'status'
].sort();

(async () => {
  console.log('\n═══════════════════════════════════════');
  console.log('  leave_requests 讀取 RPC（149-A，PGlite 實跑）');
  console.log('═══════════════════════════════════════');

  const db = new PGlite();
  const q = async (sql, params) => (await db.query(sql, params)).rows;
  const one = async (sql, params) => (await q(sql, params))[0];
  const as = async (role, sql, params) => {
    try {
      await db.exec(`SET ROLE ${role}`);
      return { rows: await q(sql, params) };
    } catch (e) {
      return { error: e.message };
    } finally {
      await db.exec('RESET ROLE');
    }
  };
  const apply = async sql => {
    try {
      await db.exec('SET ROLE prod_postgres');
      await db.exec(sql);
      return '';
    } catch (e) {
      try { await db.exec('ROLLBACK'); } catch (_) { /* no open transaction */ }
      return e.message;
    } finally {
      await db.exec('RESET ROLE');
    }
  };
  const denied = result => /access_denied|permission denied/i.test(result?.error || '');
  const keys = row => Object.keys(row || {}).sort();

  await db.exec(`
    CREATE ROLE anon NOLOGIN;
    CREATE ROLE authenticated NOLOGIN;
    CREATE ROLE service_role NOLOGIN;
    CREATE ROLE prod_postgres NOLOGIN;
    GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
    GRANT USAGE, CREATE ON SCHEMA public TO prod_postgres;

    SET ROLE prod_postgres;
    CREATE TABLE public.employees (
      id UUID PRIMARY KEY,
      company_id UUID NOT NULL,
      line_user_id TEXT,
      name TEXT NOT NULL,
      employee_number TEXT,
      department TEXT,
      role TEXT NOT NULL DEFAULT 'user',
      is_active BOOLEAN NOT NULL DEFAULT true,
      is_kiosk BOOLEAN NOT NULL DEFAULT false
    );
    CREATE TABLE public.platform_admins (
      id UUID PRIMARY KEY,
      line_user_id TEXT NOT NULL,
      is_active BOOLEAN NOT NULL DEFAULT true
    );
    CREATE TABLE public.platform_admin_companies (
      platform_admin_id UUID NOT NULL REFERENCES public.platform_admins(id),
      company_id UUID NOT NULL
    );
    CREATE TABLE public.leave_requests (
      id UUID PRIMARY KEY,
      employee_id UUID NOT NULL REFERENCES public.employees(id),
      leave_type VARCHAR NOT NULL,
      start_date DATE NOT NULL,
      end_date DATE NOT NULL,
      days NUMERIC,
      reason TEXT,
      attachment_url TEXT,
      status VARCHAR,
      approver_id UUID,
      approved_at TIMESTAMPTZ,
      rejection_reason TEXT,
      created_at TIMESTAMPTZ DEFAULT now(),
      updated_at TIMESTAMPTZ DEFAULT now(),
      leave_period TEXT NOT NULL DEFAULT 'full_day',
      leave_hours NUMERIC,
      leave_start_time TIME,
      leave_end_time TIME
    );

    CREATE FUNCTION public.is_company_manager_caller(p_line_user_id TEXT, p_company_id UUID)
    RETURNS BOOLEAN LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public AS $$
      SELECT COALESCE(p_line_user_id, '') <> '' AND p_company_id IS NOT NULL AND (
        EXISTS (
          SELECT 1 FROM public.employees e
          WHERE e.line_user_id=p_line_user_id AND e.company_id=p_company_id
            AND e.is_active=true AND e.role IN ('admin','manager','platform_admin')
            AND COALESCE(e.is_kiosk,false)=false
        ) OR EXISTS (
          SELECT 1 FROM public.platform_admins pa
          JOIN public.platform_admin_companies pac ON pac.platform_admin_id=pa.id
          WHERE pa.line_user_id=p_line_user_id AND pa.is_active=true AND pac.company_id=p_company_id
        )
      );
    $$;
    REVOKE ALL ON FUNCTION public.is_company_manager_caller(TEXT, UUID) FROM PUBLIC, anon, authenticated;
    GRANT EXECUTE ON FUNCTION public.is_company_manager_caller(TEXT, UUID) TO service_role;

    INSERT INTO public.employees
      (id,company_id,line_user_id,name,employee_number,department,role,is_active,is_kiosk)
    VALUES
      ('${EMPLOYEE_A1}','${COMPANY_A}','U-A1','甲員工','A001','製造','user',true,false),
      ('${EMPLOYEE_A2}','${COMPANY_A}','U-A2','乙員工','A002','品管','user',true,false),
      ('${MANAGER_A}','${COMPANY_A}','U-manager-A','甲主管','A900','管理','manager',true,false),
      ('${CROSS_MANAGER_A}','${COMPANY_A}','U-cross','跨公司主管','A901','管理','manager',true,false),
      ('${EMPLOYEE_B}','${COMPANY_B}','U-B1','丙員工','B001','門市','user',true,false),
      ('${CROSS_USER_B}','${COMPANY_B}','U-cross','跨公司一般員工','B002','門市','user',true,false),
      ('${ADMIN_B}','${COMPANY_B}','U-admin-B','乙管理員','B900','管理','admin',true,false),
      ('${YESTERDAY_ONLY_A}','${COMPANY_A}','U-yesterday','昨日員工','A003','製造','user',true,false),
      ('${TOMORROW_ONLY_A}','${COMPANY_A}','U-tomorrow','明日員工','A004','製造','user',true,false),
      ('${REJECTED_ONLY_A}','${COMPANY_A}','U-rejected','駁回員工','A005','製造','user',true,false);

    INSERT INTO public.leave_requests
      (id,employee_id,leave_type,start_date,end_date,days,reason,status,created_at,leave_period,leave_hours,leave_start_time,leave_end_time)
    VALUES
      ('30000000-0000-0000-0000-000000000001','${EMPLOYEE_A1}','annual','2026-10-13','2026-10-13',1,'今日核准','approved','2026-10-01T01:00:00Z','full_day',NULL,NULL,NULL),
      ('30000000-0000-0000-0000-000000000002','${EMPLOYEE_A1}','personal','2026-10-13','2026-10-13',0.5,'今日待審','pending','2026-10-02T01:00:00Z','am',NULL,NULL,NULL),
      ('30000000-0000-0000-0000-000000000003','${EMPLOYEE_A1}','sick','2026-10-12','2026-10-12',1,'昨天','approved','2026-10-03T01:00:00Z','full_day',NULL,NULL,NULL),
      ('30000000-0000-0000-0000-000000000004','${EMPLOYEE_A1}','annual','2026-10-14','2026-10-14',1,'明天','approved','2026-10-04T01:00:00Z','full_day',NULL,NULL,NULL),
      ('30000000-0000-0000-0000-000000000005','${EMPLOYEE_A1}','personal','2026-10-13','2026-10-13',1,'已拒絕','rejected','2026-10-05T01:00:00Z','full_day',NULL,NULL,NULL),
      ('30000000-0000-0000-0000-000000000006','${EMPLOYEE_A2}','sick','2026-10-13','2026-10-13',0.25,'時數假','approved','2026-10-06T01:00:00Z','hourly',2,'09:00','11:00'),
      ('30000000-0000-0000-0000-000000000007','${EMPLOYEE_B}','annual','2026-10-13','2026-10-13',1,'乙公司','approved','2026-10-07T01:00:00Z','full_day',NULL,NULL,NULL),
      ('30000000-0000-0000-0000-000000000008','${YESTERDAY_ONLY_A}','annual','2026-10-12','2026-10-12',1,'只在昨天','approved','2026-10-08T01:00:00Z','full_day',NULL,NULL,NULL),
      ('30000000-0000-0000-0000-000000000009','${TOMORROW_ONLY_A}','annual','2026-10-14','2026-10-14',1,'只在明天','pending','2026-10-09T01:00:00Z','full_day',NULL,NULL,NULL),
      ('30000000-0000-0000-0000-000000000010','${REJECTED_ONLY_A}','annual','2026-10-13','2026-10-13',1,'只有駁回','rejected','2026-10-10T01:00:00Z','full_day',NULL,NULL,NULL);
    RESET ROLE;
  `);

  console.log('\n=== 原始 migration 與契約 ===');
  let error = await apply(migration);
  check('149-A 原始 migration 可套用', error === '', error);

  const expectedSignatures = [
    'get_company_leave_overlap(text,uuid,date,date)',
    'get_company_leave_requests(text,uuid,date,date,text[],uuid,integer)',
    'get_my_leave_requests(text,uuid,date,date,text[],integer)',
    'get_public_today_leave_employees(uuid)'
  ];
  const signatures = (await q(`
    SELECT p.oid::regprocedure::TEXT AS signature
    FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname='public' AND p.proname IN
      ('get_company_leave_overlap','get_company_leave_requests','get_my_leave_requests','get_public_today_leave_employees')
    ORDER BY p.proname
  `)).map(x => x.signature.replaceAll(' ', ''));
  check('四支 RPC 只有核定簽名', JSON.stringify(signatures) === JSON.stringify(expectedSignatures), signatures.join(' | '));

  const attrs = await q(`
    SELECT p.proname, p.prosecdef, p.provolatile, p.proconfig
    FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname='public' AND p.proname IN
      ('get_company_leave_overlap','get_company_leave_requests','get_my_leave_requests','get_public_today_leave_employees')
    ORDER BY p.proname
  `);
  check('四支 RPC 都是 STABLE SECURITY DEFINER 且固定 search_path',
    attrs.length === 4 && attrs.every(x => x.prosecdef === true && x.provolatile === 's'
      && (x.proconfig || []).includes('search_path=public')), JSON.stringify(attrs));
  for (const signature of expectedSignatures) {
    const privilege = await one(`SELECT
      EXISTS (
        SELECT 1 FROM pg_proc p, LATERAL aclexplode(p.proacl) a
        WHERE p.oid=to_regprocedure($1) AND a.grantee=0 AND a.privilege_type='EXECUTE'
      ) AS public_exec,
      has_function_privilege('anon',$1,'EXECUTE') AS anon_exec,
      has_function_privilege('authenticated',$1,'EXECUTE') AS auth_exec`, [`public.${signature}`]);
    check(`${signature} 僅開放應用角色`, privilege && !privilege.public_exec && privilege.anon_exec && privilege.auth_exec,
      JSON.stringify(privilege));
  }

  console.log('\n=== 管理員權限與多租戶隔離 ===');
  let result = await as('anon', `SELECT * FROM public.get_company_leave_requests(
    'U-manager-A',$1,NULL,NULL,NULL,NULL,1000)`, [COMPANY_A]);
  check('甲公司主管可讀甲公司假單', !result.error && result.rows.length === 9,
    result.error || `rows=${result.rows.length}`);
  check('管理員 RPC 回傳完整欄位聯集', !result.error && JSON.stringify(keys(result.rows[0])) === JSON.stringify(FULL_FIELDS),
    result.error || keys(result.rows[0]).join(','));
  check('employees 嵌套欄位可直接供 149-B 使用', !result.error
    && result.rows[0].employees && ['name','employee_number','department','company_id']
      .every(k => Object.hasOwn(result.rows[0].employees, k)), JSON.stringify(result.rows?.[0]?.employees));
  check('甲公司查詢不混入乙公司資料', !result.error
    && result.rows.every(x => x.employees.company_id === COMPANY_A), JSON.stringify(result.rows));

  result = await as('anon', `SELECT * FROM public.get_company_leave_requests(
    'U-A1',$1,NULL,NULL,NULL,NULL,1000)`, [COMPANY_A]);
  check('一般員工呼叫管理員 RPC 被擋', denied(result), result.error);

  result = await as('anon', `SELECT * FROM public.get_company_leave_requests(
    'U-manager-A',$1,NULL,NULL,NULL,NULL,1000)`, [COMPANY_B]);
  check('甲公司主管不能讀乙公司', denied(result), result.error);

  result = await as('authenticated', `SELECT * FROM public.get_company_leave_requests(
    'U-cross',$1,NULL,NULL,NULL,NULL,1000)`, [COMPANY_B]);
  check('跨公司帳號在乙公司只是 user 時仍被擋', denied(result), result.error);

  result = await as('anon', `SELECT * FROM public.get_company_leave_requests(
    'U-manager-A',$1,NULL,NULL,NULL,$2,1000)`, [COMPANY_A, EMPLOYEE_B]);
  check('管理員用別公司 employee_id 篩選只得到 0 列', !result.error && result.rows.length === 0,
    result.error || `rows=${result.rows.length}`);

  result = await as('anon', `SELECT * FROM public.get_company_leave_requests(
    'U-manager-A',$1,'2026-10-13','2026-10-13',ARRAY['approved'],$2,1000)`, [COMPANY_A, EMPLOYEE_A1]);
  check('管理員日期／狀態／員工篩選交集正確', !result.error && result.rows.length === 1
    && result.rows[0].id === '30000000-0000-0000-0000-000000000001',
    result.error || JSON.stringify(result.rows));

  console.log('\n=== 員工本人讀取 ===');
  result = await as('anon', `SELECT * FROM public.get_my_leave_requests(
    'U-A1',$1,NULL,NULL,NULL,100)`, [COMPANY_A]);
  check('員工只看到自己的假單', !result.error && result.rows.length === 5
    && result.rows.every(x => x.employee_id === EMPLOYEE_A1), result.error || JSON.stringify(result.rows));
  check('本人 RPC 也回傳完整欄位聯集', !result.error
    && JSON.stringify(keys(result.rows[0])) === JSON.stringify(FULL_FIELDS), result.error || keys(result.rows[0]).join(','));

  result = await as('authenticated', `SELECT * FROM public.get_my_leave_requests(
    'U-A1',$1,NULL,NULL,NULL,100)`, [COMPANY_B]);
  check('本人帶別家公司 id 得到 0 列', !result.error && result.rows.length === 0,
    result.error || `rows=${result.rows.length}`);

  result = await as('anon', `SELECT * FROM public.get_my_leave_requests(
    'U-A1',$1,'2026-10-13','2026-10-13',ARRAY['approved'],100)`, [COMPANY_A]);
  check('本人日期與狀態篩選正確', !result.error && result.rows.length === 1
    && result.rows[0].id === '30000000-0000-0000-0000-000000000001',
    result.error || JSON.stringify(result.rows));

  await db.exec(`SET ROLE prod_postgres;
    INSERT INTO employees(id,company_id,line_user_id,name,employee_number,department,role)
    VALUES('20000000-0000-0000-0000-000000000099','${COMPANY_A}','U-A1','重複身分','A099','測試','user');
    RESET ROLE;`);
  result = await as('anon', `SELECT * FROM public.get_my_leave_requests(
    'U-A1',$1,NULL,NULL,NULL,100)`, [COMPANY_A]);
  check('同公司同 LINE 對到多位在職員工時不猜身分', !result.error && result.rows.length === 0,
    result.error || `rows=${result.rows.length}`);
  await db.exec(`SET ROLE prod_postgres;
    UPDATE employees SET is_active=false WHERE id='20000000-0000-0000-0000-000000000099';
    RESET ROLE;`);

  console.log('\n=== 一般員工查同公司重疊假單（最小揭露） ===');
  result = await as('anon', `SELECT * FROM public.get_company_leave_overlap(
    'U-A1',$1,'2026-10-13','2026-10-13')`, [COMPANY_A]);
  check('一般員工可查同公司他人的 approved／pending 重疊假單', !result.error
    && result.rows.length === 1 && result.rows[0].employee_id === EMPLOYEE_A2,
    result.error || JSON.stringify(result.rows));
  check('重疊 RPC 排除呼叫者本人', !result.error
    && result.rows.every(x => x.employee_id !== EMPLOYEE_A1), result.error || JSON.stringify(result.rows));
  check('重疊 RPC 實際只回五個核定欄位', !result.error
    && result.rows.every(x => JSON.stringify(keys(x)) === JSON.stringify(OVERLAP_FIELDS)),
    result.error || JSON.stringify(result.rows));
  check('重疊 RPC 不洩漏 reason／leave_type', !result.error
    && result.rows.every(x => !Object.hasOwn(x, 'reason') && !Object.hasOwn(x, 'leave_type')),
    result.error || JSON.stringify(result.rows));

  result = await as('authenticated', `SELECT * FROM public.get_company_leave_overlap(
    'U-no-such-employee',$1,'2026-10-13','2026-10-13')`, [COMPANY_A]);
  check('非員工呼叫重疊 RPC 回空', !result.error && result.rows.length === 0,
    result.error || `rows=${result.rows.length}`);

  result = await as('anon', `SELECT * FROM public.get_company_leave_overlap(
    'U-A1',$1,'2026-10-13','2026-10-13')`, [COMPANY_B]);
  check('員工帶別家公司 id 呼叫重疊 RPC 回空', !result.error && result.rows.length === 0,
    result.error || `rows=${result.rows.length}`);

  result = await as('anon', `SELECT * FROM public.get_company_leave_overlap(
    'U-A1',$1,'2026-10-01','2026-12-01')`, [COMPANY_A]);
  check('重疊 RPC 接受最長 62 天區間', !result.error, result.error);

  result = await as('anon', `SELECT * FROM public.get_company_leave_overlap(
    'U-A1',$1,'2026-10-01','2026-12-02')`, [COMPANY_A]);
  check('重疊 RPC 拒絕 63 天區間', /date_range_too_large/i.test(result.error || ''), result.error);

  result = await as('anon', `SELECT * FROM public.get_company_leave_overlap(
    'U-A1',$1,'2026-10-14','2026-10-13')`, [COMPANY_A]);
  check('重疊 RPC 拒絕反向日期區間', /invalid_date_range/i.test(result.error || ''), result.error);

  await db.exec(`SET ROLE prod_postgres;
    INSERT INTO employees(id,company_id,name,role)
    SELECT ('40000000-0000-0000-0000-' || lpad(g::TEXT, 12, '0'))::UUID,
           '${COMPANY_A}', '限額員工' || g, 'user'
    FROM generate_series(1,205) g;
    INSERT INTO leave_requests(id,employee_id,leave_type,start_date,end_date,status,reason)
    SELECT ('50000000-0000-0000-0000-' || lpad(g::TEXT, 12, '0'))::UUID,
           ('40000000-0000-0000-0000-' || lpad(g::TEXT, 12, '0'))::UUID,
           'annual', DATE '2026-10-13', DATE '2026-10-13', 'approved', '不得由 RPC 回傳'
    FROM generate_series(1,205) g;
    RESET ROLE;`);
  result = await as('anon', `SELECT * FROM public.get_company_leave_overlap(
    'U-A1',$1,'2026-10-13','2026-10-13')`, [COMPANY_A]);
  check('重疊 RPC 即使符合超過 200 筆也固定 LIMIT 200', !result.error && result.rows.length === 200,
    result.error || `rows=${result.rows.length}`);
  await db.exec(`SET ROLE prod_postgres;
    DELETE FROM leave_requests WHERE id::TEXT LIKE '50000000-0000-0000-0000-%';
    DELETE FROM employees WHERE id::TEXT LIKE '40000000-0000-0000-0000-%';
    RESET ROLE;`);

  console.log('\n=== 回滾、可控台北時鐘與公開最小欄位 ===');
  error = await apply(rollback);
  check('149-A rollback 可套用', error === '', error);
  const afterRollback = await one(`SELECT
    to_regprocedure('public.get_company_leave_requests(text,uuid,date,date,text[],uuid,integer)') IS NULL AS company_gone,
    to_regprocedure('public.get_my_leave_requests(text,uuid,date,date,text[],integer)') IS NULL AS my_gone,
    to_regprocedure('public.get_company_leave_overlap(text,uuid,date,date)') IS NULL AS overlap_gone,
    to_regprocedure('public.get_public_today_leave_employees(uuid)') IS NULL AS public_gone`);
  check('rollback 完整移除四支 RPC', afterRollback
    && afterRollback.company_gone && afterRollback.my_gone && afterRollback.overlap_gone && afterRollback.public_gone,
    JSON.stringify(afterRollback));

  const clockOccurrences = migration.split(CLOCK_EXPRESSION).length - 1;
  const controlledMigration = migration.replace(CLOCK_EXPRESSION, `DATE '${FIXED_TODAY}'`);
  check('公開 RPC 的伺服器台北日期來源唯一且可被測試時鐘控制', clockOccurrences === 1,
    `occurrences=${clockOccurrences}`);
  error = await apply(controlledMigration);
  check('固定 2026-10-13 測試時鐘版可重套', error === '', error);

  const publicArgs = await one(`SELECT pg_get_function_identity_arguments(
    'public.get_public_today_leave_employees(uuid)'::regprocedure) args,
    pg_get_function_result('public.get_public_today_leave_employees(uuid)'::regprocedure) result`);
  check('公開 RPC 不接受日期參數', publicArgs?.args.replaceAll(' ', '') === 'p_company_iduuid', JSON.stringify(publicArgs));
  check('公開 RPC 宣告只回兩個欄位', publicArgs?.result === 'TABLE(employee_id uuid, employee_name text)', JSON.stringify(publicArgs));

  result = await as('anon', `SELECT * FROM public.get_public_today_leave_employees($1)`, [COMPANY_A]);
  check('anon 可呼叫公開 RPC', !result.error, result.error);
  check('公開 RPC 每列實際只有 employee_id／employee_name', !result.error
    && result.rows.every(x => JSON.stringify(keys(x)) === JSON.stringify(['employee_id','employee_name'])),
    result.error || JSON.stringify(result.rows));
  check('公開 RPC 只回固定時鐘的今天且同員工 DISTINCT', !result.error && result.rows.length === 2
    && result.rows.map(x => x.employee_id).sort().join(',') === [EMPLOYEE_A1, EMPLOYEE_A2].sort().join(','),
    result.error || JSON.stringify(result.rows));
  check('昨天／明天／rejected 不會由公開 RPC 洩漏', !result.error
    && !result.rows.some(x => [YESTERDAY_ONLY_A, TOMORROW_ONLY_A, REJECTED_ONLY_A].includes(x.employee_id)),
    result.error || JSON.stringify(result.rows));

  result = await as('authenticated', `SELECT * FROM public.get_public_today_leave_employees($1)`, [COMPANY_B]);
  check('公開 RPC 仍以 p_company_id 隔離公司', !result.error && result.rows.length === 1
    && result.rows[0].employee_id === EMPLOYEE_B, result.error || JSON.stringify(result.rows));

  console.log('\n=== 再回滾並重套原始 migration ===');
  error = await apply(rollback);
  check('固定時鐘版可回滾', error === '', error);
  error = await apply(migration);
  check('rollback 後可重套原始 149-A', error === '', error);
  result = await as('anon', `SELECT * FROM public.get_company_leave_requests(
    'U-manager-A',$1,NULL,NULL,NULL,NULL,1000)`, [COMPANY_A]);
  check('重套後管理員 RPC 仍可用且隔離', !result.error && result.rows.length === 9
    && result.rows.every(x => x.employees.company_id === COMPANY_A), result.error || JSON.stringify(result.rows));

  console.log(`\n結果：${pass} 通過、${fail} 失敗`);
  await db.close();
  process.exitCode = fail ? 1 : 0;
})().catch(e => {
  console.error(e);
  process.exitCode = 1;
});
