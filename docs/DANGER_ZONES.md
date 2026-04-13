# 高風險區域（修改前必讀）

> 以下區域修改前必須充分理解影響範圍，並做完整 logic walkthrough。

---

## 🔴 絕對不可做的事

| 項目 | 原因 |
|------|------|
| attendance 表 DELETE | 軟刪除，歷史記錄必須保留 |
| employees 表 DELETE | 軟刪除（status=resigned），薪資/考勤歷史依賴 |
| migrations 已執行的 SQL 修改 | 已在 Supabase 執行過的不可回溯，只能新增 migration 修正 |
| LIFF endpoint URL 變更 | LINE 平台設定綁定，改了全部 QR Code / Rich Menu 失效 |
| CONFIG.LIFF_ID 變更 | 同上，所有 LIFF 頁面失效 |
| Supabase URL / ANON_KEY 變更 | 全部前端頁面失效 |

---

## 🟡 高風險函數（修改需額外小心）

### common.js
| 函數 | 風險 | 影響範圍 |
|------|------|---------|
| `initializeLiff()` | 所有頁面入口 | 全部 LIFF 頁面（index/checkin/records/admin/...） |
| `checkUserStatus()` | 員工身份驗證 | 所有需要登入的頁面 |
| `loadSettings()` | 快取邏輯複雜 | 功能開關、系統設定讀取 |
| `getCachedSetting()` | 依賴 loadSettings | 所有讀設定的地方 |
| `saveSetting()` | 先查再更新 | 所有寫設定的地方 |
| `getFeatureVisibility()` | 三層 AND 邏輯 | index.html 格子顯示 |

### modules/payroll.js
| 函數 | 風險 | 影響範圍 |
|------|------|---------|
| `calcEmployeePayroll()` | 薪資計算核心 | 月薪/日薪/時薪計算、扣款、津貼 |
| `loadPayrollData()` | 多表 JOIN | 員工+薪資設定+考勤+請假+加班 |

### modules/auth.js
| 函數 | 風險 | 影響範圍 |
|------|------|---------|
| `checkAdminPermission()` | 權限驗證 | admin.html 入口 |
| `HASH_PAGE_MAP` | 路由表 | admin.html 頁面跳轉 |

### SQL RPC
| RPC | 風險 | 影響範圍 |
|-----|------|---------|
| `quick_check_in()` | 打卡核心 | 上下班打卡、遲到/早退判定、GPS 驗證 |
| `get_monthly_attendance()` | RLS 繞過 | 考勤月曆顯示 |
| `get_company_daily_attendance()` | 打卡總覽 | attendance_overview + attendance_public |
| `get_company_monthly_attendance()` | 月度統計 | 同上 |

---

## 🟡 高風險資料表

| 表 | 風險 | 注意 |
|----|------|------|
| employees | 多處 JOIN | company_id 多租戶隔離、status CHECK 約束 |
| attendance | UNIQUE(employee_id, date) | 每人每天只能一筆 |
| system_settings | company_id NOT NULL | 必須帶 company_id |
| payroll | is_published 控制員工可見 | 發布後不可隨意刪除 |
| salary_settings | is_current 標記 | 更新時先把舊的設 false |

---

## 🟡 常見陷阱

| 陷阱 | 說明 |
|------|------|
| `toISOString()` 會轉 UTC | 台灣 UTC+8 日期會偏移，日期比較用字串 |
| `new Date("YYYY-MM-DD")` 是 UTC 00:00 | 與本地時間比較會誤判「今天」 |
| `.maybeSingle()` 回傳 PromiseLike | 不能直接 `.catch()`，需 try/catch |
| `RECORD IS NOT NULL` | PostgreSQL 要求所有欄位非 NULL，用 `.id IS NOT NULL` |
| `SELECT *` 改指定欄位 | 必須 grep 所有消費端確認每個欄位都有列出 |
| `sessionStorage` 快取 | 需手動清除，跨頁面可能帶殘值 |
| 勞退自提存 TIMESTAMPTZ | 用 `now()` 不能用 `now() AT TIME ZONE` |
| **新查詢必須有 company_id** | 每個 `sb.from()` 查詢都必須帶 `.eq('company_id', window.currentCompanyId)` 或透過 `employees!inner(company_id)` 間接隔離。左 join `employees(...)` 無法做隔離，必須用 `employees!inner(...)` |
