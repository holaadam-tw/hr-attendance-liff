-- 027_loyalty_add_phone.sql
-- loyalty_members 支援 LINE + 手機雙識別

-- phone 欄位已存在（025_loyalty.sql 建立），確保不會衝突
-- 移除舊的 company+phone UNIQUE（026 已移除，這裡做 safety check）
ALTER TABLE loyalty_members
DROP CONSTRAINT IF EXISTS loyalty_members_company_phone_unique;

-- phone 允許 null，line_user_id 為主要識別
-- 同一公司下 phone 不重複（但允許 null）
CREATE UNIQUE INDEX IF NOT EXISTS idx_loyalty_members_company_phone
ON loyalty_members(company_id, phone) WHERE phone IS NOT NULL;
