# RunPiston Bug 追蹤 & 測試清單

> 更新日期：2026-08-04
> 每次修改後更新此檔案

---

## 🔴→🟢 2026-08-04 「有打卡但系統說沒打卡」根因調查＋打卡失敗記錄（migration 105）

業主回報「很多員工說有打卡，隔天系統說沒打卡」。查正式庫近 120 天大正資料：

| 補卡來源 | 筆數 |
|---------|------|
| GPS 精確度不足自動轉待審 | 70 |
| GPS 超出範圍自動轉待審 | 43 |
| 員工真的忘記打卡才申請 | 21 |

**84% 的「補卡」其實是有打卡但沒進系統**：GPS 失敗時不寫 attendance，只送待審申請，員工看到「✅ 已送出待審核」以為打好了；主管核准平均要 53–75 小時（最長 504 小時＝21 天），這期間打卡總覽與缺卡稽核都算他沒打卡。

`checkin.html` 送出待審時**沒有呼叫 `sendAdminNotify`**，主管不會收到通知，待審件因此長期躺著——這是延遲的根因。

集中在 3 人（佔 95%）：E818 56 筆／E820 40 筆／E815 11 筆，平均定位誤差 900–1200m、E813 達 5124m（系統門檻 500m）。誤差 1000m 以上是**手機關閉「精確位置」**的典型特徵；E815 誤差不大但固定超範圍約 400m，屬打卡半徑或座標問題。

### 上班／下班的 GPS 規格不一致（本次查證釐清）

| 檢查項目 | 把關位置 | 上班 | 下班 |
|---------|---------|------|------|
| GPS 精確度 500m | 前端 `checkin.html` 常數 | ✅ | ✅（同一條規則） |
| 打卡範圍（地點半徑） | DB `quick_check_in` | ✅ | ❌ **完全不驗** |

原因：`quick_check_in` 的下班分支處理完就 `RETURN`，而地點範圍比對寫在其後，下班的執行流程走不到。資料佐證：43 筆「超出範圍」全部是上班卡，下班 0 筆。

副作用：`check_out_location` 寫的是 `COALESCE(v_matched_location, check_in_location)`，而 `v_matched_location` 在該時點必為 NULL → **下班地點永遠複製上班地點，不可信**（真實座標有存在 `checkout_latitude/longitude`）。

### 下班打不了卡的真正主因：21:00 時間牆（已解）

`checkout_time_limit_hours` 大正原本**沒有設定** → 走程式預設 4 小時；全部 23 位員工 `fixed_shift_end` 都是 17:00 → 截止 21:00，超過顯示「超過時限，請申請補卡」且 `canRetry: false`。

而實際加班狀況離這道牆只剩十幾分鐘：

| 員工 | 19 點後下班次數 | 最晚打卡 |
|------|--------------|---------|
| 鄭世福（E824） | 44 | 20:44 |
| 范文林（E814） | 17 | 20:42 |
| 謝秉夆（E812） | 9 | 20:48 |

| 處置 | 狀態 |
|------|------|
| `checkout_time_limit_hours` 設為 8（截止 01:00） | ✅ 已寫入正式庫（2026-08-04，設定即時生效不需部署） |
| 移除「打卡測試」打卡地點（半徑 300m，大里區現岱路 12 號） | ✅ 已移除。近 180 天僅 2 筆使用、最後一次 2026-05-18；正式打卡全走「工廠」600m（749 筆）。只影響上班（下班本就不驗範圍） |

### migration 105：打卡失敗記錄（把黑洞變成資料）

失敗路徑原本**完全不留痕**，系統分不出員工是忘了打、還是打了打不進去。

| 項目 | 狀態 | 說明 |
|------|------|------|
| `checkin_failures` 表 | ⏳ 待套正式庫 | deny-all RLS（ENABLE RLS 無 policy ＋ REVOKE ALL FROM PUBLIC/anon/authenticated，比照 094）；`company_id`/`employee_id` 皆有外鍵 |
| `log_checkin_failure()` | ⏳ 待套 | GRANT anon。**employee 與 company 由 DB 依 line_user_id 認定**，前端傳的 `p_company_id` 只用來縮小跨公司員工的查找範圍（098 模式），無法偽造歸屬；查無員工直接不寫入（擋 anon 灌資料）；`EXCEPTION WHEN OTHERS` 吞錯 |
| `get_checkin_failures()` | ⏳ 待套 | GRANT anon，admin/manager 限定（092 模式），限本公司、上限 300 筆 |
| `outcome` 兩種語意 | ✅ 刻意區分 | `blocked`＝完全打不進去；`pending_review`＝有送出但變成待審（員工看到成功畫面、系統仍算沒打卡，抱怨主要來源） |
| checkin.html 記錄點 | ✅ 完成待上線 | 10 個呼叫點涵蓋兩個拍照流程：GPS 取得失敗／精度異常／轉待審／RPC 失敗／拍照／系統例外。全部 fire-and-forget 不 await、內部包 try/catch，**任何情況都不影響打卡本身**；待審錯誤加 `_logged` 旗標避免外層 catch 重複記錄 |
| attendance_overview.html | ✅ 完成待上線 | 「🚫 打卡失敗記錄（近 7 天）」卡片：badge 顯示打不進去／轉待審次數，依原因分組計數，可展開明細（時間、員工、上下班、原因、精度／距離／截止時間） |
| 保留期限 | ⚠️ 未做自動清除 | 量級極小（每天數筆，一年約 2000 筆），暫不需 pg_cron |
| rls-checker | ✅ 通過 | deny-all 完整、無法偽造歸屬、無跨公司外洩、無 RECORD NULL 陷阱、不影響打卡主流程。依其建議補上 `company_id` 外鍵並移除待審路徑上多餘的 `await` |

## 🟢 2026-08-04 管理員代補打卡（不限日期）— 補上「員工 7 天／管理員不限時間」政策的缺口

**業主政策**：員工限 7 天內自助補打卡，管理員不限時間都可以補。

盤點發現前半已成立、後半根本做不到：

| 項目 | 盤點結果 |
|------|---------|
| 員工端 7 天 | ✅ 本來就有。`common.js:119 MAKEUP_PUNCH_WINDOW_DAYS = 7`（含當天，最早 today−6）＋ `records.html` 日期選擇器 min/max ＋ DB 端 097/098 `submit_makeup_punch` 同窗口驗證，繞前端也送不進來 |
| 管理員不限時間 | 🔴 **原本不存在**。管理員只有三種操作，沒有一種等於「補」：①`approve_makeup_request`(086) 不看日期但前提是員工當初有送出；②缺卡追蹤「手動結案」(092) 只停追蹤不寫 attendance，該日下班時間仍空、工時算不出；③直接改 DB。全庫 grep `admin_*_attendance` / `update_attendance` 無任何管理端補登 RPC |

| 修正 | 狀態 | 說明 |
|------|------|------|
| migration 104 `admin_makeup_punch` | ✅ 已套正式庫（2026-08-04） | SECURITY DEFINER，GRANT anon/authenticated。呼叫者須為 `p_company_id` 底下 is_active 的 admin/manager（092 驗證模式）；目標員工須屬同一家公司（二次隔離）；**無回溯下限**但擋未來日期；寫入 attendance（比照 086）＋ 留一筆 `status='approved'` 的 makeup_punch_requests 軌跡（reason=管理員補登、approver_id=操作者）＋ 關掉同員工同日同類型的 pending 申請（避免之後又被核准重寫一次）＋ 結案 attendance_anomalies |
| 工時計算 | ✅ 刻意不自算 | `total_work_hours` 交給 `trg_calc_work_hours`（010，096 改為含午休扣除）這個單一事實來源；RPC 內自算只會被 trigger 覆蓋，還可能與午休規則不一致 |
| 缺卡結案 resolved_by | ✅ 已處理 edge case | 補下班卡時 092 的 `trg_resolve_anomaly_on_checkout` 會**先**自動結案，`resolved_by` 留空（trigger 不知道操作者）。104 的結案條件因此改為 `status='pending' OR (resolved AND resolution='makeup' AND resolved_by IS NULL)`，兩種情況都涵蓋且冪等；靠 `UNIQUE(employee_id, date, anomaly_type)` 保證只命中一筆 |
| 前端入口 | ✅ 完成待上線 | `attendance_overview.html`：①頁頭「✏️ 代補打卡」通用表單（員工／任意日期／上班或下班／時間／備註）；②缺卡追蹤每筆待處理加「補登下班」快捷鍵，帶入該員工與日期。日期欄只設 `max`（不能補未來）**不設 min**，與員工端刻意不同 |
| 放哪一頁 | ✅ 業主指定只放舊版後台頁 | 兩個打卡總覽頁並存（見 2026-07-31 條目）；本次只做 `attendance_overview.html`（admin.html 入口），`attendance_public.html` 未動 |
| rls-checker | ✅ 通過 | 兩層租戶隔離（操作者驗證綁 company_id、目標員工再驗一次）皆確認無法跨公司寫入；RECORD 判斷全用欄位級；與既有 trigger 無重複計算。唯一標記為既有技術債：`employees` 表 RLS Phase 3 未完成，前端 `sb.from('employees')` 的 company_id 隔離目前僅客戶端強制（非本次引入） |

**部署順序**：migration 104 必須**先**套正式庫，再合併 main。反過來會讓上線的按鈕打到不存在的函式。已依此順序執行完畢（104 套用 → 合併 main `71376c0` → curl 線上驗證新元素已上線）。

### 正式庫實測（2026-08-04，測試資料事後全清、四項計數歸零）

| # | 測試 | 結果 |
|---|------|------|
| 1 | 無 `p_line_user_id` | ✅ `未提供身份驗證資訊` |
| 2 | 一般員工 line_user_id 冒用 | ✅ `需要管理員權限` |
| 3 | 大正 company_id ＋ 本米員工 id | ✅ `找不到員工（或不屬於本公司）` ← 真正的跨租戶防線 |
| 4 | 未來日期（2026-08-05） | ✅ `punch_date_in_future` |
| 5 | 無效 punch_type | ✅ `invalid_punch_type` |
| 6 | 補 **2025-01-05** 上班卡（1 年半前，遠超 7 天窗口） | ✅ 成功。DB 存 `00:00+00` = 台灣 08:00，時區換算正確 |
| 7 | 補下班卡（同日已有 pending 待審申請） | ✅ 成功，`closed_pending: 1`，該 pending 被改 rejected、`rejection_reason=管理員已直接補登，無需再審核` |
| 8 | 工時 trigger（大正午休 12:00–13:00） | ✅ 08:00→17:00 = **8.00**（9h 扣 1h 午休），096 規則生效 |
| 9 | 覆蓋既有下班時間（改 18:00） | ✅ `overwrote: true`，工時重算為 **9.00** |
| 10 | 軌跡 | ✅ 3 筆 `approved`（reason=管理員補登（Adam）、有 approver_id）＋ 1 筆被關掉的 pending |

⚠️ **測試設計陷阱（記錄備查）**：原本想測「大正 admin 帶本米 company_id」應被擋，結果回傳成功。查證後是**測試設計錯誤不是漏洞**——業主的 LINE 帳號在兩家公司都有 admin 身分（大正 `admin` / 本米 `admin-benmi`），驗證邏輯「操作者必須是所帶 company_id 的 admin」本來就該通過。跨租戶的真正防線是第 3 項（company_id 與目標員工不同家）。日後做跨公司隔離測試時，操作者不能挑跨公司帳號。

小觀察（非 bug，與 086 行為一致）：同一天重複補登時 `attendance.notes` 會逐次附加，出現重複字串。

### 2026-08-04 兩筆手動結案缺卡恢復為待處理（業主要求）

業主要用新的管理員補打卡功能處理，故把 08/03 手動結案的兩筆改回 `status='pending'`（`resolution` / `resolved_at` / `resolved_by` 一併清空）：

| 日期 | 員工 | 上班卡（台灣時間） | 下班卡 |
|------|------|-----------------|--------|
| 2026-07-13 | Hoàng Thái Hoà（E818） | 07:46 | 無 |
| 2026-07-16 | 邱順麟（E815） | 08:18 | 無 |

⚠️ 恢復為 pending 後，092 的每日稽核排程（台灣 09:10）會**重新對這兩位員工發 LINE 缺卡提醒**（notify_count 已達 20 / 18）。補登下班卡後會自動結案、提醒停止。

## 🔴→🟢 2026-08-03 公司層級 RPC 無呼叫者驗證（跨公司資料外洩，已修）

**這是目前找到最嚴重的一個洞，比 anon 可直讀資料表更嚴重**——`SECURITY DEFINER` 本來就繞過所有表層保護。

| 項目 | 狀態 | 說明 |
|------|------|------|
| 問題 | 🔴 已確認（實測） | `get_company_daily_attendance`(095)、`get_company_monthly_attendance`(095)、`get_weekly_schedules`(063) 皆 SECURITY DEFINER 且 GRANT anon，但參數只有 `p_company_id`，**完全不驗呼叫者是誰**。任何人拿公開 anon key（就寫在 common.js 裡）加上任一 company_id（CLAUDE.md 就寫著兩家的 id），即可用 owner 權限 dump 對方公司整月出勤與班表。實測以 anon key 帶本米 company_id 呼叫，成功取回本米員工姓名、部門與逐日打卡時間 |
| migration 099 | ✅ 已套正式庫 | 新增 `has_company_access(line_user_id, company_id, require_manager)` helper（已 REVOKE anon，避免變成身分探測管道）；三支 RPC 加 `p_line_user_id TEXT DEFAULT NULL` 與前置驗證。出勤兩支要求管理身分（admin/manager/公務機，對齊前端 `canReadAttendanceOverview`）；週班表只要求同公司在職員工（沿用公司內公開查看設計）。**函式本體除插入驗證區塊外完全沿用現行版本** |
| 前端傳身分 | ✅ 已上線（eb8aca5） | attendance_overview.html 2 處用 `liffProfile.userId`、attendance_public.html 4 處用 `currentLineUserId` |
| migration 100 | ✅ 已套正式庫 | 驗證改為必填（`IF NOT has_company_access(...)`），未帶身分一律 access_denied。**洞到這一步才真正關閉** |

**三步部署順序（不可顛倒）**：099 加參數但可選 → 前端上線傳參數 → 100 改必填。理由：前端要傳新參數，函式必須先具備該參數，否則 PostgREST 找不到對應函式會讓打卡總覽整頁壞掉；反之若先改必填，舊前端會全部被擋。100 套用前已等過 GitHub Pages 的 HTML 快取窗口（`Cache-Control: max-age=600`）。

正式庫實測（全唯讀）：業主查大正 22 筆／查本米 11 筆（兩家都是 admin）→ 允許；大正一般員工查大正日出勤 → access_denied（要求管理身分）；大正公務機 → 允許（kiosk 例外，符合前端既有邏輯）；大正員工查本米、亂編身分查本米 → 全擋；週班表大正員工查大正 → 允許、查本米 → 擋；anon 直呼 `has_company_access` → 42501。

### 同型排查結果（2026-08-03 全庫掃描，條件：SECURITY DEFINER + GRANT anon + 參數含租戶選擇欄位但無 line_user_id）

| 批次 | 函式 | 處置 | 狀態 |
|---|---|---|---|
| 099/100 | get_company_daily_attendance、get_company_monthly_attendance、get_weekly_schedules | 加 `p_line_user_id` 驗證 | ✅ 已必填 |
| 101/102 | get_leave_approval_requests、get_makeup_review_requests、get_pending_makeup_requests、get_pending_overtime_requests | 加 `p_line_user_id` 驗證 | ✅ 已必填（102 已套） |
| 103 | `calculate_monthly_payroll(p_employee_id, ...)` | **REVOKE anon** | ✅ 已收回。實測 anon 帶真實 employee_id 可直接取得該員工 net_salary／gross_salary／扣除額；全庫 grep 前端沒有呼叫，屬歷史遺留 |
| 103 | `generate_binding_code(p_employee_id)` | **REVOKE anon** | ✅ 已收回。任何人都能為任一員工編號取得 6 位數綁定碼（函式直接回傳 code），是帳號綁定被冒用的破口；前端未使用、verification_codes 0 筆，舊設計殘留 |
| 待處理 | `upsert_schedule` / `delete_schedule(p_scheduler_id, ...)` | 需加 `p_line_user_id` 對應驗證 | ⏳ 未修。函式**有**檢查 p_scheduler_id 是否具排班權限且同公司，但 scheduler_id 由前端傳、且 employees 表 anon 可全讀 → 冒用管理員 id 即可增刪他人排班（寫入操作） |

掃描後複查：以 `company_id/store_id` 為條件已無剩餘同型函式。

> ### ⚠️ 這道防線的實際強度（務必理解）
> `p_line_user_id` 驗證**提高了門檻但尚未完全封死**：目前 `employees` 表 anon 可全讀（37/37），**連 `line_user_id` 都讀得到**（實測可撈出 role=admin 者的 LINE ID）。攻擊者先撈管理員身分再帶進 RPC 仍可通過。
>
> 它確實擋掉的是：①只知道 company_id（公開文件裡就有）就能 dump 的情況；②A 公司使用者存取 B 公司資料。**真正封死必須連同 employees 表一起鎖**，而那受制於「前端無 auth session、身分自舉靠直讀 employees」的雞生蛋問題，需要 bootstrap RPC，屬另案工程。

## 🟢 2026-08-03 切換公司入口（跨公司員工／管理員）

| 項目 | 狀態 | 說明 |
|------|------|------|
| 首頁「切換公司」鈕 | ✅ 前端完成待上線 | index.html：原 `showCompanySelector` 重構為共用的 `pickCompanyFromOverlay(options, cancelable)`（cancelable 時多一顆取消鈕，關閉時移除不殘留）；新增 `mountCompanySwitchEntry()` 在公司名稱旁掛鈕，只在身份 ≥2 家公司時出現。平台管理員取 `managedCompanies`、一般員工取新的 `window.myCompanyOptions` |
| 切換方式 | ✅ 寫 sessionStorage + 整頁重載 | 不做即時換資料：選定後寫 `selectedCompanyId` 再 `location.reload()`，確保 currentEmployee／功能開關／子頁面全部一致，不會殘留前一家公司的畫面。選同一家或按取消則完全不動作 |
| admin.html 後台下拉 | ✅ 前端完成待上線 | `renderAdminCompanySwitcher` 從「僅平台管理員」擴充：一般跨公司管理員改用 `window.myAdminCompanies`（checkAdminPermission 以 `companies.select('id,name').in('id', 自己的 company_id 清單)` 帶名稱），change 時寫 sessionStorage + reload；平台管理員維持原本 `switchCompanyAdmin` 即時切換路徑不變。role=manager 的標註平台端仍是 (代管)、一般端顯示 (主管) |
| i18n | ✅ | 新增 `switchCompany`（中文「切換公司」／越南文「Đổi công ty」），按鈕用 data-i18n 掛載後呼叫 applyI18n |
| JS 快取版本 | ✅ 升至 `20260803-companyswitch` | common.js / i18n.js / modules/index.js 的 `?v=` 全部更新（admin、checkin、index、records、services、kiosk、employee_register）。**前一個 commit 1f5cdf2 漏升，本次一併補上** |

驗證：qa_check 0 FAIL、npm test 52/52、hook 無新警告、`node --check` 全過。真實 DOM 互動測試（jsdom 載入真實 index.html 的 inline script 與真實 modules/auth.js，非副本）：
- 首頁切換器 17/17 — 單一公司不掛鈕、多公司掛鈕且公司名稱不被蓋掉、重複 mount 不重覆掛、overlay 列出兩家公司與正確角色標籤、取消不寫入不重載且取消鈕不殘留、選同一家不動作、選另一家寫入正確 id 並觸發重載、首次登入的選單不可取消且回傳正確員工記錄。
- 後台下拉 9/9 — 單一公司不顯示、跨公司顯示兩項、(主管) 標註正確、原公司名稱隱藏、重複呼叫不重覆插入、選同一家不動作、切換寫入正確 id 並重載。
- 未涵蓋：平台管理員的即時切換分支（`switchCompanyAdmin` 需要 Supabase 連線，該路徑本次未改動）。

---

## 🟢 2026-08-03 補打卡期限延長 7 天＋跨公司管理員被踢回首頁修復

| 項目 | 狀態 | 說明 |
|------|------|------|
| 補打卡期限 2 天 → 7 天 | ✅ 前端完成待上線 | 原本 `initMpDate` min＝昨天、`submitMakeupPunch` 擋 `date < 昨天`，等於只能補當天＋昨天。改為 `MAKEUP_PUNCH_WINDOW_DAYS = 7`（common.js 單一常數，含當天回溯 7 天＝最早 today−6），records.html 日期選擇器與規則文字同步。DB 端 `submit_makeup_punch`（085）本來就沒有日期限制，不需 migration |
| initMpDate 時區 | ✅ 順手修正 | 原本用裝置本地 `new Date()`＋fmtDate，與送出時的台灣時間驗證可能差一天；改用 `getTaiwanDate()` 與驗證同源 |
| 管理員進打卡總覽被踢回首頁 | ✅ 前端完成待上線 | 根因：業主在大正＋本米各有一筆 admin 員工記錄（非平台管理員）。attendance_overview.html 等子頁沒有公司選擇 UI，common.js `checkUserStatus` 遇到多公司又無 `sessionStorage.selectedCompanyId` 時直接 `location.href='index.html'`，選完公司就停在首頁回不去。修法：導向改帶 `?next=<原頁>`，index.html 選完公司後 `location.replace(next)` 送回原頁（白名單只允許站內 `xxx.html` 相對路徑，防開放轉址） |
| admin.html 未寫入公司選擇 | ✅ 前端完成待上線 | `modules/auth.js` 一般管理員路徑只讀 `selectedCompanyId` 不寫，導致從 admin.html 進子頁必被踢回。改為驗證通過後寫入；且跨公司管理員在本次尚未選過公司時，先導回 `index.html?next=admin.html` 明確選擇，不再隨機取第一家 |

驗證：qa_check 0 FAIL、npm test 52/52、hook 無新警告（僅既有 6 筆行號位移）、common.js/auth.js `node --check` PASS、index.html/records.html inline script 語法 PASS、補打卡日期邊界 5 案例 node 實跑 PASS、導向狀態機 12 情境模擬（4 種身份 × 3 個進入點）全部收斂無迴圈。

rls-checker 審查結論：多租戶隔離未受影響（`currentCompanyId` 一律取自 `.eq('line_user_id', ...)` 查回的自身列表，`sessionStorage.selectedCompanyId` 只當作 `.find()` 的比對值，竄改成別家公司 id 只會找不到並退回自己有權限的公司）；`next` 白名單正則不允許 `/` 與 `:`，可擋 `//evil.com`、`../`、`javascript:`，且只在 `checkUserStatus()` 成功後才處理，無先跳轉後驗證的競態。

> 📌 已知限制 1：~~跨公司管理員 session 內無法切換公司~~ → 已於同日補上切換入口（見下方區塊）。
> 📌 已知限制 2（rls-checker 標記，非資安）：`auth.js` 導回首頁選公司時，index.html 的選單會列出所有身份的公司，但 admin.html 只認 admin/manager 的公司。若某人同時是 A/B 公司管理員又是 C 公司一般員工，選了 C 會退回 A 的後台。目前大正／本米兩位管理員在兩家都是 admin，不會觸發。

### ✅ migration 097 補打卡日期窗口後端驗證（rls-checker 標記，已於 2026-08-03 完成）

| 項目 | 狀態 | 說明 |
|------|------|------|
| migration 097 | ✅ 已套正式庫（2026-08-03，user 明確授權） | `submit_makeup_punch`（085 為前一版）原本**完全沒有 punch_date 檢查**，未來日期與任意久遠日期都收，「7 天內／不可未來」只在前端擋、anon key 可直接呼叫繞過。097 在 RPC 內補上窗口驗證：`v_today = (now() AT TIME ZONE 'Asia/Taipei')::date`、`v_earliest = v_today - 6`，超出回 `punch_date_out_of_window`（附 earliest_allowed / window_days）、未來回 `punch_date_in_future`。天數常數 `v_window_days = 7` 必須與前端 `MAKEUP_PUNCH_WINDOW_DAYS` 同步 |
| 日期檢查位置 | ✅ 刻意放在員工查詢之前 | 便宜、且驗證測試不會產生任何寫入 |
| 只擋送出不擋審核 | ✅ 確認 | `approve_makeup_request`（086）未動，既有超過 7 天的 pending 申請仍可正常核准（E818/E815 積欠缺卡需要） |
| 套用方式 | ✅ `CREATE OR REPLACE` 而非 DROP+CREATE | 避免正式站在套用瞬間打不到卡 |

正式庫實測（anon key REST，皆無寫入）：當天／6 天前（窗口內邊界）→ 進到員工查詢回 `employee_not_found`；7 天前／30 天前／2 年前 → `punch_date_out_of_window`（最早 2026-07-28）；明天 → `punch_date_in_future`。
交易內 rollback 實測（真實員工 E007）：窗口內邊界 `success: true`（確認正常送出未被誤擋）、同日同類型重複 → `duplicate_makeup_request`（防呆仍有效）、窗口外 → 擋下；ROLLBACK 後正式庫殘留 0 筆。

### ✅ migration 098 補打卡 RPC 加入公司範圍（2026-08-03 完成，user 授權）

| 項目 | 狀態 | 說明 |
|------|------|------|
| migration 098 | ✅ 已套正式庫（2026-08-03，user 授權） | `submit_makeup_punch` / `get_my_makeup_requests` 原本用 `WHERE line_user_id = ? AND is_active LIMIT 1` 認定員工、無 company_id，跨公司員工會隨機落在其中一家。兩支都新增 `p_company_id UUID DEFAULT NULL`：有帶就限定該公司、沒帶維持原行為（向後相容）；`LIMIT 1` 補上 `ORDER BY created_at` 避免結果不固定 |
| 前端傳入公司 | ✅ 已上線 | common.js `submitMakeupPunch` / `loadMakeupHistory`、checkin.html GPS 待審打卡都改傳 `p_company_id: window.currentCompanyId \|\| null` |
| 安全性 | ✅ 只能縮小不能放大 | 查詢條件是「line_user_id = 自己 AND company_id = 傳入值」，傳別家公司 id 只會查不到員工（實測 employee_not_found），不會取得未授權資料 |
| 參數數量改變的陷阱 | ✅ 已處理 | 必須 DROP 舊版再建，否則新舊 overload 並存會讓 PostgREST 報 `Could not choose the best candidate function`。套用後實際查 pg_proc 確認各只剩一個簽章 |

正式庫實測（交易內 rollback，殘留 0 筆）：業主帳號帶大正 company_id → 申請落在大正的員工記錄；帶本米 → 落在本米（跨公司正確性修復）；大正員工 E007 帶本米 company_id → `employee_not_found`（隔離有效）；不帶 company_id → 仍可送出（舊前端相容）；E818 讀取帶大正 → 53 筆、帶本米 → 0 筆。
PostgREST（anon key，無寫入）另測兩種呼叫形狀都能正確解析：舊前端 6 參數與新前端帶 `p_company_id` 皆回 `employee_not_found` 而非找不到函式，確認部署順序（DB 先、前端後）不會讓線上打卡中斷。

### 📌 既有未修（非本次引入）
- `submit_makeup_punch` 的 `p_line_user_id` 由前端傳入且無 auth session 驗證，理論上任何人拿 anon key ＋ 他人 LINE id 就能代送補打卡申請（仍需主管核准才生效）。這是全系統「前端無 auth session」的架構問題，見 memory `rls_011_not_deployed`，不在單一 RPC 層能解。

## 🟢 2026-07-16 請假天數排除休假日（095）＋午休不計工時（096）

| 項目 | 狀態 | 說明 |
|------|------|------|
| migration 095 請假排除休假日 | ✅ 已套正式庫（2026-07-16，user 結構化授權） | 根因：`submit_leave_request` 天數＝純日曆天，簡杏如假單跨 7/4(六)/7/5(日) 被多算 2 天。修正：新增 `count_employee_workdays()`（REVOKE anon）；天數只計工作日（認定規則沿用 083：排班優先→無排班平日＝工作日、週末看公司週末班設定）；全休假日擋下；`get_company_daily_attendance` 週末休假日不再列 on_leave；`get_company_monthly_attendance` leave_days 只計工作日 |
| 簡杏如既有假單 days 修正 | ✅ 已修正（9.0→7.0，user 授權） | 假單 03bb7a83 特休 7/2~7/10；修正後月度統計對帳：應出勤 12＝實出勤 5＋請假 7、缺勤 0 |
| common.js 請假成功訊息 | ✅ 前端完成待上線 | 顯示「計 N 天，已排除 N 天休假日」 |
| migration 096 午休不計工時 | ✅ 已套正式庫（2026-07-16，user 結構化授權） | 業主確認：08:00–17:00 班午休 12:00–13:00 不計工時（9h→8h）。公司層級設定 `lunch_break_start/end`（僅大正啟用；本米餐飲 12–13 是尖峰不啟用）。單一計算點＝`calc_work_hours()` trigger（010），quick_check_in/kiosk/補卡全路徑生效；`calc_payable_work_hours` 同步扣；大正歷史工時已回溯重算 |
| payroll.js 薪資工時扣午休 | ✅ 前端完成待上線 | `calcLunchOverlapMs()` 只扣與工作區間重疊部分（半天班不扣、12:30 下班只扣 0.5h、跨日班檢查翌日視窗）；JS 版本升 20260716-lunch |

驗證：qa_check 0 FAIL、npm test 52/52、rls-checker 兩輪全 PASS（095 五項、096 六項）、午休邏輯 node 實跑 10 案例 PASS。正式庫實測：095——count_employee_workdays 7/2~7/10=7、純週末=0、anon 42501、7/4 簡杏如 off_day、7/3 on_leave、本米週六仍工作日；096——大正 8 筆整日班全部精準 −1h（9.13→8.13 等）、邊界筆只扣重疊（12:39 下班扣 39 分、12:56 上班扣 4 分）、本米 41 筆總和 244.38 完全不變、anon 呼叫 lunch_overlap_hours 42501、月度 total_work_hours 40.00=5天×8h。

### 📌 技術債（rls-checker 2026-07-16 標記）
- `calc_payable_work_hours(UUID)` 自 077 起 GRANT anon 且內部無 company 過濾，可被任意 attendance_id 呼叫。011 RLS 未部署現況下非新增風險；011 部署時應收回此 GRANT，只留給上層已隔離的 RPC 呼叫。

## 🟢 2026-07-16 新功能：外勤行程地圖＋追蹤模式（fieldwork-tracking）

| 項目 | 狀態 | 說明 |
|------|------|------|
| migration 094 | ✅ 已套正式庫（2026-07-16，user 授權） | `field_work_trackpoints` **RLS deny-all（連續 GPS 軌跡屬敏感個資，rls-checker 建議比照 092）**：ENABLE RLS 無 policy＋REVOKE ALL，讀寫走 3 支 SECURITY DEFINER RPC——insert_fw_trackpoints（僅行程本人＋行程須 open＋employee/company 由 DB 認定防偽造＋單次≤50點）、get_fw_trackpoints / count_fw_trackpoints（本人或同公司 admin/manager 或 platform_admin）。另：pg_cron `purge-fw-trackpoints` 台灣 02:30 清 90 天前＋補收回 field_work_trips 的 DELETE。**教訓：Supabase default privileges 會自動給新表 anon 全權限，收權限必須明確 REVOKE** |
| fieldwork.html 追蹤模式 | ✅ 前端完成待上線 | open 行程＋前景每 60s 記點（accuracy>1000m 丟）、批次上傳（滿3點或3分鐘）、失敗保留重試、buffer 上限 30、visibilitychange 停/續、收工 flush、GPS 拒絕靜默停用；行程卡片顯示「📡 軌跡記錄中（N 點）」＋出發表單知情告知 |
| 管理端行程地圖 | ✅ 前端完成待上線 | settings.js：Leaflet 1.9.4 lazy load（unpkg，失敗→文字版時間軸）；明細 modal「🗺️ 行程地圖」；實線=軌跡段/虛線=僅起訖（相鄰 >5 分鐘）；出發🟢/到站🔵(popup 時間+客戶+區間)/收工⚫ circleMarker；JS 快取版本升 20260716-tripmap |

驗證：qa_check 0 FAIL、npm test 52/52、buffer 節流 4 案例 PASS、地圖分段 4 案例 PASS、E826 實測（批次 insert 3 點→管理端查詢→PATCH 42501 拒竄改→清除 0 殘留）。

## 🟢 2026-07-15 新功能：外勤里程表起訖登錄（fieldwork-odometer）

| 項目 | 狀態 | 說明 |
|------|------|------|
| migration 093 | ✅ 已套正式庫（2026-07-15，user 授權） | 新表 `field_work_trips`（出發/收工里程表登錄，含 company_id、同員工同日僅一筆 open 的 partial unique index）；`field_work_logs` 加 5 欄（trip_id/odometer_reading/odometer_photo_url/segment_km/gps_distance_km） |
| fieldwork.html 行程卡片 | ✅ 前端完成待上線 | 🚗 出發登錄（讀數+拍里程表+GPS，GPS 失敗不擋）→ 行程進行中（已行駛）→ 🏁 收工登錄（total_km=end−start，>500km confirm）；昨日 open trip 隔天自動 closed |
| 到達打卡整合讀數 | ✅ 前端完成待上線 | 有 open 行程：讀數必填、須 ≥ 上一讀數點、區間 >200km confirm；自動算 segment_km＋gps_distance_km（haversine，前站 leave→arrive→出發 GPS）；無行程走舊流程（手填 mileage）不受影響 |
| 管理端審核＋CSV | ✅ 前端完成待上線 | settings.js：列表/明細顯示 segment_km、里程表區塊（出發/到站讀數、GPS 直線距離、照片）、警示（低於直線×0.8／高於直線×3+5／缺照片）；CSV 加 6 欄 |
| resumeFieldWork 斷鏈 bug | ✅ 順手修復 | 原本先設 fwCurrentLogId 再呼叫 showFieldWorkForm()（會重設為 null），草稿續填後離開打卡會失敗；已改為先 show 再回填 |

驗證：qa_check 0 FAIL、npm test 52/52、haversine 台北101→台北車站 5.03km PASS、警示函數 6 案例 PASS、Hook 無新警告。套用 093 後驗證清單：anon select field_work_trips 回 `[]`；`field_work_logs?select=trip_id,segment_km` 不回 42703；同員工同日兩筆 open → 23505。

## 🟢 2026-07-14 新功能：缺卡稽核系統（missing-checkout-audit）

| 項目 | 狀態 | 說明 |
|------|------|------|
| migration 092 缺卡稽核 | ⏳ 程式完成，**正式庫未套用** | `attendance_anomalies` 追蹤表 + 自動結案 trigger + `scan_missing_checkouts()` + `run_daily_attendance_audit()`（pg_net 推 LINE）+ pg_cron 01:10 UTC + 大正啟用旗標。詳見 `openspec/changes/missing-checkout-audit/` |
| 打卡總覽缺卡追蹤卡片 | ✅ 前端完成待上線 | `attendance_public.html` 今日分頁「⏰ 缺卡追蹤」，僅大正科技+管理員模式；狀態膠囊（待員工處理/補卡待審/請假待審）+ 手動結案；zh/vi |
| 素食提醒文案不清 | ✅ 已修前端待上線 | `renderLunarVegetarianReminder` 改情境化完整句：當天→「今日訂便當請確認：吃素的員工要改訂素食便當」；未來→「請提前提醒吃素的員工，當天記得改訂素食便當」 |

套用後驗證清單：手動 `SELECT run_daily_attendance_audit();` 確認回傳統計、anon 呼叫 `get_attendance_anomalies` 應被擋、`SELECT * FROM cron.job WHERE jobname='daily-attendance-audit';` 確認排程存在。

## 🔴 未修復 Bug（優先修）

### 舊項目
| # | Bug | 嚴重度 | 狀態 |
|---|-----|--------|------|
| 1 | 打卡後首頁狀態不顯示 — LIFF BFCache 問題 | 🔴 嚴重 | 修了 3 次還沒穩定 |
| 2 | 考勤查詢不顯示 — RPC+RLS+時區三重 bug | 🔴 嚴重 | ✅ 已修復（041 SQL）|
| 3 | RLS 未設定 — anon key 可讀所有公司資料 | 🔴 安全 | ✅ 已修復（24+ 個查詢加 company_id）|

### 2026-04-23 Audit 新發現（完整報告: `reports/audit_summary_2026-04-22.md`）

**🔴 最優先（安全風險）— 全部已修復 ✅**
| # | Bug | Commit | 修復方式 |
|---|-----|--------|---------|
| P1 | 敏感 RPC 無後端身份驗證 → anon 可讀/改/刪他家班別 | 44ac302 | `migrations/071` 重建 4 RPC 加 `p_line_user_id` 驗證 |
| P2 | `updateAdjustment` 無負數/上限檢查 → 可誤發負薪或天價 | 44ac302 | 加 -500K~5M 範圍檢查 + toast 擋住 |
| P3 | `Promise.all` silent error → 獎金數字錯但 UI 看不出 | 44ac302 | 獎金+薪資計算加完整 error 檢查 + toast 警告 |
| D1 | `attendance_public.html` URL 可偷看別家打卡 | 0bb126c | 加 LIFF 登入 + admin/manager 角色驗證 |

**🟠 次優先 — P4/P5 已修復 ✅**
| # | Bug | 位置 | 說明 |
|---|-----|------|------|
| P4 | ~~`baseSalary NULL` 被當 0~~ | ✅ d50968c | 獎金+薪資計算偵測未設底薪 → toast 警告 |
| P5 | ~~`switchCompanyAdmin` 切公司未清全域變數~~ | ✅ d50968c | `clearPayrollState()` 清除 7 個變數 |
| P7 | ~~`onclick` 字串拼接 XSS pattern~~ | ✅ d894248 | 改 `data-*` + `this.dataset`，消除 JS 字串拼接 |
| P8 | ~~`toISOString()` 時區邊界~~ | ✅ d894248 | 改 `toLocaleString('sv-SE', { timeZone: 'Asia/Taipei' })` |

**🟡 降級觀察**
| # | Bug | 結論 |
|---|-----|------|
| P6 | 並行打卡 race（原為 🔴 推論） | ✅ **code review 降級** — `checkin.html:191/330` 前端明確傳 `p_action='check_in'/'check_out'` → 069 race 不觸發；詳見 `tests/poc/poc5_rpc069_race_review.md` |

## 🔵 2026-04-14 修復的 Bug

| # | Bug | Commit | 說明 |
|---|-----|--------|------|
| B1 | quick_check_in v_schedule 未賦值 | 3324bfe | 用 v_schedule_found BOOLEAN 旗標取代直接存取 RECORD |
| B2 | checkbox 無法取消勾選 | c3b9094 | CSS -webkit-appearance:none 連 checkbox 也套用 |
| B3 | 排班頁面載入失敗無錯誤訊息 | c3b9094 | 加顯示 e.message/details/hint |
| B4 | 固定班顯示 09:00/18:00 不是 08:00/17:00 | c3b9094 | migration 062 統一修正 |
| B5 | get_weekly_schedules column not exist | ddb1f52 | shift_types 加 company_id + 重建 RPC |
| B6 | 多租戶隔離 24+ 個漏洞 | c5d3f9d~b0d47d7 | 4 批次全面修復 |
| B7 | hire_date 空字串 → 400 錯誤 | 1d1577b | 加 \|\| null 防護 |
| B8 | QR 列印空白 | a1e4aa3 | 改用 window.open 獨立視窗 |
| B9 | 班別編輯 onclick 引號壞掉 | 0c77d57 | 改用 data lookup |
| B10 | 工時 tab 時間框截斷 | e417dba | 120px → 160px |
| B11 | shift_types 401 Unauthorized | 31fe10b | 改用 SECURITY DEFINER RPC |
| B12 | 公務機帳號繞過打卡防護 | c7c9b52 | 3 層防線（index/checkin/RPC）|

## 🔵 2026-04-25 修復的 Bug（BACKLOG 全面清掃）

| # | Bug | Commit | 說明 |
|---|-----|--------|------|
| B15 | 跨月請假查詢漏算（薪資少扣）| 56d8cfa | 查詢改區間交集 + 計算月內 overlap 天數 |
| B16 | 請假/加班日期無限制 | d9abb3b | 請假 min=-30d/max=+90d、加班 min=-30d/max=今天 |
| B17 | 排班覆蓋無提示 | d9abb3b | 儲存前查既有排班 → confirm 提示 |
| B18 | 公告 expire_at 可設過去日期 | d9abb3b | 過去日期顯示 confirm 警告 |

## 🔵 2026-06-04 修復中的 Bug（大正請假 / 補卡顯示）

| # | Bug | 狀態 | 說明 |
|---|-----|------|------|
| B19 | 今日總覽看不到待審補打卡 | ✅ 已修前端 | `attendance_public.html` 讀取 `get_pending_makeup_requests`，表格狀態顯示「待審補上班 / 待審補下班」，並加待審補卡統計 |
| B20 | 今日總覽看不到待審請假 | ✅ 已修前端 | `attendance_public.html` 讀取 `leave_requests` pending/approved，待審假單顯示「待審請假」 |
| B21 | 請假只能整天，不能請半天 / 小時 | ✅ 已執行 SQL + 前端已修 | `migrations/084_half_day_leave_and_pending_makeup.sql` 已執行；支援全日 / 上午半天 / 下午半天 / 小時請假，最低 1 小時，扣薪以 8 小時 = 1 天折算 |
| B22 | 請假衝突檢查未隔離公司 | ✅ 已修前端查詢 | `common.js` 改用 `employees!inner(company_id)`，避免跨公司請假互相影響人力上限 |
| B23 | 補打卡每月 3 次上限造成正常補卡被擋 | ✅ 正式 DB 已確認 | `migrations/085_remove_makeup_monthly_limit.sql` 已執行；`submit_makeup_punch` 已移除每月 3 次限制，只阻擋同一天同類型 pending/approved 重複申請 |
| B24 | GPS 已取得座標但範圍判斷顯示 `999999m` | ✅ 已修前端 | `quick_check_in` 回傳無效距離時，`checkin.html` 改用已載入公司打卡點重新計算最近距離；5000m 內改送主管核認，不再直接擋下 |
| B38 | 半天 / 小時請假未完整進薪資與報表 | ✅ 已修程式待上線 | `modules/payroll.js` 改用 `leave_requests.days` 計算扣薪，半天=0.5、小時假=時數/8；`modules/audit.js` 匯出請假報表新增「時段」欄；`modules/leave.js` 審核中心補上小時假標籤 |
| B39 | 大正打卡總覽今日表格載入失敗 `sb.rpc(...).catch is not a function` | ✅ 已修前端待上線 | `attendance_public.html` 將待審補卡 / 請假輔助查詢改用 `try/catch` helper，不再直接對 Supabase query builder 呼叫 `.catch()` |
| B40 | 員工首頁看不到自己的待審補上班狀態 | ✅ 已修前端待上線 | `common.js` 讀取今日自己的 pending 補卡；`index.html` 顯示「上班補打卡待主管審核」與補卡時間，便當入口維持可用 |
| B41 | 越南文請假頁假別 / 時段選項仍顯示中文 | ✅ 已修前端待上線 | `records.html` 請假表單 option/hint 接上 i18n；`common.js` 與 `records.html` 動態請假記錄、月曆細節改用 `tEmployee()` 顯示越南文 |
| B42 | 越南文記錄頁分頁 / 加班 / 考勤仍顯示中文 | ✅ 已修前端待上線 | `records.html` 補齊分頁、加班、考勤 `data-i18n`；`i18n.js` 補中越字典；`common.js` 加班動態訊息改用 `tEmployee()`；分頁改橫向滑動避免越南文擠壓 |
| B43 | 便當訂購統計只顯示總份數，會計看不出葷 / 素與初一十五提醒 | ✅ 已修前端待上線 | `attendance_public.html` 便當卡片新增葷食 / 素食數量，明細同步顯示分類統計；用瀏覽器 Chinese calendar 計算未來 3 天內農曆初一 / 十五並顯示素食提醒 |
| B44 | 今日總覽「待審補卡」混入已正式打卡但補卡修正待審的人 | ✅ 已修前端待上線 | `attendance_public.html` 將待審補卡拆成「待審補卡」（無正式打卡）與「補卡修正待審」（已有正式打卡但補卡待審），避免會計誤判未打卡人數 |

## 🔵 2026-04-22 修復的 Bug（薪資連動審查）

| # | Bug | Commit | 說明 |
|---|-----|--------|------|
| B13 | 薪資計算未過濾公務機/免打卡員工 → 出現在薪資單且缺勤扣光 | 471f284 | `modules/payroll.js:480` 加 `.eq('no_checkin', false)`，對齊 `get_company_monthly_attendance` RPC（`migrations/059:103,223`）|
| B14 | 月度總覽 vs 薪資單 `expected_days` / `absent_days` 不一致（例：排班 20 天的人薪資按 22 天扣，多扣 2 天） | be7c42f | `modules/payroll.js` 加 `computeEmployeeExpectedDays()` helper，複製 `migrations/059:156-172` 逐日排班判斷邏輯；**月中 preview 不截到今天**（B 方案核心優勢）|

### 📝 本次審查但**非 bug** 的項目

- **加班雙計疑慮**（`payroll.js:515-526`）：經確認 `attendance.overtime_hours` 欄位整個 production 無寫入路徑（`quick_check_in` RPC `migrations/069` 下班 UPDATE 不寫 `overtime_hours`；全 repo grep 無 INSERT/UPDATE 寫入），`if-else` 中 else 分支為 **dead code**，實際不會雙計。但若未來有 migration 啟用 `attendance.overtime_hours` 寫入，`if-else` 二選一陷阱會浮現（漏算非 OT 申請天數），屆時需改為合併邏輯。

## 📋 2026-04-23 User 決策（完整記錄於 `reports/audit_summary_2026-04-22.md`）

- **D1**：`attendance_public.html` URL 可改 → **是 bug，採 (i) LIFF 登入**（看者是管理者升等而來的員工）
- **D2**：`employees.line_user_id` 複合鍵 → **維持現況**（員工不兼差多家，跨公司用 `platform_admins` 處理）
- **D3**：PoC-4 並行打卡實測 → **走折衷**（已由 `poc5_rpc069_race_review.md` 完成 code review）
- **Sprint X**：`platform.html` 新增平台管理員自助 UI → **規劃中**（~3 檔 170 行，等 L2 授權）

## 🎯 2026-04-23 Audit 待 User L2 授權的修復清單

| # | 項目 | 預估 commits |
|---|---|---|
| 1 | P2 `updateAdjustment` 輸入驗證 | 1（最快） |
| 2 | P3 `Promise.all → allSettled` | 1 |
| 3 | P4 `baseSalary NULL` 警告 | 1 |
| 4 | P1 `shift_types` 4 RPC 加身份驗證 | 3-5 |
| 5 | D1 `attendance_public.html` LIFF 登入 | 2-3 |
| 6 | P5 `switchCompanyAdmin` clearState | 2-3 |
| 7 | Sprint X 平台管理員自助 UI | 4 |

**建議修復順序**：1 → 2 → 3 → 4 → 5 → 6 → 7（由小到大，風險由低到高）

---

## 🟡 已修但未驗證（需手機實測）

| # | 項目 | 修復 commit | SQL | 待驗證 |
|---|------|-------------|-----|--------|
| 4 | 上下班分開 p_action | b710a1f | 037 | 手機 LINE 測試 |
| 5 | 跨日打卡 | 4858c2c | 036 | 模擬跨日場景 |
| 6 | 早退凌晨不誤判 | — | 035 | 凌晨實測 |
| 7 | GPS 不在範圍拒絕 | — | 032 | 範圍外測試 |
| 8 | 下班記錄 GPS 地點 | 30dc883 | 039 | 手機下班確認 |
| 9 | 打卡結果畫面不卡住 | 30dc883 | — | 手機打卡確認 |
| 10 | 集點 KDS 完成取餐觸發 | d04c1e8 | — | 新訂單→KDS→查點數 |

---

## 🟢 完整流程測試

| # | 流程 | 測試步驟 | 預期結果 |
|---|------|---------|---------|
| 11 | 打卡完整流程 | LINE→上班→首頁顯示→下班→首頁顯示 | 1-5秒內顯示，不重複打卡 |
| 12 | 薪資計算 | admin→薪資→選月份→計算→預覽→確認 | 時薪×工時=正確金額 |
| 13 | 集點完整流程 | 點餐→KDS完成→查點數→兌換→核銷 | 點數正確，兌換碼核銷成功 |
| 14 | 預約集點 | 餐飲訂位→確認到店→查會員點數 | 自動加點 |
| 15 | 手動送點 | loyalty_admin→送點→選會員→送點 | 點數增加 |
| 21 | 員工自助登記 | admin→登記QR→掃碼→填表→送出→admin審核 | 登記 pending→審核 approved→LINE 通知 |
| 22 | 打卡總覽 | admin→打卡總覽→今日/月度→篩選→匯出 | 統計正確、Excel 匯出成功 |
| 23 | 員工離職 | admin→員工→離職→已離職tab→恢復 | 軟刪除正確、歷史資料保留 |
| 24 | 打卡→便當跳轉 | 上班打卡→跳 services.html→訂購→跳首頁 | lunch 開啟+未過截止+未訂才跳 |
| 25 | 下班打卡時間限制 | 超過 shift_end+3h 打卡 → 拒絕+提示補卡 | 需執行 046 SQL |

---

## ⚙️ 系統層級檢查

| # | 項目 | 檢查方式 | 頻率 |
|---|------|---------|------|
| 16 | error_logs | Supabase Dashboard | 每天 |
| 17 | GitHub Actions CI | push dev 自動跑 | 每次 push |
| 18 | QA 腳本 | bash scripts/qa_check.sh | 每次 commit 前 |
| 19 | 冒煙測試 | npm test（51 項） | 每次 commit 前 |
| 20 | 打卡診斷 | checkin-debug.html | 有問題時 |

---

## 📋 每日 SOP

### 🌅 開機（10 分鐘）
```

1. git pull
2. 看 diff（昨晚 AI 改了什麼）
3. npm test（確認沒壞）
4. 查 Supabase error_logs
5. 看 tasks.md（剩餘任務）
```

### ☀️ 白天
```
1. /opsx:propose（規劃需求）
2. 審閱 tasks.md
3. /opsx:apply（執行）
4. 手機實測
5. /opsx:archive（歸檔）
```

### 🌙 收工（15 分鐘）
```
1. git commit 所有變更
2. 確認 dev = main 同步
3. 查 error_logs
4. /opsx:apply（讓 AI 跑整晚）
```

---

## 🔧 修 Bug SOP

```
1. 確認問題：截圖 + Supabase 查詢
2. checkin-debug.html 診斷（打卡相關）
3. 貼進 Claude Code 修復
4. bash scripts/qa_check.sh（0 FAIL）
5. npm test（48/48）
6. git checkout dev → commit → push → 合併 main
7. 手機實測驗證
8. 更新本檔案狀態
```
---

## 2026-05-03 制度調整

| # | 項目 | Commit | 說明 |
|---|------|--------|------|
| B19 | 晚班實際下班照打卡，但薪資計算固定封頂 21:30 | 5dbd742 | 停用下班後自動建立 `late_close_auto`，薪資改以實際打卡紀錄回推有效工時，超過當日 `21:30` 的部分僅保留紀錄、不列入計薪；人工核准的其他加班申請仍可照常計薪。 |
## 2026-05-03 新增

- **B20**：`modules/auth.js` 管理後台權限檢查對 `line_user_id` 使用 `.maybeSingle()`，當同一個 LINE 帳號同時綁定多筆啟用中的 `admin/manager`（例如本米 + 大正）時，會在進入 `admin.html` 顯示 `JSON object requested, multiple (or no) rows returned`。已改為先查全部符合列，再依 `sessionStorage.selectedCompanyId` 或第一筆啟用資料選定目前公司。

- **B21**：本米尚未開始排班前，打卡 fallback 改為平日 `10:30-21:30`、六日 `07:00-21:30`，並加入 `checkout_time_limit_hours` 讓晚離開仍可下班打卡；目前遲到判定先關閉，不標記遲到。
## 2026-05-04 修復紀錄

- **B22**：本米餐飲業六日上班，但週班表與月度統計仍把「未排班的六日」當休假。修正方向：新增 `074_weekend_workdays_for_food_service.sql`，公司只要設定 `default_weekend_work_start/end`，六日就列入今日狀態與月度應出勤；前端週班表/明細也不再硬把六日畫成休。

## 2026-05-08 修復紀錄

- **B23**：`liff.init()` 連線 LINE CDN manifest 失敗時，`index.html?goto=attendance_public` 會停在登入初始化失敗，使用者無法進入打卡總覽。修法：`common.js` 對 LIFF 初始化加入 3 次重試，最後顯示可理解錯誤頁，提供重新整理與 LIFF 正式入口按鈕。

## 2026-05-29 修復紀錄

- **B24**：公務機員工雖在員工管理標示為「公務機」，但 `checkUserStatus()` 登入查詢沒有帶出 `is_kiosk` / `no_checkin` 欄位，導致 `index.html` / `checkin.html` 判斷不到公務機身分，不會自動跳到 `kiosk.html`。修法：`common.js` 的平台管理員公司員工查詢與一般員工查詢都補上 `is_kiosk, no_checkin`。

## 2026-06-01 修復紀錄

- **B25**：公務機拍照後按「上班打卡」可能在 LINE WebView 卡住。原因是公務機打卡雖然不強制定位，但送出前仍直接等待 `navigator.geolocation.getCurrentPosition()`；部分 LINE WebView 定位 callback 可能不回來，造成按鈕被 disabled 後看似沒有作動。修法：公務機定位改為最多等待 2 秒，逾時即以無定位資料繼續送出，並在按鈕上顯示「處理中...」。同時把 `index.html` / `checkin.html` 跳轉到 `kiosk.html` 加上版本參數，避免 LINE 快取舊公務機頁。

- **B26**：iPhone / LINE WebView 已開「使用 App 期間」與「精確位置」後，第一筆定位仍可能是基地台粗定位（例如精度 5000m），導致畫面顯示已取得座標但仍無法打卡。修法：不放寬 GPS 規則；若第一筆精度 >500m，使用 `watchPosition` 最多等待 15 秒取得更精準座標，精度改善才放行，仍太差才提示到戶外或窗邊重試；若開頁時讀到粗定位快取，也會立即在背景啟動精準定位，保留打卡速度優化。

- **B27**：iPhone 首頁預先定位可能停在「正在定位」，或只拿到粗略基地台座標，造成員工進打卡頁時仍要等很久。原因是首頁原本只呼叫一次 `getCurrentPosition(... enableHighAccuracy:false ...)`，失敗、逾時或精度太差時沒有持續暖機。修法：`preloadGPS()` 改成快速定位先行；4 秒未回或精度 >500m 時啟動高精度 `watchPosition` 最多 15 秒，把最佳座標寫入 `last_gps_location` 快取。打卡頁仍維持原本 GPS 精度規則，不放寬門檻。

- **B28**：首頁天氣與打卡預定位同時觸發 GPS，可能讓 iPhone / LINE WebView 出現多個定位請求互相搶 callback。修法：`common.js` 加入共用 GPS manager，`preloadGPS()` / `getGPS()` 共用同一個定位 Promise 與 `watchPosition`；粗定位不覆蓋較精準定位。`index.html` 天氣改成只讀既有快取或預設台北座標，不再主動呼叫 GPS；`index.html` / `checkin.html` 更新 common.js cache-bust，避免 LINE 載入舊版。

- **B29**：iPhone 打卡頁仍抓不到定位。親驗後確認不是公務機改動造成：公務機 commit 只改 `is_kiosk/no_checkin` 查詢與 `kiosk.html` 自身流程；一般員工打卡頁的問題是 `checkin.html` 仍保留獨立 GPS preload / fallback，沒有完整接上 `common.js` GPS manager。修法：`checkin.html` 的預先定位與實際打卡定位都優先呼叫 `commonRequestGps({ allowPreciseWatch: true })`，共用 4 秒 fallback + 15 秒高精度 `watchPosition`。

- **B30**：iPhone 已取得座標但精度仍 >500m 時，員工會卡在不能打卡。制度調整：不放寬正式打卡 GPS 門檻；若有座標但精度不足，前端改送既有「補打卡待審核」RPC，note 內保留照片 URL、座標、精度、送出時間與裝置資訊。主管在審核中心可查看照片與地圖，按通過後才由既有 `approve_makeup_request` 寫入正式出勤。

- **B31**：公務機打卡仍可能出現 `record "v_schedule" is not assigned yet`。原因是公務機走 `kiosk_check_in`，不是已修過的 `quick_check_in`；當員工設為排班制但當天沒有排班時，`v_schedule` 沒有被 SELECT INTO 賦值就被讀取。修法：新增 `migrations/081_fix_kiosk_v_schedule_record.sql`，用 `v_schedule_found` 保護 RECORD 存取，沒有排班時 fallback 到固定班或公司預設上下班時間；`kiosk.html` 也把舊 SQL 錯誤轉成可讀提示。

- **B32**：081 第一版仍用 `IF v_schedule_found AND v_schedule.shift_* IS NOT NULL` 保護 RECORD；現場公務機仍回報相同錯誤。原因是 PL/pgSQL/SQL expression 不應依賴 `AND` short-circuit 來保護未賦值 RECORD 欄位。修法：新增 `migrations/082_fix_kiosk_v_schedule_nested_guard.sql`，改成巢狀 IF，只有 `v_schedule_found = true` 時才讀 `v_schedule` 欄位。

- **B33**：公務機上班打卡成功後不會提示便當訂購，導致使用公務機的員工可能漏訂。修法：`kiosk.html` 在上班打卡成功後讀取公司 `lunch` 功能與 `lunch_deadline`，若未過截止且該員工今日尚未訂餐，直接在公務機頁彈出葷食/素食/不訂購選單；送出或略過後回到輸入下一位員工，不影響下班打卡。

- **B34**：公務機員工確認頁的拍照按鈕位置太低，小螢幕需要往下拉；拍照完成後也不夠明確提醒「還要再按上班/下班才送出」。修法：`kiosk.html` 改成緊湊版面，拍照按鈕上移到相機預覽前，相機高度固定且在矮螢幕縮小；拍照後顯示醒目提示「已拍照，請再按上班或下班」。

- **B35**：本米排班制規則被套用到所有公司，導致大正科技薪資計算也不顯示/不計算應出勤、缺勤與缺勤扣款。修法：`modules/payroll.js` 改為公司別分流；本米維持排班制不自動扣缺勤，大正科技與其他一般公司恢復固定班/一般薪資計算。另新增 `migrations/083_company_specific_expected_absent_days.sql`，讓月度總覽 RPC 同步依公司分流。

- **B36**：一般打卡頁已能把 GPS 精度 >500m 改送待審，但「精度正常、座標飄到公司半徑外」仍直接擋下。修法：`checkin.html` 在 `quick_check_in` 回傳 `outside_allowed_location` 且 `min_distance <= 5000m` 時，改送補打卡待審核；超過 5000m 仍直接擋。`modules/schedules.js` 審核卡片新增「GPS 範圍外疑似飄移」標示，顯示距離公司、精度、照片與地圖連結。

- **B37**：審核中心請假清單直接讀 `leave_requests`，遇到 RLS / schema 差異會顯示「載入失敗」；補打卡審核只讀 pending，且 GPS 待核與一般補卡混在一起，主管按通過後若有重複申請仍像沒作用。修法：新增 `migrations/086_approval_center_gps_review.sql`，提供 `get_leave_approval_requests`、`get_makeup_review_requests`，並讓 `approve_makeup_request` 通過一筆後自動關閉同員工同日同類型重複 pending。前端改為「待審核 / GPS 待核 / 一般補卡 / 已通過 / 已拒絕」分頁，通過時顯示處理狀態。2026-06-08 已查正式 DB：三個 RPC 均存在。

## 2026-07-02 Fix Notes

- **B45**: `attendance_public.html` daily overview showed GPS review punches as not checked because it only loaded legacy `get_pending_makeup_requests`. Fixed by reading `get_makeup_review_requests` first, falling back to the legacy RPC, and normalizing `check_in/check_out` to `clock_in/clock_out` for display and stats.

## 2026-07-12 Fix Notes

- **B46**（已修復）：正式庫的 leave_requests / overtime_requests（approver_id）與 schedules（created_by）各有第二條指向 employees 的外鍵，導致所有 `employees!inner(...)` 內嵌查詢回 PGRST201「關聯不明確」錯誤；因各處都是解構 `{ data }` 或 catch 吞錯，全部**靜默失效**（回空陣列）。受災範圍：請假月曆/今日請假標記（attendance_public.html）、同時請假上限檢查（common.js，上限從未生效）、薪資計算的請假時數/加班時數/排班應出勤（payroll.js ×5）、審計報表請假/加班匯出（audit.js）、排班管理請假顯示與上週複製（schedules.js）。修法：16 處查詢全部指定 FK 名稱（`employees!<table>_employee_id_fkey!inner`），已逐表用 anon key 對正式庫實測回傳正常。單 FK 表（attendance/lunch_orders/field_work_logs/sales_activities）不受影響，維持原寫法。
- **B47**（已知未修）：annual_bonus 表在正式庫沒有到 employees 的外鍵，audit.js 年終獎金匯出的內嵌查詢回 PGRST200 靜默失效；表目前為空、功能未使用。待啟用年終功能時補 migration 加 FK 再改查詢。
