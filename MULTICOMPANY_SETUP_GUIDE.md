# 🏢 多公司管理架構 - 驗證與設定指南

**檢查日期**: 2026-02-20
**執行者**: Claude Sonnet 4.5
**狀態**: 程式碼 100% 完成 ✅ | 資料設定待執行 ⏳

---

## 📊 重要發現：程式碼已完全實作！

經過完整程式碼檢查，**多公司管理架構已經完全實作完成**，無需任何程式碼修改。

### ✅ 已實作功能清單

| 功能 | 檔案位置 | 狀態 |
|------|---------|------|
| 資料庫架構 | `migrations/012_platform_admin_companies.sql` | ✅ 已存在 |
| 平台管理員認證 | `common.js:177-288` | ✅ 已實作 |
| 管理後台認證 | `modules/auth.js:47-198` | ✅ 已實作 |
| 公司切換器 UI | `modules/auth.js:218-293` | ✅ 已實作 |
| 商店切換器 | `modules/store.js:18-43,87-123` | ✅ 已實作 |
| 功能可見性系統 | `common.js:1264-1318` | ✅ 已實作 |

---

## 🎯 設定步驟 (僅需資料設定，無需改程式碼)

### 📋 前置準備

1. **取得 Adam 的 LINE User ID**
   - 方式 1: 請 Adam 在系統中登入一次，查詢 `employees` 表的 `line_user_id`
   - 方式 2: 使用 LINE Developers Console 查詢

2. **準備公司清單**
   - 登入 Supabase Dashboard
   - 執行查詢: `SELECT id, code, name, industry FROM companies;`
   - 記錄所有公司的 `code` (代碼) 或 `id`

---

### 步驟 1️⃣: 驗證 Migration 012 已執行

**在 Supabase SQL Editor 執行**:

```sql
-- 檢查 platform_admin_companies 表是否存在
SELECT table_name
FROM information_schema.tables
WHERE table_name = 'platform_admin_companies';
```

**預期結果**:
- 有回傳 1 筆資料 → ✅ Migration 已執行
- 無資料 → ❌ 需要執行 migration 012

**如果表不存在，執行以下步驟**:

1. 打開檔案: `migrations/012_platform_admin_companies.sql`
2. 複製整個檔案內容
3. 在 Supabase SQL Editor 貼上並執行
4. 確認成功訊息

---

### 步驟 2️⃣: 設定 Adam 的平台管理員權限

**使用提供的設定腳本**:

1. 打開檔案: [`setup-adam-multicompany.sql`](./setup-adam-multicompany.sql)
2. 修改以下內容:

**⚠️ 必須修改的地方** (共 4 處):

```sql
-- (1) 修改 Adam 的 LINE User ID (第 15, 21, 30, 46, 79, 105 行)
'YOUR_LINE_USER_ID_HERE' → 'Adam的實際LINE_USER_ID'

-- (2) 修改擁有的公司代碼 (第 34-37 行)
WHERE c.code IN (
    'COMPANY_A',  -- 改為實際代碼，例如 'DZ001'
    'COMPANY_B',  -- 改為實際代碼，例如 'BENMI'
    'COMPANY_C',
    'COMPANY_D'
)

-- (3) 修改代管的公司代碼 (第 48-51 行)
WHERE c.code IN (
    'COMPANY_E',  -- Amy 的公司
    'COMPANY_F'
)

-- (4) 修改製造業/餐飲業公司代碼 (第 75, 100 行)
```

3. 在 Supabase SQL Editor 執行修改後的腳本
4. 檢查最後的驗證結果

---

### 步驟 3️⃣: 執行完整驗證

**使用驗證腳本**:

1. 打開檔案: [`verify-multicompany.sql`](./verify-multicompany.sql)
2. 在 Supabase SQL Editor 執行整個腳本
3. 檢查輸出結果:

**預期輸出**:

```
===== Step 1: 檢查 Migration 012 =====
✅ platform_admin_companies 表已存在

===== Step 2: 平台管理員清單 =====
[顯示 Adam 的記錄]

===== Step 3: 公司清單 =====
[顯示所有公司及其功能設定]

===== Step 4: 平台管理員 ↔ 公司連結 =====
[顯示 Adam 連結到的所有公司]

===== Step 5: 統計摘要 =====
平台管理員 (活躍): 1
公司 (活躍): 6
管理員↔公司連結數: 6

===== Step 6: 各公司的功能設定 =====
[顯示每個公司啟用的功能]
```

---

### 步驟 4️⃣: 前端測試

**4.1 測試公司切換器**

1. 使用 Adam 的 LINE 帳號登入系統
2. 訪問 [admin.html](https://holaadam-tw.github.io/admin.html)
3. 檢查 user-card 區域是否出現公司下拉選單
4. 切換公司 → 觀察功能選單是否自動更新

**預期行為**:
- ✅ 看到公司下拉選單 (如果管理 2+ 公司)
- ✅ 下拉選單顯示所有公司名稱
- ✅ 代管公司標註 "(代管)"
- ✅ 切換後功能選單立即更新

**4.2 測試功能可見性**

切換到不同類型的公司，確認功能選單正確顯示:

| 公司類型 | 應顯示的功能 |
|---------|-------------|
| 製造業 | 請假、考勤、排班、薪資、便當訂購、外勤/業務 |
| 餐飲業 | 請假、考勤、排班、薪資、餐飲業管理、預約管理、會員管理 |
| 一般公司 | 僅顯示基本 HR 功能 (請假、考勤、排班、薪資) |

**4.3 測試餐飲業商店管理**

1. 切換到餐飲業公司 (industry = 'restaurant')
2. 點擊「餐飲業管理」
3. **應自動跳到商店詳情頁** (不顯示商店列表)
4. 如果有多個商店 → 頂部應顯示商店下拉選單
5. 點擊「返回」→ 應回到 adminHomePage (不是商店列表)

**預期行為**:
- ✅ 平台管理員直接進入第一個商店的詳情頁
- ✅ 頂部出現商店切換器 (多店時)
- ✅ 可切換商店
- ✅ 返回按鈕回到管理首頁

**4.4 測試 SessionStorage 持久化**

1. 選擇公司 A
2. 跳轉到其他頁面 (例如 index.html)
3. 回到 admin.html
4. **應自動恢復公司 A** (不需重新選擇)

**預期行為**:
- ✅ 重新載入頁面時記住最後選擇的公司
- ✅ 關閉分頁後重開 → 重置 (從第一間公司開始)

---

## 🔍 驗證 Checklist

執行完所有步驟後，請確認以下項目:

- [ ] `platform_admin_companies` 表已存在於資料庫
- [ ] Adam 已在 `platform_admins` 表中 (is_active = true)
- [ ] Adam 已連結到所有目標公司 (檢查 `platform_admin_companies` 表)
- [ ] 各公司的 `features` JSONB 已正確設定
- [ ] 各公司的 `industry` 已正確設定
- [ ] Admin 後台顯示公司切換器
- [ ] 切換公司後功能選單自動更新 (實時測試)
- [ ] 製造業公司顯示「外勤/業務」、「便當訂購」
- [ ] 餐飲業公司顯示「餐飲業管理」、「會員管理」、「預約管理」
- [ ] 餐飲業自動跳到商店詳情 (跳過商店列表)
- [ ] 商店切換器正常運作 (多店時)
- [ ] SessionStorage 記住最後選擇的公司 (頁面跳轉測試)

---

## 📁 相關檔案

| 檔案 | 用途 |
|------|------|
| [migrations/012_platform_admin_companies.sql](./migrations/012_platform_admin_companies.sql) | Migration 腳本 (建立表) |
| [verify-multicompany.sql](./verify-multicompany.sql) | 資料庫狀態驗證腳本 |
| [setup-adam-multicompany.sql](./setup-adam-multicompany.sql) | Adam 權限設定腳本 (需修改) |
| [MULTICOMPANY_SETUP_GUIDE.md](./MULTICOMPANY_SETUP_GUIDE.md) | 本檔案 (設定指南) |

---

## 🏗️ 架構說明

### 資料庫架構

```
platform_admins
  ├── id (UUID, PK)
  ├── line_user_id (TEXT, UNIQUE)
  ├── name (TEXT)
  ├── role (TEXT) = 'platform_admin'
  └── is_active (BOOLEAN)

platform_admin_companies (連結表)
  ├── id (UUID, PK)
  ├── platform_admin_id (FK → platform_admins)
  ├── company_id (FK → companies)
  ├── role (TEXT) = 'owner' | 'manager'
  └── created_at (TIMESTAMPTZ)
  └── UNIQUE(platform_admin_id, company_id)

companies
  ├── id (UUID, PK)
  ├── code (TEXT, UNIQUE)
  ├── name (TEXT)
  ├── industry (VARCHAR) = 'general' | 'manufacturing' | 'restaurant'
  ├── status (TEXT) = 'active' | 'pending' | 'suspended'
  ├── features (JSONB) ← 功能開關
  └── ...
```

### 認證流程

```
1. 使用者以 LINE 登入 (liff.init)
   ↓
2. checkUserStatus() (common.js)
   ↓
   ├─ 檢查 platform_admins (line_user_id = ?)
   │  ↓ 找到
   │  ├─ 載入 platform_admin_companies (JOIN companies)
   │  ├─ 設定 isPlatformAdmin = true
   │  ├─ 設定 managedCompanies = [...]
   │  └─ 從 sessionStorage 恢復上次選擇的公司
   │
   └─ 沒找到 → 檢查 employees (line_user_id = ?)
      ↓ 找到
      └─ 一般員工流程 (單一公司)
```

### 功能可見性 (3 層 AND 邏輯)

```
Layer 0: Industry Template (INDUSTRY_TEMPLATES)
  ↓ AND
Layer 1: Platform Features (companies.features JSONB)
  ↓ AND
Layer 2: Company Admin Settings (system_settings.feature_visibility)
  ↓
最終功能狀態
```

---

## ❓ 常見問題

### Q1: 如何取得 Adam 的 LINE User ID?

**A**: 兩種方式:
1. 請 Adam 登入系統一次，執行查詢:
   ```sql
   SELECT line_user_id FROM employees WHERE name LIKE '%Adam%';
   ```
2. 使用 LINE Developers Console → Your Channel → Messaging API → User ID

### Q2: 公司切換器沒有出現?

**A**: 檢查以下條件:
- `isPlatformAdmin === true` (檢查 console)
- `managedCompanies.length > 1` (至少 2 間公司)
- `#adminCompanyName` 元素存在於 admin.html

### Q3: owner 和 manager 的差別?

**A**:
- **owner**: 可修改公司的 `features` 設定 (在 platform.html)
- **manager**: 只能在已開放的功能範圍內操作，無法修改功能設定
- 兩者都可以管理公司資料、員工、訂單等

### Q4: 如何新增更多公司給 Adam?

**A**: 執行 SQL:
```sql
INSERT INTO platform_admin_companies (platform_admin_id, company_id, role)
VALUES (
    (SELECT id FROM platform_admins WHERE line_user_id = 'Adam的LINE_ID'),
    '新公司的UUID',
    'owner'
)
ON CONFLICT DO NOTHING;
```

### Q5: 如何修改公司的功能設定?

**A**: 更新 `companies.features`:
```sql
UPDATE companies
SET features = jsonb_set(features, '{store_ordering}', 'true')
WHERE code = 'COMPANY_A';
```

---

## 🎉 完成後的系統行為

設定完成後，Adam 登入系統時的體驗:

1. **登入** → 系統自動識別為平台管理員
2. **首頁** (index.html) → 顯示當前公司名稱 + 該公司啟用的功能
3. **管理後台** (admin.html) → 顯示公司切換器 (下拉選單)
4. **切換公司** → 功能選單立即更新，無需重新載入
5. **餐飲業公司** → 點「餐飲業管理」直接進入商店詳情
6. **多個商店** → 顯示商店切換器 (下拉選單)
7. **頁面跳轉** → 記住當前選擇的公司 (sessionStorage)

---

**設定完成日期**: _____________
**執行者**: _____________
**驗證結果**: ☐ 全部通過 ☐ 部分問題 (請記錄於下方)

**問題記錄**:
-
-
-
