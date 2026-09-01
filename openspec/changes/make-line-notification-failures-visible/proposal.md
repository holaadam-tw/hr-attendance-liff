## Why

請假申請目前即使 LINE Messaging API 回傳 401、錯誤 Group ID 或網路失敗，前端仍會把測試推播顯示為成功，且請假送出後完全看不到通知失敗。這會讓主管誤以為沒有新申請，也讓管理者無法判斷是 Token、群組或網路設定異常。

## What Changes

- 統一 LINE 推播回傳結果，明確區分成功、設定缺失、LINE 拒絕與網路失敗。
- 修正測試推播，只有 LINE 實際接受訊息時才顯示成功，否則顯示不含 Token 的白話錯誤。
- 請假申請與審核資料維持成功保存；若後續 LINE 通知失敗，畫面另外提示「申請／審核已完成，但 LINE 通知失敗」。
- 補上離線回歸測試，模擬成功、HTTP 401 包在 JSON、缺少設定與網路例外。
- 不改請假規則、資料庫 schema、RPC、09:15 缺時通知開關或正式環境設定。

## Capabilities

### New Capabilities
- `line-notification-delivery-feedback`: LINE 推播必須回傳可判定的傳送結果，並讓測試推播及請假流程呈現真實成功或失敗。

### Modified Capabilities

無。

## Impact

- `common.js`：共用 LINE 推播結果契約與請假送出提示。
- `modules/settings.js`：測試推播真實結果與白話錯誤。
- `modules/leave.js`：請假核准／退回後的員工通知結果。
- `supabase/functions/line-push/index.ts`：保留現有呼叫格式，讓 HTTP 狀態與 LINE 回應一致。
- `tests/`、`package.json`、快取版本與專案文件。
