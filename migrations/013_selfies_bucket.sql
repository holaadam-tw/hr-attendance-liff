-- ============================================================
-- 013_selfies_bucket.sql
-- 建立 selfies Storage bucket（菜單圖片 + 打卡自拍 + 外勤照片）
-- ============================================================

-- 建立 bucket
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
    'selfies',
    'selfies',
    true,
    5242880,  -- 5MB
    ARRAY['image/jpeg', 'image/png', 'image/webp', 'image/gif']
)
ON CONFLICT (id) DO NOTHING;

-- RLS policies: 任何人可讀取（public bucket）
DROP POLICY IF EXISTS "selfies_public_read" ON storage.objects;
CREATE POLICY "selfies_public_read"
    ON storage.objects FOR SELECT
    USING (bucket_id = 'selfies');

-- RLS policies: anon 可上傳
DROP POLICY IF EXISTS "selfies_anon_insert" ON storage.objects;
CREATE POLICY "selfies_anon_insert"
    ON storage.objects FOR INSERT
    WITH CHECK (bucket_id = 'selfies');

-- RLS policies: anon 可更新（覆蓋圖片）
DROP POLICY IF EXISTS "selfies_anon_update" ON storage.objects;
CREATE POLICY "selfies_anon_update"
    ON storage.objects FOR UPDATE
    USING (bucket_id = 'selfies');
