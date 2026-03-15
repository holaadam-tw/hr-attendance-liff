# 架構詳細筆記

## 檔案結構
| 檔案 | 用途 |
|------|------|
| index.html | 員工首頁（功能格子 + 編輯模式） |
| fieldwork.html | 外勤打卡 + 業務週報 + 客戶管理（三 tab） |
| admin.html | 管理後台（地點/員工/排班/薪酬/系統設定） |
| checkin.html | 打卡頁 |
| common.js | 共用函數（saveSetting, loadSettings, applyFeatureVisibility 等） |
| modules/auth.js | 登入驗證、頁面路由、公司切換 |
| modules/settings.js | INDUSTRY_TEMPLATES, LINE推播, 公告, 客戶, 外勤, 公司管理 |
| modules/index.js | ES module → window 綁定（所有 onclick 入口） |
| modules/employees.js | 員工 CRUD, QR Code, 部門管理 |
| modules/leave.js | 請假/排班/午餐管理 |
| modules/store.js | 商店/預約（餐飲業）/會員 |
| booking_service.html | 消費者預約頁（服務業，不需登入，?store=company_id） |
| booking_service_admin.html | 服務業預約後台（4 tab：預約列表/技師/服務項目/時段） |
| modules/payroll.js | 薪資計算 |
| modules/schedules.js | 班表管理 |

## saveSetting 模式
```javascript
async function saveSetting(key, value, description) {
    // 1. 查 existing by key + company_id
    // 2. existing → update, else → insert
    // 3. invalidateSettingsCache() + loadSettings(true)
}
```

## 功能開關流程
1. `DEFAULT_FEATURES` (common.js) — 全域預設
2. `INDUSTRY_TEMPLATES` (settings.js) — 產業別覆蓋
3. `companies.features` — 平台管理員允許的功能
4. `feature_visibility` (system_settings) — 公司管理員微調（只能關不能開）
5. `applyFeatureVisibility()` — DOM 顯示/隱藏

## 常見陷阱
- 獨立頁面初始化必須先 `initializeLiff()` 再 `checkUserStatus()`，順序不能反
- `checkUserStatus()` 依賴 `liffProfile`（由 `initializeLiff()` 設定），不能直接呼叫
- 獨立頁面不要自行查 employees 覆蓋 `currentCompanyId`，用 `checkUserStatus()` 統一設定
- `toISOString()` 會轉 UTC，台灣 UTC+8 日期會偏移
- system_settings company_id 是 NOT NULL
- sessionStorage 快取需手動清除
- CORS：瀏覽器不能直接呼叫 LINE API，需 Edge Function
- admin.html 系統設定 tab 名稱是 'setting'（不是 'feature'）

## 最近修改記錄
- 2026-03-10: 權限分級 + 薪酬密碼鎖
- 2026-03-11: 首頁直接編輯功能開關，移除 admin 功能管理頁面
- 2026-03-11: 員工視角修復（隱藏 toggle/編輯按鈕）
- 2026-03-11: 地點管理 UI 改善（卡片式+地址+可編輯座標）
- 2026-03-11: 功能格子直接 toggle 開關（platform_admin），移除編輯模式
- 2026-03-12: 統一功能開關架構（9 key），精簡 index.html 為 7 格，platform.html 分組 toggle
- 2026-03-12: 移除 admin.html 底部導航設定（改由 platform admin 統一控制）
- 2026-03-12: 修復 index.html loadActiveOrders() null reference（activeOrdersItem/Badge 已移除）
- 2026-03-12: 完全移除底部導航列（initBottomNav/ALL_NAV_ITEMS/CSS/所有頁面呼叫/admin靜態DOM）
- 2026-03-12: 修復功能開關錯層（toggle改寫companies.features、移除skipFilter、feature_visibility預設全true）
- 2026-03-13: 修復 toggleFeatureSwitch companyId 取值（用 let 變數非 window）、舊 feature_visibility 偵測跳過
- 2026-03-13: 修正 index.html toggle 開關架構：業主 toggle 控制第二層 feature_visibility（saveSetting），非 companies.features；業主視角顯示所有第一層允許的格子
- 2026-03-13: 修正員工流程 loadSettings 時序（必須在 currentCompanyId 設定後）；移除 isLegacy 跳過邏輯；toggleViewMode 不再清快取；renderFeatureToggles 非業主時移除 toggle
- 2026-03-13: 新增申請管理入口（index.html 格子 + common.js requests:true + platform.html toggle）；admin.html 預約管理加「（餐飲業）」；修復 salary_settings employee_id=null 查詢
- 2026-03-14: 新建 fieldwork.html（外勤打卡+業務週報+客戶管理三tab）；services.html 精簡為便當訂購；admin.html 移除客戶管理；clients 表加 employee_id/company_id
- 2026-03-15: booking 格子連結改為 admin.html#booking；auth.js 新增 EMPLOYEE_ALLOWED_HASHES 讓一般員工可存取預約頁；名稱統一為「預約系統（餐飲業）」
- 2026-03-15: 新建服務業預約系統（booking_service.html + booking_service_admin.html）；SQL 018_booking_service.sql；功能 key booking_service；platform.html 新增服務業 preset
