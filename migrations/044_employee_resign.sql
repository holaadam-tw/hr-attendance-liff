-- ============================================================
-- 044: 員工離職管理（軟刪除）
-- ============================================================

-- 離職日期
ALTER TABLE employees ADD COLUMN IF NOT EXISTS resigned_date DATE;

-- 離職原因
ALTER TABLE employees ADD COLUMN IF NOT EXISTS resign_reason TEXT;

-- 離職備註
ALTER TABLE employees ADD COLUMN IF NOT EXISTS resign_note TEXT;

-- status 加入 'resigned'（先移除舊 CHECK，再建新的）
ALTER TABLE employees DROP CONSTRAINT IF EXISTS employees_status_check;
ALTER TABLE employees ADD CONSTRAINT employees_status_check
    CHECK (status IN ('pending', 'approved', 'rejected', 'resigned'));

-- 既有 is_active=false 且 status 不是 pending/rejected 的設為 resigned
UPDATE employees SET status = 'resigned'
WHERE is_active = false AND status NOT IN ('pending', 'rejected') AND resigned_date IS NULL AND status != 'resigned';
