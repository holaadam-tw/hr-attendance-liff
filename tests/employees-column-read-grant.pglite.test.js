#!/usr/bin/env node
// 欄位授權 SQL 內嵌於測試，必須與私有 158 migration 的同名標記區塊一致。
const { PGlite } = require('@electric-sql/pglite');

const ALLOWED_COLUMNS = [
  'id', 'employee_number', 'name', 'department', 'position', 'join_date',
  'line_user_id', 'phone', 'email', 'is_active', 'is_bound', 'bound_at',
  'created_at', 'updated_at', 'id_card_last_4', 'is_admin', 'company_id',
  'role', 'hire_date', 'employment_type', 'salary_type', 'hourly_rate',
  'emergency_contact', 'emergency_phone', 'status', 'resigned_date',
  'resign_reason', 'resign_note', 'shift_mode', 'fixed_shift_start',
  'fixed_shift_end', 'can_schedule', 'no_checkin', 'is_kiosk',
  'preferred_language', 'gps_relaxed', 'default_lunch'
];
const OTHER_COLUMNS = [
  'verify_code', 'id_last_four', 'device_info',
  'check_in_lat', 'check_in_lng', 'max_distance_meters'
];

const APPLY_SQL = String.raw`
-- BEGIN TEST-MIRRORED APPLY SQL
REVOKE SELECT ON public.employees FROM anon, authenticated;
GRANT SELECT (
  id, employee_number, name, department, position, join_date,
  line_user_id, phone, email, is_active, is_bound, bound_at,
  created_at, updated_at, id_card_last_4, is_admin, company_id, role,
  hire_date, employment_type, salary_type, hourly_rate, emergency_contact,
  emergency_phone, status, resigned_date, resign_reason, resign_note,
  shift_mode, fixed_shift_start, fixed_shift_end, can_schedule, no_checkin,
  is_kiosk, preferred_language, gps_relaxed, default_lunch
) ON public.employees TO anon, authenticated;
-- END TEST-MIRRORED APPLY SQL
`;

const ROLLBACK_SQL = String.raw`
-- BEGIN TEST-MIRRORED ROLLBACK SQL
REVOKE SELECT (
  id, employee_number, name, department, position, join_date,
  line_user_id, phone, email, is_active, is_bound, bound_at,
  created_at, updated_at, id_card_last_4, is_admin, company_id, role,
  hire_date, employment_type, salary_type, hourly_rate, emergency_contact,
  emergency_phone, status, resigned_date, resign_reason, resign_note,
  shift_mode, fixed_shift_start, fixed_shift_end, can_schedule, no_checkin,
  is_kiosk, preferred_language, gps_relaxed, default_lunch
) ON public.employees FROM anon, authenticated;
GRANT SELECT ON public.employees TO anon, authenticated;
-- END TEST-MIRRORED ROLLBACK SQL
`;

let passed = 0;
let failed = 0;
function check(name, ok, detail = '') {
  ok ? passed++ : failed++;
  console.log(`  ${ok ? '✅' : '❌'} ${name}${detail ? ` → ${detail}` : ''}`);
}

(async () => {
  console.log('\n═══════════════════════════════════════');
  console.log('  員工欄位讀取授權（PGlite 實跑）');
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
  const allColumns = [...ALLOWED_COLUMNS, ...OTHER_COLUMNS];

  await db.exec(`
    CREATE ROLE anon NOLOGIN;
    CREATE ROLE authenticated NOLOGIN;
    GRANT USAGE ON SCHEMA public TO anon, authenticated;
    CREATE TABLE public.employees (
      ${allColumns.map(column => `"${column}" text`).join(',\n      ')}
    );
    GRANT SELECT ON public.employees TO anon, authenticated;
  `);

  for (const role of ['anon', 'authenticated']) {
    check(`基線：${role} 表級查詢可用`, (await as(role, 'SELECT * FROM public.employees LIMIT 1')).rows !== undefined);
  }

  await db.exec(APPLY_SQL);
  const explicitSelect = `SELECT ${ALLOWED_COLUMNS.map(column => `"${column}"`).join(',')} FROM public.employees LIMIT 1`;
  for (const role of ['anon', 'authenticated']) {
    check(`${role} 的 37 欄明確查詢成功`, (await as(role, explicitSelect)).rows !== undefined);
    check(`${role} 的 SELECT * 受到欄位清單限制`, denied(await as(role, 'SELECT * FROM public.employees LIMIT 1')));
    for (const column of OTHER_COLUMNS) {
      check(`${role} 的非清單欄位 ${column} 查詢被拒`,
        denied(await as(role, `SELECT "${column}" FROM public.employees LIMIT 1`)));
    }
    const privileges = (await db.query(`
      SELECT
        has_table_privilege('${role}', 'public.employees', 'SELECT') AS table_select,
        ${ALLOWED_COLUMNS.map(column => `has_column_privilege('${role}', 'public.employees', '${column}', 'SELECT')`).join(' AND ')} AS allowed_select,
        ${OTHER_COLUMNS.map(column => `NOT has_column_privilege('${role}', 'public.employees', '${column}', 'SELECT')`).join(' AND ')} AS other_blocked
    `)).rows[0];
    check(`${role} 僅有欄位級 SELECT`,
      privileges.table_select === false && privileges.allowed_select === true && privileges.other_blocked === true,
      JSON.stringify(privileges));
  }

  await db.exec(ROLLBACK_SQL);
  for (const role of ['anon', 'authenticated']) {
    check(`回滾後 ${role} 的表級查詢恢復`,
      (await as(role, 'SELECT * FROM public.employees LIMIT 1')).rows !== undefined);
    check(`回滾後 ${role} 的表級 SELECT 恢復`,
      (await db.query(`SELECT has_table_privilege('${role}', 'public.employees', 'SELECT') ok`)).rows[0].ok === true);
  }

  console.log(`結果：✅ ${passed} 通過 ❌ ${failed} 失敗`);
  await db.close();
  process.exit(failed ? 1 : 0);
})().catch(error => {
  console.error(error);
  process.exit(1);
});
