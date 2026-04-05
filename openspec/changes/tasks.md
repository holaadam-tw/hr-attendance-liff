# 任務清單：薪資系統強化 — 時薪制與月薪制

## Task 1：SQL Migration — employees 加薪資快取欄位 ✅

**修改檔案**：`migrations/040_employees_salary_fields.sql`（新增）

**做什麼**：
1. employees 表加 `salary_type TEXT DEFAULT 'hourly'` 和 `hourly_rate NUMERIC(10,2) DEFAULT 196`
2. 從現有 salary_settings 同步資料到 employees
3. 為未設定薪資的在職員工自動建立 salary_settings（時薪 NT$196）

**驗收條件**：
- [x] SQL 在 Supabase 執行無錯誤
- [x] `SELECT id, name, salary_type, hourly_rate FROM employees WHERE is_active = true` 所有員工都有值
- [x] `SELECT * FROM salary_settings WHERE is_current = true` 所有在職員工都有一筆記錄
- [x] 本米 6 名員工 salary_type='hourly', base_salary=196

---

## Task 2：批次薪資設定 UI ✅

**修改檔案**：`admin.html`（薪資設定面板）、`modules/payroll.js`（loadSalarySettingList）

**做什麼**：
1. 將 `salarySettingPanel` 從唯讀列表改為**可編輯表格**
2. 每列有：姓名、部門、制度下拉（時薪/月薪/日薪）、金額輸入框、時薪換算顯示
3. 制度切換時自動填入預設值（時薪→196）
4. 新增「全部儲存」按鈕，批次寫入 salary_settings
5. 儲存時同步更新 employees.salary_type / hourly_rate

**驗收條件**：
- [x] 開啟薪資發放頁，展開設定面板，6 名員工以表格顯示
- [x] 切換制度下拉到「時薪」自動填入 196
- [x] 切換制度下拉到「月薪」清空金額等待輸入
- [x] 修改 2 名員工的設定後按「全部儲存」，重新載入仍顯示修改後的值
- [x] salary_settings 表中 is_current=true 的記錄正確更新
- [x] employees 表的 salary_type / hourly_rate 同步更新

---

## Task 3：薪資報表欄位增強 ✅

**修改檔案**：`modules/payroll.js`（renderAllPayrollTable）

**做什麼**：
1. 全員總覽表格新增欄位：制度、工時、底薪/時薪
2. 時薪制顯示：「時薪 NT$196 × 176h」
3. 月薪制顯示：「月薪 NT$35,000」
4. 表格底部加合計列（薪資總額、扣款總額、實發總額）
5. 未設定薪資的員工標示「⚠️ 未設定」

**驗收條件**：
- [x] 選擇年月按「計算薪資」，全員總覽表格顯示所有新欄位
- [x] 時薪制員工顯示工時和時薪計算
- [x] 月薪制員工顯示固定月薪
- [x] 底部合計列金額正確
- [x] 未設定薪資的員工不參與計算，顯示警告

---

## Task 4：Excel 匯出功能 ✅

**修改檔案**：`admin.html`（加 SheetJS CDN + 匯出按鈕）、`modules/payroll.js`（exportPayrollExcel）

**做什麼**：
1. admin.html `<head>` 加入 SheetJS CDN
2. 薪資發放 actions 區新增「📥 匯出 Excel」按鈕
3. 新增 `exportPayrollExcel()` 函數：
   - Sheet 1「薪資總表」：姓名、工號、部門、制度、工時、底薪、加班費、全勤獎金、餐費、職務津貼、勞保、健保、遲到扣款、事假扣款、手動調整、應發、扣款、實發
   - Sheet 2「計算明細」：每位員工的 calculation_details
   - 自動欄寬、標題列粗體、金額欄右對齊、合計列
4. 檔名格式：`薪資報表_YYYY年M月.xlsx`

**驗收條件**：
- [x] 計算薪資後出現「📥 匯出 Excel」按鈕
- [x] 點擊後下載 .xlsx 檔案，可用 Excel / Google Sheets 開啟
- [x] Sheet 1 全員資料完整，欄位齊全，合計列正確
- [x] Sheet 2 明細資料完整
- [x] 欄寬自動調整，標題粗體，金額右對齊
- [x] 保留原有 CSV 匯出功能不受影響

---

## Task 5：員工端 salary.html 制度顯示優化 ✅

**修改檔案**：`salary.html`

**做什麼**：
1. 薪資明細頁頂部卡片依 salary_type 顯示不同文案：
   - 時薪制：「⏰ 時薪 NT$196 · 本月工時 176h」
   - 月薪制：「💼 月薪 NT$35,000」
   - 日薪制：「📅 日薪 NT$X · 本月出勤 22 天」
2. 明細區塊「基本薪資」描述依制度顯示計算方式

**驗收條件**：
- [x] 時薪制員工開啟 salary.html，頂部顯示時薪和工時
- [x] 月薪制員工開啟 salary.html，頂部顯示固定月薪
- [x] 明細區塊描述文字正確反映計算方式

---

## Task 6：QA 驗證 + 回歸測試 ✅

**修改檔案**：無（純測試）

**做什麼**：
1. `bash scripts/qa_check.sh` 全部通過
2. `npm test` 冒煙測試全部通過
3. 回歸測試：
   - admin.html 薪資發放頁正常開啟
   - 計算薪資功能正常（時薪制 + 月薪制混合）
   - salary.html 員工端正常顯示
   - 匯出 Excel 和 CSV 都正常
4. 多租戶隔離：確認薪資設定不會跨公司

**驗收條件**：
- [x] qa_check.sh: 0 FAIL
- [x] npm test: 全部通過
- [x] admin.html 可正常開啟並計算薪資
- [x] salary.html 可正常開啟並顯示明細
- [x] Excel 匯出的資料與畫面一致
- [x] 不同公司的薪資資料互不可見

---

## 執行順序

```
Task 1 (SQL) → Task 2 (批次設定 UI) → Task 3 (報表增強)
                                           ↓
                              Task 4 (Excel 匯出) → Task 5 (員工端) → Task 6 (QA)
```

## 預估影響範圍

| 修改檔案 | 必須測試的頁面 |
|---------|--------------|
| migrations/040* | Supabase Table Editor 確認 |
| admin.html | admin.html 薪資發放頁 |
| modules/payroll.js | admin.html、salary.html |
| salary.html | salary.html |
