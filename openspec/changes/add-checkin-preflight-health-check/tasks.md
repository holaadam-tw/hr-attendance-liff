## 1. 打卡頁安全檢查介面

- [x] 1.1 在 `checkin.html` 加入「打卡環境檢查」按鈕、進度／結果區與不會真的打卡的說明
- [x] 1.2 建立結構化檢查結果、錯誤碼、白話建議與隱私安全摘要的渲染函數

## 2. 裝置與環境檢查流程

- [x] 2.1 實作 LIFF／員工公司脈絡與正式站無快取 GET 的無寫入檢查
- [x] 2.2 重用 `ensureCameraReadyForCapture()` 與 `canvasToJpegBlob()` 完成串流相機及記憶體 JPEG 檢查
- [x] 2.3 為 `input[capture]` fallback 加入獨立測試拍照路徑，完成後清除檔案且不呼叫上傳或打卡
- [x] 2.4 重用正式 GPS helper 檢查定位，僅回報耗時與精度等級，不顯示或保存座標
- [x] 2.5 確保檢查與正式打卡互斥、每項獨立失敗、結束後恢復按鈕且保留可用相機串流

## 3. 自動驗證與文件

- [x] 3.1 新增自我檢查回歸測試，涵蓋全通、權限拒絕、網路／定位逾時、無有效畫面、JPEG 失敗及系統相機 fallback
- [x] 3.2 加入禁止副作用的靜態／執行測試，確認自我檢查不含 `quick_check_in`、Storage upload、資料庫寫入或失敗記錄呼叫
- [x] 3.3 將新測試納入 `npm test`，並同步更新 `docs/BUG_TRACKER.md` 與 `.claude/memory/architecture.md`

## 4. 完整驗證與交付

- [x] 4.1 執行目標測試、`bash scripts/qa_check.sh` 與完整 `npm test`，確認 0 FAIL 且沒有新 hook 警告
- [x] 4.2 走查至少相機正常、相機失敗、定位失敗、系統相機 fallback 與檢查後正式打卡五個流程
- [x] 4.3 執行 `@rls-checker` 最終審查，確認無新增查詢、RPC、RLS、多租戶或正式資料副作用
- [x] 4.4 提供實機驗收步驟、剩餘限制與單一 commit 回滾方式，由使用者手動執行 Git 提交與部署
