# PoC-2: `updateAdjustment` 接受負數 / 超大數字（證明 P2 bug）

## Bug source
`modules/payroll.js:224-230`

```js
export function updateAdjustment(empId, value) {
    const val = parseMoney(value);       // ← 無 val < 0 / val > threshold 檢查
    bonusAdjustments[empId] = val;        // ← 直接存
    populateBonusEmpDropdown();
    renderSelectedBonusCard();
    updateBonusSummary();
}
```

## Code path 分析

### Step 1: 管理員在前端輸入
- 獎金手動調整欄位 `<input onchange="updateAdjustment('${empId}', this.value)">`
- 輸入 `-999999` 或 `99999999999`

### Step 2: `updateAdjustment` 處理
- `parseMoney('-999999')` → `-999999`（`parseMoney` 定義在 `common.js`，僅去 `,` `$` 空白 + 轉數字，不驗範圍）
- `bonusAdjustments[empId] = -999999` → 直接存記憶體

### Step 3: `calculateBonus()` 消費
- `modules/payroll.js:calculateBonus` 把 `bonusAdjustments[empId]` 加進獎金公式
- 輸出 `finalAmount` 可能為**負數**或**天價**

### Step 4: `updateBonusSummary` 顯示
- `total += c.finalAmount`
- UI 顯示 `$-999,999` 或 `$99,999,999,999` — 系統不擋

### Step 5: 按「確認發放」
- 寫入 `payroll` / `annual_bonus` 表
- **DB 不擋**（欄位是 `NUMERIC`，接受負數）

## 實測方法（純前端，0 DB 風險）

1. 開 `admin.html` 進獎金頁面
2. DevTools Console 執行：
   ```js
   const { updateAdjustment } = await import('./modules/payroll.js');
   updateAdjustment('some-employee-id', '-999999');
   ```
   或直接在 UI 輸入 `-999999` 後切焦點
3. 觀察獎金總額欄位 → 應該顯示負數
4. **不要按「確認發放」**（會寫入 DB）

## 預期結果
- ✅ `bonusAdjustments[empId] = -999999`（記憶體狀態）
- ✅ UI 顯示負獎金（red text 可能觸發 negative class）
- ✅ **無任何錯誤訊息 / 驗證 blocker**
- → P2 bug 確認存在

## 影響分級
- **如果管理員手殘**：誤輸入負號 → 發負薪（DB 被寫入）
- **如果管理員惡意**：輸入天價 → 掏空公司（但一般有 UI 最終確認 dialog，需雙重確認）

## 修復方向（僅記錄，不動手）
```js
export function updateAdjustment(empId, value) {
    const val = parseMoney(value);
    const MAX = 500000;   // 單人單次調整上限
    if (isNaN(val) || val < -MAX || val > MAX) {
        showToast(`⚠️ 調整金額必須在 -${MAX.toLocaleString()} ~ ${MAX.toLocaleString()} 之間`);
        return;
    }
    bonusAdjustments[empId] = val;
    populateBonusEmpDropdown();
    renderSelectedBonusCard();
    updateBonusSummary();
}
```

## 關聯項
- 相同 pattern 可能存在於：
  - `payrollAdjustments`（同檔 L26）
  - `modules/payroll.js` 其他 parseMoney 點
  - grep `parseMoney(` 全 repo 統一處理

**PoC 類型**: code path 文件（無執行）
**L1 安全**: 0 DB 動作
