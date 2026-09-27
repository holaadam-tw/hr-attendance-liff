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
-- 套用後堵住的攻擊：
--   - 冒充管理員（用 anon 讀到的 line_user_id）把自己升成 admin、改掉 admin 的 LINE ID（→ 進而通過 126／129 的 LIFF 驗證）
--   - 不用任何身分就核准／拒絕別家公司的補卡、加班；冒充排班者改別人班表
-- 仍未解決（P1，另案）：其他 70 多支 RPC 仍信任前端傳的 p_line_user_id（讀薪資、出勤等），employees 的 line_user_id 仍對 anon 公開。
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
