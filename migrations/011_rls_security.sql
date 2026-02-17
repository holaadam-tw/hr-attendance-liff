-- ============================================================
-- 011_rls_security.sql
-- HR Attendance LIFF — RLS 安全策略強化
-- 取代 002 的 allow-all 策略，實作多租戶隔離 + 角色權限
-- ============================================================
-- 前置需求：Supabase Auth 需在 JWT app_metadata 中包含 line_user_id
-- 例如：{ "app_metadata": { "line_user_id": "U1234..." } }
-- ============================================================

-- ========================
-- 0. 輔助函數
-- ========================

-- 取得目前登入者的 employee_id
CREATE OR REPLACE FUNCTION get_my_employee_id()
RETURNS UUID AS $$
    SELECT id FROM employees
    WHERE line_user_id = (
        COALESCE(
            current_setting('request.jwt.claims', true)::jsonb -> 'app_metadata' ->> 'line_user_id',
            current_setting('request.jwt.claims', true)::jsonb ->> 'sub'
        )
    )
    AND is_active = true
    LIMIT 1;
$$ LANGUAGE sql STABLE SECURITY DEFINER;

-- 取得目前登入者的 company_id
CREATE OR REPLACE FUNCTION get_my_company_id()
RETURNS UUID AS $$
    SELECT company_id FROM employees
    WHERE id = get_my_employee_id()
    LIMIT 1;
$$ LANGUAGE sql STABLE SECURITY DEFINER;

-- 判斷目前登入者是否為管理員
CREATE OR REPLACE FUNCTION is_admin()
RETURNS BOOLEAN AS $$
    SELECT EXISTS (
        SELECT 1 FROM employees
        WHERE id = get_my_employee_id()
          AND role IN ('admin', 'manager')
    );
$$ LANGUAGE sql STABLE SECURITY DEFINER;

-- 判斷目前登入者是否為平台管理員
CREATE OR REPLACE FUNCTION is_platform_admin()
RETURNS BOOLEAN AS $$
    SELECT EXISTS (
        SELECT 1 FROM platform_admins
        WHERE line_user_id = (
            COALESCE(
                current_setting('request.jwt.claims', true)::jsonb -> 'app_metadata' ->> 'line_user_id',
                current_setting('request.jwt.claims', true)::jsonb ->> 'sub'
            )
        )
        AND is_active = true
    );
$$ LANGUAGE sql STABLE SECURITY DEFINER;

-- ========================
-- 1. 清除所有舊的 allow-all 策略
-- ========================
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
        'binding_attempts','binding_audit_log','verification_codes',
        'platform_admins','sales_targets','sales_activities',
        'store_profiles','menu_categories','menu_items',
        'orders','bookings','loyalty_points',
        'clients','service_items','field_work_logs'
    ]
    LOOP
        -- 移除所有既有 policy
        EXECUTE format('DROP POLICY IF EXISTS "allow_select_%s" ON %I', t, t);
        EXECUTE format('DROP POLICY IF EXISTS "allow_insert_%s" ON %I', t, t);
        EXECUTE format('DROP POLICY IF EXISTS "allow_update_%s" ON %I', t, t);
        EXECUTE format('DROP POLICY IF EXISTS "allow_delete_%s" ON %I', t, t);
    END LOOP;
END;
$$;

-- 確保所有表都啟用 RLS
ALTER TABLE clients ENABLE ROW LEVEL SECURITY;
ALTER TABLE service_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE field_work_logs ENABLE ROW LEVEL SECURITY;

-- ========================
-- 2. companies（公司）
-- 同公司成員可讀，平台管理員可寫
-- ========================
CREATE POLICY "companies_select" ON companies FOR SELECT
    USING (id = get_my_company_id() OR is_platform_admin());
CREATE POLICY "companies_insert" ON companies FOR INSERT
    WITH CHECK (is_platform_admin());
CREATE POLICY "companies_update" ON companies FOR UPDATE
    USING (id = get_my_company_id() AND is_admin())
    WITH CHECK (id = get_my_company_id() AND is_admin());
CREATE POLICY "companies_delete" ON companies FOR DELETE
    USING (is_platform_admin());

-- ========================
-- 3. employees（員工）
-- 同公司可讀，管理員可增刪改，自己可改自己
-- ========================
CREATE POLICY "employees_select" ON employees FOR SELECT
    USING (company_id = get_my_company_id() OR is_platform_admin());
CREATE POLICY "employees_insert" ON employees FOR INSERT
    WITH CHECK (company_id = get_my_company_id() AND is_admin());
CREATE POLICY "employees_update_admin" ON employees FOR UPDATE
    USING (company_id = get_my_company_id() AND is_admin())
    WITH CHECK (company_id = get_my_company_id() AND is_admin());
CREATE POLICY "employees_update_self" ON employees FOR UPDATE
    USING (id = get_my_employee_id())
    WITH CHECK (id = get_my_employee_id());
CREATE POLICY "employees_delete" ON employees FOR DELETE
    USING (company_id = get_my_company_id() AND is_admin());

-- ========================
-- 4. shift_types（班別定義）
-- 全公司可讀，管理員可寫
-- ========================
CREATE POLICY "shift_types_select" ON shift_types FOR SELECT
    USING (true);
CREATE POLICY "shift_types_insert" ON shift_types FOR INSERT
    WITH CHECK (is_admin());
CREATE POLICY "shift_types_update" ON shift_types FOR UPDATE
    USING (is_admin()) WITH CHECK (is_admin());
CREATE POLICY "shift_types_delete" ON shift_types FOR DELETE
    USING (is_admin());

-- ========================
-- 5. schedules（排班表）
-- 同公司可讀，管理員可寫
-- ========================
CREATE POLICY "schedules_select" ON schedules FOR SELECT
    USING (employee_id IN (
        SELECT id FROM employees WHERE company_id = get_my_company_id()
    ));
CREATE POLICY "schedules_insert" ON schedules FOR INSERT
    WITH CHECK (is_admin() AND employee_id IN (
        SELECT id FROM employees WHERE company_id = get_my_company_id()
    ));
CREATE POLICY "schedules_update" ON schedules FOR UPDATE
    USING (is_admin() AND employee_id IN (
        SELECT id FROM employees WHERE company_id = get_my_company_id()
    ))
    WITH CHECK (is_admin());
CREATE POLICY "schedules_delete" ON schedules FOR DELETE
    USING (is_admin() AND employee_id IN (
        SELECT id FROM employees WHERE company_id = get_my_company_id()
    ));

-- ========================
-- 6. attendance（考勤紀錄）
-- 自己可讀寫自己的，管理員可讀寫同公司
-- ========================
CREATE POLICY "attendance_select" ON attendance FOR SELECT
    USING (
        employee_id = get_my_employee_id()
        OR (is_admin() AND employee_id IN (
            SELECT id FROM employees WHERE company_id = get_my_company_id()
        ))
    );
CREATE POLICY "attendance_insert" ON attendance FOR INSERT
    WITH CHECK (
        employee_id = get_my_employee_id()
        OR (is_admin() AND employee_id IN (
            SELECT id FROM employees WHERE company_id = get_my_company_id()
        ))
    );
CREATE POLICY "attendance_update" ON attendance FOR UPDATE
    USING (
        employee_id = get_my_employee_id()
        OR (is_admin() AND employee_id IN (
            SELECT id FROM employees WHERE company_id = get_my_company_id()
        ))
    )
    WITH CHECK (
        employee_id = get_my_employee_id()
        OR is_admin()
    );
CREATE POLICY "attendance_delete" ON attendance FOR DELETE
    USING (is_admin() AND employee_id IN (
        SELECT id FROM employees WHERE company_id = get_my_company_id()
    ));

-- ========================
-- 7. leave_requests（請假申請）
-- 自己可讀寫，管理員可讀寫同公司
-- ========================
CREATE POLICY "leave_requests_select" ON leave_requests FOR SELECT
    USING (
        employee_id = get_my_employee_id()
        OR (is_admin() AND employee_id IN (
            SELECT id FROM employees WHERE company_id = get_my_company_id()
        ))
    );
CREATE POLICY "leave_requests_insert" ON leave_requests FOR INSERT
    WITH CHECK (employee_id = get_my_employee_id());
CREATE POLICY "leave_requests_update" ON leave_requests FOR UPDATE
    USING (
        employee_id = get_my_employee_id()
        OR (is_admin() AND employee_id IN (
            SELECT id FROM employees WHERE company_id = get_my_company_id()
        ))
    )
    WITH CHECK (
        employee_id = get_my_employee_id()
        OR is_admin()
    );
CREATE POLICY "leave_requests_delete" ON leave_requests FOR DELETE
    USING (is_admin() AND employee_id IN (
        SELECT id FROM employees WHERE company_id = get_my_company_id()
    ));

-- ========================
-- 8. makeup_punch_requests（補打卡申請）
-- 同 leave_requests 模式
-- ========================
CREATE POLICY "makeup_punch_select" ON makeup_punch_requests FOR SELECT
    USING (
        employee_id = get_my_employee_id()
        OR (is_admin() AND employee_id IN (
            SELECT id FROM employees WHERE company_id = get_my_company_id()
        ))
    );
CREATE POLICY "makeup_punch_insert" ON makeup_punch_requests FOR INSERT
    WITH CHECK (employee_id = get_my_employee_id());
CREATE POLICY "makeup_punch_update" ON makeup_punch_requests FOR UPDATE
    USING (
        employee_id = get_my_employee_id()
        OR (is_admin() AND employee_id IN (
            SELECT id FROM employees WHERE company_id = get_my_company_id()
        ))
    )
    WITH CHECK (employee_id = get_my_employee_id() OR is_admin());
CREATE POLICY "makeup_punch_delete" ON makeup_punch_requests FOR DELETE
    USING (is_admin() AND employee_id IN (
        SELECT id FROM employees WHERE company_id = get_my_company_id()
    ));

-- ========================
-- 9. overtime_requests（加班申請）
-- 同 leave_requests 模式
-- ========================
CREATE POLICY "overtime_req_select" ON overtime_requests FOR SELECT
    USING (
        employee_id = get_my_employee_id()
        OR (is_admin() AND employee_id IN (
            SELECT id FROM employees WHERE company_id = get_my_company_id()
        ))
    );
CREATE POLICY "overtime_req_insert" ON overtime_requests FOR INSERT
    WITH CHECK (employee_id = get_my_employee_id());
CREATE POLICY "overtime_req_update" ON overtime_requests FOR UPDATE
    USING (
        employee_id = get_my_employee_id()
        OR (is_admin() AND employee_id IN (
            SELECT id FROM employees WHERE company_id = get_my_company_id()
        ))
    )
    WITH CHECK (employee_id = get_my_employee_id() OR is_admin());
CREATE POLICY "overtime_req_delete" ON overtime_requests FOR DELETE
    USING (is_admin() AND employee_id IN (
        SELECT id FROM employees WHERE company_id = get_my_company_id()
    ));

-- ========================
-- 10. shift_swap_requests（換班申請）
-- 同公司可讀（需看到對方的換班），自己可建，管理員可改刪
-- ========================
CREATE POLICY "shift_swap_select" ON shift_swap_requests FOR SELECT
    USING (
        requester_id = get_my_employee_id()
        OR target_id = get_my_employee_id()
        OR (is_admin() AND requester_id IN (
            SELECT id FROM employees WHERE company_id = get_my_company_id()
        ))
    );
CREATE POLICY "shift_swap_insert" ON shift_swap_requests FOR INSERT
    WITH CHECK (requester_id = get_my_employee_id());
CREATE POLICY "shift_swap_update" ON shift_swap_requests FOR UPDATE
    USING (
        requester_id = get_my_employee_id()
        OR target_id = get_my_employee_id()
        OR is_admin()
    )
    WITH CHECK (
        requester_id = get_my_employee_id()
        OR target_id = get_my_employee_id()
        OR is_admin()
    );
CREATE POLICY "shift_swap_delete" ON shift_swap_requests FOR DELETE
    USING (is_admin());

-- ========================
-- 11. salary_settings（薪資設定）— 敏感
-- 自己可讀自己的，管理員可讀寫同公司
-- ========================
CREATE POLICY "salary_select" ON salary_settings FOR SELECT
    USING (
        employee_id = get_my_employee_id()
        OR (is_admin() AND employee_id IN (
            SELECT id FROM employees WHERE company_id = get_my_company_id()
        ))
    );
CREATE POLICY "salary_insert" ON salary_settings FOR INSERT
    WITH CHECK (is_admin() AND employee_id IN (
        SELECT id FROM employees WHERE company_id = get_my_company_id()
    ));
CREATE POLICY "salary_update" ON salary_settings FOR UPDATE
    USING (is_admin() AND employee_id IN (
        SELECT id FROM employees WHERE company_id = get_my_company_id()
    ))
    WITH CHECK (is_admin());
CREATE POLICY "salary_delete" ON salary_settings FOR DELETE
    USING (is_admin() AND employee_id IN (
        SELECT id FROM employees WHERE company_id = get_my_company_id()
    ));

-- ========================
-- 12. payroll（薪資單）— 敏感
-- 自己可讀自己的，管理員可讀寫同公司
-- ========================
CREATE POLICY "payroll_select" ON payroll FOR SELECT
    USING (
        employee_id = get_my_employee_id()
        OR (is_admin() AND employee_id IN (
            SELECT id FROM employees WHERE company_id = get_my_company_id()
        ))
    );
CREATE POLICY "payroll_insert" ON payroll FOR INSERT
    WITH CHECK (is_admin() AND employee_id IN (
        SELECT id FROM employees WHERE company_id = get_my_company_id()
    ));
CREATE POLICY "payroll_update" ON payroll FOR UPDATE
    USING (is_admin() AND employee_id IN (
        SELECT id FROM employees WHERE company_id = get_my_company_id()
    ))
    WITH CHECK (is_admin());
CREATE POLICY "payroll_delete" ON payroll FOR DELETE
    USING (is_admin() AND employee_id IN (
        SELECT id FROM employees WHERE company_id = get_my_company_id()
    ));

-- ========================
-- 13. annual_bonus（年終獎金）— 敏感
-- 同 payroll 模式
-- ========================
CREATE POLICY "bonus_select" ON annual_bonus FOR SELECT
    USING (
        employee_id = get_my_employee_id()
        OR (is_admin() AND employee_id IN (
            SELECT id FROM employees WHERE company_id = get_my_company_id()
        ))
    );
CREATE POLICY "bonus_insert" ON annual_bonus FOR INSERT
    WITH CHECK (is_admin() AND employee_id IN (
        SELECT id FROM employees WHERE company_id = get_my_company_id()
    ));
CREATE POLICY "bonus_update" ON annual_bonus FOR UPDATE
    USING (is_admin() AND employee_id IN (
        SELECT id FROM employees WHERE company_id = get_my_company_id()
    ))
    WITH CHECK (is_admin());
CREATE POLICY "bonus_delete" ON annual_bonus FOR DELETE
    USING (is_admin() AND employee_id IN (
        SELECT id FROM employees WHERE company_id = get_my_company_id()
    ));

-- ========================
-- 14. system_settings（系統設定）
-- 同公司可讀，管理員可寫
-- ========================
CREATE POLICY "settings_select" ON system_settings FOR SELECT
    USING (
        company_id IS NULL
        OR company_id = get_my_company_id()
    );
CREATE POLICY "settings_insert" ON system_settings FOR INSERT
    WITH CHECK (is_admin());
CREATE POLICY "settings_update" ON system_settings FOR UPDATE
    USING (is_admin() AND (company_id IS NULL OR company_id = get_my_company_id()))
    WITH CHECK (is_admin());
CREATE POLICY "settings_delete" ON system_settings FOR DELETE
    USING (is_admin() AND (company_id IS NULL OR company_id = get_my_company_id()));

-- ========================
-- 15. lunch_orders（午餐訂單）
-- 自己可讀寫，管理員可讀寫同公司
-- ========================
CREATE POLICY "lunch_select" ON lunch_orders FOR SELECT
    USING (
        employee_id = get_my_employee_id()
        OR (is_admin() AND employee_id IN (
            SELECT id FROM employees WHERE company_id = get_my_company_id()
        ))
    );
CREATE POLICY "lunch_insert" ON lunch_orders FOR INSERT
    WITH CHECK (employee_id = get_my_employee_id());
CREATE POLICY "lunch_update" ON lunch_orders FOR UPDATE
    USING (
        employee_id = get_my_employee_id()
        OR (is_admin() AND employee_id IN (
            SELECT id FROM employees WHERE company_id = get_my_company_id()
        ))
    )
    WITH CHECK (employee_id = get_my_employee_id() OR is_admin());
CREATE POLICY "lunch_delete" ON lunch_orders FOR DELETE
    USING (is_admin());

-- ========================
-- 16. office_locations（辦公地點）
-- 同公司可讀，管理員可寫
-- ========================
CREATE POLICY "office_loc_select" ON office_locations FOR SELECT
    USING (company_id = get_my_company_id());
CREATE POLICY "office_loc_insert" ON office_locations FOR INSERT
    WITH CHECK (is_admin() AND company_id = get_my_company_id());
CREATE POLICY "office_loc_update" ON office_locations FOR UPDATE
    USING (is_admin() AND company_id = get_my_company_id())
    WITH CHECK (is_admin() AND company_id = get_my_company_id());
CREATE POLICY "office_loc_delete" ON office_locations FOR DELETE
    USING (is_admin() AND company_id = get_my_company_id());

-- ========================
-- 17. hr_audit_logs（稽核紀錄）
-- 管理員可讀，系統可寫（任何人可 insert）
-- ========================
CREATE POLICY "audit_select" ON hr_audit_logs FOR SELECT
    USING (is_admin());
CREATE POLICY "audit_insert" ON hr_audit_logs FOR INSERT
    WITH CHECK (true);

-- ========================
-- 18. announcement_acknowledgments（公告確認）
-- 自己可讀寫自己的
-- ========================
CREATE POLICY "ack_select" ON announcement_acknowledgments FOR SELECT
    USING (employee_id = get_my_employee_id() OR is_admin());
CREATE POLICY "ack_insert" ON announcement_acknowledgments FOR INSERT
    WITH CHECK (employee_id = get_my_employee_id());

-- ========================
-- 19. insurance_brackets（保險級距）
-- 唯讀參考表
-- ========================
CREATE POLICY "insurance_select" ON insurance_brackets FOR SELECT
    USING (true);
CREATE POLICY "insurance_write" ON insurance_brackets FOR ALL
    USING (is_platform_admin())
    WITH CHECK (is_platform_admin());

-- ========================
-- 20. overtime_rules（加班規則）
-- 同公司可讀，管理員可寫
-- ========================
CREATE POLICY "ot_rules_select" ON overtime_rules FOR SELECT
    USING (true);
CREATE POLICY "ot_rules_insert" ON overtime_rules FOR INSERT
    WITH CHECK (is_admin());
CREATE POLICY "ot_rules_update" ON overtime_rules FOR UPDATE
    USING (is_admin()) WITH CHECK (is_admin());

-- ========================
-- 21. binding_attempts / binding_audit_log / verification_codes
-- 綁定流程表：自己可讀寫，管理員可讀
-- ========================
CREATE POLICY "binding_att_select" ON binding_attempts FOR SELECT
    USING (true);
CREATE POLICY "binding_att_insert" ON binding_attempts FOR INSERT
    WITH CHECK (true);
CREATE POLICY "binding_att_update" ON binding_attempts FOR UPDATE
    USING (true) WITH CHECK (true);

CREATE POLICY "binding_audit_select" ON binding_audit_log FOR SELECT
    USING (is_admin());
CREATE POLICY "binding_audit_insert" ON binding_audit_log FOR INSERT
    WITH CHECK (true);

CREATE POLICY "verify_code_select" ON verification_codes FOR SELECT
    USING (true);
CREATE POLICY "verify_code_insert" ON verification_codes FOR INSERT
    WITH CHECK (true);
CREATE POLICY "verify_code_update" ON verification_codes FOR UPDATE
    USING (true) WITH CHECK (true);
CREATE POLICY "verify_code_delete" ON verification_codes FOR DELETE
    USING (true);

-- ========================
-- 22. platform_admins（平台管理員）
-- 只有平台管理員可存取
-- ========================
CREATE POLICY "platadmin_select" ON platform_admins FOR SELECT
    USING (is_platform_admin());
CREATE POLICY "platadmin_insert" ON platform_admins FOR INSERT
    WITH CHECK (is_platform_admin());
CREATE POLICY "platadmin_update" ON platform_admins FOR UPDATE
    USING (is_platform_admin()) WITH CHECK (is_platform_admin());

-- ========================
-- 23. sales_targets（業務目標）
-- 同公司可讀，管理員可寫
-- ========================
CREATE POLICY "sales_target_select" ON sales_targets FOR SELECT
    USING (company_id = get_my_company_id());
CREATE POLICY "sales_target_insert" ON sales_targets FOR INSERT
    WITH CHECK (is_admin() AND company_id = get_my_company_id());
CREATE POLICY "sales_target_update" ON sales_targets FOR UPDATE
    USING (is_admin() AND company_id = get_my_company_id())
    WITH CHECK (is_admin());
CREATE POLICY "sales_target_delete" ON sales_targets FOR DELETE
    USING (is_admin() AND company_id = get_my_company_id());

-- ========================
-- 24. sales_activities（業務活動）
-- 自己可讀寫，管理員可讀同公司
-- ========================
CREATE POLICY "sales_act_select" ON sales_activities FOR SELECT
    USING (
        employee_id = get_my_employee_id()
        OR (is_admin() AND company_id = get_my_company_id())
    );
CREATE POLICY "sales_act_insert" ON sales_activities FOR INSERT
    WITH CHECK (employee_id = get_my_employee_id());
CREATE POLICY "sales_act_update" ON sales_activities FOR UPDATE
    USING (
        employee_id = get_my_employee_id()
        OR (is_admin() AND company_id = get_my_company_id())
    )
    WITH CHECK (employee_id = get_my_employee_id() OR is_admin());
CREATE POLICY "sales_act_delete" ON sales_activities FOR DELETE
    USING (is_admin() AND company_id = get_my_company_id());

-- ========================
-- 25. clients（客戶）
-- 同公司可讀寫（無 company_id，但透過業務活動關聯）
-- ========================
CREATE POLICY "clients_select" ON clients FOR SELECT
    USING (true);
CREATE POLICY "clients_insert" ON clients FOR INSERT
    WITH CHECK (get_my_employee_id() IS NOT NULL);
CREATE POLICY "clients_update" ON clients FOR UPDATE
    USING (get_my_employee_id() IS NOT NULL)
    WITH CHECK (get_my_employee_id() IS NOT NULL);
CREATE POLICY "clients_delete" ON clients FOR DELETE
    USING (is_admin());

-- ========================
-- 26. service_items（服務項目）
-- 唯讀參考表，管理員可寫
-- ========================
CREATE POLICY "service_items_select" ON service_items FOR SELECT
    USING (true);
CREATE POLICY "service_items_insert" ON service_items FOR INSERT
    WITH CHECK (is_admin());
CREATE POLICY "service_items_update" ON service_items FOR UPDATE
    USING (is_admin()) WITH CHECK (is_admin());

-- ========================
-- 27. field_work_logs（外勤紀錄）
-- 自己可讀寫，管理員可讀寫同公司
-- ========================
CREATE POLICY "field_work_select" ON field_work_logs FOR SELECT
    USING (
        employee_id = get_my_employee_id()
        OR (is_admin() AND employee_id IN (
            SELECT id FROM employees WHERE company_id = get_my_company_id()
        ))
    );
CREATE POLICY "field_work_insert" ON field_work_logs FOR INSERT
    WITH CHECK (employee_id = get_my_employee_id());
CREATE POLICY "field_work_update" ON field_work_logs FOR UPDATE
    USING (
        employee_id = get_my_employee_id()
        OR (is_admin() AND employee_id IN (
            SELECT id FROM employees WHERE company_id = get_my_company_id()
        ))
    )
    WITH CHECK (employee_id = get_my_employee_id() OR is_admin());
CREATE POLICY "field_work_delete" ON field_work_logs FOR DELETE
    USING (is_admin() AND employee_id IN (
        SELECT id FROM employees WHERE company_id = get_my_company_id()
    ));

-- ========================
-- 28. store_profiles（商店設定）
-- 公開可讀（顧客需要看到），同公司管理員可寫
-- ========================
CREATE POLICY "store_select" ON store_profiles FOR SELECT
    USING (true);
CREATE POLICY "store_insert" ON store_profiles FOR INSERT
    WITH CHECK (is_admin() AND company_id = get_my_company_id());
CREATE POLICY "store_update" ON store_profiles FOR UPDATE
    USING (is_admin() AND company_id = get_my_company_id())
    WITH CHECK (is_admin());
CREATE POLICY "store_delete" ON store_profiles FOR DELETE
    USING (is_admin() AND company_id = get_my_company_id());

-- ========================
-- 29. menu_categories（菜單分類）
-- 公開可讀，商店管理員可寫
-- ========================
CREATE POLICY "menu_cat_select" ON menu_categories FOR SELECT
    USING (true);
CREATE POLICY "menu_cat_insert" ON menu_categories FOR INSERT
    WITH CHECK (is_admin() AND store_id IN (
        SELECT id FROM store_profiles WHERE company_id = get_my_company_id()
    ));
CREATE POLICY "menu_cat_update" ON menu_categories FOR UPDATE
    USING (is_admin() AND store_id IN (
        SELECT id FROM store_profiles WHERE company_id = get_my_company_id()
    ))
    WITH CHECK (is_admin());
CREATE POLICY "menu_cat_delete" ON menu_categories FOR DELETE
    USING (is_admin() AND store_id IN (
        SELECT id FROM store_profiles WHERE company_id = get_my_company_id()
    ));

-- ========================
-- 30. menu_items（菜單品項）
-- 公開可讀，商店管理員可寫
-- ========================
CREATE POLICY "menu_item_select" ON menu_items FOR SELECT
    USING (true);
CREATE POLICY "menu_item_insert" ON menu_items FOR INSERT
    WITH CHECK (is_admin() AND store_id IN (
        SELECT id FROM store_profiles WHERE company_id = get_my_company_id()
    ));
CREATE POLICY "menu_item_update" ON menu_items FOR UPDATE
    USING (is_admin() AND store_id IN (
        SELECT id FROM store_profiles WHERE company_id = get_my_company_id()
    ))
    WITH CHECK (is_admin());
CREATE POLICY "menu_item_delete" ON menu_items FOR DELETE
    USING (is_admin() AND store_id IN (
        SELECT id FROM store_profiles WHERE company_id = get_my_company_id()
    ));

-- ========================
-- 31. orders（訂單）
-- 公開可讀寫（顧客直接下單），管理員可改狀態
-- ========================
CREATE POLICY "orders_select" ON orders FOR SELECT
    USING (true);
CREATE POLICY "orders_insert" ON orders FOR INSERT
    WITH CHECK (true);
CREATE POLICY "orders_update" ON orders FOR UPDATE
    USING (
        -- 顧客可取消自己的訂單（透過 customer_line_id）
        customer_line_id = (
            COALESCE(
                current_setting('request.jwt.claims', true)::jsonb -> 'app_metadata' ->> 'line_user_id',
                current_setting('request.jwt.claims', true)::jsonb ->> 'sub'
            )
        )
        -- 管理員可更新所有同商店訂單
        OR (is_admin() AND store_id IN (
            SELECT id FROM store_profiles WHERE company_id = get_my_company_id()
        ))
    )
    WITH CHECK (true);
CREATE POLICY "orders_delete" ON orders FOR DELETE
    USING (is_admin() AND store_id IN (
        SELECT id FROM store_profiles WHERE company_id = get_my_company_id()
    ));

-- ========================
-- 32. bookings（預約）
-- 公開可建，管理員可讀改刪
-- ========================
CREATE POLICY "bookings_select" ON bookings FOR SELECT
    USING (true);
CREATE POLICY "bookings_insert" ON bookings FOR INSERT
    WITH CHECK (true);
CREATE POLICY "bookings_update" ON bookings FOR UPDATE
    USING (
        customer_line_id = (
            COALESCE(
                current_setting('request.jwt.claims', true)::jsonb -> 'app_metadata' ->> 'line_user_id',
                current_setting('request.jwt.claims', true)::jsonb ->> 'sub'
            )
        )
        OR (is_admin() AND store_id IN (
            SELECT id FROM store_profiles WHERE company_id = get_my_company_id()
        ))
    )
    WITH CHECK (true);
CREATE POLICY "bookings_delete" ON bookings FOR DELETE
    USING (is_admin() AND store_id IN (
        SELECT id FROM store_profiles WHERE company_id = get_my_company_id()
    ));

-- ========================
-- 33. loyalty_points（會員集點）
-- 自己可讀，管理員可讀寫
-- ========================
CREATE POLICY "loyalty_select" ON loyalty_points FOR SELECT
    USING (
        customer_line_id = (
            COALESCE(
                current_setting('request.jwt.claims', true)::jsonb -> 'app_metadata' ->> 'line_user_id',
                current_setting('request.jwt.claims', true)::jsonb ->> 'sub'
            )
        )
        OR (is_admin() AND store_id IN (
            SELECT id FROM store_profiles WHERE company_id = get_my_company_id()
        ))
    );
CREATE POLICY "loyalty_insert" ON loyalty_points FOR INSERT
    WITH CHECK (true);
CREATE POLICY "loyalty_update" ON loyalty_points FOR UPDATE
    USING (
        is_admin() AND store_id IN (
            SELECT id FROM store_profiles WHERE company_id = get_my_company_id()
        )
    )
    WITH CHECK (is_admin());

-- ========================
-- 記錄 migration
-- ========================
INSERT INTO _migrations (filename) VALUES ('011_rls_security.sql')
ON CONFLICT (filename) DO NOTHING;
