# 設計文件：薪資自動計算 + 下班打卡記錄地點

## 功能 1：薪資自動計算

### 計算流程
```
admin.html「一鍵產生本月薪資」按鈕
  → 呼叫 generateMonthlyPayroll(year, month)
  → Step 1：查詢所有在職員工的 salary_settings
  → Step 2：對每位員工查詢當月 attendance 統計
    - 出勤天數：有 check_in_time 的天數
    - 總工時：sum(total_work_hours)
    - 遲到次數：count(is_late = true)
    - 早退次數：count(is_early_leave = true)
    - 加班工時：sum(overtime_hours) 或從 overtime_requests(approved) 取
  → Step 3：計算薪資
    - gross = base_salary + meal_allowance + position_allowance
    - overtime_pay = 加班時數 × (base_salary / 30 / 8) × 倍率
    - full_attendance_bonus = 全勤（遲到=0 且 缺勤=0）? salary_settings.full_attendance_bonus : 0
    - late_deduction = 遲到次數 × 遲到每次扣款（system_settings: late_deduction_per_time，預設 0）
    - absence_deduction = 缺勤天數 × 日薪（base_salary / 30）
    - 勞健保 = 從 getInsuranceBracket(base_salary) 取得
    - net_salary = gross + overtime_pay + full_attendance_bonus - late_deduction - absence_deduction - 勞保自付 - 健保自付
  → Step 4：顯示預覽表格（員工 × 各項目 × net_salary）
  → Step 5：使用者確認後 upsert payroll 表

### 預覽 UI
- admin.html 薪酬 tab 上方新增「自動產薪」按鈕
- 點擊後顯示年月選擇 + 「開始計算」
- 計算完顯示表格：員工、底薪、加班、全勤、遲到扣、缺勤扣、勞保、健保、實發
- 表格下方「確認發布」按鈕

### SQL
- 不需要新表，payroll 表已有所有需要的欄位
- 新增 system_settings key：
  - `late_deduction_per_time`：遲到每次扣款金額（預設 0）
  - `overtime_rate`：加班費倍率（預設 1.34）
  - `work_days_per_month`：每月工作天數（預設 22）

### 缺勤定義
- 「應出勤日」= 該月工作天數（排除週末 + 排休）
- 「實際出勤日」= attendance 有記錄的天數
- 「缺勤天數」= 應出勤 - 實際出勤（最低 0）
- 計算時參考 schedules 表或預設每月 22 天

---

## 功能 2：下班打卡記錄地點

### 資料庫變更
```sql
-- attendance 表已有 check_out_location (TEXT)
-- 需新增下班座標欄位
ALTER TABLE attendance ADD COLUMN IF NOT EXISTS checkout_latitude DOUBLE PRECISION;
ALTER TABLE attendance ADD COLUMN IF NOT EXISTS checkout_longitude DOUBLE PRECISION;
```

### RPC 變更（quick_check_in）
下班打卡流程的 UPDATE 加入：
```sql
UPDATE attendance SET
    check_out_time = v_now,
    check_out_location = v_checkout_location,  -- 新增
    checkout_latitude = p_latitude,             -- 新增
    checkout_longitude = p_longitude,           -- 新增
    total_work_hours = ...,
    is_early_leave = ...,
    updated_at = now()
WHERE id = v_existing.id;
```

下班地點名稱判定邏輯：
- 用和上班相同的 office_locations 比對
- 在範圍內 → 記錄地點名稱
- 不在範圍內 → 記錄「外部地點」（不拒絕，只記錄）

### 前端顯示
- index.html `loadTodayStatus`：下班卡片加顯示地點
- admin.html 考勤明細：加 check_out_location 欄位
- records.html 月曆詳情：顯示下班地點

### checkin.html
- 不需改動 — checkin.html 已傳 GPS 座標給 RPC（p_latitude, p_longitude）
- RPC 下班流程原本沒用這些座標，修正後會用

---

## 執行順序
1. 下班打卡記錄地點（影響範圍小，先做）
2. 薪資自動計算（複雜度高，後做）
