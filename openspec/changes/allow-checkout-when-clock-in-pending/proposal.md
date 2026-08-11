## Why

後端 migration 107 已允許員工在「今日上班補卡仍待審」時先完成下班打卡，但首頁仍只以正式 `attendance` 上班紀錄決定按鈕，因此同樣是待審狀態的員工會因入口不同而出現有人能下班、有人必須等主管核准的不一致行為。需要讓首頁與後端規則一致，避免主管延遲審核造成員工漏下班卡。

## What Changes

- 首頁載入今日待審補卡後，若存在 `pending clock_in/check_in`，即視為「上班待審、可先下班」。
- 此狀態停用重複上班按鈕、開放下班按鈕，並顯示「上班待審，但可以先打下班卡」的明確提示。
- 昨日未打下班提醒仍保留，但不得覆蓋今日待審上班可下班的操作。
- 沒有正式上班紀錄、也沒有今日待審上班申請者，仍不得打下班卡，避免產生幽靈下班紀錄。
- 新增回歸測試，鎖定正常上班、待審上班、昨日缺卡、無上班資料及已下班等狀態。

## Capabilities

### New Capabilities

- `pending-clock-in-checkout`: 定義今日上班補卡待審時的首頁按鈕、提示與下班入口行為。

### Modified Capabilities

<!-- 無既有 OpenSpec capability 需要修改。 -->

## Impact

- 主要影響 `common.js` 的首頁打卡按鈕狀態判定及對應前端快取版本。
- 新增純前端回歸測試並納入 `npm test`；同步更新 Bug Tracker 與架構記憶。
- 不修改 migration 107、`quick_check_in`、審核 RPC、資料表、RLS 或考勤業務規則。
