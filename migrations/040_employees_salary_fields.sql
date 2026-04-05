-- 040_employees_salary_fields.sql
-- 薪資系統強化：employees 加薪資快取欄位 + 未設定員工自動建立 salary_settings

-- 1. employees 表加快取欄位（非正規化，加速查詢）
ALTER TABLE employees ADD COLUMN IF NOT EXISTS salary_type TEXT DEFAULT 'hourly';
ALTER TABLE employees ADD COLUMN IF NOT EXISTS hourly_rate NUMERIC(10,2) DEFAULT 196;

-- 2. 從現有 salary_settings 同步資料到 employees
UPDATE employees e SET
    salary_type = ss.salary_type,
    hourly_rate = CASE
        WHEN ss.salary_type = 'hourly' THEN ss.base_salary
        WHEN ss.salary_type = 'daily' THEN ROUND(ss.base_salary / 8, 2)
        WHEN ss.salary_type = 'monthly' THEN ROUND(ss.base_salary / 30 / 8, 2)
    END
FROM salary_settings ss
WHERE ss.employee_id = e.id AND ss.is_current = true;

-- 3. 為未設定薪資的在職員工自動建立 salary_settings（時薪 NT$196）
INSERT INTO salary_settings (employee_id, salary_type, base_salary, is_current)
SELECT e.id, 'hourly', 196, true
FROM employees e
LEFT JOIN salary_settings ss ON ss.employee_id = e.id AND ss.is_current = true
WHERE ss.id IS NULL AND e.is_active = true
ON CONFLICT DO NOTHING;
