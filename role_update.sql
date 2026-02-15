-- 新增缺少的欄位到 employees 表
ALTER TABLE employees ADD COLUMN IF NOT EXISTS role TEXT DEFAULT 'user';
ALTER TABLE employees ADD COLUMN IF NOT EXISTS hire_date DATE;

-- 更新現有員工的角色設定
-- 請將 'YOUR_LINE_USER_ID' 替換為您的實際 LINE User ID
UPDATE employees 
SET role = 'admin' 
WHERE line_user_id = 'YOUR_LINE_USER_ID';

-- 如果沒有到職日期，設為公司成立日期或預設值
UPDATE employees 
SET hire_date = '2026-01-01' 
WHERE hire_date IS NULL AND is_active = true;

-- 確保 role 欄位有正確的約束
ALTER TABLE employees ADD CONSTRAINT check_role 
CHECK (role IN ('admin', 'user', 'manager'));

-- 建立索引以提高查詢效能
CREATE INDEX IF NOT EXISTS idx_employees_role ON employees(role);
CREATE INDEX IF NOT EXISTS idx_employees_hire_date ON employees(hire_date);
