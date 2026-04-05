# 任務清單：薪資自動計算 + 下班打卡記錄地點

---

## 功能 2（先做）：下班打卡記錄地點

### T1: attendance 表加下班座標欄位
- **檔案**：migrations/039_checkout_location.sql
- **做什麼**：ALTER TABLE attendance ADD COLUMN IF NOT EXISTS checkout_latitude / checkout_longitude
- **驗收**：SQL 執行無錯誤，Supabase Table Editor 可看到新欄位
- [x] 完成 ✅

### T2: quick_check_in RPC 下班流程記錄 GPS
- **檔案**：migrations/039_checkout_location.sql（CREATE OR REPLACE FUNCTION）
- **做什麼**：
  - 下班 UPDATE 加入 check_out_location、checkout_latitude、checkout_longitude
  - 地點名稱用 office_locations 比對（在範圍內→地點名、不在→「外部地點」）
  - 不拒絕打卡，只記錄位置
- **驗收**：
  - 在範圍內下班 → check_out_location = 地點名
  - 不在範圍內下班 → check_out_location = '外部地點'，checkout_latitude/longitude 有值
  - 上班打卡行為不變
- [x] 完成 ✅

### T3: 前端考勤顯示下班地點
- **檔案**：index.html（loadTodayStatus）、common.js（checkTodayAttendance SELECT 欄位）
- **做什麼**：
  - checkTodayAttendance SELECT 加入 check_out_location
  - loadTodayStatus 下班卡片顯示地點
- **驗收**：首頁下班卡顯示「📍 大里office」或「📍 外部地點」
- [x] 完成 ✅

### T4: Supabase 測試下班地點記錄
- **做什麼**：用 RPC 測試下班打卡是否正確記錄 GPS
- **驗收**：
  - 測試在範圍內下班 → check_out_location 有值，checkout_latitude 有值
  - 測試在範圍外下班 → 成功打卡，check_out_location = '外部地點'
- [x] 完成 ✅

---

## 功能 1（後做）：薪資自動計算

### T5: 新增薪資計算相關 system_settings
- **檔案**：modules/payroll.js 或 admin.html
- **做什麼**：admin.html 薪酬設定區加入：
  - 遲到每次扣款金額（late_deduction_per_time，預設 0）
  - 加班費倍率（overtime_rate，預設 1.34）
  - 每月工作天數（work_days_per_month，預設 22）
  - 儲存到 system_settings
- **驗收**：admin.html 薪酬設定可輸入並儲存���個值
- [x] 完成 ✅

### T6: 實作 generateMonthlyPayroll 函數
- **檔案**：modules/payroll.js
- **做什麼**：
  - 查所有在職員工 salary_settings
  - 查每位員工當月 attendance 統計（出勤天數、遲到、早退、工時）
  - 查當月已核准的 overtime_requests
  - 依公式計算各項目 → 產生 payroll 陣列
  - 回傳預覽資料（不寫入 DB）
- **驗收**：
  - 呼叫函數取得員工薪資預覽陣列
  - base_salary 正確、遲到扣款 = 次數 × 單價、缺勤扣款 = 天數 × 日薪
  - 勞健保正確（getInsuranceBracket）
  - net_salary = gross - 扣款
- [x] 完成 ✅（既有 calcEmployeePayroll 已實作，改為讀取 system_settings 參數）

### T7: admin.html 自動產薪 UI
- **檔案**：admin.html、modules/payroll.js
- **做什麼**：
  - 薪酬 tab 加「🤖 自動產薪」按鈕
  - 點擊後選擇年月 → 呼叫 generateMonthlyPayroll → 顯示預覽表格
  - 預覽表格：員工名、底薪、加班費、全勤、遲到扣、缺勤扣、勞保、健保、實發
  - 「確認發布」按鈕 → upsert payroll 表 + is_published = true
  - 已有當月 payroll → 顯示警告「將覆蓋現有資料」
- **驗收**：
  - 點擊自動產薪顯示預覽表格
  - 確認後 payroll 表寫入正確
  - 員工 salary.html 可看到發布的薪資
- [x] 完成 ✅（既有 UI 已有預覽+發布，新增設定面板 + 參數化計算）

### T8: 測試 + QA + commit
- **做什麼**：
  - bash scripts/qa_check.sh → 0 FAIL
  - npm test → 全部通過
  - git checkout dev → commit → push → 合併 main
- **驗收**：QA 0 FAIL、npm test 通過、已部署
- [x] 完成 ✅

---

## 驗證
- 每項完成後跑 `bash scripts/qa_check.sh`
- 全部完成跑 `npm test`
- Git: checkout dev → commit → push → 合併 main
