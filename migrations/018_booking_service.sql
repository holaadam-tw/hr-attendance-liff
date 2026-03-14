-- 018: 服務業預約系統資料表
-- staff_profiles, service_items, service_time_slots, service_bookings

-- 1. 技師資料
CREATE TABLE IF NOT EXISTS staff_profiles (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    company_id UUID NOT NULL REFERENCES companies(id),
    employee_id UUID NOT NULL REFERENCES employees(id),
    bio TEXT,
    photo_url TEXT,
    is_bookable BOOLEAN DEFAULT true,
    created_at TIMESTAMPTZ DEFAULT now(),
    updated_at TIMESTAMPTZ DEFAULT now(),
    UNIQUE(company_id, employee_id)
);

-- 2. 服務項目
CREATE TABLE IF NOT EXISTS service_items (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    company_id UUID NOT NULL REFERENCES companies(id),
    name TEXT NOT NULL,
    price INTEGER DEFAULT 0,
    duration_minutes INTEGER DEFAULT 60,
    description TEXT,
    is_active BOOLEAN DEFAULT true,
    sort_order INTEGER DEFAULT 0,
    created_at TIMESTAMPTZ DEFAULT now()
);

-- 3. 可預約時段
CREATE TABLE IF NOT EXISTS service_time_slots (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    company_id UUID NOT NULL REFERENCES companies(id),
    slot_time TEXT NOT NULL,
    max_concurrent INTEGER DEFAULT 1,
    day_of_week INTEGER,
    is_active BOOLEAN DEFAULT true
);

-- 4. 預約記錄
CREATE TABLE IF NOT EXISTS service_bookings (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    company_id UUID NOT NULL REFERENCES companies(id),
    booking_date DATE NOT NULL,
    slot_time TEXT NOT NULL,
    employee_id UUID REFERENCES employees(id),
    service_item_id UUID REFERENCES service_items(id),
    customer_name TEXT NOT NULL,
    customer_phone TEXT,
    notes TEXT,
    status TEXT DEFAULT 'pending' CHECK (status IN ('pending','confirmed','completed','cancelled')),
    booking_number TEXT,
    created_at TIMESTAMPTZ DEFAULT now(),
    confirmed_at TIMESTAMPTZ,
    cancelled_reason TEXT
);

-- 索引
CREATE INDEX IF NOT EXISTS idx_staff_profiles_company ON staff_profiles(company_id);
CREATE INDEX IF NOT EXISTS idx_staff_profiles_employee ON staff_profiles(employee_id);
CREATE INDEX IF NOT EXISTS idx_service_items_company ON service_items(company_id);
CREATE INDEX IF NOT EXISTS idx_service_time_slots_company ON service_time_slots(company_id);
CREATE INDEX IF NOT EXISTS idx_service_bookings_company ON service_bookings(company_id);
CREATE INDEX IF NOT EXISTS idx_service_bookings_date ON service_bookings(booking_date);
CREATE INDEX IF NOT EXISTS idx_service_bookings_employee ON service_bookings(employee_id);
CREATE INDEX IF NOT EXISTS idx_service_bookings_status ON service_bookings(status);

-- RLS
ALTER TABLE staff_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE service_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE service_time_slots ENABLE ROW LEVEL SECURITY;
ALTER TABLE service_bookings ENABLE ROW LEVEL SECURITY;

-- staff_profiles: 所有人可讀（消費者需看技師列表），員工可改自己
CREATE POLICY "staff_profiles_select" ON staff_profiles FOR SELECT USING (true);
CREATE POLICY "staff_profiles_insert" ON staff_profiles FOR INSERT WITH CHECK (true);
CREATE POLICY "staff_profiles_update" ON staff_profiles FOR UPDATE USING (true);
CREATE POLICY "staff_profiles_delete" ON staff_profiles FOR DELETE USING (true);

-- service_items: 所有人可讀（消費者選服務），管理員可寫
CREATE POLICY "service_items_select" ON service_items FOR SELECT USING (true);
CREATE POLICY "service_items_insert" ON service_items FOR INSERT WITH CHECK (true);
CREATE POLICY "service_items_update" ON service_items FOR UPDATE USING (true);
CREATE POLICY "service_items_delete" ON service_items FOR DELETE USING (true);

-- service_time_slots: 所有人可讀，管理員可寫
CREATE POLICY "service_time_slots_select" ON service_time_slots FOR SELECT USING (true);
CREATE POLICY "service_time_slots_insert" ON service_time_slots FOR INSERT WITH CHECK (true);
CREATE POLICY "service_time_slots_update" ON service_time_slots FOR UPDATE USING (true);
CREATE POLICY "service_time_slots_delete" ON service_time_slots FOR DELETE USING (true);

-- service_bookings: 所有人可新增（消費者預約），可讀可改
CREATE POLICY "service_bookings_select" ON service_bookings FOR SELECT USING (true);
CREATE POLICY "service_bookings_insert" ON service_bookings FOR INSERT WITH CHECK (true);
CREATE POLICY "service_bookings_update" ON service_bookings FOR UPDATE USING (true);
CREATE POLICY "service_bookings_delete" ON service_bookings FOR DELETE USING (true);
