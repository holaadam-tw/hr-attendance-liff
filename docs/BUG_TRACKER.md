# RunPiston Bug 追蹤 & 測試清單

> 更新日期：2026-04-22
> 每次修改後更新此檔案

---

## 🔴 未修復 Bug（優先修）

| # | Bug | 嚴重度 | 狀態 |
|---|-----|--------|------|
| 1 | 打卡後首頁狀態不顯示 — LIFF BFCache 問題 | 🔴 嚴重 | 修了 3 次還沒穩定 |
| 2 | 考勤查詢不顯示 — RPC+RLS+時區三重 bug | 🔴 嚴重 | ✅ 已修復（041 SQL）|
| 3 | RLS 未設定 — anon key 可讀所有公司資料 | 🔴 安全 | ✅ 已修復（24+ 個查詢加 company_id）|

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

## 🔵 2026-04-22 修復的 Bug（薪資連動審查）

| # | Bug | Commit | 說明 |
|---|-----|--------|------|
| B13 | 薪資計算未過濾公務機/免打卡員工 → 出現在薪資單且缺勤扣光 | 471f284 | `modules/payroll.js:480` 加 `.eq('no_checkin', false)`，對齊 `get_company_monthly_attendance` RPC（`migrations/059:103,223`）|
| B14 | 月度總覽 vs 薪資單 `expected_days` / `absent_days` 不一致（例：排班 20 天的人薪資按 22 天扣，多扣 2 天） | be7c42f | `modules/payroll.js` 加 `computeEmployeeExpectedDays()` helper，複製 `migrations/059:156-172` 逐日排班判斷邏輯；**月中 preview 不截到今天**（B 方案核心優勢）|

### 📝 本次審查但**非 bug** 的項目

- **加班雙計疑慮**（`payroll.js:515-526`）：經確認 `attendance.overtime_hours` 欄位整個 production 無寫入路徑（`quick_check_in` RPC `migrations/069` 下班 UPDATE 不寫 `overtime_hours`；全 repo grep 無 INSERT/UPDATE 寫入），`if-else` 中 else 分支為 **dead code**，實際不會雙計。但若未來有 migration 啟用 `attendance.overtime_hours` 寫入，`if-else` 二選一陷阱會浮現（漏算非 OT 申請天數），屆時需改為合併邏輯。

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
