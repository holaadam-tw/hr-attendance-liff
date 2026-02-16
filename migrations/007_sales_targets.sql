-- ============================================================
-- 007_sales_targets.sql
-- HR Attendance LIFF — 業務週目標 + 活動紀錄
-- ============================================================

-- ========================
-- 1. 業務週目標
-- ========================
CREATE TABLE IF NOT EXISTS sales_targets (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    company_id UUID REFERENCES companies(id),
    employee_id UUID REFERENCES employees(id),  -- NULL = 全員預設
    week_start DATE NOT NULL,                    -- 該週的週一
    call_target INTEGER DEFAULT 0,               -- 目標：電話拜訪次數
    visit_target INTEGER DEFAULT 0,              -- 目標：實地拜訪次數
    notes TEXT,
    created_by UUID REFERENCES employees(id),
    created_at TIMESTAMPTZ DEFAULT now(),
    UNIQUE(employee_id, week_start)
);

-- RLS
ALTER TABLE sales_targets ENABLE ROW LEVEL SECURITY;
CREATE POLICY IF NOT EXISTS "allow_select_sales_targets" ON sales_targets FOR SELECT USING (true);
CREATE POLICY IF NOT EXISTS "allow_insert_sales_targets" ON sales_targets FOR INSERT WITH CHECK (true);
CREATE POLICY IF NOT EXISTS "allow_update_sales_targets" ON sales_targets FOR UPDATE USING (true) WITH CHECK (true);
CREATE POLICY IF NOT EXISTS "allow_delete_sales_targets" ON sales_targets FOR DELETE USING (true);

-- ========================
-- 2. 業務活動紀錄
-- ========================
CREATE TABLE IF NOT EXISTS sales_activities (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    employee_id UUID NOT NULL REFERENCES employees(id),
    company_id UUID REFERENCES companies(id),
    activity_date DATE NOT NULL DEFAULT CURRENT_DATE,
    activity_type TEXT NOT NULL CHECK (activity_type IN ('call', 'visit', 'other')),
    client_id UUID REFERENCES clients(id),
    description TEXT,
    duration_minutes INTEGER DEFAULT 0,
    result TEXT,  -- interested / follow-up / closed / rejected / no-answer
    notes TEXT,
    created_at TIMESTAMPTZ DEFAULT now()
);

-- RLS
ALTER TABLE sales_activities ENABLE ROW LEVEL SECURITY;
CREATE POLICY IF NOT EXISTS "allow_select_sales_activities" ON sales_activities FOR SELECT USING (true);
CREATE POLICY IF NOT EXISTS "allow_insert_sales_activities" ON sales_activities FOR INSERT WITH CHECK (true);
CREATE POLICY IF NOT EXISTS "allow_update_sales_activities" ON sales_activities FOR UPDATE USING (true) WITH CHECK (true);
CREATE POLICY IF NOT EXISTS "allow_delete_sales_activities" ON sales_activities FOR DELETE USING (true);

-- 記錄 migration
INSERT INTO _migrations (filename) VALUES ('007_sales_targets.sql')
ON CONFLICT (filename) DO NOTHING;
