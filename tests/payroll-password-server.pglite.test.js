// ============================================================
// migration 133／134：薪酬密碼改伺服器端比對（bcrypt 雜湊＋錯誤次數限制＋短效解鎖）— PGlite 實跑
//
// 不連線、不寫正式庫。流程：
//   1. base schema ＋ 125 ＋ 正式庫 system_settings 政策快照 ＋ 126 ＋ 129（正式庫已套）＋ pgcrypto（extensions schema，同正式庫）
//   2. 套用前：重現「anon 讀得到薪酬密碼明碼」「anon 可直接改掉別家公司的薪酬密碼」
//   3. 套 133：現有頁面照舊（明碼仍在、一般設定照寫）；雜湊回填；比對／錯誤次數限制／短效解鎖／權限
//   4. 套 134：明碼消失、只剩 {configured}；新密碼經 admin_save_setting 存成雜湊；舊密碼失效
//   5. 回滾 134 → 133 後回到原狀、可重複套用
// 反向對照（證明測試在舊程式會失敗）：MIGRATION133_FILE／MIGRATION134_FILE 指向空檔 → 套用後的情境應大量失敗
// ============================================================
const fs = require('fs');
const path = require('path');
const { PGlite } = require('@electric-sql/pglite');
const { pgcrypto } = require('@electric-sql/pglite/contrib/pgcrypto');

const root = path.join(__dirname, '..');
const read = f => fs.readFileSync(f, 'utf8');
const baseSql = read(path.join(__dirname, 'fixtures', 'line_push_base_schema.sql'));
const prodRls = read(path.join(__dirname, 'fixtures', 'system_settings_prod_rls.sql'));
const m125 = read(path.join(root, 'migrations', '125_line_push_budget_and_digest.sql'));
const m126 = read(path.join(root, 'migrations', '126_line_push_server_token.sql'));
const m129 = read(path.join(root, 'migrations', '129_platform_admin_write_lock.sql'));
const m133 = read(process.env.MIGRATION133_FILE || path.join(root, 'migrations', '133_payroll_password_server_check.sql'));
const m134 = read(process.env.MIGRATION134_FILE || path.join(root, 'migrations', '134_payroll_password_strip_plaintext.sql'));
const m133rb = read(path.join(root, 'migrations', '133_payroll_password_server_check_rollback.sql'));
const m134rb = read(path.join(root, 'migrations', '134_payroll_password_strip_plaintext_rollback.sql'));

let pass = 0, fail = 0;
function check(name, condition, detail = '') {
  if (condition) { pass++; console.log(`  ✅ ${name}${detail ? `  → ${detail}` : ''}`); }
  else { fail++; console.log(`  ❌ ${name}${detail ? `  → ${detail}` : ''}`); }
}

const A = '8a669e2c-7521-43e9-9300-5c004c57e9db';
const B = '11111111-2222-3333-4444-555555555555';
const C = '33333333-4444-5555-6666-777777777777';   // 沒設薪酬密碼的公司
const PA = '00000000-0000-0000-0000-00000000fa01';
const PW_A = 'A-secret-88';
const PW_B = '4321';

(async () => {
  console.log('\n═══════════════════════════════════════');
  console.log('  薪酬密碼伺服器端比對（133／134，PGlite 實跑）');
  console.log('═══════════════════════════════════════');

  const db = new PGlite({ extensions: { pgcrypto } });
  const q = async (sql, params) => (await db.query(sql, params)).rows;
  const one = async (sql, params) => (await q(sql, params))[0];
  await db.exec(`CREATE SCHEMA IF NOT EXISTS extensions; CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA extensions;`);
  await db.exec(baseSql);
  await db.exec(m125);
  await db.exec(prodRls);
  await db.exec(m126);
  await db.exec(m129);

  async function as(role, sql, params) {
    try {
      await db.exec(`SET ROLE ${role}`);
      await db.query(`SELECT set_config('request.jwt.claims', $1, false)`, [JSON.stringify({ role })]);
      return { rows: (await db.query(sql, params)).rows };
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
  const denied = r => typeof r?.error === 'string' && /permission denied/.test(r.error);
  const flag = async (company) => { const v = await setting(company, 'payroll_password'); return v && Object.keys(v).length === 1 ? v.configured : undefined; };
  const setting = async (company, key) => (await one(`SELECT value FROM public.system_settings WHERE company_id = $1 AND key = $2`, [company, key]))?.value;
  const unlock = (uid, company, pw) => rpc('service_role', 'payroll_password_unlock', { p_company_id: company, p_line_user_id: uid, p_password: pw });
  const save = (uid, company, key, value) => rpc('service_role', 'admin_save_setting', { p_company_id: company, p_line_user_id: uid, p_key: key, p_value: JSON.stringify(value), p_description: key });
  const sx = async sql => { try { await db.exec(sql); } catch (e) { /* 反向對照（沒套 133）時表不存在 */ } };
  const tableExists = async t => !!(await one(`SELECT to_regclass($1) AS r`, ['public.' + t])).r;

  async function seed() {
    if (await tableExists('payroll_unlock_attempts')) await db.exec(`DELETE FROM public.payroll_unlock_attempts; DELETE FROM public.payroll_unlock_grants;`);
    await db.exec(`
      ALTER TABLE public.system_settings DISABLE TRIGGER USER;
      TRUNCATE public.line_push_log, public.system_settings CASCADE;
      DELETE FROM public.platform_admin_companies; DELETE FROM public.platform_admins;
      DELETE FROM public.employees; DELETE FROM public.companies;
      INSERT INTO public.companies (id, name) VALUES ('${A}', '大正科技'), ('${B}', '本米'), ('${C}', '沒設密碼');
      INSERT INTO public.employees (company_id, employee_number, name, line_user_id, role, is_kiosk, is_active) VALUES
        ('${A}', 'A01', '主管甲', 'Uadmin', 'admin', false, true),
        ('${A}', 'E01', '員工一', 'U1', 'user', false, true),
        ('${A}', 'E02', '員工二', 'U2', 'user', false, true),
        ('${A}', 'E09', '離職', 'Uquit', 'user', false, false),
        ('${B}', 'B01', '別家員工', 'UB1', 'user', false, true),
        ('${C}', 'C01', 'C 員工', 'UC1', 'user', false, true);
      INSERT INTO public.platform_admins (id, line_user_id, name) VALUES ('${PA}', 'Uplatform', '平台');
      INSERT INTO public.platform_admin_companies (platform_admin_id, company_id, role) VALUES ('${PA}', '${A}', 'owner');
      INSERT INTO public.system_settings (company_id, key, value) VALUES
        ('${A}', 'payroll_password', '{"password":"${PW_A}"}'),
        ('${B}', 'payroll_password', '{"password":"${PW_B}"}'),
        ('${A}', 'office_locations', '[{"name":"總公司"}]');
      ALTER TABLE public.system_settings ENABLE TRIGGER USER;
    `);
  }
  // seed 繞過 trigger 直接放明碼（模擬正式庫現況，也不受前一段已套的 134 影響）；133 之後要把雜湊補上
  const backfill = async () => sx(`
    INSERT INTO public.payroll_password_secrets (company_id, password_hash)
    SELECT company_id, extensions.crypt(value->>'password', extensions.gen_salt('bf', 4)) FROM public.system_settings
    WHERE key = 'payroll_password' AND COALESCE(value->>'password', '') <> ''
    ON CONFLICT (company_id) DO UPDATE SET password_hash = EXCLUDED.password_hash`);

  // ---------- 1. 套用前 ----------
  console.log('\n=== 套用前（正式庫現況）：重現問題 ===');
  await seed();
  let r = await as('anon', `SELECT value->>'password' AS p FROM public.system_settings WHERE key = 'payroll_password' AND company_id = $1`, [A]);
  check('現況重現：anon 讀得到 A 公司薪酬密碼明碼', r.rows?.[0]?.p === PW_A);
  r = await as('anon', `UPDATE public.system_settings SET value = '{"password":"hacked"}' WHERE key = 'payroll_password' AND company_id = $1`, [B]);
  check('現況重現：anon 可直接改掉 B 公司的薪酬密碼', !r.error && (await setting(B, 'payroll_password')).password === 'hacked');

  // ---------- 2. 套 133 ----------
  console.log('\n=== 套 133（純新增，現有頁面行為不變）===');
  await seed();
  let ok = true;
  try { await db.exec(m133); } catch (e) { ok = false; check('133 可在 PostgreSQL 套用', false, e.message); }
  if (ok) check('133 可在 PostgreSQL 套用', true);

  const secretRows = await tableExists('payroll_password_secrets')
    ? await q(`SELECT company_id, password_hash FROM public.payroll_password_secrets ORDER BY company_id`) : [];
  check('回填：兩家有設密碼的公司都有雜湊、C 公司沒有', secretRows.length === 2 && !secretRows.some(x => x.company_id === C));
  check('雜湊是 bcrypt（$2a$10$、自帶 salt）且不含明碼', secretRows.length === 2 && secretRows.every(x => /^\$2a\$10\$/.test(x.password_hash) && !x.password_hash.includes(PW_A) && !x.password_hash.includes(PW_B)));
  check('133 不動明碼（舊快取頁面還能比對）', (await setting(A, 'payroll_password'))?.password === PW_A);

  for (const role of ['anon', 'authenticated']) {
    r = await as(role, `SELECT * FROM public.payroll_password_secrets`);
    check(`${role} 讀不到雜湊表`, denied(r), r.error);
    r = await as(role, `SELECT * FROM public.payroll_unlock_grants`);
    check(`${role} 讀不到解鎖紀錄`, denied(r), r.error);
    r = await as(role, `UPDATE public.system_settings SET value = '{"password":"hacked"}' WHERE key = 'payroll_password' AND company_id = $1`, [B]);
    check(`${role} 不能直接改薪酬密碼（127 前也擋）`, !!r.error && (await setting(B, 'payroll_password'))?.password === PW_B, r.error);
    r = await as(role, `DELETE FROM public.system_settings WHERE key = 'payroll_password' AND company_id = $1`, [B]);
    check(`${role} 不能直接刪薪酬密碼`, !!r.error && !!(await setting(B, 'payroll_password')), r.error);
    r = await as(role, `INSERT INTO public.system_settings (company_id, key, value) VALUES ($1, 'payroll_password', '{"password":"x"}')`, [C]);
    check(`${role} 不能替沒設密碼的公司新增薪酬密碼`, !!r.error, r.error);
    r = await rpc(role, 'payroll_password_unlock', { p_company_id: A, p_line_user_id: 'U1', p_password: PW_A });
    check(`${role} 不能直接呼叫 payroll_password_unlock（必須經 Edge Function 驗 LIFF）`, denied(r), r?.error);
    r = await rpc(role, 'payroll_unlock_check', { p_company_id: A, p_line_user_id: 'U1', p_token: 'x' });
    check(`${role} 不能直接呼叫 payroll_unlock_check`, denied(r), r?.error);
  }
  r = await as('anon', `UPDATE public.system_settings SET value = '[{"name":"改"}]' WHERE key = 'office_locations' AND company_id = $1`, [A]);
  check('133 只管 payroll_password：其他設定的現況（127 前 anon 可寫）不受影響', !r.error);

  console.log('\n=== 133：伺服器端比對 ===');
  r = await unlock('U1', A, PW_A);
  check('員工輸入正確密碼：成功、回 64 碼 unlock_token', r?.success === true && /^[0-9a-f]{64}$/.test(r.unlock_token || '') && r.configured === true, JSON.stringify(r));
  const token = r?.unlock_token;
  const exp = r?.expires_at ? new Date(r.expires_at).getTime() : 0;
  check('解鎖最多 12 小時', exp > Date.now() && exp <= Date.now() + 12 * 3600 * 1000 + 5000);
  const taipeiMidnight = (() => { const d = new Date(Date.now() + 8 * 3600 * 1000); d.setUTCHours(24, 0, 0, 0); return d.getTime() - 8 * 3600 * 1000; })();
  check('解鎖不跨台北午夜（同舊版「當日有效」）', exp <= taipeiMidnight + 1000);
  check('DB 只存 token 的 SHA-256，不存原值', !!token && !(await one(`SELECT count(*)::int AS n FROM public.payroll_unlock_grants WHERE token_sha256 = $1`, [token])).n
    && (await one(`SELECT count(*)::int AS n FROM public.payroll_unlock_grants WHERE token_sha256 = encode(extensions.digest($1, 'sha256'), 'hex')`, [token])).n === 1);
  check('payroll_unlock_check：同人同公司有效', (await rpc('service_role', 'payroll_unlock_check', { p_company_id: A, p_line_user_id: 'U1', p_token: token })) === true);
  check('payroll_unlock_check：換人用同一個 token 無效', (await rpc('service_role', 'payroll_unlock_check', { p_company_id: A, p_line_user_id: 'U2', p_token: token })) === false);
  check('payroll_unlock_check：換公司無效', (await rpc('service_role', 'payroll_unlock_check', { p_company_id: B, p_line_user_id: 'U1', p_token: token })) === false);
  await sx(`UPDATE public.payroll_unlock_grants SET expires_at = now() - interval '1 second'`);
  check('payroll_unlock_check：過期無效', (await rpc('service_role', 'payroll_unlock_check', { p_company_id: A, p_line_user_id: 'U1', p_token: token })) === false);

  r = await unlock('U1', A, PW_B);
  check('用別家公司的密碼：wrong_password', r?.error_code === 'wrong_password' && !r.unlock_token);
  r = await unlock('UB1', A, PW_A);
  check('別家公司員工（即使知道密碼）：access_denied', r?.error_code === 'access_denied');
  r = await unlock('Uquit', A, PW_A);
  check('離職員工：access_denied', r?.error_code === 'access_denied');
  r = await unlock('Unobody', A, PW_A);
  check('陌生 LINE 帳號：access_denied', r?.error_code === 'access_denied');
  r = await unlock('Uplatform', A, PW_A);
  check('綁定該公司的平台管理員：成功', r?.success === true);
  r = await unlock('UB1', B, PW_B);
  check('B 公司員工用 B 密碼：成功（各公司各自比對）', r?.success === true);
  r = await unlock('UC1', C, '0000');
  check('沒設密碼的公司：沿用舊預設 0000、configured=false', r?.success === true && r.configured === false);
  r = await unlock('UC1', C, '1234');
  check('沒設密碼的公司：其他密碼不行', r?.error_code === 'wrong_password');
  r = await unlock('U1', A, '');
  check('空密碼：bad_request（不算錯誤次數）', r?.error_code === 'bad_request');

  console.log('\n=== 133：錯誤次數限制 ===');
  await sx(`DELETE FROM public.payroll_unlock_attempts`);
  for (let i = 0; i < 5; i++) await unlock('U2', A, 'guess' + i);
  r = await unlock('U2', A, PW_A);
  check('同一人 15 分鐘內錯 5 次：之後連正確密碼也 rate_limited', r?.error_code === 'rate_limited' && !r.unlock_token);
  r = await unlock('U1', A, PW_A);
  check('其他人不受影響', r?.success === true);
  await sx(`UPDATE public.payroll_unlock_attempts SET created_at = now() - interval '16 minutes'`);
  r = await unlock('U2', A, PW_A);
  check('15 分鐘後恢復', r?.success === true);
  await sx(`DELETE FROM public.payroll_unlock_attempts;
    INSERT INTO public.payroll_unlock_attempts (company_id, line_user_id, success)
    SELECT '${A}', 'Ux' || g, false FROM generate_series(1, 10) g`);
  r = await unlock('U1', A, PW_A);
  check('整家公司 15 分鐘內有 10 個不同帳號打錯（換帳號撞庫）：全公司暫停', r?.error_code === 'rate_limited');
  await sx(`DELETE FROM public.payroll_unlock_attempts;
    INSERT INTO public.payroll_unlock_attempts (company_id, line_user_id, success)
    SELECT '${A}', 'U2', false FROM generate_series(1, 30) g`);
  r = await unlock('U1', A, PW_A);
  check('單一員工故意錯 30 次：只鎖他自己，不會把全公司（含管理員）鎖住', r?.success === true && (await unlock('U2', A, PW_A))?.error_code === 'rate_limited');
  r = await unlock('U1', A, '密'.repeat(25));
  check('密碼超過 72 bytes（bcrypt 上限）：bad_request', r?.error_code === 'bad_request');
  r = await save('Uadmin', A, 'payroll_password', { password: '密'.repeat(25) });
  check('管理員設定超過 72 bytes 的密碼：拒絕、原密碼不變', r?.success !== true && (await unlock('U1', A, PW_A))?.success === true);
  check('解鎖以 advisory lock 排隊（並行請求不能繞過次數上限；PGlite 單連線無法實測並行）',
    /pg_advisory_xact_lock\(hashtextextended\('payroll_unlock:'/.test(m133));
  check('嘗試紀錄不含密碼欄位', !(await q(`SELECT column_name FROM information_schema.columns WHERE table_name = 'payroll_unlock_attempts'`)).some(c => /pass/.test(c.column_name)));
  await sx(`DELETE FROM public.payroll_unlock_attempts`);

  console.log('\n=== 133：管理員改密碼（admin_save_setting）同步雜湊 ===');
  r = await save('Uadmin', A, 'payroll_password', { password: 'new-A-pw' });
  check('admin 經 admin_save_setting 改密碼：成功', r?.success === true, JSON.stringify(r));
  check('新密碼立即可用、舊密碼失效', (await unlock('U1', A, 'new-A-pw'))?.success === true && (await unlock('U1', A, PW_A))?.error_code === 'wrong_password');
  check('133 仍保留明碼（給舊快取頁面）', (await setting(A, 'payroll_password'))?.password === 'new-A-pw');
  r = await save('U1', A, 'payroll_password', { password: 'evil' });
  check('一般員工不能改密碼（126 的 admin_only 照舊）', r?.error_code === 'access_denied' || r?.error_code === 'admin_only');
  r = await save('Uadmin', C, 'payroll_password', { password: 'c-pw' });
  check('別家公司 admin 不能替 C 設密碼', r?.success !== true);

  // ---------- 3. 套 134 ----------
  console.log('\n=== 套 134（移除明碼）===');
  await seed();
  await backfill();
  ok = true;
  try { await db.exec(m134); } catch (e) { ok = false; check('134 可在 133 之後套用', false, e.message); }
  if (ok) check('134 可在 133 之後套用', true);
  const plain = await q(`SELECT company_id FROM public.system_settings WHERE key = 'payroll_password' AND value ? 'password'`);
  check('system_settings 再也沒有任何明碼', plain.length === 0, plain.length + ' 列');
  check('A、B 只剩 {"configured": true}', (await flag(A)) === true && (await flag(B)) === true, JSON.stringify(await setting(A, 'payroll_password')));
  r = await as('anon', `SELECT value FROM public.system_settings WHERE key = 'payroll_password'`);
  check('anon 讀到的只有 configured 旗標（密碼與雜湊都讀不到）', !r.error && r.rows.length === 2 && !JSON.stringify(r.rows).includes(PW_A) && !JSON.stringify(r.rows).includes('$2a$'));
  check('既有密碼在 134 後照樣能解鎖', (await unlock('U1', A, PW_A))?.success === true && (await unlock('UB1', B, PW_B))?.success === true);
  r = await save('Uadmin', A, 'payroll_password', { password: 'after-134' });
  check('134 後 admin 改密碼：DB 仍只存 configured', r?.success === true && (await flag(A)) === true);
  check('134 後新密碼可用、舊的失效', (await unlock('U1', A, 'after-134'))?.success === true && (await unlock('U1', A, PW_A))?.error_code === 'wrong_password');
  r = await save('Uadmin', A, 'payroll_password', { password: '' });
  check('清空密碼：雜湊刪除、旗標 configured=false、回到預設 0000', r?.success === true && (await flag(A)) === false
    && (await unlock('U1', A, '0000'))?.success === true);

  console.log('\n=== 134 順序防呆 ===');
  await seed();
  await db.exec(m134rb); await db.exec(m133rb);
  r = null;
  try { await db.exec(m134); } catch (e) { r = e.message; await db.exec('ROLLBACK').catch(() => {}); }
  check('沒套 133 就套 134：中止', !!r && /133/.test(r), r);
  await db.exec(m133);
  await db.exec(`DELETE FROM public.payroll_password_secrets WHERE company_id = '${B}'`);
  r = null;
  try { await db.exec(m134); } catch (e) { r = e.message; await db.exec('ROLLBACK').catch(() => {}); }
  check('有公司缺雜湊：134 中止、明碼不被抹掉（不會把密碼弄丟）', !!r && (await setting(B, 'payroll_password'))?.password === PW_B, r + ' / ' + JSON.stringify(await setting(B, 'payroll_password')));

  console.log('\n=== 回滾 ===');
  await seed();
  await db.exec(m133); await db.exec(m134);
  await db.exec(m134rb);
  r = await save('Uadmin', A, 'payroll_password', { password: 'rb-pw' });
  check('回滾 134 後：admin 重設密碼會存回明碼（舊版前端可用）＋同步雜湊', r?.success === true && (await setting(A, 'payroll_password'))?.password === 'rb-pw'
    && (await unlock('U1', A, 'rb-pw'))?.success === true);
  r = null;
  try { await db.exec(m133rb); } catch (e) { r = e.message; await db.exec('ROLLBACK').catch(() => {}); }
  check('B 公司密碼只剩雜湊時回滾 133：中止（不會默默把密碼弄丟）', !!r && /134/.test(r) && (await tableExists('payroll_password_secrets')), r);
  await save('Uadmin', B, 'payroll_password', { password: 'rb-pw-b' });
  await db.exec(`INSERT INTO public.employees (company_id, employee_number, name, line_user_id, role, is_kiosk, is_active) VALUES ('${B}', 'B09', 'B 管理員', 'UBadmin', 'admin', false, true)`);
  r = await save('UBadmin', B, 'payroll_password', { password: 'rb-pw-b' });
  check('B 管理員重設密碼後（存回明碼）', r?.success === true && (await setting(B, 'payroll_password'))?.password === 'rb-pw-b');
  await db.exec(m133rb);
  const leftovers = await q(`SELECT tgname FROM pg_trigger WHERE tgrelid = 'public.system_settings'::regclass AND tgname LIKE 'trg_payroll%'`);
  check('回滾 133：trigger、表、函式全部移除', leftovers.length === 0 && !(await tableExists('payroll_password_secrets'))
    && !(await one(`SELECT to_regprocedure('public.payroll_password_unlock(uuid, text, text)') AS r`)).r);
  r = await as('anon', `UPDATE public.system_settings SET value = '{"password":"x"}' WHERE key = 'payroll_password' AND company_id = $1`, [B]);
  check('回滾 133 後回到正式庫現況（anon 可寫，由 127 另行處理）', !r.error);
  await seed();
  ok = true;
  try { await db.exec(m133); await db.exec(m133); await db.exec(m134); await db.exec(m134); } catch (e) { ok = false; check('133／134 可重複套用', false, e.message); }
  if (ok) check('133／134 可重複套用', true);

  console.log(`\n結果：${pass} 通過、${fail} 失敗`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('  ❌ 中途失敗：' + e.message); console.log(`
結果：${pass} 通過、${fail + 1} 失敗`); process.exit(1); });
