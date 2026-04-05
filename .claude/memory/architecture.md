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
- **order.html currentStoreId vs company_id**：`currentStoreId` = `store_profiles.id`，但 `system_settings`/`loyalty_*` 表用 `companies.id`。須用 `window._storeCompanyId`（= `store.company_id`）查詢這些表
- SQL RPC 存入 TIMESTAMPTZ 欄位時必須用 `now()`（UTC），不能用 `now() AT TIME ZONE 'Asia/Taipei'`（會變無時區 TIMESTAMP 被當 UTC 存入，導致 +8 偏移）；日期/時間判定另用 `(now() AT TIME ZONE 'Asia/Taipei')::date/::time`
- system_settings company_id 是 NOT NULL
- sessionStorage 快取需手動清除
- CORS：瀏覽器不能直接呼叫 LINE API，需 Edge Function
- admin.html 系統設定 tab 名稱是 'setting'（不是 'feature'）
- Supabase JS 的 `.maybeSingle()` 回傳 PromiseLike（非標準 Promise），不能直接 `.catch()`，必須用 try/catch 或 `Promise.resolve()` 包裝
- **PostgreSQL RECORD IS NOT NULL 陷阱**：`RECORD IS NOT NULL` 要求所有欄位都非 NULL，若有任何欄位是 NULL 整個 RECORD 被判定為 NULL。永遠用 `.id IS NOT NULL` 取代 `IS NOT NULL`（例如 `v_existing.id IS NOT NULL` 而非 `v_existing IS NOT NULL`）
- **時區規則**：所有 `toLocaleTimeString` / `toLocaleString` / `toLocaleDateString` 必須加 `timeZone: 'Asia/Taipei'`；不能用 `getHours()`/`getMinutes()` 處理 DB 回傳的時間（只有顯示「現在時間」的即時時鐘例外）
- **LIFF 環境檢查 — 頁面四分類**：
  - 員工頁面（index/checkin/records/requests/fieldwork/salary/services/schedule/booking_service_admin）：`initializeLiff({ requireLineApp: true })`
  - 管理頁面（admin via auth.js/platform）：`initializeLiff()` 不帶參數 → 允許瀏覽器 OAuth
  - 消費者頁面（booking/booking_service/order/loyalty）：完全不走 LIFF SDK
  - **loyalty.html 特殊**：不載入 LIFF SDK，LINE 登入改跳 `liff.line.me/{LIFF_ID}?goto=loyalty&store={id}` → index.html handleGotoParam 存 userId 到 sessionStorage → 跳回 loyalty.html 讀取
- **LIFF OAuth 跳轉**：`liff.login()` 不帶 `redirectUri`（避免非 endpoint URL 被 LINE 拒絕 400）；非 index.html 頁面登入前存 `sessionStorage('liff_redirect_page')`，登入成功後自動跳回
- **QA 腳本**：`bash scripts/qa_check.sh`（7 項檢查），commit 前必跑，FAIL 必修
- **回歸測試清單**：CLAUDE.md 末尾有核心頁面開啟測試 + 修改影響範圍對照表，commit 前必確認

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
- 2026-03-15: booking_service_admin.html 預約列表 UI 改為餐飲業同風格（日期橫向捲軸+統計卡片+狀態膠囊+時間軸分組卡片）；loadBookings 一次抓15天→renderBookingList 前端切換；移除舊 from/to input
- 2026-03-15: booking_service_admin.html 時段設定 tab 改為三區塊（基本設定/時段管理/預約連結+QR Code）；基本設定存 system_settings key=booking_service_settings（interval_minutes, advance_days, auto_confirm）；時段卡片含星期格子+啟停用
- 2026-03-18: service_time_slots 加 slot_end_time（023_service_time_slots_range.sql）；消費者端 expandSlots() 依 interval_minutes 自動切割區間時段；後台 modal 加結束時間 input
- 2026-03-18: 餐飲業預約管理加開放星期格子（store.js toggleBkDayBtn）；儲存到 localStorage + system_settings key=booking_open_days；booking.html 消費者頁讀取後非開放星期灰底不可點
- 2026-03-18: 薪資查詢從 index.html 移至 admin.html（DEFAULT_FEATURES salary=false）；platform.html 移除 salary toggle；新建 loyalty.html（集點會員：點數卡片+記錄+兌換即將推出）；index.html 加 loyalty 格子
- 2026-03-16: checkin.html 相機錯誤分類（showCameraError：NotAllowedError/NotFoundError/NotReadableError 各自 UI 卡片+錯誤代碼）
- 2026-03-16: 打卡改為 LIFF 內雙模式：openCamera() 先試 getUserMedia（電腦/iOS），失敗 fallback 到 input[capture="user"] 觸發系統相機（Android LINE）；handleCapturePhoto() 壓縮+上傳+GPS+RPC；移除外部瀏覽器方案（liff.openWindow/window.open/eid+cid 全移除）
- 2026-03-17: admin.html 便當管理新增「訂餐截止時間」設定（system_settings key=lunch_deadline）；services.html 改用動態截止時間取代寫死 LUNCH_DEADLINE_HOUR=9；saveLunchDeadline/loadLunchDeadline 在 modules/leave.js
- 2026-03-17: checkin.html 相機多重 getUserMedia 重試（4 種 constraints）；captureInput fallback 改 accept="image/jpeg,image/png" capture="user" + showToast 提示；進入打卡頁即檢查 GPS 權限，未開啟顯示步驟提示
- 2026-03-18: quick_check_in RPC 遲到+早退判定（021→022_add_early_leave.sql）：上班→is_late（排班/default_work_start/late_threshold_minutes）；下班→is_early_leave（排班/default_work_end/early_leave_threshold_minutes）；admin.html 考勤設定卡片含上下班時間+遲到早退容忍分鐘；records.html 月曆顯示早退標記
- 2026-03-18: index.html 加入 ?goto= URL 參數跳轉（handleGotoParam），支援 Rich Menu 直接跳轉到 records/leave/attendance/requests/salary/checkin/services/fieldwork/admin
- 2026-03-17: index.html 骨架屏 + 載入優化 + ?goto= URL 跳轉：skeleton 在 LIFF init 後立即顯示；首頁不等天氣/公告載完就顯示；bindPage 預設不加 active；handleGotoParam() 支援 Rich Menu 直接跳轉（records/leave/attendance/requests/salary/checkin/services/fieldwork/admin）
- 2026-03-21: 全頁面時區修正 + initializeLiff requireLineApp 參數 + scripts/qa_check.sh + liff.login() 移除 redirectUri 改 sessionStorage 跳轉（修 admin.html 400）+ CLAUDE.md 回歸測試清單
- 2026-03-21: 025_loyalty.sql — 集點會員系統 4 表（loyalty_members/transactions/rewards/settings）；members: company_id+phone UNIQUE, available_points GENERATED；transactions: source(order/booking/manual)+source_id
- 2026-03-21: loyalty.html 消費者頁（LINE 登入查點數/兌換）+ loyalty_admin.html 後台（4 tab：會員/送點/商品/設定）+ admin.html 加集點格子
- 2026-03-21: 026_loyalty_line_user.sql — loyalty_members 加 line_user_id + UNIQUE(company_id, line_user_id)；識別改用 LINE userId（取代手機）
- 2026-03-21: order.html 加 LIFF SDK（可選 LINE 登入集點）+ awardLoyaltyPoints 改用 line_user_id + system_settings order_mode=dine_in_only 支援；index.html 線上點餐連結加 ?store=currentCompanyId
- 2026-03-21: order.html loadStoreFromSupabase 支援 UUID(company_id) 和 store_slug 雙格式查詢（isUUID 偵測）
- 2026-03-21: admin.html 餐飲設定新增點餐模式（all/dine_in_only/takeout_only）+ 集點開關 + 幾元得1點；儲存到 system_settings key=order_mode/loyalty_enabled/loyalty_points_per_amount；order.html 支援三種模式
- 2026-03-21: admin.html 餐飲設定 tab 重排 → 再改為 5 tab（訂單/菜單/報表/🕐營業/⚙️設定）；營業時間獨立 rdHoursTab；設定 tab 保留點餐設定+LINE群組+基本資料；外帶模式隱藏桌號；QR URL 用 company_id
- 2026-03-21: store.js 移除不存在的 rdLoyalty* DOM 引用；order.html 新增 _storeCompanyId（store.company_id）用於 system_settings/loyalty 查詢
- 2026-03-21: loyalty.html 改為 LINE 登入為主+手機查詢為輔（三 view：loginView/memberView 含兌換碼/phoneView 唯讀）；兌換碼 6 碼數字 24h 有效
- 2026-03-21: 統一集點設定（餐飲設定只保留開關+連結到 loyalty_admin）；loyalty_members 支援 LINE+手機雙識別；LINE 登入後可綁定手機
- 2026-03-21: 028_loyalty_redemptions.sql + 029_loyalty_consolidated.sql（整合 phone/expiry_date/redemptions/trigger）；兌換碼系統（pending→used→expired）+ 店員核銷
- 2026-03-21: 預約集點：餐飲 updateBookingStatus completed→awardBookingLoyalty；服務業 updateBsStatus completed→awardServiceBookingLoyalty；system_settings key=booking_loyalty_points；報表匯出加集點會員+集點異動 CSV
- 2026-03-21: loyalty_admin.html 會員詳細 modal（showMemberDetail）：LINE 綁定狀態+手機可編輯+點數+日期+最近記錄
- 2026-03-21: loyalty_admin.html 設定頁加 QR Code（qrcode.min.js）+ 列印功能（printLoyaltyQR）
- 2026-03-21: salary.html 從 2 tab 改 3 tab（明細/試算/年終）；年終 tab 改為內嵌（import payroll.js）；platform_admin 直接通過密碼驗證
- 2026-03-21: loyalty.html 移除 LIFF SDK，LINE 登入改跳 liff.line.me URL → index.html handleGotoParam(loyalty) 存 userId 到 sessionStorage → 跳回 loyalty.html 讀取
- 2026-03-21: 030_loyalty_phone_nullable.sql — phone DROP NOT NULL（LINE 會員不一定有手機）；loadLineMember 加 null 防護
- 2026-03-21: order.html loginLineForLoyalty 改用 LIFF URL 跳轉（移除 liff.login redirectUri）；initApp 加 sessionStorage fallback 讀 LINE userId；index.html handleGotoParam 加 goto=order
- 2026-03-23: 031_fix_quick_check_in_exception.sql — INSERT 移入 BEGIN...EXCEPTION 子區塊；unique_violation 時重新查詢自動下班
- 2026-03-24: 032_fix_record_null_check.sql — 修正 RECORD IS NOT NULL 陷阱 + GPS 地點驗證（有設定打卡地點但不在範圍→拒絕打卡）；checkin.html「處理中」10 秒安全逾時
- 2026-03-24: 集點架構變更：消費者端（order.html）不再集點，改由店家端在訂單 completed 時用手機號碼集點；兩條路徑：store.js `awardOrderLoyalty`（admin.html）+ kds.html `kdsAwardLoyalty`（獨立廚房系統）
- 2026-03-25: kds.html 有獨立 `updateStatus` 函數（不走 store.js），需獨立處理集點；init 時取 company_id 存 kdsCompanyId
- 2026-03-25: 集點設定統一只讀 loyalty_settings 表（移除 system_settings loyalty_points_per_amount fallback）；033 SQL 清除舊 key
- 2026-03-25: order.html 點數查詢全面改用 loyalty_members（phone）+ loyalty_transactions（member_id），移除所有 loyalty_points 表引用
- 2026-03-25: checkin.html 打卡成功改為顯示結果畫面（時間+地點+返回/關閉按鈕），不再自動跳轉 index.html（LIFF 環境跳轉會卡 loading）
- 2026-03-25: order.html 確認訂單 modal 可刪除品項（removeConfirmItem）+清空購物車（clearCartFromConfirm）；品項全刪自動關閉 modal
- 2026-03-25: order.html 集點提示改用 loyalty_rewards 表動態讀取（loadLoyaltyRewards + buildRewardHintHtml + buildRewardsListHtml），移除所有 points_to_redeem/discount_amount 硬編碼；我的點數 tab 加可兌換商品列表
- 2026-03-25: order.html 我的點數 tab 加兌換功能（redeemReward）：6碼兌換碼→loyalty_redemptions(pending,24h)+used_points+loyalty_transactions(redeem,-N)→showRedeemCodeOverlay 大字顯示；用手機識別會員
- 2026-03-25: index.html 集點格子連結加 ?store=currentCompanyId；loyalty.html 加 sessionStorage('loyalty_company_id') fallback 防參數遺失
- 2026-04-03: v2.5 集點完善+考勤修正+DevOps（OpenSpec 歸檔 archive/2026-04-03_v2.5）
- 2026-04-03: loyalty_admin.html 核銷改善（Enter 鍵+核銷後自動 loadMembers）；手動送點改為搜尋會員下拉+消費金額自動計算點數（依 loyalty_settings.points_per_amount）+直接輸入點數雙模式
- 2026-04-03: store.js 餐飲訂位 confirmed 狀態按鈕從「報到入場→checked_in」改為「確認到店→completed」直接觸發 awardBookingLoyalty 集點
- 2026-04-03: 035_fix_early_leave_overnight.sql — 早退判定修正：一般班只在 shift_end-2h 到 shift_end 之間判定（凌晨不誤判）；跨日班用 is_overnight 正確處理
- 2026-04-03: checkin.html 新增 stopCamera() helper；安全計時器 10s→30s；closeLiff 非 LIFF 環境改為導回 index.html
- 2026-04-03: 034_add_benmi_office_location.sql — 本米土城店 GPS 24.976995,121.442323 半徑 300m
- 2026-04-03: 全部 19 個 HTML 加 <link rel="icon" href="data:,"> 消除 favicon 404
- 2026-04-03: .github/workflows/ci.yml — push main/dev 或 PR 自動跑 npm test
- 2026-04-04: 程式碼品質優化（OpenSpec 歸檔 archive/2026-04-04_code-quality）：common.js 98 var→let/const、5 處 innerHTML 加 escapeHTML、5 個空 catch 加 console.error、9 處 SELECT * 改指定欄位、11 個 console.log 清除、admin.html 4 img 加 alt
- 2026-04-05: 036_fix_overnight_checkout.sql — 跨日打卡修正：RPC 查 2 天內未下班記錄（今天→昨天）；跨日下班不判定早退；前端 _pendingCheckout 顯示下班按鈕+🌙提示；checkin.html 用 rpcData.type 判斷顯示
- 2026-04-05: index.html 打卡狀態返回刷新：加 visibilitychange + pageshow 事件自動重查 checkTodayAttendance + loadTodayStatus

