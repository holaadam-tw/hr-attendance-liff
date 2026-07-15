# 技術設計：外勤里程表起訖登錄（fieldwork-odometer）

## 1. 資料模型

### 1.1 新表 `field_work_trips`（migration 093）

每位業務每天一筆「行程」，記錄出發與收工的里程表讀數。

```sql
CREATE TABLE IF NOT EXISTS field_work_trips (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    employee_id UUID NOT NULL REFERENCES employees(id),
    company_id UUID NOT NULL REFERENCES companies(id),
    trip_date DATE NOT NULL DEFAULT CURRENT_DATE,
    -- 出發登錄
    start_odometer NUMERIC NOT NULL CHECK (start_odometer >= 0),
    start_odometer_photo_url TEXT,
    start_time TIMESTAMPTZ DEFAULT now(),
    start_lat DOUBLE PRECISION,
    start_lng DOUBLE PRECISION,
    -- 收工登錄（選配）
    end_odometer NUMERIC CHECK (end_odometer IS NULL OR end_odometer >= start_odometer),
    end_odometer_photo_url TEXT,
    end_time TIMESTAMPTZ,
    end_lat DOUBLE PRECISION,
    end_lng DOUBLE PRECISION,
    total_km NUMERIC,                 -- 收工時前端計算 end - start 寫入
    status TEXT DEFAULT 'open' CHECK (status IN ('open','closed')),
    notes TEXT,
    created_at TIMESTAMPTZ DEFAULT now(),
    updated_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_fwt_emp_date ON field_work_trips(employee_id, trip_date);
-- 同一員工同一天只允許一筆 open 行程
CREATE UNIQUE INDEX IF NOT EXISTS idx_fwt_one_open_per_day
    ON field_work_trips(employee_id, trip_date) WHERE status = 'open';
```

存取模式：與 `field_work_logs` 一致（前端 anon 直寫；不在 RLS 禁寫清單）。RLS 收緊隨 Phase 2/3 另案。

### 1.2 `field_work_logs` 加欄位（migration 093）

```sql
ALTER TABLE field_work_logs
    ADD COLUMN IF NOT EXISTS trip_id UUID REFERENCES field_work_trips(id),
    ADD COLUMN IF NOT EXISTS odometer_reading NUMERIC,      -- 到站當下里程表讀數
    ADD COLUMN IF NOT EXISTS odometer_photo_url TEXT,       -- 到站里程表照片
    ADD COLUMN IF NOT EXISTS segment_km NUMERIC,            -- 區間公里（自動計算）
    ADD COLUMN IF NOT EXISTS gps_distance_km NUMERIC;       -- 前一 GPS 點→本站直線距離
```

既有 `mileage` 欄位保留不動（相容舊資料與無行程模式）。

## 2. 計算規則（前端 fieldwork.html）

### 2.1 區間公里 `segment_km`

到達打卡時：

```
前一讀數點 = 當日 trip 內最後一站的 odometer_reading（依 arrive_time 排序）
           ；若本站是第一站 → trip.start_odometer
segment_km = 本站 odometer_reading − 前一讀數點
```

驗證（前端擋）：
- `odometer_reading` 必須 ≥ 前一讀數點（否則提示「讀數不可小於上一筆 XXXX」）
- `segment_km > 200` → confirm 二次確認（防多打一位數）

### 2.2 GPS 直線距離 `gps_distance_km`（Haversine）

```
前一 GPS 點 = 前一站的 leave_lat/lng（有離開打卡）→ 否則前一站 arrive_lat/lng
            ；第一站 → trip.start_lat/lng
gps_distance_km = haversine(前一 GPS 點, 本站 arrive_lat/lng)，四捨五入到 0.1
```

Haversine 為既有專案未有的小工具函數，加在 fieldwork.html 內（僅此頁使用，不進 common.js）。

### 2.3 交叉比對警示（管理端顯示，不擋員工送出）

| 條件 | 警示 |
|------|------|
| `segment_km < gps_distance_km × 0.8` | ⚠️ 申報里程低於 GPS 直線距離（不合理，路程必 ≥ 直線） |
| `segment_km > gps_distance_km × 3 + 5` | ⚠️ 申報里程顯著高於直線距離（繞路或誤填，需人工確認） |
| 站有讀數但無里程表照片 | 📷 缺照片佐證 |

倍率 3 與 +5km 緩衝考量市區繞路與短程誤差，管理端純提示、由審核者判斷。

### 2.4 收工

收工登錄時：`total_km = end_odometer − start_odometer`，並可與 `Σ segment_km` 對照（差額即「最後一站→回程」公里，屬正常）。

## 3. UI 流程（fieldwork.html Tab1）

### 3.1 行程卡片（新增，置於「今日外勤」摘要卡上方）

- **無當日 open/closed 行程**：顯示「🚗 出發登錄」按鈕 → 展開表單：里程表讀數（必填、數字）＋ 📷 拍里程表（選填）→ 送出時抓 GPS、insert `field_work_trips`
- **有 open 行程**：顯示出發讀數、出發時間、已行駛（最後讀數點 − start）＋「🏁 收工登錄」按鈕 → 填結束讀數（≥ 最後讀數點）＋拍照 → update `status='closed'`、`total_km`
- **已 closed**：顯示當日總公里 total_km（唯讀）

### 3.2 到達打卡表單（改動）

- 有 open 行程時：客戶選單下方新增「當下里程表讀數 *」數字欄＋「📷 拍里程表」按鈕（獨立於工作照的單張上傳，寫 `odometer_photo_url`）
  - 到達打卡送出時一併寫入 `trip_id / odometer_reading / segment_km / gps_distance_km`
  - 讀數留空 → 擋（有行程時必填）
- 無行程時：欄位隱藏，維持舊流程（離開時自填 mileage），並在表單頂部顯示灰字提示「尚未出發登錄，本站不會自動計算區間公里」

### 3.3 今日摘要與紀錄列表

- 摘要卡「里程(km)」：有行程 → `Σ segment_km`（closed 後顯示 total_km）；無行程 → 沿用 `Σ mileage`
- 每站紀錄列：優先顯示 `segment_km`，其次 `mileage`

### 3.4 照片上傳

沿用既有壓縮＋上傳模式（createImageBitmap → canvas 800×600 JPEG 0.6 → `sb.storage.from(CONFIG.BUCKET)`），路徑：
- 出發/收工：`fieldwork/odo_trip_{員工編號}_{Date.now()}.jpg`
- 到站：`fieldwork/odo_{員工編號}_{Date.now()}.jpg`

## 4. 管理端（modules/settings.js 外勤審核）

- 列表列：里程顯示改為 `segment_km ?? mileage`，帶警示者加 ⚠️ 前綴
- 明細 modal 新增區塊：本站里程表讀數、區間公里、GPS 直線距離、警示文字、里程表照片（點擊放大，沿用 photo_urls 的顯示模式）
- 明細 modal 加查詢該筆 `trip_id` 對應行程的出發/收工讀數（單筆 select，`.eq('company_id', window.currentCompanyId)` 由 employees join 既有模式帶出或直接以 trip_id 查——trip 表自帶 company_id，直接 `.eq('company_id', ...)`）
- CSV 匯出（exportFieldWorkCSV）新增欄位：出發讀數、到站讀數、區間公里、GPS直線距離、警示、當日總公里

## 5. 多租戶與安全

| 查詢 | 隔離方式 |
|------|---------|
| 員工端 trips/logs 讀寫 | `.eq('employee_id', currentEmployee.id)`（員工自查，ID 來源已隔離） |
| trips insert | 帶 `company_id: currentCompanyId` |
| 管理端 trips 查詢 | `.eq('company_id', window.currentCompanyId)` |
| 管理端 logs 查詢 | 沿用既有 `employees!inner(company_id)` filter |

`field_work_logs` / `field_work_trips` 不在 RLS 禁寫清單（attendance 等五表），維持前端直寫；不需 SECURITY DEFINER RPC。

## 6. 錯誤與相容處理

- GPS 取得失敗：出發登錄仍可送出（lat/lng 為 null，該站 gps_distance_km 記 null、不產生比對警示）
- 照片上傳失敗：提示但不擋送出（照片為佐證非必要條件）
- 舊資料（無 trip_id）：管理端顯示 mileage、無警示區塊
- 跨日未收工的 open 行程：隔天出發登錄時偵測到昨日 open trip → 自動將其標記 closed（end_odometer 留空、total_km null），不影響新行程建立
