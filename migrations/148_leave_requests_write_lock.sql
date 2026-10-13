-- ============================================================
-- 148: leave_requests 只能經 SECURITY DEFINER RPC 寫入
--
-- 正式庫現況（2026-10-13 唯讀盤點，見
-- .codex/handoffs/2026-10-13_B_prod_inventory.md）：
--   - 表 owner=postgres、RLS 已開；anon／authenticated 目前有全部 table grant。
--   - 寫入政策為 Allow RPC access leaves（ALL true）、允許新增請假單（INSERT true）、
--     允許更新待審核請假單（UPDATE pending，無 WITH CHECK）。讀取政策另有「允許查看請假單」。
--   - 前端、Edge Function、pg_cron 均無直接寫入；正式庫唯一寫入函式
--     submit_leave_request／approve_leave_request 都是 SECURITY DEFINER、owner=postgres。
--   - trg_resolve_anomaly_on_leave 的函式為 SECURITY DEFINER；update_leave_requests_updated_at
--     只修改 NEW.updated_at。沒有 SECURITY INVOKER 寫入路徑。
--
-- 本檔只移除三條寫入政策與 anon／authenticated 的表寫入權；SELECT 與讀取政策不動。
-- 回滾：migrations/148_leave_requests_write_lock_rollback.sql。
-- 套用身分：表擁有者 postgres；檔尾自我檢查失敗會使整筆交易回復。
-- 只建立 migration 檔，不得由開發流程直接套用正式資料庫。
-- ============================================================

BEGIN;

DROP POLICY IF EXISTS "Allow RPC access leaves" ON public.leave_requests;
DROP POLICY IF EXISTS "允許新增請假單" ON public.leave_requests;
DROP POLICY IF EXISTS "允許更新待審核請假單" ON public.leave_requests;

REVOKE ALL ON public.leave_requests FROM anon, authenticated;
GRANT SELECT ON public.leave_requests TO anon, authenticated;

-- 自我檢查（同一交易）：撤權或政策移除沒生效就整筆回復。
DO $$ DECLARE r text; p text; BEGIN
  FOREACH r IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    FOREACH p IN ARRAY ARRAY['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'] LOOP
      IF has_table_privilege(r, 'public.leave_requests', p) THEN
        RAISE EXCEPTION '撤權未生效：% 仍有 leave_requests 的 %（請以表擁有者 postgres 身分套用）', r, p;
      END IF;
    END LOOP;
    IF NOT has_table_privilege(r, 'public.leave_requests', 'SELECT') THEN
      RAISE EXCEPTION '% 失去 leave_requests 的 SELECT（第一階段不應影響讀取）', r;
    END IF;
  END LOOP;
  IF EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'leave_requests'
      AND cmd IN ('ALL', 'INSERT', 'UPDATE', 'DELETE')
  ) THEN
    RAISE EXCEPTION 'leave_requests 仍有寫入政策';
  END IF;
END $$;

COMMIT;
