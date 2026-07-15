-- ============================================================
-- 093_fieldwork_odometer.sql
-- 外勤里程表起訖登錄：每日行程表 + 外勤紀錄加里程表欄位
-- 需求：業務出發前登錄里程表讀數＋拍照，每站到達填讀數＋拍照，
--       系統自動算區間公里（差額），與 GPS 打卡點交叉比對，供距離補貼查核
-- 可重複執行（IF NOT EXISTS 齊全）
-- ============================================================

-- ========================
-- 1. 每日行程表（出發/收工里程表登錄）
-- ========================
CREATE TABLE IF NOT EXISTS field_work_trips (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    employee_id UUID NOT NULL REFERENCES employees(id),
    company_id UUID NOT NULL REFERENCES companies(id),
    trip_date DATE NOT NULL DEFAULT CURRENT_DATE,
    -- 出發登錄
    start_odometer NUMERIC NOT NULL CHECK (start_odometer >= 0),
    start_odometer_photo_url TEXT,
    start_time TIMESTAMPTZ DEFAULT now(),
    start_lat DOUBLE PRECISION,
    start_lng DOUBLE PRECISION,
    -- 收工登錄（選配）
    end_odometer NUMERIC CHECK (end_odometer IS NULL OR end_odometer >= start_odometer),
    end_odometer_photo_url TEXT,
    end_time TIMESTAMPTZ,
    end_lat DOUBLE PRECISION,
    end_lng DOUBLE PRECISION,
    total_km NUMERIC,
    status TEXT DEFAULT 'open' CHECK (status IN ('open','closed')),
    notes TEXT,
    created_at TIMESTAMPTZ DEFAULT now(),
    updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_fwt_emp_date ON field_work_trips(employee_id, trip_date);
CREATE INDEX IF NOT EXISTS idx_fwt_company_date ON field_work_trips(company_id, trip_date);

-- 同一員工同一天只允許一筆 open 行程
CREATE UNIQUE INDEX IF NOT EXISTS idx_fwt_one_open_per_day
    ON field_work_trips(employee_id, trip_date) WHERE status = 'open';

-- ========================
-- 2. field_work_logs 加里程表欄位
-- ========================
ALTER TABLE field_work_logs
    ADD COLUMN IF NOT EXISTS trip_id UUID REFERENCES field_work_trips(id),
    ADD COLUMN IF NOT EXISTS odometer_reading NUMERIC,
    ADD COLUMN IF NOT EXISTS odometer_photo_url TEXT,
    ADD COLUMN IF NOT EXISTS segment_km NUMERIC,
    ADD COLUMN IF NOT EXISTS gps_distance_km NUMERIC;

CREATE INDEX IF NOT EXISTS idx_fwl_trip ON field_work_logs(trip_id);

-- ========================
-- 3. 權限：與 field_work_logs 一致（前端 anon 直寫模式）
--    RLS 收緊隨 Phase 2/3 另案處理
-- ========================
GRANT SELECT, INSERT, UPDATE ON field_work_trips TO anon, authenticated;
