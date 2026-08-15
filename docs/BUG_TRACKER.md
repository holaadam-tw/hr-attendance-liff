# RunPiston Bug 追蹤 & 測試清單

> 更新日期：2026-08-06
> 每次修改後更新此檔案

---

## 🟢 2026-08-06 歷史缺卡回補：追蹤啟用前的 21 天缺下班卡

健康檢查盤點發現：6/1 起有 **22 天**有上班卡卻沒有下班卡，而 `attendance_anomalies` **完全沒有對應記錄**——缺卡追蹤卡片顯示「0 待處理」是假的安心。

### 根因

缺卡追蹤（migration 092 的 `scan_missing_checkouts()` ＋ 每日 01:10 排程）最早的記錄是 **2026-07-13**，且只掃「昨天起算 `p_days_back` 天內」。在那之前的缺卡從來沒有被建立過追蹤記錄，也就沒有人被提醒、沒有人補登，工時一律算 0，**直接少算薪資**。

套上 `scan_missing_checkouts()` 的同一組排除條件（停用員工／免打卡／公務機／當日有已核准請假）後，實際待處理是 **21 天**（06-03 黃秀娟因當日有核准請假被排除）。集中在 E820 黃秀娟 6 天、E815 邱順麟 4 天，其餘 11 人各 1~2 天。

順帶查證：那 11 筆「有補卡申請」的紀錄**全部是 `clock_in`**（早上 GPS 失敗轉待審後被核准），解釋的是早上為什麼有卡，不是傍晚為什麼沒卡。

### 為什麼不回補 `attendance_anomalies`

`run_daily_attendance_audit()` 的邏輯是：只要該表有 `pending` 列，每天 01:10 就會 **DM 每一位當事員工**（訊息明寫「未處理前每天都會提醒」）並發管理群組彙總。回補 6 月的資料等於讓 8 位員工**每天**收到兩個月前的提醒，直到有人處理完為止。

所以改成**純前端現算的管理員清單**：不寫入任何記錄、不觸發任何通知。

### 改動（`attendance_overview.html`，無 migration、無 DB 寫入）

新增「🗂️ 歷史缺卡（追蹤啟用前）」卡片：

- 範圍 `2026-06-01` ~ `2026-07-13`（追蹤啟用日），與現行缺卡追蹤**不重疊**
- 排除條件與 `scan_missing_checkouts()` 逐項對齊：`is_active=false`／`no_checkin`／`is_kiosk`／當日有已核准請假
- 依日期分組，每列一顆「補登下班」直接開代補打卡（已預設帶入 17:00）
- badge 顯示「N 天 · M 人未補」
- **自清**：補登後 `check_out_time` 不再是 null，該列下次載入自動消失，全部補完卡片自動隱藏

### 驗證

`tests/attendance-overview.test.js` 新增第 11 節共 16 項（全檔 88 → **104 項**）：四種排除條件各一題、badge 文字、依日期分組、補登按鈕帶入正確的 employeeId 與 date、兩張表的多租戶 filter、`lt(date, 2026-07-13)` 不與現行追蹤重疊、`not(check_in_time,is,)` ＋ `is(check_out_time,)`、全部補完後自動隱藏、無 company context 時隱藏。

qa_check 0 FAIL 1 WARN（WARN 為已知 RLS 項，數字未變）、npm test 三套件全過、inline script `node --check` 兩段通過、hook 仍為既有 6 筆無新增。

### 待處理

這 21 天需要**業主逐筆決定實際下班時間**再補登——系統不會替他猜。補完後這些日子的工時才會從 0 變成實際值。

---

## 🔴 2026-08-05 RLS 形同虛設：公開 anon key 可讀寫幾乎整個資料庫（**未修復**）

健康檢查盤點時查證正式庫 metadata 得出（**沒有撈任何一筆業務資料**，全部靠 `pg_class` / `pg_policy` / `information_schema` 判定）。

### 規模

| 指標 | 數字 |
|------|------|
| public schema 資料表總數 | 64 |
| **RLS 完全未開啟** | **12** |
| **有 `USING (true)` 且套用到 anon／PUBLIC 政策的表** | **50** |
| 這類全開政策條數 | 101 |

也就是 64 張表裡有 **62 張** 不是 RLS 沒開、就是有一條政策把門全開。

### 為什麼 `Block direct access` 沒有用

`attendance` / `employees` 上都有一條 `Block direct access USING (false)`，但同表另有 `允許查看考勤記錄 USING (true)`、`允許更新考勤記錄 USING (true)`，角色明確是 `anon, authenticated`。**PostgreSQL 的 permissive policy 是 OR 起來的**——只要有一條 `true` 就全開，`false` 那條完全擋不住。

### 確認受影響的資料

- `employees`：SELECT／UPDATE 對 anon 全開 → 所有公司的員工個資可讀可改
- `attendance`：同上 → 所有考勤可讀可改
- `payroll_records`：`payroll_select` / `payroll_update` 皆 `USING (true)` 且角色是 **PUBLIC** → 薪資可讀可改
- `overtime_requests`：**RLS 完全關閉、0 條政策**
- 另外 RLS 未開的還有 `attendance_backup`（考勤全量備份）、`companies`、`clients`、`field_work_logs`、`field_work_trips`、`lunch_order_details`、`binding_attempts`、`booking_settings`、`insurance_brackets` 等

table-level 權限方面，anon 對 `employees` / `attendance` / `payroll_records` / `overtime_requests` / `system_settings` 全都有 `SELECT,INSERT,UPDATE,DELETE`——唯一防線就是 RLS，而 RLS 是上面這個狀態。

anon key 本身寫在 `common.js` 裡，任何人打開網頁原始碼就看得到，這是 Supabase 的正常設計，前提是 RLS 有在做事。

### 為什麼一直沒修（不是疏忽，是有結構性原因）

前端是 **LIFF 認證、沒有 Supabase auth session**。收緊成 `auth.jwt() ->> 'sub'` 型政策會讓所有頁面直接壞掉——現有大量頁面是拿 anon key 直接 `sb.from(...)` 讀表的（包含 2026-08-05 新增的加班確認卡片，它能運作正是因為 `overtime_requests` 沒開 RLS）。

正解是**全面改走 SECURITY DEFINER RPC**，再把 `USING(true)` 政策撤掉。這是架構級工程，需單獨排期，不是一次 commit 能收的。

### 已做的：讓它至少會被喊出來

- `scripts/qa_check.sh` 新增第 8 項 RLS 靜態檢查：新 migration 若又寫出 `USING(true)` 政策、或建表後沒 `ENABLE ROW LEVEL SECURITY`，會出 WARN
- 新增 `scripts/rls_audit.sh`：連線正式庫列出「RLS 未開的表」「全開政策」「RLS 開但 0 政策（走 RPC 的預期設計）」「anon 的 table 權限」四段，只讀 metadata

---

## 🔴→🟢 2026-08-05 薪資彙總報表加班基準錯誤（每次多算 30 分鐘）＋正常工時壓 17:00

業主確認實際規則：「**下班的計算薪水時間還是在 5 點，沒有多計算薪資；但是加班的人不能壓在 5 點。實際上 17:30–20:30 加班三個小時，17:00–17:30 算是休息時間**」。

對照程式後發現**加班時數算錯**：基準用 17:00 而非 17:30，`(outMin - 17*60)/60`，**每一次加班都多算 30 分鐘**。

### 2026-06 實測影響（正式庫真實資料）

| 員工 | 加班次數 | 舊值 | 新值 | 差 |
|------|---------|------|------|-----|
| 鄭世福 E824 | 21 次 | 76.8h | **66.3h** | −10.5h |
| 范文林 E814 | 12 次 | 43.9h | **37.9h** | −6.0h |

改後每次平均加班 **3.16 小時**，與業主手工表註記的「加班 3hr×N 次」吻合——這是規則正確的佐證。加班次數不變（門檻仍是 18:00，仍與手工表的 21 次／12 次一致）。

### 改動（`modules/audit.js`，純前端）

| 項目 | 舊 | 新 |
|------|-----|-----|
| 加班基準 | 17:00 寫死 | `OT_START_MIN = SHIFT_END_MIN + 30` |
| 班表時間 | 上班 08:00 寫死、無下班 | 讀 `default_work_start` / `default_work_end`，fallback 08:00 / 17:00 |
| 午休 | 依賴 DB 已扣 | 另讀 `lunch_break_start` / `lunch_break_end`（本米未設定→不扣）|
| 「總工時」欄 | `total_work_hours` 一欄 | 拆兩欄：**正常工時(至17:00)** 供計薪、**實際工時(打卡)** 供對照 |

報表由 16 欄增為 17 欄。cache-busting 版本號 `20260805-payrollsummary` → `20260805-otbase1730`（`modules/index.js` 與 `admin.html` 同步）。

### 驗證

把 `modules/audit.js` 第 59–164 行**原樣抽出**在 node 跑 2026-06 正式庫真實資料（attendance 381 筆／leave 13 筆／overtime 0 筆，與交付當時同一份），21 位員工全部產出：

- 欄位數 17，標題與程式一致
- 蔡朝文 18 天正常工時 143.1h → 7.95h/天，符合 08:00–17:00 扣午休 1 小時 = 8h
- 全公司「實際 − 正常」合計 156.0h，其中 104.2h 落在加班推估欄、51.8h 是 17:00–18:00 之間的零星晚打卡（依業主規則屬休息時間，不計薪也不算加班）

qa_check ALL PASS、npm test 52/52、`node --check` 兩個模組通過、hook 仍為既有 6 筆。

### 未做

「加班推估」不會排除**定位範圍外**的下班卡——湯煜騰 07-28 在工廠外 18.1km 打 18:18，按規則會被算成加班 0.8h。目前只在打卡總覽呈現距離讓業主自行判斷，**刻意不自動排除**（沿用「不替業主決定」的原則，同遲到兩欄的處理）。

---

## 🟢 2026-08-05 下班定位距離呈現於打卡總覽（純前端，三選一第三案）

「上下班 GPS 規格不一致」三選一的**第三案落地**：不擋人，但把下班的真實距離攤在業主眼前。前兩案的處置分別是「下班不驗範圍」（維持現狀）與「下班取消精度門檻」（今日稍早已上線），本案補上唯一缺的一塊——**看得到**。

### 為什麼是「呈現」而不是「擋」

下班真正的作弊型態是**早退後在家補打下班卡多賺工時**，對應的把關是距離而非精度。但直接擋會重蹈精度門檻的覆轍：擋到的是定位不準的誠實員工。座標一直都寫在 `attendance.checkout_latitude/longitude`，過去只是**沒有任何介面呈現**——所以本案不動任何驗證邏輯，只做呈現。

### 改動（`attendance_overview.html`，無 migration、無 DB 寫入）

| 位置 | 內容 |
|------|------|
| 每日表格「下班」欄 | 顯示距最近打卡地點的距離；超出半徑套 `.loc-hint.out-range` 標紅為「⚠️範圍外 1.2km」，範圍內顯示「📍工廠 120m」，`title` 帶完整說明 |
| 新卡片「下班定位範圍外」 | 預設收合，badge 顯示「當日 N 筆 · 近 30 天 M 筆」，展開列出日期／員工／下班時間／距離／該地點半徑 |
| `loadCheckoutDistances()` | 一次查 30 天，同時餵表格（僅選定日期）與卡片（整個窗期） |

距離用 `common.js` 既有的 `calculateDistance`，地點與半徑讀 `system_settings.office_locations`，半徑 fallback 100m **與 `quick_check_in` 的 `COALESCE(radius, 100)` 對齊**。

**為什麼卡片要看 30 天**：實測正式庫 4 個月 746 筆有座標的下班卡，只有 6 筆範圍外——只看單日的話業主幾乎永遠遇不到，功能等於沒做。

### 驗證（正式庫真實資料）

無法在瀏覽器實測，改用**把上線程式碼從 HTML 抽出來在 node 跑**（不是另抄一份，驗的是真的會上線的那段）：

- **距離公式對帳**：400 筆真實座標，JS 版與 SQL 版 haversine（`quick_check_in` 內同一條公式）最大差異 **0.005 公尺**，不一致 0 筆
- **端對端模擬**：餵 2026-07-07~08-05 共 342 筆真實資料，查詢送出的 filter 確認為 `eq employees.company_id`（多租戶隔離成立），卡片 badge 產出「近 30 天 2 筆」，內容為湯煜騰 07/28 18.1km（下班 18:18）與 07/13 11.6km
- **邊界**：無打卡地點設定→不顯示；座標 null/undefined/空字串→不顯示；座標為字串→正確轉數字；radius 未設定→fallback 100m
- **30 天窗期**：跨月、跨年、閏年、美國 DST 週共 8 個日期，span 皆為 29 天

qa_check ALL PASS、npm test 52/52、inline script `node --check` 兩段皆通過、多租戶 hook 仍為既有 6 筆無新增。

### 修掉的兩個陷阱（開發中發現）

1. `getTaiwanDate()` 收的是「距今天幾天」的**數字**不是 Date，一開始傳 Date 進去會得到 NaN
2. `Number(null)` 與 `Number('')` 都是 **0**，`Number.isFinite` 擋不掉——缺座標的列會被當成 (0,0) 算出一萬多公里的假「範圍外」。已加 `isUsableCoord()` 先擋 null/undefined/空字串

### 已知限制

- **沒有座標的下班卡無從計算**：全庫 854 筆下班卡有 108 筆（12.6%）沒有座標，來源是管理員代補與公務機打卡，這些不會出現在卡片裡
- **範圍外 ≠ 作弊**：湯煜騰 E822 三筆全是 11~18km，但下班時間 17:50/18:18 且工時 8.85h，比較像外務結束後在外地打卡而非早退；卡片只呈現數字，不下判斷
- 上班卡不列入——上班本來就擋範圍，能寫進 attendance 的必然在範圍內

---

## 🟢 2026-08-05 隔天主管確認加班（migration 108，**已套用正式庫**）

業主 2026-08-05 決定：加班改為**隔天由主管逐筆確認**，只有確認過的才計薪。原本薪資彙總的加班完全由打卡時間推估，沒有任何人把關。

### 開工前的發現：這個功能其實已經蓋好一半

`migration 072_late_close_overtime_approval` 的目標寫得跟業主的要求幾乎一樣（自動建立待核認加班、主管核認可全額／部分／不認列、薪資只吃核認後時數），而且**整條管線都在**：

| 元件 | 狀態 |
|------|------|
| `overtime_requests` 的 `late_close_auto` 來源欄位 | ✅ 072 已建 |
| 主管核認 UI（`modules/schedules.js:567` 起，有「系統自動」標籤、班表下班／實際下班／超時分鐘對照） | ✅ 已存在 |
| `approve_overtime_request` / `reject_overtime_request` | ✅ 已存在（101/102 再補呼叫者驗證） |
| 薪資彙總「加班時數(已核准)」讀 `overtime_requests` status=approved（不分 source_type） | ✅ 已存在 |
| **產生待核認記錄** | ❌ **缺這一環** |

`sync_late_close_overtime_request()` 是 RPC 不是 trigger，而且**前端從頭到尾沒有任何一處呼叫它**（全庫 grep 只有 `get_pending_overtime_requests` 有被呼叫）。所以從來沒有任何 `late_close_auto` 記錄被建立，核認清單永遠是空的——**2026-06 全月 0 筆核准、1 筆駁回就是這個原因**，不是主管不批。

### 為什麼不直接把 072 的 sync 接上去

072 的算法是 `late_minutes = 實際下班 − 班表下班(17:00)`，**沒有 18:00 門檻，也沒有扣 17:00–17:30 的休息時間**。直接接上，17:0x 正常收工的人會全部湧進待審清單（handover #78 已實測：以 17:00 為基準全公司會多出 1~9 小時的假加班）。業主規則是門檻 18:00、從 17:30 起算。

### 改動

| 檔案 | 內容 |
|------|------|
| `migrations/108_daily_overtime_confirm.sql`（新增） | `confirm_daily_overtime()` SECURITY DEFINER RPC：驗 admin/manager、驗目標員工同公司、該日必須有已完成下班打卡、confirm→approved／reject→rejected、員工自送的 manual 申請優先不覆蓋、依 072 的 `idx_ot_late_close_attendance_unique` 冪等 |
| `attendance_overview.html` | 新卡片「⏱️ 加班確認」：列出近 14 天未確認且下班 ≥18:00 的日子，每列可調整分鐘數後按「確認加班」／「不算加班」；badge 顯示「昨天 N 筆 · 待確認 M 筆」 |
| `modules/audit.js` | **不用改**——「加班時數(已核准)」本來就讀 `overtime_requests` status=approved 不分來源，確認過的會自動流進去 |

清單只看到**昨天**為止（今天還沒過完，不該叫主管確認今天），但回看 14 天，主管漏看幾天也不會掉件。

### 驗證

把 inline script 原樣載入 vm sandbox 執行，餵可鏈式呼叫的 supabase 替身（會記錄整條 filter 鏈），本次新增 33 項、全檔累計 91 項全通：

- **候選判定**：20:30 與 18:18 列入、17:05 不列入（門檻 18:00）；推估分鐘 180 / 48（從 17:30 起算）；`default_work_end` 改 18:00 時起算跟著變 18:30
- **不重複列出**：已確認過的（late_close_auto 任何狀態）、員工自送的 manual pending/approved 都排除；已確認者仍出現在「已核准加班」區塊
- **多租戶**：`attendance` 與 `overtime_requests` 兩張表的查詢都確認帶 `eq(employees.company_id, ...)`；無 company context 時不查詢
- **窗期**：只查到昨天（`lte(date, 2026-08-05)`）、回看 14 天（`gte(date, 2026-07-23)`）
- **送出防呆**：0 分鐘與 >720 分鐘都擋下且不送 RPC；合法值送出的 RPC 參數逐項比對；按取消不送出

qa_check ALL PASS、npm test 52/52、inline script `node --check` 兩段皆通過、多租戶 hook 仍為既有 6 筆無新增。

### 走查時補掉的兩個洞

1. **索引錯位會對錯人下確認**：原本按鈕帶的是陣列索引，但確認完會非同步重載清單、該列消失、後面的索引整個往前移——這時按第二列會送出**別人**的確認。已改為以 `employeeId|date` 為識別，找不到該列時明確提示「清單已更新，請重新確認一次」而不是靜靜沒反應
2. **重載空窗**：原本一進 `loadOvertimeConfirm()` 就把清單清空，主管確認完第一列馬上按第二列會撲空。改為先收在區域變數、資料到齊才換掉畫面上那份

### 正式庫實測（2026-08-05，migration 108 已套用）

前置確認：072 的 12 個欄位全部存在（`information_schema.columns` count = 12），確認 072 已部署。
函式建立後查 `pg_proc`：`prosecdef = true`，`proacl` 含 `anon=X` 與 `authenticated=X`，GRANT 未掉。

**防護路徑 8 項全過，且跑完 `overtime_requests` 仍為 2 筆（零意外寫入）**：

| # | 情境 | 回傳 |
|---|------|------|
| 1 | 一般員工（role=user）呼叫 | 需要管理員權限 |
| 2 | 空 line_user_id | 未提供身份驗證資訊 |
| 3 | decision 傳 'maybe' | invalid_decision |
| 4 | 未來日期 2099-01-01 | ot_date_in_future |
| 5 | confirm 但 0 分鐘 | minutes_not_positive |
| 6 | confirm 但 800 分鐘 | minutes_too_large |
| 7 | 用本米的 employee_id（跨公司） | 找不到員工（或不屬於本公司） |
| 8 | 2020-01-01（該日無下班卡） | no_checkout_record |

**寫入路徑 3 項全過**（對象：鄭世福 E824 2026-08-04，下班 20:39）：

- **建立**：confirm 189 分 → success、hours 3.15；DB 實際欄位 status=approved、source_type=late_close_auto、hours/approved_hours/final_hours 皆 3.15、late_close_minutes=189、scheduled_end_time=17:00、approval_reason_category=daily_confirm、reason「主管確認加班（Adam）」、approver_id 有值、attendance_id 正確連到那筆出勤
- **冪等**：同一筆再 confirm 180 分 → `updated_existing: true`，late_close_auto 仍只有 **1 列**、時數更新為 3.00（沒有長出第二筆）
- **改判**：同一筆 reject → status=rejected、final_hours=0、rejection_reason 記錄備註

**測試資料已清除**：DELETE 該列後 `overtime_requests` 回到 2 筆、late_close_auto 0 筆、該筆 attendance 完好未受影響。

⚠️ 未在正式庫實測的分支：`manual_request_exists`（員工自送 pending/approved 申請時跳過）。現有 2 筆 manual 都是 rejected，觸發不到；該段是 072 同款寫法，且前端測試已涵蓋排除邏輯。

### 一併處理：薪資計算頁也吃確認過的加班

業主指示「要一併吃」。`modules/payroll.js` 兩處 otMap（L184、L828）的 `late_close_auto` 排除已拿掉，改為不分來源加總。

- 安全性：查詢本來就 filter `status='approved'`，pending 與 rejected 不會進來；otMap 是 `calcEmployeePayroll` 加班時數的**唯一**來源，本頁沒有另一條從 attendance 推估的路，不會重複計算
- 追溯影響：查證正式庫 `overtime_requests` 全庫只有 2 筆、皆為 manual + rejected，**沒有任何 late_close_auto 資料**，所以這次改動對歷史薪資數字**零影響**
- 驗證：把兩處 otMap 區塊原樣抽出在 node 跑，餵四種來源資料，兩處各 3 項共 6 項全通

### 未完成 / 待決定

- 確認動作沒有 LINE 通知，主管需自己進打卡總覽看
- 072 的 `sync_late_close_overtime_request()` 仍是孤兒（沒人呼叫），維持原樣。日後若要恢復「員工打卡即產生待審」，必須先補上 18:00 門檻與 17:00–17:30 休息時間，否則會湧入大量假加班

---

## 🟢 2026-08-05 下班定位點統計（近 90 天分群，純前端）

上一節的卡片回答的是「**有沒有**範圍外」，這一節回答「**是不是同一個地方**」。單次落在工廠外可能是外務、送貨、臨時狀況；同一個座標反覆出現才代表有固定模式（例如每天都在住家附近打下班卡）。這個判斷靠翻清單看不出來，必須把座標分群。

### 改動（`attendance_overview.html`，無 migration、無 DB 寫入）

| 位置 | 內容 |
|------|------|
| 「下班定位查核」卡片 | 近 30 天無異常時**不再整張隱藏**，改顯示灰色空狀態＋「近 30 天無異常」badge |
| 「📊 定位點統計（近 90 天）」按鈕 | 點了才查，**刻意不進 30 秒自動刷新**——90 天資料量是 30 天的三倍 |
| `clusterPoints()` | 貪婪分群，100m 內視為同一地點；群心用累進平均 |
| `renderCheckoutClusters()` | 重複出現的地點排前面並標紅（「地點 A · 重複 3 次」），單次出現為灰色；列出人員、每次的日期時間、群心座標與群內最大偏移 |

**為什麼空狀態要保留卡片**：範圍外事件很稀疏（4 個月 6 筆），30 天內常常剛好是空的。若沿用原本「沒有異常就整張隱藏」，90 天統計的按鈕會**沒有地方按**，功能等於藏起來。

**為什麼是 90 天**：分群要看得出「重複」，窗期太短每個點都會是單次，分群本身就沒有意義。

### 驗證

同樣把 inline script **原樣載入 vm sandbox 執行**（只補 DOM／supabase 替身，`calculateDistance`／`escapeHTML` 直接從 `common.js` 取真本），44 項全通：分群邊界（3 群大小 [3,2,1]、群心落在成員之間、單點群 spread=0、空輸入）、渲染輸出（重複次數標示、排序、同群同一人不重複列名、XSS 逃逸）、90 天窗期跨月／跨年／閏年／DST 共 6 個日期 span 皆為 89、`fmtDistance` 邊界（999.5 不顯示成 1000m）。

**反向對照**：把下述兩個修正撤掉後重跑同一份測試，44 通過掉到 41，失敗的正是對應的三題——確認測試擋的是真的行為，不是空轉。

qa_check ALL PASS、npm test 52/52、inline script `node --check` 兩段皆通過、多租戶 hook 仍為既有 6 筆無新增。

### 走查時補掉的四個洞

1. **空狀態殘留舊清單**：空狀態只把明細 `display:none` 沒清 `innerHTML`，而標題列仍可點——從有異常的日期切到無異常的日期後點開，會看到**上一個窗期的舊資料**配著「無異常」badge。已補 `innerHTML = ''`
2. **換日期後 90 天快取不失效**：`clusterLoaded` 一旦為 true 就不再重查，但窗期是以「選定日期」往回推的，換日期等於換窗期。已在 `onDailyDateChange()` 重置，面板展開中則立即重查。**刻意不掛在 `loadDailyData()`**——後者每 30 秒自動刷新會呼叫，掛上去就變成每 30 秒重抓 90 天，正是要避免的
3. **`loadCheckoutClusters()` 缺 `currentCompanyId` 守衛**：與 `loadCheckoutDistances()` 不一致，補上後不會送出 `company_id` 為 null 的查詢
4. **`spread` 標示不誠實**：原本記的是「加入當下對**當時**群心的距離」，但群心會隨後續加入而移動，與畫面上顯示的最終座標對不起來。改為分群結束後對最終群心重算

### 已知限制

- 分群門檻 100m 是固定值，未隨地點半徑調整
- 群標籤用 A~Z 循環，超過 26 群會重複字母（實測 4 個月只有 6 筆範圍外，不會觸及）
- `limit(3000)`：90 天實際約 600 筆有座標的下班卡，遠低於上限；掃描筆數有顯示在面板抬頭，真的被截斷業主看得出來

---

## 🟢 2026-08-05 下班打卡取消 GPS 精度門檻（純前端）

107 上線當天下午 17:02:38 就出現反例：**E820 黃秀娟的下班卡因 GPS 精度 2000m 轉待審**，attendance 下班欄空白。她早上的上班卡（超範圍 888m）已被核准、當天有 attendance 列，所以她卡的不是 107 修的 `no_open_check_in_record`，而是前端 `checkin.html` 的 500m 精度門檻——**那道檢查跑在呼叫 `quick_check_in` 之前**。

### 為什麼拿掉精度門檻不降低防弊能力

**精度 ≠ 位置。**「精度 2000m」是手機自評的誤差範圍，不是人離公司 2000m：

| 情境 | 精度 | 500m 門檻 |
|------|------|----------|
| 人在工廠、iPhone 關了精確位置 | 2000m | ❌ 擋下 |
| 人在家、GPS 訊號良好 | 10m | ✅ 暢通 |

這道門檻擋的是「定位不準的誠實員工」，放過的是「在錯的地方的人」。下班真正該把關的是**距離**（作弊法是早退後在家補打下班卡多賺工時），而下班**本來就完全不驗打卡範圍**（`quick_check_in` 下班分支提前 RETURN）——所以該漏洞今天就已經是開的，精度門檻一分忙也沒幫上。拿掉它，防弊能力不變（本來就是 0），只是不再懲罰 E820 這類人。

### 改動

`checkin.html` 兩個拍照流程的精度判斷都加上 `currentCheckInType === 'in' &&`，並把後續的 `submitLowAccuracyReviewRequest` 參數由三元式改為寫死 `'check_in'`（該分支已不可能是下班）。**上班規格完全不變**，`gps_relaxed` 旗標（23 人中 3 人已開）行為也不變。

查證 `submitOutsideRangeReviewIfAllowed` 對下班本來就走不到：`canSubmitOutsideRangeReview` 要求 `rpcData.error === 'outside_allowed_location'`，而下班分支永遠不回這個錯。**改完後下班完全不會被送待審。**

### 下班打卡現行規格（改後）

| 檢查 | 下班 |
|------|------|
| 拍照上傳 | ✅ 要 |
| 取得 GPS（拒絕授權／抓不到）| ✅ **仍然擋** |
| 精度過於精確（模擬定位偵測，門檻 0）| ✅ 要（實務不觸發）|
| **精度 > 500m** | ❌ **本次取消** |
| 找不到當天上班記錄 | ⚠️ 107 已放寬 |
| 超過下班截止（17:00＋8h＝01:00）| ✅ 要 |
| 今天已打過下班 | ✅ 要 |
| 打卡範圍／距離 | ❌ 本來就不驗 |

### 驗證

無法在瀏覽器實測，依 CLAUDE.md 用 code review ＋ logic walkthrough 替代，6 情境全通：下班精度 2000m 放行／上班精度 2000m 仍待審／下班拒絕 GPS 授權仍擋／早上待審＋下午下班（疊加 107）成功／`gps_relaxed` 三人無副作用／下班超過 01:00 仍擋。`node --check` inline script PASS、qa_check ALL PASS、npm test 52/52、hook 無新警告。

### 未做（業主待決）

真正對應下班作弊的把關是「**記錄距離並在打卡總覽標紅範圍外**」——不擋人但業主看得到。真實座標本來就存在 `checkout_latitude/longitude`，只是沒有任何介面呈現。這就是 2026-08-04 那則「上下班 GPS 規格不一致」三選一的第三案，業主仍未決定。

另：`refineGpsIfNeeded` 未動——精度不足時下班仍會等最多 15 秒嘗試取得更好座標（`GPS_REFINEMENT_TIMEOUT_MS`）。保留是因為那個座標是下班唯一的稽核訊號，且頁面載入時已在背景先跑（`startBackgroundGpsRefinement`），多數情況不會真的等滿。若業主嫌慢可再拿掉。

---

## 🔴→🟢 2026-08-05 上班卡待審時下班卡被擋（migration 107）＋送待審通知主管

業主問「下班應該是沒問題的吧，因為沒有設定 GPS 範圍」。範圍確實不驗（`quick_check_in` 下班分支在 L262 就 `RETURN`，範圍比對寫在 L272-299，執行流程走不到），**但下班還有別的關卡，而且其中一道就是 E815 缺下班卡的真正原因**。

### 根因：早上的卡卡在待審，傍晚下班就打不進去

1. GPS 失敗（精度 >500m 或超出範圍）時 `checkin.html` **不寫 attendance**，只送一筆 `makeup_punch_requests` 待審，員工看到「✅ 已送出待審核」
2. 當天沒有 attendance 列 → 傍晚打下班卡，`quick_check_in` 走到 `ELSIF p_action = 'check_out'` 發現 `v_existing.id IS NULL` → 回 `no_open_check_in_record`
3. 員工打不了，隔天說「系統有問題」

**資料 100% 吻合，E815 九天 GPS 待審無一例外：**

| 日期 | 核准延遲 | 當天下班卡 |
|------|---------|-----------|
| 06-09 | 13 分鐘 | ✅ 17:09 |
| 06-10 | 13 分鐘 | ✅ 17:05 |
| 07-03 | 主管 17:18 核准 | ✅ **17:19（核准後 1 分鐘）** |
| 06-26 | 153h | ❌ 缺 |
| 06-24 | 201h | ❌ 缺 |
| 06-17 | 369h | ❌ 缺 |
| 06-16 | 393h | ❌ 缺 |

當天批得到就打得到，隔夜才批就缺卡。07-03 是決定性證據。

### 下班會被擋的五個地方（本次查證釐清）

| 關卡 | 位置 | 狀態 |
|------|------|------|
| 找不到當天上班記錄 `no_open_check_in_record` | `quick_check_in` L151-153 | 🔴 主因 → **107 已修** |
| GPS 精度 >500m 轉待審 | `checkin.html` L844-846（上下班共用）| ⚠️ 仍在，E815 6/4 中過 |
| 超過下班截止 `checkout_time_expired` | `quick_check_in` | ✅ 已放寬到 01:00 |
| 今天已打過下班 `already_checked_out_today` | `quick_check_in` L74 | ✅ 正常防呆 |
| 打卡範圍 `outside_allowed_location` | L292-297 | ✅ 下班走不到 |

附帶查證：`kiosk_check_in`（公務機打卡）不驗 GPS 精度（0 處）、不驗範圍（0 處）、不會回 `no_open_check_in_record`，直接 `INSERT INTO attendance`——E815 07-01 就是靠這個脫困的。

### migration 107 修正內容

`check_out` 分支：當天沒有 attendance 列時，**若該員工當天確實有 pending／approved 的「上班」補卡申請**，先建立當日空白列再讓下班寫入。之後主管核准上班卡，`approve_makeup_request` 的 `ON CONFLICT (employee_id, date) DO UPDATE` 會把 `check_in_time` 填回同一列，`trg_calc_work_hours` 重算工時。

**刻意不做**：沒有任何上班申請的人仍然擋著（避免幽靈下班卡）；昨天的待審上班卡不處理（下班截止已放寬到 01:00，窗口極窄）。

### checkin.html：送待審時通知主管

`submitGpsReviewRequest()` 原本**完全沒有呼叫 `sendAdminNotify`**——這是待審件躺 6~16 天的根因（handover #75 已查出，當時 Spec Lock 2 刻意先不修、等資料）。本次補上，fire-and-forget 不 await（`sendAdminNotify` 內部自帶 try/catch）。

### 正式庫實測（2026-08-05，測試資料事後全清、四項計數歸零）

用業主 admin 帳號（Adam，當天 0 出勤列 / 0 補卡申請）：

| # | 步驟 | 結果 |
|---|------|------|
| 1 | 套用 107 **前**呼叫 `check_out` | ✅ `no_open_check_in_record`（基準）|
| 2 | 套用 107 | ✅ `v_has_pending_checkin` 已在函式內，`anon` EXECUTE 權限未掉 |
| 3 | 無待審申請時呼叫 `check_out` | ✅ **仍擋**——沒開出幽靈下班卡的洞 |
| 4 | 建立 pending 上班補卡（08:00）| ✅ 仍無 attendance 列，重現 E815 處境 |
| 5 | 再呼叫 `check_out` | ✅ `success:true`，建立 `check_in=null` / 下班 14:30:37 / 工時 0.00 的列 |
| 6 | 核准上班補卡 | ✅ 上班 08:00 填回**同一列**，工時 **5.51**（6.51 扣午休 1 小時）|
| 7 | 清空 | ✅ Adam 出勤列 0、殘留測試申請 0、缺卡追蹤 0，未波及 E815 |

qa_check ALL PASS、npm test 52/52、`node --check` checkin.html inline script 通過、hook 警告與改動前逐筆比對仍為既有 6 筆無新增。

> ⚠️ **操作鐵則（本次踩到）**：Windows PowerShell 5.1 的 `Get-Content -Raw` **預設用 ANSI（Big5）解碼**，讀含中文註解的 UTF-8 migration 會吞掉換行（本次吞了 40 個），造成 PG 回報的行號與檔案對不上的假語法錯誤。必須用 `-Encoding UTF8`，或 `[System.IO.File]::ReadAllText(path, [System.Text.Encoding]::UTF8)`。

### 未做

`attendance_anomalies` 沒有 `missing_checkin` 類型，「只有下班卡」的日子不會被稽核標記。但 107 的放行條件保證那天一定有一筆待審申請躺在審核清單，加上本次補的 `sendAdminNotify`，不會無聲遺失。

---

## 🔴→🟢 2026-08-05 補打卡只驗日期不驗時間（migration 106）＋E815 打卡稽核

業主圈出畫面問「為什麼今天早上就能補今天 8/5 的下班紀錄」。

**根因：`submit_makeup_punch`（097/098）只驗日期三項（不得為空／不得未來／7 天窗口），`punch_time` 完全不驗；`records.html initMpDate()` 日期欄預設今天。**

E815 邱順麟 08-05 08:22 打完上班卡後，日期欄不用動就是 08-05，選「下班 17:00」→ 系統判定「08-05 不是未來日期」→ 通過，主管 09:49 核准，`approve_makeup_request` 立刻寫入 attendance → **人還在上班，工時 7.62h 就記完了**。更糟的是當天真的 17:00 打卡時 `quick_check_in` 會回 `already_checked_out_today`，**他反而打不了卡，隔天又會說系統有問題**。從理由「[忘記打卡] 應該是有打」的過去式語氣與 8/4 缺下班卡研判，他真正想補的是 8/4。

同一個缺陷造成的第二類壞資料：**下班時間填成上午**。E815 07-23 補「下班 05:00」（應為 17:00），上班 08:18 → `total_work_hours` **0.00h**，整天工時歸零。全庫同型 2 筆，皆為 05:00（另一筆是 2026-04-07 admin 測試資料）。

### migration 106 修正內容

| 檢查項目 | 修正前 | 修正後 |
|---------|-------|--------|
| 當天補卡時間不得晚於現在 | ❌ 無 | ✅ `punch_time_in_future` |
| 下班不得早於當日上班 | ❌ 無 | ✅ `checkout_before_checkin` |
| 上班不得晚於當日下班 | ❌ 無 | ✅ `checkin_after_checkout` |

`submit_makeup_punch`（員工自助）與 `admin_makeup_punch`（管理員代補）兩支都加。管理員「不限回溯日期」的政策不變。
前端 `common.js submitMakeupPunch()` 加同樣的未來時間即時提示，新增 `getTaiwanTimeHM()` helper（用 `hourCycle: 'h23'`，部分 WebKit 用 `hour12: false` 會把午夜輸出成 `24:xx` 導致字串比大小失效）。

**安全性查證：正式庫無跨夜班員工（`fixed_shift_end <= fixed_shift_start` 共 0 人），故「下班早於上班」不會誤擋正常班別。**

### 正式庫實測（2026-08-05，測試資料事後清空、殘留 0 筆）

| # | 案例 | 結果 |
|---|------|------|
| 1 | 員工補當天 17:00（現在 10:31）| ✅ 擋 `punch_time_in_future` |
| 2 | 員工補當天下班 07:00（上班 08:22）| ✅ 擋 `checkout_before_checkin` |
| 3 | 員工補當天下班 09:00（合理）| ✅ `success: true`（未回歸）|
| 4 | 員工補 07-28（超出 7 天窗口）| ✅ 擋，窗口驗證未回歸 |
| 5 | 管理員補當天 23:00 | ✅ 擋 |
| 6 | 管理員重現 7/23 誤填 05:00 | ✅ 擋 |

`proacl` 確認 anon／authenticated EXECUTE 未因 `CREATE OR REPLACE` 掉失。

### 資料處置（業主授權）

8/5 的假下班卡已撤銷：attendance `check_out_time`／`check_out_location`／`total_work_hours` 清空，補卡申請 `cfa8af15` 改 `rejected` 並記明原因。他當天可正常打下班卡。

**未處理（待業主決定）**：7/23 的 05:00（工時 0.00h 未更正）、8/4 缺下班卡（仍 pending）。

### E815 邱順麟 打卡稽核

完整紀錄見 **`docs/E815_PUNCH_AUDIT.md`**。重點：6/1–8/5 共 46 個工作日，缺下班卡 5 天（11%）；補卡 15 筆中**只有 3 筆是他主動申請**，其餘 11 筆是 GPS 失敗被系統自動轉待審、1 筆管理員代補。他抱怨的是下班，但**上班卡問題（11 天定位異常）遠多於下班卡**。

他與 E818／E820 的定位問題不同型：那兩位誤差 900–1200m（關閉精確位置），**E815 精度正常但距離固定超出約 369–405m**，屬打卡半徑／座標問題。大正目前只剩「工廠」一個地點、半徑 600m，仍固定超出約 400m → **需實地量測調整座標或半徑，否則他的上班卡會持續進待審**。

### 未做

主管核准介面沒有異常提示——05:00 下班、17:00 未來時間兩筆都被一鍵核准。建議審核清單對異常時間標紅。

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

## 2026-08-10 修復紀錄

- **B48**（已修復、待手機實測）：iPhone／LINE WebView 下班打卡時，相機預覽正常但按下打卡後可能一直停在「處理中」；60 秒安全逾時會停止相機，原本的重試卻直接再次截圖，導致從已停止的串流取得 0×0 畫面並顯示「照片處理失敗」。修法：`checkin.html` 拍照前驗證 MediaStream track、readyState 與 videoWidth/videoHeight；相機已停止時自動重開並等待有效畫面。`canvas.toBlob()` 加 3 秒逾時，空值、丟錯或 callback 不回時改走 `canvas.toDataURL()` 備援；兩種拍照模式共用同一 helper。每次打卡加入 attempt id，60 秒逾時後使舊流程失效，後續 await 不再覆蓋畫面或送出舊操作；失敗記錄新增 camera/photo/upload/gps/rpc 階段。新增 `tests/checkin-photo-retry.test.js` 並納入 `npm test`，自動模擬 toBlob 正常、空值、永不回應、丟錯、相機 track ended、0×0 畫面與重開等待，共 21 項。考勤規則未變：下班仍需取得座標，但不受 500m GPS 精度門檻阻擋。

- **B49**（已完成、第二輪手機實測中）：打卡頁新增「🩺 打卡環境檢查」，在不送出打卡、不寫資料庫、不上傳照片的前提下，逐項檢查 LINE／員工身分、正式站網路、相機有效畫面、記憶體 JPEG 編碼與定位。結果提供白話處理方式及不含姓名、ID、照片、精確座標的可截圖摘要；系統相機 fallback 可另拍一張不會上傳的測試照。新增 `tests/checkin-health-check.test.js`，鎖定隱私摘要、錯誤分類及禁止 `quick_check_in`／Storage／資料庫副作用。`npm test` 內的舊 smoke 改走 `SKIP_EXTERNAL_SMOKE=1`，避免 CI／日常測試寫入再刪除正式 `error_logs`；單獨執行 `npm run test:smoke` 時仍保留原 live 測試。第一版驗證：目標測試 21/21、`npm test` 7/7 suites、UI 29/29、qa_check 0 FAIL／1 既有 WARN、hook 無新增警告、rls-checker PASS。Android／LINE 第一輪實測發現定位關閉時約等 30 秒且問題色彩不夠醒目；第二版改為不讀舊快取、最多約 7 秒的全新定位探測，不改正式打卡定位流程，定位拒絕／不可用／逾時會提供 Android／iPhone 對應設定路徑。失敗總結改為深紅底，失敗項目改為紅色卡片與黃色處理步驟框；專用測試擴充至 30 項並以真實瀏覽器手機尺寸確認視覺結果。

## 2026-08-11 修復紀錄

- **B50**（已修復、待手機實測）：同樣是「今日上班卡待主管審核」，部分員工可先下班、部分員工首頁卻必須等主管核准才出現下班按鈕。原因是 migration 107 後端已允許今日有 pending／approved 上班補卡時先寫下班，但 `common.js updateCheckInButtons()` 仍只認正式 attendance，沒有使用已載入的 `todayPendingMakeups`。修法：待審清單 RPC 補 `p_company_id` 限定目前公司；新增 `getTodayPendingPunchState()` 統一 `clock_in/check_in` 與 `clock_out/check_out`；狀態優先序固定為跨日班 → 下班待審 → 上班待審 → 昨日一般班漏下班 → 未上班。今日只有上班待審時停用重複上班、開放下班，若同時有昨日漏卡仍保留補卡提醒；今日下班已待審則停用兩按鈕防重送。所有 `common.js` 引用同步升為 `20260811-pendingcheckout`。新增 `tests/pending-checkout.test.js`，目標測試 18/18、完整 `npm test` 8/8 suites、UI 29/29、QA 0 FAIL／1 既有 WARN、RLS Hook 0 問題、多租戶 Hook 無新增警告、rls-checker PASS；沒有修改 migration 107、正式打卡 RPC 或資料庫結構。

## 2026-08-14 修復紀錄

- **B51**（已實作、隔離測試及正式部署完成）：考勤核對把上午半天假後的下午到班誤算成從 08:00 遲到，時數假只能手填整數時數，整日假又以日曆天重算，造成遲到與請假時數失真。修法：`migrations/113_hourly_leave_time_range.sql` 新增實際起訖時間與具公司隔離的新 RPC；時數假限定同一天並由 DB 自動計算。共用前端計算規則為核准上午半天從 13:00 判斷遲到，連續銜接上班起點的時數假才延後基準，待審假不抵遲到；整日假採 DB 已排除休假日的 `days`。`migrations/114_missing_work_hours_audit.sql` 新增隔日晚到、早退、整日無打卡稽核，沿用公司容忍分鐘，排除休假日、免打卡、公務機、跨日班、待審補卡與既有未下班異常。2026-08-15 已先在隔離測試專案 `vtlvjbwqrvhfgivbmmaa` 以虛構資料驗證，之後於 11:26 在正式專案 `nssuisyvlrqnqfxupklb` 以單一交易依序套用 113/114/115；三個欄位、兩個約束、14 個 RPC 與 09:15 cron 唯讀驗證通過，通知 gate 維持 0/關閉，pg_net 佇列為 0，未人工掃描或發送 LINE。

## 2026-08-15 修復紀錄

- **B52**（已實作、隔離測試及正式部署完成）：migration 114 原本套用後就建立每日 09:15 缺時掃描與 LINE 發送排程；正式環境已有公司開啟 `attendance_audit_enabled`，主管可能尚未核對新缺時名單就開始通知。修法：`migrations/115_gate_missing_work_hours_notifications.sql` 新增獨立的 `missing_work_hours_line_notifications_enabled`，設定不存在或非 true 一律不發 LINE；每日排程仍更新 anomaly，但在讀 Token 前先略過未啟用公司。新增三支公司／管理權限驗證 RPC，供管理端讀寫開關及「掃描但不通知」；人工掃描只更新 `attendance_anomalies`，不呼叫 pg_net、不改 attendance、不建立請假。專屬驗權 helper 只允許同公司 admin／manager 或受派平台管理員，並明確排除公務機。隔離測試驗證預設關閉、跨公司／公務機拒絕、掃描通知 0 與同日防重複；2026-08-15 正式套用後再次確認設定 0 筆、啟用 0、pg_net 佇列 0，通知保持關閉。

- **B53**（已實作、待實機驗收）：員工考勤月曆只要有 attendance 就顯示「正常出勤」，導致 8/10 只有上班 19:52、沒有下班仍出現綠色正常；員工進補卡頁填 05:00 或 17:00 時，因早於 19:52 才在送出後被 migration 106 擋下。修法：`records.html` 對過去日期新增「缺上班／缺下班」狀態與待補日期清單，一鍵帶入日期與類型；下班補卡時間尚未手動輸入時帶公司設定或 17:00，明示「下午 5:00」。若已知 17:00 不晚於上班 19:52，前端先停用送出並提示主管更正既有上班紀錄；資料庫先後順序驗證、7 天期限與審核流程不變。既有月考勤 RPC 沒有公司參數，因此只有單一公司員工會載入待補清單；多公司與平台管理員帳號停止載入並顯示安全說明，避免跨公司混用。專項測試 22/22、完整 11 套測試通過，QA 0 FAIL／1 既有 WARN；未新增 migration、RPC 或資料庫寫入。

- **B53 補充**（已實作、待 LINE 實機驗收）：補打卡申請失敗文字原本繼承共用 toast 的 `white-space: nowrap`、`overflow: hidden` 與省略號，手機只能看到前半段。`records.html` 改為頁面局部換行樣式，保留左右 16px 與底部 safe-area；`showToast()` 對超過 32 字的訊息延長為 6 秒，短訊息仍為 3 秒。專項回歸 25/25、完整 11 套測試、QA 0 FAIL／1 既有 WARN 通過；390×844 瀏覽器實測中文錯誤訊息完整三行、左右各 16px、無省略號。

- **B54**（已修復、待 LINE 實機驗收）：Android 原生 `type=time` 依手機地區設定可能把 `17:00` 畫成沒有下午標記的 `5:00`；改為固定 `HH:mm` 的數字文字輸入，支援 `1700` 正規化成 `17:00`，送出前拒絕無效時間。Adam 以平台管理身分進入時，原本的多公司安全限制會直接隱藏待補清單；改用既有 `get_company_daily_attendance`，傳目前公司與 LINE 呼叫者，並只保留目前員工 ID，2026/08/10 只有上班卡時列出「補下班卡」。專項 31/31、完整 11 套測試、QA 0 FAIL／1 既有 WARN、RLS 複審通過；390×844 瀏覽器驗證顯示 `17:00` 與「2026-08-10／已有上班 19:52／補下班卡」。未新增 migration、RPC 或資料庫寫入。

- **B55**（已修復、待 LINE 實機驗收）：待補日期清單未檢查員工的 `no_checkin`，造成已勾選免打卡的 Adam 仍被列出 8/11～8/14 整日上下班待補。修正後只排除免打卡人員的整日無紀錄；若該日已有單邊打卡，仍保留缺少另一張卡的導引。管理員角色本身不自動免打卡，必須以員工資料的 `no_checkin=true` 為準。專項 34/34、完整 11 套測試、QA 0 FAIL／1 既有 WARN、OpenSpec strict 與 RLS／多租戶複審皆通過；未新增 migration、RPC、資料庫或 LINE 副作用。

- **B55 實機補強**（migration 116，隔離測試已通過、未套正式庫）：正式頁面確認 8/11～8/14 已消失，但 8/10「已有上班 19:52／補下班卡」也消失。根因不是前端判斷，而是 migration 100 的 `get_company_daily_attendance` 以 `no_checkin=false` 無條件排除免打卡人員，單邊 attendance 根本沒有傳到頁面。migration 116 保留原 RPC 簽章、管理者驗權、公司隔離與全部回傳欄位，只把篩選改為「免打卡且上下班都空才排除；任一側已有紀錄就回傳」。已確認隔離 Project Ref `vtlvjbwqrvhfgivbmmaa` 不等於正式 `nssuisyvlrqnqfxupklb`，並在隔離庫套用；部署後唯讀核對函式指紋、`SECURITY DEFINER`、`search_path=public`、公司／主管驗權及 anon/authenticated EXECUTE 權限，5 組 SQL 真值案例全數通過且未留下虛構資料。隔離庫為精簡 schema，缺少正式 RPC 的部分顯示欄位，因此未用永久 ALTER／測試資料直接呼叫完整 RPC；專項 39/39、完整 11 套、RLS 15/15、QA 0 FAIL／1 既有 WARN、OpenSpec strict 與 RLS 複審通過。正式資料庫仍未套用。

- **B56**（已實作、待 LINE／手機實機驗收）：B54 為了讓 Android 明確顯示 `17:00`，把原生時間欄位改為文字輸入，造成「實際打卡時間」旁的時鐘選取入口消失。修法：保留固定 `HH:mm` 可編輯欄位，新增明確的 🕒 時鐘按鈕；按下後開啟原生時間選取器，LINE WebView 不支援時自動回退。選到的時間同步回 `HH:mm` 欄位、視為手動選擇，並立即重跑「下班不可早於已知上班時間」防呆。專項回歸 43/43；未新增資料庫讀寫、RPC、LINE、排程或 migration。
