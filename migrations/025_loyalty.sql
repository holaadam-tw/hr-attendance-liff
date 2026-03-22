-- 025_loyalty.sql
-- 集點會員系統資料表

-- ===== 1. loyalty_members（會員）=====
CREATE TABLE IF NOT EXISTS loyalty_members (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id UUID NOT NULL REFERENCES companies(id),
    phone TEXT NOT NULL,
    name TEXT,
    total_points INTEGER NOT NULL DEFAULT 0,
    used_points INTEGER NOT NULL DEFAULT 0,
    available_points INTEGER GENERATED ALWAYS AS (total_points - used_points) STORED,
    member_since DATE NOT NULL DEFAULT CURRENT_DATE,
    last_visit DATE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT loyalty_members_company_phone_unique UNIQUE (company_id, phone)
);

CREATE INDEX IF NOT EXISTS idx_loyalty_members_company ON loyalty_members(company_id);

-- ===== 2. loyalty_transactions（點數異動記錄）=====
CREATE TABLE IF NOT EXISTS loyalty_transactions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id UUID NOT NULL REFERENCES companies(id),
    member_id UUID NOT NULL REFERENCES loyalty_members(id) ON DELETE CASCADE,
    type TEXT NOT NULL CHECK (type IN ('earn', 'redeem')),
    points INTEGER NOT NULL,
    amount NUMERIC(10,2),
    source TEXT CHECK (source IN ('order', 'booking', 'manual')),
    source_id UUID,
    note TEXT,
    created_by UUID REFERENCES employees(id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_loyalty_transactions_member ON loyalty_transactions(member_id);
CREATE INDEX IF NOT EXISTS idx_loyalty_transactions_source ON loyalty_transactions(source, source_id);

-- ===== 3. loyalty_rewards（兌換商品）=====
CREATE TABLE IF NOT EXISTS loyalty_rewards (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id UUID NOT NULL REFERENCES companies(id),
    name TEXT NOT NULL,
    description TEXT,
    points_required INTEGER NOT NULL DEFAULT 0,
    is_active BOOLEAN NOT NULL DEFAULT true,
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_loyalty_rewards_company ON loyalty_rewards(company_id);

-- ===== 4. loyalty_settings（集點設定）=====
CREATE TABLE IF NOT EXISTS loyalty_settings (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id UUID NOT NULL REFERENCES companies(id),
    points_per_amount INTEGER NOT NULL DEFAULT 50,
    welcome_points INTEGER NOT NULL DEFAULT 0,
    expiry_months INTEGER NOT NULL DEFAULT 0,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT loyalty_settings_company_unique UNIQUE (company_id)
);

-- ===== RLS =====
ALTER TABLE loyalty_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE loyalty_transactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE loyalty_rewards ENABLE ROW LEVEL SECURITY;
ALTER TABLE loyalty_settings ENABLE ROW LEVEL SECURITY;

-- 全開 policy（消費者需要讀寫）
CREATE POLICY "loyalty_members_all" ON loyalty_members FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "loyalty_transactions_all" ON loyalty_transactions FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "loyalty_rewards_all" ON loyalty_rewards FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "loyalty_settings_all" ON loyalty_settings FOR ALL USING (true) WITH CHECK (true);
