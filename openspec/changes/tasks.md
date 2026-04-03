# 任務清單：RunPiston v2.5

## 任務總覽

| # | 任務 | 分類 | 優先序 | 狀態 |
|---|------|------|--------|------|
| 1 | 核銷流程驗證與改善 | 集點 | P1 | [x] ✅ |
| 2 | 手動送點流程改善 | 集點 | P1 | [x] ✅ |
| 3a | 餐飲訂位「確認到店」集點 | 集點 | P1 | [x] ✅ |
| 3b | 服務業預約「確認完成」集點驗證 | 集點 | P2 | [x] ✅ 驗證通過 |
| 4 | order.html 查點數顯示兌換商品 | 集點 | P2 | [x] ✅ 驗證通過 |
| 5 | 早退判定修正（凌晨打卡） | 考勤 | P1 | [x] ✅ |
| 6 | checkin.html 打卡結果畫面修正 | 考勤 | P2 | [x] ✅ |
| 7 | 本米打卡地點 GPS 設定 | 考勤 | P1 | [x] ✅ |
| 8 | favicon 404 修復 | DevOps | P3 | [x] ✅ |
| 9 | GitHub Actions CI | DevOps | P2 | [x] ✅ |

---

## 任務 1：核銷流程驗證與改善

- **修改檔案**：`loyalty_admin.html`
- **具體做什麼**：
  1. 驗證現有 `verifyRedeemCode()` + `confirmRedeem()` 流程是否正常運作
  2. 核銷成功後加入明確的成功提示（綠色 toast + 動畫）
  3. 核銷成功後自動刷新會員列表
  4. 過期碼 / 已使用碼的錯誤提示要清楚區分
  5. 輸入框自動 focus + 支援 Enter 鍵提交
- **驗收條件**：
  - [ ] 從 loyalty.html 兌換商品取得 6 碼 → 在 loyalty_admin.html 輸入 → 核銷成功
  - [ ] `loyalty_redemptions` 狀態更新為 `status='used'`，`redeemed_at` 和 `redeemed_by` 已填入
  - [ ] 輸入已使用的碼 → 顯示「此兌換碼已使用」
  - [ ] 輸入過期碼 → 顯示「此兌換碼已過期」
  - [ ] 輸入不存在的碼 → 顯示「查無此兌換碼」
  - [ ] 核銷成功後會員列表自動更新

---

## 任務 2：手動送點流程改善

- **修改檔案**：`loyalty_admin.html`
- **具體做什麼**：
  1. 送點 tab 的搜尋欄支援手機號碼和姓名模糊搜尋
  2. 搜尋結果顯示下拉選單（姓名 + 手機末四碼 + 目前可用點數）
  3. 選擇會員後顯示會員資訊卡片
  4. 新增「消費金額」輸入欄位，即時計算並顯示對應點數
  5. 計算公式依據 `loyalty_settings.points_per_amount`
  6. 保留原有的「直接輸入點數」模式作為備選
  7. 確認送出前顯示摘要（會員名稱、金額、點數）
- **驗收條件**：
  - [ ] 輸入手機號碼可搜尋到會員
  - [ ] 輸入姓名可模糊搜尋到會員
  - [ ] 選擇會員後顯示姓名、手機、目前點數
  - [ ] 輸入消費金額 $500，points_per_amount=50 → 自動顯示「= 10 點」
  - [ ] 確認送出後 `loyalty_members.total_points` 正確增加
  - [ ] `loyalty_transactions` 新增一筆 type='earn', source='manual' 紀錄
  - [ ] 送點成功後顯示成功提示並清空表單

---

## 任務 3a：餐飲訂位「確認到店」集點

- **修改檔案**：`admin.html`、`modules/store.js`
- **具體做什麼**：
  1. 在 admin.html 餐飲訂位管理（bookingMgrPage）的訂位列表中，為 status='confirmed' 的訂位加入「✓ 確認到店」按鈕
  2. 點擊後呼叫 `updateBookingStatus(id, 'completed')`（store.js 已有此函式）
  3. 確認 `awardBookingLoyalty()` 正確執行：查詢顧客手機 → 找/建 loyalty_member → 送點 → 寫 transaction
  4. 到店確認後訂位狀態顯示為「已完成」
  5. 已完成的訂位不再顯示操作按鈕
- **驗收條件**：
  - [ ] 已確認（confirmed）的訂位顯示「✓ 確認到店」按鈕
  - [ ] 點擊按鈕後訂位 status 變為 'completed'
  - [ ] 顧客有手機號碼 → `loyalty_members` 點數增加（預設 10 點）
  - [ ] `loyalty_transactions` 新增一筆 source='booking' 紀錄
  - [ ] 顧客無手機號碼 → 不報錯，僅不送點（或提示設定手機）
  - [ ] 已完成訂位不再顯示操作按鈕

---

## 任務 3b：服務業預約「確認完成」集點驗證

- **修改檔案**：`booking_service_admin.html`（可能不需修改，僅驗證）
- **具體做什麼**：
  1. 驗證現有「✔ 完成服務」按鈕（line ~361）的集點邏輯
  2. 確認 `updateBsStatus('completed')` 中的集點程式碼（line ~399-406）正確寫入 DB
  3. 若有缺陷則修正
- **驗收條件**：
  - [ ] 點擊「✔ 完成服務」後 `service_bookings.status` 變為 'completed'
  - [ ] 預約者有 LINE 或手機 → `loyalty_members` 點數增加
  - [ ] `loyalty_transactions` 新增一筆 source='booking' 紀錄
  - [ ] 集點金額依據服務項目價格計算（`service_items.price / points_per_amount`）

---

## 任務 4：order.html 查點數後顯示兌換商品

- **修改檔案**：`order.html`
- **具體做什麼**：
  1. 驗證現有流程：查點數 → 顯示可用點數 → 顯示商品列表 → 兌換
  2. 確認 `checkMemberPoints()` 成功後自動呼叫 `loadLoyaltyRewards()` 並渲染列表
  3. 若商品列表未自動顯示，修正為查完點數後立即展開商品區塊
  4. 商品卡片顯示：名稱、所需點數、兌換按鈕（點數不足時 disabled + 顯示「還差 N 點」）
  5. 兌換成功後顯示 6 碼兌換碼彈窗
- **驗收條件**：
  - [ ] 輸入手機查詢點數後，下方自動顯示可兌換商品列表
  - [ ] 點數足夠的商品顯示「兌換」按鈕
  - [ ] 點數不足的商品顯示「還差 N 點」且按鈕 disabled
  - [ ] 點擊兌換 → 彈出 6 碼兌換碼
  - [ ] `loyalty_redemptions` 新增紀錄，status='pending'
  - [ ] `loyalty_members.used_points` 正確扣除

---

## 任務 5：早退判定修正（凌晨打卡不誤判）

- **修改檔案**：新增 `migrations/033_fix_early_leave_overnight.sql`
- **具體做什麼**：
  1. 修改 `quick_check_in()` RPC 的早退判定邏輯
  2. 查詢班別的 `is_overnight` 欄位
  3. 一般班別（非跨日）：只有在下班前 2 小時至下班時間之間打卡才檢查早退，凌晨打卡（00:00-06:00）不判定
  4. 跨日班別（22:00-06:00）：正確處理跨日時間比較
  5. 無排班時使用 `default_work_end`，凌晨打卡預設不判定早退
- **驗收條件**：
  - [ ] 一般班（08:00-17:00）：16:30 打卡 → 判定早退 ✅
  - [ ] 一般班（08:00-17:00）：00:30 打卡 → 不判定早退 ✅
  - [ ] 一般班（08:00-17:00）：17:01 打卡 → 不判定早退 ✅
  - [ ] 跨日班（22:00-06:00）：05:30 打卡 → 判定早退 ✅
  - [ ] 跨日班（22:00-06:00）：06:01 打卡 → 不判定早退 ✅
  - [ ] 無排班、凌晨 01:00 打卡 → 不判定早退 ✅
  - [ ] 早退容忍分鐘設定（early_leave_threshold_minutes）仍正常運作

---

## 任務 6：checkin.html 打卡結果畫面不卡住

- **修改檔案**：`checkin.html`
- **具體做什麼**：
  1. 確保相機 stream 在所有路徑（成功/失敗/超時）都正確 stop
  2. GPS 取得加入明確的超時處理（目前 10 秒），超時後顯示錯誤而非卡住
  3. 整體打卡流程加入 30 秒最大超時保護
  4. 結果畫面的「✕ 關閉視窗」按鈕：LIFF 環境用 `liff.closeWindow()`，非 LIFF 環境改為「返回首頁」連結
  5. 確認 `showCheckInSuccess()` 正確清除所有 loading 狀態
- **驗收條件**：
  - [ ] 打卡成功 → 顯示結果畫面（時間 + 地點），不卡在 loading
  - [ ] 打卡失敗 → 顯示錯誤訊息 + 重試按鈕，不卡住
  - [ ] GPS 超時 → 顯示「定位逾時，請重試」
  - [ ] 相機權限被拒 → 顯示明確錯誤，不白屏
  - [ ] LIFF 環境：「關閉視窗」可正常關閉
  - [ ] 非 LIFF 環境：顯示「返回首頁」且可正常跳轉

---

## 任務 7：本米打卡地點 GPS 設定

- **修改檔案**：需在 Supabase 執行 SQL（或透過 admin.html 設定）
- **具體做什麼**：
  1. 向用戶確認本米辦公地點的 GPS 座標（緯度/經度）和允許半徑
  2. 在 `office_locations` 表插入資料
  3. 或透過 admin.html 的辦公地點設定 UI 新增
- **驗收條件**：
  - [ ] `office_locations` 表有本米公司（company_id = fb1f6b5f...）的記錄
  - [ ] latitude、longitude 為正確的 GPS 座標
  - [ ] radius 設定為合理值（建議 100-500 公尺）
  - [ ] 在範圍內打卡 → 打卡成功，顯示地點名稱
  - [ ] 在範圍外打卡 → 顯示「不在打卡範圍內」

**⚠️ 前置需求**：需要用戶提供本米的實際地址或 GPS 座標

---

## 任務 8：favicon 404 修復

- **修改檔案**：18 個 HTML 檔案（booking_service_admin.html 已有，不需修改）
- **具體做什麼**：
  在以下檔案的 `<head>` 區塊加入 `<link rel="icon" href="data:,">`：
  - admin.html, booking.html, booking_service.html, checkin.html
  - fieldwork.html, index.html, kds.html, line-test.html
  - loyalty.html, loyalty_admin.html, order.html, platform.html
  - records.html, register.html, requests.html, salary.html
  - schedule.html, services.html
- **驗收條件**：
  - [ ] 所有 19 個 HTML 檔案的 `<head>` 都有 `<link rel="icon" href="data:,">`
  - [ ] 瀏覽器 DevTools Network 不再出現 favicon.ico 404 請求
  - [ ] 頁面功能不受影響

---

## 任務 9：GitHub Actions CI 自動測試

- **修改檔案**：新增 `.github/workflows/ci.yml`
- **具體做什麼**：
  1. 建立 GitHub Actions workflow 檔案
  2. 觸發條件：push 到 main/dev 分支、PR 到 main
  3. 步驟：checkout → setup-node@v4 (Node 20) → npm ci → npm test
  4. 確認 `tests/smoke-test.js` 在 headless 環境可執行（puppeteer 需 `--no-sandbox`）
  5. 若 smoke-test 需要瀏覽器，確保 CI 環境有 chromium
- **驗收條件**：
  - [ ] `.github/workflows/ci.yml` 檔案存在
  - [ ] push 到 dev 分支後 GitHub Actions 自動觸發
  - [ ] `npm test` 在 CI 環境成功執行
  - [ ] 測試失敗時 CI 顯示紅色 ✗
  - [ ] 測試通過時 CI 顯示綠色 ✓

---

## 建議執行順序

1. **第一批（快速完成）**：任務 8（favicon）→ 任務 9（CI）→ 任務 7（本米 GPS，等座標）
2. **第二批（核心功能）**：任務 5（早退修正）→ 任務 6（打卡畫面）
3. **第三批（集點完善）**：任務 1（核銷）→ 任務 2（手動送點）→ 任務 3a（訂位集點）→ 任務 3b（預約集點驗證）→ 任務 4（order 兌換）
