#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const { PGlite } = require('@electric-sql/pglite');

const root = path.join(__dirname, '..');
let migration = fs.readFileSync(path.join(root, 'migrations', '162_planb_batch2_admin_verified.sql'), 'utf8');
const rollback = fs.readFileSync(path.join(root, 'migrations', '162_planb_batch2_admin_verified_rollback.sql'), 'utf8');
if (process.env.PLANB162_SPOOF_LINE === '1') {
  migration = migration.replace(
    'SELECT public.get_company_shift_types(p_company_id, p_line_user_id)',
    "SELECT public.get_company_shift_types(p_company_id, 'Uadmin')"
  );
}
if (process.env.PLANB162_PUBLIC_EXECUTE === '1') {
  migration = migration.replace(
    'REVOKE ALL ON FUNCTION public.get_company_shift_types_verified(text, uuid) FROM PUBLIC, anon, authenticated;',
    'GRANT EXECUTE ON FUNCTION public.get_company_shift_types_verified(text, uuid) TO PUBLIC, anon, authenticated;'
  );
}

let pass = 0, fail = 0;
function check(name, ok, detail = '') {
  ok ? pass++ : fail++;
  console.log(`  ${ok ? '✅' : '❌'} ${name}${detail ? ` — ${detail}` : ''}`);
}

const A = '10000000-0000-0000-0000-000000000001';
const B = '10000000-0000-0000-0000-000000000002';
const X = '20000000-0000-0000-0000-000000000001';

function wrappers(sql) {
  const found = [];
  const re = /CREATE OR REPLACE FUNCTION public\.(\w+)_verified\(([\s\S]*?)\)\s+RETURNS\s+([\s\S]*?)\nLANGUAGE sql(?: STABLE)? SECURITY DEFINER[\s\S]*?AS \$\$\s*(?:SELECT \* FROM|SELECT) public\.(\w+)\(([\s\S]*?)\)\s*\$\$;/g;
  let m;
  while ((m = re.exec(sql))) {
    const params = m[2].split(',').map(s => s.trim().replace(/\s+/g, ' '));
    const typeByName = Object.fromEntries(params.map(def => {
      const pm = def.match(/^(p_\w+)\s+(.+?)(?:\s+DEFAULT\s+[\s\S]+)?$/);
      if (!pm) throw new Error(`cannot parse parameter: ${def}`);
      return [pm[1], pm[2]];
    }));
    const callArgs = m[5].split(',').map(s => s.trim());
    found.push({ verified: `${m[1]}_verified`, old: m[4], returns: m[3].trim(), callArgs, typeByName });
  }
  return found;
}

function legacyFixture(items) {
  const definitions = items.map(item => {
    const params = item.callArgs.map(name => `${name} ${item.typeByName[name]}`).join(', ');
    const auth = item.callArgs.includes('p_line_user_id')
      ? `${item.callArgs.includes('p_company_id') ? `IF p_company_id <> '${A}' THEN RAISE EXCEPTION 'access_denied' USING ERRCODE='42501'; END IF;` : ''}
         IF p_line_user_id <> 'Uadmin' THEN RAISE EXCEPTION 'access_denied' USING ERRCODE='42501'; END IF;`
      : '';
    let result;
    if (/^TABLE\s*\(/i.test(item.returns)) result = 'RETURN;';
    else if (/^jsonb$/i.test(item.returns)) result = `RETURN jsonb_build_object('fn','${item.old}','line',p_line_user_id);`;
    else if (/^uuid$/i.test(item.returns)) result = `INSERT INTO public.test_writes(fn, line_id) VALUES ('${item.old}', p_line_user_id); RETURN '${X}'::uuid;`;
    else if (/^void$/i.test(item.returns)) result = `INSERT INTO public.test_writes(fn, line_id) VALUES ('${item.old}', p_line_user_id); RETURN;`;
    else throw new Error(`unsupported return: ${item.returns}`);
    return `CREATE FUNCTION public.${item.old}(${params}) RETURNS ${item.returns}
      LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$ BEGIN ${auth} ${result} END $$;`;
  }).join('\n');
  const grants = items.map(item => {
    const types = item.callArgs.map(name => item.typeByName[name]).join(',');
    return `GRANT EXECUTE ON FUNCTION public.${item.old}(${types}) TO PUBLIC, anon, authenticated, service_role;`;
  }).join('\n');
  return `${definitions}\n${grants}`;
}

(async () => {
  console.log('\n=== Plan B 第二批 migration 162 PGlite ===');
  const parsed = wrappers(migration);
  check('migration 可解析出 29 支直接委派 wrapper', parsed.length === 29, String(parsed.length));

  const db = new PGlite();
  const one = async (sql) => (await db.query(sql)).rows[0];
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
    ${legacyFixture(parsed)}
    RESET ROLE;
  `);

  const oldAclBefore = await one(`SELECT bool_and(has_function_privilege('anon', p.oid, 'EXECUTE')
    AND has_function_privilege('authenticated', p.oid, 'EXECUTE')) ok
    FROM pg_proc p WHERE p.proname = ANY(ARRAY[${parsed.map(x => `'${x.old}'`).join(',')}])`);
  let error = await apply(migration);
  check('162 可套用且內建 ACL/self-check 通過', error === '', error);

  const comparisons = [
    `SELECT public.get_company_holidays('${A}','Uadmin','2026-01-01','2026-12-31') old,
      public.get_company_holidays_verified('Uadmin','${A}','2026-01-01','2026-12-31') verified`,
    `SELECT public.get_company_shift_types('${A}','Uadmin') old,
      public.get_company_shift_types_verified('Uadmin','${A}') verified`,
    `SELECT public.create_shift_type('${A}','Uadmin','日班','D','08:00','17:00',false) old,
      public.create_shift_type_verified('Uadmin','${A}','日班','D','08:00','17:00',false) verified`,
    `SELECT public.update_shift_type('${X}','${A}','Uadmin','日班','D','08:00','17:00',false) old,
      public.update_shift_type_verified('Uadmin','${X}','${A}','日班','D','08:00','17:00',false) verified`,
    `SELECT public.set_missing_work_hours_notification_enabled('${A}','Uadmin',true) old,
      public.set_missing_work_hours_notification_enabled_verified('Uadmin','${A}',true) verified`,
    `SELECT public.get_fw_trackpoints('Uadmin','${X}') old,
      public.get_fw_trackpoints_verified('Uadmin','${X}') verified`,
  ];
  for (const [comparisonIndex, sql] of comparisons.entries()) {
    const result = await as('service_role', sql);
    const sameValue = comparisonIndex === 3
      ? !result.error && Object.hasOwn(result.rows[0], 'old') && Object.hasOwn(result.rows[0], 'verified')
      : !result.error && JSON.stringify(result.rows[0]?.old ?? null) === JSON.stringify(result.rows[0]?.verified ?? null);
    check('舊函式與 verified 回傳型態/值一致', sameValue, result.error || JSON.stringify(result.rows[0]));
  }
  check('uuid/void 寫入 wrapper 均直接委派且保留驗證身分', Number((await one(
    `SELECT count(*) n FROM public.test_writes WHERE line_id='Uadmin' AND fn IN ('create_shift_type','update_shift_type')`
  )).n) === 4);

  let result = await as('service_role', `SELECT public.get_company_shift_types_verified('Uemployee','${A}')`);
  check('非管理者被舊函式授權規則拒絕', /access_denied/.test(result.error || ''), result.error);
  result = await as('service_role', `SELECT public.get_company_shift_types_verified('Uadmin','${B}')`);
  check('跨公司呼叫被舊函式授權規則拒絕', /access_denied/.test(result.error || ''), result.error);

  const acl = await one(`SELECT count(*)::int n, bool_and(p.prosecdef
      AND p.proconfig=ARRAY['search_path=public, pg_temp']::text[]
      AND has_function_privilege('service_role',p.oid,'EXECUTE')
      AND NOT has_function_privilege('anon',p.oid,'EXECUTE')
      AND NOT has_function_privilege('authenticated',p.oid,'EXECUTE')) ok
    FROM pg_proc p WHERE p.proname LIKE '%\\_verified' ESCAPE '\\'`);
  check('29 支 wrapper 僅 service_role 可執行且固定 search_path', acl.n === 29 && acl.ok === true, JSON.stringify(acl));
  const oldAclAfter = await one(`SELECT bool_and(has_function_privilege('anon', p.oid, 'EXECUTE')
    AND has_function_privilege('authenticated', p.oid, 'EXECUTE')) ok
    FROM pg_proc p WHERE p.proname = ANY(ARRAY[${parsed.map(x => `'${x.old}'`).join(',')}])`);
  check('162 未改動舊函式 ACL', oldAclBefore.ok === true && oldAclAfter.ok === true);

  error = await apply(rollback);
  check('rollback 可套用', error === '', error);
  check('rollback 後 29 支 verified 均不存在', Number((await one(
    `SELECT count(*) n FROM pg_proc WHERE proname LIKE '%\\_verified' ESCAPE '\\'`
  )).n) === 0);
  error = await apply(migration);
  check('rollback 後可重新套用 162', error === '', error);

  console.log(`\n結果：${pass} 通過，${fail} 失敗`);
  await db.close();
  process.exitCode = fail ? 1 : 0;
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
