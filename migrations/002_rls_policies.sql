-- ============================================================
-- 002_rls_policies.sql
-- HR Attendance LIFF — RLS 安全策略
-- 執行順序：第 2 個
-- ============================================================
-- 說明：Supabase 預設啟用 RLS 後，無 policy 的表無法存取。
-- 此系統使用 Anon Key + 前端驗證（LINE LIFF），
-- 所以 RLS 設為 allow all，實際權限由前端 role 控制。
-- 生產環境建議改為更嚴格的 policy。

-- 啟用 RLS
ALTER TABLE companies ENABLE ROW LEVEL SECURITY;
ALTER TABLE employees ENABLE ROW LEVEL SECURITY;
ALTER TABLE shift_types ENABLE ROW LEVEL SECURITY;
ALTER TABLE schedules ENABLE ROW LEVEL SECURITY;
ALTER TABLE attendance ENABLE ROW LEVEL SECURITY;
ALTER TABLE leave_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE makeup_punch_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE overtime_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE shift_swap_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE salary_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE payroll ENABLE ROW LEVEL SECURITY;
ALTER TABLE annual_bonus ENABLE ROW LEVEL SECURITY;
ALTER TABLE system_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE lunch_orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE hr_audit_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE announcement_acknowledgments ENABLE ROW LEVEL SECURITY;
ALTER TABLE office_locations ENABLE ROW LEVEL SECURITY;
ALTER TABLE insurance_brackets ENABLE ROW LEVEL SECURITY;
ALTER TABLE overtime_rules ENABLE ROW LEVEL SECURITY;
ALTER TABLE binding_attempts ENABLE ROW LEVEL SECURITY;
ALTER TABLE binding_audit_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE verification_codes ENABLE ROW LEVEL SECURITY;

-- 建立通用 policy（允許 anon 和 authenticated 讀寫）
DO $$
DECLARE
    t TEXT;
BEGIN
    FOREACH t IN ARRAY ARRAY[
        'companies','employees','shift_types','schedules','attendance',
        'leave_requests','makeup_punch_requests','overtime_requests',
        'shift_swap_requests','salary_settings','payroll','annual_bonus',
        'system_settings','lunch_orders','hr_audit_logs',
        'announcement_acknowledgments','office_locations',
        'insurance_brackets','overtime_rules',
        'binding_attempts','binding_audit_log','verification_codes'
    ]
    LOOP
        EXECUTE format('
            CREATE POLICY IF NOT EXISTS "allow_select_%s" ON %I FOR SELECT USING (true);
            CREATE POLICY IF NOT EXISTS "allow_insert_%s" ON %I FOR INSERT WITH CHECK (true);
            CREATE POLICY IF NOT EXISTS "allow_update_%s" ON %I FOR UPDATE USING (true) WITH CHECK (true);
            CREATE POLICY IF NOT EXISTS "allow_delete_%s" ON %I FOR DELETE USING (true);
        ', t, t, t, t, t, t, t, t);
    END LOOP;
END;
$$;

INSERT INTO _migrations (filename) VALUES ('002_rls_policies.sql')
ON CONFLICT (filename) DO NOTHING;
