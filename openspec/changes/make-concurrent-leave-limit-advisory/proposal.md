## Why

目前系統把「同時請假人數上限」當成硬性限制，達到門檻後員工無法送出申請；實務上遇到多人確實需要同日請假時，會讓申請流程中斷，也使主管無法依當日人力狀況做個別決定。

## What Changes

- 將既有 `max_concurrent_leave` 設定由「禁止送出的上限」改為「同時請假警告門檻」。
- 申請後若預計同時請假人數超過門檻，員工仍可送出，申請維持待審並由主管核准或駁回。
- 員工端在日期檢查及送出成功時顯示明顯的人力警告，但不得停用送出按鈕。
- 管理端沿用既有 1–10 人設定與資料鍵，改寫名稱及說明，明確表示設定只負責提醒、不會自動駁回。
- 保留公司隔離、重疊日期計算與既有請假 RPC，不新增資料表、欄位、RPC 或資料庫 migration。

## Capabilities

### New Capabilities

- `concurrent-leave-advisory`: 定義同時請假人數超過公司門檻時的警告、送出與主管審核行為。

### Modified Capabilities

<!-- 無既有正式 capability 需要修改。 -->

## Impact

- 前端：`common.js`、`records.html`、`admin.html`、`modules/leave.js`。
- 測試：新增同時請假警告門檻專項回歸，並納入完整測試入口。
- 文件：更新 Bug Tracker、架構記憶與本次 OpenSpec。
- 相容性：沿用 `system_settings.max_concurrent_leave`，不需資料轉換；既有公司設定數值會直接成為警告門檻。
