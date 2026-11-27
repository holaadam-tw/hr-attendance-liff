-- 157 回滾：還原 2026-11-27 正式庫唯讀快照中的 selfies 寫入政策。
BEGIN;
DROP POLICY IF EXISTS "selfies_insert_only" ON storage.objects;
CREATE POLICY "Allow authenticated uploads" ON storage.objects FOR INSERT TO anon, authenticated WITH CHECK (bucket_id='selfies');
CREATE POLICY "Allow public upload" ON storage.objects FOR INSERT TO anon, authenticated WITH CHECK (bucket_id='selfies');
CREATE POLICY "Allow public uploads" ON storage.objects FOR INSERT TO anon, authenticated WITH CHECK (bucket_id='selfies');
CREATE POLICY "selfies_anon_insert" ON storage.objects FOR INSERT TO public WITH CHECK (bucket_id='selfies');
CREATE POLICY "允許上傳打卡照片" ON storage.objects FOR INSERT TO public WITH CHECK (bucket_id='selfies');
CREATE POLICY "Allow public deletes" ON storage.objects FOR DELETE TO anon, authenticated USING (bucket_id='selfies');
CREATE POLICY "Allow public updates" ON storage.objects FOR UPDATE TO anon, authenticated USING (bucket_id='selfies');
CREATE POLICY "selfies_anon_update" ON storage.objects FOR UPDATE TO public USING (bucket_id='selfies');
COMMIT;
