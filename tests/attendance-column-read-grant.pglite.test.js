#!/usr/bin/env node
// 權限收緊前置：以本機 PGlite 驗證 attendance 明確欄位與回滾。
const fs = require('fs');
const { PGlite } = require('@electric-sql/pglite');

const ALLOWED = [
  'id', 'employee_id', 'date', 'check_in_time', 'check_out_time',
  'check_in_location', 'check_out_location', 'total_work_hours', 'is_late',
  'notes', 'schedule_id', 'shift_type_id', 'overtime_hours', 'is_manual',
  'late_minutes', 'status', 'is_early_leave', 'checkout_latitude', 'checkout_longitude'
];
const HIDDEN = ['photo_url', 'device_info', 'created_at', 'updated_at', 'latitude', 'longitude', 'device_id', 'is_holiday_work'];
const ALL = [
  'id', 'employee_id', 'date', 'check_in_time', 'check_out_time', 'photo_url',
  'check_in_location', 'check_out_location', 'device_info', 'total_work_hours',
  'is_late', 'created_at', 'updated_at', 'notes', 'latitude', 'longitude',
  'device_id', 'schedule_id', 'shift_type_id', 'overtime_hours', 'is_holiday_work',
  'is_manual', 'late_minutes', 'status', 'is_early_leave', 'checkout_latitude', 'checkout_longitude'
];
const APPLY = process.env.PRIVATE160_APPLY_FILE ? fs.readFileSync(process.env.PRIVATE160_APPLY_FILE, 'utf8') : `
REVOKE SELECT ON TABLE public.attendance FROM anon, authenticated;
GRANT SELECT (${ALLOWED.join(',')}) ON public.attendance TO anon, authenticated;`;
const ROLLBACK = process.env.PRIVATE160_ROLLBACK_FILE ? fs.readFileSync(process.env.PRIVATE160_ROLLBACK_FILE, 'utf8') : `
REVOKE SELECT (${ALLOWED.join(',')}) ON public.attendance FROM anon, authenticated;
GRANT SELECT ON TABLE public.attendance TO anon, authenticated;`;

let passed = 0;
let failed = 0;
function check(name, ok, detail = '') {
  ok ? passed++ : failed++;
  console.log(`  ${ok ? '✅' : '❌'} ${name}${detail ? ` → ${detail}` : ''}`);
}
async function setup(db, drill = false) {
  await db.exec(`
    CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN;
    GRANT USAGE ON SCHEMA public TO anon, authenticated;
    CREATE TABLE public.attendance (${ALL.map(c => `"${c}" text`).join(',')});
    GRANT SELECT ON public.attendance TO anon, authenticated;
    ${drill ? `CREATE TABLE public.employees (id text, company_id text, name text, employee_number text, department text, is_active text, no_checkin text, is_kiosk text);
      CREATE TABLE public.shift_types (id text, is_overnight text);
      GRANT SELECT ON public.employees, public.shift_types TO anon, authenticated;` : ''}
  `);
}
async function as(db, role, sql) {
  try { await db.exec(`SET ROLE ${role}`); return { rows: (await db.query(sql)).rows }; }
  catch (error) { return { error: error.message }; }
  finally { await db.exec('RESET ROLE'); }
}

(async () => {
  console.log('\n═══════════════════════════════════════');
  console.log('  出勤欄位讀取授權（PGlite 實跑）');
  console.log('═══════════════════════════════════════');
  const db = new PGlite();
  await setup(db);
  await db.exec(APPLY);
  const explicit = `SELECT ${ALLOWED.map(c => `"${c}"`).join(',')} FROM public.attendance LIMIT 1`;
  const denied = result => /permission denied/i.test(result.error || '');
  for (const role of ['anon', 'authenticated']) {
    check(`${role} 的 19 欄明確查詢成功`, (await as(db, role, explicit)).rows !== undefined);
    check(`${role} 的 SELECT * 被拒`, denied(await as(db, role, 'SELECT * FROM public.attendance LIMIT 1')));
    for (const column of HIDDEN) check(`${role} 的 ${column} 被拒`, denied(await as(db, role, `SELECT "${column}" FROM public.attendance LIMIT 1`)));
    const p = (await db.query(`SELECT has_table_privilege('${role}','public.attendance','SELECT') table_select,
      ${ALLOWED.map(c => `has_column_privilege('${role}','public.attendance','${c}','SELECT')`).join(' AND ')} allowed,
      ${HIDDEN.map(c => `NOT has_column_privilege('${role}','public.attendance','${c}','SELECT')`).join(' AND ')} hidden`)).rows[0];
    check(`${role} 僅有 19 欄欄位級 SELECT`, !p.table_select && p.allowed && p.hidden, JSON.stringify(p));
  }
  await db.exec(ROLLBACK);
  for (const role of ['anon', 'authenticated']) {
    check(`回滾後 ${role} 表級 SELECT 恢復`, (await as(db, role, 'SELECT * FROM public.attendance LIMIT 1')).rows !== undefined);
  }
  await db.close();

  if (process.env.PRIVATE160_DRILL_FILE) {
    const drillDb = new PGlite();
    await setup(drillDb, true);
    let error = '';
    try { await drillDb.exec(fs.readFileSync(process.env.PRIVATE160_DRILL_FILE, 'utf8')); }
    catch (e) { error = e.message; }
    check('私有 160 drill 完整實跑', error === '', error);
    check('私有 drill 最後 ROLLBACK 保留 anon 表級 SELECT',
      (await drillDb.query(`SELECT has_table_privilege('anon','public.attendance','SELECT') ok`)).rows[0].ok === true);
    await drillDb.close();
  }
  console.log(`結果：✅ ${passed} 通過 ❌ ${failed} 失敗`);
  process.exitCode = failed ? 1 : 0;
})().catch(error => { console.error(error); process.exitCode = 1; });
