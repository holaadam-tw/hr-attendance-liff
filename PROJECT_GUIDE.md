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
| booking.html | 消費者訂位 | 消費者（掃碼） |
| common.js | 共用函數 | 所有頁面 |
| modules/auth.js | 登入驗證 | |
| modules/index.js | 首頁邏輯 | |
| modules/employees.js | 員工管理 | |
| modules/store.js | 商店/預約/會員管理 | |
| modules/settings.js | 系統設定/公告 | |
| modules/leave.js | 請假/排班 | |
| modules/payroll.js | 薪資計算 | |
| modules/schedules.js | 班表管理 | |

## 常見陷阱 ⚠️
1. **時區**：`toISOString()` 會轉 UTC，台灣 UTC+8 日期會偏移。用本地格式化：
   `d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0')`
2. **全域變數**：跨函數共用變數必須掛 `window`，不能用 module scope 的 `let/const`
3. **sessionStorage 快取**：修改 system_settings 後要清快取：
   `sessionStorage.removeItem('system_settings_cache'); await loadSettings();`
4. **localStorage 是瀏覽器獨立的**：跨裝置設定必須存 Supabase
5. **CORS**：瀏覽器不能直接呼叫 LINE API，必須透過 Edge Function
6. **GitHub Pages 部署**：push 後可能需要 1-2 分鐘，有時需空 commit 觸發

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
