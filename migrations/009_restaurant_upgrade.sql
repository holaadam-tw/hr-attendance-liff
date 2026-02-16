-- ============================================================
-- 009_restaurant_upgrade.sql
-- HR Attendance LIFF — 餐飲業管理升級
-- 新增: 取餐號碼、預約時間、LINE群組、套餐組合、會員集點
-- ============================================================

-- ========================
-- 1. orders 表新增欄位
-- ========================
ALTER TABLE orders ADD COLUMN IF NOT EXISTS pickup_number INTEGER;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS pickup_time TEXT;

-- ========================
-- 2. store_profiles 表新增欄位
-- ========================
ALTER TABLE store_profiles ADD COLUMN IF NOT EXISTS line_group_id TEXT;
ALTER TABLE store_profiles ADD COLUMN IF NOT EXISTS loyalty_config JSONB;
-- loyalty_config 範例：
-- {
--   "spend_per_point": 50,    -- 每消費 X 元得 1 點
--   "points_to_redeem": 10,   -- Y 點可兌換
--   "discount_amount": 50     -- 折抵 Z 元
-- }

-- ========================
-- 3. menu_items 表新增欄位（套餐組合）
-- ========================
ALTER TABLE menu_items ADD COLUMN IF NOT EXISTS is_combo BOOLEAN DEFAULT false;
ALTER TABLE menu_items ADD COLUMN IF NOT EXISTS combo_config JSONB;
-- combo_config 範例：
-- {
--   "groups": [
--     {"name": "主餐（選1）", "pick": 1, "items": ["item_id_1", "item_id_2"]},
--     {"name": "飲料（選1）", "pick": 1, "items": ["item_id_3", "item_id_4"]},
--     {"name": "加購（任選）", "pick": -1, "items": ["item_id_5"]}
--   ]
-- }

-- ========================
-- 4. 會員集點表
-- ========================
CREATE TABLE IF NOT EXISTS loyalty_points (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    store_id UUID REFERENCES store_profiles(id) ON DELETE CASCADE,
    customer_line_id TEXT NOT NULL,
    points INTEGER DEFAULT 0,
    total_earned INTEGER DEFAULT 0,
    total_redeemed INTEGER DEFAULT 0,
    created_at TIMESTAMPTZ DEFAULT now(),
    updated_at TIMESTAMPTZ DEFAULT now()
);

-- 每位客人在每家店只有一筆集點記錄
CREATE UNIQUE INDEX IF NOT EXISTS idx_loyalty_store_customer
    ON loyalty_points(store_id, customer_line_id);

ALTER TABLE loyalty_points ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "allow_select_loyalty_points" ON loyalty_points;
CREATE POLICY "allow_select_loyalty_points" ON loyalty_points FOR SELECT USING (true);
DROP POLICY IF EXISTS "allow_insert_loyalty_points" ON loyalty_points;
CREATE POLICY "allow_insert_loyalty_points" ON loyalty_points FOR INSERT WITH CHECK (true);
DROP POLICY IF EXISTS "allow_update_loyalty_points" ON loyalty_points;
CREATE POLICY "allow_update_loyalty_points" ON loyalty_points FOR UPDATE USING (true) WITH CHECK (true);
