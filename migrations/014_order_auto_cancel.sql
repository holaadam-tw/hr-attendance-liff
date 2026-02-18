-- ============================================================
-- 014_order_auto_cancel.sql
-- 訂單自動逾時取消：pending 超過 30 分鐘自動取消
-- ============================================================

-- 1) 建立逾時取消函數
CREATE OR REPLACE FUNCTION cancel_expired_orders()
RETURNS INTEGER AS $$
DECLARE
    cancelled_count INTEGER;
BEGIN
    UPDATE orders
    SET status = 'cancelled',
        notes = COALESCE(notes, '') || ' [系統自動取消：逾時未處理]',
        updated_at = now()
    WHERE status = 'pending'
      AND created_at < now() - INTERVAL '30 minutes';

    GET DIAGNOSTICS cancelled_count = ROW_COUNT;
    RETURN cancelled_count;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- 2) 用 pg_cron 每 5 分鐘執行一次（Supabase 已內建 pg_cron）
-- 注意：需要 Dashboard → Database → Extensions 確認 pg_cron 已啟用
SELECT cron.schedule(
    'cancel-expired-orders',     -- job name
    '*/5 * * * *',               -- 每 5 分鐘
    $$ SELECT cancel_expired_orders(); $$
);

-- 3) 也建立一個 updated_at 自動更新 trigger（訂單狀態變更時）
CREATE OR REPLACE FUNCTION update_order_timestamp()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = now();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_order_updated_at ON orders;
CREATE TRIGGER trg_order_updated_at
    BEFORE UPDATE ON orders
    FOR EACH ROW EXECUTE FUNCTION update_order_timestamp();
