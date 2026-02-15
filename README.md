# HR System - 員工服務中心

一個基於 LINE LIFF 和 Supabase 的員工服務系統，提供打卡、請假、便當訂購等功能。

## 專案結構

```
/hr-system
│
├── 🎨 style.css          (所有頁面的樣式)
├── 🧠 common.js          (共用邏輯：Supabase 設定、LIFF 初始化、共用函數)
│
├── 🏠 index.html         (首頁：選單、狀態顯示、綁定頁面)
├── 📸 checkin.html       (打卡功能：相機、拍照打卡)
├── 📝 records.html       (查詢功能：請假、考勤、薪資)
└── ⚙️ services.html      (服務功能：便當訂購、系統設定)
```

## 功能特色

### 🏠 首頁 (index.html)
- 員工身分綁定（身分證/驗證碼）
- 用戶資訊顯示
- GPS 定位狀態
- 快速打卡按鈕
- 功能選單（九宮格）

### 📸 打卡頁面 (checkin.html)
- 相機功能（前鏡頭）
- 拍照打卡
- GPS 定位驗證
- 上班/下班打卡

### 📝 查詢頁面 (records.html)
- **請假申請**：特休假、病假、事假、補休
- **考勤查詢**：月度出勤記錄、統計
- **薪資查詢**：年終獎金資格計算

### ⚙️ 服務頁面 (services.html)
- **便當訂購**：素食/葷食選擇、農曆初一十五提醒
- **系統設定**：打卡地點管理、GPS 座標設定

## 技術架構

### 前端技術
- **LINE LIFF SDK** - 用戶身份驗證
- **Supabase JS** - 資料庫操作
- **原生 JavaScript** - 無框架依賴
- **CSS Grid/Flexbox** - 響應式設計

### 資料庫結構
- `employees` - 員工資料
- `attendance` - 打卡記錄
- `leave_requests` - 請假申請
- `lunch_orders` - 便當訂購
- `office_locations` - 打卡地點設定
- `system_settings` - 系統設定

## 部署說明

### 1. 設定 Supabase
```javascript
// 更新 common.js 中的設定
const CONFIG = {
    LIFF_ID: '你的_LIFF_ID',
    SUPABASE_URL: '你的_Supabase_URL',
    SUPABASE_ANON_KEY: '你的_Supabase_Anon_Key',
    BUCKET: 'selfies'
};
```

### 2. 設定 LINE LIFF
1. 在 LINE Developers Console 建立 LIFF 應用
2. 設定 LIFF URL 指向 `index.html`
3. 啟用 Camera 權限

### 3. 上傳檔案
將所有檔案上傳到 Web 伺服器，確保：
- 支援 HTTPS
- 正確的 MIME 類型設定
- 檔案路徑正確

## 開發說明

### 新增功能
1. 在對應的 HTML 檔案新增 UI
2. 在 `common.js` 新增共用函數
3. 在各頁面的 script 區塊新增頁面專用邏輯

### 樣式修改
所有樣式都在 `style.css` 中，使用 CSS 變數：
```css
:root {
    --primary-color: #667eea;
    --secondary-color: #764ba2;
    --bg-color: #f3f4f6;
    --text-color: #333;
}
```

### 頁面路由
使用 hash 進行頁面切換：
- `records.html#leave` - 請假頁面
- `records.html#attendance` - 考勤查詢
- `records.html#salary` - 薪資查詢
- `services.html#lunch` - 便當訂購
- `services.html#settings` - 系統設定

## 瀏覽器支援

- Chrome (推薦)
- Safari
- Edge
- LINE App 內建瀏覽器

## 版本資訊

- **版本**: v9.4.1 (修復版)
- **最後更新**: 2026-01-27
- **適用平台**: LINE LIFF 2.x

## 授權

內部使用，請勿外流。
