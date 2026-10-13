-- ============================================================
-- 146: 離職／停用者的 LINE Auth 帳號自動停權——每 5 分鐘檢查，有對象才呼叫 line-auth reconcile
--
-- 前提：145 已套；line-auth 已部署含 reconcile 的新版（本 PR）。順序錯了也無害：
--   舊版 line-auth 收到 {"action":"reconcile"} 會回 400，下一輪再試；145 未套則本檔開頭中止。
-- 做什麼：pg_cron 排程 line-auth-reconcile（*/5）：
--   public.line_auth_reconcile_needed() 為 true（有「LINE Auth 帳號未停權、但已不在職」的人）才 net.http_post
--   → line-auth 以 admin API 停權（ban，可逆）。平常沒有對象時完全不打 HTTP。
--   授權：用 anon key（前端 common.js 已公開的同一把；Edge Function 預設 verify_jwt）。
--   reconcile 只依 DB 現況停權「已不在職」的帳號、冪等、每次最多 50 筆，所以任何人觸發都不會停權到在職者。
-- 為什麼不用 employees 觸發器：員工資料有十幾條寫入路徑（admin_update_employee、bind_*、platform_admin_save、
--   Dashboard 直接改…），排程依「結果」比對就全部涵蓋，也不會讓員工資料的寫入因為網路或 pg_net 出錯而失敗。
--   即時性由 145 保證（caller_line_user_id 每次現查，離職當下就失去身分）；停權只是第二道。
-- 回滾：migrations/146_line_auth_reconcile_cron_rollback.sql
-- 只建立 migration 檔，不得由開發流程直接套用正式資料庫。
-- ============================================================

DO $$ BEGIN
  IF to_regprocedure('public.line_auth_reconcile_needed()') IS NULL THEN
    RAISE EXCEPTION '145 尚未套用（line_auth_reconcile_needed 不存在）：請先套 145，再套 146';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') OR NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_net') THEN
    RAISE EXCEPTION 'pg_cron／pg_net 未啟用';
  END IF;
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'line-auth-reconcile') THEN
    RAISE EXCEPTION '146 已套用過（排程 line-auth-reconcile 已存在）';
  END IF;
END $$;

SELECT cron.schedule(
  'line-auth-reconcile',
  '*/5 * * * *',
  $cron$
  SELECT net.http_post(
      url := 'https://nssuisyvlrqnqfxupklb.supabase.co/functions/v1/line-auth',
      headers := jsonb_build_object(
          'Content-Type', 'application/json',
          'Authorization', 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im5zc3Vpc3l2bHJxbnFmeHVwa2xiIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjkyOTAwMzUsImV4cCI6MjA4NDg2NjAzNX0.q_B6v3gf1TOCuAq7z0xIw10wDueCSJn0p37VzdMfmbc'  -- gitleaks:allow（前端 common.js 已公開的 anon key，不是秘密）
      ),
      body := jsonb_build_object('action', 'reconcile'),
      timeout_milliseconds := 10000
  )
  WHERE public.line_auth_reconcile_needed();
  $cron$
);
