# 任務拆解：外勤里程表起訖登錄（fieldwork-odometer）

> 依 CLAUDE.md 規則：全程在 dev 分支；每個任務完成後跑 `bash scripts/qa_check.sh`（0 FAIL）＋ `npm test`（52 通過）；Hook 新警告視同 FAIL。

## Task 1：migration 093 建表與加欄位 ⏳（SQL 完成，正式庫套用待 user 授權）

**修改檔案**：`migrations/093_fieldwork_odometer.sql`（新增）

**做什麼**：
1. 建 `field_work_trips` 表（欄位、CHECK、索引、同員工同日僅一筆 open 的 partial unique index，見 design.md §1.1）
2. `field_work_logs` 加 5 欄：`trip_id / odometer_reading / odometer_photo_url / segment_km / gps_distance_km`（`ADD COLUMN IF NOT EXISTS`）
3. 套用到正式庫（SQL Editor）

**驗收條件**：
- [ ] SQL 可重複執行不報錯（IF NOT EXISTS 齊全）
- [ ] anon REST 驗證：`field_work_trips` 可 select（回 `[]` 或資料，不是 42P01）；`field_work_logs?select=trip_id,odometer_reading,segment_km` 不回 42703
- [ ] 實測 partial unique index：同員工同日 insert 兩筆 status='open' → 第二筆報 23505

## Task 2：fieldwork.html 行程卡片（出發登錄／收工登錄）✅

**修改檔案**：`fieldwork.html`

**做什麼**：
1. Tab1 摘要卡上方加「🚗 今日行程」卡片，三種狀態：未出發（出發登錄表單）／進行中（顯示出發讀數＋收工登錄）／已收工（顯示 total_km）
2. `loadTodayTrip()`：查當日 trip（`.eq('employee_id', currentEmployee.id).eq('trip_date', getTaiwanDate())`）；偵測到昨日 open trip 自動 close（design.md §6）
3. 出發登錄：讀數必填＋選填拍里程表照（沿用既有壓縮上傳，路徑 `fieldwork/odo_trip_*`）＋ getGPS（失敗仍可送出）→ insert 帶 `company_id: currentCompanyId`
4. 收工登錄：結束讀數 ≥ 最後讀數點驗證 → update `status='closed'`、`total_km = end − start`

**驗收條件**：
- [ ] logic walkthrough：未出發／進行中／已收工 三狀態渲染正確，重新整理後狀態不變
- [ ] 結束讀數 < 最後讀數點 → 擋下並提示
- [ ] GPS 失敗（模擬 getGPS reject）→ 出發登錄仍成功、lat/lng 為 null
- [ ] 照片上傳失敗 → 提示但讀數仍送出成功
- [ ] insert 帶 company_id（grep 確認）；查詢帶 employee_id filter（多租戶）
- [ ] `node --check`（抽出 inline script）語法通過

## Task 3：fieldwork.html 到達打卡整合讀數與自動計算 ✅

**修改檔案**：`fieldwork.html`

**做什麼**：
1. 到達打卡表單：有 open 行程時顯示「當下里程表讀數 *」＋「📷 拍里程表」（單張，寫 `odometer_photo_url`）；無行程時隱藏並顯示灰字提示
2. `fwArriveCheckin()`：有行程時讀數必填、須 ≥ 前一讀數點、差額 >200km confirm；insert 一併寫 `trip_id / odometer_reading / odometer_photo_url / segment_km / gps_distance_km`
3. 新增 `haversineKm(lat1,lng1,lat2,lng2)` 工具函數；前一 GPS 點取序：前站 leave → 前站 arrive → trip start（design.md §2.2）
4. 今日摘要「里程(km)」：有行程 → Σ segment_km（closed 後 total_km）；無行程 → Σ mileage。紀錄列優先顯示 segment_km
5. `resumeFieldWork()` 草稿回填：帶回 odometer_reading / odometer_photo_url

**驗收條件**：
- [ ] logic walkthrough ≥3 情境：①第一站（前一點=trip start）②第二站（前一點=前站讀數/GPS）③無行程（舊流程不變、mileage 照舊）
- [ ] 讀數 < 前一讀數點 → 擋；segment>200 → confirm
- [ ] haversineKm 單元驗證：台北101(25.0340,121.5645)→台北車站(25.0478,121.5170) ≈ 5.0±0.3 km（bash node 實跑給輸出）
- [ ] 無行程模式完全不受影響（既有欄位 id 全部保留，回歸：離開打卡自填 mileage 仍可送出）
- [ ] `node --check` 通過；qa_check 0 FAIL；npm test 52 通過

## Task 4：管理端審核與匯出（modules/settings.js）✅

**修改檔案**：`modules/settings.js`

**做什麼**：
1. 審核列表：里程改顯示 `segment_km ?? mileage`；符合 design.md §2.3 警示條件的列加 ⚠️
2. `showFwaDetail()`：新增里程表區塊（到站讀數、區間公里、GPS 直線距離、警示文字、里程表照片可點擊放大）；以 trip_id 查 `field_work_trips`（`.eq('company_id', window.currentCompanyId)`）顯示出發/收工讀數與 total_km
3. `exportFieldWorkCSV()` 加欄：出發讀數、到站讀數、區間公里、GPS直線距離、警示、當日總公里
4. 警示判斷邏輯抽成小函數（列表與明細共用）

**驗收條件**：
- [ ] trips 查詢帶 company_id filter；logs 查詢維持 employees!inner 模式（Hook 無新警告）
- [ ] 舊資料（無 trip_id）明細不顯示里程表區塊、不誤報警示（null 安全）
- [ ] 警示函數 bash node 實跑 4 案例：低於直線×0.8 ⚠️／正常區間無警示／高於直線×3+5 ⚠️／gps null 無警示
- [ ] CSV 欄位順序與表頭正確（node 實跑產出範例列）
- [ ] qa_check 0 FAIL；npm test 52 通過

## Task 5：整合驗證與收尾 ⏳（文件/測試完成；REST 實測與 rls-checker 待 migration 套用）

**修改檔案**：`docs/BUG_TRACKER.md`、`.claude/memory/architecture.md`

**做什麼**：
1. 端到端 walkthrough（code review 替代，LIFF 頁無法 bash 執行）：出發登錄 → 站1 到達（讀數+照片）→ 離開 → 站2 → 收工，核對每步 DB 寫入欄位
2. 正式庫用測試資料實測一輪 REST insert/update（employee 用 E826 id），驗證 segment 計算寫入後管理端查詢可帶出，測完刪除測試資料
3. `@rls-checker` 最終審查（改動 ≥3 檔且涉及新資料表）
4. 更新 BUG_TRACKER.md 功能狀態、architecture.md 技術決策（新表、計算規則、警示門檻）
5. 回歸清單：index.html 首頁格子顯示正常、fieldwork.html 三 tab 可切換、admin.html 外勤審核可開啟

**驗收條件**：
- [ ] REST 實測輸出貼在驗收證據（trip insert → log insert 含 segment_km → 管理端查詢帶出 → 測試資料已刪）
- [ ] rls-checker 報告 PASS
- [ ] qa_check 0 FAIL；npm test 52 通過；Hook 無新警告
- [ ] git commit 訊息含：改了什麼／為什麼／測試了什麼；push origin dev（不動 main）
