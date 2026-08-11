## ADDED Requirements

### Requirement: 今日上班待審時開放下班入口
系統 SHALL 在目前公司、今日存在 pending 的 `clock_in` 或 `check_in` 補卡申請且尚無正式 attendance 時，停用重複上班並開放下班按鈕。

#### Scenario: 上班補卡待審且尚未送下班
- **WHEN** 今日沒有正式 attendance，但目前公司有一筆 pending 上班補卡申請
- **THEN** 首頁停用上班按鈕並開放下班按鈕
- **THEN** 首頁明確顯示「上班待審，但可以先打下班卡」

#### Scenario: 上下班補卡都在待審
- **WHEN** 今日同時存在 pending 上班與 pending 下班補卡申請
- **THEN** 首頁停用上班及下班按鈕
- **THEN** 首頁提示下班卡已送審，不得重複送出

### Requirement: 沒有上班依據時仍禁止下班
系統 MUST NOT 只因沒有正式 attendance 就任意開放下班；必須存在今日待審上班申請或既有可下班 attendance／跨日班紀錄。

#### Scenario: 完全沒有上班紀錄或申請
- **WHEN** 今日沒有正式 attendance，也沒有 pending 上班補卡申請
- **THEN** 首頁開放上班按鈕並停用下班按鈕

#### Scenario: 待審清單載入失敗
- **WHEN** 系統無法確認今日是否有 pending 上班補卡申請
- **THEN** 首頁不得以待審狀態開放下班

### Requirement: 既有班次與缺卡提示維持正確優先序
系統 SHALL 保留跨日班與昨日一般班漏下班的既有處理，並在不衝突時同時呈現昨日缺卡提醒。

#### Scenario: 昨日跨日班仍待下班
- **WHEN** 昨日跨日班仍在可下班窗口
- **THEN** 系統優先處理跨日班下班，不得把今日待審上班狀態覆蓋其班次語意

#### Scenario: 今日上班待審且昨日一般班漏下班
- **WHEN** 今日有 pending 上班補卡，且昨日一般班缺少下班卡
- **THEN** 系統仍開放今日下班按鈕
- **THEN** 系統同時保留昨日補打卡提醒與連結

### Requirement: 待審狀態限定目前公司
系統 SHALL 以目前 `company_id` 呼叫既有 `get_my_makeup_requests`，不得使用另一家公司員工身分的待審申請開放本公司的下班入口。

#### Scenario: 跨公司員工查看目前公司
- **WHEN** 同一 LINE 使用者在多家公司有員工身分
- **THEN** 今日待審上班狀態只取目前選定公司的補卡申請

### Requirement: 首頁刷新後狀態一致
系統 SHALL 在初次載入、打卡頁返回刷新及頁面重新顯示後，依相同規則重算上班／下班按鈕。

#### Scenario: 主管尚未核准時返回首頁
- **WHEN** 員工送出上班待審後返回或重新開啟首頁
- **THEN** 首頁持續顯示下班可用，不要求主管先核准

#### Scenario: 主管核准後刷新
- **WHEN** 待審上班已核准並建立正式 attendance
- **THEN** 首頁改由既有正式 attendance 流程顯示上班時間與可下班狀態
