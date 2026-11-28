#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const { PGlite } = require('@electric-sql/pglite');

const root = path.join(__dirname, '..');
const migrationSource = fs.readFileSync(path.join(root, 'migrations', '163_planb_batch3_self_verified.sql'), 'utf8');
let migration = migrationSource;
const rollback = fs.readFileSync(path.join(root, 'migrations', '163_planb_batch3_self_verified_rollback.sql'), 'utf8');

if (process.env.PLANB163_SPOOF_LINE === '1') {
  migration = migration.replace(
    'SELECT public.get_my_current_salary(p_line_user_id)',
    "SELECT public.get_my_current_salary('Ualpha')"
  );
}
if (process.env.PLANB163_PUBLIC_EXECUTE === '1') {
  migration = migration.replace(
    'REVOKE ALL ON FUNCTION public.get_my_current_salary_verified(text) FROM PUBLIC, anon, authenticated;',
    'GRANT EXECUTE ON FUNCTION public.get_my_current_salary_verified(text) TO PUBLIC, anon, authenticated;'
  );
}

let pass = 0;
let fail = 0;
function check(name, ok, detail = '') {
  ok ? pass++ : fail++;
  console.log(`  ${ok ? '✅' : '❌'} ${name}${detail ? ` — ${detail}` : ''}`);
}

const COMPANY = '10000000-0000-0000-0000-000000000001';
const OTHER = '10000000-0000-0000-0000-000000000002';
const TRIP = '20000000-0000-0000-0000-000000000001';
const EMP_A = '30000000-0000-0000-0000-000000000001';
const EMP_B = '30000000-0000-0000-0000-000000000002';

function wrappers(sql) {
  const found = [];
  const re = /CREATE OR REPLACE FUNCTION public\.(\w+)_verified\(([\s\S]*?)\)\s+RETURNS\s+([\s\S]*?)\nLANGUAGE sql(?: STABLE)? SECURITY DEFINER[\s\S]*?AS \$\$\s*(?:SELECT \* FROM|SELECT) public\.(\w+)\(([\s\S]*?)\)\s*\$\$;/g;
  let match;
  while ((match = re.exec(sql))) {
    const params = match[2].split(',').map(value => value.trim().replace(/\s+/g, ' '));
    const typeByName = Object.fromEntries(params.map(definition => {
      const parsed = definition.match(/^(p_\w+)\s+(.+?)(?:\s+DEFAULT\s+[\s\S]+)?$/);
      if (!parsed) throw new Error(`cannot parse parameter: ${definition}`);
      return [parsed[1], parsed[2]];
    }));
    found.push({
      verified: `${match[1]}_verified`,
      old: match[4],
      returns: match[3].trim(),
      callArgs: match[5].split(',').map(value => value.trim()),
      typeByName,
    });
  }
  return found;
}

function legacyFixture(items) {
  const definitions = items.map(item => {
    const params = item.callArgs.map(name => `${name} ${item.typeByName[name]}`).join(', ');
    const companyGuard = item.callArgs.includes('p_company_id')
      ? `IF p_company_id <> '${COMPANY}' THEN RAISE EXCEPTION 'access_denied' USING ERRCODE='42501'; END IF;`
      : '';
    let result;
    if (item.old === 'get_company_leave_overlap') {
      result = `RETURN QUERY SELECT r.employee_id, r.employee_name, DATE '2026-11-01', DATE '2026-11-01', 'approved'::text
        FROM public.test_self_rows r WHERE r.line_id = p_line_user_id;`;
    } else if (/^TABLE\s*\(/i.test(item.returns)) {
      result = 'RETURN;';
    } else if (/^jsonb$/i.test(item.returns)) {
      const write = /^(register_employee|set_my_preferred_language|submit_)/.test(item.old)
        ? `INSERT INTO public.test_writes(fn, line_id) VALUES ('${item.old}', p_line_user_id);`
        : '';
      result = `${write} RETURN jsonb_build_object('fn','${item.old}','line',p_line_user_id);`;
    } else if (/^json$/i.test(item.returns)) {
      result = `RETURN json_build_object('fn','${item.old}','line',p_line_user_id);`;
    } else if (/^integer$/i.test(item.returns)) {
      const write = item.old === 'insert_fw_trackpoints'
        ? `INSERT INTO public.test_writes(fn, line_id) VALUES ('${item.old}', p_line_user_id);`
        : '';
      result = `${write} RETURN 1;`;
    } else {
      throw new Error(`unsupported return: ${item.returns}`);
    }
    return `CREATE FUNCTION public.${item.old}(${params}) RETURNS ${item.returns}
      LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
      BEGIN ${companyGuard} ${result} END $$;`;
  }).join('\n');
  const grants = items.map(item => {
    const types = item.callArgs.map(name => item.typeByName[name]).join(',');
    return `GRANT EXECUTE ON FUNCTION public.${item.old}(${types}) TO PUBLIC, anon, authenticated, service_role;`;
  }).join('\n');
  return `${definitions}\n${grants}`;
}

(async () => {
  console.log('\n=== Plan B 第三批 migration 163 PGlite ===');
  // Mutation 只改待套用 SQL；fixture 與簽章解析固定使用原始 migration，
  // 避免 mutation 因 parser/fixture 損壞而假陽性失敗。
  const parsed = wrappers(migrationSource);
  check('migration 可解析出 17 支第三批 wrapper', parsed.length === 17, String(parsed.length));
  check('包含 15 個函式名稱與兩組 overload', new Set(parsed.map(item => item.old)).size === 15);

  const deferred = ['log_checkin_failure', 'quick_check_in', 'quick_check_out_after_clock_in_makeup', 'get_my_makeup_requests', 'submit_makeup_punch'];
  check('五支打卡路徑函式未建立 wrapper', deferred.every(name => !migration.includes(`public.${name}_verified`)));

  const db = new PGlite();
  const one = async sql => (await db.query(sql)).rows[0];
  async function as(role, sql) {
    try {
      await db.exec(`SET ROLE ${role}`);
      return { rows: (await db.query(sql)).rows };
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
      try { await db.exec('ROLLBACK'); } catch (_) { /* no active transaction */ }
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
    CREATE TABLE public.test_writes(fn text, line_id text);
    CREATE TABLE public.test_self_rows(line_id text, employee_id uuid, employee_name text);
    INSERT INTO public.test_self_rows VALUES
      ('Ualpha', '${EMP_A}', 'Alpha'), ('Ubeta', '${EMP_B}', 'Beta');
    ${legacyFixture(parsed)}
    RESET ROLE;
  `);

  const oldAclBefore = await one(`SELECT bool_and(has_function_privilege('anon', p.oid, 'EXECUTE')
    AND has_function_privilege('authenticated', p.oid, 'EXECUTE')) ok
    FROM pg_proc p WHERE p.proname = ANY(ARRAY[${[...new Set(parsed.map(item => item.old))].map(name => `'${name}'`).join(',')}])`);

  let error = await apply(migration);
  check('163 可套用且內建 ACL/self-check 通過', error === '', error);

  let result = await as('service_role', `SELECT
    (SELECT jsonb_agg(to_jsonb(x)) FROM public.get_company_leave_overlap('Ualpha','${COMPANY}','2026-11-01','2026-11-30') x) old,
    (SELECT jsonb_agg(to_jsonb(x)) FROM public.get_company_leave_overlap_verified('Ualpha','${COMPANY}','2026-11-01','2026-11-30') x) verified`);
  check('TABLE 讀取 wrapper 與舊版回傳一致', !result.error
    && JSON.stringify(result.rows[0]?.old) === JSON.stringify(result.rows[0]?.verified), result.error);

  const alpha = await as('service_role', `SELECT public.get_my_current_salary_verified('Ualpha') value`);
  const beta = await as('service_role', `SELECT public.get_my_current_salary_verified('Ubeta') value`);
  check('jsonb 讀取保留已驗證 LINE 身分', alpha.rows?.[0]?.value?.line === 'Ualpha' && beta.rows?.[0]?.value?.line === 'Ubeta');
  check('他人 LINE ID 只能取得該人結果且與舊版一致',
    alpha.rows?.[0]?.value?.line !== beta.rows?.[0]?.value?.line
    && (await as('service_role', `SELECT public.get_my_current_salary('Ubeta') value`)).rows?.[0]?.value?.line === beta.rows?.[0]?.value?.line);

  result = await as('service_role', `SELECT public.submit_leave_request_verified(
    'Ualpha','${COMPANY}','annual','2026-12-01','2026-12-01','test','full_day',NULL,NULL)`);
  check('寫入型 submit_* 直接委派並使用已驗證 LINE', !result.error, result.error);
  result = await as('service_role', `SELECT public.insert_fw_trackpoints_verified(
    'Ualpha','${TRIP}','[{"lat":25,"lng":121,"recorded_at":"2026-11-28T00:00:00Z"}]'::jsonb)`);
  check('insert_fw_trackpoints 直接委派並保留回傳型別', !result.error && Number(result.rows[0]?.insert_fw_trackpoints_verified) === 1, result.error);
  check('兩種寫入代表都記錄真實 LINE 身分', Number((await one(
    `SELECT count(*) n FROM public.test_writes WHERE line_id='Ualpha' AND fn IN ('submit_leave_request','insert_fw_trackpoints')`
  )).n) === 2);

  result = await as('service_role', `SELECT public.get_company_leave_overlap_verified('Ualpha','${OTHER}','2026-11-01','2026-11-30')`);
  check('跨公司仍由舊函式規則拒絕', /access_denied/.test(result.error || ''), result.error);

  const acl = await one(`SELECT count(*)::int n, bool_and(p.prosecdef
      AND p.proconfig=ARRAY['search_path=public, pg_temp']::text[]
      AND has_function_privilege('service_role',p.oid,'EXECUTE')
      AND NOT has_function_privilege('anon',p.oid,'EXECUTE')
      AND NOT has_function_privilege('authenticated',p.oid,'EXECUTE')) ok
    FROM pg_proc p WHERE p.proname = ANY(ARRAY[${[...new Set(parsed.map(item => item.verified))].map(name => `'${name}'`).join(',')}])`);
  check('17 支 wrapper 僅 service_role 可執行且固定 search_path', acl.n === 17 && acl.ok === true, JSON.stringify(acl));
  const oldAclAfter = await one(`SELECT bool_and(has_function_privilege('anon', p.oid, 'EXECUTE')
    AND has_function_privilege('authenticated', p.oid, 'EXECUTE')) ok
    FROM pg_proc p WHERE p.proname = ANY(ARRAY[${[...new Set(parsed.map(item => item.old))].map(name => `'${name}'`).join(',')}])`);
  check('163 未改動舊函式 ACL', oldAclBefore.ok === true && oldAclAfter.ok === true);

  error = await apply(rollback);
  check('rollback 可套用', error === '', error);
  check('rollback 後 17 支 verified 均不存在', Number((await one(
    `SELECT count(*) n FROM pg_proc WHERE proname = ANY(ARRAY[${[...new Set(parsed.map(item => item.verified))].map(name => `'${name}'`).join(',')}])`
  )).n) === 0);
  error = await apply(migration);
  check('rollback 後可重新套用 163', error === '', error);

  console.log(`\n結果：${pass} 通過，${fail} 失敗`);
  await db.close();
  process.exitCode = fail ? 1 : 0;
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
