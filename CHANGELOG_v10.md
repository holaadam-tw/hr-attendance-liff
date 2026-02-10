# 🔧 v10.0 修復與優化清單

## 🐛 Bug 修復

### 1. Toast 樣式完全缺失 (style.css)
- **問題**：`showToast()` 建立的 `.toast` 元素沒有對應 CSS，導致 toast 通知不可見或位置異常
- **修復**：新增完整 `.toast` 樣式，包含定位、動畫（淡入/淡出）、毛玻璃背景

### 2. `btn-warning` 樣式缺失 (style.css)
- **問題**：admin.html 員工管理的「設為主管」按鈕使用 `.btn-warning` class，但 CSS 中沒有定義
- **修復**：新增 `.btn-warning` 樣式（黃色漸層）

### 3. common.js 重複初始化 (common.js)
- **問題**：`common.js` 底部有一個 `window.addEventListener('load')` 會與各 HTML 頁面的 `load` 事件衝突，造成雙重初始化
- **修復**：移除 common.js 中的 load 事件監聽器，僅保留 debug 模式載入。各頁面自行管理初始化

### 4. admin.html 地點管理元素 ID 不匹配 (admin.html + common.js)
- **問題**：admin.html 使用 `adminNewLocLat`、`adminNewLocLng` 等 ID，但 `common.js` 的 `getCurrentGPSForSetting()` 和 `addNewLocation()` 只尋找 `newLocLat`、`newLocLng`
- **修復**：
  - admin.html 改用與 common.js 一致的 ID（`newLocLat`, `newLocLng`, `newLocName`, `newLocRadius`, `locationList`）
  - common.js 增加 fallback，同時支援兩種 ID

### 5. Event Listener 洩漏 (common.js - loadAnnualSummary)
- **問題**：每次呼叫 `loadAnnualSummary()` 都會用 `addEventListener` 綁定新的 `change` 事件，造成事件重複觸發
- **修復**：改用 `onchange` 屬性賦值，自動覆蓋舊監聽器

### 6. 管理員頭像顯示錯誤 (admin.html)
- **問題**：`updateAdminInfo` 在有 LINE 頭像圖片時仍顯示 👑 emoji，覆蓋在圖片上
- **修復**：有圖片時清空 `textContent`

### 7. 請假日期未驗證 (common.js)
- **問題**：結束日期可以早於開始日期
- **修復**：新增日期邏輯驗證

### 8. 出勤時間解析可能崩潰 (common.js)
- **問題**：`check_in_time.split(' ')[1].substr(0,5)` 如果時間格式非預期會拋出錯誤
- **修復**：加入 try-catch 安全解析

## 🎨 介面優化

### style.css
- 新增 CSS 變數統一管理顏色與圓角
- Toast 新增滑入/滑出動畫
- 狀態訊息（status-box）加入輕微背景色提升可讀性
- 改進 Modal 的毛玻璃背景效果
- 按鈕新增 `-webkit-tap-highlight-color: transparent` 移除手機點擊藍色高亮
- 新增 hover 效果（僅限桌面裝置，`@media (hover: hover)`）
- 新增 iPhone 安全區域支援（`env(safe-area-inset-bottom)`）
- 改進捲軸樣式
- 更好的小螢幕響應式（360px 以下）

### common.js
- 新增 `friendlyError()` 函數，將技術性錯誤轉為使用者友善的中文訊息
- Toast 改進：限制同時顯示數量，避免堆疊
- 請假成功後自動清空原因欄位

### admin.html
- 員工管理按鈕佈局改進（flex-wrap 避免小螢幕溢出）
- 搜尋框加入 🔍 圖示
- 角色更新整合為單一函數，避免重複定義
- Modal 點擊背景關閉通用化（支援所有 Modal）
- 管理員資訊顯示部門 + 角色

### index.html
- LIFF 參數檢查加入 try-catch 防止異常
- 精簡重複代碼

### checkin.html
- 使用 `friendlyError()` 顯示更好的錯誤訊息
