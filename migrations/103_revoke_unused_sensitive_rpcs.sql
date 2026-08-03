-- ============================================================
-- 103: 收回兩支「前端沒在用、卻對 anon 開放」的敏感 RPC
--
-- 承 099/101 的同型排查，改以 employee_id 為條件再掃一次，找到兩支：
--
-- 1. calculate_monthly_payroll(p_employee_id, p_year, p_month)
--    SECURITY DEFINER + GRANT anon，只收 employee_id 不驗呼叫者。
--    實測：以 anon key 帶真實 employee_id 呼叫，直接回傳該員工的
--    net_salary / gross_salary / total_deduction / 出勤天數。
--    employees 表目前 anon 可全讀（37/37），employee_id 唾手可得，
--    等於任何人都能查任一員工的實領薪資。
--    全庫 grep：前端沒有任何地方呼叫它（薪資走 modules/payroll.js 自行計算
--    與 088 的 RPC），屬歷史遺留。
--
-- 2. generate_binding_code(p_employee_id VARCHAR)
--    SECURITY DEFINER + GRANT anon，只檢查員工編號存在就產生 6 位數綁定碼
--    並「把碼回傳給呼叫者」。等於任何人都能為任一員工編號取得綁定碼，
--    是帳號綁定被冒用的破口。
--    全庫 grep：前端沒有任何地方呼叫它，verification_codes 表 0 筆，
--    現行綁定流程走 bind_existing_employee(052)，此為舊設計殘留。
--
-- 處置：兩支都不刪除（保留給未來可能的後台使用），只收回 anon/authenticated
--       的執行權限。前端零影響（本來就沒在呼叫）。
-- ============================================================

REVOKE ALL ON FUNCTION calculate_monthly_payroll(UUID, INTEGER, INTEGER)
    FROM PUBLIC, anon, authenticated;

REVOKE ALL ON FUNCTION generate_binding_code(CHARACTER VARYING)
    FROM PUBLIC, anon, authenticated;
