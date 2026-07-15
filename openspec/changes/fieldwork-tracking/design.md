# 技術設計：外勤行程地圖＋追蹤模式（fieldwork-tracking）

## 1. 資料模型（migration 094）

### 1.1 新表 `field_work_trackpoints`

```sql
CREATE TABLE IF NOT EXISTS field_work_trackpoints (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,  -- 量大用 BIGINT，不用 UUID
    trip_id UUID NOT NULL REFERENCES field_work_trips(id),
    employee_id UUID NOT NULL REFERENCES employees(id),
    company_id UUID NOT NULL REFERENCES companies(id),
    recorded_at TIMESTAMPTZ NOT NULL,
    lat DOUBLE PRECISION NOT NULL,
    lng DOUBLE PRECISION NOT NULL,
    accuracy NUMERIC,
    created_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_fwtp_trip_time ON field_work_trackpoints(trip_id, recorded_at);
CREATE INDEX IF NOT EXISTS idx_fwtp_company_time ON field_work_trackpoints(company_id, recorded_at);

-- 與 trips 相同存取模式；軌跡點不可改不可刪（僅 SELECT/INSERT）
GRANT SELECT, INSERT ON field_work_trackpoints TO anon, authenticated;
```

### 1.2 90 天自動清理（pg_cron）

```sql
SELECT cron.schedule('purge-fw-trackpoints', '30 18 * * *',  -- 台灣 02:30
    $$DELETE FROM field_work_trackpoints WHERE recorded_at < now() - interval '90 days'$$);
```

冪等處理：schedule 前先 `cron.unschedule` 同名 job（存在才解除，用 DO block 包 EXCEPTION）。

## 2. 員工端追蹤模式（fieldwork.html）

### 2.1 生命週期

```
出發登錄成功（fwTrip.status='open'）─┐
頁面載入發現今日 open trip ──────────┴→ startTracking()
    每 60s：navigator.geolocation.getCurrentPosition（低精度模式）
        accuracy > 1000m → 丟棄
        否則 push 進 buffer
    buffer 滿 3 點 或 距上次上傳 > 3 分鐘 → 批次 insert（一次 API call 多 rows）
visibilitychange hidden → stopTracking()（flush buffer 後停 timer）
visibilitychange visible 且 open trip → startTracking()
收工登錄成功 / trip closed → stopTracking()
```

- 計時器用 `setInterval` 存全域 `fwTrackTimer`；重複 start 前先 clear（防雙 timer）
- 取位不用共用 `getGPS()`（它是高精度+較長 timeout），改用獨立低成本呼叫：`enableHighAccuracy: false, timeout: 15000, maximumAge: 30000`
- 上傳失敗：buffer 保留，下一輪合併重試；buffer 上限 30 點（超過丟最舊，防無限成長）
- insert 每點帶 `trip_id / employee_id / company_id / recorded_at / lat / lng / accuracy`

### 2.2 UI

- 行程進行中卡片加一行狀態：`📡 軌跡記錄中（今日已記 N 點）` / 背景回來後自動恢復
- 出發登錄表單下方固定小字（知情告知）：「出發後，此頁面開啟期間會自動記錄位置軌跡，供公司核算外勤補貼」

## 3. 管理端行程地圖（admin.html + modules/settings.js）

### 3.1 Leaflet lazy load

- admin.html **不**在 head 預載；settings.js 新增 `ensureLeaflet()`：第一次開地圖時動態插入
  `https://unpkg.com/leaflet@1.9.4/dist/leaflet.css` 與 `leaflet.js`，Promise 快取
- 載入失敗（離線/CDN 擋）→ fallback 顯示文字版時間軸（各點時間+座標+客戶）

### 3.2 入口與資料

- 外勤審核明細 modal（showFwaDetail）有 trip_id 時顯示「🗺️ 行程地圖」按鈕 → `showTripMap(tripId)`
- 查詢（皆帶隔離）：
  - trip：`fwaTrips[tripId]`（已載入，含出發/收工點）
  - 站點：`fwaLogs.filter(l => l.trip_id === tripId)`（已載入，含 arrive/leave GPS）
  - 軌跡：`sb.from('field_work_trackpoints').select('recorded_at,lat,lng').eq('trip_id', tripId).eq('company_id', window.currentCompanyId).order('recorded_at').limit(2000)`

### 3.3 畫法

1. 事件點 marker：出發（綠）、各站到達（藍，popup＝時間+客戶名+segment_km/gps_distance_km）、收工（深灰）；離開點不畫 marker（避免擁擠），僅作連線節點
2. 全部點（事件點＋軌跡點）按時間排序成序列；相鄰兩點時間差 ≤ 5 分鐘 → 實線段；> 5 分鐘 → 虛線段（`dashArray`，表示無軌跡區間）
3. `map.fitBounds()` 自動縮放涵蓋全部點
4. 地圖下方圖例：「— 有軌跡路段　- - 僅起訖點路段」

### 3.4 Modal

新增 `fwaMapModal`（admin.html）：全寬 90vw、高 70vh 的地圖容器＋關閉鈕；重複開啟時 `map.remove()` 重建（Leaflet 容器不可重複 init）。

## 4. 多租戶與安全

| 操作 | 隔離 |
|------|------|
| 員工端 trackpoints insert | 帶 company_id + employee_id（來源 currentEmployee，已隔離） |
| 管理端 trackpoints 查詢 | `.eq('trip_id', ...)` + `.eq('company_id', window.currentCompanyId)` |
| Hook | `field_work_trackpoints` 加入 check-multitenant.sh 清單 |

無 UPDATE/DELETE grant → 軌跡不可竄改（比 trips 更嚴）。RLS 收緊隨 Phase 2/3。

## 5. 邊界處理

- GPS 權限被拒：追蹤靜默停用（console.warn），不彈窗騷擾，打卡功能不受影響
- 一日多開頁面：timer 只在本頁存活，多分頁同開會重複記點——可接受（畫線前按時間排序去重：同分鐘取第一點）
- 無軌跡點的舊行程（追蹤上線前）：地圖仍可開，全部虛線連打卡點
- trackpoints insert 失敗（如 migration 未套）：try/catch 靜默，不影響外勤打卡主流程
