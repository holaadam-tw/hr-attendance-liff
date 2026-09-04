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
- **new Date("YYYY-MM-DD") 是 UTC 00:00**：在台灣（UTC+8）與本地 `new Date().setHours(0,0,0,0)` 比較時，「今天」會被誤判為 future。日期比較一律用字串（`ds > getTaiwanDate()`），不用 Date 物件
- **SELECT 指定欄位必須覆蓋所有消費端**：改 SELECT * 為指定欄位時，必須 grep 所有用到回傳資料的地方，確認每個欄位都有列出（已踩坑 3 次）
- **有 RLS 的表不能直接用 anon key SELECT**：前端用 anon key 時 JWT 沒有 line_user_id，`get_my_employee_id()` 回傳 NULL → RLS 擋住查詢。必須透過 `SECURITY DEFINER` RPC 繞過（041_fix_get_monthly_attendance.sql）
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
- 2026-04-06: 考勤月曆 bug 連修 5 輪：①RPC 欄位不完整→重建 041 SQL ②直接 SELECT 被 RLS 擋→改回 RPC ③日期比對 substring(0,10) ④UTC vs 本地時區→字串比較 ⑤getStatus _todayStr 提升+RPC error log
- 2026-04-06: 薪資模擬測試工具 tests/payroll-simulation.js：大正(月薪)+本米(時薪) 8 項自動驗證 16/16 通過
- 2026-04-06: v2.7 薪資系統強化 — 時薪制/月薪制完整支援：040 SQL employees 加 salary_type/hourly_rate；批次薪資設定 UI（可編輯表格）；報表增強（制度/工時/合計列）；SheetJS Excel 匯出（雙 Sheet）；salary.html 制度顯示優化
- 2026-04-05: 036_fix_overnight_checkout.sql — 跨日打卡修正：RPC 查 2 天內未下班記錄（今天→昨天）；跨日下班不判定早退；前端 _pendingCheckout 顯示下班按鈕+🌙提示；checkin.html 用 rpcData.type 判斷顯示
- 2026-04-05: index.html 打卡狀態返回刷新：加 visibilitychange + pageshow 事件自動重查 checkTodayAttendance + loadTodayStatus

- 2026-07-12: attendance_public.html 月度分頁新增「請假月曆」：leave_requests 以 employees!inner(company_id) 關聯隔離查整月（approved+pending），每位員工固定專屬色（14 色盤，姓名排序取色）名字直接標在日期格；半天假標「·上/·下」、待審虛線、假日/週末/今日底色；月度 Excel 匯出加「請假明細」sheet。注意：formatYMD() 回傳斜線格式（農曆用），日期 key 一律用 fmtDate()（dash）。另：月度三查詢改 Promise.all 並行、visibilitychange 背景暫停 30s 自動刷新。
- 2026-07-14: 缺卡稽核系統（migration 092 + attendance_public.html）：attendance_anomalies 追蹤表（RLS 無 anon policy）＋自動結案 trigger（attendance 補 check_out_time→resolution=makeup；leave_requests 核准涵蓋當日→leave）＋ scan_missing_checkouts()（近3天、排除跨日班+6h窗口/no_checkin/is_kiosk/已核准請假、僅 attendance_audit_enabled=true 公司=大正）＋ run_daily_attendance_audit()（pg_net 直推 LINE API：員工 DM 依 preferred_language zh/vi 每日一次＋管理群組彙總拖延≥3天標⚠️；REVOKE anon）＋ pg_cron 01:10 UTC。前端打卡總覽「⏰缺卡追蹤」卡片僅大正+管理員模式，get_attendance_anomalies 附 pending_action（補卡待審/請假待審/待員工處理），可手動結案。決策：不自動判斷補卡vs補請假（員工自選+主管審核）；用 pg_net 取代新 Edge Function（部署只需一支 migration）。素食提醒文案改情境化完整句（今天→確認改訂素食；未來→提前提醒）。
- 2026-07-12: B46 系統性修復 — leave_requests/overtime_requests/schedules 對 employees 有雙外鍵（approver_id/created_by），`employees!inner` 內嵌一律 PGRST201 靜默失效；16 處改指定 `employees!<table>_employee_id_fkey!inner`。鐵則：對這三張表做 PostgREST 內嵌必須指定 FK 名稱；新表若加 approver/reviewer 欄位也會觸發同問題。annual_bonus 無 FK（B47 待補 migration）。JS 快取版本升 20260712-leavefk。
- 2026-07-15: 外勤里程表起訖登錄（migration 093 + fieldwork.html + settings.js）：field_work_trips 每日行程表（出發/收工讀數+照片+GPS，partial unique index 同員工同日僅一筆 open；隔天自動 close 舊 open trip）；field_work_logs 加 trip_id/odometer_reading/odometer_photo_url/segment_km/gps_distance_km。segment_km=本站讀數−上一讀數點（trip 起點或前站），gps_distance_km=haversine(前站 leave→arrive→出發 GPS, 本站 arrive)。警示門檻（settings.js fwOdoWarnings，列表/明細/CSV 共用）：segment<gps×0.8 或 >gps×3+5 或缺里程表照片。有 open trip 時到達表單讀數必填且隱藏手填 mileage；無 trip 走舊流程。補貼金額計算（元/km 費率）未做，另案。注意：showFieldWorkForm() 會重設 fwCurrentLogId/fwPhotoUrls/fwOdoPhotoUrl，resume 類函數必須先呼叫它再回填狀態。
- 2026-07-16: 外勤行程地圖＋追蹤模式（migration 094 + fieldwork.html + settings.js/index.js/admin.html）：field_work_trackpoints（BIGINT identity PK，SELECT/INSERT only）。**鐵則：Supabase default privileges 自動給新表 anon 全權限，「只給部分權限」必須 GRANT 後再明確 REVOKE**（094 也補收回 trips 的 DELETE）。追蹤模式僅前景有效（LIFF 限制，LINE 無任何 API 可持續取用戶位置）：60s 間隔低精度取位、批次上傳（滿3點/3分鐘）、失敗 buffer 保留重試（上限30丟最舊）、visibilitychange 停續、多分頁重複點由地圖端「同分鐘取第一點」去重。地圖：Leaflet unpkg lazy load＋文字版 fallback；分段規則相鄰點 >5 分鐘=虛線；circleMarker 不用預設 icon（避免 CDN 圖檔路徑問題）。pg_cron purge-fw-trackpoints 每日 18:30 UTC 清 90 天。
- 2026-07-16(補強): field_work_trackpoints 改 RLS deny-all＋3 支 SECURITY DEFINER RPC（insert_fw_trackpoints/get_fw_trackpoints/count_fw_trackpoints，092 驗證模式：employees.line_user_id+role 檢查+platform_admins fallback）。insert 由 DB 依 trip 認定 employee_id/company_id（防偽造）、行程 closed 拒收、單次 ≤50 點。前端 fwEndTrip 必須先 flush 軌跡再 update closed（順序反了最後一批會被 RPC 拒）。實測證據：anon 直讀/直寫 42501、假身份 P0001、收工後寫入 P0001。
- 2026-07-16: 請假天數排除休假日（migration 095 + common.js）：submit_leave_request 天數從純日曆天改為只計工作日。**休假日認定統一沿用 083 規則**：排班優先（is_off_day）→無排班平日=工作日、週末看公司 default_weekend_work_start/end（本米有=週末工作、大正沒有=週末休）。新增 count_employee_workdays() helper（REVOKE anon）。全休假日擋下「所選日期都是休假日」。get_company_daily_attendance：無排班週末（無週末班公司）有請假涵蓋也回 off_day 不再 on_leave（前端 filter !=='off_day' 自然消失）；週末真打卡仍顯示 working/completed。get_company_monthly_attendance leave_days 只計工作日。既有錯誤資料不回溯（簡杏如假單另修）。
- 2026-07-30: 缺卡追蹤卡片移植到 attendance_overview.html（舊版打卡總覽，admin.html「打卡總覽」按鈕的目標頁）：與 attendance_public.html 同一套 get_attendance_anomalies/resolve_attendance_anomaly RPC，前端 gate 為 window.currentCompanyId===大正＋liffProfile.userId（頁面本身已限 admin），zh-only 無 i18n。注意：系統有兩個打卡總覽頁（attendance_overview.html=admin 後台入口、attendance_public.html=LIFF goto=attendance_public 多語言版），新增管理端功能兩頁都要評估。
- 2026-07-16: 午休不計工時（migration 096 + payroll.js）：公司層級 system_settings lunch_break_start/end（僅大正 12:00–13:00；本米餐飲尖峰不啟用）。**單一計算點=calc_work_hours() trigger（010 建的 trg_calc_work_hours）**——quick_check_in(073)/kiosk_check_in(082)/approve_makeup_request(086)/080 補卡下班的 total_work_hours 寫入全被此 BEFORE trigger 覆蓋，改 RPC 內計算式無意義，改 trigger 一處即全路徑生效。扣除規則：只扣與工作區間「重疊」部分（半天班不扣、12:30 下班扣 0.5h、跨日班檢查翌日視窗）。lunch_overlap_hours() helper 吃台北牆鐘 timestamp（REVOKE anon、GRANT service_role——trigger 在 service_role 直改 attendance 時也要能執行）。calc_payable_work_hours 夾限後再扣。大正歷史 touch update 回溯（092 anomaly trigger 有 OLD.check_out_time IS NULL 保護不誤觸）。技術債：calc_payable_work_hours 077 起 GRANT anon 無 company 過濾，011 部署時收回。
- 2026-08-03: 補打卡期限 2 天→7 天＋跨公司管理員導向修復。①補打卡回溯期間統一由 common.js `MAKEUP_PUNCH_WINDOW_DAYS = 7`（含當天，最早 today−6）控制，records.html initMpDate 讀 `window.MAKEUP_PUNCH_WINDOW_DAYS` 設 date input min/max，並改用 getTaiwanDate() 取代裝置本地 new Date()（原本前端 min 與送出驗證時區來源不同，跨午夜可能差一天）。**限制純前端**：submit_makeup_punch(085) 與 approve_makeup_request(086) 本來就沒有日期窗口驗證，改天數不需 migration；反過來說想硬性限制必須另做 RPC 驗證。②**子頁面公司選擇導向鐵則**：只有 index.html 有 showCompanySelector overlay，其他頁遇到多公司員工未選公司時會導回首頁。原本導回後就停在首頁，現改成 `index.html?next=<原頁>`，index.html 在 checkUserStatus 成功、handleGotoParam 之後檢查 next（白名單 `/^[A-Za-z0-9_-]+\.html([?#]...)?$/`，防開放轉址）並 location.replace 回原頁。③modules/auth.js 一般管理員路徑原本只讀不寫 sessionStorage.selectedCompanyId，且多公司時隨機取 activeAdminRows[0]；改為驗證後寫入，並在「跨公司管理員且本次未選過公司」時先導回 index.html?next=admin.html 明確選擇。**防迴圈條件**：判斷式必須是 `!savedAdminCompanyId`（完全沒選過）而不是「saved 不在 adminRows 裡」——後者在管理員於 A 公司、員工於 B 公司且選了 B 時會 admin↔index 無限跳。既有缺口：跨公司管理員 session 內無切換公司 UI（只有平台管理員有 renderAdminCompanySwitcher）。
- 2026-08-03: migration 097 補打卡日期窗口後端驗證（已套正式庫）：submit_makeup_punch 加上與前端一致的窗口 `(now() AT TIME ZONE 'Asia/Taipei')::date` 往回 7 天（含當天），超出回 punch_date_out_of_window、未來回 punch_date_in_future。**鐵則：DB 端算「今天」一律用 `(now() AT TIME ZONE 'Asia/Taipei')::date`，不可用 CURRENT_DATE**（CURRENT_DATE 是 UTC，台灣時間 08:00 前整整差一天）。天數常數 v_window_days 與前端 common.js MAKEUP_PUNCH_WINDOW_DAYS 必須同步。日期檢查刻意放在員工查詢之前，驗證時不會產生寫入。只擋送出不擋審核（approve_makeup_request 未動，舊的 pending 仍可核准）。改既有 RPC 用 CREATE OR REPLACE 不用 DROP+CREATE，避免正式站在套用瞬間打不到卡。**驗證手法（無副作用）**：①用不存在的 line_user_id 打 RPC，窗口內會走到 employee_not_found、窗口外會被日期擋，可分辨兩種結果且零寫入；②真實員工的 happy path 用 `BEGIN; ... ROLLBACK;` 包起來丟 `supabase db query --linked -f`（CLI 只回最後一個 SELECT，要看每個案例就先寫進 TEMP TABLE 再一次 SELECT），事後再查一次確認殘留 0。技術債：submit_makeup_punch / get_my_makeup_requests 用 line_user_id LIMIT 1 認定員工、無 company_id 條件，跨公司員工會隨機落在其中一家（目前只有兩位管理員跨公司，影響低，另案）。
- 2026-08-03: 切換公司入口（index.html + modules/auth.js + i18n.js）：原本只有平台管理員有公司下拉，跨公司的一般員工／管理員選定後整個 session 換不了。index.html 把首次登入用的 showCompanySelector 重構成共用 `pickCompanyFromOverlay(options, cancelable)`（options = {id,name,role}；cancelable 才掛取消鈕，close 時一併移除避免下次殘留），首頁 `mountCompanySwitchEntry()` 只在身份 ≥2 家時掛「切換公司」鈕；common.js checkUserStatus 員工路徑新增 `window.myCompanyOptions` 供其取用（平台管理員用既有 managedCompanies）。**切換一律採「寫 sessionStorage.selectedCompanyId + location.reload()」而非即時抽換資料**——即時切換要重跑 currentEmployee/功能開關/該頁所有查詢，任何一處漏掉就會殘留前一家公司的畫面；reload 讓所有頁面走同一條既有的啟動路徑。auth.js renderAdminCompanySwitcher 擴充成雙分支：平台管理員維持 switchCompanyAdmin 即時切換（原路徑不動），一般跨公司管理員用 window.myAdminCompanies（checkAdminPermission 以 companies.select('id,name').in('id', 自己的 company_id 清單) 帶名稱）+ reload。**鐵則：改 common.js / i18n.js / modules/*.js 一定要同步升 HTML 裡的 `?v=` 快取版本**（本次 20260803-companyswitch；前一個 commit 1f5cdf2 就漏升，LIFF webview 會拿到舊 JS 讓修正看起來無效）。驗證手法：專案沒有前端測試框架，但 `npm install jsdom --no-save` 後可用 jsdom 把「真實 index.html 的 inline script」與「真實 modules/auth.js（無 import、只依賴全域，可直接 import 測）」載進來跑真互動測試（點擊、sessionStorage、reload 計數用 VirtualConsole 攔 jsdomError 的 navigation 訊息，因為 jsdom 的 location.reload 不可覆寫），比純 code review 可靠得多。
- 2026-08-03: migration 098 補打卡 RPC 加公司範圍（已套正式庫）：submit_makeup_punch / get_my_makeup_requests 新增 `p_company_id UUID DEFAULT NULL`，有帶就 `AND (p_company_id IS NULL OR company_id = p_company_id)` 限定、沒帶維持舊行為；前端 common.js（submitMakeupPunch/loadMakeupHistory）與 checkin.html GPS 待審都改傳 window.currentCompanyId。**鐵則：PostgREST RPC 改參數數量必須 DROP 舊簽章再建，不能只 CREATE OR REPLACE**——新舊 overload 並存時 PostgREST 會報 Could not choose the best candidate function，整支 RPC 掛掉；套完要查 pg_proc 確認只剩一個簽章。**用 DEFAULT NULL 讓新參數向後相容**，DB 可以先上、前端後上，中間不會斷（實測舊 6 參數呼叫仍正確解析）。安全性：company_id 由前端傳但查詢是「line_user_id = 自己 AND company_id = 傳入值」，只能縮小到本來就有身份的公司，傳別家只會 employee_not_found。**JS 快取版本鐵則的補充：modules/index.js 內部 import 是每支子模組各自帶 `?v=`（`from './auth.js?v=...'`），只升 admin.html 裡 modules/index.js 的版本沒有用，改哪支子模組就要升那支 import 的版本**（本次踩過：675428c 改了 auth.js 但子模組 import 版本沒動，f841207 才補）。
- 2026-08-03: 【最嚴重缺口修復】三支公司層級 RPC 無呼叫者驗證（migration 099+100，已套正式庫）：get_company_daily_attendance/get_company_monthly_attendance(095)、get_weekly_schedules(063) 都是 SECURITY DEFINER＋GRANT anon 但只收 p_company_id，任何人用公開 anon key＋company_id 就能 dump 別家公司出勤班表。**鐵則：SECURITY DEFINER＋GRANT anon 的 RPC，只要參數裡有 company_id/store_id 這種「指定要看誰的資料」的欄位，就必須收 p_line_user_id 並在函式內驗證呼叫者屬於該租戶——它繞過所有表層 RLS，表層鎖得再緊都沒用。** 修法：新增 has_company_access(line_user_id, company_id, require_manager) helper（EXISTS employees 同公司在職 ∪ platform_admin_companies；**helper 本身要 REVOKE anon，否則變成「某人是否屬於某公司」的探測 API**），三支 RPC 前置呼叫。權限層級要對齊前端既有 gate：出勤總覽=admin/manager/is_kiosk，週班表=同公司任何在職員工。**三步部署順序不可顛倒：先 migration 加參數但可選（NULL 放行）→ 前端上線傳參數 → 再 migration 改必填。** 先改必填會擋掉所有舊前端；前端先傳則 PostgREST 找不到函式（參數不符）整頁壞掉。第三步前要等過 GitHub Pages HTML 的 Cache-Control: max-age=600。**改既有 RPC 的技巧**：用 pg_get_functiondef 把正式庫現行定義撈下來、腳本插入 guard 再重建，比手抄 140 行本體可靠；注意 (a) pg_get_functiondef 輸出**不含結尾分號**，接 GRANT 會 syntax error；(b) 不同年代的 migration 寫入的本體換行可能是 CRLF（063）或 LF（095），比對 `\nBEGIN\n` 前要先正規化。
- 2026-08-03（續）: 同型漏洞全庫排查與 migration 101/102/103。掃描條件（可重複使用）：`select proname, pg_get_function_identity_arguments(oid) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where nspname='public' and prosecdef and has_function_privilege('anon',p.oid,'EXECUTE') and args ~ '(company_id|store_id|employee_id)' and args !~ 'line_user_id'`。找到：四支審核清單 RPC（101/102 加驗證）＋ calculate_monthly_payroll（anon 可算任一員工實領薪資，前端根本沒在用 → 103 REVOKE）＋ generate_binding_code（任何人可為任一員工編號取得綁定碼且函式直接回傳 code＝帳號冒用破口，前端沒用、verification_codes 0 筆 → 103 REVOKE）。**upsert_schedule/delete_schedule 未修**：它們有檢查 p_scheduler_id 的排班權限與同公司，但 scheduler_id 由前端傳，employees 表 anon 可全讀 → 冒用管理員 id 即可增刪排班（寫入）。**⚠️ 必須理解的限制：p_line_user_id 驗證只是提高門檻，沒有封死——employees 表目前 anon 可全讀且 line_user_id 也讀得到（實測可撈出 role=admin 的 LINE ID），攻擊者先撈身分再帶進 RPC 仍可通過。它擋掉的是「只知道 company_id 就能 dump」與「A 公司使用者存取 B 公司」。真正封死必須連 employees 一起鎖，卡在身分自舉（common.js:311/346、auth.js:121/160/192/360 直讀 employees 判斷你是誰）需要 bootstrap RPC。** 另：欄位級 REVOKE 救不了——前端 `.eq('line_user_id', ...)` 的 WHERE 條件同樣需要該欄位的 SELECT 權限。
- 2026-08-04: 管理員代補打卡不限日期（migration 104 + attendance_overview.html）。業主政策：員工限 7 天內自助補打卡、管理員不限時間。盤點後發現**後半原本做不到**——管理端只有 approve_makeup_request(086，不看日期但前提是員工有送出)、缺卡追蹤手動結案(092，不寫 attendance)、直接改 DB 三條路，全庫無任何 admin 補登 RPC。新增 `admin_makeup_punch(p_company_id, p_line_user_id, p_employee_id, p_punch_date, p_punch_type, p_punch_time, p_note)` SECURITY DEFINER：兩層租戶隔離（①操作者驗證綁 p_company_id＋role admin/manager，092 模式，帶別家 company_id 會查不到人而被擋；②目標員工再驗一次 company_id）；**無回溯下限但擋未來日期**；寫 attendance 比照 086；額外 INSERT 一筆 status='approved' 的 makeup_punch_requests 當軌跡（reason=管理員補登、approver_id=操作者），並把同員工同日同類型仍 pending 的申請改 rejected（否則之後被核准會再覆寫一次）。**鐵則：不要在 RPC 內自算 total_work_hours**——010 建的 trg_calc_work_hours（096 改為含午休扣除）是工時單一事實來源，BEFORE INSERT/UPDATE OF check_in_time,check_out_time 會覆蓋你算的值。**Edge case：092 的 trg_resolve_anomaly_on_checkout 是 AFTER UPDATE，補下班卡時它會「先」把缺卡結成 resolution=makeup 但 resolved_by 留空（trigger 不知道操作者）**，所以 104 的結案條件必須寫成 `status='pending' OR (status='resolved' AND resolution='makeup' AND resolved_by IS NULL)` 才記得到誰處理的，靠 UNIQUE(employee_id,date,anomaly_type) 保證只命中一筆。前端只做在 attendance_overview.html（業主指定；attendance_public.html 未動）：頁頭「代補打卡」通用表單＋缺卡追蹤每筆「補登下班」快捷鍵，日期欄只設 max 不設 min（與員工端 records.html 的 min=today−6 刻意不同）。部署順序：104 必須先套正式庫再合併 main，否則按鈕打到不存在的函式。
- 2026-08-04: 打卡失敗記錄（migration 105 + checkin.html + attendance_overview.html）。調查「有打卡但系統說沒打卡」根因：**GPS 失敗的打卡不寫 attendance，只送待審申請**，員工看到「✅已送出待審核」以為成功，主管核准平均拖 53–75 小時（最長 504 小時），這期間所有統計都算他沒打卡。近 120 天大正 113 筆 GPS 轉待審 vs 21 筆真忘打卡（84%）。延遲根因：checkin.html 送待審時沒呼叫 sendAdminNotify，主管不會收到通知。**鐵則發現：上班／下班的 GPS 規格不一致——quick_check_in 的下班分支處理完就 RETURN，地點範圍比對寫在其後，所以下班完全不驗打卡範圍（資料佐證：43 筆超範圍全是上班卡、下班 0 筆）；且 check_out_location = COALESCE(v_matched_location, check_in_location) 中 v_matched_location 在該時點必為 NULL，等於下班地點永遠複製上班地點、不可信（真實座標在 checkout_latitude/longitude）**。下班打不了卡的主因是時間牆：checkout_time_limit_hours 未設定→程式預設 4 小時，23 人 fixed_shift_end 全是 17:00→截止 21:00，而 E824/E814/E812 常態加班到 20:40 只剩十幾分鐘緩衝；已寫入 checkout_time_limit_hours=8（截止 01:00），並移除「打卡測試」打卡地點。105 新增 checkin_failures（deny-all RLS＋兩支 RPC：log_checkin_failure 由 DB 依 line_user_id 認定 employee/company 防偽造、查無員工不寫入；get_checkin_failures admin/manager 限定 092 模式）。outcome 刻意分 blocked（完全打不進去）與 pending_review（有送出但轉待審）。**鐵則：失敗記錄呼叫一律 fire-and-forget 不 await＋內部包 try/catch，絕不可影響打卡主流程；待審錯誤加 _logged 旗標避免外層 catch 重複記錄。**
- 2026-08-10: B48 iPhone／LINE WebView 相機截圖逾時與重試修復。**相機預覽可見不等於已成功產生照片**：`canvas.toBlob()` 在 WebView 可能 callback 空值、丟錯或完全不回應；一律透過 `canvasToJpegBlob()`，3 秒後改以 `toDataURL()` 轉 Blob。打卡前用 `hasUsableCameraFrame()` 同時檢查 srcObject、readyState、videoWidth/videoHeight 與 live/enabled video track；逾時關閉串流後再次打卡會由 `ensureCameraReadyForCapture()` 自動重開並等待第一個有效 frame。每次操作有 attempt id；總逾時先取消 attempt，所有長 await 後呼叫 `ensureCaptureAttemptActive()`，避免舊操作在使用者重試後繼續改 UI 或送 RPC。失敗記錄 stage 固定區分 camera/photo/upload/gps/rpc，之後可從 checkin_failures 直接判斷卡點。`tests/checkin-photo-retry.test.js` 抽取真實 helper 執行並納入 `npm test`，不得再把 raw `new Promise(canvas.toBlob)` 寫回兩種拍照流程。
- 2026-08-10: B49 打卡頁裝置自我檢查。`runCheckinHealthCheck()` 只做 LIFF／員工脈絡、正式站 no-store GET、有效相機 frame＋記憶體 JPEG 與專用短時 GPS 探測；禁止呼叫 `quick_check_in`、Storage upload、失敗記錄或任何 DB 寫入。診斷摘要只保留粗略平台、版本、狀態碼與耗時，不得包含姓名、ID、User-Agent 原文、照片或座標；`input[capture]` fallback 的測試照處理後必須 revoke URL 並清空 input。Android／LINE 實測後，定位自我檢查不得再呼叫正式 `resolveGpsLocation()`：改用 `getHealthGpsLocation()` 最多 0.5 秒查權限＋7 秒取一筆全新座標，禁止讀寫 `cachedLocation`／`localStorage`，避免定位關閉時累積約 30 秒；正式打卡仍維持完整定位與精度規則。錯誤結果必須用深紅總結、紅色問題卡與黃色處理步驟，並依 Android／iPhone 顯示設定路徑。
- 2026-08-11: B50 今日上班補卡待審時的首頁下班入口。migration 107 已是業務規則來源：今日有 pending／approved 上班申請即可先打下班；前端 `updateCheckInButtons()` 必須讀 `todayPendingMakeups` 與 `getTodayPendingPunchState()`，不可只看正式 attendance。無 attendance 時優先序固定：昨日跨日班 → 今日下班待審 → 今日上班待審 → 昨日一般班漏下班 → 未上班。上班待審時停用上班、開放下班；下班也待審時兩者停用。昨日一般班漏卡提醒可與今日上班待審並存，不得關閉今日下班。`get_my_makeup_requests` 必須傳 `p_company_id` 限目前公司。修改 `common.js` 後所有 HTML 引用一律同步升 `?v=20260811-pendingcheckout`。
- 2026-08-14: 時數假與缺時稽核。時數假新資料必須保存 `leave_start_time/leave_end_time`，限定同一天，由 DB 以時間差自動算 `leave_hours/days`；舊時數假仍可用 `leave_hours` fallback 顯示。核准上午半天的遲到基準固定 13:00；時數假只有從班別開始時間連續覆蓋時才延後遲到基準，待審假不影響考勤。整日假報表必須使用 `leave_requests.days`（095 已排除休假日），不可再用日曆日期差。隔日缺時以 `attendance_anomalies.anomaly_type='missing_work_hours'` 保存，`details` 記錄缺時／晚到／早退分鐘，並以 `group_notified_date` 保存主管彙總每日冪等標記；沿用 `late_threshold_minutes`、`early_leave_threshold_minutes`，排除 off day/no_checkin/is_kiosk/overnight、待審補卡及 pending missing_checkout。排程只建異常與 LINE 通知，不得自動寫 attendance 或 leave_requests。113/114 採 migration-only 交付，本次不得套正式庫。
- 2026-08-15: 113/114 已在獨立 Free Plan Supabase 測試專案 `vtlvjbwqrvhfgivbmmaa` 實際套用並用全虛構資料驗證，正式 Project Ref `nssuisyvlrqnqfxupklb` 全程未存取。實測補出主管群組重跑會重複通知的缺口，因此 114 以 anomaly `details.group_notified_date` 保存每日群組通知標記，scan upsert 必須保留該欄位。假 LINE Token 驗證員工／群組各排入一筆並回 401，第二次同日執行為 0/0；測後移除 LINE 設定並 unschedule 測試 cron。
- 2026-08-15: 缺時 LINE 正式上線採獨立安全閘門。`attendance_audit_enabled` 只控制 anomaly 掃描，不得兼作發訊開關；新設定 `missing_work_hours_line_notifications_enabled` 必須明確為 true 才能讀 LINE Token 與呼叫 pg_net，缺少設定一律 false。主管上線流程固定為「公司限定人工掃描（不通知、不改 attendance／leave_requests）→核對 anomaly 名單→二次確認開啟→下一次 09:15 才通知」。設定讀寫與人工掃描一律走 migration 115 的 SECURITY DEFINER RPC，透過專屬 `has_missing_work_hours_notification_access` 驗同公司 admin／manager 或受派平台管理員，且明確排除 `is_kiosk=true`；精簡測試 schema 沒有平台管理員表時用 `to_regclass` 安全退讓。前端不得直接寫 system_settings。隔離測試庫實況的 `system_settings` 僅有 id/company_id/key/value，唯一鍵為 `(company_id,key)`；migration 不可假設 description／updated_at 存在。正式維護必須在非 09:15 時段連續套用 113/114/115，避免 114 與安全 gate 之間留空窗。
- 2026-08-15: migrations 113/114/115 已於正式專案 `nssuisyvlrqnqfxupklb` 在 11:26 以單一 `BEGIN/COMMIT` 交易依序套用；RPC 舊定義已備份於本機 `.codex/production_rpc_backup_before_113_115_20260815_1124.sql`。部署後 3 欄位、2 NOT VALID 約束、14 RPC 安全屬性/權限、cron job 8 唯讀驗證通過；`missing_work_hours_line_notifications_enabled` 仍 0 筆且 pg_net queue 0。cron 每日 09:15 會掃描 anomaly，但 gate 關閉時不得讀 Token 或通知。
- 2026-08-15: B53 補打卡導引。員工月曆判斷不得以「存在 attendance」直接視為正常：過去日期有 check_in 無 check_out=`missing_out`，反向=`missing_in`；今日只有上班卡仍是進行中，不列待補。補卡頁的待補清單只是既有月曆資料的 UI 導引，RPC 仍是規則事實來源；pending/approved 同日同類型不得顯示可重送按鈕。下班補卡尚未手動輸入時讀 `default_work_end`，無有效值才 fallback 17:00，並明示下午 5:00。若已載入的上班時間晚於等於所填下班時間，前端先擋並引導主管用管理端代補覆寫；migration 106 的 DB 驗證不得移除或放寬。既有 `get_monthly_attendance` 無公司參數，補卡導引只能在「非平台管理員＋恰一個啟用公司身分＋目前員工/公司一致」時呼叫；多公司帳號必須停止載入並清空既有月資料，直到另案獲授權建立公司隔離 RPC。
- 2026-08-15: B53 補卡錯誤提示。共用 `style.css` toast 預設單行省略，`records.html` 必須用局部 `.toast` 規則改為 `white-space: normal`、手機寬度內換行、左右 16px 與 safe-area 底距；不要為單頁需求改壞其他頁面版面。`common.js showToast()` 超過 32 字顯示 6 秒，短訊息維持 3 秒，動畫淡出時間與 DOM 移除時間必須一致。
- 2026-08-15: B54 補打卡實機回歸。Android 原生 `type=time` 會依裝置地區格式把 17:00 畫成 5:00，補卡時間改用 `inputmode=numeric` 的文字欄位固定顯示 `HH:mm`，`1700` 可正規化為 `17:00`，RPC 前必須驗證 00:00–23:59。平台管理員不能因舊 `get_monthly_attendance` 無公司參數就永遠看不到待補日期；改用既有 `get_company_daily_attendance`，帶 `p_company_id + p_line_user_id` 並只取 `currentEmployee.id`，沿用 migration 100 的公司／主管驗證，禁止回退為無租戶範圍查詢。
- 2026-08-15: B55 免打卡待補清單規則。`records.html` 只在 `currentEmployee.no_checkin === true` 時排除 `absent`（整日無紀錄）的上下班待補；`missing_in`／`missing_out` 一律保留，讓已有單邊打卡的免打卡人員仍能補齊不完整紀錄。不得用 `admin`／`manager` 角色推定免打卡，避免需要打卡的管理員被錯誤排除。
- 2026-08-15: B55 實機補強。`get_company_daily_attendance` 不得以 `no_checkin=true` 無條件排除整名員工，否則平台管理員補卡導引會連既有單邊 attendance 一起看不到。migration 116 的篩選固定為：一般員工照常回傳；免打卡人員只有在上下班時間都為空時排除，只要任一側已存在就回傳。RPC 的 `has_company_access(p_line_user_id,p_company_id,true)`、`e.company_id=p_company_id`、簽章與回傳欄位不得改弱。
- 2026-08-15: B56 補打卡時間時鐘入口。B54 為固定顯示 `17:00` 將可見欄位改為文字輸入，Android 不再把下午 5 點顯示成易誤解的 `5:00`，但原生時鐘也隨之消失。`records.html` 保留可編輯的 `HH:mm` 文字欄位，旁邊新增明確時鐘按鈕與隱藏的原生 `type=time` 選取器；優先呼叫 `showPicker()`，LINE WebView 不支援時回退 focus/click。選取後必須正規化回可見欄位、標示為手動輸入並立即呼叫 `onMpFormChange()`，因此原有「下班不得早於上班」防呆與送出停用規則不會被繞過。未新增 RPC、資料庫、LINE 或排程副作用。
- 2026-08-31: 同時請假人數改為警告門檻。相容性設定鍵仍為 `max_concurrent_leave`，但不得再當成前端硬上限；`checkLeaveAvailability()` 在「既有重疊人數 + 申請者 > 門檻」時回傳 `thresholdExceeded=true` 與人力警告，同時固定 `ok=true`，`records.html` 必須保持送出按鈕可用。申請仍只走既有 `submit_leave_request` RPC 並進入待審，由主管決定；日期反向、半天／時數假跨日、時數不足等資料有效性規則仍可硬擋。管理端沿用 1–10 人設定與公司隔離查詢，所有畫面只可描述為「警告門檻／主管審核」，不可宣稱自動駁回。
- 2026-09-01: LINE 推播 helper 統一回傳 `{ok,status,code,message}`，同時檢查 Edge Function HTTP status 與舊版包裝內的 LINE status，避免 HTTP 200／內層 401 被誤顯示成功。`sendAdminNotify`／`sendUserNotify` 必須傳遞結果，員工 LINE 綁定查詢同時限定 employee_id 與 company_id；請假送出／審核資料成功後，通知失敗只顯示獨立警告，不回滾業務資料。管理端測試推播只有 `ok=true` 才顯示成功。本機 `line-push` 原始碼同步改為沿用 LINE HTTP status，但尚未部署 Edge Function；前端保留對正式站舊回傳格式的相容判斷。
- 2026-09-04: migration 117 請假重疊防呆＋移除正式庫殘留 `calculate_leave_days_trigger`（repo 從未納管、把 RPC 算好的工作日數覆寫成日曆天，是「六日被算進請假天數／半天假存 1.0」的真正根因，095 部署時沒驗 INSERT 後的 days 所以漏掉）。新增 `find_overlapping_leave()`（REVOKE anon）；`submit_leave_request` 送出前、`approve_leave_request` 核准時都查同員工 pending/approved 日期交集，**同一天一律擋**（業主決策，含上午＋下午）；approve 只處理 pending 並在 UPDATE 再限 status='pending'。前端 `submitLeave` 先跑 `findMyOverlappingLeave` 自查（employee_id＋company_id）。教訓：**部署 RPC 後要驗「寫入後的資料」而不只是驗函式回傳值**；正式庫 trigger 清單要納入 rls_audit 一併盤點。
