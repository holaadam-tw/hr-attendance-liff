// ============================================================
// migration 141：P1 Phase 2 —— RPC 呼叫者身分 soft mode（wrapper＋assert_caller）— PGlite 實跑
//
// 不連線、不寫正式庫。流程：
//   1. 正式庫快照（phase0＋attendance_schedules fixtures；quick_check_in 等 4 支是正式庫原文，本體 md5 與正式庫逐支相同）＋ auth schema 替身
//      替身 50 支的本體與正式庫不同 → 只在測試用的 141 副本裡，把這 50 支的 md5 指紋換成替身的 md5（正式庫原文 4 支不換）
//      ＋ 其餘 50 支 wrapper 對象以「正式庫的參數／預設值／回傳型別／volatility／proacl」建立可重現的替身函式
//      （回傳值由所有參數決定，能驗出參數順序、預設值、型別有沒有傳錯）
//   2. 依上線順序套 130～135、138、139、140（141 的前提），記錄套用前狀態與每支函式的呼叫結果
//   3. 套 141：54 支 wrapper 的呼叫結果與套用前逐支相同（anon／authenticated 相符／不符／service role）；
//      正式庫原文的打卡／補卡流程結果相同；soft mode 記錄內容、永不擋（含唯讀交易、設定缺漏）
//   4. enforce：沒有 session 或不符 → 拒絕；相符、service role → 放行；逐支覆寫；預先設為 soft 的註冊類不受影響
//   5. 權限：wrapper 與原函式 proacl 逐項相同；*_impl、assert_caller、設定／紀錄表 anon／authenticated 碰不到
//   6. 清單／指紋防呆（多一支、少一支、本體 md5／權限／設定與正式庫快照不同、138 未套、重複套用）→ 中止；
//      回滾前 wrapper 被改掉 → 中止；回滾後所有函式定義與權限與套用前逐項相同；可重套
//   7. 產生器：重新產生的 migration 與 repo 內的檔案逐字相同
// 反向對照：MIGRATION141_FILE 指向空檔 → 大量失敗
// ============================================================
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { PGlite } = require('@electric-sql/pglite');

const root = path.join(__dirname, '..');
// 換行一律正規化成 LF（Windows checkout 會變 CRLF，函式本體 md5 會跟正式庫不同）
const read = f => fs.readFileSync(f, 'utf8').replace(/\r\n/g, '\n');
const snapshot = read(path.join(__dirname, 'fixtures', 'phase0_prod_snapshot.sql'))
  + '\n' + read(path.join(__dirname, 'fixtures', 'attendance_schedules_prod_snapshot.sql'));
const mig = n => read(path.join(root, 'migrations', n));
const base = ['130_companies_binding_attempts_lock.sql', '131_verified_admin_rpcs.sql', '132_verified_admin_rpcs_revoke.sql',
  '133_shift_swap_verified_review.sql', '134_attendance_write_lock.sql', '135_schedules_write_lock.sql',
  '138_line_auth_phase1.sql', '139_shift_swap_verified_requests.sql', '140_shift_swap_write_lock.sql'].map(mig);
let m141 = read(process.env.MIGRATION141_FILE || path.join(root, 'migrations', '141_line_auth_rpc_wrappers.sql'));
const m141rb = mig('141_line_auth_rpc_wrappers_rollback.sql');
const inventory = JSON.parse(read(path.join(root, 'scripts', 'line-auth', 'rpc_inventory.json'))).functions;
const wrappedList = JSON.parse(read(path.join(root, 'scripts', 'line-auth', 'wrapped_rpcs.json')));
const WRAPPED = inventory.filter(f => wrappedList.functions.includes(`${f.name}(${f.identity_args})`));

let pass = 0, fail = 0;
function check(name, condition, detail = '') {
  if (condition) { pass++; console.log(`  ✅ ${name}${detail ? `  → ${detail}` : ''}`); }
  else { fail++; console.log(`  ❌ ${name}${detail ? `  → ${String(detail).slice(0, 400)}` : ''}`); }
}

const AUTH_STUB = `
CREATE SCHEMA IF NOT EXISTS auth;
CREATE TABLE IF NOT EXISTS auth.users (id UUID PRIMARY KEY, email TEXT, raw_app_meta_data JSONB, raw_user_meta_data JSONB, created_at TIMESTAMPTZ DEFAULT now());
CREATE OR REPLACE FUNCTION auth.jwt() RETURNS jsonb LANGUAGE sql STABLE AS $f$
  select coalesce(nullif(current_setting('request.jwt.claim', true), ''), nullif(current_setting('request.jwt.claims', true), ''))::jsonb
$f$;
CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $f$
  select coalesce(nullif(current_setting('request.jwt.claim.sub', true), ''), (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub'))::uuid
$f$;
GRANT USAGE ON SCHEMA auth TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION auth.jwt(), auth.uid() TO anon, authenticated, service_role;
`;

const A = '8a669e2c-7521-43e9-9300-5c004c57e9db';
const B = '11111111-2222-3333-4444-555555555555';
const L = { admin: 'U' + 'a'.repeat(32), e1: 'U' + '1'.repeat(32), e3: 'U' + '3'.repeat(32), e5: 'U' + '5'.repeat(32), kiosk: 'U' + 'c'.repeat(32), other: 'U' + 'f'.repeat(32) };
const E = { admin: '00000000-0000-0000-0000-0000000000a1', e1: '00000000-0000-0000-0000-0000000000e1', e3: '00000000-0000-0000-0000-0000000000e3', e5: '00000000-0000-0000-0000-0000000000e5', kiosk: '00000000-0000-0000-0000-0000000000c1' };
const sha = s => require('crypto').createHash('sha256').update(s, 'utf8').digest('hex');

// ---- 替身函式：簽名／預設值／回傳型別／volatility／proacl 全照正式庫，回傳值由所有參數決定 ----
function splitTop(s) {
  const out = []; let depth = 0, cur = '';
  for (const ch of s) {
    if (ch === '(') depth++;
    if (ch === ')') depth--;
    if (ch === ',' && depth === 0) { out.push(cur.trim()); cur = ''; } else cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}
function valueFor(type, g, key) {
  const t = type.toLowerCase();
  if (t === 'text' || t === 'character varying') return `(${key} || '#' || ${g})::${type}`;
  if (t === 'integer' || t === 'bigint') return `(length(${key}) + ${g})::${type}`;
  if (t === 'numeric' || t === 'double precision') return `(length(${key}) * 1.5 + ${g})::${type}`;
  if (t === 'uuid') return `md5(${key} || ${g})::uuid`;
  if (t === 'date') return `('2026-10-01'::date + (length(${key}) % 20) + ${g})`;
  if (t === 'boolean') return `(length(${key}) % 2 = ${g} % 2)`;
  if (t.startsWith('timestamp')) return `('2026-10-01 08:00+08'::timestamptz + (length(${key}) + ${g}) * interval '1 minute')::${type}`;
  if (t.startsWith('time')) return `('08:00'::time + (length(${key}) + ${g}) * interval '1 minute')::${type}`;
  if (t === 'jsonb' || t === 'json') return `jsonb_build_object('k', ${key}, 'g', ${g})::${type}`;
  return `NULL::${type}`;
}
function stubSql(f) {
  const ins = f.argnames.filter((_, i) => !f.argmodes || f.argmodes[i] === 'i');
  const key = `concat_ws('|', '${f.name}', ${ins.map((_, i) => `coalesce($${i + 1}::text, '∅')`).join(', ')})`;
  let body;
  if (f.retset) {
    const cols = splitTop(f.result.replace(/^TABLE\(/, '').replace(/\)$/, '')).map(c => {
      const m = c.match(/^("[^"]+"|\S+)\s+(.+)$/);
      return m[2];
    });
    body = `RETURN QUERY SELECT ${cols.map(t => valueFor(t, 'g', 'k')).join(', ')} FROM (SELECT ${key} AS k) s, generate_series(1, 1 + length(s.k) % 3) g;`;
  } else if (f.result === 'void') {
    body = `INSERT INTO public.test_stub_calls (fn, k) VALUES ('${f.name}', ${key});`;
  } else if (f.result === 'jsonb' || f.result === 'json') {
    body = `RETURN jsonb_build_object('fn', '${f.name}', 'args', jsonb_build_array(${ins.map((_, i) => `$${i + 1}`).join(', ')}))::${f.result};`;
  } else {
    body = `RETURN (SELECT ${valueFor(f.result, 0, 'k')} FROM (SELECT ${key} AS k) s);`;
  }
  const vol = { s: 'STABLE', v: 'VOLATILE', i: 'IMMUTABLE' }[f.volatility];
  const grants = (f.acl || '').replace(/^\{|\}$/g, '').split(',').filter(Boolean).map(e => e.split('=')[0]).filter(g => g !== 'postgres')
    .map(g => `GRANT EXECUTE ON FUNCTION public.${f.name}(${f.identity_args}) TO ${g === '' ? 'PUBLIC' : g};`).join('\n');
  return `CREATE FUNCTION public.${f.name}(${f.args}) RETURNS ${f.result} LANGUAGE plpgsql ${vol} SECURITY DEFINER
${(f.config || []).map(c => `SET ${c.split('=')[0]} = ${c.split('=').slice(1).join('=')}`).join('\n')}
AS $stub$ BEGIN ${body} END; $stub$;
REVOKE ALL ON FUNCTION public.${f.name}(${f.identity_args}) FROM PUBLIC, anon, authenticated, service_role;
${grants}
`;
}
// 代表性參數值
function argValue(name, type) {
  const t = type.toLowerCase();
  if (name === 'p_line_user_id') return `'${L.e1}'::text`;
  if (name === 'p_company_id') return `'${A}'::uuid`;
  if (name === 'p_year') return '2026';
  if (name === 'p_month') return '10';
  if (t === 'uuid') return `'${E.e3}'::uuid`;
  if (t === 'text' || t === 'character varying') return `'v_${name}'::${type}`;
  if (t === 'integer') return '7';
  if (t === 'numeric') return '1.5';
  if (t === 'double precision') return '25.03';
  if (t === 'boolean') return 'true';
  if (t === 'date') return `'2026-10-05'::date`;
  if (t.startsWith('time')) return `'08:30'::time`;
  if (t === 'jsonb') return `'{"k":1}'::jsonb`;
  throw new Error('no value for ' + type);
}
// 每支函式兩種呼叫：全部參數、只給必要參數（有預設值的省略）
function callsFor(f) {
  const args = splitTop(f.args).map(a => {
    const m = a.match(/^(\S+)\s+(.+?)(?:\s+DEFAULT\s+(.+))?$/);
    return { name: m[1], type: m[2], hasDefault: !!m[3] };
  });
  const mk = list => list.map(a => `${a.name} => ${argValue(a.name, a.type)}`).join(', ');
  const out = [mk(args)];
  if (args.some(a => a.hasDefault)) out.push(mk(args.filter(a => !a.hasDefault || a.name === 'p_line_user_id')));
  return out.map(named => f.retset
    ? `SELECT coalesce(jsonb_agg(to_jsonb(r)), '[]'::jsonb)::text AS v FROM public.${f.name}(${named}) r`
    : `SELECT public.${f.name}(${named})::text AS v`);
}
const STUB_FREE = ['quick_check_in', 'quick_check_out_after_clock_in_makeup', 'submit_makeup_punch', 'admin_makeup_punch'];

(async () => {
  console.log('\n═══════════════════════════════════════');
  console.log('  P1 Phase 2：RPC 呼叫者身分 soft mode（141，PGlite 實跑）');
  console.log('═══════════════════════════════════════');

  const db = new PGlite();
  const q = async (sql, params) => (await db.query(sql, params)).rows;
  const one = async (sql, params) => (await q(sql, params))[0];
  await db.exec(snapshot);
  await db.exec(AUTH_STUB);
  await db.exec(`CREATE TABLE public.test_stub_calls (id serial PRIMARY KEY, fn text, k text); ALTER TABLE public.test_stub_calls OWNER TO prod_postgres;`);

  const claimsFor = (role, line) => role === 'anon' ? { role: 'anon' }
    : role === 'service_role' ? { role: 'service_role' }
    : role === 'postgres' ? null
    : { role: 'authenticated', sub: '00000000-0000-4000-8000-000000000001', app_metadata: line ? { line_user_id: line } : {} };
  async function as(role, line, sql, params, { readOnly = false } = {}) {
    try {
      if (readOnly) await db.exec('BEGIN READ ONLY');
      if (role !== 'postgres') await db.exec(`SET ROLE ${role}`);
      const c = claimsFor(role, line);
      await db.query(`SELECT set_config('request.jwt.claims', $1, false)`, [c ? JSON.stringify(c) : '']);
      const rows = (await db.query(sql, params)).rows;
      if (readOnly) await db.exec('COMMIT');
      return { rows };
    } catch (e) {
      if (readOnly) { try { await db.exec('ROLLBACK'); } catch (_) { /* */ } }
      return { error: e.message, code: e.code };
    } finally {
      await db.exec('RESET ROLE');
      await db.query(`SELECT set_config('request.jwt.claims', '', false)`);
    }
  }
  async function apply(sql) {
    try {
      await db.exec('SET ROLE prod_postgres');
      await db.exec(sql);
      return '';
    } catch (e) {
      try { await db.exec('ROLLBACK'); } catch (_) { /* 沒有進行中的交易 */ }
      return e.message;
    } finally {
      await db.exec('RESET ROLE');
    }
  }
  const denied = r => typeof r?.error === 'string' && /permission denied/.test(r.error);

  // ---------- 0. 起點 ----------
  let err = '';
  for (const m of base) err = err || await apply(m);
  check('起點：以正式庫擁有者身分套 130～135、138、139、140', err === '', err);
  const have = new Set((await q(`SELECT proname || '(' || pg_get_function_identity_arguments(oid) || ')' AS k FROM pg_proc WHERE pronamespace = 'public'::regnamespace`)).map(r => r.k));
  const stubs = WRAPPED.filter(f => !have.has(`${f.name}(${f.identity_args})`));
  check('正式庫原文的 4 支（打卡／補卡）在快照裡，其餘 50 支用替身', stubs.length === 50 && STUB_FREE.every(n => WRAPPED.some(f => f.name === n) && !stubs.some(s => s.name === n)),
    `${stubs.length} 支替身`);
  err = await apply(stubs.map(stubSql).join('\n'));
  check('替身函式以正式庫簽名／proacl 建立', err === '', err);
  const drift = [];
  for (const f of WRAPPED) {
    const r = await one(`SELECT pg_get_function_arguments(p.oid) AS a, pg_get_function_result(p.oid) AS r, p.prosecdef AS s, p.provolatile AS v
      FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname = $1 AND pg_get_function_identity_arguments(p.oid) = $2`, [f.name, f.identity_args]);
    if (!r || r.a !== f.args || r.r !== f.result || !r.s || r.v !== f.volatility) drift.push(f.name);
  }
  check('54 支（含正式庫原文 4 支）的參數、預設值、回傳型別、SECURITY DEFINER、volatility 與正式庫清單逐項相同', drift.length === 0, drift.join(', '));

  // 套用前狀態（回滾比對用）
  const fnState = async () => (await q(`SELECT p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')' AS k,
      md5(pg_get_functiondef(p.oid)) AS d, p.prosecdef AS s, p.provolatile AS v, array_to_string(p.proconfig, ';') AS c,
      (SELECT string_agg(coalesce(r.rolname, 'PUBLIC') || ':' || a.privilege_type, ',' ORDER BY coalesce(r.rolname, 'PUBLIC') || ':' || a.privilege_type)
         FROM aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a LEFT JOIN pg_roles r ON r.oid = a.grantee
        WHERE a.grantee <> p.proowner) AS acl
    FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace ORDER BY 1`)).map(r => JSON.stringify(r)).join('\n');
  const liveMd5 = async (f) => (await one(`SELECT md5(p.prosrc) AS m FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace
      AND p.proname = $1 AND pg_get_function_identity_arguments(p.oid) = $2`, [f.name, f.identity_args])).m;
  // 正式庫有些函式本體是以 CRLF 換行寫入的（例如 submit_makeup_punch）；fixture 以 LF 保存 → 換回 CRLF 再比對
  for (const f of WRAPPED.filter(f => STUB_FREE.includes(f.name))) {
    if ((await liveMd5(f)) === f.prosrc_md5) continue;
    const def = (await one(`SELECT pg_get_functiondef(p.oid) AS d FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace
      AND p.proname = $1 AND pg_get_function_identity_arguments(p.oid) = $2`, [f.name, f.identity_args])).d;
    const a = def.indexOf('$function$') + 10, b = def.lastIndexOf('$function$');
    await db.exec(`SET ROLE prod_postgres; ${def.slice(0, a)}${def.slice(a, b).replace(/\n/g, '\r\n')}${def.slice(b)}; RESET ROLE;`);
  }
  const realMd5Bad = [];
  for (const f of WRAPPED.filter(f => STUB_FREE.includes(f.name))) if ((await liveMd5(f)) !== f.prosrc_md5) realMd5Bad.push(f.name);
  check('正式庫原文 4 支：快照裡的本體 md5 與正式庫清單逐支相同（141 的本體指紋檢查不用替換就會通過）', realMd5Bad.length === 0, realMd5Bad.join(', '));
  let subst = 0;
  for (const f of stubs) {
    const lit = `'${f.prosrc_md5}'`;
    if (m141.split(lit).length === 2) { m141 = m141.replace(lit, `'${await liveMd5(f)}'`); subst++; }
  }
  check('測試用 141 副本：只替換 50 支替身的本體指紋', subst === 50, `${subst}`);
  const before = await fnState();
  const aclOf = async (name, ident) => (await one(`SELECT (SELECT string_agg(coalesce(r.rolname, 'PUBLIC') || ':' || a.privilege_type, ',' ORDER BY coalesce(r.rolname, 'PUBLIC') || ':' || a.privilege_type)
      FROM aclexplode(p.proacl) a LEFT JOIN pg_roles r ON r.oid = a.grantee WHERE a.grantee <> p.proowner) AS acl
    FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname = $1 AND pg_get_function_identity_arguments(p.oid) = $2`, [name, ident]))?.acl;
  const aclBefore = {};
  for (const f of WRAPPED) aclBefore[f.name + '(' + f.identity_args + ')'] = await aclOf(f.name, f.identity_args);

  // 替身 50 支的呼叫結果（套用前，anon）
  const stubCalls = stubs.flatMap(f => callsFor(f).map(sql => ({ f, sql })));
  const runAll = async (role, line, opts) => {
    const out = [];
    for (const c of stubCalls) {
      const r = await as(role, line, c.sql, [], opts);
      out.push(r.error ? 'ERR:' + r.error : r.rows[0].v);
    }
    const voids = (await q(`SELECT fn, k FROM public.test_stub_calls ORDER BY id`)).map(r => r.fn + '=' + r.k);
    await db.exec('DELETE FROM public.test_stub_calls');
    return { out, voids };
  };
  const pre = await runAll('anon', null);
  check(`套用前：替身 ${stubs.length} 支共 ${stubCalls.length} 種呼叫都成功（含省略預設值參數）`, pre.out.every(v => !String(v).startsWith('ERR:')), pre.out.find(v => String(v).startsWith('ERR:')));

  // 正式庫原文 4 支：打卡／補卡流程
  const today = (await one(`SELECT (now() AT TIME ZONE 'Asia/Taipei')::date::text AS d`)).d;
  const yesterday = (await one(`SELECT ((now() AT TIME ZONE 'Asia/Taipei')::date - 1)::text AS d`)).d;
  async function seed() {
    await db.exec(`
      DELETE FROM public.attendance_anomalies; DELETE FROM public.shift_swap_requests; DELETE FROM public.attendance;
      DELETE FROM public.schedules; DELETE FROM public.makeup_punch_requests; DELETE FROM public.system_settings;
      DELETE FROM public.shift_types; DELETE FROM public.platform_admin_companies; DELETE FROM public.platform_admins;
      DELETE FROM public.employees; DELETE FROM public.binding_attempts; DELETE FROM public.companies;
      INSERT INTO public.companies (id, code, name, status) VALUES ('${A}', 'ACO', '大正科技', 'active'), ('${B}', 'BCO', '別家公司', 'active');
      INSERT INTO public.employees (id, company_id, employee_number, name, line_user_id, role, is_kiosk, status, is_active, shift_mode) VALUES
        ('${E.admin}', '${A}', 'A01', '主管甲', '${L.admin}', 'admin', false, 'approved', true, 'fixed'),
        ('${E.e1}', '${A}', 'E01', '員工一', '${L.e1}', 'user', false, 'approved', true, 'fixed'),
        ('${E.e3}', '${A}', 'E03', '員工三', '${L.e3}', 'user', false, 'approved', true, 'fixed'),
        ('${E.e5}', '${A}', 'E05', '員工五', '${L.e5}', 'user', false, 'approved', true, 'fixed'),
        ('${E.kiosk}', '${A}', 'K01', '公務機', '${L.kiosk}', 'user', true, 'approved', true, 'fixed');
    `);
  }
  // role／line：誰在呼叫（soft mode 不影響結果）
  async function scenario(role, lineOf) {
    await seed();
    const call = async (line, fn, args) => {
      const keys = Object.keys(args);
      const r = await as(role, lineOf(line), `SELECT public.${fn}(${keys.map((k, i) => `${k} => $${i + 1}`).join(', ')}) AS r`, keys.map(k => args[k]));
      if (r.error) return { error: r.error };
      const x = r.rows[0].r || {};
      return { success: x.success, type: x.type, error: x.error, error_code: x.error_code };
    };
    const res = [];
    res.push(await call(L.e1, 'quick_check_in', { p_line_user_id: L.e1, p_latitude: 25.03, p_longitude: 121.56, p_photo_url: null, p_device_id: 'dev1', p_action: 'check_in' }));
    res.push(await call(L.e1, 'quick_check_in', { p_line_user_id: L.e1, p_latitude: 25.03, p_longitude: 121.56, p_photo_url: null, p_device_id: 'dev1', p_action: 'check_out' }));
    res.push(await call(L.e3, 'quick_check_in', { p_line_user_id: L.e3, p_latitude: 25.03, p_longitude: 121.56 }));
    res.push(await call(L.kiosk, 'quick_check_in', { p_line_user_id: L.kiosk, p_latitude: 0, p_longitude: 0, p_photo_url: null, p_device_id: null, p_action: 'check_in' }));
    res.push(await call(L.e5, 'submit_makeup_punch', { p_line_user_id: L.e5, p_punch_date: today, p_punch_type: 'clock_in', p_punch_time: '00:00', p_reason: '忘記打卡', p_note: null, p_company_id: A }));
    res.push(await call(L.e5, 'quick_check_out_after_clock_in_makeup', { p_line_user_id: L.e5, p_latitude: 25.03, p_longitude: 121.56, p_photo_url: null, p_device_id: null, p_action: 'check_out' }));
    res.push(await call(L.admin, 'admin_makeup_punch', { p_company_id: A, p_line_user_id: L.admin, p_employee_id: E.e3, p_punch_date: yesterday, p_punch_type: 'clock_in', p_punch_time: '08:00', p_note: '補登' }));
    res.push(await call(L.e1, 'admin_makeup_punch', { p_company_id: A, p_line_user_id: L.e1, p_employee_id: E.e3, p_punch_date: yesterday, p_punch_type: 'clock_in', p_punch_time: '09:00', p_note: '冒充' }));
    const att = (await q(`SELECT e.employee_number AS n, a.date::text AS d, a.check_in_time IS NOT NULL AS ci, a.check_out_time IS NOT NULL AS co, a.is_late AS late
      FROM public.attendance a JOIN public.employees e ON e.id = a.employee_id ORDER BY 1, 2`)).map(r => JSON.stringify(r));
    const mk = (await q(`SELECT punch_type, status FROM public.makeup_punch_requests ORDER BY 1`)).map(r => JSON.stringify(r));
    return JSON.stringify({ res, att, mk });
  }
  const realPre = await scenario('anon', () => null);
  check('套用前：打卡／下班／公務機擋下／補卡申請／補卡後下班／管理員補登／非管理員補登被擋 流程可跑', /check_in/.test(realPre) && /kiosk_employee_must_use_kiosk/.test(realPre), realPre.slice(0, 300));

  // ---------- 1. 清單防呆 ----------
  console.log('\n=== 清單防呆（任何一項不符就中止、什麼都不改）===');
  await db.exec(`CREATE FUNCTION public.p2_extra_rpc(p_line_user_id text) RETURNS int LANGUAGE sql SECURITY DEFINER AS $$ SELECT 1 $$;
    ALTER FUNCTION public.p2_extra_rpc(text) OWNER TO prod_postgres; GRANT EXECUTE ON FUNCTION public.p2_extra_rpc(text) TO anon;`);
  err = await apply(m141);
  check('多出一支 anon 可執行、帶 p_line_user_id 的函式 → 中止（要求重新產生）', /p2_extra_rpc/.test(err) && (await fnState()).includes('p2_extra_rpc') && !(await one(`SELECT to_regclass('public.line_auth_caller_log') AS t`)).t, err);
  await db.exec(`DROP FUNCTION public.p2_extra_rpc(text)`);
  await db.exec(`REVOKE EXECUTE ON FUNCTION public.get_my_payslip(text, integer, integer) FROM PUBLIC, anon, authenticated`);
  err = await apply(m141);
  check('清單中的一支已不是 anon 可執行 → 中止', /get_my_payslip/.test(err), err);
  await db.exec(`SET ROLE prod_postgres; GRANT EXECUTE ON FUNCTION public.get_my_payslip(text, integer, integer) TO PUBLIC, anon, authenticated; RESET ROLE;`);
  const payslipDef = (await one(`SELECT pg_get_functiondef('public.get_my_payslip(text, integer, integer)'::regprocedure) AS d`)).d;
  await db.exec(`SET ROLE prod_postgres; ${payslipDef.replace('RETURN jsonb_build_object(', 'RETURN jsonb_build_object(\'x\', 1, ')}; RESET ROLE;`);
  err = await apply(m141);
  check('指紋：某支的本體被改過（md5 不同）→ 中止', /get_my_payslip.*md5/.test(err), err);
  await db.exec(`SET ROLE prod_postgres; ${payslipDef}; RESET ROLE;`);
  await db.exec(`SET ROLE prod_postgres; REVOKE EXECUTE ON FUNCTION public.get_weekly_schedules(uuid, date, text) FROM service_role; RESET ROLE;`);
  err = await apply(m141);
  check('指紋：某支的執行權限與快照不同 → 中止', /get_weekly_schedules.*執行權限/.test(err), err);
  await db.exec(`SET ROLE prod_postgres; GRANT EXECUTE ON FUNCTION public.get_weekly_schedules(uuid, date, text) TO service_role; RESET ROLE;`);
  await db.exec(`SET ROLE prod_postgres; ALTER FUNCTION public.get_my_payslip(text, integer, integer) SET search_path = public; RESET ROLE;`);
  err = await apply(m141);
  check('指紋：某支的設定（search_path）與快照不同 → 中止', /get_my_payslip.*設定/.test(err), err);
  await db.exec(`SET ROLE prod_postgres; ALTER FUNCTION public.get_my_payslip(text, integer, integer) RESET search_path; RESET ROLE;`);
  await db.exec(`ALTER FUNCTION public.get_my_payslip(text, integer, integer) STRICT`);
  err = await apply(m141);
  check('指紋：某支變成 STRICT → 中止', /get_my_payslip.*STRICT/.test(err), err);
  await db.exec(`ALTER FUNCTION public.get_my_payslip(text, integer, integer) CALLED ON NULL INPUT`);
  await db.exec(`ALTER FUNCTION public.caller_line_user_id() RENAME TO caller_line_user_id_x`);
  err = await apply(m141);
  check('138 未套（caller_line_user_id 不存在）→ 中止', /138/.test(err), err);
  await db.exec(`ALTER FUNCTION public.caller_line_user_id_x() RENAME TO caller_line_user_id`);
  const afterAbort = await fnState();
  check('中止後函式定義與權限與原狀逐項相同', afterAbort === before, afterAbort.split('\n').filter(x => !before.split('\n').includes(x)).slice(0, 3).join(' | '));

  // ---------- 2. 套 141 ----------
  console.log('\n=== 套用 141（soft mode）===');
  err = await apply(m141);
  check('141 可在 PostgreSQL 套用（正式庫擁有者身分）', err === '', err);
  const logCount = async () => (await one(`SELECT count(*)::int AS n FROM public.line_auth_caller_log`)).n;
  const clearLog = () => db.exec(`DELETE FROM public.line_auth_caller_log`);
  check('預設模式：* = soft；註冊類預先設 soft', JSON.stringify((await q(`SELECT fn_name, mode FROM public.line_auth_caller_settings ORDER BY 1`)).map(r => r.fn_name + ':' + r.mode))
    === JSON.stringify(['*:soft', 'log_checkin_failure:soft', 'register_employee:soft']));

  console.log('\n--- 結果與套用前逐支相同 ---');
  let post = await runAll('anon', null);
  const diff = i => `${stubCalls[i].f.name}: ${pre.out[i]} ≠ ${post.out[i]}`;
  let bad = post.out.map((v, i) => v === pre.out[i] ? -1 : i).filter(i => i >= 0);
  check(`anon（沒有 session）：${stubCalls.length} 種呼叫結果與套用前逐字相同（soft 不擋）`, bad.length === 0 && post.voids.join() === pre.voids.join(), bad.map(diff).join('; '));
  const anonLogs = await q(`SELECT fn_name, provided_id_hash, claim_present, claim_id_hash, caller_role FROM public.line_auth_caller_log`);
  check('anon 每次呼叫都記一筆：函式名、p_line_user_id 的 SHA-256（不存原值）、沒有 claim、角色 anon',
    anonLogs.length === stubCalls.length && anonLogs.every(r => r.claim_present === false && r.caller_role === 'anon' && r.claim_id_hash === null && r.provided_id_hash === sha(L.e1))
    && new Set(anonLogs.map(r => r.fn_name)).size === new Set(stubs.map(f => f.name)).size, JSON.stringify(anonLogs[0]));
  check('紀錄表不含 LINE userId 原文', !(await q(`SELECT * FROM public.line_auth_caller_log`)).some(r => JSON.stringify(r).includes(L.e1)));
  await clearLog();
  post = await runAll('authenticated', L.e1);
  bad = post.out.map((v, i) => v === pre.out[i] ? -1 : i).filter(i => i >= 0);
  check('authenticated、JWT 的 LINE userId 與 p_line_user_id 相符：結果相同、不記錄', bad.length === 0 && post.voids.join() === pre.voids.join() && (await logCount()) === 0, bad.map(diff).join('; '));
  post = await runAll('authenticated', L.other);
  bad = post.out.map((v, i) => v === pre.out[i] ? -1 : i).filter(i => i >= 0);
  const mism = await q(`SELECT DISTINCT claim_present, claim_id_hash, caller_role FROM public.line_auth_caller_log`);
  check('authenticated、JWT 的 LINE userId 不符：soft 照常回傳、記錄 claim 存在（含 claim 的雜湊）', bad.length === 0 && (await logCount()) === stubCalls.length
    && mism.length === 1 && mism[0].claim_present === true && mism[0].claim_id_hash === sha(L.other) && mism[0].caller_role === 'authenticated', JSON.stringify(mism));
  await clearLog();
  post = await runAll('authenticated', null);
  check('authenticated 但 JWT 沒有 LINE claim（非 LINE 帳號）：soft 照常、記錄 claim 不存在', post.out.every((v, i) => v === pre.out[i]) && (await logCount()) === stubCalls.length
    && (await one(`SELECT bool_and(NOT claim_present) AS x FROM public.line_auth_caller_log`)).x === true);
  await clearLog();
  post = await runAll('service_role', null);
  check('service role（Edge Function）：結果相同、不檢查不記錄', post.out.every((v, i) => v === pre.out[i]) && (await logCount()) === 0);
  post = await runAll('postgres', null);
  check('沒有 SET ROLE 的 DB 內部呼叫（pg_cron 等）：結果相同、不記錄', post.out.every((v, i) => v === pre.out[i]) && (await logCount()) === 0);

  const realPostAnon = await scenario('anon', () => null);
  check('正式庫原文 4 支（打卡、下班、公務機擋下、補卡申請、補卡後下班、管理員補登）：anon 呼叫結果與資料變化與套用前相同', realPostAnon === realPre, realPostAnon.slice(0, 300));
  const nestedLogs = await q(`SELECT fn_name, count(*)::int AS n FROM public.line_auth_caller_log GROUP BY 1 ORDER BY 1`);
  check('正式庫原文呼叫也有記錄（每支 wrapper 都有接上 assert_caller）', ['admin_makeup_punch', 'quick_check_in', 'quick_check_out_after_clock_in_makeup', 'submit_makeup_punch'].every(n => nestedLogs.some(r => r.fn_name === n)), JSON.stringify(nestedLogs));
  await clearLog();
  const realPostAuth = await scenario('authenticated', (line) => line);
  check('正式庫原文 4 支：authenticated 相符呼叫結果相同、不記錄（含 quick_check_out 內部呼叫 quick_check_in）', realPostAuth === realPre && (await logCount()) === 0, realPostAuth.slice(0, 300));

  console.log('\n--- 呼叫者角色判斷 ---');
  await clearLog();
  const rawCall = async (setRole, claims) => {
    try {
      if (setRole) await db.exec(`SET ROLE ${setRole}`);
      await db.query(`SELECT set_config('request.jwt.claims', $1, false)`, [claims]);
      await db.query(`SELECT public.get_my_payslip(p_line_user_id => '${L.e1}', p_year => 2026, p_month => 10)`);
    } finally {
      await db.exec('RESET ROLE');
      await db.query(`SELECT set_config('request.jwt.claims', '', false)`);
    }
    const x = await one(`SELECT caller_role FROM public.line_auth_caller_log ORDER BY id DESC LIMIT 1`);
    await clearLog();
    return x ? x.caller_role : null;
  };
  check('只有 SET ROLE anon、沒有 JWT：仍判定為 anon（記錄）', (await rawCall('anon', '')) === 'anon');
  check('沒有 SET ROLE、JWT role = anon：以 JWT 判定為 anon（記錄）', (await rawCall(null, JSON.stringify({ role: 'anon' }))) === 'anon');
  check('SET ROLE service_role：不檢查（不記錄）', (await rawCall('service_role', '')) === null);

  console.log('\n--- soft mode 永不擋 ---');
  const payslip = `SELECT public.get_my_payslip(p_line_user_id => '${L.e1}', p_year => 2026, p_month => 10)::text AS v`;
  const payslipPre = pre.out[stubCalls.findIndex(c => c.f.name === 'get_my_payslip')];
  let r = await as('anon', null, payslip, [], { readOnly: true });
  check('唯讀交易（PostgREST 對 STABLE 函式的做法）裡寫不了紀錄：照常回傳、不報錯', !r.error && r.rows[0].v === payslipPre, r.error);
  await db.exec(`DELETE FROM public.line_auth_caller_settings WHERE fn_name = '*'`);
  r = await as('anon', null, payslip);
  check('設定缺漏（連 * 都沒有）：視為 soft，照常回傳', !r.error && r.rows[0].v === payslipPre, r.error);
  await db.exec(`INSERT INTO public.line_auth_caller_settings (fn_name, mode) VALUES ('*', 'soft')`);
  r = await as('anon', null, `SELECT public.get_my_payslip(p_line_user_id => NULL, p_year => 2026, p_month => 10)::text AS v`);
  const nullLog = await one(`SELECT provided_id_hash FROM public.line_auth_caller_log ORDER BY id DESC LIMIT 1`);
  check('p_line_user_id 為 NULL：照常呼叫原函式、紀錄雜湊為 NULL', !r.error && nullLog.provided_id_hash === null, r.error);

  console.log('\n--- 權限 ---');
  const aclBad = [];
  for (const f of WRAPPED) {
    const k = f.name + '(' + f.identity_args + ')';
    if ((await aclOf(f.name, f.identity_args)) !== aclBefore[k]) aclBad.push(k);
  }
  check('54 支 wrapper 的 proacl 與原函式逐項相同（含 PUBLIC）', aclBad.length === 0, aclBad.join('; '));
  const impl = await q(`SELECT i.proname AS n, has_function_privilege('anon', i.oid, 'EXECUTE') AS a, has_function_privilege('authenticated', i.oid, 'EXECUTE') AS u,
      has_function_privilege('service_role', i.oid, 'EXECUTE') AS s, i.prosecdef AS sd
    FROM pg_proc i WHERE i.pronamespace = 'public'::regnamespace AND i.proname LIKE '%\\_impl'`);
  check('*_impl 恰好 54 支，anon／authenticated 都不能執行（service role 保留）', impl.length === 54 && impl.every(x => !x.a && !x.u && x.s && x.sd), `${impl.length} 支`);
  r = await as('anon', null, `SELECT public.get_my_payslip_impl('${L.e1}', 2026, 10)`);
  check('anon 直接呼叫 *_impl 繞過檢查：permission denied', denied(r), r.error);
  r = await as('authenticated', L.e1, `SELECT public.quick_check_in_impl('${L.e1}', 25.0, 121.0)`);
  check('authenticated 直接呼叫 *_impl：permission denied', denied(r), r.error);
  const wr = await q(`SELECT p.proname AS n, p.prosecdef AS sd, p.provolatile AS v, array_to_string(p.proconfig, ';') AS c
    FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname = ANY($1)`, [wrappedList.rpc_names]);
  check('wrapper 全部 SECURITY DEFINER、VOLATILE、不設 search_path（原函式沿用呼叫端的 search_path，行為不變）', wr.length === 54 && wr.every(x => x.sd && x.v === 'v' && !x.c), JSON.stringify(wr.find(x => !(x.sd && x.v === 'v'))));
  const liveSet = (await q(`SELECT p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')' AS k FROM pg_proc p
    WHERE p.pronamespace = 'public'::regnamespace AND 'p_line_user_id' = ANY (coalesce(p.proargnames, '{}'))
      AND (has_function_privilege('anon', p.oid, 'EXECUTE') OR has_function_privilege('authenticated', p.oid, 'EXECUTE')) ORDER BY 1`)).map(x => x.k);
  check('anon／authenticated 可執行、帶 p_line_user_id 的函式恰好是 54 支 wrapper', liveSet.length === 54 && liveSet.join() === [...wrappedList.functions].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)).join());
  for (const role of ['anon', 'authenticated']) {
    r = await as(role, L.e1, `SELECT public.assert_caller('${L.e1}', 'x')`);
    check(`${role} 不能直接呼叫 assert_caller（不能灌紀錄）`, denied(r), r.error);
    r = await as(role, L.e1, `UPDATE public.line_auth_caller_settings SET mode = 'soft'`);
    check(`${role} 不能改模式設定`, denied(r), r.error);
    r = await as(role, L.e1, `INSERT INTO public.line_auth_caller_settings (fn_name, mode) VALUES ('get_my_payslip', 'soft')`);
    check(`${role} 不能新增逐支覆寫`, denied(r), r.error);
    r = await as(role, L.e1, `SELECT * FROM public.line_auth_caller_log`);
    check(`${role} 讀不到紀錄`, denied(r), r.error);
    r = await as(role, L.e1, `DELETE FROM public.line_auth_caller_log`);
    check(`${role} 刪不掉紀錄`, denied(r), r.error);
  }
  r = await as('service_role', null, `SELECT count(*)::int AS n FROM public.line_auth_caller_log`);
  check('service role 讀得到紀錄', !r.error && r.rows[0].n >= 1, r.error);

  // ---------- 3. enforce ----------
  console.log('\n=== enforce（只有 service role 能切換）===');
  r = await as('service_role', null, `UPDATE public.line_auth_caller_settings SET mode = 'enforce', updated_at = now() WHERE fn_name = '*'`);
  check('service role 把 * 切成 enforce', !r.error, r.error);
  await clearLog();
  r = await as('anon', null, payslip);
  check('enforce：anon（沒有 session）→ 拒絕（42501）', /caller identity not verified/.test(r.error || '') && r.code === '42501', r.error);
  r = await as('authenticated', L.other, payslip);
  check('enforce：authenticated 但 LINE userId 不符（冒充別人）→ 拒絕', /caller identity not verified/.test(r.error || ''), r.error);
  r = await as('authenticated', null, payslip);
  check('enforce：authenticated 但沒有 LINE claim → 拒絕', /caller identity not verified/.test(r.error || ''), r.error);
  r = await as('authenticated', L.e1, payslip);
  check('enforce：authenticated 且相符 → 放行、結果相同', !r.error && r.rows[0].v === payslipPre, r.error);
  r = await as('service_role', null, payslip);
  check('enforce：service role（Edge Function）→ 放行', !r.error && r.rows[0].v === payslipPre, r.error);
  r = await as('postgres', null, payslip);
  check('enforce：DB 內部呼叫（pg_cron）→ 放行', !r.error && r.rows[0].v === payslipPre, r.error);
  post = await runAll('authenticated', L.e1);
  check('enforce：authenticated 相符時 54 支全部照常（結果與套用前相同）', post.out.every((v, i) => v === pre.out[i]) && post.voids.join() === pre.voids.join(),
    post.out.map((v, i) => v === pre.out[i] ? '' : diff(i)).filter(Boolean).join('; '));
  post = await runAll('anon', null);
  const allowedAnon = stubCalls.map((c, i) => [c.f.name, post.out[i]]).filter(([, v]) => !String(v).startsWith('ERR:')).map(([n]) => n);
  check('enforce：anon 呼叫全部被擋，只有預先設 soft 的 register_employee／log_checkin_failure 照常', [...new Set(allowedAnon)].sort().join() === 'log_checkin_failure,register_employee'
    && stubCalls.every((c, i) => ['register_employee', 'log_checkin_failure'].includes(c.f.name) ? post.out[i] === pre.out[i] : /caller identity not verified/.test(post.out[i])), [...new Set(allowedAnon)].join());
  check('enforce 擋下時不會留下被擋呼叫的紀錄（整筆回復）；soft 的兩支照常記錄',
    (await q(`SELECT DISTINCT fn_name FROM public.line_auth_caller_log ORDER BY 1`)).map(x => x.fn_name).join() === 'log_checkin_failure,register_employee');
  r = await as('anon', null, `SELECT public.quick_check_in(p_line_user_id => '${L.e1}', p_latitude => 25.0, p_longitude => 121.0)`);
  check('enforce：anon 直接帶別人的 LINE userId 打卡 → 拒絕（冒充打卡被擋）', /caller identity not verified/.test(r.error || ''), r.error);
  r = await as('service_role', null, `INSERT INTO public.line_auth_caller_settings (fn_name, mode) VALUES ('get_my_payslip', 'soft')`);
  r = await as('anon', null, payslip);
  check('逐支覆寫：* = enforce 但 get_my_payslip = soft → 該支照常', !r.error && r.rows[0].v === payslipPre, r.error);
  r = await as('service_role', null, `UPDATE public.line_auth_caller_settings SET mode = 'soft' WHERE fn_name = '*'; DELETE FROM public.line_auth_caller_settings WHERE fn_name = 'get_my_payslip'`);
  r = await as('service_role', null, `UPDATE public.line_auth_caller_settings SET mode = 'loud' WHERE fn_name = '*'`);
  check('模式只能是 soft／enforce', /check constraint/.test(r.error || ''), r.error);
  r = await as('anon', null, payslip);
  check('切回 soft：anon 照常', !r.error && r.rows[0].v === payslipPre, r.error);

  // ---------- 4. 回滾、重套 ----------
  console.log('\n=== 重複套用、回滾、重套 ===');
  const afterApply = await fnState();
  const wrapDef = (await one(`SELECT pg_get_functiondef('public.get_my_payslip(text, integer, integer)'::regprocedure) AS d`)).d;
  await db.exec(`SET ROLE prod_postgres; CREATE OR REPLACE FUNCTION public.get_my_payslip(p_line_user_id text, p_year integer, p_month integer) RETURNS jsonb
    LANGUAGE sql VOLATILE SECURITY DEFINER AS $x$ SELECT '{}'::jsonb $x$; RESET ROLE;`);
  err = await apply(m141rb);
  check('回滾前 wrapper 已被 CREATE OR REPLACE 蓋掉 → 回滾中止（不會刪錯函式）', /get_my_payslip.*已不是 141 的 wrapper/.test(err), err);
  await db.exec(`SET ROLE prod_postgres; ${wrapDef}; RESET ROLE;`);
  check('（還原 wrapper 後狀態與套用後相同）', (await fnState()) === afterApply);
  err = await apply(mig('138_line_auth_phase1_rollback.sql'));
  check('141 還在時回滾 138：中止（否則 wrapper 找不到 caller_line_user_id）', /141/.test(err) && (await fnState()) === afterApply, err);
  err = await apply(m141);
  check('已套用後再套一次 → 中止、不改任何東西', /已套用過/.test(err) && (await fnState()) === afterApply, err);
  err = await apply(m141rb);
  check('141 回滾可套用', err === '', err);
  const afterRb = await fnState();
  check('回滾後：所有 public 函式的定義、SECURITY DEFINER、volatility、設定、權限與套用前逐項相同', afterRb === before,
    afterRb.split('\n').filter(x => !before.split('\n').includes(x)).slice(0, 3).join(' | '));
  check('回滾後：assert_caller、設定表、紀錄表都移除', !(await one(`SELECT to_regprocedure('public.assert_caller(text, text)') AS f, to_regclass('public.line_auth_caller_log') AS l, to_regclass('public.line_auth_caller_settings') AS s`)).f
    && !(await one(`SELECT to_regclass('public.line_auth_caller_log') AS l`)).l && !(await one(`SELECT to_regclass('public.line_auth_caller_settings') AS s`)).s);
  post = await runAll('anon', null);
  check('回滾後：呼叫結果與套用前相同', post.out.every((v, i) => v === pre.out[i]));
  err = await apply(m141rb);
  check('未套用時執行回滾 → 中止', /未套用/.test(err), err);
  err = await apply(m141);
  check('回滾後可重新套用', err === '' && (await fnState()) === afterApply, err);

  // ---------- 5. 產生器 ----------
  console.log('\n=== 產生器 ===');
  const gen = spawnSync(process.execPath, [path.join(root, 'scripts', 'line-auth', 'generate-rpc-wrappers.js'), '--check'], { encoding: 'utf8' });
  check('重新產生的 141／回滾檔／名單與 repo 內逐字相同（沒有人手改）', gen.status === 0, (gen.stderr || gen.stdout).trim());
  check('名單：54 支（52 個名稱，含 2 組多載）；排除 29 支（service role only 9、131／132 已撤 20）',
    wrappedList.functions.length === 54 && wrappedList.rpc_names.length === 52 && wrappedList.excluded.length === 29
    && wrappedList.excluded.filter(e => /service role only/.test(e.reason)).length === 9);

  console.log(`\n結果：${pass} 通過、${fail} 失敗`);
  process.exit(fail > 0 ? 1 : 0);
})().catch(e => { console.error(e); console.log(`\n結果：${pass} 通過、${fail + 1} 失敗`); process.exit(1); });
