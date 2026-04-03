# 技術設計：RunPiston v2.5

---

## A. 集點系統完善

### A1. 核銷流程（項目 1）

**現狀**：`loyalty_admin.html` 已有完整核銷 UI 和邏輯：
- `verifyRedeemCode()`（line ~446）查詢 `loyalty_redemptions` by (company_id, code)
- `confirmRedeem()`（line ~490）更新 status='used', redeemed_at, redeemed_by

**需確認**：此功能可能已完成。需在實際環境測試：
1. 從 loyalty.html 兌換取得 6 碼
2. 在 loyalty_admin.html 輸入碼核銷
3. 確認 DB 狀態正確更新

**若有缺陷需修正**：
- 核銷成功後的 UI 回饋（toast / 動畫）
- 過期碼的錯誤提示
- 核銷後自動刷新會員列表

---

### A2. 手動送點（項目 2）

**現狀**：`loyalty_admin.html` 送點 tab（line ~49-66）已有手機號輸入 + 送點功能。

**需改進的流程**：
```
搜尋會員（手機/姓名）→ 選擇會員 → 輸入消費金額 → 
自動計算點數（依 loyalty_settings.points_per_amount）→ 確認送出
```

**設計**：
- 搜尋欄改為支援手機號和姓名模糊搜尋
- 搜尋結果顯示下拉選單（會員姓名 + 手機 + 目前點數）
- 輸入金額欄位，即時顯示「= N 點」計算結果
- 計算公式：`points = Math.floor(amount / loyalty_settings.points_per_amount)`
- 送出後更新 `loyalty_members.total_points` + 寫入 `loyalty_transactions`（source='manual'）

---

### A3. 預約完成集點（項目 3）

**餐飲訂位（admin.html）**：
- 現狀：`updateBookingStatus()` in store.js（line ~2620）已有 'completed' 狀態，且有 `awardBookingLoyalty()` 函式（line ~2642）
- 需新增：在訂位管理介面加入「確認到店」按鈕，點擊後將 status 改為 'completed' 並觸發集點
- 集點邏輯使用現有的 `awardBookingLoyalty()`，預設 10 點（可透過 `booking_loyalty_points` 設定調整）

**服務業預約（booking_service_admin.html）**：
- 現狀：已有「✔ 完成服務」按鈕（line ~361），`updateBsStatus('completed')` 已觸發集點（line ~399-406）
- 需確認：集點邏輯是否正確寫入 `loyalty_transactions` + 更新 `loyalty_members.total_points`

---

### A4. order.html 兌換商品顯示（項目 4）

**現狀**：已有完整功能：
- `checkMemberPoints()`（line ~4383）查詢會員點數
- `loadLoyaltyRewards()`（line ~4418）載入商品
- `buildRewardsListHtml()`（line ~4449）渲染商品列表
- `redeemReward()`（line ~4475）處理兌換

**需確認**：查完點數後是否自動顯示商品列表，還是需要額外點擊。若需改進：
- 查點數後自動呼叫 `loadLoyaltyRewards()` 並渲染列表
- 商品卡片顯示：名稱、所需點數、兌換按鈕（點數不足時 disabled + 顯示差額）

---

## B. 考勤系統修正

### B5. 早退判定修正（項目 5）

**現狀問題**：
- `quick_check_in()` RPC 中早退判定邏輯（migration 032，line ~89-97）：
  ```sql
  IF v_now_time < (v_shift_end - threshold) THEN
      v_is_early_leave := true;
  END IF;
  ```
- 凌晨 00:30 打下班卡，若下班時間是 17:00，`00:30 < 17:00` → 判定為早退（錯誤）
- 跨日班別（22:00-06:00）完全未處理

**修正方案**：

```sql
-- 新增邏輯：判斷是否為合理的下班打卡
-- 1. 取得班別的 is_overnight 標記
-- 2. 一般班別：只有在 (shift_start, shift_end) 區間內打卡才檢查早退
-- 3. 跨日班別：shift_end 視為隔日時間
-- 4. 凌晨打卡（00:00-06:00）且非跨日班別 → 不判定早退

IF v_is_overnight THEN
    -- 跨日班：下班時間視為隔日，例如 22:00-06:00
    -- 打卡時間在 shift_end 之前（隔日凌晨）才算早退
    IF v_tw_time::time < v_shift_end 
       AND v_tw_time::time < (v_shift_end - threshold) THEN
        v_is_early_leave := true;
    END IF;
ELSE
    -- 一般班：只有在下班前 2 小時到下班時間之間才判定早退
    -- 避免凌晨打卡被誤判
    IF v_tw_time::time >= (v_shift_end - interval '2 hours')
       AND v_tw_time::time < (v_shift_end - threshold) THEN
        v_is_early_leave := true;
    END IF;
END IF;
```

**新增 migration**：`033_fix_early_leave_overnight.sql`

---

### B6. 打卡結果畫面不卡住（項目 6）

**現狀**：
- 已有 `showCheckInSuccess()` 顯示結果畫面（line ~425-447）
- 已有 10 秒安全計時器防止「處理中」卡住（line ~112-118）
- 不使用 `window.location` 跳轉（LIFF 環境會卡 loading）

**需確認的問題場景**：
- 相機 stream 未正確關閉導致頁面卡住
- 結果畫面的「關閉視窗」按鈕在非 LIFF 環境無效
- GPS 取得中的 loading 狀態未清除

**修正方向**：
- 確保 `navigator.mediaDevices` stream 在成功/失敗後都 `stop()`
- 「關閉視窗」在非 LIFF 環境改為「返回首頁」
- 加入整體 30 秒超時保護（含 GPS + 拍照 + 上傳）

---

### B7. 本米打卡地點設定（項目 7）

**方案**：在 Supabase `office_locations` 表插入本米公司的 GPS 座標。

```sql
INSERT INTO office_locations (company_id, name, latitude, longitude, radius, is_active)
VALUES (
    'fb1f6b5f-...完整UUID...',
    '本米總部',
    25.XXXXXX,    -- 需向用戶確認實際座標
    121.XXXXXX,   -- 需向用戶確認實際座標
    300,          -- 半徑 300 公尺（可調整）
    true
);
```

**注意**：需要用戶提供本米的實際 GPS 座標（可從 Google Maps 取得）。

---

## C. DevOps 與品質改善

### C8. favicon 404 修復（項目 8）

**方案**：在所有 HTML 檔案的 `<head>` 中加入空 favicon：
```html
<link rel="icon" href="data:,">
```

**影響範圍**：18 個 HTML 檔案（booking_service_admin.html 已有）

---

### C9. GitHub Actions CI（項目 9）

**方案**：建立 `.github/workflows/ci.yml`

```yaml
name: CI
on:
  push:
    branches: [main, dev]
  pull_request:
    branches: [main]
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '20'
      - run: npm ci
      - run: npm test
```

**前提**：`npm test` 指向 `node tests/smoke-test.js`（已設定於 package.json）。
需確認 smoke-test.js 在無瀏覽器環境（CI headless）能正常執行。
