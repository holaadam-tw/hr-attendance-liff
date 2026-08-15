## Context

Migration 114 同時建立缺時計算、每日 09:15 cron 與 LINE 發送函式，並沿用既有 `attendance_audit_enabled` 決定掃描公司。正式環境既有公司已開啟該設定，因此只要套用 114，下一個排程時間就可能在主管尚未核對新缺時名單前發送訊息。

## Goals / Non-Goals

**Goals:**

- LINE 缺時通知預設關閉，只有公司管理者明確開啟後才發送。
- 主管可先執行公司限定的人工掃描，看到實際名單與分鐘數，且掃描絕不發通知。
- 人工掃描與設定讀寫都由具公司及管理權限驗證的 SECURITY DEFINER RPC 執行。
- 保留 09:15 自動掃描；開關只控制通知，不影響 anomaly 重新計算與自動結案。

**Non-Goals:**

- 不自動扣薪、不自動建立請假、不修改 attendance。
- 不改變晚到、早退、午休、半天假或時數假的計算規則。
- 不在本次操作正式資料庫或合併 main。

## Decisions

### 使用獨立通知設定，不重用 attendance_audit_enabled

新增 `system_settings.key='missing_work_hours_line_notifications_enabled'`。設定不存在、JSON false 或字串 false 均視為關閉。`attendance_audit_enabled` 繼續只表示要不要建立考勤 anomaly，避免因關閉 LINE 而停止資料核對。

替代方案是把既有 audit 設定關閉，但會連原本的缺卡追蹤一起停掉，故不採用。

### 通知開關必須由 RPC 讀寫

新增管理者讀取及更新 RPC，三支管理 RPC 都以專屬 `has_missing_work_hours_notification_access` 驗證同公司 admin／manager 或受派平台管理員，並明確排除公務機。平台管理員資料表不存在的精簡測試 schema 以 `to_regclass` 安全退讓。前端不直接寫 `system_settings`，避免 RLS、跨租戶與偽造 company_id 風險。

### 人工預覽是會更新 anomaly 的無通知掃描

新增公司限定掃描 RPC，只處理指定公司的員工與最近 1–7 天。它沿用 `calculate_missing_work_hours`，只 upsert／自動結案 `attendance_anomalies`，回傳處理數與待處理筆數；不呼叫 pg_net，也不修改通知時間、attendance 或 leave_requests。

相較純 SELECT 預覽，寫入 anomaly 能讓主管直接在既有追蹤卡逐筆檢查並處理，且與隔日排程使用同一份事實來源。

### 每日函式先掃描，再按公司通知開關過濾

Migration 115 重新定義 `run_daily_missing_work_hours_audit()`：仍先呼叫全域 scan，之後每家公司在讀 LINE Token 前先檢查新設定。關閉時回傳略過公司數，不會呼叫 `net.http_post`。既有員工／主管每日冪等標記維持不變。

### 管理介面集中在 attendance_overview.html

考勤異常卡永久顯示控制區，包含目前狀態、白話說明、「掃描但不通知」與開關。啟用必須二次確認已核對名單；停用立即生效。RPC 尚未部署時控制區顯示「資料庫功能尚未就緒」，不允許誤開。

## Risks / Trade-offs

- [114 與 115 若分開太久，114 的 cron 可能先執行] → 正式部署必須在非 09:15 時段連續套用 113、114、115，並在 115 後確認開關為 false。
- [人工掃描會建立 anomaly] → UI 明示「不通知、不改打卡或請假」，並提供掃描結果數量。
- [管理者誤開通知] → 啟用前顯示即將於每日 09:15 通知員工與主管的確認框；可隨時關閉。
- [既有 pending anomaly 在開啟後都可能通知] → 開啟前必須人工掃描並逐筆確認名單。

## Migration Plan

1. 在 dev 完成 migration 115、UI 與測試。
2. 在隔離測試專案套用 115，驗證預設關閉、掃描不通知、開啟／關閉及跨公司拒絕。
3. 正式維護時依序套用 113、114、115；三支 SQL 必須同一維護窗口完成。
4. 確認新設定不存在或 false、無 LINE 新請求，再人工掃描並核對名單。
5. 合併 main 部署管理 UI；主管確認後才從畫面開啟通知。
6. 回復時先將開關設為 false；必要時 unschedule `daily-missing-work-hours-audit`。不刪除時間欄位或 anomaly，以免資料遺失。

## Open Questions

無；通知預設關閉、主管人工核對後啟用已由業主確認。
