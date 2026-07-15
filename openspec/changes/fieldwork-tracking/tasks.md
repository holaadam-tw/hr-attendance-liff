# 任務拆解：外勤行程地圖＋追蹤模式（fieldwork-tracking）

> 依 CLAUDE.md 規則：dev 分支；每任務後跑 `bash scripts/qa_check.sh`（0 FAIL）；完成後 `npm test`（52 通過）；Hook 新警告視同 FAIL；正式庫 DDL 需 user 授權。

## Task 1：migration 094 軌跡點表＋清理排程 ✅（已套正式庫）

**修改檔案**：`migrations/094_fieldwork_trackpoints.sql`（新增）、`.claude/hooks/check-multitenant.sh`

**做什麼**：
1. 建 `field_work_trackpoints`（BIGINT identity PK、trip_id/employee_id/company_id、recorded_at、lat/lng/accuracy、兩個索引，見 design.md §1.1）
2. GRANT 僅 SELECT/INSERT（無 UPDATE/DELETE——軌跡不可竄改）
3. pg_cron `purge-fw-trackpoints` 每日台灣 02:30 清 90 天前資料（冪等：先 unschedule 再 schedule）
4. Hook 清單加 `field_work_trackpoints`

**驗收條件**：
- [x] SQL 可重複執行不報錯
- [x] 套用正式庫（user 授權）後：anon select 回 `[]`；anon PATCH/DELETE 被拒（無 grant，回 42501）
- [x] `SELECT jobname FROM cron.job WHERE jobname='purge-fw-trackpoints'` 存在且 schedule='30 18 * * *'

## Task 2：fieldwork.html 追蹤模式 ✅

**修改檔案**：`fieldwork.html`

**做什麼**：
1. `startTracking()/stopTracking()`：60s interval 低精度取位（獨立參數，不用共用 getGPS）、accuracy>1000m 丟棄、buffer 批次上傳（滿 3 點或 3 分鐘 flush，一次 insert 多 rows）、失敗保留重試、buffer 上限 30
2. 生命週期接線：出發登錄成功→start；頁面載入有 open trip→start；visibilitychange hidden→stop（含 flush）/visible→start；收工→stop；重複 start 先 clearInterval
3. UI：行程進行中卡片顯示「📡 軌跡記錄中（今日已記 N 點）」；出發表單加知情告知小字
4. GPS 權限拒絕→靜默停用；insert 失敗→try/catch 不影響打卡主流程

**驗收條件**：
- [x] logic walkthrough ≥4 情境：①出發→前景 5 分鐘（預期 5 點、2 次批次上傳）②切背景→回前景（timer 停/續、buffer flush）③收工→timer 停 ④無 open trip 開頁→不啟動
- [x] 節流參數驗證（node 實跑模擬 buffer 邏輯）：3 點觸發 flush、3 分鐘觸發 flush、失敗重試合併、上限 30 丟最舊
- [x] insert 帶 company_id/employee_id/trip_id（grep 確認）
- [x] `node --check` inline script 通過；qa_check 0 FAIL
- [x] 追蹤模式完全不影響既有打卡流程（trackpoints 失敗時到達/離開打卡照常）

## Task 3：管理端行程地圖 ✅

**修改檔案**：`admin.html`、`modules/settings.js`

**做什麼**：
1. `ensureLeaflet()`：動態載入 unpkg leaflet@1.9.4 css+js（Promise 快取）；失敗→文字版時間軸 fallback
2. admin.html 加 `fwaMapModal`（90vw×70vh 地圖容器＋圖例＋關閉）；重開時 `map.remove()` 重建
3. `showTripMap(tripId)`：trackpoints 查詢帶 trip_id+company_id、limit 2000；事件點 marker（出發綠/站點藍 popup 含時間+客戶+segment/gps/收工深灰）；全點按時間排序，相鄰 ≤5 分鐘實線、>5 分鐘虛線；fitBounds
4. showFwaDetail 有 trip_id 時顯示「🗺️ 行程地圖」按鈕
5. 同分鐘重複點去重（多分頁防護）

**驗收條件**：
- [x] 分段邏輯 node 實跑：混合事件點+軌跡點序列 → 正確切出實線/虛線段（含全無軌跡=全虛線、追蹤上線前舊行程案例）
- [x] trackpoints 查詢帶 company_id filter（Hook 無新警告）
- [x] Leaflet 載入失敗路徑有 fallback（code review 確認 promise reject 分支）
- [x] settings.js `node --check` 通過；qa_check 0 FAIL
- [x] 舊資料（無 trip_id / 無軌跡點）不會壞：無 trip_id 不顯示按鈕、無軌跡點畫全虛線

## Task 4：整合驗證與收尾 ✅（線上回歸待合併 main 後）

**修改檔案**：`docs/BUG_TRACKER.md`、`.claude/memory/architecture.md`

**做什麼**：
1. 端到端 walkthrough：出發→前景記點→背景斷→站1→收工→管理端開地圖，核對每步資料流
2. 正式庫 REST 實測（E826 測試資料，過去日期）：trip＋批次 insert 3 個 trackpoints→管理端查詢帶出→anon PATCH trackpoint 被拒→測試資料清除（trackpoints 無 DELETE grant，用 supabase db query 清）
3. `@rls-checker` 審查
4. 更新 BUG_TRACKER.md、architecture.md；npm test 52 通過
5. commit（含改了什麼/為什麼/測試了什麼）→ push origin dev；合併 main 另等 user 授權

**驗收條件**：
- [x] REST 實測輸出完整貼出（含 42501 拒寫證據、清除後 0 殘留）
- [x] rls-checker PASS
- [x] qa_check 0 FAIL；npm test 52 通過；Hook 無新警告
- [ ] 線上回歸（合併 main 後）：fieldwork.html 追蹤狀態列出現、admin 外勤審核地圖可開、大正/本米資料互不可見
