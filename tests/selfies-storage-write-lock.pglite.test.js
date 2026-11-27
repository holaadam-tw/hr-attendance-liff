const fs = require('fs');
const path = require('path');
const { PGlite } = require('@electric-sql/pglite');
const root = path.join(__dirname, '..');
const migration = fs.readFileSync(path.join(root, 'migrations', '157_selfies_storage_write_lock.sql'), 'utf8');
const rollback = fs.readFileSync(path.join(root, 'migrations', '157_selfies_storage_write_lock_rollback.sql'), 'utf8');
let pass=0, fail=0;
function check(name, ok) { ok ? pass++ : fail++; console.log('  '+(ok?'✅':'❌')+' '+name); }
(async () => {
 const db=new PGlite();
 const as=async(role,sql)=>{try{await db.exec('SET ROLE '+role);const result=await db.query(sql);return{ok:true,rows:result.rows};}catch(e){return{ok:false,error:e.message};}finally{await db.exec('RESET ROLE');}};
 const denied=r=>!r.ok && /row-level security|policy|permission denied/i.test(r.error||'');
 await db.exec("CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE ROLE prod_postgres NOLOGIN; CREATE SCHEMA storage AUTHORIZATION prod_postgres; SET ROLE prod_postgres; CREATE TABLE storage.objects(id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,bucket_id text NOT NULL,name text NOT NULL,payload text); ALTER TABLE storage.objects ENABLE ROW LEVEL SECURITY; GRANT USAGE ON SCHEMA storage TO anon,authenticated; GRANT SELECT,INSERT,UPDATE,DELETE ON storage.objects TO anon,authenticated; GRANT USAGE,SELECT ON SEQUENCE storage.objects_id_seq TO anon,authenticated; CREATE POLICY \"Allow public deletes\" ON storage.objects FOR DELETE TO anon,authenticated USING(bucket_id='selfies'); CREATE POLICY \"Allow public updates\" ON storage.objects FOR UPDATE TO anon,authenticated USING(bucket_id='selfies'); CREATE POLICY \"selfies_anon_update\" ON storage.objects FOR UPDATE TO public USING(bucket_id='selfies'); CREATE POLICY \"Allow authenticated uploads\" ON storage.objects FOR INSERT TO anon,authenticated WITH CHECK(bucket_id='selfies'); CREATE POLICY \"Allow public upload\" ON storage.objects FOR INSERT TO anon,authenticated WITH CHECK(bucket_id='selfies'); CREATE POLICY \"Allow public uploads\" ON storage.objects FOR INSERT TO anon,authenticated WITH CHECK(bucket_id='selfies'); CREATE POLICY \"selfies_anon_insert\" ON storage.objects FOR INSERT TO public WITH CHECK(bucket_id='selfies'); CREATE POLICY \"允許上傳打卡照片\" ON storage.objects FOR INSERT TO public WITH CHECK(bucket_id='selfies'); CREATE POLICY \"selfies_public_read\" ON storage.objects FOR SELECT TO public USING(bucket_id='selfies'); INSERT INTO storage.objects(bucket_id,name,payload) VALUES('selfies','existing.jpg','original'); RESET ROLE;");
 await db.exec('SET ROLE prod_postgres'); await db.exec(migration); await db.exec('RESET ROLE');
 check('anon 仍可新增 selfies',(await as('anon',"INSERT INTO storage.objects(bucket_id,name,payload) VALUES('selfies','new.jpg','new')")).ok);
 check('authenticated 仍可新增 selfies',(await as('authenticated',"INSERT INTO storage.objects(bucket_id,name,payload) VALUES('selfies','auth.jpg','new')")).ok);
 check('其他 bucket 無法新增',denied(await as('anon',"INSERT INTO storage.objects(bucket_id,name,payload) VALUES('other','bad.jpg','bad')")));
 const blockedUpdate=await as('anon',"UPDATE storage.objects SET payload='changed' WHERE name='existing.jpg' RETURNING id");
 const blockedDelete=await as('anon',"DELETE FROM storage.objects WHERE name='existing.jpg' RETURNING id");
 check('anon 無法覆寫 selfies',denied(blockedUpdate)||(blockedUpdate.ok&&blockedUpdate.rows.length===0));
 check('anon 無法刪除 selfies',denied(blockedDelete)||(blockedDelete.ok&&blockedDelete.rows.length===0));
 check('公開讀取政策仍存在',(await db.query("SELECT count(*)::int n FROM pg_policies WHERE policyname='selfies_public_read'")).rows[0].n===1);
 await db.exec('SET ROLE prod_postgres'); await db.exec(rollback); await db.exec('RESET ROLE');
 check('回滾後 anon 可覆寫',(await as('anon',"UPDATE storage.objects SET payload='rolled-back' WHERE name='existing.jpg' RETURNING id")).rows.length===1);
 check('回滾後 anon 可刪除',(await as('anon',"DELETE FROM storage.objects WHERE name='existing.jpg' RETURNING id")).rows.length===1);
 console.log('結果：✅ '+pass+' 通過 ❌ '+fail+' 失敗'); await db.close(); process.exit(fail?1:0);
})().catch(e=>{console.error(e);process.exit(1);});
