-- ============================================================
-- 004_payroll_columns.sql
-- HR Attendance LIFF — 薪資發放補充欄位 + 缺少的表
-- ============================================================

-- ========================
-- 1. payroll 補充欄位
-- ========================
ALTER TABLE payroll ADD COLUMN IF NOT EXISTS salary_type TEXT DEFAULT 'monthly';
ALTER TABLE payroll ADD COLUMN IF NOT EXISTS meal_allowance NUMERIC DEFAULT 0;
ALTER TABLE payroll ADD COLUMN IF NOT EXISTS position_allowance NUMERIC DEFAULT 0;
ALTER TABLE payroll ADD COLUMN IF NOT EXISTS night_allowance NUMERIC DEFAULT 0;
ALTER TABLE payroll ADD COLUMN IF NOT EXISTS pension_self NUMERIC DEFAULT 0;
ALTER TABLE payroll ADD COLUMN IF NOT EXISTS income_tax NUMERIC DEFAULT 0;
ALTER TABLE payroll ADD COLUMN IF NOT EXISTS personal_leave_deduction NUMERIC DEFAULT 0;
ALTER TABLE payroll ADD COLUMN IF NOT EXISTS manual_adjustment NUMERIC DEFAULT 0;
ALTER TABLE payroll ADD COLUMN IF NOT EXISTS adjustment_note TEXT DEFAULT '';

-- ========================
-- 2. Unique constraint（for upsert）
-- ========================
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'payroll_employee_year_month_key'
    ) THEN
        ALTER TABLE payroll ADD CONSTRAINT payroll_employee_year_month_key
            UNIQUE (employee_id, year, month);
    END IF;
END $$;

-- ========================
-- 3. 勞健保級距表（2024 年版本）
-- ========================
CREATE TABLE IF NOT EXISTS insurance_brackets (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    salary_min NUMERIC NOT NULL,
    salary_max NUMERIC NOT NULL,
    insured_amount NUMERIC NOT NULL,
    labor_rate NUMERIC DEFAULT 0.125,
    labor_employee_share NUMERIC DEFAULT 0.2,
    health_rate NUMERIC DEFAULT 0.0517,
    health_employee_share NUMERIC DEFAULT 0.3,
    is_active BOOLEAN DEFAULT true,
    created_at TIMESTAMPTZ DEFAULT now()
);

INSERT INTO insurance_brackets (salary_min, salary_max, insured_amount, labor_rate, labor_employee_share, health_rate, health_employee_share)
SELECT * FROM (VALUES
    (0,      27470,  27470,  0.125, 0.2, 0.0517, 0.3),
    (27471,  27600,  27600,  0.125, 0.2, 0.0517, 0.3),
    (27601,  28800,  28800,  0.125, 0.2, 0.0517, 0.3),
    (28801,  30300,  30300,  0.125, 0.2, 0.0517, 0.3),
    (30301,  31800,  31800,  0.125, 0.2, 0.0517, 0.3),
    (31801,  33300,  33300,  0.125, 0.2, 0.0517, 0.3),
    (33301,  34800,  34800,  0.125, 0.2, 0.0517, 0.3),
    (34801,  36300,  36300,  0.125, 0.2, 0.0517, 0.3),
    (36301,  38200,  38200,  0.125, 0.2, 0.0517, 0.3),
    (38201,  40100,  40100,  0.125, 0.2, 0.0517, 0.3),
    (40101,  42000,  42000,  0.125, 0.2, 0.0517, 0.3),
    (42001,  43900,  43900,  0.125, 0.2, 0.0517, 0.3),
    (43901,  45800,  45800,  0.125, 0.2, 0.0517, 0.3),
    (45801,  48200,  48200,  0.125, 0.2, 0.0517, 0.3),
    (48201,  50600,  50600,  0.125, 0.2, 0.0517, 0.3),
    (50601,  53000,  53000,  0.125, 0.2, 0.0517, 0.3),
    (53001,  55400,  55400,  0.125, 0.2, 0.0517, 0.3),
    (55401,  57800,  57800,  0.125, 0.2, 0.0517, 0.3),
    (57801,  60800,  60800,  0.125, 0.2, 0.0517, 0.3),
    (60801,  63800,  63800,  0.125, 0.2, 0.0517, 0.3),
    (63801,  66800,  66800,  0.125, 0.2, 0.0517, 0.3),
    (66801,  69800,  69800,  0.125, 0.2, 0.0517, 0.3),
    (69801,  72800,  72800,  0.125, 0.2, 0.0517, 0.3),
    (72801,  76500,  76500,  0.125, 0.2, 0.0517, 0.3),
    (76501,  80200,  80200,  0.125, 0.2, 0.0517, 0.3),
    (80201,  83900,  83900,  0.125, 0.2, 0.0517, 0.3),
    (83901,  87600,  87600,  0.125, 0.2, 0.0517, 0.3),
    (87601,  92100,  92100,  0.125, 0.2, 0.0517, 0.3),
    (92101,  96600,  96600,  0.125, 0.2, 0.0517, 0.3),
    (96601,  101100, 101100, 0.125, 0.2, 0.0517, 0.3),
    (101101, 105600, 105600, 0.125, 0.2, 0.0517, 0.3),
    (105601, 110100, 110100, 0.125, 0.2, 0.0517, 0.3),
    (110101, 115500, 115500, 0.125, 0.2, 0.0517, 0.3),
    (115501, 120900, 120900, 0.125, 0.2, 0.0517, 0.3),
    (120901, 126300, 126300, 0.125, 0.2, 0.0517, 0.3),
    (126301, 131700, 131700, 0.125, 0.2, 0.0517, 0.3),
    (131701, 137100, 137100, 0.125, 0.2, 0.0517, 0.3),
    (137101, 142500, 142500, 0.125, 0.2, 0.0517, 0.3),
    (142501, 147900, 147900, 0.125, 0.2, 0.0517, 0.3),
    (147901, 150000, 150000, 0.125, 0.2, 0.0517, 0.3)
) AS v(salary_min, salary_max, insured_amount, labor_rate, labor_employee_share, health_rate, health_employee_share)
WHERE NOT EXISTS (SELECT 1 FROM insurance_brackets LIMIT 1);

-- ========================
-- 4. 加班申請表
-- ========================
CREATE TABLE IF NOT EXISTS overtime_requests (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    employee_id UUID NOT NULL REFERENCES employees(id),
    ot_date DATE NOT NULL,
    start_time TIME,
    end_time TIME,
    hours NUMERIC DEFAULT 0,
    planned_hours NUMERIC DEFAULT 0,
    approved_hours NUMERIC,
    actual_hours NUMERIC,
    final_hours NUMERIC,
    compensation_type TEXT DEFAULT 'pay' CHECK (compensation_type IN ('pay', 'comp_leave')),
    reason TEXT,
    status TEXT DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
    approver_id UUID REFERENCES employees(id),
    approved_at TIMESTAMPTZ,
    rejection_reason TEXT,
    created_at TIMESTAMPTZ DEFAULT now()
);
