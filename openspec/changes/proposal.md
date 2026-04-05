# 變更提案：薪資自動計算 + 下班打卡記錄地點

## 摘要
兩個功能需求：
1. **薪資自動計算**：從 attendance 表自動計算月薪並寫入 payroll 表
2. **下班打卡記錄地點**：下班打卡時記錄 GPS 座標和地點名稱

## 動機
1. 目前薪資計算是手動輸入，容易出錯且耗時。從打卡記錄自動產生可大幅減少行政負擔。
2. 下班打卡目前不記錄地點（只有上班有），管理者無法追蹤員工下班位置（尤其外勤人員）。

## 範圍

### 功能 1：薪資自動計算
- **修改檔案**：modules/payroll.js、admin.html、migrations/038_payroll_auto.sql
- **新增功能**：
  - admin.html 薪酬 tab 加「一鍵產生本月薪資」按鈕
  - 從 attendance 計算：出勤天數、總工時、遲到次數、早退次數
  - 計算公式：base_salary + 加班費 - 遲到扣款 - 缺勤扣款 = net_salary
  - 預覽確認後才寫入 payroll 表

### 功能 2：下班打卡記錄地點
- **修改檔案**：migrations/039_checkout_location.sql、checkin.html（已傳 GPS）、前端考勤顯示
- **修改 RPC**：quick_check_in 下班流程加入 GPS 座標和地點名稱寫入
- **不驗證範圍**：下班允許在任何位置，但記錄實際位置
- **前端顯示**：index.html 和 admin.html 考勤查詢顯示下班地點

## 風險
- 薪資計算公式需要和用戶確認（遲到扣款金額、缺勤定義等）
- attendance 表已有 check_out_location 欄位（TEXT），缺少 checkout_latitude/longitude（需 ALTER TABLE）
- payroll 表可能需要新增欄位存放自動計算的明細

## 日期
2026-04-05
