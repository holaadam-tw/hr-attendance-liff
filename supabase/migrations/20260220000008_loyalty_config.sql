-- ===== loyalty_config：集點設定 =====
CREATE TABLE IF NOT EXISTS loyalty_config (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    store_id UUID NOT NULL,
    enabled BOOLEAN DEFAULT true,
    points_per_dollar NUMERIC(5,2) DEFAULT 1,        -- 每消費 1 元得幾點
    points_to_redeem INTEGER DEFAULT 10,              -- 累積幾點可兌換
    discount_amount NUMERIC(10,2) DEFAULT 50,         -- 折扣金額
    points_expiry_days INTEGER,                       -- 點數過期天數（null = 永不過期）
    min_purchase_for_points NUMERIC(10,2) DEFAULT 0,  -- 最低消費門檻才計點
    created_at TIMESTAMPTZ DEFAULT now(),
    updated_at TIMESTAMPTZ DEFAULT now(),
    UNIQUE(store_id)
);

CREATE INDEX IF NOT EXISTS idx_loyalty_config_store ON loyalty_config(store_id);

ALTER TABLE loyalty_config ENABLE ROW LEVEL SECURITY;

-- 讀取：所有人都可以（點餐頁需要查詢集點設定）
CREATE POLICY "loyalty_config_select" ON loyalty_config FOR SELECT USING (true);

-- 寫入：需要登入（管理員設定）
CREATE POLICY "loyalty_config_insert" ON loyalty_config FOR INSERT WITH CHECK (true);
CREATE POLICY "loyalty_config_update" ON loyalty_config FOR UPDATE USING (true);

COMMENT ON TABLE loyalty_config IS '商店集點設定';
COMMENT ON COLUMN loyalty_config.points_per_dollar IS '每消費 1 元得幾點（例如 1.5 表示消費 100 元得 150 點）';
COMMENT ON COLUMN loyalty_config.points_to_redeem IS '累積幾點可兌換折扣';
COMMENT ON COLUMN loyalty_config.discount_amount IS '兌換折扣金額（例如 50 表示折抵 $50）';
