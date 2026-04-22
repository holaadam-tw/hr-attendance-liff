# 邏輯 / 安全審查報告（Batch 2）

**日期**: 2026-04-22
**範圍**: 非多租戶的邏輯缺陷與安全漏洞（多租戶在 Batch 1 報告）
**方法**: Explore agent 7 類深查 + 關鍵結論親驗 4 項
**用途**: 純審查，**不動 code**（修復需使用者授權）

---

## 📌 Batch 1 補驗：H3 `switchCompanyAdmin` state 殘留 `[高信心]`

**檔案**: `modules/auth.js:303-353`（`switchCompanyAdmin` 全文）

**切公司時有清**：
- `currentCompanyId` / `companyAllowedFeatures`（L308-311）
- `sessionStorage['selectedCompanyId']` 更新（L312）
- `sessionStorage['system_settings_cache']` 移除（L335）
- `loadSettings()` 重載（L336）
- 功能可見性 / admin permissions 重套（L340-344）

**切公司時**未清 `[模組全域變數全漏]`：
- `modules/payroll.js:20-27` 全部：
  - `bonusEmployees`, `bonusPerformance`, `bonusAdjustments`
  - `payrollEmployees`, `payrollAdjustments`, `payrollBrackets`, `payrollIsPublished`

**影響分級**：
- ✅ **不會永久污染 DB**（計算結果不直接寫入 payroll 表，要使用者按「確認發放」）
- ⚠️ **UI 殘影風險**：A 公司算薪資 → 切 B 公司 → **進薪資頁面但還沒點「計算」前** → `renderPayrollSummary/View` 若被呼叫會 render A 公司員工名單
- ⚠️ **調整值殘留**：`bonusAdjustments[empId]` 跨公司殘留 — 若 B 公司剛好有相同 empId（UUID 碰撞極低但非零）→ 誤帶 A 公司調整值
- ⚠️ `admin_fixes.js` 也 grep 到相關變數（未深入，標為觀察項）

**修復方向**（不動手）：
```js
// switchCompanyAdmin 末尾加
if (typeof clearPayrollState === 'function') clearPayrollState();
if (typeof clearBonusState === 'function') clearBonusState();
```
加事件匯流排 `companychange` 事件讓各模組自清更乾淨。

---

## 🔴 嚴重

### S1 — 敏感 RPC 無後端身份驗證（前端權限檢查 ≠ 後端保護）`[高信心]`

**檔案**: `modules/auth.js:64-150`（`checkAdminPermission` 完整）
- L81-85 查 `platform_admins` 表驗證平台管理員身份
- L96-102 載入 `managedCompanies`
- **純前端狀態**：`window.isPlatformAdmin = true` 放 window global

**對比已知的 SECURITY DEFINER RPC**（Batch 1 發現）：
- `get_company_shift_types` / `create_shift_type` / `update_shift_type` / `delete_shift_type` **GRANT anon + 無身份檢查**

**觸發情境**:
1. 攻擊者略過 `admin.html` UI（直接用 Supabase JS SDK 從 console 呼叫 RPC）
2. 不需登入 / 前端權限檢查根本繞過
3. 直接寫入/讀取任何公司的敏感資料

**影響**: 凡是 GRANT anon 且無 `auth.uid() IS NOT NULL` / 無身份對照的 RPC 全部裸奔

**修復方向**:
- 所有敏感 RPC 加開頭：
  ```sql
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'unauthorized'; END IF;
  IF NOT EXISTS (SELECT 1 FROM employees WHERE ... AND is_admin = true) THEN ...;
  ```

---

### S2 — 薪資獎金 `updateAdjustment` 無負數 / 上限 / NULL 檢查 `[高信心]`

**檔案**: `modules/payroll.js:224-230`
```js
export function updateAdjustment(empId, value) {
    const val = parseMoney(value);     // ← 無 val < 0 / val > threshold 檢查
    bonusAdjustments[empId] = val;     // ← 直接存
    ...
}
```

**觸發情境**:
1. 管理員輸入 `-999999` 或 `9999999999` → 直接存 `bonusAdjustments`
2. `calculateBonus()` 用此值計算 → 顯示負數獎金 / 破表數字
3. 按「確認發放」→ 寫入 DB

**影響**:
- 誤發負薪 / 天價薪資
- 若 `base_salary` 為 NULL 且 L95 `baseSalary = salaryMap[emp.id] || 0` → 獎金按 0 算，員工被漏發而不自知

**修復方向**: 加 `if (val < 0 || val > MAX_BONUS) return showToast('超出範圍')`

---

### S3 — 並行打卡 race condition `[推論-中信心]`

**檔案**: `migrations/069_block_kiosk_self_checkin.sql`（quick_check_in 最新版，未親讀完整 EXCEPTION 處理）

**推論**（基於 Agent 引用舊版 032 + UNIQUE constraint 行為）:
1. 員工同時用 2 個裝置點上班
2. 兩個 RPC call 同時進到 `SELECT existing record` → 都查不到
3. 都執行 INSERT → 第二個觸發 UNIQUE(employee_id, date) 衝突
4. 舊版 032 的 EXCEPTION handler 會 **改走 check_out 流程** — 若 timing 不巧，第二個可能錯走 check_out 導致工時異常

**影響**:
- 工時計算錯亂（check_out_time < check_in_time）
- 需實測確認 069 版本的 EXCEPTION 處理是否已改

**修復方向**: PoC test（Batch 4）驗證是否真的觸發；若是，用 `INSERT ... ON CONFLICT DO UPDATE` 明確處理

**親驗狀態**: 未親讀 069 完整 EXCEPTION 段（只看到 234-255 的下班 UPDATE）

---

## 🟠 高

### S4 — Promise.all 只檢查第一個 query 的 error `[高信心]`

**檔案**: `modules/payroll.js:76-82`（`loadHybridBonusData`）
```js
const [empRes, salaryRes, attRes, leaveRes] = await Promise.all([...]);
if (empRes.error) throw empRes.error;   // ← 只檢 empRes
// salaryRes / attRes / leaveRes 的 error 完全忽略
```

**觸發情境**:
- `leaveRes` 因 RLS / 網路失敗 → `.data` 為 undefined → `(leaveRes.data || [])` fallback 空陣列
- `leaveMap = {}` → 獎金計算忽視請假扣分 → **數字錯誤但不顯示「載入失敗」**

**影響**:
- 獎金誤算（漏扣請假）
- 管理員看到看似正常的數字但其實漏資料

**修復方向**: 改 `Promise.allSettled` 或每個 `res` 都 `if (res.error) throw res.error`

---

### S5 — onclick 字串拼接未 escape `[中信心]`

**檔案範例**: 
- `modules/employees.js:171` `onclick="updateEmployeeRoleAdmin('${emp.id}', ..., '${escapeHTML(emp.name)}')"`
- `common.js:1286` `onclick="editLocation(${index})"`, `deleteLocation(${index})`
- `common.js:1709-1715` approveRequest / rejectRequest onclick

**觸發情境**:
- `emp.id` 未 escape（`emp.name` 有）— ID 通常是 UUID **實務安全**，但 pattern 危險
- 若 `emp.id` 來源是使用者可控字串（如 `employee_number` 被誤用）→ 可注入 `x'); alert('xss'); ('`

**影響**:
- 目前實務安全（UUID 固定格式）
- 未來若 schema 改動或有 migration bug 讓 ID 被污染 → XSS

**修復方向**: 統一用 `data-*` attribute + addEventListener，取代 onclick 字串拼接

---

### S6 — 時區邊界 `new Date().toISOString()` `[推論-中信心]`

**檔案**: `common.js:978`（Agent 報告，我未親讀此段）
```js
const now = new Date().toISOString();   // UTC ISO string
// 用於和 DB timestamptz 比較
```

**觸發情境**:
- `announcement.expire_at` = `"2026-04-22 23:59:59+08"` (台灣時間)
- `now.toISOString()` = `"2026-04-22T15:59:59.000Z"` (UTC)
- 字串比較 or 轉 Date 比較：通常安全（toISOString 是 UTC ISO），但若前端再 `new Date(now).toLocaleString()` 無時區參數 → 瀏覽器本地時區顯示

**影響**:
- 跨時區用戶看到的「今天」可能差 8 小時
- 公告到期邏輯邊界差異

**修復方向**: 一律用 `toLocaleString('sv-SE', { timeZone: 'Asia/Taipei' })`

**親驗狀態**: 未親讀 `common.js:978`

---

### S7 — 員工 baseSalary NULL 被當 0 `[高信心]`

**檔案**: `modules/payroll.js:95`
```js
const baseSalary = salaryMap[emp.id] || 0;
```

**情境**: 新員工 `salary_settings` 未建 → `salaryMap[emp.id]` undefined → `|| 0` fallback
- 薪資試算顯示 **全 0 數字**，但使用者可能誤以為「沒問題」
- 缺警告（應顯示「未設薪資」紅色警示）

**影響**: 漏發薪資 / UI 誤導

**修復方向**: 顯式檢查 `if (!salaryMap[emp.id]) return { emp, warning: '未設薪資' }`

---

## 🟡 中

### S8 — `new Date("YYYY-MM-DD")` UTC 陷阱 `[推論]`
建立的 Date 是 UTC 00:00，台灣顯示是早上 8 點。部分查詢邊界日期可能偏移 1 天。
已知 `common.js:78-81` 用 `toLocaleDateString('sv-SE', { timeZone: 'Asia/Taipei' })` 是正確 pattern；需 grep 其他檔確認一致性（本 batch 未做）。

### S9 — onclick 中 `${index}` 數字拼接 `[低]`
`common.js:1286` 等。實務 forEach index 安全，但 pattern 不嚴謹。

### S10 — RECORD NULL 陷阱 `[已解決]`
`migrations/032:52,64,79,170` 等已改 `.id IS NOT NULL`。此類 pattern 未來新 RPC 若違反會觸發問題。

---

## ✅ 本次確認安全的

1. **`escapeHTML()` 使用廣度**: grep >40 處 `escapeHTML(` / `esc(`，用戶輸入（name, title, description）大部分包裝
2. **`quick_check_in` GPS 驗證 + UNIQUE constraint**: 基本設計完整（雖有 S3 race 疑慮）
3. **`platform_admin_companies` 關聯**: `checkAdminPermission` 正確綁定平台管理員 → 可管理公司列表（Batch 1 已驗）

---

## 📋 Batch 2 發現彙總

| # | 代號 | 標題 | 嚴重度 | 覆驗 |
|---|---|---|---|---|
| H3 補 | — | switchCompanyAdmin 未清 payroll/bonus 全域 | 🟠 已確認 | ✅ 親驗 |
| 1 | S1 | 敏感 RPC 無後端身份驗證 | 🔴 | ✅ 親驗 |
| 2 | S2 | updateAdjustment 無負數/上限 | 🔴 | ✅ 親驗 |
| 3 | S3 | 並行打卡 race | 🔴 (推論) | ⏳ 待 PoC |
| 4 | S4 | Promise.all 只檢第一個 error | 🟠 | ✅ 親驗 |
| 5 | S5 | onclick 字串拼接未統一 escape | 🟠 中信心 | ⏳ 部分 |
| 6 | S6 | toISOString 時區邊界 | 🟠 推論 | ⏳ 未親驗 |
| 7 | S7 | baseSalary NULL 當 0 漏警告 | 🟠 | ✅ 親驗 |
| 8 | S8 | new Date() UTC 00:00 陷阱 | 🟡 | ⏳ |
| 9 | S9 | onclick index 拼接 | 🟡 低 | ✅ |
| 10 | S10 | RECORD NULL | 🟢 已解決 | ✅ |

---

## 🎯 Batch 3 要彙整的決策點

與 Batch 1 (H1/H2/H3/H4/M1/M2/L1) 合併排序。最優先 4 項：
1. **Batch 1 H2** shift_types RPC 裸 GRANT anon（4 支 RPC 都沒身份檢查）
2. **Batch 2 S1** 所有敏感 RPC 無後端身份驗證（S1 是 H2 的一般化版）
3. **Batch 2 S2** updateAdjustment 無輸入驗證
4. **Batch 2 S4** Promise.all silent 漏資料

### Batch 4 可 PoC 的有：
- S3 並行打卡 race（需開 2 個連線模擬）
- S1/H2 anon 呼叫敏感 RPC（純 curl + supabase anon key 即可）
- S2 updateAdjustment 負數（純前端 demo）

**本報告由 Explore agent 7 類查詢 + 4 項親驗產出；未親驗的項目明確標記**。
