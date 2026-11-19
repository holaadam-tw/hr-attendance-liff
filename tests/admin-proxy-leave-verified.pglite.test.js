// migration 153：管理員代員工請假 verified RPC（純本機 PGlite）。
// 反向對照：MIGRATION153_NO_PERMISSION=1 會在記憶體移除權限檢查；權限案例必須失敗。
const fs = require('fs');
const path = require('path');
const { PGlite } = require('@electric-sql/pglite');

const root = path.join(__dirname, '..');
const read = file => fs.readFileSync(file, 'utf8');
const reference = read(path.join(__dirname, 'fixtures', 'kiosk_151_prod_reference.md'));
const migration151 = read(path.join(root, 'migrations', '151_kiosk_leave_makeup_verified.sql'));
let migration153 = read(process.env.MIGRATION153_FILE || path.join(root, 'migrations', '153_admin_proxy_leave_verified.sql'));
if (process.env.MIGRATION153_NO_PERMISSION === '1') {
  migration153 = migration153.replace(
    /\n    IF NOT public\.is_company_manager_caller\(p_line_user_id, p_company_id\) THEN[\s\S]*?\n    END IF;/,
    ''
  );
}
const rollback153 = read(path.join(root, 'migrations', '153_admin_proxy_leave_verified_rollback.sql'));

function extractReferenceSql(heading) {
  const start = reference.indexOf(`### ${heading}`);
  const fence = reference.indexOf('```sql', start);
  const end = reference.indexOf('```', fence + 6);
  if (start < 0 || fence < 0 || end < 0) throw new Error(`正式庫參考缺少 SQL：${heading}`);
  return reference.slice(fence + 6, end).trim();
}

const formalSql = [
  extractReferenceSql('find_overlapping_leave('),
  extractReferenceSql('kiosk_resolve_verified('),
  extractReferenceSql('submit_leave_request(p_line_user_id text, p_company_id uuid'),
  extractReferenceSql('submit_leave_request(p_line_user_id text, p_leave_type'),
  extractReferenceSql('submit_makeup_punch(')
].join(';\n\n') + ';';

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
  cross: '20000000-0000-0000-0000-000000000005',
  resigned: '20000000-0000-0000-0000-000000000006',
  kiosk: '20000000-0000-0000-0000-000000000007'
};
const PA = '50000000-0000-0000-0000-000000000001';
const FIXED_LEAVE = '30000000-0000-0000-0000-000000000001';
const MONDAY = '2026-11-23';
const TUESDAY = '2026-11-24';
const WEDNESDAY = '2026-11-25';

(async () => {
  console.log('\n═══════════════════════════════════════');
  console.log('  管理員代員工請假 verified RPC（153，PGlite 實跑）');
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
  const rpc = async (role, args) => {
    const result = await as(role, `SELECT public.admin_submit_leave_for_employee_verified(
      $1::uuid,$2::text,$3::uuid,$4::varchar,$5::date,$6::date,$7::text,$8::text,$9::time,$10::time) r`, args);
    return result.error ? { error: result.error } : result.rows[0].r;
  };
  const denied = result => /permission denied/.test(result?.error || '');
  const call = (role, line, employee, date = MONDAY, reason = '家庭事務') => rpc(role,
    [A, line, employee, 'annual', date, date, reason, 'full_day', null, null]);
  const clearLeave = () => apply('DELETE FROM public.leave_requests;');

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
    CREATE TABLE public.leave_requests (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), employee_id uuid NOT NULL REFERENCES public.employees(id),
      leave_type varchar NOT NULL, start_date date NOT NULL, end_date date NOT NULL, days numeric DEFAULT 1,
      reason text, attachment_url text, status varchar DEFAULT 'pending', approver_id uuid,
      approved_at timestamptz, rejection_reason text, created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now(),
      leave_period text NOT NULL DEFAULT 'full_day', leave_hours numeric, leave_start_time time, leave_end_time time
    );
    CREATE TABLE public.makeup_punch_requests (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), employee_id uuid NOT NULL REFERENCES public.employees(id),
      punch_date date NOT NULL, punch_type text NOT NULL, punch_time time NOT NULL, reason text,
      status text NOT NULL DEFAULT 'pending', rejection_reason text, approver_id uuid,
      approved_at timestamptz, created_at timestamptz DEFAULT now(), note text
    );
    CREATE TABLE public.attendance (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), employee_id uuid NOT NULL REFERENCES public.employees(id),
      date date NOT NULL, check_in_time timestamptz, check_out_time timestamptz
    );

    CREATE FUNCTION public.count_employee_workdays(p_employee_id uuid, p_start date, p_end date)
    RETURNS integer LANGUAGE sql STABLE SET search_path=public AS $$
      SELECT count(*)::integer FROM generate_series(p_start, p_end, interval '1 day') d
      WHERE extract(isodow FROM d) BETWEEN 1 AND 5
    $$;
    CREATE FUNCTION public.leave_overlap_message(p_conflict jsonb, p_prefix text)
    RETURNS text LANGUAGE sql STABLE AS $$ SELECT p_prefix || '（' || (p_conflict->>'start_date') || '）' $$;

    ${formalSql}

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

    REVOKE ALL ON FUNCTION public.find_overlapping_leave(uuid,date,date,uuid,text[]) FROM PUBLIC, anon, authenticated;
    GRANT EXECUTE ON FUNCTION public.find_overlapping_leave(uuid,date,date,uuid,text[]) TO service_role;
    REVOKE ALL ON FUNCTION public.kiosk_resolve_verified(text) FROM PUBLIC, anon, authenticated;
    GRANT EXECUTE ON FUNCTION public.kiosk_resolve_verified(text) TO service_role;
    REVOKE ALL ON FUNCTION public.submit_leave_request(text,uuid,varchar,date,date,text,text,time,time) FROM PUBLIC, anon, authenticated, service_role;
    REVOKE ALL ON FUNCTION public.submit_leave_request(text,varchar,date,date,text,text,numeric) FROM PUBLIC, anon, authenticated, service_role;
    GRANT EXECUTE ON FUNCTION public.submit_leave_request(text,uuid,varchar,date,date,text,text,time,time) TO anon, authenticated, service_role;
    GRANT EXECUTE ON FUNCTION public.submit_leave_request(text,varchar,date,date,text,text,numeric) TO anon, authenticated, service_role;
    GRANT EXECUTE ON FUNCTION public.submit_makeup_punch(text,date,text,time,text,text,uuid) TO PUBLIC, anon, authenticated, service_role;
    REVOKE ALL ON FUNCTION public.is_company_manager_caller(text,uuid) FROM PUBLIC, anon, authenticated;
    GRANT EXECUTE ON FUNCTION public.is_company_manager_caller(text,uuid) TO service_role;

    INSERT INTO public.employees(id,company_id,line_user_id,name,employee_number,role,is_active,is_kiosk,created_at) VALUES
      ('${E.admin}','${A}','Uadmin','王管理員','A01','admin',true,false,'2026-01-01'),
      ('${E.manager}','${A}','Umanager','李主管','M01','manager',true,false,'2026-01-02'),
      ('${E.user}','${A}','Uuser','一般員工','E01','user',true,false,'2026-01-03'),
      ('${E.target}','${A}',NULL,'代送對象','E02','user',true,false,'2026-01-04'),
      ('${E.cross}','${B}','Ucross','別家公司','B01','user',true,false,'2026-01-05'),
      ('${E.resigned}','${A}',NULL,'離職員工','E03','user',false,false,'2026-01-06'),
      ('${E.kiosk}','${A}','Ukiosk','公務機','K01','user',true,true,'2026-01-07');
    INSERT INTO public.platform_admins(id,line_user_id,name,is_active) VALUES('${PA}','Uplatform','平台小編',true);
    INSERT INTO public.platform_admin_companies(platform_admin_id,company_id) VALUES('${PA}','${A}');
    RESET ROLE;
  `);

  let err = await apply(migration151);
  check('151 共用請假規則可在本機基線套用', err === '', err);
  err = await apply(migration153);
  check('153 可套用且檔尾 ACL 自我檢查通過', err === '', err);

  console.log('\n=== 權限、pending 與稽核 ===');
  let r = await call('service_role', 'Uadmin', E.target);
  let row = await one(`SELECT employee_id::text,status,reason,approver_id,approved_at FROM leave_requests LIMIT 1`);
  check('admin 可代送同公司在職員工', r?.success === true && row?.employee_id === E.target, JSON.stringify(r));
  check('admin 代送固定 pending 且 reason 使用 DB 姓名前綴', row?.status === 'pending' && row.approver_id === null
    && row.approved_at === null && row.reason === '[管理員代送：王管理員] 家庭事務', JSON.stringify(row));

  await clearLeave();
  r = await call('service_role', 'Umanager', E.target, TUESDAY, '主管代填');
  row = await one(`SELECT status,reason FROM leave_requests LIMIT 1`);
  check('manager 可代送且使用主管姓名稽核', r?.success === true && row?.reason === '[管理員代送：李主管] 主管代填');

  await clearLeave();
  r = await call('service_role', 'Uplatform', E.target, WEDNESDAY, '平台代填');
  row = await one(`SELECT reason FROM leave_requests LIMIT 1`);
  check('綁定公司的 platform_admin 可代送且姓名來自 platform_admins', r?.success === true
    && row?.reason === '[管理員代送：平台小編] 平台代填');

  await clearLeave();
  r = await call('service_role', 'Uuser', E.target);
  check('一般員工被拒 access_denied 且零寫入', r?.success === false && r.error_code === 'access_denied'
    && (await one('SELECT count(*)::int n FROM leave_requests')).n === 0, JSON.stringify(r));
  r = await call('anon', 'Uadmin', E.target);
  check('anon 無 EXECUTE', denied(r), r.error);
  r = await call('authenticated', 'Uadmin', E.target);
  check('authenticated 無 EXECUTE', denied(r), r.error);

  console.log('\n=== 目標員工與共用規則 ===');
  for (const [name, employee, matcher] of [
    ['跨公司目標', E.cross, x => /有效員工/.test(x?.error || '')],
    ['離職目標', E.resigned, x => /有效員工/.test(x?.error || '')],
    ['公務機目標', E.kiosk, x => x?.error_code === 'target_kiosk']
  ]) {
    await clearLeave();
    r = await call('service_role', 'Uadmin', employee);
    check(`${name}被拒且零寫入`, r?.success === false && matcher(r)
      && (await one('SELECT count(*)::int n FROM leave_requests')).n === 0, JSON.stringify(r));
  }

  await clearLeave();
  await apply(`INSERT INTO public.leave_requests(id,employee_id,leave_type,start_date,end_date,days,reason,status,leave_period)
    VALUES('${FIXED_LEAVE}','${E.target}','annual','${MONDAY}','${MONDAY}',1,'既有','pending','full_day');`);
  r = await call('service_role', 'Uadmin', E.target, MONDAY, '重疊');
  check('重疊假單沿用 internal 規則被拒', r?.success === false && r.error_code === 'leave_overlap'
    && (await one('SELECT count(*)::int n FROM leave_requests')).n === 1, JSON.stringify(r));

  console.log('\n=== rollback、重套與順序防呆 ===');
  err = await apply(rollback153);
  check('153 rollback 可套用', err === '', err);
  check('rollback 後函式不存在', (await one(`SELECT to_regprocedure(
    'public.admin_submit_leave_for_employee_verified(uuid,text,uuid,character varying,date,date,text,text,time without time zone,time without time zone)') IS NULL gone`)).gone === true);
  err = await apply(migration153);
  check('rollback 後可重套 153', err === '', err);

  err = await apply(rollback153);
  await apply(`CREATE FUNCTION public.submit_leave_request_impl() RETURNS jsonb LANGUAGE sql AS $$ SELECT '{}'::jsonb $$;`);
  err = await apply(migration153);
  check('偵測到 141 *_impl 時 153 明確中止', /141/.test(err) && /相容/.test(err), err);

  console.log(`\n結果：${pass} 通過、${fail} 失敗`);
  await db.close();
  process.exitCode = fail ? 1 : 0;
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
