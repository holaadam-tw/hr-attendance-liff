## Why

Migration 114 目前會在套用後直接建立每日 09:15 排程，既有 `attendance_audit_enabled` 公司可能在主管尚未核對名單前就收到 LINE 缺時提醒。正式上線前需要一個預設關閉、可先人工掃描且不通知的安全閘門。

## What Changes

- 新增公司層級的「缺時 LINE 提醒」開關，設定不存在或為 false 時一律不發員工或主管訊息。
- 新增公司限定、具管理權限驗證的人工缺時掃描 RPC；掃描只建立或更新缺時 anomaly，不送 LINE、不改 attendance、不自動建立請假。
- 在管理端考勤異常卡加入「掃描但不通知」按鈕、開關狀態及啟用前確認提示。
- 保留每日 09:15 掃描排程，但只有已明確開啟通知的公司才會進入 LINE 發送流程。
- 補上預設關閉、跨租戶拒絕、人工掃描無通知與開關冪等回歸測試。

## Capabilities

### New Capabilities

- `missing-work-hours-notification-control`: 管理缺時名單人工掃描、LINE 通知開關、預設關閉及公司隔離行為。

### Modified Capabilities

無。

## Impact

- 新增 `migrations/115_gate_missing_work_hours_notifications.sql`。
- 修改 `attendance_overview.html` 內嵌的考勤異常追蹤卡；本變更不需調整共用 `common.js` 或其快取版本。
- 擴充時數假／缺時測試、OpenSpec、BUG_TRACKER、TEST_SCENARIOS 與架構記憶。
- 不變更正式打卡、薪資、請假核准規則；不立即發送 LINE，也不在本次套用正式資料庫。
