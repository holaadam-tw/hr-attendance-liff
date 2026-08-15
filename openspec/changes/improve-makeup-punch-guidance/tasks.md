## 1. 不完整打卡辨識

- [x] 1.1 在 `records.html` 抽出過去日期缺上班／缺下班的判斷並修正月曆狀態與統計
- [x] 1.2 在考勤明細加入可帶入補打卡表單的操作

## 2. 待補日期與表單引導

- [x] 2.1 在補打卡頁新增待補日期清單，排除已有 pending／approved 同類申請
- [x] 2.2 下班補打卡在時間尚未手動輸入時帶入公司預設或 17:00，並顯示下午 5:00 說明
- [x] 2.3 加入已知上下班時間衝突檢查，Adam 8/10 情境顯示主管處理指引且禁止送出

## 3. 測試與同步文件

- [x] 3.1 新增 `tests/makeup-punch-guidance.test.js` 並接入 `tests/run-all.js`、`package.json`
- [x] 3.2 更新 `docs/BUG_TRACKER.md` 與 `.claude/memory/architecture.md`
- [x] 3.3 更新 `common.js` cache-bust 引用並確認未新增資料庫／endpoint／LINE 副作用
- [x] 3.4 執行專項測試、`npm test`、`bash scripts/qa_check.sh` 與 RLS 最終審查
- [x] 3.5 讓補打卡申請失敗長訊息完整換行、延長閱讀時間並加入回歸測試
