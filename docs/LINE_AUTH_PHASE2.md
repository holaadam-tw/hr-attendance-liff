# P1 身分根治 Phase 2：RPC 呼叫者身分 soft mode

> 狀態：PR 待審。**未套 141、未部署、未改任何 Dashboard 設定。**
> 預設 soft：套用後所有 RPC 的結果與套用前相同，只多記錄「呼叫者身分未經 Supabase Auth 證實」的次數。

## 做什麼
| 項目 | 內容 |
|---|---|
| `scripts/line-auth/generate-rpc-wrappers.js` | 讀 `rpc_inventory.json`（正式庫 pg_proc 唯讀快照）＋130～140 的撤權敘述 → 產生 `migrations/141_*.sql`、回滾檔、`wrapped_rpcs.json`；`--check` 比對 repo 內檔案是否被手改 |
| `migrations/141_line_auth_rpc_wrappers.sql` | 設定表、紀錄表、`assert_caller`、54 支 wrapper；開頭檢查清單與簽名，檔尾自我檢查 |
| `common.js` | 名單內的 RPC 在 LINE session 已建立（且屬於目前 LIFF 帳號、token 未過期）時改用 session client 呼叫；其他一律照舊 anon |

### wrapper
- 原函式改名 `<name>_impl`（本體、owner、search_path 設定不變），撤掉 PUBLIC／anon／authenticated 的執行權（service role 保留）
- 新的 `<name>`：參數（含預設值）、回傳型別、proacl 與原函式逐項相同；`SECURITY DEFINER`、`VOLATILE`；不設 search_path（原函式沿用呼叫端的 search_path，行為不變）
- 內容：`PERFORM public.assert_caller(p_line_user_id, '<name>')` → 原樣轉呼叫 `<name>_impl`
- ⚠️ 套用後要改某支 RPC 的邏輯，**請改 `<name>_impl`**；對 `<name>` 做 `CREATE OR REPLACE` 會把 wrapper 蓋掉

### assert_caller(p_line_user_id, fn)
1. 呼叫者不是 anon／authenticated（service role、pg_cron、DB 內部）→ 放行、不記錄
2. `caller_line_user_id()`（138，只採信 Supabase Auth 簽發 JWT 的 app_metadata）＝ `p_line_user_id` → 放行、不記錄
3. 否則查模式（`line_auth_caller_settings`：先找函式名，沒有就用 `*`）
   - `soft`（預設）：寫一筆 `line_auth_caller_log` 後放行；寫紀錄失敗（例如 PostgREST 的唯讀交易）也放行
   - `enforce`：`RAISE 42501 caller identity not verified`

`line_auth_caller_log` 欄位：`fn_name`、`provided_id_hash`（p_line_user_id 的 SHA-256，不存原文）、`claim_present`（JWT 有沒有合法的 LINE claim）、`claim_id_hash`、`caller_role`、`created_at`。
兩張表只有 service role 能讀寫；`assert_caller` 與 `*_impl` anon／authenticated 都不能直接呼叫。

## 清單（正式庫 2026-09-28 唯讀查詢）
帶 `p_line_user_id` 的函式 83 支：
- **包 wrapper 54 支**（52 個名稱，`get_leave_history`、`submit_leave_request` 各兩個多載）——完整清單見 `scripts/line-auth/wrapped_rpcs.json` 與 141 檔頭
- 排除 9 支：正式庫已是 service role only（`admin_save_setting`、`can_manage_company_settings`、`get_line_messaging_config`、`has_company_access`、`has_missing_work_hours_notification_access`、`is_company_admin_caller`、`line_pull_todo`、`line_push_authorize`、`platform_admin_save`）
- 排除 20 支：131／132 已撤 anon 執行權（`admin_*_employee` 3 支、`bind_*` 5 支、`check_*` 2 支、年度統計 2 支、`get_employee_payroll`、`get_monthly_attendance_v2`、`order_lunch`、`quick_check_in_debug*`／`_v2` 3 支、`sync_late_close_overtime_request`、`update_office_locations`）

產生器同時確認每支 wrapper 對象：SECURITY DEFINER、非 STRICT、anon 與 authenticated 權限相同、本體不讀 `auth.*`／角色、沒有其他物件依賴、owner 為 postgres——所以前端改用 authenticated 呼叫不會改變結果（postgres 有 BYPASSRLS，RLS 角色差異不影響 DEFINER 函式）。

## 前端涵蓋範圍
- 載入 `common.js` 的頁面：名單內 RPC 有 session 時帶 session 呼叫（`window.lineAuthRpcCounts` 可看 session／anon 次數）
- **不載入 `common.js` 的頁面仍是 anon**（soft 紀錄會一直有「沒有 session」）：
  - `attendance_public.html`：`create_shift_type`、`delete_shift_type`、`update_shift_type`、`get_attendance_anomalies`、`get_company_daily_attendance`、`get_company_holidays`、`get_company_leave_requests_for_audit`、`get_company_monthly_attendance`、`get_company_shift_types`、`get_makeup_review_requests`、`get_pending_makeup_requests`、`get_weekly_schedules`、`resolve_attendance_anomaly`
  - `employee_register.html`：`register_employee`（還沒綁定的新員工本來就沒有 session → 預先設為 soft）
- 關閉：`CONFIG.LINE_AUTH_RPC = 'anon'`（或單機 `localStorage.setItem('line_auth_rpc','anon')`）；`CONFIG.LINE_AUTH_MODE = 'off'` 也會一併關閉

## 上線步驟（業主執行）
1. 前提：#3 → #5 → #4 → #6 → #7 都已上線（特別是 131／132／138；141 開頭會檢查，缺一項就中止、不改任何東西）
2. 套 `141`（soft）。檔尾自我檢查失敗會整筆回復
3. 合併前端（本 PR）
4. 觀察（唯讀，service role／SQL Editor）：
   ```sql
   -- 每支 RPC 每天：沒有 session 的次數、有 session 但不符的次數
   SELECT fn_name, date_trunc('day', created_at) AS d,
          count(*) FILTER (WHERE NOT claim_present) AS no_session,
          count(*) FILTER (WHERE claim_present) AS mismatch
   FROM public.line_auth_caller_log
   WHERE created_at > now() - interval '7 days'
   GROUP BY 1, 2 ORDER BY 2 DESC, 3 DESC;
   ```
   - `mismatch` 應接近 0；不是 0 的要逐一查（前端傳了別人的 LINE userId？換帳號？）
   - `no_session` 會隨 line-auth 普及下降；剩下的主要來自上面列的兩個頁面
5. 紀錄清理（可選，service role）：`DELETE FROM public.line_auth_caller_log WHERE created_at < now() - interval '30 days';`

## 切 enforce 之前（本 PR 不做）
1. Phase 1 文件列的前置條件：離職／停用時停用 Auth 帳號、評估關閉自設密碼登入（否則 enforce 只證明「曾經通過 LINE 驗證的那個人」）
2. `attendance_public.html`、`employee_register.html` 改用 session（或另設計）
3. 紀錄顯示該支 RPC 近 7 天 `no_session`＝0、`mismatch`＝0
4. 逐支切：`INSERT INTO public.line_auth_caller_settings (fn_name, mode) VALUES ('get_my_payslip', 'enforce') ON CONFLICT (fn_name) DO UPDATE SET mode = EXCLUDED.mode, updated_at = now();`
   全部切：`UPDATE public.line_auth_caller_settings SET mode = 'enforce', updated_at = now() WHERE fn_name = '*';`
   （`register_employee`、`log_checkin_failure` 已預先設為 soft，全部切時不受影響）
5. 回到 soft：同上把 mode 改回 `'soft'`（立即生效，不需部署）

## 回滾
- 最快（不動 DB）：前端 `CONFIG.LINE_AUTH_RPC = 'anon'`；DB 端本來就是 soft，不擋任何呼叫
- enforce 出問題：把 mode 改回 soft（見上）
- DB：`migrations/141_line_auth_rpc_wrappers_rollback.sql`——還原 54 支原函式的名稱與權限（正式庫 proacl），刪掉 wrapper、`assert_caller`、兩張表（紀錄會一起刪；需要的話先匯出）
- 測試證明回滾後所有 public 函式的定義、SECURITY DEFINER、volatility、設定、權限與套用前逐項相同

## 已知限制／未驗證
- 未在正式環境實跑（不得套用／部署）；PGlite 以正式庫簽名／proacl 建立替身，正式庫原文只有打卡／補卡 4 支
- 呼叫者角色判斷依 `current_setting('role')`（PostgREST 以此切換角色），JWT `role` 為備援；兩者在 PGlite 都驗過，正式環境需以紀錄確認（套用後若 anon 呼叫卻完全沒有紀錄，表示判斷失效）
- wrapper 一律 VOLATILE：原本 STABLE 的 RPC 由 PostgREST 改用讀寫交易執行（結果不變）；前端沒有用 GET 呼叫 RPC
- DB 內部互相呼叫的 RPC（`quick_check_out_after_clock_in_makeup` → `quick_check_in`、`submit_leave_request` 多載、`count_fw_trackpoints` → `get_fw_trackpoints`）在 soft 下同一次請求可能記兩筆
