-- ============================================================
-- 005_field_work.sql
-- HR Attendance LIFF — 外勤打卡（客戶 + 服務項目 + 報工紀錄）
-- ============================================================

-- ========================
-- 1. 客戶資料表
-- ========================
CREATE TABLE IF NOT EXISTS clients (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    company_name TEXT NOT NULL,
    contact_name TEXT,
    phone TEXT,
    address TEXT,
    latitude DOUBLE PRECISION,
    longitude DOUBLE PRECISION,
    category TEXT DEFAULT 'general',
    industry TEXT,
    notes TEXT,
    is_active BOOLEAN DEFAULT true,
    created_at TIMESTAMPTZ DEFAULT now(),
    updated_at TIMESTAMPTZ DEFAULT now()
);

-- ========================
-- 2. 服務項目表
-- ========================
CREATE TABLE IF NOT EXISTS service_items (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    name TEXT NOT NULL,
    code TEXT,
    is_active BOOLEAN DEFAULT true,
    created_at TIMESTAMPTZ DEFAULT now()
);

-- 預設服務項目
INSERT INTO service_items (name, code)
SELECT * FROM (VALUES
    ('設備安裝', 'INSTALL'),
    ('維修保養', 'MAINTAIN'),
    ('業務拜訪', 'VISIT'),
    ('技術支援', 'SUPPORT'),
    ('教育訓練', 'TRAINING'),
    ('其他', 'OTHER')
) AS v(name, code)
WHERE NOT EXISTS (SELECT 1 FROM service_items LIMIT 1);

-- ========================
-- 3. 外勤報工紀錄表
-- ========================
CREATE TABLE IF NOT EXISTS field_work_logs (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    employee_id UUID NOT NULL REFERENCES employees(id),
    client_id UUID REFERENCES clients(id),
    work_date DATE NOT NULL DEFAULT CURRENT_DATE,
    arrive_time TIMESTAMPTZ,
    leave_time TIMESTAMPTZ,
    work_hours NUMERIC,
    arrive_lat DOUBLE PRECISION,
    arrive_lng DOUBLE PRECISION,
    leave_lat DOUBLE PRECISION,
    leave_lng DOUBLE PRECISION,
    service_item_id UUID REFERENCES service_items(id),
    work_content TEXT,
    photo_urls JSONB DEFAULT '[]',
    mileage NUMERIC DEFAULT 0,
    signature_url TEXT,
    status TEXT DEFAULT 'draft' CHECK (status IN ('draft', 'submitted', 'approved', 'rejected')),
    notes TEXT,
    created_at TIMESTAMPTZ DEFAULT now(),
    updated_at TIMESTAMPTZ DEFAULT now()
);
