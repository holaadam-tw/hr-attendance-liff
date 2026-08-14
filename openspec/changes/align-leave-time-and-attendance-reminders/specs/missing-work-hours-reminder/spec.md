## ADDED Requirements

### Requirement: 隔日偵測未涵蓋工作時數
系統 SHALL 在隔日依班別、午休、attendance 與已核准請假計算前一工作日的未涵蓋工作時間，涵蓋晚到、早退及整日無打卡。

#### Scenario: 晚到超過容忍分鐘
- **WHEN** 班別 08:00 開始、公司遲到容忍 5 分鐘、員工 08:20 打卡且無核准請假
- **THEN** 系統建立 `missing_work_hours` anomaly 並標示晚到缺口 20 分鐘

#### Scenario: 晚到在容忍內
- **WHEN** 公司遲到容忍 5 分鐘且員工 08:04 打卡
- **THEN** 系統不建立缺時 anomaly

#### Scenario: 早退超過容忍分鐘
- **WHEN** 班別 17:00 結束、公司早退容忍 5 分鐘、員工 16:30 下班且無核准請假
- **THEN** 系統建立缺時 anomaly 並標示早退缺口 30 分鐘

#### Scenario: 整日無打卡無請假
- **WHEN** 日期為應工作日且員工整日沒有 attendance 或核准全日假
- **THEN** 系統建立整日缺勤的缺時 anomaly

#### Scenario: 已核准請假完整涵蓋
- **WHEN** 晚到或早退區段已被核准上午、下午或時數假完整涵蓋
- **THEN** 被涵蓋分鐘不列入缺口，全部涵蓋時不建立 anomaly

### Requirement: 避免錯誤與重複提醒
系統 MUST 排除休假日、停用、免打卡、公務機及跨日班；缺下班卡日期仍由既有 `missing_checkout` 處理，不得同時發送兩種提醒。

#### Scenario: 缺下班卡
- **WHEN** 員工有上班卡但下班卡為空
- **THEN** 系統只保留既有補卡或補請假提醒，不建立缺時提醒

#### Scenario: 休假日或免打卡員工
- **WHEN** 日期不是該員工工作日或員工為 no_checkin／is_kiosk
- **THEN** 系統不建立缺時 anomaly

#### Scenario: 重複掃描
- **WHEN** 同一員工同一日期同一 anomaly 已存在
- **THEN** 掃描不得新增重複列，且一天最多通知一次

### Requirement: 通知員工並彙總主管
系統 SHALL 以員工偏好語言私訊日期、缺口類型與分鐘並引導至補請假頁，且按公司彙總通知主管群組；通知失敗不得修改 attendance 或自動建立 leave_requests。

#### Scenario: 員工私訊
- **WHEN** 新增或仍待處理的缺時 anomaly 到達每日通知時間
- **THEN** 員工收到補請假提醒與 `records.html#leave` 入口

#### Scenario: 主管彙總
- **WHEN** 同公司有一筆以上待處理缺時 anomaly
- **THEN** 主管群組收到只包含該公司員工的彙總

#### Scenario: LINE 發送失敗
- **WHEN** LINE API 或 pg_net 發送失敗
- **THEN** anomaly 保持 pending 供下次重試，attendance 與 leave_requests 均不變

### Requirement: 缺口補正後自動結案
系統 SHALL 在補卡或請假核准後重新計算缺口，只有未涵蓋分鐘歸零或回到容忍範圍才自動結案。

#### Scenario: 時數假完整補正
- **WHEN** 員工補申請的核准時數假完整涵蓋原晚到或早退區段
- **THEN** 對應 anomaly 以 leave 結案

#### Scenario: 請假只涵蓋部分缺口
- **WHEN** 核准請假仍留下超過容忍值的未涵蓋分鐘
- **THEN** anomaly 保持 pending 並於後續彙總顯示剩餘缺口
