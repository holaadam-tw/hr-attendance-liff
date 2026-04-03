# 變更提案：RunPiston v2.5 — 集點完善 + 考勤修正 + DevOps 基礎建設

## 摘要

本次變更包含 9 個待辦項目，分為三大類：

### A. 集點系統完善（項目 1-4）
完善 loyalty 核銷、手動送點、預約集點整合、點餐頁兌換體驗，形成完整的集點閉環。

### B. 考勤系統修正（項目 5-7）
修正早退判定邏輯（凌晨打卡誤判）、打卡結果畫面卡住問題、以及本米公司的打卡地點設定。

### C. DevOps 與品質改善（項目 8-9）
消除 favicon 404 錯誤、建立 GitHub Actions CI 自動測試。

---

## 項目清單

| # | 項目 | 分類 | 影響檔案 | 風險 |
|---|------|------|---------|------|
| 1 | 核銷流程 | 集點 | loyalty_admin.html | 低 |
| 2 | 手動送點 | 集點 | loyalty_admin.html | 低 |
| 3 | 預約完成集點 | 集點 | admin.html, booking_service_admin.html, store.js | 中 |
| 4 | order.html 兌換商品 | 集點 | order.html | 低 |
| 5 | 早退判定修正 | 考勤 | migrations/新 SQL, quick_check_in RPC | 中 |
| 6 | 打卡結果畫面 | 考勤 | checkin.html | 低 |
| 7 | 本米打卡地點 | 考勤 | Supabase 資料設定 | 低 |
| 8 | favicon 404 修復 | DevOps | 18 個 HTML 檔案 | 極低 |
| 9 | GitHub Actions CI | DevOps | .github/workflows/ci.yml | 低 |

## 現狀分析

### 已有基礎（不需從零開始）
- 核銷流程：`loyalty_admin.html` 已有 `verifyRedeemCode()` 和 `confirmRedeem()` 函式（~line 446-504）
- 手動送點：已有送點 tab 和 `doAwardPoints()` 函式（~line 241-288），目前以手機號搜尋
- order.html：已有 `checkMemberPoints()` / `loadLoyaltyRewards()` / `redeemReward()` 完整流程（~line 4375-4556）
- booking_service_admin：已有 `updateBsStatus('completed')` 並觸發集點（~line 399-406）
- checkin.html：已有 10 秒安全計時器和結果畫面（~line 112-118, 425-447）

### 需要新增/修正
- admin.html 餐飲訂位缺少「確認到店」按鈕與集點觸發
- 早退判定 SQL 未處理跨日班別（凌晨打卡誤判）
- 本米公司尚未設定 `office_locations` GPS 座標
- 18 個 HTML 檔案缺少 favicon link tag
- 無 `.github/workflows/` 目錄

## 狀態

- [x] 提案（proposal.md）
- [x] 設計（design.md）
- [x] 任務拆解（tasks.md）
- [ ] 實作（/opsx:apply）
- [ ] 歸檔（/opsx:archive）
