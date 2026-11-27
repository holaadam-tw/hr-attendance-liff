-- 157: selfies Storage 權限收緊；只建立檔案，不直接套用正式資料庫。
BEGIN;
DROP POLICY IF EXISTS "Allow public deletes" ON storage.objects;
DROP POLICY IF EXISTS "Allow public updates" ON storage.objects;
DROP POLICY IF EXISTS "selfies_anon_update" ON storage.objects;
DROP POLICY IF EXISTS "Allow authenticated uploads" ON storage.objects;
DROP POLICY IF EXISTS "Allow public upload" ON storage.objects;
DROP POLICY IF EXISTS "Allow public uploads" ON storage.objects;
DROP POLICY IF EXISTS "selfies_anon_insert" ON storage.objects;
DROP POLICY IF EXISTS "允許上傳打卡照片" ON storage.objects;
CREATE POLICY "selfies_insert_only" ON storage.objects FOR INSERT TO anon, authenticated
  WITH CHECK (bucket_id = 'selfies');
-- SELECT 刻意不動；public bucket 的 getPublicUrl 公開網址維持可用。
DO $$
DECLARE p record;
BEGIN
  IF (SELECT count(*) FROM pg_policies WHERE schemaname='storage' AND tablename='objects'
      AND policyname='selfies_insert_only' AND cmd='INSERT') <> 1 THEN
    RAISE EXCEPTION 'selfies 單一新增政策未建立';
  END IF;
  FOR p IN SELECT policyname, cmd FROM pg_policies WHERE schemaname='storage'
    AND tablename='objects' AND cmd IN ('UPDATE','DELETE') AND COALESCE(qual,'') LIKE '%selfies%'
  LOOP RAISE EXCEPTION 'selfies 仍有不允許的 % 政策：%', p.cmd, p.policyname; END LOOP;
END $$;
COMMIT;
