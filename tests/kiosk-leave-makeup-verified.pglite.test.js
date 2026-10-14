// migration 151：公務機代送請假／補卡，共用正式員工自助規則（純本機 PGlite）
//
// 驗收重點：
//   1. 從 .codex/handoffs/kiosk_prod_reference.md 直接抽出正式庫函式原文，先跑基準。
//   2. 套 151 後重跑同一批成功／錯誤情境，JSON.stringify 結果與寫入列逐字相同。
//   3. verified RPC 只給 service_role；裝置、公司、在職狀態、pending 與稽核標記皆由 DB 保證。
//   4. internal 不可由 anon／authenticated／service_role 直接執行；rollback 精確還原函式 metadata。
//   5. MIGRATION151_EMPTY=1 是反向對照：新入口／共用 internal／安全測試必須失敗。
const fs = require('fs');
const path = require('path');
const { PGlite } = require('@electric-sql/pglite');

const root = path.join(__dirname, '..');
const read = file => fs.readFileSync(file, 'utf8');
const reference = read(path.join(root, '.codex', 'handoffs', 'kiosk_prod_reference.md'));
const migration = process.env.MIGRATION151_EMPTY === '1' ? '' : read(
  process.env.MIGRATION151_FILE || path.join(root, 'migrations', '151_kiosk_leave_makeup_verified.sql'));
const rollback = read(path.join(root, 'migrations', '151_kiosk_leave_makeup_verified_rollback.sql'));

function extractReferenceSql(heading) {
  const marker = `### ${heading}`;
  const start = reference.indexOf(marker);
  if (start < 0) throw new Error(`正式庫參考缺少 heading：${heading}`);
  const fence = reference.indexOf('```sql', start);
  const end = reference.indexOf('```', fence + 6);
  if (fence < 0 || end < 0) throw new Error(`正式庫參考缺少 SQL code block：${heading}`);
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
  noLine: '20000000-0000-0000-0000-000000000002',
  resigned: '20000000-0000-0000-0000-000000000003',
  cross: '20000000-0000-0000-0000-000000000004',
  kiosk: '20000000-0000-0000-0000-000000000005',
  multiA: '20000000-0000-0000-0000-000000000006',
  multiB: '20000000-0000-0000-0000-000000000007'
};
const FIXED_LEAVE = '30000000-0000-0000-0000-000000000001';
const FIXED_MAKEUP = '40000000-0000-0000-0000-000000000001';
const FORMAL = [
  'public.submit_leave_request(text,uuid,character varying,date,date,text,text,time without time zone,time without time zone)',
  'public.submit_leave_request(text,character varying,date,date,text,text,numeric)',
  'public.submit_makeup_punch(text,date,text,time without time zone,text,text,uuid)'
];

(async () => {
  console.log('\n═══════════════════════════════════════');
  console.log('  公務機請假／補卡 verified RPC（151，PGlite 實跑）');
  console.log('═══════════════════════════════════════');

  const db = new PGlite();
  const q = async (sql, params) => (await db.query(sql, params)).rows;
  const one = async (sql, params) => (await q(sql, params))[0];
  async function as(role, sql, params) {
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
  const rpc = async (role, sql, params = []) => {
    const result = await as(role, sql, params);
    return result.error ? { error: result.error } : result.rows[0].r;
  };
  const denied = result => /permission denied/.test(result?.error || '');

  await db.exec(`
    CREATE ROLE anon NOLOGIN;
    CREATE ROLE authenticated NOLOGIN;
    CREATE ROLE service_role NOLOGIN;
    CREATE ROLE prod_postgres NOLOGIN;
    GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
    GRANT USAGE, CREATE ON SCHEMA public TO prod_postgres;
    SET ROLE prod_postgres;

    CREATE TABLE public.employees (
      id uuid PRIMARY KEY,
      company_id uuid NOT NULL,
      line_user_id text,
      is_active boolean NOT NULL DEFAULT true,
      is_kiosk boolean NOT NULL DEFAULT false,
      created_at timestamptz DEFAULT now()
    );
    CREATE TABLE public.leave_requests (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      employee_id uuid NOT NULL REFERENCES public.employees(id),
      leave_type varchar NOT NULL,
      start_date date NOT NULL,
      end_date date NOT NULL,
      days numeric DEFAULT 1,
      reason text,
      attachment_url text,
      status varchar DEFAULT 'pending',
      approver_id uuid,
      approved_at timestamptz,
      rejection_reason text,
      created_at timestamptz DEFAULT now(),
      updated_at timestamptz DEFAULT now(),
      leave_period text NOT NULL DEFAULT 'full_day',
      leave_hours numeric,
      leave_start_time time,
      leave_end_time time
    );
    CREATE TABLE public.makeup_punch_requests (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      employee_id uuid NOT NULL REFERENCES public.employees(id),
      punch_date date NOT NULL,
      punch_type text NOT NULL,
      punch_time time NOT NULL,
      reason text,
      status text NOT NULL DEFAULT 'pending',
      rejection_reason text,
      approver_id uuid,
      approved_at timestamptz,
      created_at timestamptz DEFAULT now(),
      note text
    );
    CREATE TABLE public.attendance (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      employee_id uuid NOT NULL REFERENCES public.employees(id),
      date date NOT NULL,
      check_in_time timestamptz,
      check_out_time timestamptz
    );

    CREATE FUNCTION public.count_employee_workdays(p_employee_id uuid, p_start date, p_end date)
    RETURNS integer LANGUAGE sql STABLE SET search_path=public AS $$
      SELECT count(*)::integer
      FROM generate_series(p_start, p_end, interval '1 day') d
      WHERE extract(isodow FROM d) BETWEEN 1 AND 5
    $$;
    CREATE FUNCTION public.leave_overlap_message(p_conflict jsonb, p_prefix text)
    RETURNS text LANGUAGE sql STABLE AS $$
      SELECT p_prefix || '（' || (p_conflict->>'start_date') || '）'
    $$;

    ${formalSql}

    REVOKE ALL ON FUNCTION public.find_overlapping_leave(uuid,date,date,uuid,text[]) FROM PUBLIC, anon, authenticated;
    GRANT EXECUTE ON FUNCTION public.find_overlapping_leave(uuid,date,date,uuid,text[]) TO service_role;
    REVOKE ALL ON FUNCTION public.kiosk_resolve_verified(text) FROM PUBLIC, anon, authenticated;
    GRANT EXECUTE ON FUNCTION public.kiosk_resolve_verified(text) TO service_role;
    REVOKE ALL ON FUNCTION public.submit_leave_request(text,uuid,varchar,date,date,text,text,time,time) FROM PUBLIC, anon, authenticated, service_role;
    REVOKE ALL ON FUNCTION public.submit_leave_request(text,varchar,date,date,text,text,numeric) FROM PUBLIC, anon, authenticated, service_role;
    GRANT EXECUTE ON FUNCTION public.submit_leave_request(text,uuid,varchar,date,date,text,text,time,time) TO anon, authenticated, service_role;
    GRANT EXECUTE ON FUNCTION public.submit_leave_request(text,varchar,date,date,text,text,numeric) TO anon, authenticated, service_role;
    GRANT EXECUTE ON FUNCTION public.submit_makeup_punch(text,date,text,time,text,text,uuid) TO PUBLIC, anon, authenticated, service_role;

    INSERT INTO public.employees(id,company_id,line_user_id,is_active,is_kiosk,created_at) VALUES
      ('${E.user}','${A}','Uuser',true,false,'2026-01-01'),
      ('${E.noLine}','${A}',NULL,true,false,'2026-01-02'),
      ('${E.resigned}','${A}',NULL,false,false,'2026-01-03'),
      ('${E.cross}','${B}','Ucross',true,false,'2026-01-04'),
      ('${E.kiosk}','${A}','Ukiosk',true,true,'2026-01-05'),
      ('${E.multiA}','${A}','Umulti',true,false,'2026-01-06'),
      ('${E.multiB}','${B}','Umulti',true,false,'2026-01-07');
    RESET ROLE;
  `);

  const dates = await one(`SELECT
    (now() AT TIME ZONE 'Asia/Taipei')::date::text AS today,
    ((now() AT TIME ZONE 'Asia/Taipei')::date - 1)::text AS yesterday,
    ((now() AT TIME ZONE 'Asia/Taipei')::date - 7)::text AS too_old,
    ((now() AT TIME ZONE 'Asia/Taipei')::date + 1)::text AS tomorrow,
    ((now() AT TIME ZONE 'Asia/Taipei')::date + (8 - extract(isodow FROM (now() AT TIME ZONE 'Asia/Taipei')::date)::int))::text AS monday,
    ((now() AT TIME ZONE 'Asia/Taipei')::date + (15 - extract(isodow FROM (now() AT TIME ZONE 'Asia/Taipei')::date)::int))::text AS monday2,
    ((now() AT TIME ZONE 'Asia/Taipei')::date + (7 - extract(isodow FROM (now() AT TIME ZONE 'Asia/Taipei')::date)::int))::text AS sunday`);

  const formalMeta = async () => Promise.all(FORMAL.map(async f => one(`
    SELECT pg_get_function_arguments(p.oid) AS args,
           pg_get_function_result(p.oid) AS result,
           p.prosrc AS src,
           coalesce(p.proacl::text, '') AS acl,
           coalesce(p.proconfig::text, '') AS config,
           p.prosecdef AS secdef,
           p.provolatile AS volatility
    FROM pg_proc p WHERE p.oid=$1::regprocedure`, [f])));
  const beforeMeta = await formalMeta();

  async function clearRequests() {
    await db.exec(`SET ROLE prod_postgres;
      DELETE FROM public.attendance;
      DELETE FROM public.makeup_punch_requests;
      DELETE FROM public.leave_requests;
      RESET ROLE;`);
  }
  async function state() {
    return {
      leave: await q(`SELECT employee_id::text, leave_type, start_date::text, end_date::text, days::text,
          coalesce(reason,'<NULL>') reason, status, coalesce(approver_id::text,'<NULL>') approver_id,
          coalesce(to_char(approved_at,'YYYY-MM-DD HH24:MI:SSOF'),'<NULL>') approved_at,
          leave_period, coalesce(leave_hours::text,'<NULL>') leave_hours,
          coalesce(leave_start_time::text,'<NULL>') leave_start_time,
          coalesce(leave_end_time::text,'<NULL>') leave_end_time
        FROM public.leave_requests ORDER BY id`),
      makeup: await q(`SELECT employee_id::text, punch_date::text, punch_type, punch_time::text,
          coalesce(reason,'<NULL>') reason, coalesce(note,'<NULL>') note, status,
          coalesce(approver_id::text,'<NULL>') approver_id,
          coalesce(to_char(approved_at,'YYYY-MM-DD HH24:MI:SSOF'),'<NULL>') approved_at
        FROM public.makeup_punch_requests ORDER BY id`)
    };
  }

  const fullLeave = (line, company, start, end, period = 'full_day', from = null, to = null, reason = '原因') =>
    rpc('anon', `SELECT public.submit_leave_request($1::text,$2::uuid,$3::varchar,$4::date,$5::date,$6::text,$7::text,$8::time,$9::time) r`,
      [line, company, 'annual', start, end, reason, period, from, to]);
  const legacyLeave = (line, start, period = 'full_day') => rpc('authenticated',
    `SELECT public.submit_leave_request($1::text,$2::varchar,$3::date,$4::date,$5::text,$6::text,$7::numeric) r`,
    [line, 'personal', start, start, '舊版原因', period, null]);
  const makeup = (line, date, type, time, company = A, note = '原 note') => rpc('anon',
    `SELECT public.submit_makeup_punch($1::text,$2::date,$3::text,$4::time,$5::text,$6::text,$7::uuid) r`,
    [line, date, type, time, '補卡原因', note, company]);

  async function runFormalScenarios() {
    const out = {};
    async function capture(name, prepare, call) {
      await clearRequests();
      if (prepare) await prepare();
      const result = await call();
      out[name] = { result, state: await state() };
    }
    await capture('leave_full_success_null_reason', null,
      () => fullLeave('Uuser', A, dates.monday, dates.monday, 'full_day', null, null, null));
    await capture('leave_hourly_success', null,
      () => fullLeave('Uuser', A, dates.monday, dates.monday, 'hourly', '09:00', '11:30'));
    await capture('leave_missing_identity', null,
      () => fullLeave('', A, dates.monday, dates.monday));
    await capture('leave_wrong_company', null,
      () => fullLeave('Uuser', B, dates.monday, dates.monday));
    await capture('leave_bad_date', null,
      () => fullLeave('Uuser', A, dates.monday2, dates.monday));
    await capture('leave_bad_period', null,
      () => fullLeave('Uuser', A, dates.monday, dates.monday, 'night'));
    await capture('leave_half_multi_day', null,
      () => fullLeave('Uuser', A, dates.monday, dates.monday2, 'am'));
    await capture('leave_hourly_missing_time', null,
      () => fullLeave('Uuser', A, dates.monday, dates.monday, 'hourly', null, null));
    await capture('leave_hourly_reverse', null,
      () => fullLeave('Uuser', A, dates.monday, dates.monday, 'hourly', '11:00', '10:00'));
    await capture('leave_overlap', async () => db.exec(`SET ROLE prod_postgres;
      INSERT INTO leave_requests(id,employee_id,leave_type,start_date,end_date,days,reason,status,leave_period,created_at)
      VALUES('${FIXED_LEAVE}','${E.user}','annual','${dates.monday}','${dates.monday}',1,'既有','pending','full_day','2026-01-01');
      RESET ROLE;`), () => fullLeave('Uuser', A, dates.monday, dates.monday));
    await capture('leave_no_workday', null,
      () => fullLeave('Uuser', A, dates.sunday, dates.sunday));
    await capture('leave_legacy_success', null,
      () => legacyLeave('Uuser', dates.monday));
    await capture('leave_legacy_multi_company', null,
      () => legacyLeave('Umulti', dates.monday));
    await capture('leave_legacy_hourly', null,
      () => legacyLeave('Uuser', dates.monday, 'hourly'));

    await capture('makeup_success_normalizes_type', null,
      () => makeup('Uuser', dates.yesterday, 'check_in', '08:30'));
    await capture('makeup_invalid_type', null,
      () => makeup('Uuser', dates.yesterday, 'break', '12:00'));
    await capture('makeup_date_required', null,
      () => makeup('Uuser', null, 'clock_in', '08:30'));
    await capture('makeup_future_date', null,
      () => makeup('Uuser', dates.tomorrow, 'clock_in', '08:30'));
    await capture('makeup_out_of_window', null,
      () => makeup('Uuser', dates.too_old, 'clock_in', '08:30'));
    await capture('makeup_time_required', null,
      () => makeup('Uuser', dates.yesterday, 'clock_in', null));
    await capture('makeup_employee_not_found', null,
      () => makeup('Unknown', dates.yesterday, 'clock_in', '08:30'));
    await capture('makeup_checkout_before_checkin', async () => db.exec(`SET ROLE prod_postgres;
      INSERT INTO attendance(employee_id,date,check_in_time)
      VALUES('${E.user}','${dates.yesterday}', ('${dates.yesterday} 09:00'::timestamp AT TIME ZONE 'Asia/Taipei'));
      RESET ROLE;`), () => makeup('Uuser', dates.yesterday, 'clock_out', '08:59'));
    await capture('makeup_checkin_after_checkout', async () => db.exec(`SET ROLE prod_postgres;
      INSERT INTO attendance(employee_id,date,check_out_time)
      VALUES('${E.user}','${dates.yesterday}', ('${dates.yesterday} 17:00'::timestamp AT TIME ZONE 'Asia/Taipei'));
      RESET ROLE;`), () => makeup('Uuser', dates.yesterday, 'clock_in', '17:00'));
    await capture('makeup_duplicate', async () => db.exec(`SET ROLE prod_postgres;
      INSERT INTO makeup_punch_requests(id,employee_id,punch_date,punch_type,punch_time,reason,status,created_at)
      VALUES('${FIXED_MAKEUP}','${E.user}','${dates.yesterday}','clock_in','08:00','既有','approved','2026-01-01');
      RESET ROLE;`), () => makeup('Uuser', dates.yesterday, 'clock_in', '08:30'));
    return out;
  }

  console.log('\n=== 1. 正式庫原文基準 → 套 151 後逐字對照 ===');
  const baseline = await runFormalScenarios();
  let err = await apply(migration);
  check('151 可在 142／正式庫原文基線上套用', err === '', err);
  const after = await runFormalScenarios();
  const baselineText = JSON.stringify(baseline);
  const afterText = JSON.stringify(after);
  check('員工自助全部成功／錯誤 JSON 與寫入列逐字相同', afterText === baselineText,
    afterText === baselineText ? `${Object.keys(baseline).length} 情境` : 'before/after 不一致');

  const afterMeta = await formalMeta();
  const stableMeta = (m => ({ args: m.args, result: m.result, acl: m.acl, config: m.config,
    secdef: m.secdef, volatility: m.volatility }));
  const stableMetaEqual = JSON.stringify(afterMeta.map(stableMeta)) === JSON.stringify(beforeMeta.map(stableMeta));
  check('三支員工 RPC 的簽名／回傳／ACL／search_path／SECURITY DEFINER／volatility 不變',
    stableMetaEqual, stableMetaEqual ? '' : JSON.stringify({ before: beforeMeta.map(stableMeta), after: afterMeta.map(stableMeta) }));

  console.log('\n=== 2. ACL 與公務機身分邊界 ===');
  const leaveVerified = `SELECT public.kiosk_submit_leave_verified($1::text,$2::uuid,$3::varchar,$4::date,$5::date,$6::text,$7::text,$8::time,$9::time) r`;
  const makeupVerified = `SELECT public.kiosk_submit_makeup_verified($1::text,$2::uuid,$3::date,$4::text,$5::time,$6::text) r`;
  let r = await rpc('anon', leaveVerified, ['Ukiosk', E.noLine, 'annual', dates.monday, dates.monday, '公務機原因', 'full_day', null, null]);
  check('anon 不能直接呼叫公務機請假 RPC', denied(r), r.error);
  r = await rpc('authenticated', makeupVerified, ['Ukiosk', E.noLine, dates.yesterday, 'clock_in', '08:30', '公務機補卡']);
  check('authenticated 不能直接呼叫公務機補卡 RPC', denied(r), r.error);
  r = await rpc('service_role', leaveVerified, ['Uuser', E.noLine, 'annual', dates.monday, dates.monday, '原因', 'full_day', null, null]);
  check('service_role 但非公務機裝置仍被拒', r?.success === false && r.error_code === 'access_denied', JSON.stringify(r));

  const internals = [
    `SELECT public.submit_leave_request_internal('${E.noLine}','${A}','annual','${dates.monday}','${dates.monday}','x','full_day',NULL,NULL,NULL) r`,
    `SELECT public.submit_makeup_punch_internal(NULL,'${E.noLine}','${A}','${dates.yesterday}','clock_in','08:30','x',NULL,NULL) r`
  ];
  for (const role of ['anon', 'authenticated', 'service_role']) {
    const attempts = await Promise.all(internals.map(sql => rpc(role, sql)));
    check(`${role} 不能直接呼叫兩支 internal`, attempts.every(denied), attempts.map(x => x.error).join(' | '));
  }

  console.log('\n=== 3. 同公司／在職／pending／稽核／共用規則 ===');
  await clearRequests();
  r = await rpc('service_role', leaveVerified, ['Ukiosk', E.cross, 'annual', dates.monday, dates.monday, '跨公司', 'full_day', null, null]);
  check('跨公司員工請假被拒且零寫入', r?.success === false && /有效員工/.test(r.error)
    && (await one(`SELECT count(*)::int n FROM leave_requests`)).n === 0, JSON.stringify(r));
  r = await rpc('service_role', makeupVerified, ['Ukiosk', E.resigned, dates.yesterday, 'clock_in', '08:30', '離職']);
  check('離職員工補卡被拒且零寫入', r?.success === false && r.error === 'employee_not_found'
    && (await one(`SELECT count(*)::int n FROM makeup_punch_requests`)).n === 0, JSON.stringify(r));

  r = await rpc('service_role', leaveVerified, ['Ukiosk', E.noLine, 'annual', dates.monday, dates.monday, '家庭事務', 'full_day', null, null]);
  let row = await one(`SELECT employee_id::text, status, reason, approver_id, approved_at FROM leave_requests LIMIT 1`);
  check('未綁 LINE 的同公司在職員工可由公務機送請假', r?.success === true && row?.employee_id === E.noLine, JSON.stringify(r));
  check('公務機請假一律 pending、未核准、reason 有稽核前綴', row?.status === 'pending'
    && row.approver_id === null && row.approved_at === null && row.reason === '[公務機送出] 家庭事務', JSON.stringify(row));

  await clearRequests();
  r = await rpc('service_role', makeupVerified, ['Ukiosk', E.noLine, dates.yesterday, 'check_out', '18:00', '忘記打卡']);
  row = await one(`SELECT employee_id::text, status, punch_type, note, approver_id, approved_at FROM makeup_punch_requests LIMIT 1`);
  check('未綁 LINE 的同公司在職員工可由公務機送補卡，類型沿用正規化', r?.success === true
    && row?.employee_id === E.noLine && row.punch_type === 'clock_out', JSON.stringify(r));
  check('公務機補卡一律 pending、未核准、note 可辨識來源', row?.status === 'pending'
    && row.approver_id === null && row.approved_at === null && row.note === '[公務機送出]', JSON.stringify(row));

  await clearRequests();
  r = await rpc('service_role', makeupVerified, ['Ukiosk', E.noLine, dates.too_old, 'clock_in', '08:00', '逾期']);
  check('公務機補卡沿用 7 天限制', r?.success === false && r.code === 'punch_date_out_of_window'
    && r.window_days === 7 && (await one(`SELECT count(*)::int n FROM makeup_punch_requests`)).n === 0, JSON.stringify(r));

  await clearRequests();
  await db.exec(`SET ROLE prod_postgres;
    INSERT INTO attendance(employee_id,date,check_in_time)
    VALUES('${E.noLine}','${dates.yesterday}', ('${dates.yesterday} 09:00'::timestamp AT TIME ZONE 'Asia/Taipei'));
    RESET ROLE;`);
  r = await rpc('service_role', makeupVerified, ['Ukiosk', E.noLine, dates.yesterday, 'clock_out', '08:59', '時間誤填']);
  check('公務機補卡沿用上下班時間合理性檢查', r?.success === false && r.code === 'checkout_before_checkin'
    && (await one(`SELECT count(*)::int n FROM makeup_punch_requests`)).n === 0, JSON.stringify(r));

  await clearRequests();
  await db.exec(`SET ROLE prod_postgres;
    INSERT INTO leave_requests(id,employee_id,leave_type,start_date,end_date,days,reason,status,leave_period,created_at)
    VALUES('${FIXED_LEAVE}','${E.noLine}','annual','${dates.monday}','${dates.monday}',1,'既有','pending','full_day','2026-01-01');
    RESET ROLE;`);
  r = await rpc('service_role', leaveVerified, ['Ukiosk', E.noLine, 'annual', dates.monday, dates.monday, '重疊', 'full_day', null, null]);
  check('公務機請假沿用重疊拒絕與相同 error_code', r?.success === false && r.error_code === 'leave_overlap'
    && r.conflict?.id === FIXED_LEAVE && (await one(`SELECT count(*)::int n FROM leave_requests`)).n === 1, JSON.stringify(r));

  console.log('\n=== 4. 141 順序防呆、rollback 與重套 ===');
  err = await apply(rollback);
  check('151 rollback 可套用', err === '', err);
  const rolledMeta = await formalMeta();
  const rollbackMetaEqual = JSON.stringify(rolledMeta.map(stableMeta)) === JSON.stringify(beforeMeta.map(stableMeta));
  check('rollback 後三支正式 RPC 簽名／回傳／ACL／search_path／安全屬性逐項還原',
    rollbackMetaEqual, rollbackMetaEqual ? '' : JSON.stringify({ before: beforeMeta.map(stableMeta), after: rolledMeta.map(stableMeta) }));
  const rollbackBehavior = await runFormalScenarios();
  check('rollback 後同一批員工自助結果與正式庫原文基準逐字相同',
    JSON.stringify(rollbackBehavior) === baselineText, `${Object.keys(rollbackBehavior).length} 情境`);
  check('rollback 後 verified／internal 全移除', !(await one(`SELECT 1 x FROM pg_proc
    WHERE pronamespace='public'::regnamespace AND proname IN
      ('kiosk_submit_leave_verified','kiosk_submit_makeup_verified','submit_leave_request_internal','submit_makeup_punch_internal') LIMIT 1`)));

  const publicSrcBeforeGuard = (await formalMeta()).map(x => x.src).join('\n');
  await apply(`CREATE FUNCTION public.submit_leave_request_impl() RETURNS jsonb LANGUAGE sql AS $$ SELECT '{}'::jsonb $$;`);
  err = await apply(migration);
  check('141 已先套（偵測到 *_impl）時 151 明確中止', /141/.test(err) && /wrapper/.test(err), err);
  check('141 防呆中止不會覆蓋既有 public RPC', (await formalMeta()).map(x => x.src).join('\n') === publicSrcBeforeGuard);
  await apply(`DROP FUNCTION public.submit_leave_request_impl();`);

  err = await apply(migration);
  check('rollback 後可重套 151', err === '', err);
  r = await rpc('service_role', leaveVerified, ['Ukiosk', E.noLine, 'annual', dates.monday2, dates.monday2, '重套', 'full_day', null, null]);
  check('重套後 verified 請假仍可用且只建 pending', r?.success === true
    && (await one(`SELECT status FROM leave_requests WHERE reason='[公務機送出] 重套'`))?.status === 'pending', JSON.stringify(r));

  console.log(`\n結果：${pass} 通過、${fail} 失敗`);
  await db.close();
  process.exitCode = fail ? 1 : 0;
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
