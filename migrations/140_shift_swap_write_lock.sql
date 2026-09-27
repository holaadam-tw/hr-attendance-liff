-- ============================================================
-- 140: shift_swap_requests 只能經伺服器端函式寫入（撤掉前端直接寫表）
--
-- 正式庫現況（2026-09-28 唯讀查詢）：
--   - RLS 開；唯一政策「Allow all for authenticated」FOR ALL TO public USING (true) WITH CHECK (true)
--     （名稱寫 authenticated，套用對象其實是 PUBLIC，含 anon）
--   - anon／authenticated 對本表有全部 grant（arwdDxtm）；目前 0 列
--
-- 前提（本檔會檢查函式是否存在）：
--   1. 133 已套用（review_shift_swap_request：後台核准／拒絕）
--   2. 139 已套用（shift_swap_request_create／shift_swap_request_respond：員工申請、對方回覆）
--   3. line-push（含 shift_swap_review／shift_swap_create／shift_swap_respond）已部署、新前端已 merge，且至少過了 1 個工作天
--      （LINE 內建瀏覽器的舊快取頁面仍會直接寫本表；過早套用 → 舊頁面送出換班申請失敗）
--
-- 本檔：把 FOR ALL 政策換成只允許讀取的 SELECT 政策（對象同樣是 PUBLIC，讀取行為不變；讀取收斂屬 P1 另案）；
--       anon／authenticated 只留 SELECT。寫入只剩 SECURITY DEFINER 函式（擁有者 postgres）與 service_role。
-- 回滾：migrations/140_shift_swap_write_lock_rollback.sql
-- 套用身分：必須以表擁有者 postgres 套用（SQL Editor／supabase db push）；檔尾的自我檢查會在撤權未生效時整筆回復。
-- 只建立 migration 檔，不得由開發流程直接套用正式資料庫。
-- ============================================================

BEGIN;

DO $$ BEGIN
  IF to_regprocedure('public.review_shift_swap_request(uuid, text, uuid, text, text)') IS NULL
     OR to_regprocedure('public.shift_swap_request_create(uuid, text, uuid, date, text)') IS NULL
     OR to_regprocedure('public.shift_swap_request_respond(uuid, text, uuid, text)') IS NULL THEN
    RAISE EXCEPTION '133／139 尚未套用：請先套 133、139，部署 line-push、merge 前端並等至少 1 個工作天，再套 140';
  END IF;
END $$;

DROP POLICY IF EXISTS "Allow all for authenticated" ON public.shift_swap_requests;
DROP POLICY IF EXISTS "shift_swap_requests_select" ON public.shift_swap_requests;
CREATE POLICY "shift_swap_requests_select" ON public.shift_swap_requests FOR SELECT TO public USING (true);

REVOKE ALL ON public.shift_swap_requests FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.shift_swap_requests TO anon, authenticated;

-- 自我檢查（同一交易）：撤權沒生效就整筆回復
DO $$ DECLARE r text; p text; BEGIN
  FOREACH r IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    FOREACH p IN ARRAY ARRAY['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'] LOOP
      IF has_table_privilege(r, 'public.shift_swap_requests', p) THEN
        RAISE EXCEPTION '撤權未生效：% 仍有 shift_swap_requests 的 %（請以表擁有者 postgres 身分套用）', r, p;
      END IF;
    END LOOP;
    IF NOT has_table_privilege(r, 'public.shift_swap_requests', 'SELECT') THEN
      RAISE EXCEPTION '% 失去 shift_swap_requests 的 SELECT（讀取不應受影響）', r;
    END IF;
  END LOOP;
  IF (SELECT count(*) FROM pg_policies WHERE schemaname = 'public' AND tablename = 'shift_swap_requests') <> 1
     OR NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'shift_swap_requests'
                    AND policyname = 'shift_swap_requests_select' AND cmd = 'SELECT') THEN
    RAISE EXCEPTION 'shift_swap_requests 的政策應恰好 1 條（SELECT）';
  END IF;
  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.shift_swap_requests'::regclass) THEN
    RAISE EXCEPTION 'shift_swap_requests 的 RLS 應為開啟';
  END IF;
END $$;

COMMIT;
