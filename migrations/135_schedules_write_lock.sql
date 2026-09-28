-- ============================================================
-- 135: schedules 只能經伺服器端函式寫入（撤掉前端直接寫表）
--
-- 正式庫現況（2026-09-28 唯讀查詢）：
--   - anon／authenticated 對 schedules 有全部 grant（arwdDxtm）
--   - 寫入政策：schedules_insert（INSERT true）、schedules_update（UPDATE true），套用對象 PUBLIC；沒有 DELETE 政策
--
-- 前提（本檔會檢查函式是否存在）：
--   1. 131 已套用（save_schedules_verified：後台／打卡總覽的排班儲存）
--   2. 133 已套用（review_shift_swap_request：換班核准）
--   3. line-push（含 schedule_save／shift_swap_review 驗證動作）已部署、新前端已 merge，且至少過了 1 個工作天
--      （LINE 內建瀏覽器的舊快取頁面仍會直接寫 schedules；過早套用 → 舊頁面儲存排班／核准換班失敗）
--
-- 寫 schedules 的其他路徑：upsert_schedule／delete_schedule（SECURITY DEFINER，擁有者 postgres，由 save_schedules_verified 呼叫），
--   不受本檔影響。pg_cron 與 Edge Function 都不寫 schedules。
--
-- 本檔：drop 兩條寫入政策；anon／authenticated 只留 SELECT（讀取收斂屬 P1，另案）
-- 回滾：migrations/135_schedules_write_lock_rollback.sql
-- 套用身分：必須以表擁有者 postgres 套用（SQL Editor／supabase db push）；檔尾的自我檢查會在撤權未生效時整筆回復。
-- 只建立 migration 檔，不得由開發流程直接套用正式資料庫。
-- ============================================================

BEGIN;

DO $$ BEGIN
  IF to_regprocedure('public.save_schedules_verified(uuid, text, jsonb)') IS NULL
     OR to_regprocedure('public.review_shift_swap_request(uuid, text, uuid, text, text)') IS NULL THEN
    RAISE EXCEPTION '131／133 尚未套用：請先套 131、133，部署 line-push、merge 前端並等至少 1 個工作天，再套 135';
  END IF;
END $$;

DROP POLICY IF EXISTS "schedules_insert" ON public.schedules;
DROP POLICY IF EXISTS "schedules_update" ON public.schedules;

REVOKE ALL ON public.schedules FROM anon, authenticated;
GRANT SELECT ON public.schedules TO anon, authenticated;

-- 自我檢查（同一交易）：撤權沒生效就整筆回復
DO $$ DECLARE r text; p text; BEGIN
  FOREACH r IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    FOREACH p IN ARRAY ARRAY['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE'] LOOP
      IF has_table_privilege(r, 'public.schedules', p) THEN
        RAISE EXCEPTION '撤權未生效：% 仍有 schedules 的 %（請以表擁有者 postgres 身分套用）', r, p;
      END IF;
    END LOOP;
    IF NOT has_table_privilege(r, 'public.schedules', 'SELECT') THEN
      RAISE EXCEPTION '% 失去 schedules 的 SELECT（讀取不應受影響）', r;
    END IF;
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'schedules'
             AND cmd IN ('INSERT', 'UPDATE', 'DELETE', 'ALL') AND qual IS DISTINCT FROM 'false') THEN
    RAISE EXCEPTION 'schedules 仍有會放行的寫入政策';
  END IF;
END $$;

COMMIT;
