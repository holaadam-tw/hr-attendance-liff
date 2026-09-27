-- ============================================================
-- 127: system_settings 收斂 ——（1）LINE token 那一列 anon/authenticated 讀不到
--                              （2）anon/authenticated 不能直接寫，只能走 admin_save_setting（126）
--
-- ⚠️ 前置：126＋129 已套用、line-push Edge Function 已部署新版、前端（本 PR）已上線並等舊快取過期（≥1 工作天）。
--         順序錯了會讓「還沒更新的頁面」推播失敗／設定存不進去（見 PR 的上線步驟）。
--
-- 正式庫 2026-09-27 快照（SELECT pg_policies，唯讀查詢）：
--   Allow RPC access settings            ALL     {anon,authenticated}  USING true  CHECK true   ← 任何人可替任何公司寫
--   Allow public read system_settings    SELECT  {public}              USING true
--   Allow public update system_settings  UPDATE  {public}              USING true               ← 任何人可改任何公司
--   Allow read settings                  SELECT  {anon,authenticated}  USING true
--   Public read settings                 SELECT  {anon,authenticated}  USING true
--   公開讀取系統設定                      SELECT  {anon,authenticated}  USING true
--   Service Role Full Access - settings  ALL     {service_role}        USING true
--   anon/authenticated table grant：INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER
--   （migrations/011 的 settings_select/insert/update/delete 在正式庫不存在）
--
-- 本檔：
--   A. DROP 上面 6 條 anon/public 政策，改成一條只讀政策：key 不在「秘密清單」的列都可讀（其他頁面照舊）
--      秘密清單目前只有 line_messaging_api（token）。
--   B. REVOKE anon/authenticated 的 INSERT/UPDATE/DELETE/TRUNCATE/REFERENCES/TRIGGER（保留 SELECT）
--   C. service_role 政策保留；SECURITY DEFINER 函式（line_daily_notify、admin_save_setting、
--      line_push_authorize、115 的開關 RPC …）以 owner 身分執行，不受影響。
--
-- 還沒處理（刻意不在本檔）：payroll_password 仍可被 anon 讀。它只是前端的畫面鎖（薪資資料本身另有讀取路徑），
--   藏起來需要把「比對密碼」改成 RPC，另開一包；寫入已限管理員且需 LIFF 驗證（126）。
--
-- 回滾：migrations/127_system_settings_lock_rollback.sql（完整還原上面快照）
-- 只建立 migration 檔，不得由開發流程直接套用正式資料庫。
-- ============================================================

BEGIN;

DO $$
BEGIN
    IF to_regprocedure('public.admin_save_setting(uuid, text, text, jsonb, text)') IS NULL THEN
        RAISE EXCEPTION '請先套用 126（admin_save_setting 不存在）';
    END IF;
END $$;

ALTER TABLE public.system_settings ENABLE ROW LEVEL SECURITY;

-- ===== A. 讀取：秘密列不給 anon/authenticated =====
DROP POLICY IF EXISTS "Allow RPC access settings" ON public.system_settings;
DROP POLICY IF EXISTS "Allow public read system_settings" ON public.system_settings;
DROP POLICY IF EXISTS "Allow public update system_settings" ON public.system_settings;
DROP POLICY IF EXISTS "Allow read settings" ON public.system_settings;
DROP POLICY IF EXISTS "Public read settings" ON public.system_settings;
DROP POLICY IF EXISTS "公開讀取系統設定" ON public.system_settings;
-- 011 的舊名（正式庫沒有，其他環境可能有）
DROP POLICY IF EXISTS "settings_select" ON public.system_settings;
DROP POLICY IF EXISTS "settings_insert" ON public.system_settings;
DROP POLICY IF EXISTS "settings_update" ON public.system_settings;
DROP POLICY IF EXISTS "settings_delete" ON public.system_settings;
DROP POLICY IF EXISTS "system_settings_read_non_secret" ON public.system_settings;

CREATE POLICY "system_settings_read_non_secret" ON public.system_settings
    FOR SELECT TO anon, authenticated
    USING (key NOT IN ('line_messaging_api'));

-- ===== B. 寫入：只能走 admin_save_setting =====
REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON public.system_settings FROM anon, authenticated;

COMMIT;
