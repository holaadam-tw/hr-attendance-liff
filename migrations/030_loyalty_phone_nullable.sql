-- 030_loyalty_phone_nullable.sql
-- phone 改為可 null（LINE 會員不一定有手機）

ALTER TABLE loyalty_members ALTER COLUMN phone DROP NOT NULL;
