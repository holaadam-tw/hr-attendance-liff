-- ============================================================
-- Migration: 預約系統 Schema (Phase 1)
-- ============================================================

-- 1. 預約設定（每間店/公司一筆）
CREATE TABLE IF NOT EXISTS booking_settings (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    store_id UUID REFERENCES store_profiles(id),
    company_id UUID REFERENCES companies(id),
    booking_type VARCHAR(20) NOT NULL DEFAULT 'general',
    -- booking_type: 'restaurant'(訂位), 'service'(服務預約), 'clinic'(看診)

    business_hours JSONB DEFAULT '{
        "mon":{"open":"09:00","close":"21:00","enabled":true},
        "tue":{"open":"09:00","close":"21:00","enabled":true},
        "wed":{"open":"09:00","close":"21:00","enabled":true},
        "thu":{"open":"09:00","close":"21:00","enabled":true},
        "fri":{"open":"09:00","close":"21:00","enabled":true},
        "sat":{"open":"10:00","close":"22:00","enabled":true},
        "sun":{"open":"10:00","close":"22:00","enabled":true}
    }',

    slot_duration_minutes INT DEFAULT 30,
    max_bookings_per_slot INT DEFAULT 5,
    advance_booking_days INT DEFAULT 30,
    min_advance_hours INT DEFAULT 2,
    max_party_size INT DEFAULT 10,
    reminder_hours INT DEFAULT 24,
    auto_cancel_minutes INT DEFAULT 30,

    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),

    UNIQUE(store_id),
    UNIQUE(company_id)
);

-- 2. 服務項目
CREATE TABLE IF NOT EXISTS booking_services (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    store_id UUID REFERENCES store_profiles(id),
    company_id UUID REFERENCES companies(id),
    name VARCHAR(100) NOT NULL,
    description TEXT,
    duration_minutes INT DEFAULT 30,
    price DECIMAL(10,2),
    max_concurrent INT DEFAULT 1,
    sort_order INT DEFAULT 0,
    is_active BOOLEAN DEFAULT true,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 3. 可預約人員
CREATE TABLE IF NOT EXISTS booking_staff (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    store_id UUID REFERENCES store_profiles(id),
    company_id UUID REFERENCES companies(id),
    employee_id UUID REFERENCES employees(id),
    display_name VARCHAR(100) NOT NULL,
    title VARCHAR(50),
    avatar_url TEXT,
    service_ids UUID[],
    schedule JSONB,
    is_active BOOLEAN DEFAULT true,
    sort_order INT DEFAULT 0,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 4. 預約紀錄
CREATE TABLE IF NOT EXISTS bookings (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    store_id UUID REFERENCES store_profiles(id),
    company_id UUID REFERENCES companies(id),
    booking_number SERIAL,
    booking_type VARCHAR(20) NOT NULL,

    customer_name VARCHAR(100) NOT NULL,
    customer_phone VARCHAR(20),
    customer_line_uid VARCHAR(100),

    booking_date DATE NOT NULL,
    start_time TIME NOT NULL,
    end_time TIME,
    party_size INT DEFAULT 1,
    service_id UUID REFERENCES booking_services(id),
    staff_id UUID REFERENCES booking_staff(id),

    status VARCHAR(20) DEFAULT 'pending',
    notes TEXT,
    admin_notes TEXT,
    reminder_sent BOOLEAN DEFAULT false,

    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- 處理已存在的 bookings table（補充缺少的欄位）
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS customer_line_uid VARCHAR(100);
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS booking_type VARCHAR(20);
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS service_id UUID REFERENCES booking_services(id);
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS staff_id UUID REFERENCES booking_staff(id);
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS end_time TIME;
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS party_size INT DEFAULT 1;
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS notes TEXT;
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS admin_notes TEXT;
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS reminder_sent BOOLEAN DEFAULT false;

CREATE INDEX IF NOT EXISTS idx_bookings_date ON bookings(store_id, booking_date, status);
CREATE INDEX IF NOT EXISTS idx_bookings_customer ON bookings(customer_line_uid, status);
CREATE INDEX IF NOT EXISTS idx_bookings_staff ON bookings(staff_id, booking_date);

COMMENT ON TABLE booking_settings IS '預約系統設定';
COMMENT ON TABLE booking_services IS '可預約的服務項目';
COMMENT ON TABLE booking_staff IS '可預約的人員/醫師';
COMMENT ON TABLE bookings IS '預約紀錄';
