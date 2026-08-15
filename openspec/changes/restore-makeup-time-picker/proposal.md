## Why

補打卡時間為了避免 Android 將 `17:00` 顯示成不清楚的 `5:00`，改成固定的 24 小時文字欄位後，原本可點擊的時鐘入口一併消失。員工必須手動輸入時間，容易誤以為欄位故障。

## What Changes

- 在補打卡「實際打卡時間」旁提供可點擊的時鐘按鈕。
- 按鈕開啟系統時間選擇器，選取後仍固定寫入並顯示 `HH:mm` 的 24 小時格式。
- 保留手動輸入 `1700`／`17:00` 的相容行為、17:00 預設值及既有上下班衝突防呆。

## Capabilities

### New Capabilities

- `makeup-time-picker`: 補打卡時間可透過時鐘選取，且選取結果固定為 24 小時 `HH:mm`。

### Modified Capabilities

- 無。

## Impact

- 影響 `records.html` 的補打卡表單與 `tests/makeup-punch-guidance.test.js`。
- 不改資料庫、RPC、LINE、排程、補卡規則或正式打卡流程。
