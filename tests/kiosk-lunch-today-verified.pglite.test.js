// migration 155：公務機員工截止前重選當天便當（純本機 PGlite，可控時鐘）。
// 反向對照：MIGRATION155_NO_DEADLINE=1 會在記憶體移除送單截止 guard；截止後零寫入案例必須失敗。
const fs = require('fs');
const path = require('path');
const { PGlite } = require('@electric-sql/pglite');

const root = path.join(__dirname, '..');
const read = file => fs.readFileSync(file, 'utf8');
const useTestClock = sql => sql.replace(/\bnow\(\)/gi, 'public.test_now()');
let migration155 = useTestClock(read(process.env.MIGRATION155_FILE || path.join(root, 'migrations', '155_kiosk_lunch_today_verified.sql')));
if (process.env.MIGRATION155_NO_DEADLINE === '1') {
  migration155 = migration155.replace(
    /\n    IF public\.lunch_deadline_passed\(v_company_id\) THEN[\s\S]*?\n    END IF;/,
    ''
  );
}
const rollback155 = read(path.join(root, 'migrations', '155_kiosk_lunch_today_verified_rollback.sql'));

let pass = 0, fail = 0;
function check(name, ok, detail = '') {
  if (ok) pass++; else fail++;
  console.log(`  ${ok ? '✅' : '❌'} ${name}${detail ? ` → ${detail}` : ''}`);
}

const A = '10000000-0000-0000-0000-000000000001';
const B = '10000000-0000-0000-0000-000000000002';
const E = {
  kioskA: '20000000-0000-0000-0000-000000000001',
  target: '20000000-0000-0000-0000-000000000002',
  target2: '20000000-0000-0000-0000-000000000003',
  cross: '20000000-0000-0000-0000-000000000004',
  kioskTarget: '20000000-0000-0000-0000-000000000005',
  resigned: '20000000-0000-0000-0000-000000000006'
};

(async () => {
  console.log('\n═══════════════════════════════════════');
  console.log('  公務機當天便當 verified RPC（155，PGlite 可控時鐘）');
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
  const order = async (role, line, employee, choice) => {
    const result = await as(role, `SELECT public.kiosk_lunch_today_verified($1::text,$2::uuid,$3::text) r`, [line, employee, choice]);
    return result.error ? { error: result.error } : result.rows[0].r;
  };
  const status = async (role, line, employee) => {
    const result = await as(role, `SELECT public.kiosk_lunch_today_status_verified($1::text,$2::uuid) r`, [line, employee]);
    return result.error ? { error: result.error } : result.rows[0].r;
  };
  const denied = result => /permission denied/.test(result?.error || '');
  const clearOrders = () => apply('DELETE FROM public.lunch_orders;');
  const setClock = iso => apply(`UPDATE public.test_clock SET value='${iso}'::timestamptz;`);
  const setDeadline = valueSql => apply(`INSERT INTO public.system_settings(company_id,key,value) VALUES('${A}','lunch_deadline',${valueSql}::jsonb)
    ON CONFLICT(company_id,key) DO UPDATE SET value=excluded.value;`);
  const clearDeadline = () => apply(`DELETE FROM public.system_settings WHERE company_id='${A}' AND key='lunch_deadline';`);

  await db.exec(`
    CREATE ROLE anon NOLOGIN;
    CREATE ROLE authenticated NOLOGIN;
    CREATE ROLE service_role NOLOGIN;
    CREATE ROLE prod_postgres NOLOGIN;
    GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
    GRANT USAGE, CREATE ON SCHEMA public TO prod_postgres;
    SET ROLE prod_postgres;

    CREATE TABLE public.test_clock(value timestamptz NOT NULL);
    INSERT INTO public.test_clock VALUES('2026-11-19T00:30:00Z');
    CREATE FUNCTION public.test_now() RETURNS timestamptz
      LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public
      AS $$ SELECT value FROM public.test_clock LIMIT 1 $$;

    CREATE TABLE public.employees (
      id uuid PRIMARY KEY, company_id uuid NOT NULL, line_user_id text, name text NOT NULL,
      is_active boolean NOT NULL DEFAULT true, is_kiosk boolean NOT NULL DEFAULT false,
      created_at timestamptz DEFAULT public.test_now()
    );
    CREATE TABLE public.system_settings (
      company_id uuid NOT NULL, key text NOT NULL, value jsonb,
      PRIMARY KEY(company_id,key)
    );
    CREATE TABLE public.lunch_orders (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), employee_id uuid NOT NULL REFERENCES public.employees(id),
      order_date date NOT NULL, is_vegetarian boolean DEFAULT false, status varchar DEFAULT 'ordered',
      created_at timestamptz DEFAULT public.test_now(), updated_at timestamptz DEFAULT public.test_now(),
      notes text, UNIQUE(employee_id, order_date)
    );

    CREATE FUNCTION public.kiosk_resolve_verified(p_line_user_id text)
    RETURNS TABLE(kiosk_id uuid, company_id uuid)
    LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public AS $$
      SELECT e.id, e.company_id FROM public.employees e
       WHERE e.line_user_id=p_line_user_id AND e.is_active=true AND coalesce(e.is_kiosk,false)=true
       ORDER BY e.created_at LIMIT 1
    $$;
    REVOKE ALL ON FUNCTION public.kiosk_resolve_verified(text) FROM PUBLIC, anon, authenticated;
    GRANT EXECUTE ON FUNCTION public.kiosk_resolve_verified(text) TO service_role;

    INSERT INTO public.employees(id,company_id,line_user_id,name,is_active,is_kiosk,created_at) VALUES
      ('${E.kioskA}','${A}','UkioskA','公務機 A',true,true,'2026-01-01'),
      ('${E.target}','${A}',NULL,'同公司員工',true,false,'2026-01-02'),
      ('${E.target2}','${A}',NULL,'第二位員工',true,false,'2026-01-03'),
      ('${E.cross}','${B}',NULL,'跨公司員工',true,false,'2026-01-04'),
      ('${E.kioskTarget}','${A}','UkioskTarget','公務機目標',true,true,'2026-01-05'),
      ('${E.resigned}','${A}',NULL,'離職員工',false,false,'2026-01-06');
    RESET ROLE;
  `);

  let err = await apply(migration155);
  check('155 可套用且檔尾 ACL 自我檢查通過', err === '', err);

  console.log('\n=== 可控截止時間與零寫入 ===');
  await setDeadline(`'"9"'`);
  await setClock('2026-11-19T00:30:00Z'); // 台灣 08:30
  let r = await order('service_role', 'UkioskA', E.target, 'regular');
  let row = await one(`SELECT order_date::text,status,is_vegetarian,notes FROM lunch_orders WHERE employee_id='${E.target}'`);
  check('純數字字串 "9"：08:30 截止前可送單', r?.success === true && row?.status === 'ordered' && row.notes === '[公務機]', JSON.stringify(r));
  check('送單日期只由可控 DB 台灣今日決定', r?.order_date === '2026-11-19' && row?.order_date === '2026-11-19', JSON.stringify(r));
  let s = await status('service_role', 'UkioskA', E.target);
  check('status 正確回目前葷食', s?.success === true && s.choice === 'regular', JSON.stringify(s));

  await clearOrders();
  await setClock('2026-11-19T01:00:00Z'); // 台灣 09:00
  r = await order('service_role', 'UkioskA', E.target, 'regular');
  check('"9"：09:00 視為已截止且零寫入', r?.success === false && r.error_code === 'deadline_passed'
    && (await one('SELECT count(*)::int n FROM lunch_orders')).n === 0, JSON.stringify(r));

  await setDeadline('9');
  await setClock('2026-11-19T00:59:00Z'); // 台灣 08:59
  s = await status('service_role', 'UkioskA', E.target);
  check('JSONB 數字 9 也正規化為 09:00', s?.success === true && s.deadline === '09:00' && s.deadline_passed === false, JSON.stringify(s));

  await setDeadline(`'"10:00"'`);
  await setClock('2026-11-19T01:59:00Z'); // 台灣 09:59
  r = await order('service_role', 'UkioskA', E.target, 'vegetarian');
  check('"10:00"：09:59 可送素食', r?.success === true && r.is_vegetarian === true, JSON.stringify(r));
  await clearOrders();
  await setClock('2026-11-19T02:00:00Z'); // 台灣 10:00
  r = await order('service_role', 'UkioskA', E.target, 'regular');
  check('"10:00"：10:00 已截止且零寫入', r?.success === false && r.error_code === 'deadline_passed'
    && (await one('SELECT count(*)::int n FROM lunch_orders')).n === 0, JSON.stringify(r));

  await clearDeadline();
  await setClock('2026-11-19T01:59:00Z');
  r = await order('service_role', 'UkioskA', E.target, 'regular');
  check('未設定：預設 10:00，09:59 可送單', r?.success === true, JSON.stringify(r));
  await clearOrders();
  await setClock('2026-11-19T02:00:00Z');
  r = await order('service_role', 'UkioskA', E.target, 'regular');
  check('未設定：預設 10:00，10:00 截止且零寫入', r?.success === false && r.error_code === 'deadline_passed'
    && (await one('SELECT count(*)::int n FROM lunch_orders')).n === 0, JSON.stringify(r));
  await setDeadline(`'"not-a-time"'`);
  await setClock('2026-11-19T01:59:00Z');
  s = await status('service_role', 'UkioskA', E.target);
  check('讀不懂的設定安全回退 10:00', s?.success === true && s.deadline === '10:00' && s.deadline_passed === false, JSON.stringify(s));

  console.log('\n=== 身分、租戶、更新與狀態查詢 ===');
  await setClock('2026-11-19T00:00:00Z');
  await setDeadline(`'"10:00"'`);
  for (const [name, line, employee, code] of [
    ['非公務機帳號', 'Uordinary', E.target, 'access_denied'],
    ['跨公司員工', 'UkioskA', E.cross, 'invalid_target'],
    ['公務機目標', 'UkioskA', E.kioskTarget, 'invalid_target'],
    ['離職員工', 'UkioskA', E.resigned, 'invalid_target']
  ]) {
    await clearOrders();
    r = await order('service_role', line, employee, 'regular');
    check(`${name}被拒且零寫入`, r?.success === false && r.error_code === code
      && (await one('SELECT count(*)::int n FROM lunch_orders')).n === 0, JSON.stringify(r));
  }

  await clearOrders();
  r = await order('service_role', 'UkioskA', E.target, 'regular');
  r = await order('service_role', 'UkioskA', E.target, 'vegetarian');
  row = await one(`SELECT status,is_vegetarian,notes FROM lunch_orders WHERE employee_id='${E.target}'`);
  check('已有訂單會更新而不新增', r?.success === true && row?.is_vegetarian === true
    && (await one(`SELECT count(*)::int n FROM lunch_orders WHERE employee_id='${E.target}'`)).n === 1, JSON.stringify(r));
  s = await status('service_role', 'UkioskA', E.target);
  check('status 正確回目前素食、截止字串與未截止', s?.success === true && s.choice === 'vegetarian'
    && s.deadline === '10:00' && s.deadline_passed === false, JSON.stringify(s));

  r = await order('service_role', 'UkioskA', E.target, 'none');
  row = await one(`SELECT status,is_vegetarian FROM lunch_orders WHERE employee_id='${E.target}'`);
  s = await status('service_role', 'UkioskA', E.target);
  check('none 更新為 cancelled 且 status 回 none', r?.success === true && r.status === 'cancelled'
    && row?.status === 'cancelled' && row.is_vegetarian === false && s?.choice === 'none', JSON.stringify(s));
  s = await status('service_role', 'UkioskA', E.target2);
  check('尚無訂單時 status choice 為 null', s?.success === true && s.choice === null, JSON.stringify(s));
  s = await status('service_role', 'UkioskA', E.cross);
  check('status 也拒絕跨公司目標', s?.success === false && s.error_code === 'invalid_target', JSON.stringify(s));
  await setClock('2026-11-19T02:01:00Z');
  s = await status('service_role', 'UkioskA', E.target);
  check('status 在截止後回 deadline_passed=true', s?.success === true && s.deadline_passed === true, JSON.stringify(s));

  console.log('\n=== 選項、ACL、rollback 與重套 ===');
  await clearOrders();
  r = await order('service_role', 'UkioskA', E.target, 'meat');
  check('錯誤 choice 被拒且零寫入', r?.success === false && r.error_code === 'invalid_choice'
    && (await one('SELECT count(*)::int n FROM lunch_orders')).n === 0, JSON.stringify(r));
  check('anon 無送單 EXECUTE', denied(await order('anon', 'UkioskA', E.target, 'regular')));
  check('authenticated 無狀態 EXECUTE', denied(await status('authenticated', 'UkioskA', E.target)));
  const internalService = await as('service_role', `SELECT public.lunch_deadline_passed('${A}'::uuid)`);
  check('internal helper 連 service_role 都不可直接執行', /permission denied/.test(internalService.error || ''), internalService.error);
  const acl = await q(`SELECT p.proname,p.prosecdef,p.proacl::text acl FROM pg_proc p
    WHERE p.oid IN ('public.kiosk_lunch_today_verified(text,uuid,text)'::regprocedure,
                    'public.kiosk_lunch_today_status_verified(text,uuid)'::regprocedure)
    ORDER BY p.proname`);
  check('兩支 verified RPC 都保留 SECURITY DEFINER 且未授 anon/authenticated', acl.length === 2
    && acl.every(x => x.prosecdef === true && /service_role=X/.test(x.acl) && !/anon|authenticated|PUBLIC/i.test(x.acl)), JSON.stringify(acl));

  err = await apply(rollback155);
  check('155 rollback 可套用', err === '', err);
  check('rollback 後三支函式都不存在', (await one(`SELECT
    to_regprocedure('public.kiosk_lunch_today_verified(text,uuid,text)') IS NULL
    AND to_regprocedure('public.kiosk_lunch_today_status_verified(text,uuid)') IS NULL
    AND to_regprocedure('public.lunch_deadline_passed(uuid)') IS NULL gone`)).gone === true);
  err = await apply(migration155);
  check('rollback 後可重套 155', err === '', err);

  console.log(`\n結果：${pass} 通過、${fail} 失敗`);
  await db.close();
  process.exitCode = fail ? 1 : 0;
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
