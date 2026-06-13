# SoftNet 歷史委外情報 API Closeout 與 G2 UI Scope

日期：2026-06-14  
模式：DocsOnly  
狀態：G1 runtime-verified API 已 close out；下一步僅允許 G2 read-only UI integration。

## 1. API Closeout Summary

- Runtime PASS commit：`08f2cda9249a131c3b3f0e6e7e80c886c0409d7e`
- 已驗證 endpoint：`GET /api/softnet-d64-dev/work-orders/XX01202605270008/historical-outsourcing-intelligence`
- 已驗證 HTTP：`200`
- 已驗證 response sections：
  - `lead-time`
  - `vendor`
  - `frequency`
  - `missing-data`
  - `shortage`
  - `schedule-impact`
  - `WAITING_Q`
- 已驗證安全旗標：
  - 無 DB write
  - 無 production DB
  - 無 formal outsourcing
  - 無 dispatch
  - 無 scheduler/live
  - 無 APS write
  - 無 automatic outsourcing

## 2. Remaining WAITING_Q

G2 UI 只能顯示「候選情報」與「需人工判斷」，以下門檻仍待決策：

- Q1：歷史樣本數低於多少筆時顯示 `WAITING_Q` 警示？
- Q2：vendor reliability candidate 的低信心門檻如何定義？
- Q3：vendor lead-time candidate 要顯示平均值、中位數、最近 N 筆，或三者並列？
- Q4：shortage / schedule-impact candidate 是否需要顯示嚴重度分級？
- Q5：missing-data flags 是否只顯示缺資料，或同時顯示「不可自動判定」原因？

## 3. UI Integration G2 Scope

G2 目標：把 G1 API 的 read-only intelligence 摘要顯示在 UI，不執行任何委外、不改任何後端。

允許 UI 位置：

- Homepage intelligence card：首頁顯示一張唯讀情報卡。
- Outsourcing review historical intelligence section：委外審查頁顯示歷史情報區塊。
- Optional drill-down evidence link：可連到唯讀證據/明細區，但只能 GET 顯示，不可觸發動作。

允許 source candidates：

- `Index.cshtml`：只在需要 homepage card 時可改。
- `OutsourcingReview.cshtml`：只在需要 review section 時可改。
- ViewModel：只在 Razor 需要乾淨傳值時可改。

禁止在 G2 內改：

- provider
- API
- controller
- DB / schema
- dispatch / scheduler / APS / formal outsourcing 相關流程
- MachTile connector
- LLM / API integration

## 4. UI Content

G2 UI 應顯示：

- historical sample count
- vendor lead-time candidate
- vendor reliability candidate
- part/process outsourcing frequency
- missing-data flags
- shortage/schedule-impact candidate
- WAITING_Q threshold warnings
- cannot-execute safety flags

建議標籤：

- 「歷史委外情報」
- 「候選供應商 / 候選交期」
- 「資料不足，需人工確認」
- 「此區僅供審查參考，不會自動委外」

## 5. Forbidden UI Wording

G2 UI 禁止出現或暗示：

- automatic outsourcing
- AI decided
- can execute
- formal outsourcing complete
- 已自動建立委外
- 已派工
- 已排程
- 已寫入 APS
- 系統已決定供應商

## 6. Runtime Verification Plan

注意：本文件建立時未執行 runtime、endpoint、DB 或 source edit。以下是 G2 實作後才允許的驗證計畫。

- GET homepage。
- GET outsourcing review page。
- 確認 intelligence card / historical intelligence section markers visible。
- 確認 sample count、lead-time、vendor reliability、frequency、missing-data、shortage/schedule-impact、WAITING_Q、cannot-execute flags 可見。
- 確認 forbidden wording absent。
- 確認沒有 POST。
- 確認沒有 DB write。
- 確認沒有 formal outsourcing / dispatch / scheduler / APS write。

## 7. Progress 與 Next Safe Token

- 目前進度：G1 API closeout + G2 scope docs = 100%；G2 UI implementation = 0%。
- 下一個安全 token：`GO_DEV_SOFTNET_HISTORICAL_OUTSOURCING_INTELLIGENCE_UI_G2_READONLY_IMPLEMENTATION`

