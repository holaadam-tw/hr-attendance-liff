-- ============================================================
-- 134: attendance 只能經伺服器端函式寫入（撤掉前端直接寫表）
--
-- 正式庫現況（2026-09-28 唯讀查詢）：
--   - anon／authenticated 對 attendance 有全部 grant（arwdDxtm）
--   - 寫入政策：「Allow RPC access attendance」（ALL true）、「允許插入考勤記錄」（INSERT true）、
--     「允許更新考勤記錄」（UPDATE true）。permissive 政策任一成立即放行，「Block direct access」（ALL false）沒有作用。
--
-- 盤點（前端／Edge Function／pg_cron／SQL 函式）：
--   - 前端 0 處直接寫 attendance（最後一處在 2026-04 已改成 RPC）；只剩讀取。
--   - 寫 attendance 的全部是 SECURITY DEFINER 函式，擁有者＝postgres（＝表擁有者、BYPASSRLS）：
--     quick_check_in、quick_check_out_after_clock_in_makeup、kiosk_check_in、admin_makeup_punch、
--     approve_makeup_request（131 的 review_makeup_request 內部呼叫）、quick_check_in_v2／quick_check_in_debug2（131 已撤前端權限）
--   - 觸發器 trg_calc_work_hours／trg_resolve_anomaly_on_checkout 同為 SECURITY DEFINER；pg_cron 與 Edge Function 都不寫 attendance。
--   → 撤掉 anon／authenticated 的寫入權，上述函式照常（它們以擁有者身分執行，不經過 grant／RLS）。
--
-- 本檔：
--   - drop 三條寫入政策（讀取政策不動；讀取收斂屬 P1，另案）
--   - anon／authenticated 只留 SELECT（撤 INSERT／UPDATE／DELETE／TRUNCATE／REFERENCES／TRIGGER／MAINTAIN）
--
-- 不依賴前端改版：可單獨先套，或與 133 同一次套。
-- 回滾：migrations/134_attendance_write_lock_rollback.sql（還原三條政策與 grant）
-- 只建立 migration 檔，不得由開發流程直接套用正式資料庫。
-- ============================================================

BEGIN;

DROP POLICY IF EXISTS "Allow RPC access attendance" ON public.attendance;
DROP POLICY IF EXISTS "允許插入考勤記錄" ON public.attendance;
DROP POLICY IF EXISTS "允許更新考勤記錄" ON public.attendance;

REVOKE ALL ON public.attendance FROM anon, authenticated;
GRANT SELECT ON public.attendance TO anon, authenticated;

COMMIT;
