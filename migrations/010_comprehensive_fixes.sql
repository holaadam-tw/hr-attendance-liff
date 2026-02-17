-- ============================================================
-- 010_comprehensive_fixes.sql
-- HR Attendance LIFF — 全面修復與優化
-- 修正: 索引、欄位缺失、效能、資料完整性
-- ============================================================

-- ========================
-- 1. 效能索引（高頻查詢最佳化）
-- ========================

-- employees: 登入查詢、列表排序
CREATE INDEX IF NOT EXISTS idx_employees_line_user_id ON employees(line_user_id) WHERE line_user_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_employees_company_active ON employees(company_id, is_active);
CREATE INDEX IF NOT EXISTS idx_employees_role ON employees(role) WHERE is_active = true;
CREATE INDEX IF NOT EXISTS idx_employees_department ON employees(department) WHERE is_active = true;

-- attendance: 日期範圍查詢（最頻繁）
CREATE INDEX IF NOT EXISTS idx_attendance_emp_date ON attendance(employee_id, date DESC);
CREATE INDEX IF NOT EXISTS idx_attendance_date ON attendance(date DESC);
CREATE INDEX IF NOT EXISTS idx_attendance_late ON attendance(date, is_late) WHERE is_late = true;

-- leave_requests: 審核列表、日曆查詢
CREATE INDEX IF NOT EXISTS idx_leave_status ON leave_requests(status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_leave_emp_dates ON leave_requests(employee_id, start_date, end_date);
CREATE INDEX IF NOT EXISTS idx_leave_date_range ON leave_requests(start_date, end_date) WHERE status IN ('approved', 'pending');

-- schedules: 排班表查詢
CREATE INDEX IF NOT EXISTS idx_schedules_emp_date ON schedules(employee_id, date);
CREATE INDEX IF NOT EXISTS idx_schedules_date_range ON schedules(date);

-- makeup_punch_requests: 審核
CREATE INDEX IF NOT EXISTS idx_makeup_status ON makeup_punch_requests(status, created_at DESC);

-- overtime_requests: 審核 + 薪資計算
CREATE INDEX IF NOT EXISTS idx_ot_status ON overtime_requests(status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ot_date ON overtime_requests(ot_date, employee_id) WHERE status = 'approved';

-- shift_swap_requests: 審核
CREATE INDEX IF NOT EXISTS idx_swap_status ON shift_swap_requests(status, created_at DESC);

-- payroll: 月份查詢
CREATE INDEX IF NOT EXISTS idx_payroll_year_month ON payroll(year, month);
CREATE INDEX IF NOT EXISTS idx_payroll_emp ON payroll(employee_id, year DESC, month DESC);

-- salary_settings: 當前薪資
CREATE INDEX IF NOT EXISTS idx_salary_current ON salary_settings(employee_id) WHERE is_current = true;

-- lunch_orders: 每日統計
CREATE INDEX IF NOT EXISTS idx_lunch_date ON lunch_orders(order_date, status);

-- hr_audit_logs: 時間排序
CREATE INDEX IF NOT EXISTS idx_audit_created ON hr_audit_logs(created_at DESC);

-- field_work_logs: 審核查詢
CREATE INDEX IF NOT EXISTS idx_field_work_status ON field_work_logs(status, work_date DESC);
CREATE INDEX IF NOT EXISTS idx_field_work_emp_date ON field_work_logs(employee_id, work_date);

-- orders: 商店訂單查詢
CREATE INDEX IF NOT EXISTS idx_orders_store_status ON orders(store_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_orders_created ON orders(created_at DESC);

-- sales_activities: 週統計
CREATE INDEX IF NOT EXISTS idx_sales_act_date ON sales_activities(employee_id, activity_date);

-- sales_targets: 週查詢
CREATE INDEX IF NOT EXISTS idx_sales_target_week ON sales_targets(week_start, employee_id);

-- menu_items: 商店菜單
CREATE INDEX IF NOT EXISTS idx_menu_items_store ON menu_items(store_id, sort_order);

-- insurance_brackets: 級距查找
CREATE INDEX IF NOT EXISTS idx_ins_brackets_range ON insurance_brackets(salary_min, salary_max) WHERE is_active = true;

-- ========================
-- 2. overtime_requests 補充欄位（修正 migration 001 vs 004 衝突）
-- ========================
ALTER TABLE overtime_requests ADD COLUMN IF NOT EXISTS planned_hours NUMERIC DEFAULT 0;
ALTER TABLE overtime_requests ADD COLUMN IF NOT EXISTS approved_hours NUMERIC;
ALTER TABLE overtime_requests ADD COLUMN IF NOT EXISTS actual_hours NUMERIC;
ALTER TABLE overtime_requests ADD COLUMN IF NOT EXISTS final_hours NUMERIC;
ALTER TABLE overtime_requests ADD COLUMN IF NOT EXISTS compensation_type TEXT DEFAULT 'pay';

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'overtime_requests_compensation_type_check'
    ) THEN
        ALTER TABLE overtime_requests ADD CONSTRAINT overtime_requests_compensation_type_check
            CHECK (compensation_type IN ('pay', 'comp_leave'));
    END IF;
EXCEPTION WHEN OTHERS THEN NULL;
END $$;

-- ========================
-- 3. shift_swap_requests 補充欄位
-- ========================
ALTER TABLE shift_swap_requests ADD COLUMN IF NOT EXISTS approver_id UUID REFERENCES employees(id);
ALTER TABLE shift_swap_requests ADD COLUMN IF NOT EXISTS approved_at TIMESTAMPTZ;

DO $$
BEGIN
    ALTER TABLE shift_swap_requests DROP CONSTRAINT IF EXISTS shift_swap_requests_status_check;
    ALTER TABLE shift_swap_requests ADD CONSTRAINT shift_swap_requests_status_check
        CHECK (status IN ('pending_target', 'pending_admin', 'approved', 'rejected', 'cancelled'));
EXCEPTION WHEN OTHERS THEN NULL;
END $$;

-- ========================
-- 4. attendance 補充欄位
-- ========================
ALTER TABLE attendance ADD COLUMN IF NOT EXISTS late_minutes INTEGER DEFAULT 0;
ALTER TABLE attendance ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'present';

-- ========================
-- 5. leave_requests 修正 days 的預設值
-- ========================
ALTER TABLE leave_requests ALTER COLUMN days SET DEFAULT 1;

-- ========================
-- 6. lunch_orders 補充欄位
-- ========================
ALTER TABLE lunch_orders ADD COLUMN IF NOT EXISTS notes TEXT;

-- ========================
-- 7. annual_bonus 補充欄位
-- ========================
ALTER TABLE annual_bonus ADD COLUMN IF NOT EXISTS base_amount NUMERIC DEFAULT 0;
ALTER TABLE annual_bonus ADD COLUMN IF NOT EXISTS adjustment NUMERIC DEFAULT 0;

-- ========================
-- 8. 系統設定預設值
-- ========================
INSERT INTO system_settings (key, value, description)
VALUES ('max_concurrent_leave', '{"max": 2}', '同時請假人數上限')
ON CONFLICT (key) DO NOTHING;

INSERT INTO system_settings (key, value, description)
VALUES ('feature_visibility', '{"leave":true,"lunch":true,"attendance":true,"fieldwork":true,"sales_target":true,"store_ordering":false}', '員工可見功能設定')
ON CONFLICT (key) DO NOTHING;

-- ========================
-- 9. 實用 View
-- ========================

-- 員工完整資訊 View
CREATE OR REPLACE VIEW v_employee_full AS
SELECT
    e.id,
    e.employee_number,
    e.name,
    e.department,
    e.position,
    e.hire_date,
    e.role,
    e.employment_type,
    e.line_user_id,
    e.is_active,
    e.company_id,
    c.name AS company_name,
    ss.salary_type,
    ss.base_salary,
    ss.meal_allowance,
    ss.position_allowance,
    ss.full_attendance_bonus,
    ss.pension_self_rate
FROM employees e
LEFT JOIN companies c ON c.id = e.company_id
LEFT JOIN salary_settings ss ON ss.employee_id = e.id AND ss.is_current = true;

-- 今日出勤概覽 View
CREATE OR REPLACE VIEW v_today_attendance AS
SELECT
    e.id AS employee_id,
    e.name,
    e.department,
    a.check_in_time,
    a.check_out_time,
    a.is_late,
    a.late_minutes,
    a.total_work_hours,
    a.status,
    CASE
        WHEN a.id IS NULL THEN '未打卡'
        WHEN a.check_out_time IS NULL THEN '已上班'
        ELSE '已下班'
    END AS attendance_status
FROM employees e
LEFT JOIN attendance a ON a.employee_id = e.id AND a.date = (now() AT TIME ZONE 'Asia/Taipei')::date
WHERE e.is_active = true;

-- ========================
-- 10. 自動計算觸發器
-- ========================

-- 出勤自動計算工時
CREATE OR REPLACE FUNCTION calc_work_hours()
RETURNS TRIGGER AS $$
BEGIN
    IF NEW.check_in_time IS NOT NULL AND NEW.check_out_time IS NOT NULL THEN
        NEW.total_work_hours := ROUND(
            EXTRACT(EPOCH FROM (NEW.check_out_time - NEW.check_in_time)) / 3600.0, 2
        );
    END IF;
    NEW.updated_at := now();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_calc_work_hours ON attendance;
CREATE TRIGGER trg_calc_work_hours
    BEFORE INSERT OR UPDATE OF check_in_time, check_out_time ON attendance
    FOR EACH ROW EXECUTE FUNCTION calc_work_hours();

-- 外勤自動計算工時
CREATE OR REPLACE FUNCTION calc_field_work_hours()
RETURNS TRIGGER AS $$
BEGIN
    IF NEW.arrive_time IS NOT NULL AND NEW.leave_time IS NOT NULL THEN
        NEW.work_hours := ROUND(
            EXTRACT(EPOCH FROM (NEW.leave_time - NEW.arrive_time)) / 3600.0, 2
        );
    END IF;
    NEW.updated_at := now();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_calc_field_hours ON field_work_logs;
CREATE TRIGGER trg_calc_field_hours
    BEFORE INSERT OR UPDATE OF arrive_time, leave_time ON field_work_logs
    FOR EACH ROW EXECUTE FUNCTION calc_field_work_hours();

-- 訂單自動編號 + 取餐號
CREATE OR REPLACE FUNCTION generate_order_number()
RETURNS TRIGGER AS $$
DECLARE
    today_date TEXT;
    seq_num INTEGER;
BEGIN
    today_date := to_char(now() AT TIME ZONE 'Asia/Taipei', 'YYYYMMDD');

    SELECT COUNT(*) + 1 INTO seq_num
    FROM orders
    WHERE store_id = NEW.store_id
      AND created_at >= (now() AT TIME ZONE 'Asia/Taipei')::date
      AND created_at < (now() AT TIME ZONE 'Asia/Taipei')::date + interval '1 day';

    IF NEW.order_number IS NULL OR NEW.order_number = '' THEN
        NEW.order_number := today_date || '-' || LPAD(seq_num::TEXT, 4, '0');
    END IF;

    IF NEW.pickup_number IS NULL THEN
        NEW.pickup_number := seq_num;
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_order_number ON orders;
CREATE TRIGGER trg_order_number
    BEFORE INSERT ON orders
    FOR EACH ROW EXECUTE FUNCTION generate_order_number();

-- ========================
-- 11. 清理過期公告函數
-- ========================
CREATE OR REPLACE FUNCTION cleanup_expired_announcements()
RETURNS void AS $$
DECLARE
    settings_row RECORD;
    items JSONB;
    filtered JSONB;
    today TEXT;
BEGIN
    today := to_char(now() AT TIME ZONE 'Asia/Taipei', 'YYYY-MM-DD');

    SELECT value INTO settings_row
    FROM system_settings
    WHERE key = 'announcements';

    IF settings_row IS NULL THEN RETURN; END IF;

    items := settings_row.value -> 'items';
    IF items IS NULL THEN RETURN; END IF;

    SELECT jsonb_agg(elem) INTO filtered
    FROM jsonb_array_elements(items) AS elem
    WHERE (elem ->> 'expire_date') IS NULL
       OR (elem ->> 'expire_date') = ''
       OR (elem ->> 'expire_date') >= today;

    UPDATE system_settings
    SET value = jsonb_build_object('items', COALESCE(filtered, '[]'::jsonb)),
        updated_at = now()
    WHERE key = 'announcements';
END;
$$ LANGUAGE plpgsql;

-- 記錄此 migration 已執行
INSERT INTO _migrations (filename) VALUES ('010_comprehensive_fixes.sql')
ON CONFLICT (filename) DO NOTHING;
