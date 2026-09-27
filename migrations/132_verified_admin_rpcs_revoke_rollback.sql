-- ============================================================
-- 132 回滾：還原 9 支 RPC 的正式庫 proacl（2026-09-27）
--   admin_create_employee／admin_update_employee／admin_delete_pending_employee／approve_makeup_request：
--     anon＋authenticated＋service_role（沒有 PUBLIC）
--   reject_makeup_request／approve_overtime_request／reject_overtime_request／upsert_schedule／delete_schedule：
--     PUBLIC＋anon＋authenticated＋service_role
-- ⚠️ 回滾後冒充管理員、跨公司核准補卡的洞重新打開，只在 132 造成線上故障時使用。
-- ============================================================

BEGIN;

GRANT EXECUTE ON FUNCTION
    public.admin_create_employee(uuid, text, jsonb),
    public.admin_update_employee(uuid, text, uuid, jsonb),
    public.admin_delete_pending_employee(uuid, text, uuid),
    public.approve_makeup_request(uuid, uuid)
TO anon, authenticated, service_role;

GRANT EXECUTE ON FUNCTION
    public.reject_makeup_request(uuid, uuid, text),
    public.approve_overtime_request(uuid, uuid, numeric, text, text),
    public.reject_overtime_request(uuid, uuid, text, text, text),
    public.upsert_schedule(uuid, uuid, date, uuid, boolean, text),
    public.delete_schedule(uuid, uuid, date)
TO PUBLIC, anon, authenticated, service_role;

COMMIT;
