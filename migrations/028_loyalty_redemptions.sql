-- 028_loyalty_redemptions.sql
-- 兌換碼系統 + 點數有效期

-- 兌換記錄表
CREATE TABLE IF NOT EXISTS loyalty_redemptions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id UUID NOT NULL REFERENCES companies(id),
    member_id UUID NOT NULL REFERENCES loyalty_members(id),
    reward_id UUID NOT NULL REFERENCES loyalty_rewards(id),
    code TEXT NOT NULL,
    points_used INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'used', 'expired')),
    redeemed_at TIMESTAMPTZ,
    redeemed_by UUID REFERENCES employees(id),
    expires_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT loyalty_redemptions_code_unique UNIQUE (company_id, code)
);

CREATE INDEX IF NOT EXISTS idx_loyalty_redemptions_member ON loyalty_redemptions(member_id);
CREATE INDEX IF NOT EXISTS idx_loyalty_redemptions_code ON loyalty_redemptions(company_id, code);

-- loyalty_members 加 expiry_date（點數有效期）
ALTER TABLE loyalty_members
ADD COLUMN IF NOT EXISTS expiry_date DATE;

-- 點數有效期觸發：更新 last_visit 時重算 expiry_date
CREATE OR REPLACE FUNCTION update_loyalty_expiry()
RETURNS TRIGGER AS $$
DECLARE
    v_expiry_months INT;
BEGIN
    SELECT expiry_months INTO v_expiry_months
    FROM loyalty_settings
    WHERE company_id = NEW.company_id;

    IF v_expiry_months > 0 THEN
        NEW.expiry_date := CURRENT_DATE + (v_expiry_months || ' months')::INTERVAL;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_loyalty_expiry ON loyalty_members;
CREATE TRIGGER trg_loyalty_expiry
BEFORE UPDATE OF last_visit ON loyalty_members
FOR EACH ROW EXECUTE FUNCTION update_loyalty_expiry();

-- RLS
ALTER TABLE loyalty_redemptions ENABLE ROW LEVEL SECURITY;
CREATE POLICY "loyalty_redemptions_all" ON loyalty_redemptions
FOR ALL USING (true) WITH CHECK (true);
