# 設計文件：admin.html 程式碼品質優化

## 技術方案

### 1. innerHTML 消毒（XSS 防護）
- **策略**：辨別每處 innerHTML 是否含使用者/DB 輸入，僅對動態資料套用 `escapeHTML()`
- **escapeHTML() 已存在**：common.js L162，替換 `&<>"'` 五個字元
- **不消毒**：純靜態 HTML 模板（如骨架屏、固定 UI）
- **消毒**：employee.name、department、position、日期、金額等 DB 來源欄位

### 2. 空 try-catch 加 console.error
- 所有空 catch 加入 `console.error('描述:', e);`
- admin_fixes.js L142 的 `/* 非致命 */` 也加 console.error

### 3. index.js 404 調查
- 根目錄無 index.js 檔案，HTML 中無對根 index.js 的引用
- 可能原因：瀏覽器 service worker 或第三方擴充套件
- **處理**：確認 admin.html 無多餘 script 引用，不需額外修改

### 4. SELECT * 改指定欄位
- 逐一檢查 9 處 `.select('*')` 呼叫
- 根據後續程式碼使用的欄位，替換為明確欄位列表
- 保留 `.select()` 不帶參數的（Supabase 預設等同 *，但此次不處理）

### 5. console.log 清除
- 移除 11 處 console.log
- 保留所有 console.error 和 console.warn

### 6. var 改 let/const
- 98 處 var → let 或 const
- 判斷規則：若變數後續無重新賦值用 const，否則用 let
- 注意函數宣告式的 var（如 `var ROLE_PERMISSIONS = {...}`）應改 const

### 7. img 加 alt
- admin.html 4 張 img 加描述性 alt 屬性

### 8. == 改 ===
- common.js L171 `str == null` → `str == null`（保留！因為 `== null` 是慣用法，同時捕獲 null 和 undefined）
- **結論**：此項無需修改，`== null` 是 JavaScript 最佳實踐

## 執行順序
1. var→let/const（最大量，先處理避免衝突）
2. innerHTML 消毒
3. 空 catch 加 error
4. SELECT * 指定欄位
5. console.log 清除
6. img alt
7. index.js 404 確認
8. == 確認（不修改）
