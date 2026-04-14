# 公務機打卡設定指引

## 設定步驟

### 1. 建立公務機員工帳號
- admin.html → 員工管理 → 新增員工
- 姓名：「公務機」或「大門打卡機」
- 部門：管理

### 2. 設定公務機屬性
- 編輯該員工 → 勾選「📱 公務機帳號」
- 系統會自動勾選「🚫 免打卡」

### 3. 綁定 LINE
- 用公務機的 LINE 開啟系統（LIFF URL）
- 複製 LINE User ID
- admin.html → 編輯該員工 → 貼上 LINE User ID

### 4. 測試
- 用公務機的 LINE 開啟 index.html
- 應自動跳轉到 kiosk.html（公務機打卡模式）
- 輸入員工工號/手機/身分證後4碼 → 識別員工 → 拍照打卡

## 常見問題

### 公務機進入沒有出現公務機模式
1. 確認 `is_kiosk = true`（在 admin.html 編輯員工勾選）
2. 確認 `line_user_id` 已綁定
3. 必須從 LINE LIFF 開啟（不是瀏覽器直接開）

### 員工打卡時找不到
1. 確認員工有設定至少一項識別資料：
   - 工號（employee_number）
   - 手機號碼（phone）
   - 身分證後4碼（id_card_last_4）
2. 確認員工 `no_checkin = false`（免打卡員工不會出現）

## SQL 檢查指令

```sql
-- 查公務機帳號狀態
SELECT name, employee_number, line_user_id, is_kiosk, no_checkin
FROM employees
WHERE company_id = '你的公司ID'
  AND is_kiosk = true;

-- 查員工識別資料
SELECT name, employee_number, phone, id_card_last_4
FROM employees
WHERE company_id = '你的公司ID'
  AND is_active = true;
```
