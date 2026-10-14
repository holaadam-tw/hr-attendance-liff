// migration 152：leave_requests 撤除公開讀取（純本機 PGlite）
//
// 基準：先建立正式庫 148 前政策／ACL，依序套 148、149、151，再驗 152。
// 反向對照：MIGRATION152_EMPTY=1 時，直接 SELECT／ACL／政策／自我檢查測試必須失敗。
const fs = require('fs');
const path = require('path');
const { PGlite } = require('@electric-sql/pglite');

const root = path.join(__dirname, '..');
const read = file => fs.readFileSync(file, 'utf8');
const m148 = read(path.join(root, 'migrations', '148_leave_requests_write_lock.sql'));
const m149 = read(path.join(root, 'migrations', '149_leave_requests_read_rpcs.sql'));
const m151 = read(path.join(root, 'migrations', '151_kiosk_leave_makeup_verified.sql'));
const m152 = process.env.MIGRATION152_EMPTY === '1' ? '' : read(
  process.env.MIGRATION152_FILE || path.join(root, 'migrations', '152_leave_requests_read_lock.sql'));
const rollback152 = read(path.join(root, 'migrations', '152_leave_requests_read_lock_rollback.sql'));
const reference = read(path.join(__dirname, 'fixtures', 'kiosk_151_prod_reference.md'));

function extractReferenceSql(heading) {
  const start = reference.indexOf(`### ${heading}`);
  const fence = reference.indexOf('```sql', start);
  const end = reference.indexOf('```', fence + 6);
  if (start < 0 || fence < 0 || end < 0) throw new Error(`正式庫參考缺少：${heading}`);
  return reference.slice(fence + 6, end).trim();
}

const formalSql = [
  extractReferenceSql('find_overlapping_leave('),
  extractReferenceSql('kiosk_resolve_verified('),
  extractReferenceSql('submit_leave_request(p_line_user_id text, p_company_id uuid'),
  extractReferenceSql('submit_leave_request(p_line_user_id text, p_leave_type'),
  extractReferenceSql('submit_makeup_punch(')
].join(';\n\n') + ';';

let pass = 0;
let fail = 0;
function check(name, ok, detail = '') {
  (ok ? pass++ : fail++);
  console.log(`  ${ok ? '✅' : '❌'} ${name}${detail ? ` → ${detail}` : ''}`);
}

const A = '10000000-0000-0000-0000-000000000001';
const B = '10000000-0000-0000-0000-000000000002';
const E = {
  user: '20000000-0000-0000-0000-000000000001',
  other: '20000000-0000-0000-0000-000000000002',
  admin: '20000000-0000-0000-0000-000000000003',
  kiosk: '20000000-0000-0000-0000-000000000004',
  cross: '20000000-0000-0000-0000-000000000005'
};

(async () => {
  console.log('\n═══════════════════════════════════════');
  console.log('  leave_requests 公開讀取鎖（152，PGlite 實跑）');
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
  const rpcRows = async (role, sql, params = []) => {
    const result = await as(role, sql, params);
    return result.error ? { error: result.error } : result.rows;
  };
  const rpcJson = async (role, sql, params = []) => {
    const result = await as(role, sql, params);
    return result.error ? { error: result.error } : result.rows[0].r;
  };
  const denied = result => /permission denied/i.test(result?.error || '');

  await db.exec(`
    CREATE ROLE anon NOLOGIN;
    CREATE ROLE authenticated NOLOGIN;
    CREATE ROLE service_role NOLOGIN;
    CREATE ROLE prod_postgres NOLOGIN;
    CREATE ROLE leak_reader NOLOGIN;
    GRANT leak_reader TO anon;
    GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
    GRANT USAGE, CREATE ON SCHEMA public TO prod_postgres;
    SET ROLE prod_postgres;

    CREATE TABLE public.employees (
      id uuid PRIMARY KEY, company_id uuid NOT NULL, line_user_id text,
      name text NOT NULL, employee_number text, department text,
      role text NOT NULL DEFAULT 'user', is_active boolean NOT NULL DEFAULT true,
      is_kiosk boolean NOT NULL DEFAULT false, created_at timestamptz DEFAULT now()
    );
    CREATE TABLE public.platform_admins (
      id uuid PRIMARY KEY, line_user_id text NOT NULL, is_active boolean NOT NULL DEFAULT true
    );
    CREATE TABLE public.platform_admin_companies (
      platform_admin_id uuid NOT NULL REFERENCES public.platform_admins(id), company_id uuid NOT NULL
    );
    CREATE TABLE public.leave_requests (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      employee_id uuid NOT NULL REFERENCES public.employees(id),
      leave_type varchar NOT NULL, start_date date NOT NULL, end_date date NOT NULL,
      days numeric DEFAULT 1, reason text, attachment_url text,
      status varchar DEFAULT 'pending', approver_id uuid, approved_at timestamptz,
      rejection_reason text, created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now(),
      leave_period text NOT NULL DEFAULT 'full_day', leave_hours numeric,
      leave_start_time time, leave_end_time time
    );
    CREATE TABLE public.makeup_punch_requests (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), employee_id uuid NOT NULL REFERENCES public.employees(id),
      punch_date date NOT NULL, punch_type text NOT NULL, punch_time time NOT NULL,
      reason text, status text NOT NULL DEFAULT 'pending', rejection_reason text,
      approver_id uuid, approved_at timestamptz, created_at timestamptz DEFAULT now(), note text
    );
    CREATE TABLE public.attendance (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), employee_id uuid NOT NULL REFERENCES public.employees(id),
      date date NOT NULL, check_in_time timestamptz, check_out_time timestamptz
    );

    ALTER TABLE public.leave_requests ENABLE ROW LEVEL SECURITY;
    CREATE POLICY "Allow RPC access leaves" ON public.leave_requests FOR ALL TO authenticated, anon USING (true) WITH CHECK (true);
    CREATE POLICY "允許新增請假單" ON public.leave_requests FOR INSERT TO authenticated, anon WITH CHECK (true);
    CREATE POLICY "允許更新待審核請假單" ON public.leave_requests FOR UPDATE TO authenticated, anon USING (((status)::text = 'pending'::text));
    CREATE POLICY "允許查看請假單" ON public.leave_requests FOR SELECT TO authenticated, anon USING (true);
    GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.leave_requests TO anon, authenticated;
    GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.leave_requests TO service_role;

    CREATE FUNCTION public.is_company_manager_caller(p_line_user_id text, p_company_id uuid)
    RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public AS $$
      SELECT EXISTS (
        SELECT 1 FROM public.employees e
        WHERE e.line_user_id=p_line_user_id AND e.company_id=p_company_id AND e.is_active=true
          AND e.role IN ('admin','manager','platform_admin') AND COALESCE(e.is_kiosk,false)=false
      )
    $$;
    CREATE FUNCTION public.count_employee_workdays(p_employee_id uuid, p_start date, p_end date)
    RETURNS integer LANGUAGE sql STABLE SET search_path=public AS $$
      SELECT count(*)::integer FROM generate_series(p_start,p_end,interval '1 day') d
      WHERE extract(isodow FROM d) BETWEEN 1 AND 5
    $$;
    CREATE FUNCTION public.leave_overlap_message(p_conflict jsonb, p_prefix text)
    RETURNS text LANGUAGE sql STABLE AS $$
      SELECT p_prefix || '（' || (p_conflict->>'start_date') || '）'
    $$;

    ${formalSql}

    CREATE FUNCTION public.approve_leave_request(
      p_company_id uuid, p_line_user_id text, p_request_id uuid,
      p_status text, p_rejection_reason text DEFAULT NULL
    ) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
    BEGIN
      IF NOT public.is_company_manager_caller(p_line_user_id,p_company_id) THEN
        RETURN jsonb_build_object('success',false,'error_code','access_denied');
      END IF;
      UPDATE public.leave_requests lr SET status=p_status,
        rejection_reason=CASE WHEN p_status='rejected' THEN p_rejection_reason ELSE NULL END,
        approver_id=(SELECT id FROM public.employees WHERE company_id=p_company_id AND line_user_id=p_line_user_id LIMIT 1),
        approved_at=now()
      FROM public.employees e
      WHERE lr.id=p_request_id AND lr.employee_id=e.id AND e.company_id=p_company_id AND lr.status='pending';
      RETURN jsonb_build_object('success',FOUND);
    END $$;

    REVOKE ALL ON FUNCTION public.find_overlapping_leave(uuid,date,date,uuid,text[]) FROM PUBLIC, anon, authenticated;
    GRANT EXECUTE ON FUNCTION public.find_overlapping_leave(uuid,date,date,uuid,text[]) TO service_role;
    REVOKE ALL ON FUNCTION public.kiosk_resolve_verified(text) FROM PUBLIC, anon, authenticated;
    GRANT EXECUTE ON FUNCTION public.kiosk_resolve_verified(text) TO service_role;
    REVOKE ALL ON FUNCTION public.submit_leave_request(text,uuid,varchar,date,date,text,text,time,time) FROM PUBLIC, anon, authenticated, service_role;
    REVOKE ALL ON FUNCTION public.submit_leave_request(text,varchar,date,date,text,text,numeric) FROM PUBLIC, anon, authenticated, service_role;
    GRANT EXECUTE ON FUNCTION public.submit_leave_request(text,uuid,varchar,date,date,text,text,time,time) TO anon, authenticated, service_role;
    GRANT EXECUTE ON FUNCTION public.submit_leave_request(text,varchar,date,date,text,text,numeric) TO anon, authenticated, service_role;
    GRANT EXECUTE ON FUNCTION public.submit_makeup_punch(text,date,text,time,text,text,uuid) TO PUBLIC, anon, authenticated, service_role;
    REVOKE ALL ON FUNCTION public.approve_leave_request(uuid,text,uuid,text,text) FROM PUBLIC;
    GRANT EXECUTE ON FUNCTION public.approve_leave_request(uuid,text,uuid,text,text) TO anon, authenticated;

    INSERT INTO public.employees(id,company_id,line_user_id,name,employee_number,department,role,is_active,is_kiosk,created_at) VALUES
      ('${E.user}','${A}','Uuser','員工甲','A001','製造','user',true,false,'2026-01-01'),
      ('${E.other}','${A}',NULL,'員工乙','A002','品管','user',true,false,'2026-01-02'),
      ('${E.admin}','${A}','Uadmin','主管甲','A900','管理','admin',true,false,'2026-01-03'),
      ('${E.kiosk}','${A}','Ukiosk','公務機','K001','管理','user',true,true,'2026-01-04'),
      ('${E.cross}','${B}','Ucross','跨公司員工','B001','門市','user',true,false,'2026-01-05');
    RESET ROLE;
  `);

  console.log('\n=== 1. 以 148 後狀態建立基準，再套 149／151 ===');
  let error = await apply(m148);
  check('148 可套用', error === '', error);
  error = await apply(m149);
  check('149 四支讀取 RPC 可套用', error === '', error);
  error = await apply(m151);
  check('151 員工／公務機送單 RPC 可套用', error === '', error);

  const dates = await one(`SELECT
    (now() AT TIME ZONE 'Asia/Taipei')::date::text today,
    ((now() AT TIME ZONE 'Asia/Taipei')::date - 1)::text yesterday,
    ((now() AT TIME ZONE 'Asia/Taipei')::date + (8-extract(isodow FROM (now() AT TIME ZONE 'Asia/Taipei')::date)::int))::text monday,
    ((now() AT TIME ZONE 'Asia/Taipei')::date + (15-extract(isodow FROM (now() AT TIME ZONE 'Asia/Taipei')::date)::int))::text monday2,
    ((now() AT TIME ZONE 'Asia/Taipei')::date + (22-extract(isodow FROM (now() AT TIME ZONE 'Asia/Taipei')::date)::int))::text monday3`);
  await db.exec(`SET ROLE prod_postgres;
    INSERT INTO public.leave_requests(id,employee_id,leave_type,start_date,end_date,days,reason,status)
    VALUES
      ('30000000-0000-0000-0000-000000000001','${E.user}','annual','${dates.today}','${dates.today}',1,'本人核准','approved'),
      ('30000000-0000-0000-0000-000000000002','${E.other}','sick','${dates.today}','${dates.today}',1,'同事待審','pending');
    RESET ROLE;`);

  for (const role of ['anon', 'authenticated']) {
    const result = await as(role, 'SELECT count(*)::int n FROM public.leave_requests');
    check(`152 前（148 後）${role} 直接 SELECT 可讀`, !result.error && result.rows[0].n === 2,
      result.error || `rows=${result.rows[0].n}`);
  }

  const readCalls = {
    company: [`SELECT id::text,status FROM public.get_company_leave_requests('Uadmin',$1,NULL,NULL,NULL,NULL,100) ORDER BY id`, [A]],
    mine: [`SELECT id::text,status FROM public.get_my_leave_requests('Uuser',$1,NULL,NULL,NULL,100) ORDER BY id`, [A]],
    overlap: [`SELECT employee_id::text,status FROM public.get_company_leave_overlap('Uuser',$1,$2,$2) ORDER BY employee_id`, [A, dates.today]],
    publicToday: [`SELECT employee_id::text,employee_name FROM public.get_public_today_leave_employees($1) ORDER BY employee_id`, [A]]
  };
  const beforeRpc = {};
  for (const [name, [sql, params]] of Object.entries(readCalls)) beforeRpc[name] = await rpcRows('anon', sql, params);
  check('149 四支 RPC 套 152 前全部可讀', Object.values(beforeRpc).every(x => !x.error && x.length > 0), JSON.stringify(beforeRpc));

  console.log('\n=== 2. 套 152：公開直接讀取全鎖，RPC 維持 ===');
  error = await apply(m152);
  check('152 可套用', error === '', error);
  for (const role of ['anon', 'authenticated']) {
    const result = await as(role, 'SELECT * FROM public.leave_requests');
    check(`152 後 ${role} 直接 SELECT permission denied`, denied(result), result.error);
    const privilege = await one(`SELECT has_table_privilege($1,'public.leave_requests','SELECT') s,
      has_table_privilege($1,'public.leave_requests','INSERT') i,
      has_table_privilege($1,'public.leave_requests','UPDATE') u,
      has_table_privilege($1,'public.leave_requests','DELETE') d`, [role]);
    check(`152 後 ${role} 無 table 權限`, privilege && !privilege.s && !privilege.i && !privilege.u && !privilege.d,
      JSON.stringify(privilege));
  }
  const meta = await one(`SELECT
    (SELECT relrowsecurity FROM pg_class WHERE oid='public.leave_requests'::regclass) rls,
    (SELECT count(*)::int FROM pg_policies WHERE schemaname='public' AND tablename='leave_requests'
      AND roles && ARRAY['public','anon','authenticated']::name[]) public_policies,
    has_table_privilege('service_role','public.leave_requests','SELECT') service_select`);
  check('152 後 RLS on、公開政策 0、service_role 不受影響',
    meta?.rls === true && meta.public_policies === 0 && meta.service_select === true, JSON.stringify(meta));

  const afterRpc = {};
  for (const [name, [sql, params]] of Object.entries(readCalls)) afterRpc[name] = await rpcRows('authenticated', sql, params);
  check('149 四支 SECURITY DEFINER RPC 套 152 後結果不變',
    JSON.stringify(afterRpc) === JSON.stringify(beforeRpc), JSON.stringify({ beforeRpc, afterRpc }));

  const submitted = await rpcJson('anon',
    `SELECT public.submit_leave_request('Uuser',$1::uuid,'annual',$2::date,$2::date,'152 測試','full_day',NULL,NULL) r`,
    [A, dates.monday]);
  const submittedId = await one(`SELECT id FROM public.leave_requests WHERE employee_id=$1 AND start_date=$2`, [E.user, dates.monday]);
  const approved = await rpcJson('authenticated',
    `SELECT public.approve_leave_request($1::uuid,'Uadmin',$2::uuid,'approved',NULL) r`, [A, submittedId?.id]);
  const approvedRow = await one(`SELECT status FROM public.leave_requests WHERE id=$1`, [submittedId?.id]);
  check('152 後 submit_leave_request／approve_leave_request 正常',
    submitted?.success === true && approved?.success === true && approvedRow?.status === 'approved',
    JSON.stringify({ submitted, approved, approvedRow }));

  const kioskLeave = await rpcJson('service_role',
    `SELECT public.kiosk_submit_leave_verified('Ukiosk',$1::uuid,'annual',$2::date,$2::date,'公務機測試','full_day',NULL,NULL) r`,
    [E.other, dates.monday2]);
  const kioskMakeup = await rpcJson('service_role',
    `SELECT public.kiosk_submit_makeup_verified('Ukiosk',$1::uuid,$2::date,'clock_in','08:30','公務機補卡') r`,
    [E.other, dates.yesterday]);
  const kioskState = await one(`SELECT
    EXISTS(SELECT 1 FROM public.leave_requests WHERE employee_id=$1 AND start_date=$2 AND status='pending' AND reason LIKE '[公務機送出]%') leave_ok,
    EXISTS(SELECT 1 FROM public.makeup_punch_requests WHERE employee_id=$1 AND punch_date=$3 AND status='pending' AND note LIKE '[公務機送出]%') makeup_ok`,
    [E.other, dates.monday2, dates.yesterday]);
  check('152 後 151 公務機請假／補卡送單正常',
    kioskLeave?.success === true && kioskMakeup?.success === true && kioskState?.leave_ok && kioskState?.makeup_ok,
    JSON.stringify({ kioskLeave, kioskMakeup, kioskState }));

  console.log('\n=== 3. rollback 精確恢復、漂移時自我檢查回復、可重套 ===');
  error = await apply(rollback152);
  check('152 rollback 可套用', error === '', error);
  for (const role of ['anon', 'authenticated']) {
    const result = await as(role, 'SELECT count(*)::int n FROM public.leave_requests');
    check(`rollback 後 ${role} 恢復直接 SELECT`, !result.error && result.rows[0].n >= 4, result.error);
  }
  const restored = await one(`SELECT
    (SELECT count(*)::int FROM pg_policies WHERE schemaname='public' AND tablename='leave_requests'
      AND policyname='允許查看請假單' AND cmd='SELECT' AND qual='true'
      AND roles @> ARRAY['authenticated','anon']::name[] AND array_length(roles,1)=2) policy_exact,
    has_table_privilege('anon','public.leave_requests','SELECT') anon_select,
    has_table_privilege('authenticated','public.leave_requests','SELECT') auth_select`);
  check('rollback 精確還原政策原文與兩個 SELECT grant',
    restored?.policy_exact === 1 && restored.anon_select && restored.auth_select, JSON.stringify(restored));

  await db.exec(`SET ROLE prod_postgres;
    CREATE POLICY unexpected_inherited_read ON public.leave_requests FOR SELECT TO leak_reader USING (true);
    RESET ROLE;`);
  error = await apply(m152);
  const rolledBack = await one(`SELECT
    (SELECT count(*)::int FROM pg_policies WHERE schemaname='public' AND tablename='leave_requests'
      AND policyname IN ('允許查看請假單','unexpected_inherited_read')) policies,
    has_table_privilege('anon','public.leave_requests','SELECT') anon_select`);
  check('152 檔尾發現經角色繼承的殘留政策會 RAISE 並整筆回復',
    /經角色繼承適用/.test(error) && rolledBack?.policies === 2 && rolledBack.anon_select === true,
    `${error} | ${JSON.stringify(rolledBack)}`);
  await db.exec(`SET ROLE prod_postgres; DROP POLICY unexpected_inherited_read ON public.leave_requests; RESET ROLE;`);

  error = await apply(m152);
  check('清除漂移後 152 可重套', error === '', error);
  const finalSelect = await as('anon', 'SELECT * FROM public.leave_requests');
  check('重套後仍擋直接 SELECT', denied(finalSelect), finalSelect.error);
  const finalRpc = await rpcRows('anon', readCalls.mine[0], readCalls.mine[1]);
  check('重套後本人讀取 RPC 仍正常', !finalRpc.error && finalRpc.length >= 2, JSON.stringify(finalRpc));

  console.log(`\n結果：${pass} 通過、${fail} 失敗`);
  await db.close();
  process.exitCode = fail ? 1 : 0;
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
