// ============================================================
// migration 125 LINE 推播減量 — 真的在 PostgreSQL（PGlite）裡跑的回歸測試
//
// 不連線、不寫正式庫。流程：
//   1. 載入 tests/fixtures/line_push_base_schema.sql（最小表結構＋正式庫原文函式）
//   2. 先用「舊函式」重現 bug（缺時被套成補卡文字、群組兩則彙總）
//   3. 套 125 → 逐情境驗證（工作日、提醒次數、失敗不算已通知、預算閘門、合併彙總、#待辦、權限、排程）
//   4. 套 125 回滾 → 舊行為與排程恢復 → 再套一次 125（可重複套用）
// 反向對照：MIGRATION125_FILE 環境變數可指向改壞的副本。
// ============================================================
const fs = require('fs');
const path = require('path');
const { PGlite } = require('@electric-sql/pglite');

const root = path.join(__dirname, '..');
const baseSql = fs.readFileSync(path.join(__dirname, 'fixtures', 'line_push_base_schema.sql'), 'utf8');
const m125 = fs.readFileSync(process.env.MIGRATION125_FILE || path.join(root, 'migrations', '125_line_push_budget_and_digest.sql'), 'utf8');
const m125rb = fs.readFileSync(path.join(root, 'migrations', '125_line_push_budget_and_digest_rollback.sql'), 'utf8');

let pass = 0, fail = 0;
function check(name, condition, detail = '') {
  if (condition) { pass++; console.log(`  ✅ ${name}${detail ? `  → ${detail}` : ''}`); }
  else { fail++; console.log(`  ❌ ${name}${detail ? `  → ${detail}` : ''}`); }
}

const C = '8a669e2c-7521-43e9-9300-5c004c57e9db';
const E = {
  admin: '00000000-0000-0000-0000-0000000000a1',
  e1: '00000000-0000-0000-0000-0000000000e1',
  e2: '00000000-0000-0000-0000-0000000000e2',
  e3: '00000000-0000-0000-0000-0000000000e3',
  vi: '00000000-0000-0000-0000-0000000000e4',
};
const at = (date, time = '09:10') => `${date} ${time}:00+08`;

(async () => {
  console.log('\n═══════════════════════════════════════');
  console.log('  LINE 推播減量（migration 125，PGlite 實跑）');
  console.log('═══════════════════════════════════════');

  const db = new PGlite();
  const q = async (sql, params) => (await db.query(sql, params)).rows;
  const one = async (sql, params) => (await q(sql, params))[0];
  await db.exec(baseSql);

  async function seed() {
    await db.exec(`
      DO $$ BEGIN IF to_regclass('public.line_push_log') IS NOT NULL THEN TRUNCATE public.line_push_log; END IF; END $$;
      TRUNCATE public.attendance_anomalies, public.leave_requests, public.makeup_punch_requests,
               public.overtime_requests, public.shift_swap_requests, public.requests, public.attendance,
               public.holidays, public.system_settings, net.http_request_queue, net._http_response CASCADE;
      DELETE FROM public.employees; DELETE FROM public.companies;
      INSERT INTO public.companies (id, name) VALUES ('${C}', '大正科技');
      INSERT INTO public.employees (id, company_id, employee_number, name, line_user_id, role) VALUES
        ('${E.admin}', '${C}', 'A01', '主管甲', 'Uadmin', 'admin'),
        ('${E.e1}', '${C}', 'E01', '員工一', 'U1', 'user'),
        ('${E.e2}', '${C}', 'E02', '員工二', 'U2', 'user'),
        ('${E.e3}', '${C}', 'E03', '員工三', 'U3', 'user');
      INSERT INTO public.employees (id, company_id, employee_number, name, line_user_id, role, preferred_language) VALUES
        ('${E.vi}', '${C}', 'E04', 'Nguyen', 'U4', 'user', 'vi-VN');
      INSERT INTO public.system_settings (company_id, key, value) VALUES
        ('${C}', 'line_messaging_api', '{"token":"test-token","groupId":"Cgroup"}'),
        ('${C}', 'attendance_audit_enabled', 'true'),
        ('${C}', 'missing_work_hours_line_notifications_enabled', 'true');
      INSERT INTO public.holidays (company_id, holiday_date, holiday_name) VALUES
        ('${C}', '2026-10-09', '國慶日補假'), ('${C}', '2026-10-10', '國慶日');
    `);
  }
  const pushes = () => q(`SELECT id, body->>'to' AS "to", body->'messages'->0->>'text' AS text FROM net.http_request_queue ORDER BY id`);
  const respond = async (id, status, content = '') =>
    db.query(`INSERT INTO net._http_response (id, status_code, content, timed_out) VALUES ($1, $2, $3, false)`, [id, status, content]);

  // ---------- 1. 舊函式重現 bug ----------
  console.log('\n=== 套用前：重現正式庫行為 ===');
  await seed();
  await db.exec(`INSERT INTO cron.job (jobname, schedule, command) VALUES
    ('daily-attendance-audit', '10 1 * * *', ' SELECT run_daily_attendance_audit(); '),
    ('daily-missing-work-hours-audit', '15 1 * * *', ' SELECT public.run_daily_missing_work_hours_audit(); ')`);
  await db.exec(`INSERT INTO public.attendance_anomalies (company_id, employee_id, date, anomaly_type, details) VALUES
    ('${C}', '${E.e1}', '2026-08-28', 'missing_work_hours', '{"missing_minutes":90}'),
    ('${C}', '${E.e2}', '2026-08-10', 'missing_checkout', '{}')`);
  await q(`SELECT public.run_daily_attendance_audit()`);
  await q(`SELECT public.run_daily_missing_work_hours_audit()`);
  let p = await pushes();
  const oldE1 = p.filter(x => x.to === 'U1');
  check('舊版：缺時員工收到的是「下班補卡提醒」（錯字卡）', oldE1.length === 1 && /下班補卡提醒/.test(oldE1[0].text), oldE1.map(x => x.text.split('\n')[0]).join('|'));
  check('舊版：主管群組一天兩則彙總', p.filter(x => x.to === 'Cgroup').length === 2, String(p.filter(x => x.to === 'Cgroup').length));
  await db.exec(`INSERT INTO net._http_response (id, status_code) SELECT id, 429 FROM net.http_request_queue`);
  const oldCount = await one(`SELECT notify_count FROM public.attendance_anomalies WHERE employee_id = '${E.e2}'`);
  check('舊版：LINE 回 429 仍然 notify_count + 1（問題重現）', oldCount.notify_count === 1);

  // ---------- 2. 套 125 ----------
  console.log('\n=== 套用 125 ===');
  let applied = true;
  try { await db.exec(m125); } catch (e) { applied = false; check('125 可在 PostgreSQL 套用', false, e.message); }
  if (!applied) return finish();
  check('125 可在 PostgreSQL 套用', true);
  const jobs = (await q(`SELECT jobname, schedule FROM cron.job ORDER BY jobname`)).map(j => `${j.jobname}@${j.schedule}`);
  check('排程：09:10 保留、09:15 移除、新增每 10 分鐘回填', JSON.stringify(jobs) === JSON.stringify(['daily-attendance-audit@10 1 * * *', 'line-push-reconcile@*/10 * * * *']), jobs.join(', '));

  // ---------- 3. 工作日判斷 ----------
  console.log('\n=== 工作日判斷 ===');
  await seed();
  const wd = async d => (await one(`SELECT public.line_is_workday('${C}', '${d}') AS w`)).w;
  check('週五 10/02 = 工作日', await wd('2026-10-02') === true);
  check('週六 10/03 = 非工作日（預設週一到週五）', await wd('2026-10-03') === false);
  check('週五 10/09 公司假日 = 非工作日', await wd('2026-10-09') === false);
  await db.exec(`INSERT INTO public.attendance (employee_id, date, check_in_time) VALUES
    ('${E.e1}', '2026-10-03', '2026-10-03 07:55+08'), ('${E.e2}', '2026-10-03', '2026-10-03 07:58+08'), ('${E.e3}', '2026-10-03', '2026-10-03 08:00+08')`);
  check('週六有 3 人打上班卡（補班日）= 工作日', await wd('2026-10-03') === true);
  await db.exec(`DELETE FROM public.attendance`);
  await db.exec(`INSERT INTO public.system_settings (company_id, key, value) VALUES ('${C}', 'line_notify_work_weekdays', '[1,2,3,4,5,6]')`);
  check('設定改週一到週六 → 週六 = 工作日', await wd('2026-10-03') === true);
  await db.exec(`DELETE FROM public.system_settings WHERE key = 'line_notify_work_weekdays'`);
  const age = async (from, today) => (await one(`SELECT public.line_workday_age('${C}', '${from}', '${today}') AS a`)).a;
  check('10/01 異常：10/02 第 1 工作天、10/05 第 2、10/06 第 3', await age('2026-10-01', '2026-10-02') === 1 && await age('2026-10-01', '2026-10-05') === 2 && await age('2026-10-01', '2026-10-06') === 3);
  check('跨假日：10/08 異常到 10/12 只算 1 個工作天（10/09、10/10 假日＋週末）', await age('2026-10-08', '2026-10-12') === 1);

  // ---------- 4. 提醒節奏與失敗處理 ----------
  console.log('\n=== 員工提醒：第 1、3 工作天，失敗不算已通知 ===');
  await seed();
  await db.exec(`INSERT INTO public.attendance_anomalies (id, company_id, employee_id, date, anomaly_type, details) VALUES
    ('10000000-0000-0000-0000-000000000001', '${C}', '${E.e1}', '2026-10-01', 'missing_work_hours', '{"missing_minutes":90}'),
    ('10000000-0000-0000-0000-000000000002', '${C}', '${E.e2}', '2026-10-01', 'missing_checkout', '{}'),
    ('10000000-0000-0000-0000-000000000003', '${C}', '${E.e3}', '2026-10-01', 'missing_checkout', '{}'),
    ('10000000-0000-0000-0000-000000000004', '${C}', '${E.vi}', '2026-08-10', 'missing_checkout', '{}')`);
  await db.exec(`UPDATE public.attendance_anomalies SET notify_count = 47 WHERE employee_id = '${E.vi}'`);
  await db.exec(`INSERT INTO public.makeup_punch_requests (employee_id, punch_date, punch_type, status) VALUES ('${E.e3}', '2026-10-01', 'clock_out', 'pending')`);
  await db.exec(`INSERT INTO public.leave_requests (employee_id, leave_type, start_date, end_date, status, created_at) VALUES ('${E.e2}', 'annual', '2026-10-20', '2026-10-20', 'pending', '2026-09-30 10:00+08')`);
  await db.exec(`INSERT INTO public.makeup_punch_requests (employee_id, punch_date, punch_type, status, note) VALUES ('${E.e1}', '2026-10-02', 'clock_in', 'pending', '{"review_type":"low_accuracy_gps"}')`);

  let r = (await one(`SELECT public.line_daily_notify($1) AS r`, [at('2026-10-02')])).r;
  p = await pushes();
  const toU1 = p.filter(x => x.to === 'U1'), toU2 = p.filter(x => x.to === 'U2'), toU3 = p.filter(x => x.to === 'U3'), toU4 = p.filter(x => x.to === 'U4');
  const summary1 = p.filter(x => x.to === 'Cgroup');
  check('第 1 工作天：缺時員工收到「應上班時數不足」而不是補卡文字', toU1.length === 1 && /應上班時數不足提醒/.test(toU1[0].text) && !/下班補卡/.test(toU1[0].text));
  check('第 1 工作天：缺下班卡員工收到補卡提醒', toU2.length === 1 && /下班補卡提醒/.test(toU2[0].text) && /未處理會再提醒一次/.test(toU2[0].text));
  check('已送補卡申請待審的員工不再提醒', toU3.length === 0);
  check('舊異常（已提醒 47 次）不再提醒，只留在彙總', toU4.length === 0);
  check('主管只收一則合併彙總', summary1.length === 1, String(summary1.length));
  const s1 = summary1[0] ? summary1[0].text : '';
  check('彙總含缺時／缺卡／待審核（含 GPS 待核認與最早一筆）', /缺 90 分/.test(s1) && /員工二 下班未打卡/.test(s1) && /員工三 下班未打卡（已送申請待審）/.test(s1) && /請假 1 件（最早：員工二 10\/20）/.test(s1) && /GPS 待核認 1 件/.test(s1), s1.replace(/\n/g, ' ⏎ ').slice(0, 400));
  check('彙總列出 8/10 舊案並標出工作天數', /08\/10 Nguyen 下班未打卡（第 \d+ 工作天）/.test(s1));
  let logs = await q(`SELECT category, recipient_kind, billed_estimate, status FROM public.line_push_log ORDER BY id`);
  check('推播紀錄 3 筆 reserved，群組計費估 4、個人 1', logs.length === 3 && logs.every(l => l.status === 'reserved') && logs.find(l => l.recipient_kind === 'group').billed_estimate === 4, JSON.stringify(logs));

  // LINE 回應：U1 200、U2 429、群組 200
  for (const x of p) await respond(x.id, x.to === 'U2' ? 429 : 200, x.to === 'U2' ? '{"message":"You have reached your monthly limit."}' : '{}');
  await q(`SELECT public.reconcile_line_push_log()`);
  const nc = async emp => (await one(`SELECT notify_count, notified_at FROM public.attendance_anomalies WHERE employee_id = '${emp}' AND date = '2026-10-01'`));
  check('LINE 200 → notify_count = 1', (await nc(E.e1)).notify_count === 1);
  const e2state = await nc(E.e2);
  check('LINE 429 → notify_count 仍是 0、notified_at 不寫', e2state.notify_count === 0 && e2state.notified_at === null);
  const failed = await one(`SELECT status, http_status, error FROM public.line_push_log WHERE recipient_ref = '${E.e2}'`);
  check('429 寫進推播紀錄（failed＋錯誤訊息）', failed.status === 'failed' && failed.http_status === 429 && /monthly limit/.test(failed.error));
  check('失敗不計入本月用量（只算 1 + 4）', (await one(`SELECT public.line_push_usage('${C}', $1) AS u`, [at('2026-10-02')])).u === 5);

  await q(`SELECT public.line_daily_notify($1)`, [at('2026-10-02', '15:00')]);
  check('同一天重跑不重發（彙總與提醒都不重複）', (await pushes()).length === 3);
  await q(`SELECT public.line_daily_notify($1)`, [at('2026-10-03')]);
  await q(`SELECT public.line_daily_notify($1)`, [at('2026-10-04')]);
  check('週六、週日完全不發', (await pushes()).length === 3);

  await q(`SELECT public.line_daily_notify($1)`, [at('2026-10-05')]);
  p = (await pushes()).slice(3);
  check('10/05（第 2 工作天）：只重試上次失敗的 U2，U1 不發', p.filter(x => x.to === 'U2').length === 1 && p.filter(x => x.to === 'U1').length === 0, p.map(x => x.to).join(','));
  const s2 = p.find(x => x.to === 'Cgroup');
  check('10/05 彙總提示上次有推播沒送出（HTTP 429）', s2 && /有 1 則推播沒送出（HTTP 429）/.test(s2.text), s2 ? s2.text.slice(-200).replace(/\n/g, ' ⏎ ') : 'no summary');
  for (const x of p) await respond(x.id, 200);
  await q(`SELECT public.reconcile_line_push_log()`);

  await q(`SELECT public.line_daily_notify($1)`, [at('2026-10-06')]);
  p = (await pushes()).slice(5);
  const u1Last = p.find(x => x.to === 'U1');
  check('10/06（第 3 工作天）：U1 收第二次也是最後一次提醒', u1Last && /最後一次提醒/.test(u1Last.text));
  const s3 = p.find(x => x.to === 'Cgroup');
  check('同一筆失敗只報一次：10/06 彙總不再提 429', s3 && !/推播沒送出/.test(s3.text));
  check('10/06：U2 昨天（10/05）才補發，未滿 2 個工作天不再發（不連兩天轟炸）', p.filter(x => x.to === 'U2').length === 0);
  for (const x of p) await respond(x.id, 200);
  await q(`SELECT public.reconcile_line_push_log()`);
  await q(`SELECT public.line_daily_notify($1)`, [at('2026-10-07')]);
  p = (await pushes()).slice(-2);
  const u2Last = p.find(x => x.to === 'U2');
  check('10/07：U2 距上次滿 2 個工作天，發第二次也是最後一次', u2Last && /最後一次提醒/.test(u2Last.text));
  for (const x of p) await respond(x.id, 200);
  await q(`SELECT public.reconcile_line_push_log()`);
  await q(`SELECT public.line_daily_notify($1)`, [at('2026-10-08')]);
  const all = await pushes();
  check('之後不再提醒員工：U1 共 2 次、U2 共 3 次（其中 1 次 429 失敗後重試）', all.filter(x => x.to === 'U1').length === 2 && all.filter(x => x.to === 'U2').length === 3, `U1=${all.filter(x => x.to === 'U1').length} U2=${all.filter(x => x.to === 'U2').length}`);
  check('U2 實際送達（2xx）只算 2 次', (await one(`SELECT notify_count FROM public.attendance_anomalies WHERE employee_id = '${E.e2}' AND date = '2026-10-01'`)).notify_count === 2);
  check('10/07、10/08 仍各有一則主管彙總', all.filter(x => x.to === 'Cgroup').length === 5, String(all.filter(x => x.to === 'Cgroup').length));

  // ---------- 4b. 彙總本身失敗 → 失敗要在下一則成功的彙總報出來 ----------
  console.log('\n=== 彙總本身 429：下次再報，報過一次就不重複 ===');
  await seed();
  await db.exec(`INSERT INTO public.attendance_anomalies (company_id, employee_id, date, anomaly_type) VALUES ('${C}', '${E.e2}', '2026-10-01', 'missing_checkout')`);
  await q(`SELECT public.line_daily_notify($1)`, [at('2026-10-02')]);
  for (const x of await pushes()) await respond(x.id, 429, '{"message":"You have reached your monthly limit."}');
  await q(`SELECT public.reconcile_line_push_log()`);
  await q(`SELECT public.line_daily_notify($1)`, [at('2026-10-05')]);
  let sp = (await pushes()).filter(x => x.to === 'Cgroup');
  check('10/05 彙總報出 10/02 兩則 429（含彙總本身）', sp.length === 2 && /有 2 則推播沒送出（HTTP 429）/.test(sp[1].text), sp[1] ? sp[1].text.slice(-160).replace(/\n/g, ' ⏎ ') : '');
  for (const x of (await pushes()).slice(2)) await respond(x.id, 429);
  await q(`SELECT public.reconcile_line_push_log()`);
  await q(`SELECT public.line_daily_notify($1)`, [at('2026-10-06')]);
  sp = (await pushes()).filter(x => x.to === 'Cgroup');
  check('10/05 彙總也 429 → 10/06 連同舊的一起再報（沒被吃掉）', sp.length === 3 && /有 [34] 則推播沒送出/.test(sp[2].text), sp[2] ? sp[2].text.slice(-120).replace(/\n/g, ' ⏎ ') : '');
  for (const x of (await pushes()).slice(-2)) await respond(x.id, 200);
  await q(`SELECT public.reconcile_line_push_log()`);
  await q(`SELECT public.line_daily_notify($1)`, [at('2026-10-07')]);
  sp = (await pushes()).filter(x => x.to === 'Cgroup');
  check('10/06 彙總送達後，10/07 不再重報', sp.length === 4 && !/推播沒送出/.test(sp[3].text));

  // ---------- 4c. 提醒日可設定 ----------
  console.log('\n=== 提醒日設定 [2]：第 1 工作天不發、第 2 工作天發 ===');
  await seed();
  await db.exec(`INSERT INTO public.system_settings (company_id, key, value) VALUES ('${C}', 'line_employee_reminder_days', '[2]'), ('${C}', 'line_daily_summary_target', '"off"')`);
  await db.exec(`INSERT INTO public.attendance_anomalies (company_id, employee_id, date, anomaly_type) VALUES ('${C}', '${E.e2}', '2026-10-01', 'missing_checkout')`);
  await q(`SELECT public.line_daily_notify($1)`, [at('2026-10-02')]);
  check('第 1 工作天：不發', (await pushes()).length === 0);
  await q(`SELECT public.line_daily_notify($1)`, [at('2026-10-05')]);
  const only = await pushes();
  check('第 2 工作天：發一次且是最後一次', only.length === 1 && only[0].to === 'U2' && /最後一次提醒/.test(only[0].text));

  // ---------- 5. 缺時開關關閉 ----------
  console.log('\n=== 缺時 LINE 開關（115）仍有效 ===');
  await seed();
  await db.exec(`UPDATE public.system_settings SET value = 'false' WHERE key = 'missing_work_hours_line_notifications_enabled'`);
  await db.exec(`INSERT INTO public.attendance_anomalies (company_id, employee_id, date, anomaly_type, details) VALUES ('${C}', '${E.e1}', '2026-10-01', 'missing_work_hours', '{"missing_minutes":90}')`);
  r = (await one(`SELECT public.line_daily_notify($1) AS r`, [at('2026-10-02')])).r;
  check('開關關閉：缺時不提醒員工、也不列入彙總（沒別的事就不發彙總）', (await pushes()).length === 0, JSON.stringify(r.companies[0]));

  // ---------- 6. 彙總收件人 ----------
  console.log('\n=== 彙總改私訊指定審核人 ===');
  await seed();
  await db.exec(`INSERT INTO public.attendance_anomalies (company_id, employee_id, date, anomaly_type) VALUES ('${C}', '${E.e2}', '2026-08-10', 'missing_checkout')`);
  await db.exec(`UPDATE public.attendance_anomalies SET notify_count = 5`);
  await db.exec(`INSERT INTO public.system_settings (company_id, key, value) VALUES
    ('${C}', 'line_daily_summary_target', '"approver"'), ('${C}', 'line_admin_approver_employee_id', '"${E.admin}"')`);
  await q(`SELECT public.line_daily_notify($1)`, [at('2026-10-02')]);
  p = await pushes();
  const lg = await one(`SELECT recipient_kind, billed_estimate FROM public.line_push_log WHERE category = 'admin_daily_summary'`);
  check('approver 模式：彙總私訊審核人、計費 1', p.length === 1 && p[0].to === 'Uadmin' && lg.recipient_kind === 'user' && lg.billed_estimate === 1);
  await db.exec(`UPDATE public.system_settings SET value = '"not-a-uuid"' WHERE key = 'line_admin_approver_employee_id'`);
  await q(`SELECT public.line_daily_notify($1)`, [at('2026-10-05')]);
  p = await pushes();
  check('審核人設定錯誤 → 退回群組，不會默默不發', p.length === 2 && p[1].to === 'Cgroup');
  await db.exec(`UPDATE public.system_settings SET value = '"off"' WHERE key = 'line_daily_summary_target'`);
  await q(`SELECT public.line_daily_notify($1)`, [at('2026-10-06')]);
  check('off 模式：不發彙總', (await pushes()).length === 2);

  // ---------- 7. 預算閘門 ----------
  console.log('\n=== 月預算閘門 ===');
  await seed();
  await db.exec(`INSERT INTO public.system_settings (company_id, key, value) VALUES ('${C}', 'line_monthly_budget', '10'), ('${C}', 'line_monthly_quota', '14')`);
  const reserve = async (cat, prio, kind, now = at('2026-10-02')) =>
    (await one(`SELECT public.line_push_reserve('${C}', 'frontend', $1, $2, $3, NULL, NULL, NULL, $4) AS r`, [cat, prio, kind, now])).r;
  const a1 = await reserve('leave', 'normal', 'group');
  const a2 = await reserve('leave', 'normal', 'group');
  const a3 = await reserve('leave', 'normal', 'group');
  check('一般訊息：4+4 通過，第三則（12 > 10）被擋', a1.allowed && a2.allowed && !a3.allowed && a3.reason === 'budget_exceeded', `${a1.allowed},${a2.allowed},${a3.allowed}`);
  const h1 = await reserve('urgent_announcement', 'high', 'group');
  const h2 = await reserve('urgent_announcement', 'high', 'user');
  check('高優先：可用到額度上限 14（8+4=12 通過，再 +4 超過；個人 1 則 13 通過）', h1.allowed === true && h2.allowed === true);
  const h3 = await reserve('urgent_announcement', 'high', 'group');
  check('高優先也不超過方案額度', h3.allowed === false);
  const blocked = await one(`SELECT COUNT(*)::int AS n FROM public.line_push_log WHERE status = 'blocked_budget'`);
  check('被擋的也有紀錄（blocked_budget）', blocked.n === 2);
  const nov = await reserve('leave', 'normal', 'group', '2026-10-31 23:30:00+08');
  check('台灣 10/31 23:30 = 日本 11/01 → 新月份額度重新計算', nov.allowed === true && nov.used === 0);
  await db.exec(`UPDATE public.line_push_log SET created_at = now() - interval '2 hours' WHERE status = 'reserved' AND net_request_id IS NULL`);
  const rec = (await one(`SELECT public.reconcile_line_push_log() AS r`)).r;
  check('前端送出後 1 小時沒回報 → unknown（仍計入用量）', rec.marked_unknown >= 1);

  // ---------- 7b. Edge Function 入口：驗 token、限類別 ----------
  console.log('\n=== Edge Function 預約入口（防冒用） ===');
  await seed();
  const goodHash = (await one(`SELECT encode(sha256(convert_to('test-token', 'UTF8')), 'hex') AS h`)).h;
  const fe = async (hash, cat) => (await one(`SELECT public.line_push_reserve_frontend('${C}', $1, $2, 'normal', 'group', NULL) AS r`, [hash, cat])).r;
  const bad = await fe('0'.repeat(64), 'leave');
  check('token 不符：不記帳、回 token_mismatch', bad.allowed === null && bad.reason === 'token_mismatch'
    && (await one(`SELECT COUNT(*)::int AS n FROM public.line_push_log`)).n === 0);
  const spoof = await fe(goodHash, 'admin_daily_summary');
  const spoofCat = (await one(`SELECT category, source FROM public.line_push_log WHERE id = $1`, [spoof.log_id]));
  check('冒充 admin_daily_summary 會被改成 frontend_other（壓不掉每日彙總）', spoof.allowed === true && spoofCat.category === 'frontend_other' && spoofCat.source === 'frontend');
  const okLeave = await fe(goodHash, 'leave');
  check('token 正確＋合法類別：照常預約', okLeave.allowed === true);

  // ---------- 8. #待辦 與管理員狀態 ----------
  console.log('\n=== #待辦 與推播狀態 RPC ===');
  await seed();
  await db.exec(`INSERT INTO public.attendance_anomalies (company_id, employee_id, date, anomaly_type, details) VALUES
    ('${C}', '${E.e1}', '2026-10-01', 'missing_work_hours', '{"missing_minutes":45}')`);
  await db.exec(`INSERT INTO public.leave_requests (employee_id, leave_type, start_date, end_date, status) VALUES ('${E.e1}', 'annual', '2026-10-20', '2026-10-20', 'pending')`);
  await db.exec(`INSERT INTO public.shift_swap_requests (requester_id, target_id, swap_date, status) VALUES ('${E.e2}', '${E.e1}', '2026-10-21', 'pending_target')`);
  const todoEmp = (await one(`SELECT public.line_pull_todo('U1') AS t`)).t;
  check('員工 #待辦：看到自己的缺時、待審申請、等我回覆的換班', /缺 45 分鐘/.test(todoEmp) && /我的申請待審】1 件/.test(todoEmp) && /等我回覆的換班】1 件/.test(todoEmp) && !/主管待審/.test(todoEmp), todoEmp.replace(/\n/g, ' ⏎ '));
  const todoAdmin = (await one(`SELECT public.line_pull_todo('Uadmin') AS t`)).t;
  check('主管 #待辦：看到全公司待審數量與本月推播用量', /主管待審】/.test(todoAdmin) && /請假 1 件/.test(todoAdmin) && /本月 LINE 推播估計 0／200/.test(todoAdmin), todoAdmin.replace(/\n/g, ' ⏎ '));
  const todoNone = (await one(`SELECT public.line_pull_todo('Unobody') AS t`)).t;
  check('沒綁定的 LINE 帳號：只回提示，不洩漏資料', /找不到您的員工綁定資料/.test(todoNone));
  const st = (await one(`SELECT public.get_line_push_status('${C}', 'Uadmin') AS s`)).s;
  check('管理員可讀推播狀態（used/budget/quota）', st.success === true && st.budget === 180 && st.quota === 200);
  let denied = false;
  try { await q(`SELECT public.get_line_push_status('${C}', 'U1')`); } catch (e) { denied = /access_denied/.test(e.message); }
  check('一般員工讀推播狀態被拒', denied);

  // ---------- 9. 權限 ----------
  console.log('\n=== 權限 ===');
  const priv = async (role, fn) => (await one(`SELECT has_function_privilege('${role}', '${fn}', 'EXECUTE') AS p`)).p;
  check('anon 不能呼叫 line_push_reserve / line_pull_todo / line_daily_notify',
    !(await priv('anon', 'public.line_push_reserve(uuid,text,text,text,text,text,integer,uuid,timestamptz)')) &&
    !(await priv('anon', 'public.line_pull_todo(text)')) && !(await priv('anon', 'public.line_daily_notify(timestamptz)')));
  check('service_role 只能走 reserve_frontend（驗 token），不能直接呼叫內部 reserve',
    !(await priv('service_role', 'public.line_push_reserve(uuid,text,text,text,text,text,integer,uuid,timestamptz)')) &&
    await priv('service_role', 'public.line_push_reserve_frontend(uuid,text,text,text,text,text)'));
  check('service_role 可呼叫 complete / pull_todo（Edge Function 用）',
    await priv('service_role', 'public.line_push_complete(bigint,integer,text)') && await priv('service_role', 'public.line_pull_todo(text)'));
  check('anon 可呼叫 get_line_push_status（函式內再驗主管身分）', await priv('anon', 'public.get_line_push_status(uuid,text)'));
  const tblPriv = await one(`SELECT has_table_privilege('anon', 'public.line_push_log', 'SELECT') AS p`);
  check('anon 不能直接讀 line_push_log', tblPriv.p === false);

  // ---------- 10. 排程入口 ----------
  console.log('\n=== 排程入口 ===');
  await seed();
  const full = (await one(`SELECT public.run_daily_attendance_audit() AS r`)).r;
  check('run_daily_attendance_audit() 一次做完兩種掃描＋通知', 'scanned_new' in full && 'missing_work_hours_scan' in full && 'notify' in full, Object.keys(full).join(','));
  const q15 = (await one(`SELECT public.run_daily_missing_work_hours_audit() AS r`)).r;
  check('09:15 舊入口只掃描、不推播', q15.employees_notified === 0 && (await pushes()).length === 0);
  const ctl = (await one(`SELECT public.get_missing_work_hours_notification_control('${C}', 'Uadmin') AS c`)).c;
  check('缺時開關 RPC 顯示 09:10', ctl.schedule_time === '09:10');

  // ---------- 11. 回滾與重套 ----------
  console.log('\n=== 回滾 → 再套一次 ===');
  let rbOk = true;
  try { await db.exec(m125rb); } catch (e) { rbOk = false; check('回滾可套用', false, e.message); }
  if (rbOk) {
    check('回滾可套用', true);
    const jobs2 = (await q(`SELECT jobname FROM cron.job ORDER BY jobname`)).map(j => j.jobname);
    check('回滾：09:15 排程回來、回填排程移除', JSON.stringify(jobs2) === JSON.stringify(['daily-attendance-audit', 'daily-missing-work-hours-audit']), jobs2.join(','));
    const tbl = await one(`SELECT to_regclass('public.line_push_log') AS t`);
    const body = await one(`SELECT prosrc FROM pg_proc WHERE proname = 'run_daily_attendance_audit'`);
    check('回滾：推播紀錄表移除、舊函式本體還原', tbl.t === null && /未處理前每天都會提醒/.test(body.prosrc) && !/line_daily_notify/.test(body.prosrc));
    let again = true;
    try { await db.exec(m125); } catch (e) { again = false; check('回滾後可再套 125', false, e.message); }
    if (again) check('回滾後可再套 125', true);
  }

  finish();
  function finish() {
    console.log(`\n結果：${pass} 通過、${fail} 失敗`);
    process.exit(fail > 0 ? 1 : 0);
  }
})().catch(e => { console.error(e); process.exit(1); });
