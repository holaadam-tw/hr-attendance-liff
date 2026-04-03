# 任務清單：admin.html 程式碼品質優化

## 任務

- [x] T1: var 改 let/const — common.js 98 處 ✅
- [x] T2: innerHTML 消毒 — 5 處動態資料加 escapeHTML（其餘已有或靜態） ✅
- [x] T3: 空 try-catch 加 console.error — common.js 4 個 + admin_fixes.js 1 個 ✅
- [x] T4: SELECT * 改指定欄位 — common.js 9 處 ✅
- [x] T5: console.log 清除 — common.js 11 處 ✅
- [x] T6: img 加 alt — admin.html 4 張 ✅
- [x] T7: index.js 404 調查 — 根目錄無引用，modules/index.js 路徑正確，非程式碼問題 ✅
- [x] T8: == 改 === 確認 — common.js 僅 1 處 `== null`（JS 慣用法，保留） ✅

## 驗證
- 每項完成後跑 `bash scripts/qa_check.sh`
- 全部完成跑 `npm test`
- Git: checkout dev → commit → push → 合併 main
