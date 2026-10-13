// migration 148：leave_requests 只能經 SECURITY DEFINER RPC 寫入（純本機 PGlite）
const fs = require('fs');
const path = require('path');
const { PGlite } = require('@electric-sql/pglite');

const root = path.join(__dirname, '..');
const migration = process.env.MIGRATION148_EMPTY === '1' ? '' : fs.readFileSync(
  process.env.MIGRATION148_FILE || path.join(root, 'migrations', '148_leave_requests_write_lock.sql'), 'utf8');
const rollback = fs.readFileSync(path.join(root, 'migrations', '148_leave_requests_write_lock_rollback.sql'), 'utf8');
let pass = 0, fail = 0;
function check(name, ok, detail = '') {
  (ok ? pass++ : fail++);
  console.log(`  ${ok ? '✅' : '❌'} ${name}${detail ? ` → ${detail}` : ''}`);
}

const COMPANY = '10000000-0000-0000-0000-000000000001';
const COMPANY_B = '10000000-0000-0000-0000-000000000002';
const USER = '20000000-0000-0000-0000-000000000001';
const ADMIN = '20000000-0000-0000-0000-000000000002';
const ADMIN_B = '20000000-0000-0000-0000-000000000003';

(async () => {
  console.log('\n═══════════════════════════════════════');
  console.log('  leave_requests 寫入鎖（148，PGlite 實跑）');
  console.log('═══════════════════════════════════════');
  const db = new PGlite();
  const q = async (sql, params) => (await db.query(sql, params)).rows;
  const one = async (sql, params) => (await q(sql, params))[0];
  const as = async (role, sql, params) => {
    try {
      await db.exec(`SET ROLE ${role}`);
      return { rows: await q(sql, params) };
    } catch (e) {
      return { error: e.message };
    } finally {
      await db.exec('RESET ROLE');
    }
  };
  const apply = async sql => {
    try {
      await db.exec('SET ROLE prod_postgres');
      await db.exec(sql);
      return '';
    } catch (e) {
      try { await db.exec('ROLLBACK'); } catch (_) { /* no open transaction */ }
      return e.message;
    } finally {
      await db.exec('RESET ROLE');
    }
  };
  const denied = r => /permission denied/.test(r?.error || '');

  await db.exec(`
    CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE ROLE prod_postgres NOLOGIN;
    GRANT USAGE ON SCHEMA public TO anon, authenticated;
    GRANT USAGE, CREATE ON SCHEMA public TO prod_postgres;
    SET ROLE prod_postgres;
    CREATE TABLE public.employees (
      id uuid PRIMARY KEY, company_id uuid NOT NULL, line_user_id text NOT NULL,
      role text NOT NULL DEFAULT 'user', is_active boolean NOT NULL DEFAULT true
    );
    CREATE TABLE public.leave_requests (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), employee_id uuid NOT NULL REFERENCES public.employees(id),
      leave_type text NOT NULL DEFAULT 'annual', start_date date NOT NULL, end_date date NOT NULL,
      status text NOT NULL DEFAULT 'pending', rejection_reason text
    );
    ALTER TABLE public.leave_requests ENABLE ROW LEVEL SECURITY;
    CREATE POLICY "Allow RPC access leaves" ON public.leave_requests FOR ALL TO authenticated, anon USING (true) WITH CHECK (true);
    CREATE POLICY "允許新增請假單" ON public.leave_requests FOR INSERT TO authenticated, anon WITH CHECK (true);
    CREATE POLICY "允許更新待審核請假單" ON public.leave_requests FOR UPDATE TO authenticated, anon USING (((status)::text = 'pending'::text));
    CREATE POLICY "允許查看請假單" ON public.leave_requests FOR SELECT TO authenticated, anon USING (true);
    GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE
      ON public.leave_requests TO anon, authenticated;

    CREATE FUNCTION public.submit_leave_request(p_line_user_id text, p_company_id uuid, p_start date)
    RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
    DECLARE eid uuid; rid uuid; BEGIN
      SELECT id INTO eid FROM employees WHERE company_id=p_company_id AND line_user_id=p_line_user_id AND is_active;
      IF eid IS NULL THEN RETURN jsonb_build_object('success',false); END IF;
      INSERT INTO leave_requests(employee_id,start_date,end_date) VALUES(eid,p_start,p_start) RETURNING id INTO rid;
      RETURN jsonb_build_object('success',true,'id',rid);
    END $$;
    CREATE FUNCTION public.approve_leave_request(p_company_id uuid, p_line_user_id text, p_request_id uuid, p_status text)
    RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
    BEGIN
      IF NOT EXISTS (SELECT 1 FROM employees WHERE company_id=p_company_id AND line_user_id=p_line_user_id
                     AND role IN ('admin','manager') AND is_active) THEN
        RETURN jsonb_build_object('success',false);
      END IF;
      UPDATE leave_requests lr SET status=p_status,
        rejection_reason=CASE WHEN p_status='rejected' THEN '測試駁回' ELSE NULL END
      FROM employees e WHERE lr.id=p_request_id AND lr.employee_id=e.id AND e.company_id=p_company_id AND lr.status='pending';
      RETURN jsonb_build_object('success',FOUND);
    END $$;
    REVOKE ALL ON FUNCTION public.submit_leave_request(text,uuid,date) FROM PUBLIC;
    REVOKE ALL ON FUNCTION public.approve_leave_request(uuid,text,uuid,text) FROM PUBLIC;
    GRANT EXECUTE ON FUNCTION public.submit_leave_request(text,uuid,date) TO anon, authenticated;
    GRANT EXECUTE ON FUNCTION public.approve_leave_request(uuid,text,uuid,text) TO anon, authenticated;
    INSERT INTO employees(id,company_id,line_user_id,role) VALUES
      ('${USER}','${COMPANY}','Uuser','user'), ('${ADMIN}','${COMPANY}','Uadmin','admin'),
      ('${ADMIN_B}','${COMPANY_B}','UadminB','admin');
    RESET ROLE;
  `);

  const policies = async () => (await q(`SELECT policyname, roles::text roles, cmd, qual, with_check FROM pg_policies
    WHERE schemaname='public' AND tablename='leave_requests' ORDER BY policyname`)).map(JSON.stringify).join('\n');
  const acl = async () => (await q(`SELECT coalesce(r.rolname,'PUBLIC') g, a.privilege_type p
    FROM aclexplode((SELECT relacl FROM pg_class WHERE oid='public.leave_requests'::regclass)) a
    LEFT JOIN pg_roles r ON r.oid=a.grantee WHERE coalesce(r.rolname,'PUBLIC') <> 'prod_postgres' ORDER BY 1,2`))
    .map(x => `${x.g}:${x.p}`).join(',');
  const before = { policies: await policies(), acl: await acl() };
  const rpc = async (role, sql, params) => {
    const x = await as(role, sql, params);
    return x.error ? { error: x.error } : x.rows[0].r;
  };
  async function rpcScenario(firstDate, secondDate) {
    const submitted = await rpc('anon', `SELECT submit_leave_request('Uuser',$1,$2) r`, [COMPANY, firstDate]);
    const approved = await rpc('anon', `SELECT approve_leave_request($1,'Uadmin',$2::uuid,'approved') r`, [COMPANY, submitted.id]);
    const rejectedReq = await rpc('authenticated', `SELECT submit_leave_request('Uuser',$1,$2) r`, [COMPANY, secondDate]);
    const rejected = await rpc('authenticated', `SELECT approve_leave_request($1,'Uadmin',$2::uuid,'rejected') r`, [COMPANY, rejectedReq.id]);
    const states = await q(`SELECT status, coalesce(rejection_reason,'') reason FROM leave_requests
      WHERE id IN ($1::uuid,$2::uuid) ORDER BY start_date`, [submitted.id, rejectedReq.id]);
    return {
      ok: submitted.success === true && approved.success === true && rejectedReq.success === true && rejected.success === true,
      states
    };
  }

  console.log('\n=== 套用前：重現公開寫入漏洞 ===');
  let r = await as('anon', `INSERT INTO leave_requests(id,employee_id,start_date,end_date) VALUES
    ('30000000-0000-0000-0000-000000000001',$1,'2026-10-20','2026-10-20')`, [USER]);
  check('anon 可直接 INSERT', !r.error, r.error);
  r = await as('anon', `UPDATE leave_requests SET status='approved' WHERE id='30000000-0000-0000-0000-000000000001'`);
  check('anon 可把 pending 直接改 approved', !r.error && (await one(`SELECT status FROM leave_requests WHERE id='30000000-0000-0000-0000-000000000001'`)).status === 'approved', r.error);
  r = await as('anon', `DELETE FROM leave_requests WHERE id='30000000-0000-0000-0000-000000000001'`);
  check('anon 可直接 DELETE（取消／刪除漏洞）', !r.error, r.error);
  const rpcBefore = await rpcScenario('2026-10-18', '2026-10-19');
  check('套用前申請／核准／駁回 RPC 基線成功', rpcBefore.ok, JSON.stringify(rpcBefore));
  await db.exec(`SET ROLE prod_postgres; DELETE FROM leave_requests; RESET ROLE;`);

  console.log('\n=== 套用 148 ===');
  let err = await apply(migration);
  check('148 可套用', err === '', err);
  for (const role of ['anon', 'authenticated']) {
    const id = role === 'anon' ? '30000000-0000-0000-0000-000000000011' : '30000000-0000-0000-0000-000000000012';
    const ins = await as(role, `INSERT INTO leave_requests(id,employee_id,start_date,end_date) VALUES($1,$2,'2026-10-21','2026-10-21')`, [id, USER]);
    await db.exec(`SET ROLE prod_postgres; INSERT INTO leave_requests(id,employee_id,start_date,end_date) VALUES('${id}', '${USER}','2026-10-21','2026-10-21') ON CONFLICT DO NOTHING; RESET ROLE;`);
    const upd = await as(role, `UPDATE leave_requests SET status='approved' WHERE id=$1`, [id]);
    const del = await as(role, `DELETE FROM leave_requests WHERE id=$1`, [id]);
    check(`${role} 的 INSERT／UPDATE／DELETE 全被拒`, denied(ins) && denied(upd) && denied(del), [ins.error, upd.error, del.error].join(' | '));
  }
  r = await as('anon', `SELECT count(*)::int n FROM leave_requests`);
  check('第一階段保留 SELECT', !r.error, r.error);
  const postAcl = await acl();
  check('148 後 anon／authenticated ACL 都只剩 SELECT',
    postAcl === 'anon:SELECT,authenticated:SELECT', postAcl);

  const rpcAfter = await rpcScenario('2026-10-22', '2026-10-23');
  check('148 後申請／核准／駁回 RPC 照常', rpcAfter.ok, JSON.stringify(rpcAfter));
  check('148 前後 RPC 資料變化一致', JSON.stringify(rpcAfter.states) === JSON.stringify(rpcBefore.states),
    `${JSON.stringify(rpcBefore.states)} / ${JSON.stringify(rpcAfter.states)}`);
  const crossSubmit = await rpc('anon', `SELECT submit_leave_request('Uuser',$1,'2026-10-25') r`, [COMPANY_B]);
  const pending = await rpc('anon', `SELECT submit_leave_request('Uuser',$1,'2026-10-26') r`, [COMPANY]);
  const crossApprove = await rpc('anon', `SELECT approve_leave_request($1,'UadminB',$2::uuid,'approved') r`, [COMPANY_B, pending.id]);
  check('跨公司 submit 被拒', crossSubmit?.success === false, JSON.stringify(crossSubmit));
  check('跨公司 approve 被拒且假單維持 pending', crossApprove?.success === false
    && (await one(`SELECT status FROM leave_requests WHERE id=$1`, [pending.id])).status === 'pending', JSON.stringify(crossApprove));

  console.log('\n=== 回滾與重套 ===');
  err = await apply(rollback);
  check('rollback 可套用', err === '', err);
  check('rollback 後政策逐項等同正式庫快照', await policies() === before.policies);
  check('rollback 後 ACL 逐項等同正式庫快照', await acl() === before.acl, await acl());
  r = await as('anon', `DELETE FROM leave_requests WHERE status='rejected'`);
  check('rollback 後直接 DELETE 恢復', !r.error, r.error);
  err = await apply(migration) || await apply(migration);
  check('148 可重複套用', err === '', err);
  r = await as('anon', `INSERT INTO leave_requests(employee_id,start_date,end_date) VALUES($1,'2026-10-24','2026-10-24')`, [USER]);
  check('重套後仍擋直接寫入', denied(r), r.error);

  console.log(`\n結果：${pass} 通過、${fail} 失敗`);
  await db.close();
  process.exitCode = fail ? 1 : 0;
})().catch(e => { console.error(e); process.exitCode = 1; });
