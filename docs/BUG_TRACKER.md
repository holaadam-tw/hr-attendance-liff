# RunPiston Bug 追蹤 & 測試清單

> 更新日期：2026-04-07
> 每次修改後更新此檔案

---

## 🔴 未修復 Bug（優先修）

| # | Bug | 嚴重度 | 狀態 |
|---|-----|--------|------|
| 1 | 打卡後首頁狀態不顯示 — LIFF BFCache 問題 | 🔴 嚴重 | 修了 3 次還沒穩定 |
| 2 | 考勤查詢不顯示 — RPC+RLS+時區三重 bug | 🔴 嚴重 | ✅ 已修復（041 SQL 重建 RPC + UTC 時區字串比較 + debug log）需執行 041 SQL |
| 3 | RLS 未設定 — anon key 可讀所有公司資料 | 🔴 安全 | 未處理 |

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

---

## ⚙️ 系統層級檢查

| # | 項目 | 檢查方式 | 頻率 |
|---|------|---------|------|
| 16 | error_logs | Supabase Dashboard | 每天 |
| 17 | GitHub Actions CI | push dev 自動跑 | 每次 push |
| 18 | QA 腳本 | bash scripts/qa_check.sh | 每次 commit 前 |
| 19 | 冒煙測試 | npm test（49 項） | 每次 commit 前 |
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
