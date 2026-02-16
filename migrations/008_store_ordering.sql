-- ============================================================
-- 008_store_ordering.sql
-- HR Attendance LIFF — 線上點餐/預約 SaaS
-- ============================================================

-- ========================
-- 1. 商店設定
-- ========================
CREATE TABLE IF NOT EXISTS store_profiles (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    client_id UUID NOT NULL REFERENCES clients(id),
    company_id UUID REFERENCES companies(id),
    store_name TEXT NOT NULL,
    store_slug TEXT UNIQUE,
    description TEXT,
    logo_url TEXT,
    banner_url TEXT,
    phone TEXT,
    address TEXT,
    business_hours JSONB DEFAULT '{}',
    store_type TEXT DEFAULT 'restaurant'
        CHECK (store_type IN ('restaurant', 'service', 'retail')),
    accept_orders BOOLEAN DEFAULT true,
    accept_bookings BOOLEAN DEFAULT false,
    theme_color TEXT DEFAULT '#4F46E5',
    is_active BOOLEAN DEFAULT true,
    created_at TIMESTAMPTZ DEFAULT now(),
    updated_at TIMESTAMPTZ DEFAULT now()
);

ALTER TABLE store_profiles ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "allow_select_store_profiles" ON store_profiles;
CREATE POLICY "allow_select_store_profiles" ON store_profiles FOR SELECT USING (true);
DROP POLICY IF EXISTS "allow_insert_store_profiles" ON store_profiles;
CREATE POLICY "allow_insert_store_profiles" ON store_profiles FOR INSERT WITH CHECK (true);
DROP POLICY IF EXISTS "allow_update_store_profiles" ON store_profiles;
CREATE POLICY "allow_update_store_profiles" ON store_profiles FOR UPDATE USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "allow_delete_store_profiles" ON store_profiles;
CREATE POLICY "allow_delete_store_profiles" ON store_profiles FOR DELETE USING (true);

-- ========================
-- 2. 菜單分類
-- ========================
CREATE TABLE IF NOT EXISTS menu_categories (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    store_id UUID NOT NULL REFERENCES store_profiles(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    sort_order INTEGER DEFAULT 0,
    is_active BOOLEAN DEFAULT true,
    created_at TIMESTAMPTZ DEFAULT now()
);

ALTER TABLE menu_categories ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "allow_select_menu_categories" ON menu_categories;
CREATE POLICY "allow_select_menu_categories" ON menu_categories FOR SELECT USING (true);
DROP POLICY IF EXISTS "allow_insert_menu_categories" ON menu_categories;
CREATE POLICY "allow_insert_menu_categories" ON menu_categories FOR INSERT WITH CHECK (true);
DROP POLICY IF EXISTS "allow_update_menu_categories" ON menu_categories;
CREATE POLICY "allow_update_menu_categories" ON menu_categories FOR UPDATE USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "allow_delete_menu_categories" ON menu_categories;
CREATE POLICY "allow_delete_menu_categories" ON menu_categories FOR DELETE USING (true);

-- ========================
-- 3. 菜單品項
-- ========================
CREATE TABLE IF NOT EXISTS menu_items (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    store_id UUID NOT NULL REFERENCES store_profiles(id) ON DELETE CASCADE,
    category_id UUID REFERENCES menu_categories(id),
    name TEXT NOT NULL,
    description TEXT,
    price NUMERIC NOT NULL DEFAULT 0,
    image_url TEXT,
    is_available BOOLEAN DEFAULT true,
    sort_order INTEGER DEFAULT 0,
    options JSONB DEFAULT '[]',
    tags TEXT[] DEFAULT '{}',
    created_at TIMESTAMPTZ DEFAULT now(),
    updated_at TIMESTAMPTZ DEFAULT now()
);

ALTER TABLE menu_items ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "allow_select_menu_items" ON menu_items;
CREATE POLICY "allow_select_menu_items" ON menu_items FOR SELECT USING (true);
DROP POLICY IF EXISTS "allow_insert_menu_items" ON menu_items;
CREATE POLICY "allow_insert_menu_items" ON menu_items FOR INSERT WITH CHECK (true);
DROP POLICY IF EXISTS "allow_update_menu_items" ON menu_items;
CREATE POLICY "allow_update_menu_items" ON menu_items FOR UPDATE USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "allow_delete_menu_items" ON menu_items;
CREATE POLICY "allow_delete_menu_items" ON menu_items FOR DELETE USING (true);

-- ========================
-- 4. 訂單
-- ========================
CREATE TABLE IF NOT EXISTS orders (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    store_id UUID NOT NULL REFERENCES store_profiles(id),
    order_number TEXT NOT NULL,
    customer_name TEXT,
    customer_phone TEXT,
    customer_line_id TEXT,
    order_type TEXT DEFAULT 'dine_in'
        CHECK (order_type IN ('dine_in', 'takeout', 'delivery')),
    items JSONB NOT NULL DEFAULT '[]',
    total NUMERIC DEFAULT 0,
    status TEXT DEFAULT 'pending'
        CHECK (status IN ('pending','confirmed','preparing','ready','completed','cancelled')),
    table_number TEXT,
    notes TEXT,
    created_at TIMESTAMPTZ DEFAULT now(),
    updated_at TIMESTAMPTZ DEFAULT now()
);

ALTER TABLE orders ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "allow_select_orders" ON orders;
CREATE POLICY "allow_select_orders" ON orders FOR SELECT USING (true);
DROP POLICY IF EXISTS "allow_insert_orders" ON orders;
CREATE POLICY "allow_insert_orders" ON orders FOR INSERT WITH CHECK (true);
DROP POLICY IF EXISTS "allow_update_orders" ON orders;
CREATE POLICY "allow_update_orders" ON orders FOR UPDATE USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "allow_delete_orders" ON orders;
CREATE POLICY "allow_delete_orders" ON orders FOR DELETE USING (true);

-- ========================
-- 5. 預約
-- ========================
CREATE TABLE IF NOT EXISTS bookings (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    store_id UUID NOT NULL REFERENCES store_profiles(id),
    booking_number TEXT NOT NULL,
    customer_name TEXT NOT NULL,
    customer_phone TEXT,
    customer_line_id TEXT,
    booking_date DATE NOT NULL,
    booking_time TIME NOT NULL,
    party_size INTEGER DEFAULT 1,
    service_type TEXT,
    duration_minutes INTEGER DEFAULT 60,
    status TEXT DEFAULT 'pending'
        CHECK (status IN ('pending','confirmed','completed','cancelled','no_show')),
    notes TEXT,
    created_at TIMESTAMPTZ DEFAULT now(),
    updated_at TIMESTAMPTZ DEFAULT now()
);

ALTER TABLE bookings ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "allow_select_bookings" ON bookings;
CREATE POLICY "allow_select_bookings" ON bookings FOR SELECT USING (true);
DROP POLICY IF EXISTS "allow_insert_bookings" ON bookings;
CREATE POLICY "allow_insert_bookings" ON bookings FOR INSERT WITH CHECK (true);
DROP POLICY IF EXISTS "allow_update_bookings" ON bookings;
CREATE POLICY "allow_update_bookings" ON bookings FOR UPDATE USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "allow_delete_bookings" ON bookings;
CREATE POLICY "allow_delete_bookings" ON bookings FOR DELETE USING (true);

-- 記錄 migration
INSERT INTO _migrations (filename) VALUES ('008_store_ordering.sql')
ON CONFLICT (filename) DO NOTHING;
