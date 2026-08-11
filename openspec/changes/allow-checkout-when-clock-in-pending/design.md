## Context

`checkTodayAttendance()` 會先讀正式 `attendance`，再讀今日待審補卡；但 `updateCheckInButtons()` 目前只依正式 attendance、昨日跨日班與昨日漏下班決定首頁按鈕，完全沒有使用已載入的 `todayPendingMakeups`。因此今日上班卡只存在 `makeup_punch_requests(pending)` 時，首頁仍停用下班。後端 migration 107 已有嚴格放行條件：只有當天確實存在 pending／approved 上班申請才允許建立空白 attendance 並寫下班，沒有申請仍回 `no_open_check_in_record`。

## Goals / Non-Goals

**Goals:**

- 讓首頁與 migration 107 一致：今日上班待審時可先打下班。
- 防止重複上班與重複下班申請。
- 保留昨日漏下班與跨日班提示及原本優先序。
- 待審資料查詢明確限定目前公司。
- 用純函式與真實來源靜態檢查鎖定所有按鈕狀態。

**Non-Goals:**

- 不改 migration 107、`quick_check_in`、補卡核准流程或下班截止時間。
- 不自動核准早上上班卡，也不把待審申請直接寫成正式出勤。
- 不允許完全沒有上班紀錄或上班申請的人打下班。
- 不處理跨公司 `quick_check_in` 簽章的既有技術債；本次只確保首頁讀取的待審清單限於目前公司。

## Decisions

### 1. 在 `common.js` 統一按鈕狀態，而不是只在首頁事後覆寫

`checkTodayAttendance()`、返回頁面刷新與其他首頁流程都會呼叫 `updateCheckInButtons()`。在此單一入口加入待審狀態，可避免 `index.html` 先開放後又被共用函式關閉。新增純函式 `getTodayPendingPunchState()` 統一辨識 `clock_in/check_in` 與 `clock_out/check_out` 別名，供按鈕與首頁卡片共用。

### 2. 狀態優先序固定

無正式 attendance 時依序判斷：昨日跨日班待下班 → 今日下班待審 → 今日上班待審 → 昨日一般班漏下班 → 完全未上班。跨日班仍優先，避免把應關閉昨天班次的下班誤算到今天；已有今日下班待審時兩個按鈕都停用，防止重送；今日只有上班待審時停用上班、開放下班。

### 3. 昨日漏下班提醒與今日可下班提示同時保留

今日有待審上班時，操作優先開放下班；如果同時存在昨日一般班漏下班，狀態框追加昨日日期與補打卡連結，不讓舊提醒覆蓋今天下班入口。

### 4. 待審 RPC 加目前公司參數

`loadTodayPendingMakeups()` 呼叫既有 `get_my_makeup_requests` 時補上 `p_company_id: window.currentCompanyId || null`。migration 098 已提供此參數；這只縮小查詢範圍，不新增 RPC 或資料庫變更。

### 5. 所有 `common.js` 引用同步升版

LINE WebView 容易快取舊 JS；修改 `common.js` 後，所有引用頁面統一改為 `?v=20260811-pendingcheckout`，避免部分入口仍使用舊按鈕邏輯。

## Risks / Trade-offs

- [今日待審資料載入失敗] → 保守維持下班停用，不因未知狀態放行。
- [migration 107 未存在的環境] → 前端可能開放入口但後端仍拒絕；正式追蹤文件已記錄 107 於 2026-08-05 套用與驗證，本次仍以 RPC 回應為最終防線。
- [LINE 快取造成新舊行為不一致] → 所有 `common.js` 引用同步升版，部署後要求關閉 LIFF 視窗重新進入。
- [跨日班與今日待審同時存在] → 跨日班維持最高優先，先完成昨天班次，不改既有規則。

## Migration Plan

1. 在 `dev` 修改共用按鈕狀態、公司範圍與快取版本。
2. 執行目標測試、完整 `npm test`、UI、QA、Hook 與 RLS 審查。
3. 由使用者手動提交 `dev`，再經明確授權合併 `main`。
4. 用兩支手機／兩名員工驗收：今日上班待審者可見下班；無上班申請者仍不可見。
5. 回滾只需 revert 本次前端與測試 commit，沒有 DB 回滾。

## Open Questions

- 無。migration 107 已確立「今日上班待審仍可先下班」的業務規則，本次只修正入口一致性。
