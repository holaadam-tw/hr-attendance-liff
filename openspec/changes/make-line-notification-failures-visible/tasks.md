## 1. 共用推播結果

- [x] 1.1 讓 `sendLineMessage` 同時判斷 HTTP 與包裝後的 LINE status，回傳不含 Token 的結構化結果
- [x] 1.2 讓主管與員工通知 helper 傳遞失敗結果，並補上員工查詢的公司隔離
- [x] 1.3 更新本機 `line-push` Edge Function 原始碼，使 HTTP 狀態與 LINE 結果一致且保持舊呼叫格式相容

## 2. 請假與設定畫面

- [x] 2.1 修正管理端測試推播，只在真實成功時顯示成功並提供白話失敗原因
- [x] 2.2 請假申請成功但主管通知失敗時顯示獨立警告，不改變申請結果
- [x] 2.3 請假審核成功但員工通知失敗時顯示獨立警告，不改變審核結果

## 3. 回歸與文件

- [x] 3.1 新增離線 LINE 通知回歸測試並納入 `npm test`
- [x] 3.2 同步 `common.js`／管理模組快取版本及所有引用頁面
- [x] 3.3 更新 BUG_TRACKER 與 architecture，記錄行為、剩餘風險及未部署 Edge Function
- [x] 3.4 執行專項、完整、UI、QA、OpenSpec strict 與負面副作用驗證
