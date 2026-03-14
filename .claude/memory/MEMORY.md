# RunPiston HR 系統 - 開發記憶

## 專案架構
- 純前端靜態站：GitHub Pages + Supabase + LINE LIFF
- 根目錄：`D:\hr-attendance-liff-main\hr-attendance-liff-main\`
- Git remote: `https://github.com/holaadam-tw/hr-attendance-liff.git` (main branch)
- 部署：push to main → GitHub Pages 自動部署（1-2 分鐘）

## 核心規則
- 多租戶：所有查詢必須 `.eq('company_id', window.currentCompanyId)`
- 設定存取：用 `saveSetting(key, value, description)` — 先查再更新
- 全域變數必須掛 `window.`（跨檔案共用），但 common.js 頂層用 `let` 宣告的變數（currentCompanyId 等）不會自動掛到 window，同檔案內直接用變數名存取
- system_settings 的 company_id 是 NOT NULL
- 快取：修改設定後 `invalidateSettingsCache()` + `loadSettings(true)`

## 角色權限
- platform_admin > admin > manager > user
- 薪酬密碼鎖僅 platform_admin 可見
- `checkIsAdmin()` 在 viewAsEmployee 時返回 false

## 功能開關架構（2026-03-11 更新）
- DEFAULT_FEATURES（common.js）：leave/attendance/salary/requests=true，其餘=false
- 功能 key 清單：leave, attendance, salary, requests, lunch, fieldwork, sales_target, store_ordering, booking, booking_service, loyalty
- platform.html：FEATURE_LIST 10 項（不含 sales_target，儲存時自動跟隨 fieldwork）
- platform.html：FEATURE_DEFAULTS + FEATURE_PRESETS（general/catering/service/all）
- index.html menu-grid 10 格：leave, attendance, salary, lunch, fieldwork+sales_target, store_ordering, requests, booking, booking_service, admin-only
- fieldwork.html：外勤打卡 + 業務週報 + 客戶管理（三 tab），從 services.html 獨立出來
- services.html：僅保留便當訂購 + 系統設定，舊 #fieldwork/#sales hash 自動重導 fieldwork.html
- clients 資料表：需執行 016_clients_add_employee_company.sql 加 employee_id/company_id
- booking 格子已加入 index.html（連結 admin.html#booking）；loyalty 格子尚未加入（待功能完成）
- admin.html hash 路由：HASH_PAGE_MAP（auth.js）支援 #booking, #restaurant 等直接跳轉
- EMPLOYEE_ALLOWED_HASHES（auth.js）：一般員工可透過 hash 存取的 admin 頁面（目前僅 booking）
- 預約系統名稱統一為「預約系統（餐飲業）」（index.html + admin.html）
- 服務業預約系統：booking_service.html（消費者，URL ?store=company_id，不需登入）+ booking_service_admin.html（後台，LIFF 認證）
- 服務業預約資料表：staff_profiles, service_items, service_time_slots, service_bookings（018_booking_service.sql）
- booking_service_admin.html：一般員工只看自己預約+隱藏管理tab，admin看全部
- 三層 AND 邏輯：DEFAULT_FEATURES × INDUSTRY_TEMPLATES × companies.features × feature_visibility
- `INDUSTRY_TEMPLATES` 保留在 settings.js（common.js getFeatureVisibility 需要）
- index.html 業主視角：格子上有 toggle switch，控制第二層 feature_visibility（saveSetting）
- platform.html：控制第一層 companies.features
- 底部導航已完全移除（initBottomNav 空殼、ALL_NAV_ITEMS 已刪、CSS 已清、所有頁面呼叫已刪）

## 員工視角 (viewAsEmployee)
- `toggleViewMode()` 切換時：隱藏 toggle 開關、管理後台入口
- 業主視角：顯示第一層允許的所有格子（含 toggle OFF 的），toggle 控制第二層
- 員工視角：兩層都 true 才顯示，無 toggle
- feature_visibility（第二層）預設全 true，業主只能關不能開

## 重要 Bug 紀錄
- loadSettings() 必須在 currentCompanyId 和 currentCompanyFeatures 設定完成後才呼叫，否則因 companyId 為空直接 return，導致 _settingsCache 為空，feature_visibility 讀不到
- feature_visibility 不應寫入 sessionStorage 快取，必須每次從 DB 讀取，確保跨裝置即時同步

## 關鍵檔案路徑
- [專案指南](../../hr-attendance-liff-main/PROJECT_GUIDE.md)
- [詳細架構筆記](./architecture.md)
