## ADDED Requirements

### Requirement: LINE 缺時通知預設關閉
系統 SHALL 使用獨立公司設定控制缺時 LINE 通知；設定不存在或不是明確 true 時 MUST 不發送員工私訊或主管彙總。

#### Scenario: migration 完成但尚未啟用
- **WHEN** 公司尚未建立 `missing_work_hours_line_notifications_enabled=true`
- **THEN** 每日排程仍可更新缺時 anomaly，但員工與主管均不收到 LINE

#### Scenario: 關閉已啟用通知
- **WHEN** 公司管理者將通知開關改為關閉
- **THEN** 後續每日排程立即停止該公司的缺時 LINE 發送

### Requirement: 主管可先掃描但不通知
系統 SHALL 提供公司限定的人工缺時掃描，並 MUST 沿用正式缺時計算規則更新 anomaly；該操作不得呼叫 LINE、不得修改 attendance、不得自動建立或核准請假。

#### Scenario: 人工預覽缺時名單
- **WHEN** 公司管理者按下「掃描但不通知」
- **THEN** 系統更新最近日期的缺時名單並顯示處理數與待處理筆數，通知數維持不變

#### Scenario: 掃描後資料已補齊
- **WHEN** 員工補卡或請假核准後主管再次人工掃描
- **THEN** 已無缺口的 missing_work_hours anomaly 自動結案，且不發 LINE

### Requirement: 只有公司管理者可操作
系統 MUST 驗證呼叫者對指定公司具有管理權限，且人工掃描與開關讀寫 MUST 以 company_id 隔離。

#### Scenario: 一般員工嘗試掃描
- **WHEN** 非管理角色呼叫人工掃描或設定 RPC
- **THEN** 系統以 access_denied 拒絕且不修改資料

#### Scenario: A 公司管理者操作 B 公司
- **WHEN** A 公司管理者傳入 B 公司的 company_id
- **THEN** 系統拒絕操作且不回傳 B 公司缺時名單

#### Scenario: 公務機帳號嘗試操作通知控制
- **WHEN** `is_kiosk=true` 的帳號直接呼叫人工掃描或設定 RPC
- **THEN** 系統以 access_denied 拒絕，不得因既有出勤總覽例外取得通知管理權限

### Requirement: 啟用前必須明確確認
管理介面 SHALL 清楚顯示通知狀態、每日 09:15 的發送內容與「掃描不通知」說明；從關閉切換為開啟時 MUST 要求管理者確認已核對名單。

#### Scenario: 管理者啟用通知
- **WHEN** 管理者確認目前名單正確並開啟通知
- **THEN** 系統保存公司設定，下一次 09:15 排程才可通知該公司員工與主管

#### Scenario: 管理者取消啟用確認
- **WHEN** 管理者在確認視窗按取消
- **THEN** 開關維持關閉且不寫入設定

### Requirement: 通知開啟後仍維持每日冪等
系統 SHALL 延續員工及主管群組的每日通知標記，同一公司同一批缺時 anomaly 在同一天人工或排程重跑時不得重複發送。

#### Scenario: 同日重跑每日函式
- **WHEN** 通知已開啟且同一天第二次執行每日函式
- **THEN** 已通知的員工與主管群組發送數皆為 0
