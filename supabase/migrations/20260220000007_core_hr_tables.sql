-- ===== attendance_records：考勤記錄 =====
CREATE TABLE IF NOT EXISTS attendance_records (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    employee_id UUID NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
    company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    date DATE NOT NULL,
    check_in_time TIMESTAMPTZ,
    check_out_time TIMESTAMPTZ,
    status TEXT DEFAULT 'present',  -- 'present', 'absent', 'late', 'early_leave'
    work_hours NUMERIC(5,2),
    overtime_hours NUMERIC(5,2),
    notes TEXT,
    location_checkin TEXT,
    location_checkout TEXT,
    created_at TIMESTAMPTZ DEFAULT now(),
    updated_at TIMESTAMPTZ DEFAULT now(),
    UNIQUE(employee_id, date)
);

CREATE INDEX IF NOT EXISTS idx_attendance_employee ON attendance_records(employee_id, date DESC);
CREATE INDEX IF NOT EXISTS idx_attendance_company ON attendance_records(company_id, date DESC);
CREATE INDEX IF NOT EXISTS idx_attendance_date ON attendance_records(date DESC);

ALTER TABLE attendance_records ENABLE ROW LEVEL SECURITY;

CREATE POLICY "attendance_select" ON attendance_records FOR SELECT USING (true);
CREATE POLICY "attendance_insert" ON attendance_records FOR INSERT WITH CHECK (true);
CREATE POLICY "attendance_update" ON attendance_records FOR UPDATE USING (true);

COMMENT ON TABLE attendance_records IS '員工考勤打卡記錄';

-- ===== payroll_records：薪資發放記錄 =====
CREATE TABLE IF NOT EXISTS payroll_records (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    employee_id UUID NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
    company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    period_start DATE NOT NULL,
    period_end DATE NOT NULL,
    base_salary NUMERIC(10,2),
    overtime_pay NUMERIC(10,2) DEFAULT 0,
    bonus NUMERIC(10,2) DEFAULT 0,
    deductions NUMERIC(10,2) DEFAULT 0,
    net_salary NUMERIC(10,2),
    status TEXT DEFAULT 'pending',  -- 'pending', 'approved', 'paid'
    paid_at TIMESTAMPTZ,
    notes TEXT,
    created_at TIMESTAMPTZ DEFAULT now(),
    updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_payroll_employee ON payroll_records(employee_id, period_start DESC);
CREATE INDEX IF NOT EXISTS idx_payroll_company ON payroll_records(company_id, period_start DESC);
CREATE INDEX IF NOT EXISTS idx_payroll_status ON payroll_records(status, period_start DESC);

ALTER TABLE payroll_records ENABLE ROW LEVEL SECURITY;

CREATE POLICY "payroll_select" ON payroll_records FOR SELECT USING (true);
CREATE POLICY "payroll_insert" ON payroll_records FOR INSERT WITH CHECK (true);
CREATE POLICY "payroll_update" ON payroll_records FOR UPDATE USING (true);

COMMENT ON TABLE payroll_records IS '員工薪資發放記錄';

-- ===== audit_logs：操作日誌 =====
CREATE TABLE IF NOT EXISTS audit_logs (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    company_id UUID REFERENCES companies(id) ON DELETE CASCADE,
    user_id UUID,
    user_name TEXT,
    action TEXT NOT NULL,
    entity_type TEXT,  -- 'employee', 'attendance', 'leave', 'payroll', 'order', etc.
    entity_id UUID,
    details JSONB,
    ip_address TEXT,
    user_agent TEXT,
    created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_audit_company ON audit_logs(company_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_user ON audit_logs(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_entity ON audit_logs(entity_type, entity_id);
CREATE INDEX IF NOT EXISTS idx_audit_action ON audit_logs(action, created_at DESC);

ALTER TABLE audit_logs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "audit_select" ON audit_logs FOR SELECT USING (true);
CREATE POLICY "audit_insert" ON audit_logs FOR INSERT WITH CHECK (true);

COMMENT ON TABLE audit_logs IS '系統操作日誌（審計追蹤）';
