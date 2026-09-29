# P1 身分根治：Phase 2／3 前置三件事（145／146／147）

> 狀態：PR 待審。**未套 145／146／147、未部署 line-auth、未改任何 Dashboard 設定（含 Auth Hooks）。**
> 對應 `docs/LINE_AUTH_PHASE1.md` 末段「Phase 2／3 之前必須先處理」的 1～3 項。

| # | 做什麼 | 檔案 | 生效方式 |
|---|---|---|---|
| 1 | 每次呼叫都在 DB 現查在職 | `migrations/145_line_auth_live_identity.sql` | 套 145 即生效 |
| 2 | 離職／停用 → 停權（ban）Auth 帳號；line-auth 拒發 session | `supabase/functions/line-auth/handler.ts`、`migrations/146_line_auth_reconcile_cron.sql`（145 的 D 段） | 部署 line-auth → 套 146 |
| 3 | 擋「LINE 帳號改用密碼登入」 | `migrations/147_line_auth_password_block_hooks.sql` | 套 147 → **Dashboard 啟用 Hook** |

## 1. 現查在職（145）

- `caller_line_user_id()` 簽名、回傳型別、權限都不變，只是多了兩個「每次呼叫都查」的條件：
  1. JWT 的 `sub` 在 `auth.users` 找得到、未刪除、未停權，且那一列的 `app_metadata.line_user_id` 仍是同一個
  2. `line_auth_identity_is_active()`：在職員工（`is_active`、有公司）或啟用中的平台管理員（＝`line_auth_resolve` 的 known）
  - 任一不成立 → NULL。離職設定存檔的**下一個請求**就失去身分，不必等 JWT 過期、也不依賴第 2 項的停權。
- 改成 `SECURITY DEFINER`（擁有者 postgres）才能讀 `auth.users`／`employees`；只讀呼叫者自己的 JWT，不接受參數。
- **與 #8／141 的關係：不需要改 141。** 141 的 `assert_caller` 直接呼叫 `caller_line_user_id()`，改這一支，54 支 wrapper 全部跟著生效。
  - 141 開頭只檢查 `caller_line_user_id()` 存在；指紋比對的是 54 支 RPC 本體，不含這一支 → 145 與 141 **誰先套都可以**。
  - 145 沒有出現任何 wrapper 名稱，不會觸發 #8 的 `line-auth-phase2-guard` 防呆。
  - 測試：`MIGRATION141_FILE=<#8 的 141>` 跑 `tests/line-auth-prereq.pglite.test.js`，取出 141 的 `assert_caller` 實跑——enforce 下「同一個 JWT、設為離職當下」就 42501（本 PR 已用 #8 head `fa10f44` 的 141 跑過，全過）；#8 合併後這段會自動跑。
- 新增 `caller_company_ids()`：呼叫者「現在」所屬公司。**Phase 3 做公司層級授權請用它**，不要用 JWT 的 `company_ids`（可能過期）。
- 公司本身停用（`companies.status`）不在 known 的定義內（與 138 相同）；是否要一併擋，屬各 RPC 的授權判斷。

## 2. 離職／停用 → 停權（ban）

### 會讓人「不再在職」的路徑（正式庫 2026-09-30 唯讀查）
`admin_update_employee`（is_active／status=resigned）、`platform_admin_save`（平台管理員停用）、`bind_*` 系列（改綁 LINE）、
`admin_delete_pending_employee`、`register_employee`、`upsert_salary_setting`、`platform_company_*` 等十幾支函式會寫 employees／platform_admins／companies，
另外還有 Dashboard／service role 直接改資料。

### 設計：依「結果」比對，不掛在每一條寫入路徑上
- **145 D 段**：`line_auth_reconcile_targets()` 列出「有 LINE Auth 帳號、未停權、但 `line_auth_identity_is_active` 為 false」的帳號（只給 service role）。
- **line-auth `{"action":"reconcile"}`**：逐一以 admin API `PUT /auth/v1/admin/users/{id}` 停權（`ban_duration: 876000h`），
  並在 `app_metadata` 標 `line_auth_banned: true`。每次最多 50 筆、冪等；回應不含 user id。
- **146**：pg_cron 每 5 分鐘，**只有** `line_auth_reconcile_needed()` 為 true 時才用 pg_net 呼叫 reconcile（平常零 HTTP）。
- **line-auth 登入時**：
  - 不在職但已有 Auth 帳號 → 停權後回 403 `not_linked`（已停權的不動）
  - 在職、帳號是**本機制**停權的（有標記）→ 自動解除（`ban_duration: none`、清標記）再發 session＝回任不用人工處理
  - 在職、帳號是**人工**停權的（沒有標記）→ 403 `account_disabled`，不解除

### 取捨
| 選項 | 為什麼沒選／選了 |
|---|---|
| employees 觸發器直接改 `auth.users.banned_until` | 直接寫 Auth 內部表不是官方支援做法；而且觸發器失敗會讓員工資料存不進去 → 不採用 |
| 觸發器＋pg_net 即時呼叫 | 要在每一條寫入路徑的交易裡打網路；一樣有「連帶讓存檔失敗」的風險 → 不採用 |
| 在各 RPC 裡加呼叫 | 路徑十幾條、還有 Dashboard 直接改，一定漏 → 不採用 |
| **排程依結果比對（採用）** | 所有路徑一次涵蓋；員工資料的寫入完全不受影響。延遲最多約 5 分鐘，但**即時性由第 1 項保證**（DB 現查），停權只是第二道 |
| ban vs 刪除 | **ban（可逆）**：回任自動解除、紀錄保留；刪除會讓 `auth.users` 的對應消失、回任要重建 |

- reconcile 用 anon key 就能觸發（前端已公開的同一把）：它只依 DB 現況停權「已不在職」的帳號、冪等，任何人觸發都停權不到在職者；
  最多只是多一次 DB 查詢。
- 停權後 refresh 會被 Auth 拒絕；手上還沒過期的 access token 在第 1 項下也已經沒有身分。
- 關閉：Edge Function secret `LINE_AUTH_RECONCILE_DISABLED=true`（只停 reconcile）；或回滾 146。

## 3. 擋「LINE 帳號改用密碼登入」（147，要在 Dashboard 啟用）

官方文件（2026-09-30 讀 `supabase.com/docs/guides/auth/auth-hooks`）的方案支援：

| Hook | 方案 |
|---|---|
| **Custom Access Token** | **Free、Pro**（本 PR 主要用這個） |
| Password Verification Attempt | **僅 Team／Enterprise** |

> 本專案的方案我查不到（CLI 沒有顯示），**請業主在 Dashboard → Organization → Billing 確認**。Pro 以下只啟用 A 即可。

- **A. `public.line_auth_access_token_hook`（Custom Access Token）**：每次簽發 access token（登入與 refresh）都會經過。
  只處理 `app_metadata.line_user_id` 有值的帳號：`authentication_method = password`，或 `amr` 含 otp／magiclink 以外的方法 → 回 `{"error":{"http_code":403}}`，不發 token。
  用密碼建立的 session 連 refresh 都換不到新 token。line-auth 的正常流程（magiclink verify，正式庫 `mfa_amr_claims` 目前只有 `otp`）與 refresh 放行，claims 一字不改。
  非 LINE 帳號完全不動；非預期輸入一律原樣放行（避免 Hook 本身變成全站登入故障點）。
- **B. `public.line_auth_password_verification_hook`（Password Verification Attempt，Team／Enterprise）**：LINE 帳號一律 reject＋登出；其他 continue。方案支援才啟用，有 A 就夠。
- 使用者仍能設定密碼（Auth 沒有「改密碼」的 Hook），但設了也無法用來換 token。

### 啟用步驟（業主，Dashboard）
1. 先套 147（SQL Editor）。
2. Dashboard → **Authentication → Hooks** → **Custom Access Token** → Add hook → 類型 **Postgres** → schema `public` → function `line_auth_access_token_hook` → 啟用。
3. 馬上驗證（LINE 內開任一頁）：開發者主控台 `lineAuthStatus` 仍為 `verified_in_db`／`reused`；Auth logs 沒有 hook 錯誤。
   - 有問題 → 同一頁把 Hook **停用**（立即恢復，不需要動 DB）。
4. （Team／Enterprise 才做）**Password Verification Attempt** → Postgres → `public.line_auth_password_verification_hook` → 啟用。
5. ⛔ 要回滾 147 之前，**先在 Dashboard 停用 Hook**，否則所有登入／refresh 都會失敗。

## 上線順序
前提：138 已套、line-auth Phase 1 已上線；**Allow new users to sign up 已關閉**（Phase 1 的硬性閘門）。

1. 套 **145**（純新增＋改寫 `caller_line_user_id`；141 未套前沒有任何 RPC／政策用它，只有 `line_auth_whoami` 會讀）。
2. 部署 line-auth：`supabase functions deploy line-auth`（本 PR 的 handler）。
3. 套 **146**（排程）。觀察：
   ```sql
   SELECT public.line_auth_reconcile_targets(50);   -- service role／SQL Editor；total 應在 5 分鐘內變 0
   SELECT count(*) FILTER (WHERE banned_until > now()) AS banned,
          count(*) FILTER (WHERE raw_app_meta_data ->> 'line_auth_banned' = 'true') AS banned_by_line_auth
   FROM auth.users;
   SELECT status_code, count(*) FROM net._http_response WHERE created > now() - interval '1 hour' GROUP BY 1;
   ```
4. 套 **147** → Dashboard 啟用 Custom Access Token Hook（見上）。
5. 與 #8：合併順序不拘（145 不改 141；兩邊檔案沒有衝突）。#8 合併後，本 PR 的 141 相容測試會自動執行。

## 回滾
- 145：`145_line_auth_live_identity_rollback.sql`（`caller_line_user_id` 還原成 138 原文；146 排程還在會中止）。要回滾 138 前必須先回滾 145。
- 146：`146_line_auth_reconcile_cron_rollback.sql`（只移除排程）。
- 147：**先停用 Dashboard Hook**，再 `147_line_auth_password_block_hooks_rollback.sql`。
- 解除某個人的停權：Dashboard → Authentication → Users → 該使用者 → Unban；或讓他（在職狀態下）重新從 LINE 開頁面（本機制停權的會自動解除）。

## 已知限制／未驗證
- 未在正式環境實跑（不得套用／部署）。GoTrue 行為（ban 後 refresh 被拒、`app_metadata` 逐鍵合併且 `null` 刪鍵、Hook 的輸入欄位）依官方文件與原始碼，
  以假 fetch／PGlite 驗證；**第一次上線請照上面的觀察 SQL 與步驟 3 實機確認**。
- 146 的排程指令在 PGlite 以 pg_net 替身實跑（pg_cron 不存在於 PGlite）；排程本身只做靜態檢查。
- Password Verification Hook 的方案支援依官方文件；本專案方案未確認。
