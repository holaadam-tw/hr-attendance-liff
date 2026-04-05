# 技術設計：薪資系統強化 — 時薪制與月薪制

## 現狀分析

### 已有的（不需重寫）

| 元件 | 位置 | 說明 |
|------|------|------|
| salary_settings 表 | 001_initial_schema.sql | salary_type, base_salary, is_current |
| calcEmployeePayroll() | payroll.js:506 | 已支援 monthly/daily/hourly 三種計算 |
| 薪資設定 Modal | admin.html:359 + employees.js:228 | salary_type 下拉 + base_salary 輸入 |
| 薪資計算參數 | payroll.js:313 | late_deduction, overtime_rate 可設定 |
| CSV 匯出 | payroll.js exportPayrollCSV | 基本匯出功能 |

### 缺口

1. **employees 表無 salary_type / hourly_rate** — 每次顯示都要 JOIN salary_settings
2. **薪資設定列表（loadSalarySettingList）** — 單筆設定，無批次功能
3. **全員薪資報表（renderAllPayrollTable）** — 缺「制度」「工時」欄位
4. **Excel 匯出** — 目前只有 CSV，無格式化
5. **預設時薪** — 時薪制選擇後無預設值

---

## 設計方案

### 1. SQL Migration（040_employees_salary_fields.sql）

```sql
-- employees 表加快取欄位（非正規化，加速查詢）
ALTER TABLE employees ADD COLUMN IF NOT EXISTS salary_type TEXT DEFAULT 'hourly';
ALTER TABLE employees ADD COLUMN IF NOT EXISTS hourly_rate NUMERIC(10,2) DEFAULT 196;

-- 從 salary_settings 同步現有資料
UPDATE employees e SET
    salary_type = ss.salary_type,
    hourly_rate = CASE
        WHEN ss.salary_type = 'hourly' THEN ss.base_salary
        WHEN ss.salary_type = 'daily' THEN ROUND(ss.base_salary / 8, 2)
        WHEN ss.salary_type = 'monthly' THEN ROUND(ss.base_salary / 30 / 8, 2)
    END
FROM salary_settings ss
WHERE ss.employee_id = e.id AND ss.is_current = true;

-- 為本米未設定的員工建立 salary_settings（時薪 196）
INSERT INTO salary_settings (employee_id, salary_type, base_salary, is_current)
SELECT e.id, 'hourly', 196, true
FROM employees e
LEFT JOIN salary_settings ss ON ss.employee_id = e.id AND ss.is_current = true
WHERE ss.id IS NULL AND e.is_active = true
ON CONFLICT DO NOTHING;
```

**注意**：employees.salary_type / hourly_rate 是**快取欄位**，正式來源仍是 salary_settings。每次 saveSalarySetting 時同步更新。

### 2. 薪資計算邏輯（無需修改）

`calcEmployeePayroll()` 已正確處理：

```
時薪制：monthSalary = hourlyRate × totalWorkHours
月薪制：monthSalary = baseSalary（固定）
日薪制：monthSalary = dailyRate × actualDays
```

扣款邏輯（三種制度共用）：
- 遲到扣款 = lateCount × late_deduction_per_time
- 事假扣款 = dailyRate × personalLeaveDays
- 勞保/健保/自提 = 查 insurance_brackets
- 實發 = gross - totalDeduct

### 3. 批次薪資設定 UI（admin.html payrollPage）

改造 `salarySettingPanel` 為**可編輯表格**：

```
┌─────────────────────────────────────────────────┐
│ 📋 員工薪資設定                          [全部儲存] │
├──────┬──────┬──────────┬──────────┬─────────────┤
│ 姓名 │ 部門 │ 制度 ▼   │ 底薪/時薪 │ 時薪換算    │
├──────┼──────┼──────────┼──────────┼─────────────┤
│ 小明 │ 外場 │ [時薪 ▼] │ [  196 ] │ NT$196/h    │
│ 小華 │ 廚房 │ [時薪 ▼] │ [  196 ] │ NT$196/h    │
│ 大正 │ 管理 │ [月薪 ▼] │ [35000] │ NT$146/h    │
└──────┴──────┴──────────┴──────────┴─────────────┘
```

- 制度下拉切換時，自動填入預設值（時薪→196、月薪→空白需填入）
- 「全部儲存」批次寫入 salary_settings + 同步 employees 快取欄位
- 修改後即時反映到薪資計算

### 4. 薪資報表增強（renderAllPayrollTable）

全員總覽表格新增欄位：

```
┌──────┬──────┬──────┬───────┬────────┬───────┬───────┬────────┐
│ 姓名 │ 制度 │ 工時 │ 底薪   │ 加班費 │ 津貼  │ 扣款  │ 實發    │
├──────┼──────┼──────┼───────┼────────┼───────┼───────┼────────┤
│ 小明 │ 時薪 │ 176h │ 34,496│   0    │   0   │ 2,100 │ 32,396 │
│ 大正 │ 月薪 │ 180h │ 35,000│ 1,200  │ 500   │ 3,200 │ 33,500 │
└──────┴──────┴──────┴───────┴────────┴───────┴───────┴────────┘
                                              合計：│ 65,896 │
```

### 5. Excel 匯出（SheetJS）

- 新增 `<script src="https://cdn.sheetjs.com/xlsx-0.20.3/package/dist/xlsx.full.min.js"></script>`
- `exportPayrollExcel()` 函數：
  - Sheet 1「薪資總表」：全員一覽（姓名、制度、工時、各項目、實發）
  - Sheet 2「薪資明細」：每位員工的完整計算明細
  - 自動欄寬、標題粗體、金額右對齊、合計列
  - 檔名：`薪資報表_2026年4月.xlsx`

### 6. 員工端 salary.html 調整

- 頂部卡片依 salary_type 顯示不同文案：
  - 時薪制：「⏰ 時薪 NT$196 · 本月工時 176h」
  - 月薪制：「💼 月薪 NT$35,000」
- 明細區塊依制度顯示對應欄位

---

## 資料流

```
admin.html 批次設定
    │
    ├→ salary_settings（INSERT is_current=true）
    └→ employees.salary_type / hourly_rate（同步）

admin.html 計算薪資
    │
    ├→ salary_settings（讀取 is_current）
    ├→ attendance（該月出勤）
    ├→ leave_requests（該月請假）
    └→ calcEmployeePayroll() → payrollEmployees[]
         │
         ├→ renderAllPayrollTable()（全員報表）
         ├→ renderPayrollCard()（個人明細）
         ├→ exportPayrollExcel()（Excel 匯出）
         └→ publishPayroll()（發布到 payroll 表）
```

---

## 風險與注意事項

1. **employees 快取欄位同步** — 每次 saveSalarySetting 都要同步，否則產生不一致
2. **SheetJS CDN** — 加一個外部依賴（~500KB），只在 admin.html 載入
3. **本米現有 6 名員工** — migration 自動補建 salary_settings，不會影響已有設定
4. **向後相容** — 未設定薪資的員工在報表中標示「⚠️ 未設定」，不參與計算
