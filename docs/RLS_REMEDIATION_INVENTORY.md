# RLS 整治盤點（2026-08-06）

> 這份文件只做盤點與排期建議，**沒有動任何程式**。
> 漏洞本身的描述見 `docs/BUG_TRACKER.md` 開頭「RLS 形同虛設」那一節。

---

## 一、先釐清：暴露面不是「頁面」，是 anon key ＋ RLS

公開的 anon key 寫在 `common.js` 裡，任何人打開網頁原始碼就看得到。這在 Supabase 是**正常設計**——前提是 RLS 有在做事。而正式庫現況是 64 張表裡 62 張不是 RLS 沒開、就是有一條 `USING (true)` 的政策把門全開。

所以：

- **攻擊者不需要透過任何頁面**。拿著 anon key 直接打 REST API 就能讀寫，頁面上的 `canSaveHumanSchedule()` 這類前端檢查完全不構成防線。
- 下面的頁面盤點**不是在列舉攻擊路徑**，而是在算「要把 RLS 收緊，得改多少程式」——因為政策一旦收緊，所有直接讀表的地方都會壞掉。

---

## 二、規模

掃描 41 個 `.html` / `.js`（排除 `tests/` `migrations/` `docs/` `scripts/` 等）：

| 指標 | 數字 |
|------|------|
| 直接存取的資料表 | **44** |
| 讀取點（表 × 檔案） | **138** |
| 寫入點（表 × 檔案） | **73** |
| 已在用的 SECURITY DEFINER RPC | 47 |

已經有 47 支 RPC 在用，代表這個模式在專案裡是成熟的（`quick_check_in`、`admin_makeup_punch`、`confirm_daily_overtime`、`get_company_daily_attendance` 等），改造是「延用既有模式」而不是「導入新架構」。

---

## 三、寫入點最集中的表

| 資料表 | 讀取點 | 寫入點 | 寫入方式 |
|--------|--------|--------|----------|
| `employees` | 15 | 7 | insert / update / delete |
| `companies` | 10 | 2 | insert / update / delete |
| `lunch_orders` | 9 | 3 | update / upsert |
| `system_settings` | 10 | 1 | insert / update |
| `loyalty_members` | 6 | 5 | insert / update |
| `loyalty_transactions` | 5 | 5 | insert |
| `store_profiles` | 5 | 3 | insert / update |
| `service_items` | 4 | 3 | insert / update / delete |
| `attendance` | 6 | 0 | （寫入已全走 RPC ✅） |
| `leave_requests` | 8 | 0 | （寫入已全走 RPC ✅） |
| `overtime_requests` | 3 | 0 | （寫入已全走 RPC ✅） |

**好消息**：`attendance` / `leave_requests` / `overtime_requests` 這三張最敏感的表，**寫入已經全部走 RPC 了**（`check-rls-bypass.sh` hook 的功勞），只剩讀取要處理。

---

## 四、無 LIFF 認證的公開頁面

這 9 頁不需要登入就能開：

`attendance_public.html`、`employee_register.html`、`register.html`、`loyalty.html`、`booking.html`、`booking_service.html`、`order.html`、`kds.html`、`kiosk.html`

其中有寫入的：

| 頁面 | 寫入 |
|------|------|
| `employee_register.html` | `employees`（insert / update） |
| `attendance_public.html` | `employees`（update：`shift_mode` / `fixed_shift_*`） |
| `kds.html` | `orders`（update）、`loyalty_members`（insert/update）、`loyalty_transactions`（insert） |
| `loyalty.html` | `loyalty_members`（update）、`loyalty_transactions`（insert）、`loyalty_redemptions`（insert） |
| `kiosk.html` | `lunch_orders`（upsert） |
| `booking_service.html` | `service_bookings`（insert） |
| `register.html` | `store_profiles`（insert） |

`attendance_public.html` 另外還**讀** `employees`、`attendance`、`leave_requests`、`lunch_orders`、`system_settings`、`companies`、`holidays`——一個不需登入的頁面讀得到全公司考勤。

---

## 五、建議分三階段，順序不可顛倒

### ⚠️ 鐵則：先補 RPC，全部改完並驗證，最後才收政策

順序反過來（先 `DROP POLICY`）會**當場弄壞所有還在直接讀表的頁面**。每一階段都必須是：

```
1. 寫 RPC（SECURITY DEFINER，函式內驗身分 + 多租戶）
2. 前端改呼叫 RPC
3. 補測試、qa_check、npm test 全綠
4. 部署並驗證線上正常
5. 才 DROP 該表的 USING(true) 政策 / ENABLE RLS
6. 跑 scripts/rls_audit.sh 確認該表已從清單消失
```

### P0 — HR 敏感資料（薪資與個資）

`employees`、`attendance`、`leave_requests`、`payroll_records`、`salary_settings`、`overtime_requests`、`makeup_punch_requests`、`schedules`

- 寫入部分：`attendance` / `leave_requests` / `overtime_requests` 已完成，只剩 `employees`（7 個寫入點）、`schedules`（1 個）、`salary_settings`（2 個）、`payroll`（1 個）
- 讀取部分是主要工作量：`employees` 15 個、`leave_requests` 8 個、`attendance` 6 個
- **`overtime_requests` 連 RLS 都沒開**，這張最快——`ENABLE ROW LEVEL SECURITY` 之後只剩 3 個讀取點要改（其中 1 個是 2026-08-05 新增的加班確認卡片）

### P1 — 營運設定

`companies`、`system_settings`、`clients`、`field_work_logs`、`field_work_trips`、`insurance_brackets`、`platform_admins`、`platform_admin_companies`

`system_settings` 有 10 個讀取點但只有 1 個寫入點，而且 `common.js` 已有 `loadSettings()` 集中管理——把那一支改成 RPC 就能覆蓋大部分。

### P2 — 門市與會員

`loyalty_*`（6 張）、`orders`、`menu_*`、`bookings`、`service_*`、`store_*`

量最大但外洩衝擊相對低。可以最後做，或評估這些資料是否本來就該公開讀（例如菜單）。

---

## 六、進行中的防止惡化機制

- `scripts/qa_check.sh` 第 8 項：新 migration 若又寫出 `USING(true)` 政策、或建表沒 `ENABLE ROW LEVEL SECURITY`，會出 WARN。**現況必然 WARN，用法是比對數字有沒有變多**
- `scripts/rls_audit.sh`：連線列出正式庫實況，每完成一階段就跑一次確認該表已消失
- `.claude/hooks/check-rls-bypass.sh`：擋前端直接寫入 RLS 表（`attendance` 等三張表的寫入之所以已經乾淨，就是這個 hook 的成果）

---

## 七、給業主的一句話版本

> 目前資料庫等於沒有上鎖，但門牌號碼（anon key）是公開的。修好要改 44 張表、211 個存取點，不可能一次做完；建議先鎖住薪資與個資這 8 張表，再處理其他。在鎖好之前，**不要對外宣傳或擴大使用範圍**。
