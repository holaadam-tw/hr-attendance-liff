## Context

`leave_requests` 目前只有 `leave_hours`，無法知道時數假位於班別的哪個區段。`modules/payroll.js` 與 `attendance_public.html` 又直接以「打卡時間 − 08:00」計遲到，並以日曆日期跨度重算全日假，與 migration 095 已採用的工作日口徑不一致。migration 092 的每日稽核只建立 `missing_checkout`，尚未偵測晚到、早退或整日無打卡造成的應上班時數缺口。

本變更跨越 RLS 表、SECURITY DEFINER RPC、LINE 通知、員工表單與薪酬核對，且正式站由 `main` 自動部署；因此採相容 RPC，避免資料庫與前端無法同時切換造成中斷。

## Goals / Non-Goals

**Goals:**

- 保存同日時數假的實際起訖時間，依時間差自動計算小時與扣抵天數。
- 讓遲到核對排除全日假、上午半天假及從班別開始連續涵蓋的時數假；上午半天後以 13:00 為上班基準。
- 讓全日請假統計採工作日口徑，不再把週末重新算回去。
- 隔日偵測晚到、早退與整日無打卡的未涵蓋工作時間，依公司容忍分鐘通知員工及彙總主管。
- 保持多租戶隔離、既有漏下班卡流程及無正式資料庫副作用的離線驗證。

**Non-Goals:**

- 不自動建立請假申請、不自動核准、不直接修改 attendance。
- 不改變跨日班的打卡與計薪規則；跨日班先排除於此缺時掃描。
- 不回填舊時數假的起訖時間；舊資料保留 `leave_hours` 作相容讀取。
- 本次不套用正式資料庫、不合併 main、不部署。

## Decisions

### 1. 兩支順序明確的 migration

- `113_hourly_leave_time_range.sql`：新增 `leave_start_time TIME`、`leave_end_time TIME`，建立新 RPC 簽章與讀取欄位。
- `114_missing_work_hours_audit.sql`：擴充 migration 092 的 anomaly 掃描、查詢與每日 LINE 通知。

拆開後可先驗證請假資料契約，再啟用通知；回復時也能先停掃描而不移除已保存的請假時間。

### 2. 以相容 overload／v2 RPC 避免切換中斷

`submit_leave_request` 新增一個參數集合不同且無 DEFAULT 歧義的 overload，要求 `p_company_id`、`p_leave_start_time`、`p_leave_end_time`；舊簽章保留給舊前端。歷史查詢用具 `p_company_id` 的 overload，主管審核使用 `get_leave_approval_requests_v2` 並由前端在 migration 尚未套用時回退舊 RPC。員工查找以 `line_user_id + company_id + is_active` 限定；公司參數只能縮小身分範圍。

時數假限定 `start_date = end_date`、起訖時間必填、結束晚於開始且至少 60 分鐘；`leave_hours` 與 `days` 由 DB 計算到小數。舊時數假不回填，因此資料表 CHECK 採 `NOT VALID`：新寫入受約束、舊列不被猜測時間。

### 3. 共用純函數計算請假調整後遲到

`common.js` 提供可測試 helper，輸入打卡時間、日期與當日已核准請假：

- 全日假：遲到 0。
- 上午半天：有效上班基準 13:00；12:40 到班為 0，13:05 為 5 分鐘。
- 下午半天：不抵扣早上遲到。
- 時數假：只有從班別開始時間連續覆蓋的區間才延後上班基準；中午才開始的時數假不得抵扣早上遲到。

`modules/payroll.js` 使用 `common.js` helper；獨立、不載入 LIFF/common.js 的 `attendance_public.html` 實作同規則的本地純函式。全日假優先讀 migration 095 保存的 `days`；半天固定 4 小時；新時數假由起訖時間算、舊列才 fallback `leave_hours`。

### 4. 缺時掃描以班別區段覆蓋為準

內部 SECURITY DEFINER helper 依排班優先、員工固定班、公司預設班的順序取得工作區間，排除午休。實際 attendance 與已核准 leave 形成覆蓋區間，剩餘分鐘分成：

- 晚到缺口：班別開始到打卡時間，超過 `late_threshold_minutes` 才建立 anomaly。
- 早退缺口：下班時間到班別結束，超過 `early_leave_threshold_minutes` 才建立 anomaly。
- 整日無打卡：工作日且無 attendance、無全日核准請假即建立 anomaly。

缺下班卡繼續由 `missing_checkout` 處理，新掃描跳過該日，避免重複訊息。免打卡、公務機、停用、休假日、未結束的當日及跨日班全部排除。

### 5. 沿用 `attendance_anomalies` 並保存可稽核的計算快照

新增 `anomaly_type='missing_work_hours'`，沿用唯一鍵、狀態、通知次數與結案欄位，並增加 `details JSONB` 保存當次缺時、晚到、早退、容忍分鐘與原因，讓通知及主管畫面使用同一份稽核快照。核准請假或補卡後，下次掃描重新計算；缺口消失才以 `system_reconciled` 自動結案。

### 6. 沿用 migration 092 通知管線

保留既有 09:10 未下班稽核，新增台灣時間 09:15 缺時掃描，檢查前一日及近 3 天未結案項目；每筆一天最多通知一次。員工訊息列出日期及未涵蓋分鐘並連到請假入口；主管群組收到公司彙總，不包含跨公司資料。LINE 呼叫不影響 attendance 或 leave_requests。

## Risks / Trade-offs

- [舊 LINE WebView 在 migration 後仍顯示舊時數欄位] → 舊版提交時數假會收到明確「請重新開啟頁面填寫起訖時間」，非時數假仍相容；前端所有 `common.js` 引用同步升版。
- [舊時數假沒有起訖時間] → 僅在報表用 `leave_hours` fallback，不讓舊資料影響新缺時區段判斷；必要時由主管人工核對。
- [排班與午休設定不完整] → 沿用既有 quick_check_in／migration 095 的 fallback，不建立跨日班缺時 anomaly。
- [LINE API 或 pg_net 失敗] → anomaly 保留 pending，下次排程重試；不得影響 attendance 或 leave_requests。
- [分鐘級掃描成本] → 只有「整日無任何打卡」需要逐分鐘扣除午休與重疊請假；範圍限近 3 天、啟用 attendance_audit 的公司與在職需打卡員工，晚到／早退仍用區間算術。

## Migration Plan

1. 在 dev 完成 migration、前端與離線測試；不得連正式資料庫。
2. 取得使用者對正式 schema 的第二次結構化授權後，先備份 RPC 定義並套用 113、114。
3. 唯讀驗證新欄位、函式簽章、RLS／GRANT 與 dry-run 掃描；通知函式先不手動發送。
4. 等 PostgREST schema cache 更新，再合併前端至 main。
5. 用測試員工驗證上午半天、13:05、時數假、晚到、早退與整日缺勤。

Rollback：先停用／回復 114 的 cron 與 audit 函式，再回復前端；113 新增欄位保留以避免資料損失，不直接 DROP。必要時回復舊 RPC 定義，但不得刪除已保存起訖時間。

## Open Questions

無；業主已確認上午半天後 13:00 起算、時數假記錄實際起訖時間，並授權在 dev 建立 migration（不得套正式庫）。
