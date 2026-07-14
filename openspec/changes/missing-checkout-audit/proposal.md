# 缺卡稽核系統（missing-checkout-audit）

## 問題

員工下班忘記打卡時，該筆 attendance 的 `check_out_time` 永遠是 NULL，沒有任何流程會再碰到它：

- 員工自己不會發現（隔天照常打新的上班卡，051 已允許）
- 會計要到算薪水時才發現工時缺漏，再逐一追人
- 「忘記打卡」和「提早離開/請假」混在一起，無法區分

## 目標

1. 下班沒打卡 → **隔天早上自動 LINE 通知**會計（管理群組）和員工本人
2. 員工擇一處理：**補打下班卡**（makeup_punch_requests）或**補請假**（leave_requests）
3. 會計在**打卡總覽（attendance_public.html）**看到待處理清單，核准後**自動結案**
4. 未處理前每天重複提醒，拖延 3 天以上在群組彙總標記 ⚠️

## 方案

採 pg_cron + plpgsql + pg_net 直接推 LINE Messaging API（原提案 B 為新 Edge Function，
改為 SQL-only 原因：部署路徑單純——只需套一支 migration，不需 Supabase CLI 部署與新 secret 管理；
pg_net 無瀏覽器 CORS 限制，可直接呼叫 api.line.me）。

### 元件（migration 092）

| 元件 | 說明 |
|------|------|
| `attendance_anomalies` 表 | 追蹤缺卡：pending/resolved、通知次數、結案方式（makeup/leave/manual）。RLS 開啟且無 anon policy |
| 自動結案 trigger ×2 | attendance 補上 check_out_time（補卡核准/手動修正）；leave_requests 核准且涵蓋缺卡日 |
| `scan_missing_checkouts()` | 掃近 3 天缺下班卡。排除：跨日班仍在下班窗口（+6h 緩衝，隔天補抓）、no_checkin、is_kiosk、離職、已核准請假涵蓋當日。僅掃 `attendance_audit_enabled=true` 的公司 |
| `run_daily_attendance_audit()` | 掃描 + 員工 DM（依 preferred_language 中/越文，附補卡與補請假 LIFF 連結，每日最多一次）+ 管理群組彙總（拖延 ≥3 天標 ⚠️）。REVOKE anon/authenticated |
| `get_attendance_anomalies()` | 前端讀取：pending + 近 7 天 resolved，附 pending_action（補卡待審/請假待審/待員工處理）。admin/manager 驗證（071 模式） |
| `resolve_attendance_anomaly()` | 手動結案（admin/manager） |
| pg_cron | `daily-attendance-audit`，01:10 UTC = 台灣 09:10 |
| 啟用旗標 | system_settings `attendance_audit_enabled` = true，**僅大正科技** |

### 前端（attendance_public.html）

- 今日分頁新增「⏰ 缺卡追蹤」卡片：**僅大正科技 + 管理員模式**顯示
  （`companyId === DACHENG_COMPANY_ID && isManagerRole && !viewingAsEmployee`）
- 每列：日期、員工、第 N 天、已提醒 N 次、狀態膠囊（待員工處理/補卡待審/請假待審）、手動結案按鈕
- 近 7 天已結案以灰字列出（讓會計看到自動結案軌跡）
- zh/vi 雙語

### 附帶：素食提醒文案改清楚

原文案「2026/07/14 農曆初一（今天）／初一 / 十五前 3 天，請提醒需要素食的員工。」語意不清。
改為依情境的完整句子：

- 當天：「今天（07/14，週二）是農曆初一」＋「今日訂便當請確認：吃素的員工要改訂素食便當。」
- 即將到來：「N 天後（MM/DD，週X）是農曆十五」＋「請提前提醒吃素的員工，當天記得改訂素食便當。」

## 產品決策（已於對話確認）

- 系統**不自動判斷**補卡 vs 補請假（無法區分忘打與早退），由員工自選、主管審核把關
- 追蹤 UI 放在打卡總覽、僅大正科技
- 通知對象：員工本人 DM + 既有管理群組（line_messaging_api.groupId）

## 風險與緩解

- pg_net 未啟用 → migration 內 `CREATE EXTENSION IF NOT EXISTS pg_net`；套用後需在正式庫手動跑一次 `SELECT run_daily_attendance_audit();` 驗證
- 員工未加 LINE 好友 → DM 推播失敗（LINE API 回錯），但群組彙總與頁面清單仍在
- 「上班卡也沒打（全日缺卡）」不在本次範圍（屬缺勤，另案處理）
