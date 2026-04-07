-- ============================================================
-- 042: 員工自助登記 — employees 加欄位
-- ============================================================

-- 手機號碼（employees 已有 phone 欄位，確保存在）
DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='employees' AND column_name='phone') THEN
        ALTER TABLE employees ADD COLUMN phone VARCHAR;
    END IF;
END $$;

-- 緊急聯絡人
ALTER TABLE employees ADD COLUMN IF NOT EXISTS emergency_contact VARCHAR;

-- 緊急聯絡人電話
ALTER TABLE employees ADD COLUMN IF NOT EXISTS emergency_phone VARCHAR;

-- 登記狀態：pending（待審核）/ approved（已通過）/ rejected（已拒絕）
-- 既有員工預設 approved
ALTER TABLE employees ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'approved'
    CHECK (status IN ('pending', 'approved', 'rejected'));

-- 既有 is_active=true 的員工設為 approved
UPDATE employees SET status = 'approved' WHERE status IS NULL AND is_active = true;
UPDATE employees SET status = 'rejected' WHERE status IS NULL AND is_active = false;
