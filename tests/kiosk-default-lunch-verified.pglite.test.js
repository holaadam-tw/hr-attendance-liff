// migration 156：員工固定便當＋公務機自動套用（純本機 PGlite，可控時鐘）。
// 反向對照：
//   MIGRATION156_NO_ALREADY_CHOSEN=1 破壞既有選擇保護，測試必須失敗。
//   MIGRATION156_NO_DEADLINE=1 移除截止保護，測試必須失敗。
const fs = require('fs');
const path = require('path');
const { PGlite } = require('@electric-sql/pglite');

const root = path.join(__dirname, '..');
const read = file => fs.readFileSync(file, 'utf8');
const useTestClock = sql => sql.replace(/\bnow\(\)/gi, 'public.test_now()');
let migration156 = useTestClock(read(process.env.MIGRATION156_FILE || path.join(root, 'migrations', '156_employee_default_lunch.sql')));
if (process.env.MIGRATION156_NO_DEADLINE === '1') {
  migration156 = migration156.replace(
    /\n    IF public\.lunch_deadline_passed\(v_company_id\) THEN[\s\S]*?\n    END IF;/,
    ''
  );
}
if (process.env.MIGRATION156_NO_ALREADY_CHOSEN === '1') {
  migration156 = migration156
    .replace(/\n    -- MUTATION_GUARD_ALREADY_CHOSEN_BEGIN[\s\S]*?-- MUTATION_GUARD_ALREADY_CHOSEN_END\n/, '\n')
    .replace(
      'ON CONFLICT (employee_id, order_date) DO NOTHING;',
      `ON CONFLICT (employee_id, order_date) DO UPDATE
         SET status = EXCLUDED.status,
             is_vegetarian = EXCLUDED.is_vegetarian,
             updated_at = EXCLUDED.updated_at,
             notes = EXCLUDED.notes;`
    );
}
const rollback156 = read(path.join(root, 'migrations', '156_employee_default_lunch_rollback.sql'));

let pass = 0, fail = 0;
function check(name, ok, detail = '') {
  if (ok) pass++; else fail++;
  console.log(`  ${ok ? '✅' : '❌'} ${name}${detail ? ` → ${detail}` : ''}`);
}

const A = '10000000-0000-0000-0000-000000000001';
const B = '10000000-0000-0000-0000-000000000002';
const E = {
  admin: '20000000-0000-0000-0000-000000000001',
  kioskA: '20000000-0000-0000-0000-000000000002',
  regular: '20000000-0000-0000-0000-000000000003',
  vegetarian: '20000000-0000-0000-0000-000000000004',
  none: '20000000-0000-0000-0000-000000000005',
  unset: '20000000-0000-0000-0000-000000000006',
  cross: '20000000-0000-0000-0000-000000000007',
  kioskTarget: '20000000-0000-0000-0000-000000000008',
  resigned: '20000000-0000-0000-0000-000000000009'
};

(async () => {
  console.log('\n═══════════════════════════════════════');
  console.log('  員工固定便當 verified RPC（156，PGlite 可控時鐘）');
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
  const callDefault = async (line, employee, role = 'service_role') => {
    const out = await as(role, `SELECT public.kiosk_lunch_apply_default_verified($1::text,$2::uuid) r`, [line, employee]);
    return out.error ? { error: out.error } : out.rows[0].r;
  };
  const updateEmployee = async updates => {
    const out = await as('service_role', `SELECT public.admin_update_employee($1::uuid,$2::text,$3::uuid,$4::jsonb) r`,
      [A, 'Uadmin', E.regular, JSON.stringify(updates)]);
    return out.error ? { error: out.error } : out.rows[0].r;
  };
  const clearOrders = () => apply('DELETE FROM public.lunch_orders;');
  const setClock = iso => apply(`UPDATE public.test_clock SET value='${iso}'::timestamptz;`);
  const setCompany = (industry, features = '{}') => apply(`UPDATE public.companies SET industry='${industry}', features='${features}'::jsonb WHERE id='${A}';`);
  const setVisibility = value => apply(`INSERT INTO public.system_settings(company_id,key,value) VALUES('${A}','feature_visibility','${value}'::jsonb)
    ON CONFLICT(company_id,key) DO UPDATE SET value=excluded.value;`);
  const clearVisibility = () => apply(`DELETE FROM public.system_settings WHERE company_id='${A}' AND key='feature_visibility';`);
  const denied = result => /permission denied/.test(result?.error || '');

  await db.exec(`
    CREATE ROLE anon NOLOGIN;
    CREATE ROLE authenticated NOLOGIN;
    CREATE ROLE service_role NOLOGIN;
    CREATE ROLE prod_postgres NOLOGIN;
    GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
    GRANT USAGE, CREATE ON SCHEMA public TO prod_postgres;
    SET ROLE prod_postgres;

    CREATE TABLE public.test_clock(value timestamptz NOT NULL);
    INSERT INTO public.test_clock VALUES('2026-11-27T00:30:00Z');
    CREATE FUNCTION public.test_now() RETURNS timestamptz
      LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public
      AS $$ SELECT value FROM public.test_clock LIMIT 1 $$;

    CREATE TABLE public.companies (
      id uuid PRIMARY KEY, name text, industry text, features jsonb NOT NULL DEFAULT '{}'::jsonb
    );
    CREATE TABLE public.employees (
      id uuid PRIMARY KEY, company_id uuid NOT NULL REFERENCES public.companies(id), employee_number text,
      name text NOT NULL, department text, position text, phone text, hire_date date,
      employment_type text, preferred_language text, line_user_id text, is_bound boolean, bound_at timestamptz,
      can_schedule boolean, no_checkin boolean, is_kiosk boolean, gps_relaxed boolean,
      shift_mode text, fixed_shift_start time, fixed_shift_end time, is_active boolean NOT NULL DEFAULT true,
      status text, resigned_date date, resign_reason text, resign_note text, emergency_contact text,
      emergency_phone text, id_card_last_4 text, role text, created_at timestamptz DEFAULT public.test_now(),
      updated_at timestamptz
    );
    CREATE TABLE public.system_settings (
      company_id uuid NOT NULL, key text NOT NULL, value jsonb, PRIMARY KEY(company_id,key)
    );
    CREATE TABLE public.lunch_orders (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), employee_id uuid NOT NULL REFERENCES public.employees(id),
      order_date date NOT NULL, is_vegetarian boolean DEFAULT false, status varchar DEFAULT 'ordered',
      created_at timestamptz DEFAULT public.test_now(), updated_at timestamptz DEFAULT public.test_now(),
      notes text, UNIQUE(employee_id, order_date)
    );

    CREATE FUNCTION public.is_company_manager_caller(p_line_user_id text, p_company_id uuid)
    RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public AS $$
      SELECT EXISTS (SELECT 1 FROM public.employees e WHERE e.line_user_id=p_line_user_id
        AND e.company_id=p_company_id AND e.is_active=true AND coalesce(e.is_kiosk,false)=false
        AND e.role IN ('admin','manager','platform_admin'))
    $$;
    CREATE FUNCTION public.is_company_admin_strict_caller(p_line_user_id text, p_company_id uuid)
    RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public AS $$
      SELECT EXISTS (SELECT 1 FROM public.employees e WHERE e.line_user_id=p_line_user_id
        AND e.company_id=p_company_id AND e.is_active=true AND coalesce(e.is_kiosk,false)=false
        AND e.role IN ('admin','platform_admin'))
    $$;
    CREATE FUNCTION public.kiosk_resolve_verified(p_line_user_id text)
    RETURNS TABLE(kiosk_id uuid, company_id uuid)
    LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public AS $$
      SELECT e.id, e.company_id FROM public.employees e
       WHERE e.line_user_id=p_line_user_id AND e.is_active=true AND coalesce(e.is_kiosk,false)=true
       ORDER BY e.created_at LIMIT 1
    $$;
    CREATE FUNCTION public.lunch_deadline_passed(p_company_id uuid)
    RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public AS $$
      SELECT (public.test_now() AT TIME ZONE 'Asia/Taipei')::time >= time '10:00'
    $$;
    CREATE FUNCTION public.admin_update_employee(uuid,text,uuid,jsonb)
    RETURNS jsonb LANGUAGE sql SECURITY DEFINER SET search_path=public AS $$ SELECT '{"success":false}'::jsonb $$;

    REVOKE ALL ON FUNCTION public.kiosk_resolve_verified(text) FROM PUBLIC, anon, authenticated;
    REVOKE ALL ON FUNCTION public.lunch_deadline_passed(uuid) FROM PUBLIC, anon, authenticated, service_role;
    REVOKE ALL ON FUNCTION public.admin_update_employee(uuid,text,uuid,jsonb) FROM PUBLIC, anon, authenticated;
    GRANT EXECUTE ON FUNCTION public.admin_update_employee(uuid,text,uuid,jsonb) TO service_role;

    INSERT INTO public.companies(id,name,industry,features) VALUES
      ('${A}','A 公司','manufacturing','{}'), ('${B}','B 公司','general','{}');
    INSERT INTO public.employees(id,company_id,employee_number,name,line_user_id,role,is_active,is_kiosk,status,department) VALUES
      ('${E.admin}','${A}','A01','管理員','Uadmin','admin',true,false,'approved','管理部'),
      ('${E.kioskA}','${A}','K01','公務機 A','UkioskA','user',true,true,'approved','管理部'),
      ('${E.regular}','${A}','E01','固定葷',NULL,'user',true,false,'approved','生產部'),
      ('${E.vegetarian}','${A}','E02','固定素',NULL,'user',true,false,'approved','生產部'),
      ('${E.none}','${A}','E03','固定不訂',NULL,'user',true,false,'approved','生產部'),
      ('${E.unset}','${A}','E04','每天問',NULL,'user',true,false,'approved','生產部'),
      ('${E.cross}','${B}','B01','跨公司',NULL,'user',true,false,'approved','他公司'),
      ('${E.kioskTarget}','${A}','K02','公務機目標','UkioskTarget','user',true,true,'approved','管理部'),
      ('${E.resigned}','${A}','E05','離職員工',NULL,'user',false,false,'resigned','生產部');
    RESET ROLE;
  `);

  let err = await apply(migration156);
  check('156 可套用且檔尾 ACL 自我檢查通過', err === '', err);

  await apply(`UPDATE public.employees SET default_lunch='regular' WHERE id='${E.regular}';
    UPDATE public.employees SET default_lunch='vegetarian' WHERE id='${E.vegetarian}';
    UPDATE public.employees SET default_lunch='none' WHERE id='${E.none}';`);

  console.log('\n=== 固定選擇、既有列與截止 ===');
  let r = await callDefault('UkioskA', E.regular);
  let row = await one(`SELECT order_date::text,status,is_vegetarian,notes FROM lunch_orders WHERE employee_id='${E.regular}'`);
  check('固定葷且今日無列：自動套用並標記來源', r?.success === true && r.applied === true && r.choice === 'regular'
    && row?.order_date === '2026-11-27' && row.status === 'ordered' && row.is_vegetarian === false && row.notes === '[公務機][固定]', JSON.stringify(r));

  r = await callDefault('UkioskA', E.none);
  row = await one(`SELECT status,is_vegetarian,notes FROM lunch_orders WHERE employee_id='${E.none}'`);
  check('固定不訂：寫 cancelled 且 notes 正確', r?.applied === true && r.choice === 'none'
    && row?.status === 'cancelled' && row.is_vegetarian === false && row.notes === '[公務機][固定]', JSON.stringify(r));

  await apply(`INSERT INTO public.lunch_orders(employee_id,order_date,status,is_vegetarian,notes,updated_at)
    VALUES('${E.vegetarian}','2026-11-27','ordered',false,'[人工]',public.test_now());`);
  const beforeOrdered = await one(`SELECT status,is_vegetarian,notes,updated_at::text FROM lunch_orders WHERE employee_id='${E.vegetarian}'`);
  r = await callDefault('UkioskA', E.vegetarian);
  const afterOrdered = await one(`SELECT status,is_vegetarian,notes,updated_at::text FROM lunch_orders WHERE employee_id='${E.vegetarian}'`);
  check('已有 ordered 任一列：回 already_chosen 且完全零寫入', r?.applied === false && r.reason === 'already_chosen'
    && r.choice === 'regular' && JSON.stringify(afterOrdered) === JSON.stringify(beforeOrdered), JSON.stringify(r));

  await clearOrders();
  await apply(`INSERT INTO public.lunch_orders(employee_id,order_date,status,is_vegetarian,notes,updated_at)
    VALUES('${E.vegetarian}','2026-11-27','cancelled',false,'[人工取消]',public.test_now());`);
  const beforeCancelled = await one(`SELECT status,is_vegetarian,notes,updated_at::text FROM lunch_orders WHERE employee_id='${E.vegetarian}'`);
  r = await callDefault('UkioskA', E.vegetarian);
  const afterCancelled = await one(`SELECT status,is_vegetarian,notes,updated_at::text FROM lunch_orders WHERE employee_id='${E.vegetarian}'`);
  check('已有 cancelled 列也算已選：回 none 且零寫入', r?.reason === 'already_chosen' && r.choice === 'none'
    && JSON.stringify(afterCancelled) === JSON.stringify(beforeCancelled), JSON.stringify(r));

  await clearOrders();
  await setClock('2026-11-27T02:00:00Z'); // 台灣 10:00
  r = await callDefault('UkioskA', E.regular);
  check('截止後回 deadline_passed 且零寫入', r?.success === true && r.applied === false && r.reason === 'deadline_passed'
    && (await one('SELECT count(*)::int n FROM lunch_orders')).n === 0, JSON.stringify(r));
  await setClock('2026-11-27T00:30:00Z');

  console.log('\n=== 預設、功能開關與身分隔離 ===');
  r = await callDefault('UkioskA', E.unset);
  check('未設定固定便當：no_default 且零寫入', r?.applied === false && r.reason === 'no_default'
    && (await one('SELECT count(*)::int n FROM lunch_orders')).n === 0, JSON.stringify(r));

  await setCompany('general', '{}');
  r = await callDefault('UkioskA', E.regular);
  check('產業預設關閉：lunch_disabled 且零寫入', r?.reason === 'lunch_disabled'
    && (await one('SELECT count(*)::int n FROM lunch_orders')).n === 0, JSON.stringify(r));
  await setCompany('manufacturing', '{"lunch":null}');
  r = await callDefault('UkioskA', E.regular);
  check('features.lunch=null：與前端一致視為關閉且零寫入', r?.reason === 'lunch_disabled'
    && (await one('SELECT count(*)::int n FROM lunch_orders')).n === 0, JSON.stringify(r));
  await setCompany('manufacturing', '{"lunch":"true"}');
  r = await callDefault('UkioskA', E.regular);
  check('features.lunch 為字串：與前端一致視為關閉且零寫入', r?.reason === 'lunch_disabled'
    && (await one('SELECT count(*)::int n FROM lunch_orders')).n === 0, JSON.stringify(r));
  await setCompany('general', '{"lunch":true}');
  await setVisibility('{"lunch":false}');
  r = await callDefault('UkioskA', E.regular);
  check('companies 開啟但 feature_visibility=false：仍關閉且零寫入', r?.reason === 'lunch_disabled'
    && (await one('SELECT count(*)::int n FROM lunch_orders')).n === 0, JSON.stringify(r));
  await clearVisibility();
  await setCompany('manufacturing', '{}');

  for (const [name, line, employee, code] of [
    ['非公務機帳號', 'Uadmin', E.regular, 'access_denied'],
    ['跨公司員工', 'UkioskA', E.cross, 'invalid_target'],
    ['目標是公務機', 'UkioskA', E.kioskTarget, 'invalid_target'],
    ['離職員工', 'UkioskA', E.resigned, 'invalid_target']
  ]) {
    await clearOrders();
    r = await callDefault(line, employee);
    check(`${name}被拒且零寫入`, r?.success === false && r.error_code === code
      && (await one('SELECT count(*)::int n FROM lunch_orders')).n === 0, JSON.stringify(r));
  }

  await clearOrders();
  r = await callDefault('UkioskA', E.regular);
  const second = await callDefault('UkioskA', E.regular);
  check('重複／競態呼叫不新增第二列', r?.applied === true && second?.reason === 'already_chosen'
    && (await one(`SELECT count(*)::int n FROM lunch_orders WHERE employee_id='${E.regular}'`)).n === 1, JSON.stringify(second));

  console.log('\n=== admin_update_employee 相容與 ACL ===');
  for (const choice of ['regular', 'vegetarian', 'none']) {
    r = await updateEmployee({ default_lunch: choice });
    row = await one(`SELECT default_lunch FROM employees WHERE id='${E.regular}'`);
    check(`admin_update_employee 接受 ${choice}`, r?.success === true && row.default_lunch === choice, JSON.stringify(r));
  }
  r = await updateEmployee({ default_lunch: null });
  row = await one(`SELECT default_lunch FROM employees WHERE id='${E.regular}'`);
  check('admin_update_employee 接受 null（不固定）', r?.success === true && row.default_lunch === null, JSON.stringify(r));
  r = await updateEmployee({ default_lunch: '   ' });
  row = await one(`SELECT default_lunch FROM employees WHERE id='${E.regular}'`);
  check('admin_update_employee 空字串視為 null', r?.success === true && row.default_lunch === null, JSON.stringify(r));
  r = await updateEmployee({ default_lunch: 'meat' });
  check('admin_update_employee 拒絕亂值且欄位不變', r?.success === false && r.error_code === 'invalid_value'
    && (await one(`SELECT default_lunch FROM employees WHERE id='${E.regular}'`)).default_lunch === null, JSON.stringify(r));
  r = await updateEmployee({ department: '品保部', phone: '0900' });
  row = await one(`SELECT department,phone FROM employees WHERE id='${E.regular}'`);
  check('其他既有欄位行為不變', r?.success === true && row.department === '品保部' && row.phone === '0900', JSON.stringify(r));

  check('anon 無固定便當 RPC EXECUTE', denied(await callDefault('UkioskA', E.regular, 'anon')));
  const adminAnon = await as('authenticated', `SELECT public.admin_update_employee('${A}'::uuid,'Uadmin','${E.regular}'::uuid,'{"phone":"1"}'::jsonb)`);
  check('authenticated 無 admin_update_employee EXECUTE', /permission denied/.test(adminAnon.error || ''), adminAnon.error);
  const acl = await q(`SELECT p.proname,p.prosecdef,p.proacl::text acl FROM pg_proc p
    WHERE p.oid IN ('public.kiosk_lunch_apply_default_verified(text,uuid)'::regprocedure,
                    'public.admin_update_employee(uuid,text,uuid,jsonb)'::regprocedure)
    ORDER BY p.proname`);
  check('兩支 RPC 均為 SECURITY DEFINER 且只授 service_role', acl.length === 2
    && acl.every(x => x.prosecdef === true && /service_role=X/.test(x.acl) && !/anon|authenticated|PUBLIC/i.test(x.acl)), JSON.stringify(acl));

  console.log('\n=== rollback 與重套 ===');
  err = await apply(rollback156);
  check('156 rollback 可套用', err === '', err);
  const rolled = await one(`SELECT
    to_regprocedure('public.kiosk_lunch_apply_default_verified(text,uuid)') IS NULL AS fn_gone,
    NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='employees' AND column_name='default_lunch') AS col_gone`);
  check('rollback 移除新 RPC 與欄位', rolled.fn_gone === true && rolled.col_gone === true, JSON.stringify(rolled));
  r = await updateEmployee({ default_lunch: 'regular' });
  check('rollback 後 admin_update_employee 回到正式庫白名單', r?.error_code === 'field_not_allowed', JSON.stringify(r));
  err = await apply(migration156);
  check('rollback 後可重套 156', err === '', err);

  console.log(`\n結果：${pass} 通過、${fail} 失敗`);
  await db.close();
  process.exitCode = fail ? 1 : 0;
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
