# P1 身分根治 Phase 1：LINE 驗證 → Supabase Auth session

> 狀態：PR 待審。**未套 135、未部署 line-auth、未改任何 Dashboard 設定。**
> Phase 1 只「建立 session＋記錄」，現有 RPC／政策／查詢行為一律不變。

## 為什麼
099／118／124／131… 等 RPC 用前端傳的 `p_line_user_id` 當身分，而 `employees.line_user_id` anon 讀得到 → 可冒充。
根治＝DB 從「Supabase Auth 簽發、PostgREST 驗過簽章的 JWT」取得 LINE userId（`caller_line_user_id()`）。

| 階段 | 內容 |
|---|---|
| Phase 1（本包） | line-auth 發 session；前端在**獨立 client** 持有；`caller_line_user_id()` 就位；只記錄 |
| Phase 2 | 各 RPC 包 soft mode：`caller_line_user_id()` 與 `p_line_user_id` 不符只記錄；前端逐頁改用 session client 呼叫 |
| Phase 3 | 強制：不符就拒絕，撤掉 anon 對這些 RPC 的 EXECUTE |

## 做法與選擇理由
**選擇：admin `generate_link`（type=magiclink，不寄信）＋ `POST /auth/v1/verify`（token_hash）換 session。**

- 不需要 JWT secret：session 由 Supabase Auth 自己簽發，refresh token 正常可用、可在 Dashboard 撤銷。
  自簽 JWT（需 JWT secret）會繞過 Auth 的 session 管理、無法 refresh，且 secret 外洩風險最高 → 不採用。
- 依 supabase/auth 原始碼（2026-09-28 讀 `internal/api/mail.go`／`verify.go`）：
  `adminGenerateLink` 不檢查 DisableSignup、不寄信、沒有頻率限制；magiclink 對「不存在的使用者」會自動改成 signup
  → 所以 line-auth **先用 admin API 建帳號**（`email_confirm: true`），再 generate_link，永遠不走自動 signup。
  `/verify` 以 `recovery_token` 比對 magiclink 的 token_hash、檢查過期與 banned，沒有檢查 Email provider 開關。
- `/verify` 有「每 IP 5 分鐘 N 次」限制（`token_verifications`，本機 config.toml 為 30），Edge Function 共用出口 IP：
  被 429 時 line-auth 改回傳 `token_hash`（mode=token_hash），前端自己 `verifyOtp` → 限制改算在使用者自己的 IP。
- 帳號 email＝`<LINE userId 小寫>@line-auth.invalid`（`.invalid` 保證不會是真信箱；只當內部識別，不寄信）。
  `app_metadata = { line_user_id, company_ids }`：只有 service role 改得到（使用者只能改 user_metadata）。
  `company_ids` 只是資訊，**Phase 2 不可拿來做授權**（可能過期）；授權一律用 DB 現查。
- 只替「在職員工或啟用中的平台管理員」建帳號（`line_auth_resolve.known`）；陌生 LINE 帳號 → 403 not_linked。

### 為什麼前端用「另一個」client
正式庫（2026-09-28 唯讀查）anon 與 authenticated 權限不同：bookings／requests／announcements 有只給 anon 的政策，
holidays／binding_audit_log 有只給 authenticated 的政策，另有 7 條政策用 `auth.uid()`／`auth.jwt()`。
若把 session 設到現有 `sb`，所有查詢會從 anon 變 authenticated → 行為改變。所以 Phase 1 的 session 放在
`storageKey: 'hr-line-auth-v1'` 的獨立 client，`sb` 完全不動（有真 supabase-js 測試證明）。

## 業主要在 Dashboard 確認的事（本 PR 不改任何設定）
| 位置 | 要確認 | 原因 |
|---|---|---|
| Authentication → Sign In / Providers → **Allow new users to sign up** | **關閉** | 開著的話任何人拿 anon key 就能 `/signup` 建帳號；line-auth 用 admin API 建帳號，不受這個開關影響 |
| Authentication → Sign In / Providers → **Allow anonymous sign-ins** | 關閉 | 同上 |
| Authentication → Sign In / Providers → **Email** | 保持啟用（預設）；「Confirm email」開關不影響（帳號建立時已 confirm） | 依原始碼 verify 不檢查這個開關，但**未在正式環境實測**；關掉前請先在測試專案試 |
| Authentication → Email → SMTP／Send Email Hook | 不需設定 | generate_link 不寄信 |
| Authentication → **Rate Limits → Token verifications** | 看目前值；30/5 分鐘（預設）可接受，首次上線若大量 429 可調到 150 | Edge Function 共用出口 IP；已有 token_hash 備援 |
| Authentication → Rate Limits → Token refreshes | 預設即可 | 算在使用者 IP |
| Authentication → Sessions（time-box／inactivity） | 若有設，session 到期後前端會自動再跑一次 line-auth | — |
| Authentication → 允許的 email 網域／Restrict email（若有） | 需允許 `line-auth.invalid`（或設 `LINE_AUTH_EMAIL_DOMAIN`） | 建帳號用 |
| Edge Functions → Secrets | 不需新增（用內建 SUPABASE_URL／SUPABASE_SERVICE_ROLE_KEY／SUPABASE_ANON_KEY）；可選 `LINE_AUTH_EMAIL_DOMAIN`、沿用 `LINE_LOGIN_CHANNEL_ID` | — |

## 上線步驟
1. 業主確認上表（特別是 **Allow new users to sign up = OFF**）。
2. 套 `migrations/135_line_auth_phase1.sql`（純新增 3 個函式；測試證明既有函式／政策／權限逐項不變）。
3. 部署：`supabase functions deploy line-auth`（verify_jwt 維持預設；前端以 anon key 當 Bearer 呼叫）。
4. 合併前端（本 PR；需在 #3、#4 之後）。`CONFIG.LINE_AUTH_MODE = 'shadow'` 起就會在背景建立 session。
5. 實機：在 LINE 開任一頁 → 開發者主控台 `lineAuthStatus` 應為 `verified_in_db`；再開一次應為 `reused`。
6. 觀察（唯讀 SQL）：
   ```sql
   SELECT count(*) FILTER (WHERE raw_app_meta_data ? 'line_user_id') AS line_users, max(last_sign_in_at) FROM auth.users;
   ```
   與在職員工數比對；Edge Function logs 看 409（identity_conflict／duplicate_auth_user）與 503。
7. 穩定後才開始 Phase 2。

## 回滾
- **最快**：前端 `CONFIG.LINE_AUTH_MODE = 'off'`（一行 commit）；單機可 `localStorage.setItem('line_auth_mode','off')`。
  關閉後頁面行為與現在完全相同（Phase 1 本來就不影響任何查詢）。
- Edge Function：`supabase functions delete line-auth`（前端遇 404 會退避 10 分鐘，不影響頁面）。
- DB：`migrations/135_line_auth_phase1_rollback.sql`（Phase 2 wrapper 上線後不可單獨回滾）。
- 已建立的 Auth 帳號：Dashboard → Authentication → Users 逐一刪除，或以 admin API 依 `app_metadata.line_user_id` 刪除；
  刪除會讓對應的 refresh token 失效，前端下次會自動重跑 line-auth（若仍啟用）。

## 已知限制／未驗證
- 未在正式環境實跑（無 LIFF token 可測、且不得部署）；generate_link／verify 的行為依原始碼與 supabase-js 型別，
  以及假 fetch 測試驗證。第一次部署後請依步驟 5 實機確認。
- LINE 帳號被停用／離職：Phase 1 不撤銷已發的 session（refresh token 仍有效到被刪或過期）；Phase 2 授權一律 DB 現查，
  不依賴 session 存在與否。需要時可在 Dashboard 刪該使用者。
  Phase 3 之前要補：line-auth 遇到 not_linked 但已有 Auth 帳號 → admin API 停用（ban）或登出該帳號。
