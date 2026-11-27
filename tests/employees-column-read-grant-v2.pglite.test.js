#!/usr/bin/env node
// 權限收緊第二階段：先有 37 欄授權，再撤除 6 個管理端敏感欄位（純本機 PGlite）。
// TEST-MIRRORED 區塊須與私有 159b SQL 對應區塊一致。
const fs = require('fs');
const { PGlite } = require('@electric-sql/pglite');

const PUBLIC_COLUMNS = [
  'id', 'employee_number', 'name', 'department', 'position', 'join_date',
  'line_user_id', 'is_active', 'is_bound', 'bound_at', 'created_at',
  'updated_at', 'is_admin', 'company_id', 'role', 'hire_date',
  'employment_type', 'salary_type', 'status', 'resigned_date', 'resign_reason', 'resign_note',
  'shift_mode', 'fixed_shift_start', 'fixed_shift_end', 'can_schedule',
  'no_checkin', 'is_kiosk', 'preferred_language', 'gps_relaxed', 'default_lunch'
];
const SENSITIVE_COLUMNS = [
  'phone', 'email', 'emergency_contact', 'emergency_phone',
  'id_card_last_4', 'hourly_rate'
];
const OTHER_COLUMNS = [
  'verify_code', 'id_last_four', 'device_info',
  'check_in_lat', 'check_in_lng', 'max_distance_meters'
];
const FIRST_STAGE_COLUMNS = [...PUBLIC_COLUMNS, ...SENSITIVE_COLUMNS];
const ALL_COLUMNS = [...FIRST_STAGE_COLUMNS, ...OTHER_COLUMNS];

const APPLY_158 = `
REVOKE SELECT ON public.employees FROM anon, authenticated;
GRANT SELECT (${FIRST_STAGE_COLUMNS.join(',')}) ON public.employees TO anon, authenticated;
`;

const APPLY_159B = process.env.PRIVATE159B_APPLY_FILE
  ? fs.readFileSync(process.env.PRIVATE159B_APPLY_FILE, 'utf8')
  : String.raw`
DO $verify_158$
DECLARE
  v_role name;
  v_column name;
  v_first_stage constant text[] := ARRAY[
    'id', 'employee_number', 'name', 'department', 'position', 'join_date',
    'line_user_id', 'phone', 'email', 'is_active', 'is_bound', 'bound_at',
    'created_at', 'updated_at', 'id_card_last_4', 'is_admin', 'company_id',
    'role', 'hire_date', 'employment_type', 'salary_type', 'hourly_rate',
    'emergency_contact', 'emergency_phone', 'status', 'resigned_date',
    'resign_reason', 'resign_note', 'shift_mode', 'fixed_shift_start',
    'fixed_shift_end', 'can_schedule', 'no_checkin', 'is_kiosk',
    'preferred_language', 'gps_relaxed', 'default_lunch'
  ];
BEGIN
  FOREACH v_role IN ARRAY ARRAY['anon'::name, 'authenticated'::name] LOOP
    IF has_table_privilege(v_role, 'public.employees', 'SELECT') THEN
      RAISE EXCEPTION '159b 前提失敗：% 仍有 employees 表級 SELECT', v_role;
    END IF;
    FOREACH v_column IN ARRAY v_first_stage LOOP
      IF NOT has_column_privilege(v_role, 'public.employees', v_column, 'SELECT') THEN
        RAISE EXCEPTION '159b 前提失敗：% 缺少 158 欄位權限 %', v_role, v_column;
      END IF;
    END LOOP;
  END LOOP;
END
$verify_158$;

-- BEGIN TEST-MIRRORED 159B APPLY SQL
REVOKE SELECT (
  phone, email, emergency_contact, emergency_phone,
  id_card_last_4, hourly_rate
) ON public.employees FROM anon, authenticated;
-- END TEST-MIRRORED 159B APPLY SQL
`;

const ROLLBACK_159B = process.env.PRIVATE159B_ROLLBACK_FILE
  ? fs.readFileSync(process.env.PRIVATE159B_ROLLBACK_FILE, 'utf8')
  : String.raw`
-- BEGIN TEST-MIRRORED 159B ROLLBACK SQL
GRANT SELECT (
  phone, email, emergency_contact, emergency_phone,
  id_card_last_4, hourly_rate
) ON public.employees TO anon, authenticated;
-- END TEST-MIRRORED 159B ROLLBACK SQL
`;

let passed = 0;
let failed = 0;
function check(name, ok, detail = '') {
  ok ? passed++ : failed++;
  console.log(`  ${ok ? '✅' : '❌'} ${name}${detail ? ` → ${detail}` : ''}`);
}

(async () => {
  console.log('\n═══════════════════════════════════════');
  console.log('  員工欄位讀取授權第二階段（PGlite 實跑）');
  console.log('═══════════════════════════════════════');
  const db = new PGlite();
  const as = async (role, sql) => {
    try {
      await db.exec(`SET ROLE ${role}`);
      return { rows: (await db.query(sql)).rows };
    } catch (error) {
      return { error: error.message };
    } finally {
      await db.exec('RESET ROLE');
    }
  };
  const denied = result => /permission denied/i.test(result.error || '');

  await db.exec(`
    CREATE ROLE anon NOLOGIN;
    CREATE ROLE authenticated NOLOGIN;
    GRANT USAGE ON SCHEMA public TO anon, authenticated;
    CREATE TABLE public.employees (
      ${ALL_COLUMNS.map(column => `"${column}" text`).join(',\n      ')}
    );
    GRANT SELECT ON public.employees TO anon, authenticated;
  `);

  let prerequisiteError = '';
  try { await db.exec(APPLY_159B); } catch (error) { prerequisiteError = error.message; }
  check('158 未套用時 159b 前提檢查明確拒絕', /159b 前提失敗/.test(prerequisiteError), prerequisiteError);

  await db.exec(APPLY_158);
  await db.exec(APPLY_159B);
  const publicSelect = `SELECT ${PUBLIC_COLUMNS.map(column => `"${column}"`).join(',')} FROM public.employees LIMIT 1`;
  for (const role of ['anon', 'authenticated']) {
    check(`${role} 的 31 欄一般查詢成功`, (await as(role, publicSelect)).rows !== undefined);
    for (const column of [...SENSITIVE_COLUMNS, ...OTHER_COLUMNS]) {
      check(`${role} 的非一般欄位 ${column} 查詢被拒`,
        denied(await as(role, `SELECT "${column}" FROM public.employees LIMIT 1`)));
    }
    const privileges = (await db.query(`
      SELECT
        has_table_privilege('${role}', 'public.employees', 'SELECT') AS table_select,
        ${PUBLIC_COLUMNS.map(column => `has_column_privilege('${role}', 'public.employees', '${column}', 'SELECT')`).join(' AND ')} AS public_select,
        ${[...SENSITIVE_COLUMNS, ...OTHER_COLUMNS].map(column => `NOT has_column_privilege('${role}', 'public.employees', '${column}', 'SELECT')`).join(' AND ')} AS private_blocked
    `)).rows[0];
    check(`${role} 僅有 31 欄欄位級 SELECT`,
      privileges.table_select === false && privileges.public_select === true && privileges.private_blocked === true,
      JSON.stringify(privileges));
  }

  await db.exec(ROLLBACK_159B);
  const firstStageSelect = `SELECT ${FIRST_STAGE_COLUMNS.map(column => `"${column}"`).join(',')} FROM public.employees LIMIT 1`;
  for (const role of ['anon', 'authenticated']) {
    check(`回滾後 ${role} 的 37 欄查詢恢復`, (await as(role, firstStageSelect)).rows !== undefined);
    check(`回滾後 ${role} 仍無表級 SELECT`,
      (await db.query(`SELECT has_table_privilege('${role}', 'public.employees', 'SELECT') ok`)).rows[0].ok === false);
    for (const column of OTHER_COLUMNS) {
      check(`回滾後 ${role} 的原 6 個非前端欄位 ${column} 仍被拒`,
        denied(await as(role, `SELECT "${column}" FROM public.employees LIMIT 1`)));
    }
  }

  if (process.env.PRIVATE159B_DRILL_FILE) {
    const drillDb = new PGlite();
    await drillDb.exec(`
      CREATE ROLE anon NOLOGIN;
      CREATE ROLE authenticated NOLOGIN;
      GRANT USAGE ON SCHEMA public TO anon, authenticated;
      CREATE TABLE public.companies (
        id uuid PRIMARY KEY, name text, features jsonb, status text, industry text
      );
      CREATE TABLE public.employees (
        id uuid PRIMARY KEY, employee_number text, name text, department text, position text,
        join_date date, line_user_id text, id_last_four text, phone text, email text,
        check_in_lat numeric, check_in_lng numeric, max_distance_meters numeric,
        is_active boolean, is_bound boolean, bound_at timestamptz, created_at timestamptz,
        updated_at timestamptz, id_card_last_4 text, is_admin boolean, company_id uuid,
        role text, hire_date date, device_info jsonb, employment_type text, salary_type text,
        hourly_rate numeric, emergency_contact text, emergency_phone text, status text,
        resigned_date date, resign_reason text, resign_note text, verify_code text,
        shift_mode text, fixed_shift_start time, fixed_shift_end time, can_schedule boolean,
        no_checkin boolean, is_kiosk boolean, preferred_language text, gps_relaxed boolean,
        default_lunch text
      );
      GRANT SELECT ON public.employees, public.companies TO anon, authenticated;
    `);
    let drillError = '';
    try {
      await drillDb.exec(fs.readFileSync(process.env.PRIVATE159B_DRILL_FILE, 'utf8'));
    } catch (error) {
      drillError = error.message;
    }
    check('私有 159b drill 可在 43 欄最小 schema 完整實跑', drillError === '', drillError);
    for (const role of ['anon', 'authenticated']) {
      const baseline = (await drillDb.query(`SELECT has_table_privilege('${role}', 'public.employees', 'SELECT') ok`)).rows[0].ok;
      check(`私有 drill 最後 ROLLBACK 保留 ${role} 原表級 SELECT 基線`, baseline === true, String(baseline));
    }
    await drillDb.close();
  }

  console.log(`結果：✅ ${passed} 通過 ❌ ${failed} 失敗`);
  await db.close();
  process.exit(failed ? 1 : 0);
})().catch(error => {
  console.error(error);
  process.exit(1);
});
