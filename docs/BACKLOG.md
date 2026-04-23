# RunPiston Backlog

**更新**: 2026-04-23
**來源**: 2026-04-22 Audit (Batch 1-5) · Sprint X 規劃 · tests/poc/BACKLOG · grep TODO 結果

---

## 🔥 待 User L2 授權的修復（建議由小到大順序執行）

| 順序 | 項目 | 預估 commits | 嚴重度 | 完整細節 |
|---|---|---|---|---|
| 1 | **P2** `updateAdjustment` 輸入驗證（負數/上限/NULL） | 1 | 🔴 | `reports/audit_summary_2026-04-22.md` · `tests/poc/poc2_bonus_negative.md` |
| 2 | **P3** `Promise.all` → `allSettled`（修 silent error） | 1 | 🔴 | `tests/poc/poc3_promise_all_silent.md` |
| 3 | **P4** `baseSalary NULL` 警告 | 1 | 🟠 | `audit_summary_2026-04-22.md` §P4 |
| 4 | **P1** `shift_types` 4 RPC 加身份驗證（+其他 SECURITY DEFINER 稽核） | 3-5 | 🔴 | `reports/multi_tenant_audit_2026-04-22.md` §H2 · `tests/poc/poc1_shift_types_anon.mjs` |
| 5 | **D1** `attendance_public.html` LIFF 登入 + 公司匹配驗證 | 2-3 | 🔴 | `audit_summary_2026-04-22.md` §D1 |
| 6 | **P5** `switchCompanyAdmin` clearState 清 payroll/bonus 全域變數 | 2-3 | 🟠 | `logic_security_audit_2026-04-22.md` §H3 補驗 |
| 7 | **Sprint X** `platform.html` 平台管理員自助 UI（新 RPC + 表單 + 呼叫） | 4 | 🟢 便民 | `audit_summary_2026-04-22.md` §Sprint X |
| 8 | **P7** onclick 字串拼接重構 → `data-*` + addEventListener | 2-3 | 🟠 pattern | `logic_security_audit_2026-04-22.md` §S5 |
| 9 | **P8** 時區統一 `toLocaleString('sv-SE', { timeZone: 'Asia/Taipei' })` | 1 | 🟠 推論 | `logic_security_audit_2026-04-22.md` §S6 |

### 2026-04-23 Feature Gap Audit 新增（B / F 系列）
| 順序 | 項目 | 預估 commits | 嚴重度 | 完整細節 |
|---|---|---|---|---|
| 10 | **B1 / F1-S1** 請假 date input 加 min/max 限制 | 1 | 🟠 | `reports/feature_gap_employee_2026-04-23.md` + summary |
| 11 | **B2 / F2-SR1** 跨月請假查詢 + calc 修正（薪資誤算） | 2-3 | 🔴 財務 | `reports/feature_gap_admin_2026-04-23.md` + summary |
| 12 | **F2-P2** 排班 upsert 加 confirm dialog（覆蓋既有排班提示） | 1 | 🟡 | `feature_gap_admin_2026-04-23.md` 親驗 |
| 13 | **F2-P3** 公告 `expire_at` 設過去日期時警告 | 1 | 🟡 | `feature_gap_admin_2026-04-23.md` |

### 🕓 Agent 推論待親驗（修前必驗 — 不可直接動手）
- **F1-S2** 補卡日期 min / **F1-S3** 加班時數 JS 驗 / **F1-I3** GPS fail fallback / **F1-I4** 便當截止 popup 重檢
- **F2-I1** AI 菜單按鈕卡 disabled（疑似同 F2-S1 誤判）/ **F2-I2** 離職員工薪資邊界 / **F2-I3** 批次計算原子性 / **F2-I4** 審核人離職鏈斷

**執行前請告訴我要做哪一項**（GUARDRAILS §3 L2 規範：DB 寫入/破壞性/跨 >8 檔 需明確授權）

---

## 📝 未定案 / 待決策

| 議題 | 現況 | 何時再決定 |
|---|---|---|
| **H1** `employees.line_user_id` 是否改複合鍵 | User D2 答：**維持現況**（員工不兼差多家） | 若未來真有員工兼差需求才重啟 |
| **H4** `attendance_public.html` URL 是否為 feature | User D1 答：**是 bug**（已納入修復清單 #5） | — |
| **P6** 並行打卡 race | code review 降級為「理論存在實務不觸發」 | 若日後發現實際工時異常再啟 PoC-4 實測 |

---

## 🧪 PoC Backlog（來自 `tests/poc/BACKLOG.md`）

| PoC # | 目標 | 狀態 | 授權級別 |
|---|---|---|---|
| PoC-4 | 並行打卡 race 實測 | ❌ 不做（已由 poc5 code review 替代） | L2（寫 attendance） |
| PoC-6 | `shift_types` anon 寫入（create/update/delete）實測 | 🕓 待決定 | L2（寫 shift_types） |
| PoC-7 | `switchCompanyAdmin` state 殘留 E2E 觀察 | 🕓 Optional | L1（純前端 DevTools） |
| PoC-8 | `baseSalary NULL` 無警告實測 | 🕓 可由 code review 替代 | L2（建測試員工） |

---

## 🔍 grep TODO/FIXME/HACK/XXX 結果

**全 repo 零筆** ✅

檢查範圍：`*.js`（含 `common.js`、`modules/*.js`）、`*.html`、`*.sql`、`*.sh`
結論：code 無堆積技術債註釋，品質管控佳。

---

## 🎯 已決策待執行 / 已完成項目

### 2026-04-22 完成
- ✅ 月度明細月曆化（`cd3a6e3`）
- ✅ B13 公務機/免打卡員工薪資排除（`471f284`）
- ✅ B14 薪資 `expected_days` 對齊月度 RPC（`be7c42f`）
- ✅ gitleaks pre-commit hook 建置
- ✅ `AUTONOMOUS_24H_GUARDRAILS.md` 規範建檔

### 2026-04-22 ~ 23 Audit sprint（純 docs 無 code 改動）
- ✅ Batch 1 多租戶審查（`630f084`）
- ✅ Batch 2 邏輯/安全審查 + H3 補驗（`c5de29c`）
- ✅ Batch 3 彙總（`7bae107`）
- ✅ Batch 4 PoC 5 檔（`b9b2d94`）
- ✅ User D1/D2/D3 決策落檔（`e5f36e5`）
- ✅ Sprint X 規劃落檔（`b6c80c5`）
- ✅ Batch 5 BUG_TRACKER 更新（`d4d0b6c`）

---

## 📖 延伸閱讀

- 完整審查報告：`reports/audit_summary_2026-04-22.md`
- 多租戶細節：`reports/multi_tenant_audit_2026-04-22.md`
- 邏輯/安全細節：`reports/logic_security_audit_2026-04-22.md`
- PoC 檔案：`tests/poc/poc1_shift_types_anon.mjs`、`poc2/poc3/poc5*.md`、`BACKLOG.md`
- Bug 追蹤：`docs/BUG_TRACKER.md`
- Autonomous 規範：`docs/AUTONOMOUS_24H_GUARDRAILS.md`
