# 修改同步檢查表

每次修改前請確認以下事項：

## 資料查詢
- [ ] 查詢 employees 表有加 `.eq('company_id', window.currentCompanyId)`？
- [ ] 查詢 system_settings 有加 `.eq('company_id', window.currentCompanyId)`？
- [ ] 新增資料有帶 `company_id: window.currentCompanyId`？
- [ ] 查詢商店相關資料有用 `store_id` 篩選？

## 底部導航
如果新增頁面：
- [ ] 頁面有呼叫 `initBottomNav()` 或 `renderBottomNav()`？
- [ ] bottom_nav_config 的 available 列表有加入？
- [ ] 新頁面有正確的 LIFF 初始化流程？

## 全域變數
- [ ] 跨函數變數有掛 `window`？
- [ ] 新函數有 export 到 `window`（modules/index.js）？

## 設定相關
- [ ] 寫入 system_settings 有用 `saveSetting()` 共用函數？
- [ ] 設定有用 `.eq('company_id', currentCompanyId)` 篩選？

## UI 相關
- [ ] 新 UI 在手機 LINE LIFF 測試過？
- [ ] 管理頁面有自動選擇商店（不顯示下拉）？
- [ ] 列表有空狀態提示？
- [ ] 按鈕有 loading 狀態防重複點擊？

## 部署
- [ ] git add -A && git commit && git push？
- [ ] GitHub Pages 部署完成（等 1-2 分鐘）？
- [ ] Ctrl+Shift+R 清快取測試？

## 檔案關聯對照表
| 修改項目 | 需同步檔案 |
|---------|-----------|
| 新增頁面 | common.js(導航), modules/index.js(export), bottom_nav_config |
| 員工欄位 | modules/employees.js, admin.html, common.js |
| 系統設定 | common.js(loadSettings), modules/settings.js |
| 公告 | common.js(loadAnnouncements), modules/settings.js(管理端), index.html(小卡) |
| LINE 推播 | common.js(sendLineMessage), Edge Function(line-push) |
| 預約 | booking.html(消費者), modules/store.js(管理端) |
| 點餐 | order.html(消費者), modules/store.js(管理端) |
