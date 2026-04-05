# 變更提案：薪資系統強化 — 時薪制與月薪制完整支援

## 背景

現有系統 `salary_settings` 表已有 `salary_type`（monthly/daily/hourly）和 `base_salary` 欄位，`calcEmployeePayroll()` 也能依類型計算。但存在以下缺口：

1. **本米 6 名員工尚未設定薪資** — 需要批次設定為時薪制 NT$196
2. **薪資報表不夠清晰** — 全員總覽表格缺少「制度、工時、時薪/月薪」欄位
3. **無 Excel 匯出** — 目前只有 CSV，需要真正的 .xlsx 格式
4. **employees 表無快速查詢欄位** — 每次都要 JOIN salary_settings
5. **預設時薪未落地** — 新增時薪制員工時無預設值 NT$196

## 範圍

- **修改檔案**：admin.html、modules/payroll.js、modules/employees.js、common.js
- **新增 SQL**：040_employees_salary_fields.sql
- **新增依賴**：SheetJS (xlsx) CDN
- **不動**：salary.html（員工端）、打卡流程、請假流程

## 目標

- 本米 6 名員工可在一個畫面內批次設定薪資制度與金額
- 管理員一鍵計算全員月薪，時薪制與月薪制各自正確
- 薪資報表一目瞭然：姓名、制度、工時、底薪、加班費、扣款、實發
- 可匯出 Excel（.xlsx），格式專業可直接交給會計

## 版本

v2.7 — 薪資系統強化
