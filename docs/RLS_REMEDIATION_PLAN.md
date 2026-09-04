# RLS 資料外洩補救計畫（2026-07-03 調查）

## 1. 問題根因

正式 Supabase（nssuisyvlrqnqfxupklb）的 `_migrations` 表只有 `006/007/008/010/012`，**缺 `011_rls_security.sql`**。多租戶 RLS 強化從未部署，資料庫仍跑 `002` 的 allow-all `USING (true)`。

### 實測外洩（前端公開 anon key、不帶登入即可 SELECT）
| 資料表 | 狀態 |
|--------|------|
| `salary_settings` | ⚠️ 9 筆全可讀 |
| `payroll` | ⚠️ 可讀 |
| `employees` | ⚠️ 37 筆 = 大正 24 + 本米 13（**跨公司**）|
| `attendance` / `leave_requests` / `schedules` / `overtime_requests` / `system_settings` / `companies` | ⚠️ 全可讀 |
| `makeup_punch_requests` | ✅ 唯一 RLS 有生效（回空）|

anon key 印在每個 HTML 原始碼，任何人可下載兩家公司全部薪資、考勤、員工個資。

## 2. 為何不能直接套 011
全站無任何 `supabase.auth.signIn` / `setSession`，只用 anon key + client 端 `.eq('company_id', ...)` 過濾。011 的隔離函數 `get_my_employee_id()` 從 JWT `app_metadata.line_user_id` 取身分，但 app 無 auth session → 套 011 後真實使用者查詢也回 NULL → 打卡/薪資/排班全掛。寫入目前靠 SECURITY DEFINER RPC 繞過 RLS，所以 allow-all 對寫入無影響。

## 3. 兩條修法路線

### A. 建立真正的 Supabase Auth session（airtight，工程大）
登入時把 line_user_id 寫進已簽章 JWT（`app_metadata.line_user_id`），之後 011 直接生效。優點：伺服器端驗證身分，密不透風。缺點：需重做登入流程、每個頁面加 session 建立。

### B. 敏感讀取 RPC 化 + 收緊 RLS（漸進，非 airtight）— 目前傾向
每張敏感表：新增帶 `p_line_user_id` 的 SECURITY DEFINER 讀取 RPC + 把該表 RLS SELECT 改為拒絕 anon。

> ⚠️ **關鍵設計原則（勿重蹈 049 覆轍）**：RPC **不可信任 client 傳入的 `p_company_id`**。現有 `get_pending_makeup_requests(p_company_id)` / `approve_makeup_request(p_approver_id)` 直接信任 client 參數，等於沒隔離。新 RPC 必須收 `p_line_user_id`，在函數內 `resolve employee → company_id → role`，只回該公司資料。
>
> ⚠️ **B 的殘留弱點**：無 auth session 時 `p_line_user_id` 仍是 client 可偽造的。B 把門檻從「公開 anon key 即可撈」提高到「需有效 admin LINE ID 才可撈」，是顯著強化但非 airtight。若要 airtight 須走 A。建議：先 B 止血，中期評估 A。

## 4. B 方案 — 直接讀取盤點（需 RPC 化 + 收緊 RLS）

| 敏感表 | 直接讀取點 | 檔案 |
|--------|-----------|------|
| `salary_settings` | payroll.js:108, 418, 534；employees.js:251 | payroll / employees |
| `payroll` | payroll.js:538；audit.js:74 | payroll / audit |
| `attendance` | audit.js:39；payroll.js:109, 535 | audit / payroll |
| `leave_requests` | audit.js:44；payroll.js:110, 536；schedules.js:85 | audit / payroll / schedules |
| `overtime_requests` | audit.js:55；payroll.js:537 | audit / payroll |
| `schedules` | schedules.js:77, 267, 674, 675；payroll.js:540 | schedules / payroll |
| `employees` | ~20 處：auth.js:121/160/183/320, employees.js（多）, settings.js:591/745, payroll.js:107/417/533, schedules.js:75 | 6 檔 |

**順序陷阱**：`employees` 有 ~20 處且牽涉 `auth.js` 登入流程（`get_my_employee_id` 自己就要查 employees）。**employees 必須最後動**，否則先鎖 employees 會讓登入直接掛。

## 5. 建議分期

- **Phase 1（止血，最小面）**：`salary_settings` + `payroll`（財務個資最敏感、~6 讀取點、不碰登入流程）。
- **Phase 2**：`attendance` + `leave_requests` + `overtime_requests` + `schedules`。
- **Phase 3**：`employees`（最後，含登入流程改造），並補上 `011` 缺的其他表。
- **收尾**：把 `makeup_punch_requests` 以外的 RLS SELECT 全數改為拒絕 anon（每 Phase 收緊對應表）。

## 6. Phase 1 具體設計（待授權後實作）

### 新 RPC（SECURITY DEFINER，收 p_line_user_id，內部 resolve + is_admin 檢查）
```
get_payroll_overview(p_line_user_id TEXT, p_year INT, p_month INT)  -- 取代 payroll.js:538 + audit.js:74
get_salary_settings_current(p_line_user_id TEXT)                    -- 取代 payroll.js:108/418/534
get_salary_history(p_line_user_id TEXT, p_employee_id UUID)         -- 取代 employees.js:251（含呼叫者與目標同公司檢查）
```
每支開頭統一：
```sql
v_caller_company := (SELECT company_id FROM employees WHERE line_user_id = p_line_user_id AND is_active LIMIT 1);
IF v_caller_company IS NULL OR NOT <caller is admin/manager> THEN RETURN empty/error; END IF;
-- 之後所有查詢 WHERE company_id = v_caller_company
```

### RLS 收緊（Phase 1 隨 RPC 一起）
```sql
DROP POLICY IF EXISTS "allow_select_salary_settings" ON salary_settings;
DROP POLICY IF EXISTS "allow_select_payroll" ON payroll;
-- 不建新 SELECT policy（RLS 啟用 + 無 policy = 拒絕 anon 直接 SELECT；RPC 以 DEFINER 繞過）
```

### 前端改動
`modules/payroll.js` / `modules/audit.js` / `modules/employees.js` 對應讀取點改呼叫上述 RPC，傳 `liffProfile.userId`。寫入路徑（employees.js:298/299、payroll.js:490/1052/1097）本就走 upsert，若被 RLS 擋需另建寫入 RPC 或改走既有薪資寫入 RPC（待確認 upsert 是否已被擋）。

## 7. 驗證要求（每 Phase）
- 無法本地起 Postgres → RPC 行為須在正式庫套用後用 admin/service-role 實測（見停損：正式庫套用需 User 明確授權，對齊 Guardrails §1）。
- 前端改動跑 `bash scripts/qa_check.sh`（0 FAIL）+ `npm test`（53 通過）+ Hook 無新警告。
- 複雜任務（>3 檔）跑 `@rls-checker` 最終審查。
- 套用後用 anon key 重測：對應敏感表 SELECT 應回空/403。

## 8. 附帶：E818/E820 補卡來源（未解）
`makeup_punch_requests` 核准只改 `status='approved'` 不刪除（049:100），note 仍在但 RLS 擋 anon 讀不到。`hr_audit_logs` 的 makeup 核准全是 `System/approve/details=null`，無來源記錄。7/2 有 ~20 筆集中在 17:11–17:14 核准，像主管批次通過。**要定論 GPS 定位是否為特定裝置問題，須以 admin/service-role 直接查那幾筆 note（有 accuracy/座標即 GPS 精度審核轉入）。**

---

## 9. 2026-09-04 更新：現況重盤與分階段執行計畫

> 以下為 2026-09-04 依業主指示補上的執行計畫；上面第 1～4 節（2026-07-03 調查）的原則不變，特別是「RPC 不可只信任 client 傳入的 p_company_id」——118/119 新增的 RPC 一律以 `has_company_access(p_line_user_id, p_company_id, …)` 驗證呼叫者確實屬於該公司，符合此原則。
>
> 已完成 RPC 化的表（可當範本）：`leave_requests`（048/053/113/117/119）、`makeup_punch_requests`（085/086）、`overtime_requests`（109/110）、`attendance_anomalies`（092）、`holidays`（118/119）、`payroll`（111）。

### 前端直接讀寫現況（2026-09-04 grep `sb.from('<table>')`）

| 表 | select | 寫入（insert/update/upsert/delete） | 敏感度 | 備註 |
|---|---|---|---|---|
| employees | 14 | 10 | 🔴 個資、角色 | 角色欄位可被改 → 提權 |
| attendance | 4 | 0 | 🔴 考勤 | 寫入已全走 RPC，只剩讀 |
| leave_requests | 7 | 0 | 🔴 | 寫入已全走 RPC，只剩讀 |
| system_settings | 7 | 1 | 🟠 含 LINE token、打卡地點 | `saveSetting` 直寫 |
| companies | 14 | 7 | 🟠 租戶主檔 | |
| schedules | 6 | 6 | 🟠 | 排班可被改 |
| shift_swap_requests | 0 | 5 | 🟠 | |
| requests | 0 | 4 | 🟠 | 雜項申請 |
| insurance_brackets | 2 | 4 | 🟡 | |
| hr_audit_logs | 1 | 1 | 🟡 稽核可被竄改 | |
| platform_admins / platform_admin_companies | 2 | 6 | 🔴 平台管理員 | 提權路徑 |
| lunch_orders | 2 | 6 | 🟢 | |
| field_work_logs / trips / sales_* / clients | ~3 | ~20 | 🟡 業務資料 | |
| store_* / booking_* / orders / menu_* / loyalty_* / service_* | ~40 | ~70 | 🟡 商店端（消費者頁面 anon 使用） | 本來就設計給匿名消費者，需另一套 RLS 思路 |

### 分階段

#### 階段 0：盤點與量測（1 天，唯讀）
- `bash scripts/rls_audit.sh` 產出目前政策清單存檔
- 用上表為每張表標「目標：RPC-only／anon 可讀不可寫／維持公開」
- 補一支 `tests/rls-locked-tables.test.js` 的擴充：前端出現新的直接寫入就 FAIL（現在只擋既有鎖定表）

#### 階段 1：先鎖「寫入」不鎖「讀取」（高風險、低工程量）
對 employees、companies、system_settings、schedules、shift_swap_requests、requests、hr_audit_logs、platform_admins、platform_admin_companies、insurance_brackets：
1. 每張表的寫入路徑改 RPC（employees 的 update 有 7 處，是最大工程；其餘每表 1～6 處）
2. 撤掉 `INSERT/UPDATE/DELETE` 的 `USING(true)` 政策，**保留 SELECT 全開**
3. 效果：外人仍能讀，但不能改角色、改薪資設定、改排班、改稽核紀錄
- 預估：employees 2 天、其餘合計 2 天、驗證 1 天

#### 階段 2：讀取改 RPC（高風險表）
employees、attendance、leave_requests、system_settings、payroll_records、attendance_backup：
- 每頁讀取改成帶 `p_line_user_id` 的 RPC（打卡總覽、薪資頁、員工管理已有大部分 RPC，可重用）
- 撤 SELECT 全開政策
- 預估：3～4 天，需逐頁回歸（CLAUDE.md 修改影響範圍對照表）

#### 階段 3：商店端（消費者匿名頁）
booking / order / loyalty / menu 是給匿名消費者用的，不能要求 LINE 身分。做法：
- 讀：只開「is_active = true 的公開欄位」view，其餘欄位不暴露
- 寫：改 RPC 並加 rate limit／欄位白名單（例如 orders 只能 insert 自己的、不能改 status）
- 預估：3 天

#### 階段 4：收尾
- `attendance_backup`、`binding_attempts` 等純內部表：RLS 開、0 政策
- 換 anon key（舊 key 已公開多時）
- `scripts/qa_check.sh` 第 8 項改為：出現 `USING(true)` 直接 FAIL

### 每階段的驗證方式
- `bash scripts/rls_audit.sh` 前後比對（全開政策條數必須下降）
- 用 anon key 對該表做 curl 寫入 → 必須 401/403 或 0 rows
- `npm test` 全綠＋該表牽涉頁面的手動回歸（對照表在 CLAUDE.md）
- 每階段一支 migration、單一交易、事前備份、業主結構化授權後套用

### 建議順序與原因
1. 階段 1 的 employees **寫入**（提權風險最高、且 role 欄位能被改；只鎖寫入不影響第 4 節提到的登入流程讀取，employees 的**讀取**仍依第 4 節「順序陷阱」放最後）
2. 階段 1 其餘寫入
3. 階段 2 的 employees／attendance／leave_requests 讀取（個資與考勤）
4. 階段 3、4

每完成一張表就在 `docs/BUG_TRACKER.md` 更新那張表的狀態，不必等整個階段結束。
