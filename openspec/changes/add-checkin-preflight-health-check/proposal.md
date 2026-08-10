## Why

目前打卡頁只能在失敗後顯示零散診斷，管理者也無法從自己的電腦判斷員工手機上的 LINE、相機、照片編碼、定位或網路是哪一環有問題。需要在真正打卡前提供一個安全的一鍵檢查，讓員工在原裝置上產生白話且可截圖回報的結果，降低到下班時間才發現無法打卡的風險。

## What Changes

- 在 `checkin.html` 加入「打卡環境檢查」入口，員工可在不送出打卡的情況下主動檢查目前手機。
- 一鍵依序檢查 LINE／LIFF 登入與員工身分、網路可用性、相機權限與有效畫面、記憶體內照片編碼、定位權限與座標取得狀態。
- 顯示每一項的「正常／需處理」結果、耗時、白話原因及手機操作建議，並產生不含照片、精確座標、LINE user ID 或員工 ID 的可截圖診斷摘要。
- 檢查流程不呼叫打卡 RPC、不建立考勤、不上傳測試照片、不寫入資料庫，也不影響原本上班／下班按鈕與規則。
- 保留既有自動回歸測試作為系統端檢查；新增自我檢查的正向、權限拒絕、逾時、相機無有效畫面、照片編碼失敗及定位失敗測試。
- 現有 `checkin-debug.html` 含會實際寫入打卡的 RPC 測試按鈕，不作為員工入口；本次新功能採完全無寫入的安全模式。

## Capabilities

### New Capabilities

- `checkin-device-health-check`: 在打卡頁提供無副作用的一鍵裝置與打卡環境檢查、白話修復建議及可安全回報的診斷摘要。

### Modified Capabilities

<!-- 無既有 OpenSpec capability 需要修改。 -->

## Impact

- 主要影響 `checkin.html` 的畫面與前端檢查流程，重用既有相機、照片編碼及 GPS helper。
- 新增專用自動測試並納入 `npm test`；同步更新 `docs/BUG_TRACKER.md` 與 `.claude/memory/architecture.md`。
- 不新增或修改 API、RPC、資料表、RLS、migration、LIFF ID、Supabase 設定或部署流程。
