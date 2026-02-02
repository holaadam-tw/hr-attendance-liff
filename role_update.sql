-- 新增 role 欄位到 employees 表
ALTER TABLE employees ADD COLUMN IF NOT EXISTS role TEXT DEFAULT 'user';

-- 更新現有員工的角色設定
-- 請將 'YOUR_LINE_USER_ID' 替換為您的實際 LINE User ID
UPDATE employees 
SET role = 'admin' 
WHERE line_user_id = 'YOUR_LINE_USER_ID';

-- 確保 role 欄位有正確的約束
ALTER TABLE employees ADD CONSTRAINT check_role 
CHECK (role IN ('admin', 'user', 'manager'));

-- 建立索引以提高查詢效能
CREATE INDEX IF NOT EXISTS idx_employees_role ON employees(role);
