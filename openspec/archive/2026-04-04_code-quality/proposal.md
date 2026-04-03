# 變更提案：admin.html 程式碼品質優化

## 摘要
針對 common.js 和 admin_fixes.js 進行 8 項程式碼品質優化，改善安全性、可維護性和程式碼規範。

## 動機
- innerHTML 未消毒存在 XSS 風險
- 空 try-catch 吞掉錯誤，難以除錯
- SELECT * 浪費頻寬，且欄位變更時可能引入非預期資料
- 殘留 console.log 影響正式環境效能
- var 宣告有變數提升問題
- 缺少 img alt 影響無障礙存取
- == 鬆散比較可能產生非預期行為

## 範圍
- **修改檔案**：common.js、admin_fixes.js、admin.html
- **不改**：inline onclick、SPA 架構、CSS
- **影響頁面**：所有使用 common.js 的頁面（需回歸測試）

## 實際調查數據
| 項目 | 預估 | 實際 | 說明 |
|------|------|------|------|
| innerHTML 消毒（common.js） | 35 | 35 | escapeHTML() 已存在於 L162 |
| innerHTML 消毒（admin_fixes.js） | 5 | 5 | 已使用 escapeHTML，需檢查遺漏 |
| 空 try-catch | 5 | 4+1 | common.js 4 個 + admin_fixes.js 1 個（僅註解） |
| index.js 404 | 調查 | 無根目錄引用 | 可能為瀏覽器 favicon 相關，需進一步確認 |
| SELECT * | 10 | 9 | common.js 9 處 |
| console.log | 11 | 11 | 保留 console.error |
| var 宣告 | 98 | 98 | 全部改為 let/const |
| img 缺 alt | 4 | 4 | 全在 admin.html |
| == 比較 | 15 | 1 | common.js 僅 L171 一處（`str == null`） |

## 風險
- var→let/const 可能影響變數提升行為（需逐一確認）
- innerHTML 消毒需區分「靜態 HTML 模板」和「含使用者輸入的動態內容」
- SELECT * 改指定欄位需確認所有使用到的欄位

## 日期
2026-04-04
