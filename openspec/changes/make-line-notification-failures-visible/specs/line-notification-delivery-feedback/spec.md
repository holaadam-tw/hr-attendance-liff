## ADDED Requirements

### Requirement: LINE 推播回傳可判定結果
系統 SHALL 對每次 LINE 推播回傳明確的成功或失敗結果；成功 MUST 同時符合 HTTP 與 LINE 包裝狀態均為 2xx，且結果不得包含 Channel Access Token。

#### Scenario: LINE 接受訊息
- **WHEN** Edge Function 與 LINE 都回傳 2xx
- **THEN** 共用推播 helper 回傳 `ok=true` 及成功狀態

#### Scenario: LINE 401 包在 HTTP 200 內
- **WHEN** 現行 Edge Function 以 HTTP 200 回傳 `status=401`
- **THEN** 共用推播 helper 回傳失敗，不得誤判成功

#### Scenario: 網路錯誤
- **WHEN** 瀏覽器無法連線 Edge Function
- **THEN** 共用推播 helper 回傳網路失敗與不含敏感資料的處理訊息

### Requirement: 測試推播呈現真實結果
管理端測試推播 MUST 只在 LINE 實際接受訊息時顯示成功；缺少 Token、缺少 Group ID、LINE 拒絕或網路失敗 MUST 顯示紅色失敗與可操作說明。

#### Scenario: 設定缺失
- **WHEN** 管理者按測試推播但 Token 或 Group ID 未設定
- **THEN** 畫面顯示缺少哪一類設定且不呼叫 LINE

#### Scenario: LINE 拒絕測試訊息
- **WHEN** 測試推播收到 LINE 非 2xx 結果
- **THEN** 畫面顯示推播失敗，不得顯示「請查看 LINE 群組」

### Requirement: 請假資料結果與通知結果分離
員工送出請假以及主管核准或退回後，系統 MUST 保留既有資料成功結果；LINE 通知失敗 SHALL 額外顯示警告，不得回滾、重送或誤報資料操作失敗。

#### Scenario: 申請成功但主管群組通知失敗
- **WHEN** `submit_leave_request` 成功而主管群組推播失敗
- **THEN** 畫面明示請假已送出並等待審核，同時提示 LINE 通知失敗

#### Scenario: 審核成功但員工通知失敗
- **WHEN** `approve_leave_request` 成功而員工 LINE 推播失敗
- **THEN** 畫面明示審核已完成，同時提示員工通知失敗

### Requirement: 員工通知查詢維持公司隔離
系統 SHALL 以員工 ID 與目前公司 ID 同時查找 LINE 收件者，避免跨公司帳號取得其他公司的通知對象。

#### Scenario: 相同使用者存在多公司資料
- **WHEN** 系統依審核結果查詢員工 LINE 收件者
- **THEN** 查詢同時限定 `employee_id` 與目前 `company_id`
