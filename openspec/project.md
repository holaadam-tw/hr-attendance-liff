# RunPiston - HR & 餐飲多合一管理系統

## 專案概述

RunPiston 是一套多租戶 HR 考勤與餐飲管理系統，以純前端靜態站架構（無後端伺服器）搭配 Supabase 作為 BaaS，透過 LINE LIFF 做員工身份認證，部署於 GitHub Pages。

---

## 技術棧

| 層級 | 技術 | 版本/備註 |
|------|------|----------|
| 前端框架 | Vanilla JavaScript (ES6 Modules) | 無框架，原生 HTML/CSS/JS |
| 樣式 | CSS3 + CSS Variables | style.css (24 KB)，響應式設計 |
| 資料庫 | Supabase (PostgreSQL) | @supabase/supabase-js@2，含 RLS |
| 身份認證 | LINE LIFF SDK | edge/2/sdk.js |
| 圖表 | Chart.js | @4 |
| QR Code | qrcodejs | 1.0.0 |
| 字體 | Google Noto Sans TC | 中文字體 |
| 測試 | Puppeteer | @24.37.5 (E2E) |
| 部署 | GitHub Pages | main 分支自動部署 |
| Edge Functions | Supabase Functions | line-push, line-webhook |

---

## 架構設計

### 整體架構

```
使用者 (LINE App / 瀏覽器)
    │
    ├─ 員工頁面 ──→ LINE LIFF 認證 ──→ common.js ──→ Supabase
    ├─ 管理後台 ──→ LINE OAuth 認證 ──→ common.js ──→ Supabase
    └─ 消費者頁面 ─→ 無需登入 / LINE 登入 ──────────→ Supabase
```

### 頁面分類

| 分類 | 頁面 | 認證方式 |
|------|------|---------|
| 員工頁面 | index.html, checkin.html, records.html, salary.html, schedule.html, services.html, fieldwork.html, requests.html | LINE LIFF (須從 LINE 開啟) |
| 管理後台 | admin.html, platform.html, booking_service_admin.html, loyalty_admin.html | LINE OAuth (瀏覽器可開) |
| 消費者頁面 | booking.html, booking_service.html, order.html, loyalty.html, register.html | 無需登入 / URL 參數識別店家 |
| 輔助頁面 | kds.html (廚房顯示) | 獨立 Supabase 連線 |

### 多租戶架構

三層 AND 邏輯控制功能可見性：
1. **產業模板** (`INDUSTRY_TEMPLATES`)：general / manufacturing / restaurant / service / clinic / retail
2. **公司功能** (`companies.features` JSONB)：platform.html 控制
3. **管理員覆蓋** (`system_settings.feature_visibility`)：index.html 業主開關

### 角色權限

```
platform_admin > admin > manager > user
```

- `platform_admin`：可管理多家公司、切換公司、看薪酬密碼鎖
- `admin`：公司管理員，管理員工、排班、審核
- `manager`：主管，可審核假單
- `user`：一般員工

### 全域變數（common.js）

```javascript
window.currentCompanyId       // 當前公司 ID (UUID)
window.currentCompanyFeatures // 公司功能設定 (JSON)
window.currentCompanyName     // 公司名稱
window.currentCompanyIndustry // 產業別
window.isPlatformAdmin        // 是否為平台管理員
window.currentEmployee        // 當前員工物件
window.liffProfile            // LINE 使用者資料
window.sb                     // Supabase client
```

---

## 目錄結構

```
hr-attendance-liff-git/
├── CLAUDE.md                     # Claude Code 開發規則
├── PROJECT_GUIDE.md              # 架構指南 (30 KB)
├── README.md                     # 專案說明
├── DEPLOYMENT.md                 # 年終獎金部署指南
├── MULTICOMPANY_SETUP_GUIDE.md   # 多公司設定指南
├── package.json                  # npm 設定 (puppeteer)
│
├── common.js                     # 核心共用模組 (95 KB)
├── admin_fixes.js                # 歷史修復
├── style.css                     # 全域樣式 (24 KB)
│
├── modules/                      # ES6 模組
│   ├── index.js                  # 模組聚合器，綁定至 window
│   ├── auth.js                   # 登入/權限/頁面路由 (17 KB)
│   ├── employees.js              # 員工 CRUD / 部門 / 薪資設定 (15 KB)
│   ├── audit.js                  # 稽核紀錄 / 報表匯出 (11 KB)
│   ├── leave.js                  # 假勤審核 / 排班 / 便當 (31 KB)
│   ├── payroll.js                # 年終獎金 / 薪資發放 (55 KB)
│   ├── schedules.js              # 班表管理 / 補打卡 / 加班 (28 KB)
│   ├── settings.js               # 功能開關 / 公告 / 外勤稽核 (42 KB)
│   └── store.js                  # 餐飲管理 / 菜單 / 訂單 / 訂位 (193 KB)
│
├── scripts/
│   └── qa_check.sh               # QA 自動檢查 (commit 前必執行)
│
├── migrations/                   # Supabase SQL migrations (33 檔)
│   ├── 001_initial_schema.sql    # 核心表
│   ├── 002_rls_policies.sql      # RLS 安全策略
│   ├── 003_seed_data.sql         # 種子資料
│   └── 004-033_*.sql             # 增量功能
│
├── openspec/                     # OpenSpec SDD
│   ├── project.md                # 本檔案
│   ├── specs/                    # 規格文件
│   └── changes/                  # 變更提案
│       └── archive/              # 已歸檔變更
│
├── .claude/                      # Claude Code 設定
│   ├── memory/                   # 開發記憶
│   ├── skills/                   # OpenSpec 技能
│   └── commands/                 # OpenSpec 指令
│
│── HTML 頁面 (18 檔)
│   ├── index.html                # 員工首頁
│   ├── admin.html                # 管理後台 (141 KB)
│   ├── checkin.html              # 打卡頁面
│   ├── records.html              # 出勤紀錄
│   ├── salary.html               # 薪資查詢
│   ├── schedule.html             # 排班表
│   ├── services.html             # 便當訂購 / 系統設定
│   ├── fieldwork.html            # 外勤打卡 / 業務週報 / 客戶管理
│   ├── requests.html             # 報修 / 採購申請
│   ├── platform.html             # 平台管理
│   ├── booking.html              # 餐飲訂位 (消費者)
│   ├── booking_service.html      # 服務預約 (消費者)
│   ├── booking_service_admin.html# 服務預約後台
│   ├── order.html                # 線上點餐 (消費者)
│   ├── kds.html                  # 廚房顯示系統
│   ├── loyalty.html              # 集點查詢 (消費者)
│   ├── loyalty_admin.html        # 集點後台
│   └── register.html             # 公開註冊
│
└── 輔助腳本
    ├── e2e-test.js               # E2E 測試
    ├── health-check-v4.js        # 健康檢查
    └── *.sql                     # 各種 SQL 設定腳本
```

---

## 資料庫結構

### 核心 HR (10 張表)

| 表名 | 用途 | 關鍵欄位 |
|------|------|---------|
| `companies` | 公司/租戶 | id, code, name, industry, features(JSONB), is_active |
| `employees` | 員工主檔 | id, line_user_id, company_id, role, department, is_admin |
| `attendance` | 打卡紀錄 | employee_id, date, check_in_time, check_out_time, latitude, longitude |
| `attendance_records` | 出勤紀錄(新) | employee_id, company_id, date, status, work_hours |
| `shift_types` | 班別定義 | code, name, start_time, end_time, is_overnight |
| `schedules` | 排班表 | employee_id, date, shift_type_id, is_off_day |
| `office_locations` | 辦公地點 | company_id, latitude, longitude, radius |
| `lunch_orders` | 便當訂購 | employee_id, order_date, is_vegetarian |
| `system_settings` | 系統設定 | company_id(NOT NULL), key, value(JSONB) |
| `platform_admins` | 平台管理員 | line_user_id, role, is_active |

### 假勤審核 (4 張表)

| 表名 | 用途 | 關鍵欄位 |
|------|------|---------|
| `leave_requests` | 請假單 | employee_id, leave_type, start_date, end_date, status |
| `makeup_punch_requests` | 補打卡 | employee_id, punch_date, punch_type, status |
| `overtime_requests` | 加班申請 | employee_id, ot_date, hours, compensation_type, status |
| `shift_swap_requests` | 換班申請 | requester_id, target_id, swap_date, status |

### 薪資 (5 張表)

| 表名 | 用途 | 關鍵欄位 |
|------|------|---------|
| `salary_settings` | 薪資設定 | employee_id, salary_type, base_salary, is_current |
| `payroll` | 薪資單 | employee_id, year, month, net_salary, is_published |
| `payroll_records` | 薪資紀錄(新) | employee_id, company_id, period_start, net_salary |
| `annual_bonus` | 年終獎金 | employee_id, year, total_score, final_bonus, status |
| `insurance_brackets` | 勞健保級距 | salary_min, salary_max, insured_amount |

### 餐飲管理 (5 張表)

| 表名 | 用途 | 關鍵欄位 |
|------|------|---------|
| `store_profiles` | 店家資料 | company_id, store_name, store_slug, store_type |
| `menu_categories` | 菜單分類 | store_id, name, sort_order |
| `menu_items` | 菜單品項 | store_id, category_id, name, price, options(JSONB) |
| `orders` | 訂單 | store_id, order_number, items(JSONB), status |
| `store_customers` | 顧客資料 | store_id, phone, total_orders, total_spent |

### 集點系統 (5 張表)

| 表名 | 用途 | 關鍵欄位 |
|------|------|---------|
| `loyalty_members` | 會員 | company_id, phone, line_user_id, total_points |
| `loyalty_transactions` | 點數交易 | member_id, type, points, source |
| `loyalty_rewards` | 兌換獎品 | company_id, name, points_required |
| `loyalty_settings` | 集點設定 | company_id, points_per_amount, welcome_points |
| `loyalty_redemptions` | 兌換紀錄 | member_id, reward_id, redeemed_at |

### 預約系統 (4 張表)

| 表名 | 用途 | 關鍵欄位 |
|------|------|---------|
| `bookings` | 餐飲訂位 | store_id, booking_date, party_size, status |
| `service_bookings` | 服務預約 | company_id, employee_id, service_item_id, status |
| `service_items` | 服務項目 | company_id, name, price, duration_minutes |
| `service_time_slots` | 時段設定 | company_id, slot_time, max_concurrent |

### 外勤/業務 (4 張表)

| 表名 | 用途 | 關鍵欄位 |
|------|------|---------|
| `clients` | 客戶管理 | company_name, employee_id, company_id |
| `field_work_logs` | 外勤紀錄 | employee_id, client_id, arrive_time, work_content |
| `sales_targets` | 業務目標 | employee_id, week_start, call_target, visit_target |
| `sales_activities` | 業務活動 | employee_id, activity_type, client_id, result |

### 稽核/安全 (6 張表)

| 表名 | 用途 | 關鍵欄位 |
|------|------|---------|
| `hr_audit_logs` | HR 操作紀錄 | actor_id, action, target_table, details(JSONB) |
| `audit_logs` | 通用稽核 | company_id, user_id, action, entity_type |
| `binding_attempts` | 綁定嘗試 | line_user_id, employee_id, success |
| `binding_audit_log` | 綁定稽核 | employee_id, line_user_id, action |
| `verification_codes` | 驗證碼 | employee_id, code, expires_at, used |
| `error_logs` | 錯誤監控 | message, page, line, user_id, user_agent |

**總計：約 49 張資料表**

---

## 開發慣例

### Git 工作流程

- **開發分支**：`dev`（所有修改先在此進行）
- **正式分支**：`main`（GitHub Pages 部署來源）
- **推送指令**：`git push origin dev` → 測好後合併 → `git push origin main`
- **Commit 前必做**：`bash scripts/qa_check.sh`

### 程式碼風格

- **全域變數**：跨檔案共用必須掛 `window.`
- **模組系統**：ES6 import/export，透過 `modules/index.js` 綁定至 `window`
- **Supabase 查詢**：所有查詢必須 `.eq('company_id', window.currentCompanyId)` 確保多租戶隔離
- **設定存取**：使用 `saveSetting(key, value, description)`（先查再更新）+ `invalidateSettingsCache()`
- **時區處理**：所有 `toLocaleTimeString` / `toLocaleString` 必須加 `timeZone: 'Asia/Taipei'`
- **消費者頁面**：不可引用 LIFF SDK（order.html, booking.html 等）
- **變數命名**：camelCase，常數 UPPER_SNAKE_CASE

### QA 自動檢查項目

1. 全域變數衝突（HTML vs common.js）
2. `maybeSingle().catch()` 陷阱
3. 時區問題（缺少 `timeZone: 'Asia/Taipei'`）
4. `getHours/getMinutes` 用於 DB 時間
5. 多租戶隔離（查詢缺 `company_id`）
6. 子頁面返回按鍵
7. 消費者頁面不應有 LIFF

### 回歸測試規則

| 修改檔案 | 必須測試的頁面 |
|---------|--------------|
| common.js | 所有頁面 |
| modules/auth.js | admin.html, platform.html, index.html |
| modules/store.js | booking.html, booking_service.html, order.html |
| modules/leave.js | records.html, services.html |
| modules/payroll.js | salary.html, admin.html |

### 已知公司資料

| 公司 | company_id |
|------|-----------|
| 本米 | fb1f6b5f |
| 大正科技機械 | 8a669e2c |
