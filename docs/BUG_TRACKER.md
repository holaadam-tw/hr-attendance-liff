# RunPiston Bug 追蹤 & 測試清單

> 更新日期：2026-04-23
> 每次修改後更新此檔案

---

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
