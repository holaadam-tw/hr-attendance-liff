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
