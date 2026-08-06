-- ============================================================
-- 112: 收掉 payroll / salary_settings / payroll_records 的全開政策（P0 第二批收尾）
--
-- ⚠️ 套用前提（順序不可顛倒，見 docs/RLS_REMEDIATION_INVENTORY.md §5）：
--   1. migration 111 已套用（save_payroll_records / upsert_salary_setting 存在）
--   2. modules/payroll.js 的 2 處 payroll upsert、modules/payroll.js 與
--      modules/employees.js 的 4 個 salary_settings 寫入語句已全部改為呼叫 RPC，
--      且已合併 main 部署完成
--   3. 線上實際確認薪資計算頁的「儲存全部（草稿）」「發布」、薪資設定批次儲存、
--      員工管理的薪資設定 Modal 都還能存檔
--
--   在 (2) 完成前套用這支，上述四個存檔動作會全部失敗。
--
-- 收掉什麼（查證 2026-08-06 正式庫現況）：
--   payroll           payroll_insert / payroll_update / payroll_delete
--                     三條角色皆 PUBLIC、條件皆 true
--   salary_settings   salary_settings_insert / _update / _delete，同上
--   payroll_records   payroll_select / payroll_insert / payroll_update，同上
--
--   三張表都沒有給 anon 的 SELECT 政策（payroll_records 有，但該表 0 筆資料、
--   前端完全沒有使用，只有兩支健康檢查腳本會碰）。真正開著的是寫入——
--   任何人拿公開 anon key 就能偽造、竄改或刪光全公司薪資。
--
-- 保留什麼：
--   payroll 的「Service Role Full Access - payroll」（角色 service_role）保留。
--   service_role 只在伺服器端使用，不會出現在前端。
--
-- 收完之後三張表都是 RLS on + 0 條（或僅 service_role）政策，
-- 所有存取一律經 SECURITY DEFINER 函式，與 attendance_anomalies、
-- checkin_failures、overtime_requests（110）同一個設計。
--
-- 回滾：重建這 9 條政策即可退回本次整治前的狀態，例如
--   CREATE POLICY payroll_insert ON payroll FOR INSERT WITH CHECK (true);
--   （不建議——那等於把門重新打開）
--
-- 驗證方式：
--   套用後跑 bash scripts/rls_audit.sh，第 2 段「USING(true) 且套用到
--   anon/PUBLIC 的政策」不應再出現這三張表。
-- ============================================================

-- payroll
DROP POLICY IF EXISTS payroll_insert ON payroll;
DROP POLICY IF EXISTS payroll_update ON payroll;
DROP POLICY IF EXISTS payroll_delete ON payroll;

-- salary_settings
DROP POLICY IF EXISTS salary_settings_insert ON salary_settings;
DROP POLICY IF EXISTS salary_settings_update ON salary_settings;
DROP POLICY IF EXISTS salary_settings_delete ON salary_settings;

-- payroll_records（0 筆資料、前端未使用）
DROP POLICY IF EXISTS payroll_select ON payroll_records;
DROP POLICY IF EXISTS payroll_insert ON payroll_records;
DROP POLICY IF EXISTS payroll_update ON payroll_records;
