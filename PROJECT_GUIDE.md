# RunPiston HR 系統 - 專案開發指南

## 架構概覽
- 純前端靜態架構：GitHub Pages + Supabase + LINE LIFF
- 部署：push to main → GitHub Pages 自動部署
- 資料庫：Supabase (nssuisyvlrqnqfxupklb)
- 通知：LINE Messaging API → Supabase Edge Function (line-push)

## 多租戶（Multi-tenant）規則 ⚠️ 重要
- 一間公司 = 一間商店（store_profiles）
- 所有資料查詢必須篩選 `company_id` 或 `store_id`
- `window.currentCompanyId` = 當前公司 ID（登入後設定）
- `window.currentEmployee` = 當前員工資訊
- 管理頁面只有一間商店時自動選擇，不顯示下拉

## 公司資訊
| 公司 | company_id | 公司代碼 | store_id |
|------|-----------|---------|----------|
| 大正科技機械 | 8a669e2c-... | PROPISTON | (查 store_profiles) |
| 本米股份 | fb1f6b5f-... | 本米 | 58223b9c-... |

## 角色權限
| 角色 | 說明 |
|------|------|
| platform_admin | 超級管理員（Adam），可切換公司 |
| admin | 公司管理員 |
| manager | 主管 |
| user | 一般員工 |

## 全域變數（必須用 window）
- `window.currentCompanyId` - 當前公司 ID
- `window.currentEmployee` - 當前員工物件
- `window.sb` - Supabase client
- `window.selectedBookingDate` - 預約管理選中日期
- `window.currentBookingFilter` - 預約篩選狀態

## 檔案結構
| 檔案 | 用途 | 使用者 |
|------|------|--------|
| index.html | 員工首頁 | 所有員工 |
| checkin.html | 打卡頁 | 所有員工 |
| schedule.html | 班表 | 所有員工 |
| salary.html | 薪資 | 所有員工 |
| records.html | 考勤紀錄 | 所有員工 |
| requests.html | 報修/採購申請 | 所有員工 |
| admin.html | 管理後台 | 管理員 |
| platform.html | 平台管理 | platform_admin |
| order.html | 消費者點餐 | 消費者（掃碼） |
| booking.html | 消費者訂位（餐飲業） | 消費者（掃碼） |
| booking_service.html | 消費者預約（服務業） | 消費者（?store=company_id） |
| booking_service_admin.html | 服務業預約後台 | 管理員（LIFF） |
| loyalty.html | 集點會員（消費者） | 消費者（LINE 登入/手機查詢） |
| loyalty_admin.html | 集點會員後台 | 管理員（LIFF） |
| fieldwork.html | 外勤打卡/業務週報 | 所有員工 |
| services.html | 便當訂購 | 所有員工 |
| kds.html | 廚房顯示系統 | 廚房（獨立） |
| common.js | 共用函數 | 所有頁面 |
| modules/auth.js | 登入驗證、頁面路由 | |
| modules/index.js | ES module → window 綁定 | |
| modules/employees.js | 員工管理 | |
| modules/store.js | 商店/預約/會員/集點 | |
| modules/settings.js | 系統設定/公告/外勤 | |
| modules/leave.js | 請假/排班/午餐 | |
| modules/payroll.js | 薪資計算 | |
| modules/schedules.js | 班表管理 | |
| modules/audit.js | 稽核日誌/報表匯出 | |

## 頁面認證分類
| 分類 | 頁面 | 認證方式 |
|------|------|---------|
| 員工頁面 | index/checkin/records/requests/fieldwork/salary/services/schedule | `initializeLiff({ requireLineApp: true })` |
| 管理頁面 | admin/platform | `initializeLiff()` 允許瀏覽器 OAuth |
| 消費者頁面 | order/booking/booking_service/loyalty | 不走 LIFF（loyalty 可選 LINE 登入） |
| 後台頁面 | loyalty_admin/booking_service_admin | `initializeLiff({ requireLineApp: true })` |

## 集點會員系統
- **識別方式**：LINE userId（主要）+ 手機號碼（備用查詢）
- **資料表**：loyalty_members / loyalty_transactions / loyalty_rewards / loyalty_settings / loyalty_redemptions
- **集點來源**：order（消費）、booking（餐飲訂位）、booking_service（服務預約）、manual（手動）
- **兌換碼**：6 碼數字，24h 有效，店員核銷（loyalty_admin.html）
- **設定統一在 loyalty_settings 表**（不用 system_settings）；餐飲設定只保留開關

## 常見陷阱 ⚠️
1. **時區**：所有 `toLocaleTimeString/toLocaleString/toLocaleDateString` 必須加 `timeZone: 'Asia/Taipei'`
2. **全域變數**：跨函數共用變數必須掛 `window`，不能用 module scope 的 `let/const`
3. **sessionStorage 快取**：修改 system_settings 後要清快取：
   `invalidateSettingsCache(); await loadSettings(true);`
4. **order.html ID 問題**：`currentStoreId` = store_profiles.id，`_storeCompanyId` = companies.id，查 system_settings/loyalty 用後者
5. **CORS**：瀏覽器不能直接呼叫 LINE API，必須透過 Edge Function
6. **GitHub Pages 部署**：push 後 1-2 分鐘
7. **QA 腳本**：commit 前必跑 `bash scripts/qa_check.sh`，FAIL 必修

## 權限分級
| 角色 | 首頁功能 | 管理頁面 | 薪酬 |
|------|---------|---------|------|
| platform_admin | 全部 | 全部 | 🔒 密碼鎖 |
| admin | 受 feature_visibility 控制 | 除薪酬外全部 | ⛔ 隱藏 |
| manager | 受 feature_visibility 控制 | 部分（請假/考勤/排班） | ⛔ 隱藏 |
| user | 受 feature_visibility 控制 | 無 | ⛔ 隱藏 |

- 薪酬密碼存在 system_settings key='payroll_password'，預設 '0000'
- 密碼鎖僅限 platform_admin，admin 角色完全看不到薪酬入口
- session 內驗證一次即通過（`window._payrollUnlocked`）

## system_settings 規則 ⚠️
- company_id 是 NOT NULL，每筆設定都屬於一間公司
- 讀取用 `.eq('company_id', currentCompanyId)`
- 寫入用 `saveSetting(key, value, description)` 共用函數（在 common.js）
- 不要直接 insert，用先查再更新模式
- 新公司建立時需呼叫 `initCompanySettings(companyId)` 初始化預設設定

## Supabase Edge Functions
| Function | 用途 |
|----------|------|
| line-push | LINE 推播 proxy（避免 CORS） |
| line-webhook | LINE Bot 指令處理（#id 回傳 Group ID） |

## LINE 設定
- Channel Access Token 存在 system_settings key='line_messaging_api'
- Group ID: C3372c17c42c4f0ba023338a4417f8b0b
- Webhook URL: https://nssuisyvlrqnqfxupklb.supabase.co/functions/v1/line-webhook
