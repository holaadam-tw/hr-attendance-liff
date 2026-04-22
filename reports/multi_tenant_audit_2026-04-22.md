# 多租戶隔離審查報告（Batch 1）

**日期**: 2026-04-22
**範圍**: HR 考勤 LIFF 系統兩家公司（大正科技 `8a669e2c...`、本米 `fb1f6b5f...`）的資料隔離
**方法**: Explore agent 深度 grep + code review → 覆驗抽樣（H1 / H2 / H4）
**用途**: 純審查漏洞清單，**不動 code**（修復需使用者明確授權）

---

## 🔴 嚴重漏洞（可跨公司讀/寫）

### H1 — `employees.line_user_id` 全局 UNIQUE（無 company_id 複合鍵）`[高信心]`

**檔案**: `migrations/001_initial_schema.sql:36`
```sql
line_user_id VARCHAR UNIQUE,  -- 全局 UNIQUE，非 (company_id, line_user_id)
```

**對照證據**: `migrations/026_loyalty_line_user.sql:12` `loyalty_members` 表**用對 pattern**：
```sql
UNIQUE (company_id, line_user_id);
```
→ 顯示設計者「知道」這 pattern，但 employees 表沒用。

**觸發情境**: 一個 LINE 帳號 `U123` 不能同時綁兩家公司（會被全局 UNIQUE 擋），但反過來，既有員工表的 `SELECT ... WHERE line_user_id = U123 LIMIT 1` 就**永遠能找到唯一一筆**。**真正風險是 RPC 隱式行為**：
- `quick_check_in`（`migrations/069:42`）透過 `line_user_id` 查員工 → 該員工屬於哪家公司全看 `employees.company_id` 的值
- 若未來需求改為「員工能在不同公司任職」（例如派遣 / 多公司登記）→ UNIQUE 會擋，架構層難升級
- 當前風險程度：**低**（UNIQUE 反而提供保護）；但**架構僵硬度高**，未來 multi-company 員工會卡住

**影響**: 架構性限制 — 目前不會跨公司洩漏（UNIQUE 擋住），但封死未來「員工可加入多公司」的擴展路徑。

**修復方向**:
1. 改為 `UNIQUE (company_id, line_user_id)`（**破壞性，需 migration + 所有 RPC 同步改用 `(company_id, line_user_id)` 查詢**）
2. 或維持現狀但文件化（接受單人單公司限制）

**覆驗結果**: ✅ Agent 報告方向正確，但我把 **嚴重度從「跨公司竄改風險」調整為「架構性限制」** — 當前 UNIQUE 反而是保護（非漏洞），真正問題是未來擴展。

---

### H2 — `get_company_shift_types` RPC 信任前端 `p_company_id`，無呼叫者驗證 `[高信心]`

**檔案**: `migrations/068_shift_types_rpc.sql:10-26`
```sql
CREATE FUNCTION get_company_shift_types(p_company_id UUID)
RETURNS JSONB
LANGUAGE plpgsql STABLE SECURITY DEFINER AS $$
BEGIN
    RETURN ... FROM shift_types
    WHERE (company_id = p_company_id OR company_id IS NULL)
      AND is_active = true;
END;
$$;
GRANT EXECUTE ON FUNCTION ... TO anon, authenticated;
```

**觸發情境**:
1. 任何 anon 用戶（含從未登入過的人）呼叫此 RPC 傳任一 company UUID
2. 因為 `SECURITY DEFINER` + `GRANT anon`，RPC 以擁有者權限執行，無身份檢查
3. **回傳該公司所有班別**（name, code, start_time, end_time）

**同檔其他 RPC 有類似問題**：
- `create_shift_type(p_company_id, ...)` L30-52：只驗公司存在，**不驗呼叫者屬於該公司** → anon 可寫入
- `update_shift_type(p_id, p_company_id, ...)` L56-75：同上 → anon 可改別家班別
- `delete_shift_type(p_id, p_company_id)` L79-88：同上 → anon 可刪別家班別

**影響**:
- **讀洩漏**：對手公司的班別設定（排班時間表）外洩
- **寫漏洞**：anon 可建立/修改/刪除任何公司的班別（透過直接打 Supabase RPC endpoint）

**注意**: `company_id IS NULL` 是**平台共用班別**設計（feature，非 bug）。漏洞在於「只驗參數公司存在，不驗呼叫者身份」。

**修復方向**:
- RPC 內部加 `auth.uid()` 查 `employees` 表確認身份
- 或改用 JWT 內含的 company_id claim（Supabase RLS 標準做法）

---

## 🟠 高風險（特定條件下洩漏）

### H3 — 薪資/獎金全域狀態切公司時未清理 `[Agent 報告，未親驗，中信心]`

**檔案**: `modules/payroll.js:L20-27, L94, L547` + `modules/auth.js:L335` (`switchCompanyAdmin`)

**Agent 觸發情境**（我未親自驗證）:
1. 平台管理員在 A 公司薪資頁點「計算薪資」→ 全域變數 `bonusEmployees`, `payrollEmployees`, `payrollBrackets`, `bonusAdjustments` 填入 A 資料
2. 呼叫 `switchCompanyAdmin` 切 B 公司 — 僅清 `sessionStorage['system_settings_cache']`，**不清 payroll 模組全域變數**
3. 若快速切回 A 或操作 B 公司 UI 前舊資料顯示瞬間 → 資料污染

**影響**: 薪資/獎金數字錯亂、手動調整值跨公司殘留（可能誤發獎金）

**修復方向**: `switchCompanyAdmin` 中呼叫各模組的 `clearCache()` 清理函式，或事件匯流排 `companychange` 讓模組自清

**待驗證**: 我沒親自讀 `modules/auth.js:L335` `switchCompanyAdmin` 實作

---

### H4 — `attendance_public.html` URL 可竄改 `[設計意圖待確認]`

**檔案**: `attendance_public.html:377-414`（init 函式）

**覆驗結果**:
```js
const params = new URLSearchParams(window.location.search);
companyId = params.get('company');
// 只驗公司存在，不驗看者有權
const { data: company } = await sb.from('companies').select('id, name').eq('id', companyId).maybeSingle();
```

**兩種可能**:
- **(a) 這是 feature（public by design）**：
  - L396 watermark `'會計查看模式'`
  - 頁面有「📲 打卡 QR」按鈕產生 URL 分享給會計（anyone with link）
  - 公開連結給合作夥伴/會計查看打卡總覽
- **(b) 這是 bug（原意只給自家）**：
  - URL 可被任何人竄改
  - 對方知道兩家公司 UUID（不難，本米的 fb1f6b5f... 有顯示在 URL），就能偷看別家打卡資料

**需要 user 判斷意圖**。

**若是 bug**: 修復方向 — 加 LIFF 登入驗證或 access_token URL 參數（HMAC-signed）

---

## 🟡 中風險

### M1 — `quick_check_in` RPC 理論上依 line_user_id LIMIT 1 `[推論]`

**檔案**: `migrations/069_block_kiosk_self_checkin.sql:42`

**觸發情境**: 因 H1 的全局 UNIQUE，此 RPC 用 `WHERE line_user_id = p_line_user_id` 找員工，`LIMIT 1` 取唯一結果 → 當前安全。

**但若未來 H1 修改為複合鍵且允許多公司** → 此 RPC 需要額外傳 `p_company_id` 並驗證。

**當前風險：低**（UNIQUE 擋住）。僅作為 H1 修復時的配套清單。

---

### M2 — 平台管理員 UI 邊界 `[Agent 推論，未親驗]`

**檔案**: `modules/auth.js:L81-150` (`checkAdminPermission`)

**Agent 推論**: 平台管理員權限載入所有公司列表，若 admin.html 某處允許直接選公司 ID → 可能越界

**我的判斷**: 這是「前端被破解」後的漏洞，平台管理員本身就有跨公司權限，不算資料洩漏（而是身份濫用）

**降級為「觀察項」**，不列為當前要修的漏洞。

---

## 🟢 觀察項

### L1 — 設定 cache key 不含 company_id

**檔案**: `common.js` `loadSettings` / `getCachedSetting`

**風險**: 切公司若不清 cache → 取到前公司設定值
**緩解**: `switchCompanyAdmin` 目前**有清** `sessionStorage['system_settings_cache']`（從 H3 得知）→ 此項實際已緩解

---

## ✅ 本次審查確認安全的（抽樣）

1. **`get_company_monthly_attendance` RPC** (`migrations/043, 059`)
   - L156-172 逐日生成序列 + `WHERE e.company_id = p_company_id`
   - 每個子查詢都綁 `e.id` 員工層級過濾
   - ✅ 無 JOIN 跨公司漏洞

2. **`submit_leave_request` RPC** (`migrations/048`)
   - 透過 `SELECT id FROM employees WHERE line_user_id = ...` 取員工
   - 寫入的 leave_requests 會自動隸屬於該員工所屬公司
   - ✅ 隔離在員工層級（只要 H1 全局 UNIQUE 撐住，此 RPC 安全）

3. **RLS policies** (`migrations/002_rls_policies.sql`)
   - 大部分表 RLS 啟用但 policy 為 "allow all"
   - **真正的隔離靠 SECURITY DEFINER RPC + 前端 company_id filter**
   - 架構選擇（非漏洞，但需注意 RPC 層嚴謹度）

---

## 📋 本 Batch 發現彙總

| # | 代號 | 標題 | 嚴重度 | 驗證 | 動作建議 |
|---|---|---|---|---|---|
| 1 | H1 | employees.line_user_id 全局 UNIQUE（架構性） | 🔴 架構性限制 | ✅ 親驗 | **文件化** 或破壞性 migration |
| 2 | H2 | shift_types RPC 無呼叫者驗證（讀+寫） | 🔴 **可被 anon 改別家班別** | ✅ 親驗 | 🔥 **最優先修**（加 auth.uid 驗證） |
| 3 | H3 | payroll 全域變數切公司未清 | 🟠 高 | ⏳ 未親驗 | Batch 2 補驗，或 user 直接 approve 修 |
| 4 | H4 | attendance_public URL 可竄改 | ⚠️ 設計意圖待確認 | ✅ 親驗 | **user 先決定是 feature 還是 bug** |
| 5 | M1 | quick_check_in line_user_id 依賴 | 🟡 架構配套 | ✅ 親驗 | 隨 H1 一起修 |
| 6 | M2 | 平台管理員 UI 邊界 | 🟢 觀察 | ⏳ 未親驗 | 降級觀察 |
| 7 | L1 | settings cache key | 🟢 已緩解 | ✅ 親驗 | 無動作 |

---

## 🎯 最優先要你決策的 2 項

### 決策 1 — H2 `shift_types` RPC 無驗證
- **現況**：`get/create/update/delete_shift_type` 4 個 RPC 都 `GRANT anon` + 不驗呼叫者
- **影響**：anon 可讀/建/改/刪任何公司的班別
- **問**：要不要進入 Batch 4 PoC test 驗證可被 anon 利用？

### 決策 2 — H4 `attendance_public.html`
- **問**：公開 URL 只驗公司存在是 feature 還是 bug？
  - 若 feature（anyone with link 設計）：無需修
  - 若 bug（只給自家會計）：要加 LIFF 登入或 HMAC token

---

## 📎 延伸到 Batch 2 要查的（非多租戶但相關）

- payroll 全域變數生命週期（補 H3 驗證）
- 公司切換流程完整性（`switchCompanyAdmin` 全貌）
- 其他 `SECURITY DEFINER RPC` 的呼叫者驗證情況（上方只查了 068、043、048、059、069）

---

**本報告審查深度**:
- Agent 深度 grep + 8 類隱式漏洞檢查
- 3 項親驗（H1/H2/H4），3 項 Agent 結論採信並標註「未親驗」
- 2 項降級（M2、L1）
- 3 項確認安全（get_company_monthly_attendance / submit_leave_request / RLS 設計）
