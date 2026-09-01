## Context

目前瀏覽器把公司 `line_messaging_api` 設定傳給 `line-push` Edge Function，再由該函式呼叫 LINE Messaging API。Edge Function 即使收到 LINE 401/400，也會以 HTTP 200 包成 `{ status, data }`；前端只檢查 `result.error`，又在共用 helper 內吞掉例外，因此測試推播與請假流程都無法辨識失敗。請假申請本身已透過 RPC 成功保存，LINE 僅為後續通知，不得因通知失敗回滾或誤報申請失敗。

## Goals / Non-Goals

**Goals:**
- 統一回傳 `{ ok, status, code, message }`，讓所有呼叫端可判定結果。
- 同時相容目前已部署的 HTTP 200 + `result.status` 舊 Edge Function，以及未來直接回傳非 2xx 的新版函式。
- 測試推播只在 LINE 接受訊息時顯示成功。
- 請假送出、核准與退回完成後，通知失敗只顯示獨立警告，不改變資料結果。
- UI、console 與測試輸出不得洩漏 Channel Access Token。

**Non-Goals:**
- 不更動請假 schema、RPC、RLS、審核規則或 09:15 缺時通知開關。
- 本次不搬移既有 Token 到 Edge Function Secret；此安全重構另案處理。
- 不部署 Edge Function、不讀寫正式資料庫、不發送真實 LINE。

## Decisions

### 使用結構化結果而非以例外控制全部流程

`sendLineMessage` 對缺少設定、缺少收件者、網路錯誤及 LINE 拒絕都回傳結構化失敗；`sendAdminNotify`、`sendUserNotify` 原樣傳遞。請假流程可安全顯示「資料已完成、通知失敗」，而測試推播則把失敗結果轉成紅色狀態。若全面丟出例外，既有未 `await` 的補卡、換班與加班通知可能產生未處理 Promise rejection，因此不採用。

### 同時檢查 HTTP 與包裝後的 LINE status

成功必須符合：HTTP 回應成功、JSON 沒有 `error`，且 `result.status` 不存在或位於 200–299。這讓 GitHub Pages 先部署時仍能辨識現行 Edge Function 包在 HTTP 200 內的 LINE 401，也能相容之後 Edge Function 直接回傳 401。

### Edge Function 回傳相同 HTTP 狀態並只提供安全摘要

本機 Edge Function 原始碼改為以 LINE 回應狀態作為 HTTP 狀態；成功回傳 `ok: true`，失敗只回傳狀態與安全錯誤摘要。Token 不寫入回應或 log。前端仍保留舊格式相容，避免前端與 Edge Function 無法同時部署造成空窗。

### 通知失敗不改變請假交易結果

員工送出請假或主管完成審核後，先以既有 RPC 結束資料操作，再等待通知結果。失敗時顯示醒目警告及管理者可採取的下一步，但不得再次呼叫請假 RPC、刪除資料或把成功改成失敗。

## Risks / Trade-offs

- [正式 Token 或 Group ID 本身可能已失效] → 修正後可辨識並顯示原因，但仍需管理者更新正式設定才能恢復收件。
- [Edge Function 尚未部署新版] → 前端同時辨識舊 `result.status`，GitHub Pages 端修正可先發揮作用。
- [等待通知讓請假成功畫面多等待一次網路] → 資料成功先顯示，通知使用短路結果且不得影響資料；後續可另加逾時。
- [Token 仍存在瀏覽器設定快取] → 列為剩餘安全風險，本次不擴張成憑證架構遷移。

## Migration Plan

1. 先部署相容的新前端；即使 Edge Function 尚未更新，也能判定舊格式的 LINE status。
2. 管理員在正式設定頁手動執行一次測試推播，依畫面結果確認 Token、Group ID 與 Bot 群組狀態。
3. 另行明確授權後再部署新版 `line-push` Edge Function。
4. 回復時可還原 `common.js`、`modules/settings.js`、`modules/leave.js` 與 Edge Function 原始碼；不涉及資料回復。

## Open Questions

無；「請假資料成功優先、通知失敗另行警告」已採最小風險相容行為。
