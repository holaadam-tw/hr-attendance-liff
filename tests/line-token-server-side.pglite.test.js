// ============================================================
// migration 126／127：LINE token 伺服器端化＋system_settings 讀寫收斂 — PGlite 實跑
//
// 不連線、不寫正式庫。流程：
//   1. base schema ＋ 125 ＋ 正式庫 system_settings 政策／grant 快照（tests/fixtures/system_settings_prod_rls.sql）
//   2. 套用前：重現「anon 讀得到 token」「anon 可替別家公司寫設定」
//   3. 套 126 → 套 127 → 以 anon／authenticated／service_role 身分逐情境驗證
//   4. 127、126 回滾 → 回到正式庫快照 → 再套一次（可重複套用）
// 反向對照（證明測試在舊程式會失敗）：
//   MIGRATION126_FILE／MIGRATION127_FILE 指向空檔 → 套用後的情境應大量失敗
// ============================================================
const fs = require('fs');
const path = require('path');
const { PGlite } = require('@electric-sql/pglite');

const root = path.join(__dirname, '..');
const read = f => fs.readFileSync(f, 'utf8');
const baseSql = read(path.join(__dirname, 'fixtures', 'line_push_base_schema.sql'));
const prodRls = read(path.join(__dirname, 'fixtures', 'system_settings_prod_rls.sql'));
const m125 = read(path.join(root, 'migrations', '125_line_push_budget_and_digest.sql'));
const m126 = read(process.env.MIGRATION126_FILE || path.join(root, 'migrations', '126_line_push_server_token.sql'));
const m127 = read(process.env.MIGRATION127_FILE || path.join(root, 'migrations', '127_system_settings_lock.sql'));
const m126rb = read(path.join(root, 'migrations', '126_line_push_server_token_rollback.sql'));
const m127rb = read(path.join(root, 'migrations', '127_system_settings_lock_rollback.sql'));

let pass = 0, fail = 0;
function check(name, condition, detail = '') {
  if (condition) { pass++; console.log(`  ✅ ${name}${detail ? `  → ${detail}` : ''}`); }
  else { fail++; console.log(`  ❌ ${name}${detail ? `  → ${detail}` : ''}`); }
}

const A = '8a669e2c-7521-43e9-9300-5c004c57e9db';
const B = '11111111-2222-3333-4444-555555555555';
const E = {
  admin: '00000000-0000-0000-0000-0000000000a1',
  mgr: '00000000-0000-0000-0000-0000000000a2',
  e1: '00000000-0000-0000-0000-0000000000e1',
  e2: '00000000-0000-0000-0000-0000000000e2',
  kiosk: '00000000-0000-0000-0000-0000000000c1',
  bAdmin: '00000000-0000-0000-0000-0000000000b1',
  bUser: '00000000-0000-0000-0000-0000000000b2',
};
const PA = '00000000-0000-0000-0000-00000000fa01';
const TOKEN_A = 'secret-token-AAAA-1234';

(async () => {
  console.log('\n═══════════════════════════════════════');
  console.log('  LINE token 伺服器端化＋system_settings 收斂（126／127，PGlite 實跑）');
  console.log('═══════════════════════════════════════');

  const db = new PGlite();
  const q = async (sql, params) => (await db.query(sql, params)).rows;
  const one = async (sql, params) => (await q(sql, params))[0];
  await db.exec(baseSql);
  await db.exec(m125);
  await db.exec(prodRls);

  // 以某個 PostgREST 角色身分執行（含 request.jwt.claims），回傳 { rows } 或 { error }
  async function as(role, sql, params) {
    try {
      await db.exec(`SET ROLE ${role}`);
      await db.query(`SELECT set_config('request.jwt.claims', $1, false)`, [JSON.stringify({ role })]);
      const rows = (await db.query(sql, params)).rows;
      return { rows };
    } catch (e) {
      return { error: e.message };
    } finally {
      await db.exec(`RESET ROLE`);
      await db.query(`SELECT set_config('request.jwt.claims', '', false)`);
    }
  }
  const rpc = async (role, fn, args) => {
    const keys = Object.keys(args);
    const r = await as(role, `SELECT public.${fn}(${keys.map((k, i) => `${k} => $${i + 1}`).join(', ')}) AS r`, keys.map(k => args[k]));
    return r.error ? { error: r.error } : r.rows[0].r;
  };
  const setting = async (company, key) => (await one(`SELECT value FROM public.system_settings WHERE company_id = $1 AND key = $2`, [company, key]))?.value;

  async function seed() {
    await db.exec(`
      TRUNCATE public.line_push_log, public.attendance_anomalies, public.leave_requests, public.makeup_punch_requests,
               public.overtime_requests, public.shift_swap_requests, public.requests, public.attendance,
               public.holidays, public.system_settings, net.http_request_queue, net._http_response CASCADE;
      DELETE FROM public.platform_admin_companies; DELETE FROM public.platform_admins;
      DELETE FROM public.employees; DELETE FROM public.companies;
      INSERT INTO public.companies (id, name) VALUES ('${A}', '大正科技'), ('${B}', '別家公司');
      INSERT INTO public.employees (id, company_id, employee_number, name, line_user_id, role, is_kiosk) VALUES
        ('${E.admin}', '${A}', 'A01', '主管甲', 'Uadmin', 'admin', false),
        ('${E.mgr}', '${A}', 'A02', '主管乙', 'Umgr', 'manager', false),
        ('${E.e1}', '${A}', 'E01', '員工一', 'U1', 'user', false),
        ('${E.e2}', '${A}', 'E02', '員工二', 'U2', 'user', false),
        ('${E.kiosk}', '${A}', 'K01', '公務機', 'Ukiosk', 'manager', true),
        ('${E.bAdmin}', '${B}', 'B01', '別家主管', 'UBadmin', 'admin', false),
        ('${E.bUser}', '${B}', 'B02', '別家員工', 'UB1', 'user', false);
      INSERT INTO public.platform_admins (id, line_user_id, name) VALUES ('${PA}', 'Uplatform', '平台');
      INSERT INTO public.platform_admin_companies (platform_admin_id, company_id, role) VALUES ('${PA}', '${A}', 'admin');
      INSERT INTO public.system_settings (company_id, key, value) VALUES
        ('${A}', 'line_messaging_api', '{"token":"${TOKEN_A}","groupId":"CgroupA"}'),
        ('${A}', 'office_locations', '[{"name":"總公司"}]'),
        ('${A}', 'attendance_audit_enabled', 'true'),
        ('${B}', 'line_messaging_api', '{"token":"secret-token-B","groupId":"CgroupB"}'),
        ('${B}', 'office_locations', '[{"name":"B 公司"}]');
    `);
  }

  // ---------- 1. 套用前：重現正式庫的洞 ----------
  console.log('\n=== 套用前（正式庫政策快照）：重現問題 ===');
  await seed();
  let r = await as('anon', `SELECT value->>'token' AS t FROM public.system_settings WHERE key = 'line_messaging_api' AND company_id = $1`, [A]);
  check('現況重現：anon 讀得到 A 公司的 LINE token', r.rows && r.rows[0] && r.rows[0].t === TOKEN_A);
  r = await as('anon', `INSERT INTO public.system_settings (company_id, key, value) VALUES ($1, 'office_locations_evil', '[]'::jsonb)`, [B]);
  check('現況重現：anon 可替 B 公司新增設定（不驗公司）', !r.error);
  r = await as('anon', `UPDATE public.system_settings SET value = '{"token":"attacker","groupId":"Cattacker"}' WHERE company_id = $1 AND key = 'line_messaging_api'`, [A]);
  check('現況重現：anon 可改掉 A 公司的 token／群組', !r.error && (await setting(A, 'line_messaging_api')).token === 'attacker');

  // ---------- 2. 套 126、127 ----------
  console.log('\n=== 套用 126 → 127 ===');
  await seed();
  let ok126 = true, ok127 = true;
  try { await db.exec(m126); } catch (e) { ok126 = false; check('126 可在 PostgreSQL 套用', false, e.message); }
  if (ok126) check('126 可在 PostgreSQL 套用', true);
  r = await as('anon', `SELECT count(*)::int AS n FROM public.system_settings WHERE key = 'line_messaging_api'`);
  check('只套 126（前端還沒換版）：政策不變，舊頁面仍讀得到（相容）', r.rows && r.rows[0].n === 2);
  try { await db.exec(m127); } catch (e) { ok127 = false; check('127 可在 PostgreSQL 套用', false, e.message); }
  if (ok127) check('127 可在 PostgreSQL 套用', true);

  console.log('\n=== 127：讀取 ===');
  await seed();
  for (const role of ['anon', 'authenticated']) {
    r = await as(role, `SELECT key, value FROM public.system_settings WHERE company_id = $1`, [A]);
    const keys = (r.rows || []).map(x => x.key);
    check(`${role} 讀不到 line_messaging_api（token 不外洩）`, !r.error && !keys.includes('line_messaging_api') && !JSON.stringify(r.rows).includes(TOKEN_A), keys.join(','));
    check(`${role} 仍讀得到一般設定（其他頁面不受影響）`, keys.includes('office_locations') && keys.includes('attendance_audit_enabled'));
  }
  const pol = (await q(`SELECT policyname, cmd, roles::text AS roles, qual FROM pg_policies WHERE tablename = 'system_settings' ORDER BY policyname`));
  check('anon 相關政策只剩一條唯讀（排除秘密列）＋ service_role', pol.length === 2 && pol.some(p => p.policyname === 'system_settings_read_non_secret' && p.cmd === 'SELECT') && pol.some(p => p.policyname === 'Service Role Full Access - settings'), pol.map(p => p.policyname + ':' + p.cmd).join(', '));

  console.log('\n=== 127：直接寫入全擋 ===');
  for (const role of ['anon', 'authenticated']) {
    r = await as(role, `INSERT INTO public.system_settings (company_id, key, value) VALUES ($1, 'x_evil', '1'::jsonb)`, [B]);
    check(`${role} INSERT 被擋`, !!r.error, r.error);
    r = await as(role, `UPDATE public.system_settings SET value = '"attacker"' WHERE company_id = $1`, [A]);
    check(`${role} UPDATE 被擋`, !!r.error, r.error);
    r = await as(role, `DELETE FROM public.system_settings WHERE company_id = $1`, [A]);
    check(`${role} DELETE 被擋`, !!r.error, r.error);
  }
  check('A 公司 token 沒被動到', (await setting(A, 'line_messaging_api'))?.token === TOKEN_A);

  console.log('\n=== admin_save_setting（前端 saveSetting 的新路徑）===');
  const save = (role, uid, company, key, value) => rpc(role, 'admin_save_setting', {
    p_company_id: company, p_line_user_id: uid, p_key: key, p_value: value === undefined ? null : JSON.stringify(value), p_description: key });
  r = await save('anon', 'Uadmin', A, 'office_locations', [{ name: '新地點' }]);
  check('A 管理員存 A 的一般設定：成功', r?.success === true && (await setting(A, 'office_locations'))[0].name === '新地點', JSON.stringify(r));
  r = await save('anon', 'Uadmin', A, 'brand_new_key', { a: 1 });
  check('新 key 會 INSERT（含 company_id＝參數）', r?.success === true && (await setting(A, 'brand_new_key')).a === 1);
  r = await save('anon', 'Uadmin', B, 'office_locations', []);
  check('A 管理員改 B 公司：拒絕，B 不變', r?.error_code === 'access_denied' && (await setting(B, 'office_locations'))[0].name === 'B 公司', JSON.stringify(r));
  r = await save('anon', 'U1', A, 'office_locations', []);
  check('一般員工：拒絕', r?.error_code === 'access_denied');
  r = await save('anon', 'Ukiosk', A, 'office_locations', []);
  check('公務機帳號（即使 role=manager）：拒絕', r?.error_code === 'access_denied');
  r = await save('anon', 'Umgr', A, 'late_threshold_minutes', 5);
  check('主管存一般設定：成功（沿用後台 admin/manager 都能進設定頁）', r?.success === true && (await setting(A, 'late_threshold_minutes')) === 5);
  r = await save('anon', 'Umgr', A, 'payroll_password', { password: 'x' });
  check('主管存 payroll_password：拒絕（限管理員）', r?.error_code === 'admin_only');
  r = await save('anon', 'Uplatform', A, 'feature_visibility', { leave: true });
  check('平台管理員（有綁 A）存 A：成功', r?.success === true);
  r = await save('anon', 'Uplatform', B, 'feature_visibility', { leave: true });
  check('平台管理員（沒綁 B）存 B：拒絕', r?.error_code === 'access_denied');
  r = await save('anon', 'Uadmin', A, 'Bad Key;drop', 1);
  check('key 格式不符：拒絕', r?.error_code === 'invalid_key');
  r = await save('anon', 'Uadmin', A, 'line_admin_approver_employee_id', undefined);
  check('value 為 null（取消指定審核人）存成 JSON null，不會因 NOT NULL 失敗', r?.success === true && (await one(`SELECT jsonb_typeof(value) AS t FROM public.system_settings WHERE company_id = $1 AND key = 'line_admin_approver_employee_id'`, [A])).t === 'null');
  r = await save('anon', 'Uadmin', A, 'line_messaging_api', { token: 'attacker', groupId: 'Cattacker' });
  check('前端（anon）直接存 LINE token：拒絕，必須走 Edge Function 驗 LIFF', r?.error_code === 'verified_path_required' && (await setting(A, 'line_messaging_api')).token === TOKEN_A, JSON.stringify(r));
  r = await save('service_role', 'Umgr', A, 'line_messaging_api', { groupId: 'Cnew' });
  check('Edge Function（service role）代主管存 LINE 設定：拒絕（限管理員）', r?.error_code === 'admin_only');
  r = await save('service_role', 'Uadmin', A, 'line_messaging_api', { groupId: 'Cnew' });
  let v = await setting(A, 'line_messaging_api');
  check('Edge Function 代管理員只改群組（沒帶 token）：沿用原 token', r?.success === true && v.token === TOKEN_A && v.groupId === 'Cnew', JSON.stringify(r));
  r = await save('service_role', 'Uadmin', A, 'line_messaging_api', { token: 'rotated-token-9999', groupId: 'Cnew' });
  v = await setting(A, 'line_messaging_api');
  check('Edge Function 代管理員換 token：成功', r?.success === true && v.token === 'rotated-token-9999');
  await db.query(`UPDATE public.system_settings SET value = $2 WHERE company_id = $1 AND key = 'line_messaging_api'`, [A, JSON.stringify({ token: TOKEN_A, groupId: 'CgroupA' })]);

  console.log('\n=== get_line_messaging_config（設定頁顯示，不回 token）===');
  r = await rpc('anon', 'get_line_messaging_config', { p_company_id: A, p_line_user_id: 'Uadmin' });
  check('管理員：看得到「已設定、末 4 碼、群組 ID」', r?.success === true && r.has_token === true && r.token_hint === '…1234' && r.group_id === 'CgroupA', JSON.stringify(r));
  check('回傳內容不含 token 本體', !JSON.stringify(r).includes(TOKEN_A));
  r = await rpc('anon', 'get_line_messaging_config', { p_company_id: A, p_line_user_id: 'U1' });
  check('一般員工：拒絕', r?.error_code === 'access_denied');

  console.log('\n=== line_push_authorize（line-push Edge Function 用）===');
  const auth = (uid, target, emp, category, priority = 'normal') => rpc('service_role', 'line_push_authorize', {
    p_company_id: A, p_line_user_id: uid, p_target: target, p_employee_id: emp, p_category: category, p_priority: priority });
  r = await rpc('anon', 'line_push_authorize', { p_company_id: A, p_line_user_id: 'Uadmin', p_target: 'admin_group', p_employee_id: null, p_category: 'test', p_priority: 'normal' });
  check('anon 不能直接呼叫（會拿到 token）', typeof r?.error === 'string' && /permission denied/.test(r.error), r?.error);
  r = await rpc('authenticated', 'can_manage_company_settings', { p_line_user_id: 'Uadmin', p_company_id: A });
  check('anon/authenticated 不能呼叫身分探測 helper', typeof r?.error === 'string' && /permission denied/.test(r.error));
  r = await auth('U1', 'admin_group', null, 'leave');
  check('員工 → 主管群組（請假通知）：允許，收件人＝DB 的 groupId，token 由 DB 提供', r?.allowed === true && r.to === 'CgroupA' && r.token === TOKEN_A && r.recipient_kind === 'group', JSON.stringify({ ...r, token: r?.token ? '<redacted>' : null }));
  const logRow = await one(`SELECT source, category, status, recipient_kind FROM public.line_push_log WHERE id = $1`, [r.log_id]);
  check('同時預約月預算（line_push_log reserved／source=frontend）', logRow && logRow.status === 'reserved' && logRow.source === 'frontend' && logRow.category === 'leave');
  r = await auth('U1', 'admin_group', null, 'test', 'high');
  check('員工發「測試推播」：拒絕（限主管）', r?.allowed === false && r.reason === 'manager_required');
  r = await auth('U1', 'admin_group', null, 'urgent_announcement', 'high');
  check('員工發「緊急公告」：拒絕（限主管）', r?.allowed === false && r.reason === 'manager_required');
  r = await auth('U1', 'employee', E.e2, 'leave_result');
  check('員工發「審核結果」給別人：拒絕（限主管）', r?.allowed === false && r.reason === 'manager_required');
  r = await auth('Uadmin', 'employee', E.e1, 'leave_result');
  check('主管 → 員工（審核結果）：收件人＝該員工的 LINE ID', r?.allowed === true && r.to === 'U1' && r.recipient_kind === 'user' && r.recipient_ref === E.e1);
  r = await auth('Uadmin', 'employee', E.bUser, 'leave_result');
  check('主管 → 別家公司員工：拒絕', r?.allowed === false && r.reason === 'employee_not_found');
  r = await auth('U1', 'employee', E.e2, 'shift_swap_request');
  check('員工 → 同事（換班邀請）：允許', r?.allowed === true && r.to === 'U2');
  r = await auth('UB1', 'admin_group', null, 'leave');
  check('別家公司員工替 A 發通知：拒絕', r?.allowed === false && r.reason === 'not_company_member');
  r = await auth('Unobody', 'admin_group', null, 'leave');
  check('不認識的 LINE 帳號：拒絕', r?.allowed === false && r.reason === 'not_company_member');
  r = await auth('U1', 'admin_group', null, 'admin_daily_summary');
  check('冒充 DB 排程類別（admin_daily_summary）：拒絕', r?.allowed === false && r.reason === 'category_not_allowed');
  r = await auth('U1', 'employee', E.e2, 'leave');
  check('主管通知類別不能改寄給員工：拒絕', r?.allowed === false && r.reason === 'target_not_allowed');
  r = await auth('U1', 'admin_group', null, 'leave', 'high');
  check('一般類別帶 high：降為 normal', r?.allowed === true && r.priority === 'normal');
  r = await auth('U1', 'admin_group', null, 'request_urgent', 'high');
  check('急迫報修帶 high：保留 high', r?.allowed === true && r.priority === 'high');
  r = await auth('Uadmin', 'admin_group', null, 'test', 'high');
  check('主管測試推播：允許、高優先', r?.allowed === true && r.priority === 'high' && r.to === 'CgroupA');
  r = await auth('U1', 'admin_approver', null, 'gps_review');
  check('指定審核人未設定 → 退回主管群組', r?.allowed === true && r.to === 'CgroupA');
  await db.query(`INSERT INTO public.system_settings (company_id, key, value) VALUES ($1, 'line_admin_approver_employee_id', $2::jsonb) ON CONFLICT (key, COALESCE(company_id, '00000000-0000-0000-0000-000000000000'::uuid)) DO UPDATE SET value = EXCLUDED.value`, [A, JSON.stringify(E.mgr)]);
  r = await auth('U1', 'admin_approver', null, 'gps_review');
  check('指定審核人已設定 → 私訊審核人（1 則）', r?.allowed === true && r.to === 'Umgr' && r.recipient_kind === 'user');
  await db.query(`UPDATE public.system_settings SET value = '"not-a-uuid"' WHERE company_id = $1 AND key = 'line_admin_approver_employee_id'`, [A]);
  r = await auth('U1', 'admin_approver', null, 'gps_review');
  check('審核人設定壞掉 → 退回群組，不報錯', r?.allowed === true && r.to === 'CgroupA');
  await db.query(`INSERT INTO public.system_settings (company_id, key, value) VALUES ($1, 'line_monthly_budget', '0')`, [A]);
  r = await auth('U1', 'admin_group', null, 'leave');
  check('超過月預算：allowed=false、reason=budget_exceeded、不回 token', r?.allowed === false && r.reason === 'budget_exceeded' && !r.token);
  await db.query(`DELETE FROM public.system_settings WHERE company_id = $1 AND key = 'line_monthly_budget'`, [A]);
  await db.query(`UPDATE public.system_settings SET value = '{"token":"","groupId":"CgroupA"}' WHERE company_id = $1 AND key = 'line_messaging_api'`, [A]);
  r = await auth('U1', 'admin_group', null, 'leave');
  check('公司沒設定 token：missing_token', r?.allowed === false && r.reason === 'missing_token');
  await db.query(`UPDATE public.system_settings SET value = $2 WHERE company_id = $1 AND key = 'line_messaging_api'`, [A, JSON.stringify({ token: TOKEN_A, groupId: 'CgroupA' })]);

  console.log('\n=== 127 之後 DB 排程照常拿得到 token ===');
  await seed();
  await db.exec(`INSERT INTO public.attendance_anomalies (company_id, employee_id, date, anomaly_type, details) VALUES ('${A}', '${E.e1}', '2026-10-01', 'missing_checkout', '{}')`);
  await q(`SELECT public.line_daily_notify('2026-10-02 09:10:00+08')`);
  const queued = await q(`SELECT headers->>'Authorization' AS auth, body->>'to' AS "to" FROM net.http_request_queue`);
  check('09:10 每日通知仍用 DB 裡的 token 送出（SECURITY DEFINER 不受 RLS 影響）', queued.length >= 1 && queued.every(x => x.auth === 'Bearer ' + TOKEN_A), queued.map(x => x.to).join(','));

  console.log('\n=== 順序防呆、回滾、重套 ===');
  {
    const db2 = new PGlite();
    await db2.exec(baseSql); await db2.exec(m125); await db2.exec(prodRls);
    let err = '';
    try { await db2.exec(m127); } catch (e) { err = e.message; }
    check('沒套 126 就套 127：中止（避免前端失去寫設定的路徑）', /126/.test(err), err);
    await db2.close();
  }
  await db.exec(m127rb);
  const polRb = (await q(`SELECT policyname FROM pg_policies WHERE tablename = 'system_settings' ORDER BY policyname`)).map(p => p.policyname);
  check('127 回滾：7 條政策回到正式庫快照', polRb.length === 7 && polRb.includes('Allow RPC access settings') && polRb.includes('公開讀取系統設定'), polRb.join(', '));
  r = await as('anon', `INSERT INTO public.system_settings (company_id, key, value) VALUES ($1, 'rb_check', '1'::jsonb)`, [A]);
  check('127 回滾：anon 寫入 grant 恢復（舊頁面可用）', !r.error, r.error);
  await db.exec(m126rb);
  const fns = (await q(`SELECT proname FROM pg_proc WHERE proname IN ('line_push_authorize','admin_save_setting','get_line_messaging_config','can_manage_company_settings')`)).length;
  check('126 回滾：4 支新函式移除', fns === 0, String(fns));
  let reErr = '';
  try { await db.exec(m126); await db.exec(m127); await db.exec(m126); await db.exec(m127); } catch (e) { reErr = e.message; }
  check('126、127 可重複套用', reErr === '', reErr);

  finish();
  function finish() {
    console.log(`\n結果：${pass} 通過、${fail} 失敗`);
    process.exit(fail > 0 ? 1 : 0);
  }
})().catch(e => { console.error(e); process.exit(1); });
