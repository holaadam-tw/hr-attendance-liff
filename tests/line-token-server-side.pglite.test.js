// ============================================================
// migration 126／127／129：LINE token 伺服器端化＋system_settings 讀寫收斂＋平台管理員表寫入鎖定 — PGlite 實跑
//
// 不連線、不寫正式庫。流程：
//   1. base schema ＋ 125 ＋ 正式庫 system_settings／platform_admins／platform_admin_companies 政策與 grant 快照
//      （tests/fixtures/system_settings_prod_rls.sql）
//   2. 套用前：重現「anon 讀得到 token」「anon 可替別家公司寫設定」「anon 可把自己加成平台管理員 → 繞過權限」
//   3. 依上線順序套 126 → 129 → 127，以 anon／authenticated／service_role 身分逐情境驗證
//   4. 回滾 127 → 129 → 126 → 回到正式庫快照 → 再套一次（可重複套用）
// 反向對照（證明測試在舊程式會失敗）：
//   MIGRATION126_FILE／MIGRATION127_FILE／MIGRATION129_FILE 指向空檔 → 套用後的情境應大量失敗
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
const m129 = read(process.env.MIGRATION129_FILE || path.join(root, 'migrations', '129_platform_admin_write_lock.sql'));
const m126rb = read(path.join(root, 'migrations', '126_line_push_server_token_rollback.sql'));
const m127rb = read(path.join(root, 'migrations', '127_system_settings_lock_rollback.sql'));
const m129rb = read(path.join(root, 'migrations', '129_platform_admin_write_lock_rollback.sql'));

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
const U_ATTACKER = 'U' + 'f'.repeat(32);
const U_NEWPA = 'U' + '1'.repeat(32);

(async () => {
  console.log('\n═══════════════════════════════════════');
  console.log('  LINE token 伺服器端化＋設定／平台管理員寫入收斂（126／127／129，PGlite 實跑）');
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
  const denied = r => typeof r?.error === 'string' && /permission denied/.test(r.error);

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
      INSERT INTO public.platform_admin_companies (platform_admin_id, company_id, role) VALUES ('${PA}', '${A}', 'owner');
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
  await seed();
  r = await as('anon', `WITH pa AS (INSERT INTO public.platform_admins (line_user_id, name) VALUES ($1, '攻擊者') RETURNING id)
                        INSERT INTO public.platform_admin_companies (platform_admin_id, company_id, role) SELECT id, $2, 'owner' FROM pa`, [U_ATTACKER, A]);
  check('現況重現（H1）：anon 可把自己加成平台管理員並綁 A 公司', !r.error, r.error);
  r = await as('anon', `UPDATE public.platform_admins SET line_user_id = $1 WHERE id = $2`, ['Uhijack', PA]);
  check('現況重現（H1）：anon 可改掉既有平台管理員的 LINE ID', !r.error);

  // ---------- 2. 依上線順序套 126 → 129 → 127 ----------
  console.log('\n=== 套用 126 → 129 → 127 ===');
  await seed();
  let ok = true;
  try { await db.exec(m126); } catch (e) { ok = false; check('126 可在 PostgreSQL 套用', false, e.message); }
  if (ok) check('126 可在 PostgreSQL 套用', true);
  r = await as('anon', `SELECT count(*)::int AS n FROM public.system_settings WHERE key = 'line_messaging_api'`);
  check('只套 126（前端還沒換版）：system_settings 政策不變，舊頁面仍讀得到（相容）', r.rows && r.rows[0].n === 2);
  ok = true;
  try { await db.exec(m129); } catch (e) { ok = false; check('129 可在 127 之前套用', false, e.message); }
  if (ok) check('129 可在 127 之前套用', true);
  r = await as('anon', `INSERT INTO public.system_settings (company_id, key, value) VALUES ($1, 'still_open_before_127', '1'::jsonb)`, [A]);
  check('126＋129 之後、127 之前：舊頁面的 saveSetting（直接寫表）仍可用', !r.error, r.error);
  r = await as('anon', `SELECT id FROM public.platform_admins WHERE line_user_id = 'Uplatform' AND is_active = true`);
  check('126＋129 之後：舊頁面登入時查平台管理員（SELECT）仍可用', r.rows && r.rows.length === 1);
  ok = true;
  try { await db.exec(m127); } catch (e) { ok = false; check('127 可在 PostgreSQL 套用', false, e.message); }
  if (ok) check('127 可在 PostgreSQL 套用', true);

  console.log('\n=== 129：平台管理員表 ===');
  await seed();
  for (const role of ['anon', 'authenticated']) {
    r = await as(role, `INSERT INTO public.platform_admins (line_user_id, name) VALUES ($1, '攻擊者')`, [U_ATTACKER]);
    check(`${role} 不能把自己加成平台管理員`, !!r.error, r.error);
    r = await as(role, `INSERT INTO public.platform_admin_companies (platform_admin_id, company_id, role) VALUES ($1, $2, 'owner')`, [PA, B]);
    check(`${role} 不能新增公司綁定`, !!r.error, r.error);
    r = await as(role, `UPDATE public.platform_admins SET line_user_id = 'Uhijack' WHERE id = $1`, [PA]);
    check(`${role} 不能改平台管理員`, !!r.error, r.error);
    r = await as(role, `DELETE FROM public.platform_admin_companies`);
    check(`${role} 不能刪公司綁定`, !!r.error, r.error);
  }
  check('平台管理員資料沒被動到', (await one(`SELECT line_user_id FROM public.platform_admins WHERE id = $1`, [PA])).line_user_id === 'Uplatform'
    && (await one(`SELECT count(*)::int AS n FROM public.platform_admin_companies`)).n === 1);
  r = await rpc('anon', 'platform_admin_save', { p_caller_line_user_id: 'Uplatform', p_admin_id: null, p_line_user_id: U_ATTACKER, p_name: 'x', p_is_active: true, p_company_ids: `{${A}}` });
  check('anon 不能直接呼叫 platform_admin_save（必須經 Edge Function 驗 LIFF）', denied(r), r?.error);
  const paSave = (caller, adminId, uid, name, active, companies) => rpc('service_role', 'platform_admin_save', {
    p_caller_line_user_id: caller, p_admin_id: adminId, p_line_user_id: uid, p_name: name, p_is_active: active, p_company_ids: `{${companies.join(',')}}` });
  r = await paSave('Uadmin', null, U_ATTACKER, '攻擊者', true, [A]);
  check('公司 admin（非平台管理員）不能新增平台管理員', r?.error_code === 'access_denied', JSON.stringify(r));
  r = await paSave('Uplatform', null, U_NEWPA, '新平台管理員', true, [A, B]);
  const newPa = r?.id;
  check('平台管理員（LIFF 驗證後）新增平台管理員＋綁兩家公司：成功', r?.success === true
    && (await one(`SELECT count(*)::int AS n FROM public.platform_admin_companies WHERE platform_admin_id = $1`, [newPa])).n === 2, JSON.stringify(r));
  r = await paSave('Uplatform', null, 'not-a-line-id', 'x', true, [A]);
  check('LINE User ID 格式不符：拒絕', r?.error_code === 'invalid_line_user_id');
  r = await paSave('Uplatform', null, U_NEWPA, '重複', true, [A]);
  check('重複的 LINE User ID：拒絕', r?.error_code === 'duplicate');
  r = await paSave('Uplatform', newPa, 'Uignored', '改名', false, [B]);
  const edited = await one(`SELECT name, is_active, line_user_id FROM public.platform_admins WHERE id = $1`, [newPa]);
  const links = (await q(`SELECT company_id FROM public.platform_admin_companies WHERE platform_admin_id = $1`, [newPa])).map(x => x.company_id);
  check('修改：改名、停用、公司綁定重設為 B；不改 LINE ID', r?.success === true && edited.name === '改名' && edited.is_active === false && edited.line_user_id === U_NEWPA && links.length === 1 && links[0] === B);
  r = await paSave('Uplatform', PA, null, '平台', false, [A]);
  check('不能停用自己', r?.error_code === 'self_lockout');
  r = await paSave('Uplatform', PA, null, '平台', true, []);
  check('不能清空自己的公司綁定', r?.error_code === 'self_lockout');
  r = await paSave('Uplatform', null, 'U' + '2'.repeat(32), 'x', true, ['99999999-9999-9999-9999-999999999999']);
  check('綁不存在的公司：拒絕', r?.error_code === 'invalid_company');
  r = await rpc('service_role', 'platform_link_company_owner', { p_caller_line_user_id: 'Uplatform', p_company_id: B });
  check('平台管理員建立公司後綁自己為 owner：成功', r?.success === true
    && (await one(`SELECT role FROM public.platform_admin_companies WHERE platform_admin_id = $1 AND company_id = $2`, [PA, B])).role === 'owner');
  r = await rpc('service_role', 'platform_link_company_owner', { p_caller_line_user_id: 'Uadmin', p_company_id: B });
  check('非平台管理員不能綁公司', r?.error_code === 'access_denied');
  r = await rpc('authenticated', 'platform_link_company_owner', { p_caller_line_user_id: 'Uplatform', p_company_id: B });
  check('authenticated 不能直接呼叫 platform_link_company_owner', denied(r));

  console.log('\n=== 127：讀取 ===');
  await seed();
  for (const role of ['anon', 'authenticated']) {
    r = await as(role, `SELECT key, value FROM public.system_settings WHERE company_id = $1`, [A]);
    const keys = (r.rows || []).map(x => x.key);
    check(`${role} 讀不到 line_messaging_api（token 不外洩）`, !r.error && !keys.includes('line_messaging_api') && !JSON.stringify(r.rows).includes(TOKEN_A), keys.join(','));
    check(`${role} 仍讀得到一般設定（其他頁面不受影響）`, keys.includes('office_locations') && keys.includes('attendance_audit_enabled'));
  }
  const pol = (await q(`SELECT policyname, cmd FROM pg_policies WHERE tablename = 'system_settings' ORDER BY policyname`));
  check('system_settings 政策只剩一條唯讀（排除秘密列）＋ service_role', pol.length === 2 && pol.some(p => p.policyname === 'system_settings_read_non_secret' && p.cmd === 'SELECT') && pol.some(p => p.policyname === 'Service Role Full Access - settings'), pol.map(p => p.policyname + ':' + p.cmd).join(', '));

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

  console.log('\n=== admin_save_setting（前端 saveSetting → Edge Function 驗 LIFF → service role）===');
  const save = (role, uid, company, key, value) => rpc(role, 'admin_save_setting', {
    p_company_id: company, p_line_user_id: uid, p_key: key, p_value: value === undefined ? null : JSON.stringify(value), p_description: key });
  r = await save('anon', 'Uadmin', A, 'office_locations', []);
  check('anon 不能直接呼叫（身分不能自己報）', denied(r), r?.error);
  r = await save('authenticated', 'Uadmin', A, 'office_locations', []);
  check('authenticated 不能直接呼叫', denied(r));
  r = await save('service_role', 'Uadmin', A, 'office_locations', [{ name: '新地點' }]);
  check('A 管理員存 A 的一般設定：成功', r?.success === true && (await setting(A, 'office_locations'))[0].name === '新地點', JSON.stringify(r));
  r = await save('service_role', 'Uadmin', A, 'brand_new_key', { a: 1 });
  check('新 key 會 INSERT（含 company_id＝參數）', r?.success === true && (await setting(A, 'brand_new_key')).a === 1);
  r = await save('service_role', 'Uadmin', B, 'office_locations', []);
  check('A 管理員改 B 公司：拒絕，B 不變', r?.error_code === 'access_denied' && (await setting(B, 'office_locations'))[0].name === 'B 公司', JSON.stringify(r));
  r = await save('service_role', 'U1', A, 'office_locations', []);
  check('一般員工：拒絕', r?.error_code === 'access_denied');
  r = await save('service_role', 'Ukiosk', A, 'office_locations', []);
  check('公務機帳號（即使 role=manager）：拒絕', r?.error_code === 'access_denied');
  r = await save('service_role', 'Umgr', A, 'late_threshold_minutes', 5);
  check('主管存一般設定：成功', r?.success === true && (await setting(A, 'late_threshold_minutes')) === 5);
  r = await save('service_role', 'Umgr', A, 'payroll_password', { password: 'x' });
  check('主管存 payroll_password：拒絕（限管理員）', r?.error_code === 'admin_only');
  for (const key of ['line_admin_approver_employee_id', 'line_admin_notify_routes', 'line_daily_summary_target', 'line_monthly_budget',
    'line_monthly_quota', 'line_admin_group_member_count', 'line_notify_work_weekdays', 'line_notify_workday_min_checkins',
    'line_employee_reminder_days', 'line_frontend_push_limit_member_hour']) {
    r = await save('service_role', 'Umgr', A, key, 1);
    check(`主管存 ${key}：拒絕（LINE 推播控制限管理員）`, r?.error_code === 'admin_only');
  }
  r = await save('service_role', 'Uadmin', A, 'line_monthly_budget', 150);
  check('管理員存 line_monthly_budget：成功', r?.success === true && (await setting(A, 'line_monthly_budget')) === 150);
  r = await save('service_role', 'Uplatform', A, 'feature_visibility', { leave: true });
  check('平台管理員（有綁 A）存 A：成功', r?.success === true);
  r = await save('service_role', 'Uplatform', B, 'feature_visibility', { leave: true });
  check('平台管理員（沒綁 B）存 B：拒絕', r?.error_code === 'access_denied');
  r = await save('service_role', 'Uadmin', A, 'Bad Key;drop', 1);
  check('key 格式不符：拒絕', r?.error_code === 'invalid_key');
  r = await save('service_role', 'Uadmin', A, 'line_admin_approver_employee_id', undefined);
  check('value 為 null（取消指定審核人）存成 JSON null', r?.success === true && (await one(`SELECT jsonb_typeof(value) AS t FROM public.system_settings WHERE company_id = $1 AND key = 'line_admin_approver_employee_id'`, [A])).t === 'null');
  r = await save('service_role', 'Umgr', A, 'line_messaging_api', { groupId: 'Cnew' });
  check('代主管存 LINE token 設定：拒絕（限管理員）', r?.error_code === 'admin_only');
  r = await save('service_role', 'Uadmin', A, 'line_messaging_api', { groupId: 'Cnew' });
  let v = await setting(A, 'line_messaging_api');
  check('代管理員只改群組（沒帶 token）：沿用原 token', r?.success === true && v.token === TOKEN_A && v.groupId === 'Cnew', JSON.stringify(r));
  r = await save('service_role', 'Uadmin', A, 'line_messaging_api', { token: 'rotated-token-9999', groupId: 'Cnew' });
  v = await setting(A, 'line_messaging_api');
  check('代管理員換 token：成功', r?.success === true && v.token === 'rotated-token-9999');
  await db.exec(`GRANT EXECUTE ON FUNCTION public.admin_save_setting(uuid, text, text, jsonb, text) TO anon`);
  r = await save('anon', 'Uadmin', A, 'line_messaging_api', { token: 'attacker', groupId: 'Cattacker' });
  check('雙重保險：就算 grant 被誤開給 anon，前端仍不能直接存 LINE token', r?.error_code === 'verified_path_required' && (await setting(A, 'line_messaging_api')).token === 'rotated-token-9999');
  await db.exec(`REVOKE EXECUTE ON FUNCTION public.admin_save_setting(uuid, text, text, jsonb, text) FROM anon`);
  await db.query(`UPDATE public.system_settings SET value = $2 WHERE company_id = $1 AND key = 'line_messaging_api'`, [A, JSON.stringify({ token: TOKEN_A, groupId: 'CgroupA' })]);

  console.log('\n=== H1 攻擊鏈在 129 之後不成立 ===');
  r = await as('anon', `INSERT INTO public.platform_admins (line_user_id, name) VALUES ($1, '攻擊者')`, [U_ATTACKER]);
  r = await save('service_role', U_ATTACKER, A, 'line_messaging_api', { token: 'attacker', groupId: 'Cattacker' });
  check('攻擊者（真的 LINE 帳號、LIFF 驗證通過）無法藉自封平台管理員改 A 的 token', r?.error_code === 'access_denied' && (await setting(A, 'line_messaging_api')).token === TOKEN_A, JSON.stringify(r));

  console.log('\n=== get_line_messaging_config（設定頁經 Edge Function 讀，不回 token）===');
  r = await rpc('anon', 'get_line_messaging_config', { p_company_id: A, p_line_user_id: 'Uadmin' });
  check('anon 不能直接呼叫', denied(r));
  r = await rpc('service_role', 'get_line_messaging_config', { p_company_id: A, p_line_user_id: 'Uadmin' });
  check('管理員：看得到「已設定、末 4 碼、群組 ID」', r?.success === true && r.has_token === true && r.token_hint === '…1234' && r.group_id === 'CgroupA', JSON.stringify(r));
  check('回傳內容不含 token 本體', !JSON.stringify(r).includes(TOKEN_A));
  r = await rpc('service_role', 'get_line_messaging_config', { p_company_id: A, p_line_user_id: 'U1' });
  check('一般員工：拒絕', r?.error_code === 'access_denied');

  console.log('\n=== get_line_push_status：撤 PUBLIC execute（L6）===');
  const acl = await one(`SELECT
      EXISTS (SELECT 1 FROM pg_proc p, aclexplode(p.proacl) a WHERE p.proname = 'get_line_push_status' AND a.grantee = 0) AS public_exec,
      has_function_privilege('anon', 'public.get_line_push_status(uuid, text)', 'EXECUTE') AS anon_exec`);
  check('PUBLIC 不再有 execute，anon/authenticated 的明確 grant 保留（打卡總覽照常）', acl.public_exec === false && acl.anon_exec === true, JSON.stringify(acl));

  console.log('\n=== line_push_authorize（line-push Edge Function 用）===');
  const auth = (uid, target, emp, category, priority = 'normal') => rpc('service_role', 'line_push_authorize', {
    p_company_id: A, p_line_user_id: uid, p_target: target, p_employee_id: emp, p_category: category, p_priority: priority });
  r = await rpc('anon', 'line_push_authorize', { p_company_id: A, p_line_user_id: 'Uadmin', p_target: 'admin_group', p_employee_id: null, p_category: 'test', p_priority: 'normal' });
  check('anon 不能直接呼叫（會拿到 token）', denied(r), r?.error);
  r = await rpc('authenticated', 'can_manage_company_settings', { p_line_user_id: 'Uadmin', p_company_id: A });
  check('anon/authenticated 不能呼叫身分探測 helper', denied(r));
  r = await auth('U1', 'admin_group', null, 'leave');
  check('員工 → 主管群組（請假通知）：允許，收件人＝DB 的 groupId，token 由 DB 提供', r?.allowed === true && r.to === 'CgroupA' && r.token === TOKEN_A && r.recipient_kind === 'group', JSON.stringify({ ...r, token: r?.token ? '<redacted>' : null }));
  check('員工發的訊息帶寄件人前綴（M2）', r?.text_prefix === '［員工一 送出］\n', JSON.stringify(r?.text_prefix));
  const logRow = await one(`SELECT source, category, status, requested_by FROM public.line_push_log WHERE id = $1`, [r.log_id]);
  check('預約月預算並記下發起人（line_push_log reserved／source=frontend／requested_by）', logRow && logRow.status === 'reserved' && logRow.source === 'frontend' && logRow.category === 'leave' && logRow.requested_by === 'U1');
  r = await auth('U1', 'admin_group', null, 'test', 'high');
  check('員工發「測試推播」：拒絕（限主管）', r?.allowed === false && r.reason === 'manager_required');
  r = await auth('U1', 'admin_group', null, 'urgent_announcement', 'high');
  check('員工發「緊急公告」：拒絕（限主管）', r?.allowed === false && r.reason === 'manager_required');
  r = await auth('U1', 'employee', E.e2, 'leave_result');
  check('員工發「審核結果」給別人：拒絕（限主管）', r?.allowed === false && r.reason === 'manager_required');
  r = await auth('Uadmin', 'employee', E.e1, 'leave_result');
  check('主管 → 員工（審核結果）：收件人＝該員工的 LINE ID、不加寄件人前綴', r?.allowed === true && r.to === 'U1' && r.recipient_kind === 'user' && r.recipient_ref === E.e1 && r.text_prefix === '');
  r = await auth('Uadmin', 'employee', E.bUser, 'leave_result');
  check('主管 → 別家公司員工：拒絕', r?.allowed === false && r.reason === 'employee_not_found');
  r = await auth('U2', 'employee', E.e1, 'shift_swap_request');
  check('員工 → 同事（換班邀請）：允許、帶寄件人前綴', r?.allowed === true && r.to === 'U1' && r.text_prefix === '［員工二 送出］\n');
  r = await auth('UB1', 'admin_group', null, 'leave');
  check('別家公司員工替 A 發通知：拒絕', r?.allowed === false && r.reason === 'not_company_member');
  r = await auth('Unobody', 'admin_group', null, 'leave');
  check('不認識的 LINE 帳號：拒絕', r?.allowed === false && r.reason === 'not_company_member');
  r = await auth('U1', 'admin_group', null, 'admin_daily_summary');
  check('冒充 DB 排程類別（admin_daily_summary）：拒絕', r?.allowed === false && r.reason === 'category_not_allowed');
  r = await auth('U1', 'employee', E.e2, 'leave');
  check('主管通知類別不能改寄給員工：拒絕', r?.allowed === false && r.reason === 'target_not_allowed');
  r = await auth('U2', 'admin_group', null, 'leave', 'high');
  check('一般類別帶 high：降為 normal', r?.allowed === true && r.priority === 'normal');
  r = await auth('U2', 'admin_group', null, 'request_urgent', 'high');
  check('員工急迫報修帶 high：也降為 normal（M1：員工不能自選高優先）', r?.allowed === true && r.priority === 'normal');
  r = await auth('Uadmin', 'admin_group', null, 'test', 'high');
  check('主管測試推播：允許、高優先', r?.allowed === true && r.priority === 'high' && r.to === 'CgroupA');
  r = await auth('Uadmin', 'admin_group', null, 'urgent_announcement', 'high');
  check('主管緊急公告：高優先', r?.allowed === true && r.priority === 'high');
  r = await auth('U2', 'admin_approver', null, 'gps_review');
  check('指定審核人未設定 → 退回主管群組', r?.allowed === true && r.to === 'CgroupA');
  await db.query(`INSERT INTO public.system_settings (company_id, key, value) VALUES ($1, 'line_admin_approver_employee_id', $2::jsonb) ON CONFLICT (key, COALESCE(company_id, '00000000-0000-0000-0000-000000000000'::uuid)) DO UPDATE SET value = EXCLUDED.value`, [A, JSON.stringify(E.mgr)]);
  r = await auth('U2', 'admin_approver', null, 'gps_review');
  check('指定審核人已設定 → 私訊審核人（1 則）', r?.allowed === true && r.to === 'Umgr' && r.recipient_kind === 'user');
  await db.query(`UPDATE public.system_settings SET value = '"not-a-uuid"' WHERE company_id = $1 AND key = 'line_admin_approver_employee_id'`, [A]);
  r = await auth('U2', 'admin_approver', null, 'gps_review');
  check('審核人設定壞掉 → 退回群組，不報錯', r?.allowed === true && r.to === 'CgroupA');
  await db.query(`DELETE FROM public.system_settings WHERE company_id = $1 AND key = 'line_monthly_budget'`, [A]);
  await db.query(`INSERT INTO public.system_settings (company_id, key, value) VALUES ($1, 'line_monthly_budget', '0')`, [A]);
  r = await auth('Umgr', 'admin_group', null, 'leave');
  check('超過月預算：allowed=false、reason=budget_exceeded、不回 token', r?.allowed === false && r.reason === 'budget_exceeded' && !r.token);
  await db.query(`DELETE FROM public.system_settings WHERE company_id = $1 AND key = 'line_monthly_budget'`, [A]);
  await db.query(`UPDATE public.system_settings SET value = '{"token":"","groupId":"CgroupA"}' WHERE company_id = $1 AND key = 'line_messaging_api'`, [A]);
  r = await auth('Umgr', 'admin_group', null, 'leave');
  check('公司沒設定 token：missing_token', r?.allowed === false && r.reason === 'missing_token');
  await db.query(`UPDATE public.system_settings SET value = $2 WHERE company_id = $1 AND key = 'line_messaging_api'`, [A, JSON.stringify({ token: TOKEN_A, groupId: 'CgroupA' })]);

  console.log('\n=== 每人頻率限制（M1）===');
  await seed();
  let lastOk = null, n = 0;
  for (let i = 0; i < 12; i++) {
    r = await auth('U1', 'admin_group', null, 'leave');
    if (r?.allowed === true) { n++; lastOk = r; }
    else break;
  }
  check('一般員工 1 小時內預設最多 10 則，第 11 則 rate_limited', n === 10 && r?.allowed === false && r.reason === 'rate_limited' && r.hour_limit === 10 && !r.token, `${n} 則後 ${r?.reason}`);
  r = await auth('U2', 'admin_group', null, 'leave');
  check('限制是每個人各自算（員工二不受影響）', r?.allowed === true);
  r = await auth('Uadmin', 'employee', E.e1, 'leave_result');
  check('主管的額度另計（預設 60／小時）', r?.allowed === true);
  await db.query(`UPDATE public.line_push_log SET created_at = now() - interval '2 hours' WHERE requested_by = 'U1'`);
  r = await auth('U1', 'admin_group', null, 'leave');
  check('超過 1 小時後可再發（日上限 30 未到）', r?.allowed === true);
  await db.query(`INSERT INTO public.system_settings (company_id, key, value) VALUES ($1, 'line_frontend_push_limit_member_day', '11')`, [A]);
  r = await auth('U1', 'admin_group', null, 'leave');
  check('日上限可用 system_settings 調整（設 11 → 第 12 則擋下）', r?.allowed === false && r.reason === 'rate_limited' && r.day_limit === 11, JSON.stringify(r));
  const rlRows = await one(`SELECT count(*)::int AS n FROM public.line_push_log WHERE requested_by = 'U1'`);
  check('被頻率限制擋下的不寫紀錄、不佔月預算', rlRows.n === 11);

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
    await db2.exec('ROLLBACK');
    let err129 = '';
    try { await db2.exec(m129); } catch (e) { err129 = e.message; }
    check('129 不依賴 126／127（可單獨先套）', err129 === '', err129);
    await db2.close();
  }
  await db.exec(m127rb);
  const polRb = (await q(`SELECT policyname FROM pg_policies WHERE tablename = 'system_settings' ORDER BY policyname`)).map(p => p.policyname);
  check('127 回滾：7 條政策回到正式庫快照', polRb.length === 7 && polRb.includes('Allow RPC access settings') && polRb.includes('公開讀取系統設定'), polRb.join(', '));
  r = await as('anon', `INSERT INTO public.system_settings (company_id, key, value) VALUES ($1, 'rb_check', '1'::jsonb)`, [A]);
  check('127 回滾：anon 寫入 grant 恢復（舊頁面可用）', !r.error, r.error);
  await db.exec(m129rb);
  const paPol = (await q(`SELECT tablename || ':' || policyname || ':' || cmd AS p, qual, with_check FROM pg_policies WHERE tablename IN ('platform_admins','platform_admin_companies') ORDER BY 1`));
  check('129 回滾：兩表 8 條政策回到正式庫快照', paPol.length === 8 && paPol.every(p => (p.qual === null || p.qual === 'true') && (p.with_check === null || p.with_check === 'true')), paPol.map(p => p.p).join(', '));
  r = await as('anon', `INSERT INTO public.platform_admins (line_user_id, name) VALUES ($1, 'rb')`, ['U' + '3'.repeat(32)]);
  check('129 回滾：anon 寫入 grant 恢復', !r.error, r.error);
  const rpcGone = (await q(`SELECT count(*)::int AS n FROM pg_proc WHERE proname IN ('platform_admin_save','platform_link_company_owner')`))[0].n;
  check('129 回滾：RPC 移除', rpcGone === 0);
  await db.exec(m126rb);
  const fns = (await q(`SELECT proname FROM pg_proc WHERE proname IN ('line_push_authorize','admin_save_setting','get_line_messaging_config','can_manage_company_settings')`)).length;
  const col = (await q(`SELECT 1 FROM information_schema.columns WHERE table_name = 'line_push_log' AND column_name = 'requested_by'`)).length;
  const pubBack = (await one(`SELECT EXISTS (SELECT 1 FROM pg_proc p, aclexplode(p.proacl) a WHERE p.proname = 'get_line_push_status' AND a.grantee = 0) AS x`)).x;
  check('126 回滾：4 支函式、requested_by 欄位移除，get_line_push_status 的 PUBLIC execute 還原', fns === 0 && col === 0 && pubBack === true, `${fns}/${col}/${pubBack}`);
  let reErr = '';
  try { for (let i = 0; i < 2; i++) { await db.exec(m126); await db.exec(m129); await db.exec(m127); } } catch (e) { reErr = e.message; }
  check('126、129、127 可重複套用', reErr === '', reErr);

  console.log(`\n結果：${pass} 通過、${fail} 失敗`);
  process.exit(fail > 0 ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
