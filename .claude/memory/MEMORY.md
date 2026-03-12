# RunPiston HR 系統 - 開發記憶

## 專案架構
- 純前端靜態站：GitHub Pages + Supabase + LINE LIFF
- 根目錄：`D:\hr-attendance-liff-main\hr-attendance-liff-main\`
- Git remote: `https://github.com/holaadam-tw/hr-attendance-liff.git` (main branch)
- 部署：push to main → GitHub Pages 自動部署（1-2 分鐘）

## 核心規則
- 多租戶：所有查詢必須 `.eq('company_id', window.currentCompanyId)`
- 設定存取：用 `saveSetting(key, value, description)` — 先查再更新
- 全域變數必須掛 `window.`（跨檔案共用）
- system_settings 的 company_id 是 NOT NULL
- 快取：修改設定後 `invalidateSettingsCache()` + `loadSettings(true)`

## 角色權限
- platform_admin > admin > manager > user
- 薪酬密碼鎖僅 platform_admin 可見
- `checkIsAdmin()` 在 viewAsEmployee 時返回 false

## 功能開關架構（2026-03-11 更新）
- DEFAULT_FEATURES（common.js）：leave/attendance/salary=true，其餘=false
- 功能 key 清單：leave, attendance, salary, lunch, fieldwork, sales_target, store_ordering, booking, loyalty
- platform.html：FEATURE_LIST 8 項（不含 sales_target，儲存時自動跟隨 fieldwork）
- platform.html：FEATURE_DEFAULTS + FEATURE_PRESETS（general/catering/all）
- index.html menu-grid 7 格：leave, attendance, salary, lunch, fieldwork+sales_target, store_ordering, admin-only
- booking/loyalty 格子尚未加入 index.html（待功能完成）
- 三層 AND 邏輯：DEFAULT_FEATURES × INDUSTRY_TEMPLATES × companies.features × feature_visibility
- `INDUSTRY_TEMPLATES` 保留在 settings.js（common.js getFeatureVisibility 需要）
- platform_admin 在首頁每個功能格子右上角看到即時 toggle 開關（綠/灰）
- 底部導航設定已從 admin.html 移除（loadNavSettings/saveNavSettings 已刪），改由 platform admin 控制

## 員工視角 (viewAsEmployee)
- `toggleViewMode()` 切換時：隱藏 toggle 開關、管理後台入口
- `applyFeatureVisibility()` 的 skipFilter 只在非員工視角的 platform_admin 生效

## 關鍵檔案路徑
- [專案指南](../../hr-attendance-liff-main/PROJECT_GUIDE.md)
- [詳細架構筆記](./architecture.md)
