-- ============================================================
-- 070: platform_admin 跨公司 UPDATE + 多公司員工讀取自己的所有記錄
--
-- 背景 1（role 編輯）：
--   admin.html 編輯員工 modal 新增 role 欄位（僅 platform_admin 可見）。
--   既有 employees_update_admin policy 僅允許本公司 is_admin() 更新；
--   platform_admin 若無對應公司的 employees.role='admin' 紀錄，會被擋。
--   即使有，多公司 platform_admin 的 get_my_employee_id() LIMIT 1 會抓到
--   隨機一筆，company_id 比對失敗機率高。
--
-- 背景 2（多公司員工讀取）：
--   common.js checkUserStatus 需要查該 LINE user 所有 employees 記錄；
--   既有 employees_select policy 為 company_id = get_my_company_id()
--   OR is_platform_admin()，非平台管理員的多公司員工會被擋掉其他公司的自己。
--
-- 修正：
--   (1) 新增 policy 讓 platform_admin 跨公司 UPDATE。
--   (2) 新增 policy 讓任何使用者 SELECT 自己所有的 employees 記錄。
-- 安全性：
--   - 前端僅 platform_admin 看得到 role 下拉，一般使用者無法觸發
--   - DB layer 以 is_platform_admin() 二次防線
--   - role 白名單（admin/user/manager）由前端驗證 + 既有 DB CHECK 保障
-- ============================================================

-- (1) platform_admin 跨公司 UPDATE
CREATE POLICY "employees_update_platform_admin" ON employees FOR UPDATE
    USING (is_platform_admin())
    WITH CHECK (is_platform_admin());

-- (2) 任何使用者可 SELECT 自己所有的 employees 記錄（跨公司多筆）
-- 注意：前端用 anon key，JWT 中 line_user_id 來自 app_metadata 或 sub claim
CREATE POLICY "employees_select_self_all_companies" ON employees FOR SELECT
    USING (
        line_user_id = COALESCE(
            current_setting('request.jwt.claims', true)::jsonb -> 'app_metadata' ->> 'line_user_id',
            current_setting('request.jwt.claims', true)::jsonb ->> 'sub'
        )
    );

DO $$
BEGIN
    RAISE NOTICE '✅ employees_update_platform_admin + employees_select_self_all_companies 已建立';
END $$;
