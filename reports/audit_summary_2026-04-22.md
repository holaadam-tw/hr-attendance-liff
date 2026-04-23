# 審查彙總報告（Batch 3）

**日期**: 2026-04-22（彙總於 2026-04-23 補做）
**來源**: `reports/multi_tenant_audit_2026-04-22.md`（Batch 1）+ `reports/logic_security_audit_2026-04-22.md`（Batch 2）
**用途**: 優先級排序 + 修復工程量估算 + Batch 4 PoC 候選 + 等 user 決策清單

---

## 去重合併

| 原條目 | 合併去向 | 理由 |
|---|---|---|
| B1-H2（`shift_types` 4 RPC 裸 anon） | **P1（特例）** | 具體案例 |
| B2-S1（敏感 RPC 無後端身份驗證） | **P1（一般化）** | 根因相同：RPC 層缺 `auth.uid()` + role check |
| B1-H3（payroll state 切公司未清，未親驗） | **P5** | 同議題 |
| B2「H3 補驗」（親驗確認） | **P5** | 同議題 |

**不合併**：
- B1-M1（`quick_check_in` 依賴 line_user_id）vs B2-S3（並行打卡 race）— 都在 069 RPC，但不同議題
- B1-H1（line_user_id 全局 UNIQUE）為**架構決策**，不與其他合併

---

## 🔥 最優先（必修）

| 代號 | 原代號 | 標題 | 嚴重度 | 工程量 | 估 commits | PoC 難度 | 親驗 |
|---|---|---|---|---|---|---|---|
| **P1** | B1-H2 + B2-S1 | 敏感 RPC 無後端身份驗證（含 `shift_types` 4 支、其他 SECURITY DEFINER RPC） | 🔴 anon 可讀寫他家資料 | 中 — 需改 N 支 RPC，加 auth.uid + employee role 檢查 | 3-5（按 RPC 群分批） | ✅ 極簡（curl + anon key） | ✅ |
| **P2** | B2-S2 | `updateAdjustment` 無負數/上限/NULL 檢查 → 可誤發負薪或天價 | 🔴 財務直接風險 | 小 — 1 個函式加 `if (val < 0 \|\| val > MAX)` | 1 | ✅ 純前端 demo | ✅ |
| **P3** | B2-S4 | `Promise.all` 只檢 empRes.error → silent 漏資料 | 🔴 獎金數字錯但 UI 看不出 | 小 — 改 `Promise.allSettled` + 每 res 檢查 | 1 | ⚠️ 需模擬 query 失敗 | ✅ |

### P1 修復順序建議
1. 先修 `shift_types` 4 RPC（B1-H2 具體版）— 範圍明確，可當模板
2. 再全面 audit 所有 `SECURITY DEFINER + GRANT anon` 的 RPC（B2-S1 一般化）
3. 建立統一 helper：`IF NOT is_caller_admin_of(p_company_id) THEN RAISE EXCEPTION '...'; END IF;`

---

## ⚠️ 次優先（應修）

| 代號 | 原代號 | 標題 | 嚴重度 | 工程量 | 估 commits | 親驗 |
|---|---|---|---|---|---|---|
| **P4** | B2-S7 | `baseSalary = salaryMap[emp.id] \|\| 0` 無警告 → 新員工漏發靜默 | 🟠 | 小 — 顯式 `if (!ss) return { warning: '未設薪資' }` | 1 | ✅ |
| **P5** | B1-H3 + B2 補驗 | `switchCompanyAdmin` 未清 payroll/bonus 7 個全域變數 → UI 殘影 + 調整值殘留 | 🟠 | 中 — payroll.js 加 clearState + auth.js 呼叫 | 2 | ✅ |
| **P6** | B2-S3 | 並行打卡 race（2 裝置同時上班 → UNIQUE 衝突處理可能誤判） | 🔴 推論 | 視 PoC 結果 | 0-3 | ⏳ 待 PoC |
| **P7** | B2-S5 | `onclick` 字串拼接 XSS pattern（UUID 實務安全，pattern 危險） | 🟠 中信心 | 中 — 統一 `data-*` + `addEventListener` | 2-3 | ⏳ 部分 |
| **P8** | B2-S6 | `toISOString()` / 時區邊界 — 跨時區用戶日期差 | 🟠 推論 | 小 — 統一 `toLocaleString('sv-SE', { timeZone: 'Asia/Taipei' })` | 1 | ⏳ 未親驗 |

---

## 🟢 觀察項（目前不修）

| 代號 | 原代號 | 標題 | 狀態 |
|---|---|---|---|
| O1 | B1-M1 | `quick_check_in` line_user_id LIMIT 1 依賴 | UNIQUE 擋住，安全；H1 修改時一併配套 |
| O2 | B1-M2 | 平台管理員 UI 邊界 | 前端被破解後的漏洞，降級觀察 |
| O3 | B1-L1 | settings cache key 不含 company_id | `switchCompanyAdmin` 有清，已緩解 |
| O4 | B2-S8 | `new Date("YYYY-MM-DD")` UTC 00:00 陷阱 | 需全 grep 確認一致性，暫不修 |
| O5 | B2-S9 | `onclick` index 數字拼接 | forEach 安全，pattern 不嚴謹而已 |
| O6 | B2-S10 | RECORD NULL 陷阱 | `migrations/032` 系列已修完 |

---

## ✅ 本次審查確認安全的

1. **`get_company_monthly_attendance` RPC**（`migrations/043, 059:156-172`）— 逐日 generate_series + `e.company_id = p_company_id` + 員工層級子查詢，無 JOIN 跨公司漏洞
2. **`submit_leave_request` RPC**（`migrations/048`）— 透過 `line_user_id` 取員工 ID → 寫入自動隸屬正確公司
3. **RLS 架構選擇** — 大部分表 RLS 啟用但 policy allow-all，真正保護靠 SECURITY DEFINER RPC（架構設計非漏洞，但需注意 RPC 層嚴謹度 → P1 要解這個）
4. **`escapeHTML()` 使用廣度** — grep >40 處使用，用戶輸入（name/title/description）大部分包裝
5. **`quick_check_in` GPS 驗證 + UNIQUE constraint** — 基本設計完整（雖有 P6 race 疑慮）
6. **`platform_admin_companies` 關聯** — `checkAdminPermission` 正確綁定平台管理員 → 可管理公司列表

---

## 🧪 Batch 4 PoC 候選（按可行性排序）

| PoC # | 目標 | 方式 | 預估時間 | 破壞性 |
|---|---|---|---|---|
| **PoC-1** | **P1** `shift_types` 可被 anon 存取 | `curl -X POST` + anon key 呼叫 `get_company_shift_types(p_company_id)` 打對手公司 UUID | 5 min | 零（SELECT 不寫入） |
| **PoC-2** | **P2** `updateAdjustment` 接受負數 | 純前端 console 呼叫 + 截圖 UI 顯示負獎金 | 5 min | 零（不按發放就不寫 DB） |
| **PoC-3** | **P3** `Promise.all` silent error | Supabase client override + mock `leaveRes.error` | 15 min | 零（只影響 local state） |
| **PoC-4** | **P6** 並行打卡 race | 開 2 個 Supabase client 同時 rpc('quick_check_in') | 30-60 min | **低但非零** — 寫 attendance 表（需測試帳號） |

PoC-1/2/3 可執行（純 recon），PoC-4 會寫 DB 需 **L2 授權**。

---

## 🎯 等 User 決策（Batch 3 產出的 3 項）

### D1 — `attendance_public.html` URL 可竄改（B1-H4）
**現況**：`?company=<uuid>` 只驗公司存在，任何人知道 UUID 就能看
**問**：是 **feature**（anyone with link，公開給會計/合作夥伴）還是 **bug**（只給自家）？
- 若 feature → 無需修，在文件明示「public link」設計
- 若 bug → 加 LIFF 登入 or HMAC-signed access_token URL 參數

### D2 — `employees.line_user_id` 全局 UNIQUE（B1-H1）
**現況**：`migrations/001:36` 是 `UNIQUE`（非 `(company_id, line_user_id)` 複合）
**問**：要不要破壞性 migration 改複合鍵？
- 若要改 → 需改 migration + 所有 RPC 同步改用 `(company_id, line_user_id)` 查詢，約 5-8 commits
- 若不改 → 接受「單人單公司」限制，文件化

### D3 — Batch 4 PoC 範圍
**問**：要做哪幾個 PoC？
- PoC-1/2/3（純 recon，無 DB 寫入）建議都做 — 產出 `tests/poc/*.js`
- PoC-4（並行打卡，會寫測試帳號 attendance）— **需你明確 L2 授權**

---

## 📊 彙總數字

| 分類 | 數量 |
|---|---|
| 🔴 最優先（必修） | 3（P1/P2/P3） |
| 🟠 次優先（應修） | 5（P4-P8） |
| 🟢 觀察項 | 6（O1-O6） |
| ✅ 確認安全 | 6 |
| 🎯 等 user 決策 | 3（D1/D2/D3） |
| 🧪 Batch 4 PoC 候選 | 4（PoC-1/2/3 純 recon · PoC-4 需 L2） |

---

## 📎 建議修復順序（若你授權）

**Sprint A**（小改動、影響大、1-2 commit）：
1. P2 `updateAdjustment` 加輸入驗證 — 1 行改動
2. P3 `Promise.all` → `allSettled` — 1 函式改動

**Sprint B**（中改動、關鍵保護、3-5 commit）：
3. P1 `shift_types` 4 RPC 加 `auth.uid()` 驗證 — 先做這 4 支當模板
4. P1 其他 SECURITY DEFINER RPC 全面 audit
5. P4 `baseSalary` NULL 警告

**Sprint C**（中-大改動、UX/架構）：
6. P5 `switchCompanyAdmin` 加 clearState
7. P7 onclick 字串拼接重構（可拖後）
8. P8 時區統一（需 grep 全 repo）

**Sprint D**（決策驅動）：
- D2 若選複合鍵 → migration + 配套改 5-8 RPC

---

**彙總完成。下一步 Batch 4 PoC 視你 D3 回答。**
