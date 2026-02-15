-- ============================================================
-- 001_initial_schema.sql
-- HR Attendance LIFF — 完整初始建表
-- 執行順序：第 1 個（全新安裝時執行）
-- ============================================================

-- 版本追蹤表（記錄已執行的 migration）
CREATE TABLE IF NOT EXISTS _migrations (
    id SERIAL PRIMARY KEY,
    filename TEXT UNIQUE NOT NULL,
    executed_at TIMESTAMPTZ DEFAULT now()
);

-- ========================
-- 1. companies（公司）
-- ========================
CREATE TABLE IF NOT EXISTS companies (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    code TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    is_active BOOLEAN DEFAULT true,
    created_at TIMESTAMPTZ DEFAULT now()
);

-- ========================
-- 2. employees（員工）
-- ========================
CREATE TABLE IF NOT EXISTS employees (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    employee_number VARCHAR NOT NULL UNIQUE,
    name VARCHAR NOT NULL,
    department VARCHAR,
    position VARCHAR,
    join_date DATE,
    hire_date DATE,
    line_user_id VARCHAR UNIQUE,
    id_last_four VARCHAR,
    id_card_last_4 VARCHAR,
    phone VARCHAR,
    email VARCHAR,
    check_in_lat NUMERIC,
    check_in_lng NUMERIC,
    max_distance_meters INTEGER DEFAULT 100,
    is_active BOOLEAN DEFAULT true,
    is_bound BOOLEAN DEFAULT false,
    bound_at TIMESTAMPTZ,
    is_admin BOOLEAN DEFAULT false,
    company_id UUID NOT NULL REFERENCES companies(id),
    role TEXT DEFAULT 'user' CHECK (role IN ('admin', 'user', 'manager')),
    employment_type TEXT DEFAULT 'fulltime',
    device_info TEXT,
    created_at TIMESTAMPTZ DEFAULT now(),
    updated_at TIMESTAMPTZ DEFAULT now()
);

-- ========================
-- 3. shift_types（班別定義）
-- ========================
CREATE TABLE IF NOT EXISTS shift_types (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    code TEXT NOT NULL,
    name TEXT NOT NULL,
    start_time TIME NOT NULL,
    end_time TIME NOT NULL,
    is_overnight BOOLEAN DEFAULT false,
    work_hours NUMERIC DEFAULT 8,
    break_minutes INTEGER DEFAULT 60,
    night_allowance NUMERIC DEFAULT 0,
    color TEXT DEFAULT '#667eea',
    is_active BOOLEAN DEFAULT true,
    created_at TIMESTAMPTZ DEFAULT now()
);

-- ========================
-- 4. schedules（排班表）
-- ========================
CREATE TABLE IF NOT EXISTS schedules (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    employee_id UUID REFERENCES employees(id),
    date DATE NOT NULL,
    shift_type_id UUID REFERENCES shift_types(id),
    is_off_day BOOLEAN DEFAULT false,
    is_holiday BOOLEAN DEFAULT false,
    notes TEXT,
    created_by UUID REFERENCES employees(id),
    created_at TIMESTAMPTZ DEFAULT now(),
    updated_at TIMESTAMPTZ DEFAULT now(),
    UNIQUE(employee_id, date)
);

-- ========================
-- 5. attendance（考勤紀錄）
-- ========================
CREATE TABLE IF NOT EXISTS attendance (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    employee_id UUID NOT NULL REFERENCES employees(id),
    date DATE NOT NULL DEFAULT (now() AT TIME ZONE 'Asia/Taipei')::date,
    check_in_time TIMESTAMPTZ,
    check_out_time TIMESTAMPTZ,
    photo_url TEXT,
    check_in_location TEXT,
    check_out_location TEXT,
    device_info TEXT,
    total_work_hours NUMERIC,
    is_late BOOLEAN DEFAULT false,
    notes TEXT,
    latitude DOUBLE PRECISION,
    longitude DOUBLE PRECISION,
    device_id TEXT,
    schedule_id UUID REFERENCES schedules(id),
    shift_type_id UUID REFERENCES shift_types(id),
    overtime_hours NUMERIC DEFAULT 0,
    is_holiday_work BOOLEAN DEFAULT false,
    is_manual BOOLEAN DEFAULT false,
    created_at TIMESTAMPTZ DEFAULT now(),
    updated_at TIMESTAMPTZ DEFAULT now()
);

-- ========================
-- 6. leave_requests（請假申請）
-- ========================
CREATE TABLE IF NOT EXISTS leave_requests (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    employee_id UUID NOT NULL REFERENCES employees(id),
    leave_type VARCHAR NOT NULL CHECK (leave_type IN ('annual', 'sick', 'personal', 'compensatory', 'maternity', 'marriage')),
    start_date DATE NOT NULL,
    end_date DATE NOT NULL,
    days NUMERIC DEFAULT 0 CHECK (days >= 0),
    reason TEXT,
    attachment_url TEXT,
    status VARCHAR DEFAULT 'pending',
    approver_id UUID REFERENCES employees(id),
    approved_at TIMESTAMPTZ,
    rejection_reason TEXT,
    created_at TIMESTAMPTZ DEFAULT now(),
    updated_at TIMESTAMPTZ DEFAULT now()
);

-- ========================
-- 7. makeup_punch_requests（補打卡申請）
-- ========================
CREATE TABLE IF NOT EXISTS makeup_punch_requests (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    employee_id UUID NOT NULL REFERENCES employees(id),
    punch_date DATE NOT NULL,
    punch_type TEXT NOT NULL CHECK (punch_type IN ('clock_in', 'clock_out')),
    punch_time TIME NOT NULL,
    reason TEXT,
    status TEXT DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
    rejection_reason TEXT,
    approver_id UUID REFERENCES employees(id),
    approved_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT now()
);

-- ========================
-- 8. overtime_requests（加班申請）
-- ========================
CREATE TABLE IF NOT EXISTS overtime_requests (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    employee_id UUID NOT NULL REFERENCES employees(id),
    ot_date DATE NOT NULL,
    start_time TIME,
    end_time TIME,
    hours NUMERIC DEFAULT 0,
    reason TEXT,
    status TEXT DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
    approver_id UUID REFERENCES employees(id),
    approved_at TIMESTAMPTZ,
    rejection_reason TEXT,
    created_at TIMESTAMPTZ DEFAULT now()
);

-- ========================
-- 9. shift_swap_requests（換班申請）
-- ========================
CREATE TABLE IF NOT EXISTS shift_swap_requests (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    requester_id UUID REFERENCES employees(id),
    target_id UUID REFERENCES employees(id),
    swap_date DATE NOT NULL,
    requester_original_shift TEXT,
    target_original_shift TEXT,
    reason TEXT,
    status TEXT DEFAULT 'pending_target',
    target_agreed BOOLEAN,
    rejection_reason TEXT,
    approved_by UUID REFERENCES employees(id),
    created_at TIMESTAMPTZ DEFAULT now()
);

-- ========================
-- 10. salary_settings（薪資設定）
-- ========================
CREATE TABLE IF NOT EXISTS salary_settings (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    employee_id UUID REFERENCES employees(id),
    salary_type TEXT NOT NULL DEFAULT 'monthly',
    base_salary NUMERIC NOT NULL DEFAULT 0,
    meal_allowance NUMERIC DEFAULT 2400,
    position_allowance NUMERIC DEFAULT 0,
    full_attendance_bonus NUMERIC DEFAULT 0,
    labor_insurance_grade NUMERIC DEFAULT 0,
    health_insurance_grade NUMERIC DEFAULT 0,
    pension_self_rate NUMERIC DEFAULT 0,
    tax_rate NUMERIC DEFAULT 5,
    effective_date DATE NOT NULL DEFAULT CURRENT_DATE,
    is_current BOOLEAN DEFAULT true,
    created_at TIMESTAMPTZ DEFAULT now(),
    updated_at TIMESTAMPTZ DEFAULT now()
);

-- ========================
-- 11. payroll（薪資發放紀錄）
-- ========================
CREATE TABLE IF NOT EXISTS payroll (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    employee_id UUID NOT NULL REFERENCES employees(id),
    year INTEGER NOT NULL,
    month INTEGER NOT NULL,
    base_salary NUMERIC NOT NULL,
    overtime_pay NUMERIC DEFAULT 0,
    bonus NUMERIC DEFAULT 0,
    full_attendance_bonus NUMERIC DEFAULT 0,
    late_deduction NUMERIC DEFAULT 0,
    absence_deduction NUMERIC DEFAULT 0,
    labor_insurance NUMERIC DEFAULT 0,
    health_insurance NUMERIC DEFAULT 0,
    total_deduction NUMERIC DEFAULT 0,
    gross_salary NUMERIC NOT NULL,
    net_salary NUMERIC NOT NULL,
    calculation_details JSONB,
    is_published BOOLEAN DEFAULT false,
    is_paid BOOLEAN DEFAULT false,
    created_at TIMESTAMPTZ DEFAULT now(),
    updated_at TIMESTAMPTZ DEFAULT now()
);

-- ========================
-- 12. annual_bonus（年終獎金）
-- ========================
CREATE TABLE IF NOT EXISTS annual_bonus (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    employee_id UUID NOT NULL REFERENCES employees(id),
    year INTEGER NOT NULL,
    attendance_score NUMERIC,
    performance_score NUMERIC,
    seniority_months INTEGER,
    final_bonus NUMERIC,
    ai_recommendation TEXT,
    manager_adjustment NUMERIC DEFAULT 0,
    is_approved BOOLEAN DEFAULT false,
    months_worked NUMERIC DEFAULT 0,
    late_score NUMERIC DEFAULT 0,
    contribution_score NUMERIC DEFAULT 0,
    total_score NUMERIC DEFAULT 0,
    base_months NUMERIC DEFAULT 0,
    calculated_bonus NUMERIC DEFAULT 0,
    adjusted_bonus NUMERIC DEFAULT 0,
    adjustment_reason TEXT,
    status TEXT DEFAULT 'draft',
    approved_by UUID,
    approved_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT now(),
    updated_at TIMESTAMPTZ DEFAULT now(),
    UNIQUE(employee_id, year)
);

-- ========================
-- 13. system_settings（系統設定）
-- ========================
CREATE TABLE IF NOT EXISTS system_settings (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    key VARCHAR NOT NULL UNIQUE,
    value JSONB NOT NULL,
    description TEXT,
    updated_at TIMESTAMPTZ DEFAULT now()
);

-- ========================
-- 14. lunch_orders（午餐訂購）
-- ========================
CREATE TABLE IF NOT EXISTS lunch_orders (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    employee_id UUID REFERENCES employees(id),
    order_date DATE NOT NULL,
    is_vegetarian BOOLEAN DEFAULT false,
    special_requirements TEXT,
    status VARCHAR DEFAULT 'confirmed',
    created_at TIMESTAMPTZ DEFAULT now(),
    updated_at TIMESTAMPTZ DEFAULT now()
);

-- ========================
-- 15. hr_audit_logs（操作日誌）
-- ========================
CREATE TABLE IF NOT EXISTS hr_audit_logs (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    actor_id UUID,
    actor_name TEXT,
    action TEXT,
    target_table TEXT,
    target_id TEXT,
    target_name TEXT,
    details JSONB,
    created_at TIMESTAMPTZ DEFAULT now()
);

-- ========================
-- 16. announcement_acknowledgments（公告已讀）
-- ========================
CREATE TABLE IF NOT EXISTS announcement_acknowledgments (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    announcement_id TEXT NOT NULL,
    employee_id UUID REFERENCES employees(id),
    acknowledged_at TIMESTAMPTZ DEFAULT now(),
    UNIQUE(announcement_id, employee_id)
);

-- ========================
-- 17. office_locations（打卡地點）
-- ========================
CREATE TABLE IF NOT EXISTS office_locations (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    company_id UUID REFERENCES companies(id),
    name TEXT NOT NULL,
    latitude DOUBLE PRECISION,
    longitude DOUBLE PRECISION,
    radius INTEGER DEFAULT 300,
    is_active BOOLEAN DEFAULT true,
    created_at TIMESTAMPTZ DEFAULT now()
);

-- ========================
-- 18. insurance_brackets（勞健保級距表）
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

-- ========================
-- 19. overtime_rules（加班費規則）
-- ========================
CREATE TABLE IF NOT EXISTS overtime_rules (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    rule_type TEXT NOT NULL,
    hour_from NUMERIC NOT NULL,
    hour_to NUMERIC NOT NULL,
    multiplier NUMERIC NOT NULL,
    description TEXT,
    is_active BOOLEAN DEFAULT true,
    created_at TIMESTAMPTZ DEFAULT now()
);

-- ========================
-- 20. binding / verification 輔助表
-- ========================
CREATE TABLE IF NOT EXISTS binding_attempts (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    line_user_id VARCHAR NOT NULL,
    employee_id VARCHAR,
    id_card_last_4 VARCHAR,
    verification_code VARCHAR,
    success BOOLEAN DEFAULT false,
    error_message TEXT,
    ip_address INET,
    user_agent TEXT,
    created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS binding_audit_log (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    employee_id VARCHAR,
    employee_number VARCHAR,
    line_user_id VARCHAR,
    action VARCHAR NOT NULL,
    success BOOLEAN NOT NULL,
    error_message TEXT,
    ip_address INET,
    device_info TEXT,
    created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS verification_codes (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    employee_id VARCHAR NOT NULL,
    code VARCHAR NOT NULL UNIQUE,
    created_by VARCHAR,
    created_at TIMESTAMPTZ DEFAULT now(),
    expires_at TIMESTAMPTZ DEFAULT (now() + INTERVAL '5 minutes'),
    used BOOLEAN DEFAULT false,
    used_at TIMESTAMPTZ,
    ip_address INET
);

-- 記錄此 migration 已執行
INSERT INTO _migrations (filename) VALUES ('001_initial_schema.sql')
ON CONFLICT (filename) DO NOTHING;
