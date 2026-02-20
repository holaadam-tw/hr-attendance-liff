-- ===== store_customers：客戶/會員資料 =====
CREATE TABLE IF NOT EXISTS store_customers (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    store_id UUID NOT NULL,
    phone TEXT NOT NULL,
    name TEXT,
    line_uid TEXT,
    tags TEXT[] DEFAULT '{}',           -- 標籤：'regular'(常客), 'vip', 'blacklist'(黑名單)
    total_orders INTEGER DEFAULT 0,
    total_spent NUMERIC(10,2) DEFAULT 0,
    no_show_count INTEGER DEFAULT 0,     -- 未取餐次數
    notes TEXT,
    created_at TIMESTAMPTZ DEFAULT now(),
    updated_at TIMESTAMPTZ DEFAULT now(),
    UNIQUE(store_id, phone)
);

-- 索引
CREATE INDEX IF NOT EXISTS idx_store_customers_store ON store_customers(store_id);
CREATE INDEX IF NOT EXISTS idx_store_customers_phone ON store_customers(store_id, phone);
CREATE INDEX IF NOT EXISTS idx_store_customers_line ON store_customers(store_id, line_uid);

-- RLS
ALTER TABLE store_customers ENABLE ROW LEVEL SECURITY;

-- 讀取：所有人都可以（匿名用戶也要能查自己的會員資訊）
CREATE POLICY "store_customers_select" ON store_customers FOR SELECT USING (true);

-- 寫入：anon 也能（點餐時自動建立客戶）
CREATE POLICY "store_customers_insert" ON store_customers FOR INSERT WITH CHECK (true);

-- 更新：anon 也能（更新累計訂單等）
CREATE POLICY "store_customers_update" ON store_customers FOR UPDATE USING (true);

-- 註解
COMMENT ON TABLE store_customers IS '商店客戶/會員資料';
COMMENT ON COLUMN store_customers.tags IS '標籤陣列：regular(常客)/vip/blacklist(黑名單)';
COMMENT ON COLUMN store_customers.no_show_count IS '未取餐次數，用於提醒';
