# PoC-3: `Promise.all` silent error（證明 P3 bug）

## Bug source
`modules/payroll.js:76-82`（`loadHybridBonusData`）

```js
const [empRes, salaryRes, attRes, leaveRes] = await Promise.all([
    sb.from('employees').select(...).eq('company_id', ...),
    sb.from('salary_settings').select(...),
    sb.from('attendance').select(...),
    sb.from('leave_requests').select(...)
]);
if (empRes.error) throw empRes.error;    // ← 只檢 empRes
// salaryRes / attRes / leaveRes 的 .error 完全忽略
```

## Bug 本質

Supabase SDK 的 `sb.from(...)` 回傳 `{ data, error }` 物件，**不 reject Promise**（即使 query 失敗）。

因此 `Promise.all` 會拿到 4 個 `{data, error}` 物件，**不會短路 throw**。

目前 code 只檢查 `empRes.error`：
- 若 `salaryRes.error` 存在 → 被忽略，後續 `(salaryRes.data || []).forEach(...)` 用空陣列 fallback
- 若 `leaveRes.error` 存在 → 同樣忽略，`leaveMap = {}`

## Code path

### Step 1: 觸發 Error
假設某公司的 `leave_requests` 因 RLS 權限或 schema 差異導致 query 失敗：
```
// leaveRes = { data: null, error: { message: "permission denied" } }
```

### Step 2: Line 82 的檢查
```js
if (empRes.error) throw empRes.error;  // empRes 沒問題，不 throw
```

### Step 3: Line 88-89 消費 leaveRes
```js
const leaveMap = {};
(leaveRes.data || []).forEach(l => { ... });   // ← null → [] → 空循環
```

### Step 4: `calculateBonus` 消費 `leaveMap`
```js
const leaveDays = leaveMap[emp.id] || 0;   // ← 全員工都是 0（因為 map 是空的）
```

### Step 5: 獎金計算
- 所有員工的「請假天數扣分」都是 0
- 獎金**高估**
- UI 正常顯示（無錯誤訊息）

## 使用者視角
- 管理員點「計算獎金」
- 畫面正常 render 出來
- **看起來一切正常**，但請假扣分被無聲吞掉
- 按「確認發放」→ 員工拿到比實際該得多的獎金

## 實測方法（純前端，0 DB 風險）

DevTools Console override `sb.from('leave_requests')` 讓它回 error：

```js
const origFrom = sb.from.bind(sb);
sb.from = function(table) {
    const builder = origFrom(table);
    if (table === 'leave_requests') {
        const origThen = builder.then?.bind(builder);
        return { ...builder,
            then: (resolve) => resolve({ data: null, error: { message: 'simulated RLS denied' } })
        };
    }
    return builder;
};

// 然後點「計算獎金」
```

## 預期結果
- ✅ 獎金計算照常執行（無 throw）
- ✅ 所有員工 leaveDays = 0（漏扣請假）
- ✅ **console 無警告、UI 無錯誤**
- → P3 bug 確認存在

## 修復方向（僅記錄，不動手）

**方案 A**：`Promise.allSettled` + 逐項檢查
```js
const results = await Promise.allSettled([...]);
const [empRes, salaryRes, attRes, leaveRes] = results.map(r => 
    r.status === 'fulfilled' ? r.value : { data: null, error: r.reason }
);
if (empRes.error) throw empRes.error;
// 非核心查詢失敗 → 顯示警告但不擋主流程
if (leaveRes.error) showToast('⚠️ 請假資料載入失敗，獎金可能偏高');
```

**方案 B**：每個 res 都檢查
```js
[empRes, salaryRes, attRes, leaveRes].forEach(r => {
    if (r.error) throw r.error;
});
```

**建議 A**（允許非核心查詢失敗但警告，類似本 repo `attendance_public.html` L548 的 pattern — 我們剛在 Sprint 4 做過的）

## 關聯項
同 pattern 可能存在於：
- `modules/payroll.js:478-487`（`loadPayrollData`）— 只有 `.catch(() => ({data: []}))` 在 `otRes` / `bracketRes` / `schedRes`，**大部分 query 還是 silent ignore**
- 其他 `Promise.all` 用法需全 repo grep

**PoC 類型**: code path 文件（無執行，但含可複製 DevTools override 腳本）
**L1 安全**: 0 DB 動作
