-- 026_loyalty_line_user.sql
-- 集點會員改用 LINE userId 識別（取代手機號碼）

ALTER TABLE loyalty_members
ADD COLUMN IF NOT EXISTS line_user_id TEXT;

ALTER TABLE loyalty_members
DROP CONSTRAINT IF EXISTS loyalty_members_company_phone_unique;

ALTER TABLE loyalty_members
ADD CONSTRAINT loyalty_members_company_line_unique
UNIQUE (company_id, line_user_id);

CREATE INDEX IF NOT EXISTS idx_loyalty_members_line
ON loyalty_members(line_user_id);
