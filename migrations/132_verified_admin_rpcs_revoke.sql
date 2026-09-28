-- ============================================================
-- 132: 撤掉前端直接呼叫 9 支管理 RPC 的權限（Phase 0 第二步）
--
-- 前提：131 已套用、line-push（含新的驗證動作）已部署、新前端已 merge 且至少過了 1 個工作天
--       （LINE 內建瀏覽器／sessionStorage 的舊快取過期；舊頁面還在直接呼叫這 9 支 RPC）。
--
-- 本檔：以下 9 支撤掉 PUBLIC／anon／authenticated 的 EXECUTE，只留 service_role
--   （之後只能經 line-push Edge Function：先向 LINE 驗證 LIFF access token，身分＝LINE 回傳的 userId，前端報的一律忽略）
--   admin_create_employee／admin_update_employee／admin_delete_pending_employee
--   approve_makeup_request／reject_makeup_request／approve_overtime_request／reject_overtime_request
--   upsert_schedule／delete_schedule
--   （131 的 review_*／save_schedules_verified 以 SECURITY DEFINER 身分在內部呼叫後 6 支，不受影響）
--
-- 套用後「實際」堵住的（誠實列出）：
--   - 冒充管理員（用 anon 讀到的 line_user_id）呼叫 admin_*：把自己升成 admin、改掉 admin 的 LINE ID
--     （→ 進而通過 126／129 的 LIFF 驗證）、新增 admin、刪待審登記
--   - 加班核定／不認列：overtime_requests 沒有任何 anon 寫入政策，本檔之後前端唯一的寫入路徑是經 LIFF 驗證的 review_overtime_request
--   - 補卡申請的「狀態」（核准／拒絕、核准人）：makeup_punch_requests 的寫入政策以 auth.uid() 為條件，anon 不成立
--
-- ⚠️ 本檔「沒有」堵住的（2026-09-27 正式庫 pg_policies 實況，下一個 P0，另案處理）：
--   - attendance：政策「Allow RPC access attendance」（ALL，USING true／WITH CHECK true）、「允許插入考勤記錄」（INSERT true）、
--     「允許更新考勤記錄」（UPDATE true），anon/authenticated 也有 INSERT/UPDATE/DELETE/TRUNCATE grant
--     → 撤掉 approve_makeup_request 的 anon 權限後，攻擊者仍可直接對 attendance 寫入／改／刪出勤紀錄
--   - schedules：政策「schedules_insert」（INSERT true）、「schedules_update」（UPDATE true）＋ anon 全部 grant，
--     前端 modules/schedules.js（saveSchedule、approveSwap）也還在直接寫這張表
--     → 撤掉 upsert_schedule 的 anon 權限後，攻擊者仍可直接新增／改別人的班表（DELETE 目前因沒有政策而被 RLS 擋下）
--   所以就 attendance／schedules 而言，本檔只是把「經 RPC 的那條路」收掉；直接寫表的路要等「鎖 attendance／schedules 直接寫入」那一包。
--
-- 仍未解決（P1，另案）：其他約 55 支 RPC 仍信任前端傳的 p_line_user_id（讀薪資、出勤等），employees 的 line_user_id 仍對 anon 公開。
--
-- 回滾：migrations/132_verified_admin_rpcs_revoke_rollback.sql（還原正式庫 proacl）
-- 只建立 migration 檔，不得由開發流程直接套用正式資料庫。
-- ============================================================

BEGIN;

DO $$ BEGIN
  IF to_regprocedure('public.review_makeup_request(uuid, text, uuid, text, text)') IS NULL
     OR to_regprocedure('public.save_schedules_verified(uuid, text, jsonb)') IS NULL
     OR to_regprocedure('public.is_company_admin_strict_caller(text, uuid)') IS NULL THEN
    RAISE EXCEPTION '131 尚未套用：請先套 131、部署 line-push、merge 前端並等至少 1 個工作天，再套 132';
  END IF;
END $$;

REVOKE EXECUTE ON FUNCTION public.admin_create_employee(uuid, text, jsonb) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.admin_update_employee(uuid, text, uuid, jsonb) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.admin_delete_pending_employee(uuid, text, uuid) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.approve_makeup_request(uuid, uuid) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.reject_makeup_request(uuid, uuid, text) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.approve_overtime_request(uuid, uuid, numeric, text, text) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.reject_overtime_request(uuid, uuid, text, text, text) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.upsert_schedule(uuid, uuid, date, uuid, boolean, text) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.delete_schedule(uuid, uuid, date) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION
    public.admin_create_employee(uuid, text, jsonb),
    public.admin_update_employee(uuid, text, uuid, jsonb),
    public.admin_delete_pending_employee(uuid, text, uuid),
    public.approve_makeup_request(uuid, uuid),
    public.reject_makeup_request(uuid, uuid, text),
    public.approve_overtime_request(uuid, uuid, numeric, text, text),
    public.reject_overtime_request(uuid, uuid, text, text, text),
    public.upsert_schedule(uuid, uuid, date, uuid, boolean, text),
    public.delete_schedule(uuid, uuid, date)
TO service_role;

COMMIT;
