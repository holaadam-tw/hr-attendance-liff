# 管理員端功能缺陷審查（Batch F2）

**日期**: 2026-04-23
**範圍**: admin.html / platform.html / modules/(payroll/schedules/leave/employees/auth/settings/audit/store).js
**方法**: Explore agent 7 類缺陷掃描 + **3 項親驗**
**焦點**: 功能缺陷（非前輪已記錄的 P1-P8 / D1 / F1-S1~F3 / B13/B14/月曆化）

---

## ⚠️ 本次 Agent 親驗失準率：3/3 有問題（**比 F1 更糟**）

| 原代號 | Agent 結論 | 親驗結果 |
|---|---|---|
| **F2-S1** | 薪資批次儲存按鈕卡 disabled（無 finally） | ❌ **全面誤判**：`modules/payroll.js:450` 明確有 `finally { btn.disabled = false; btn.textContent = origText; }` |
| **F2-M4** | 排班衝突未提示 | ⚠️ **方向對但嚴重度過高**：`modules/schedules.js:228` `.upsert(..., { onConflict: 'employee_id,date' })` 是**有意的覆蓋設計**（員工當天改排班），非 bug；問題僅在缺「覆蓋確認 UX」 |
| **F2-M2** | 跨月請假查詢漏邊界 | ⚠️ **方向對但修法錯**：`modules/payroll.js:483` `.gte('start_date', startDate).lte('end_date', endDate)` 確實漏「1/30~2/3 跨月請假查 2 月」；但 Agent 建議的 `gte('start_date', endDate)` 邏輯完全反向 |

**教訓（寫入 §10.3 強化）**：
- F1 agent 失準率 2/3，F2 升為 3/3
- Explore agent 對業務邏輯推論能力**普遍不可信**
- 未親驗項一律加 `[Agent 推論，未親驗]` 標籤 + 降級信心

---

## 🔴 嚴重（親驗確認）

### F2-SR1 — 跨月請假查詢漏邊界 `[親驗，修正 Agent F2-M2]`

**檔案**: `modules/payroll.js:483`
```js
sb.from('leave_requests')
  .select('employee_id, days, leave_type, employees!inner(company_id)')
  .eq('status', 'approved')
  .gte('start_date', startDate)    // ← start_date 必須 >= 月初
  .lte('end_date', endDate)         // ← end_date 必須 <= 月底
```

**真實情境**：
- 查 2026-02 薪資 → `startDate = '2026-02-01'`, `endDate = '2026-02-28'`
- 員工請假 `2026-01-30 ~ 2026-02-03`（跨月）
- `start_date = 2026-01-30` **不 >= 2026-02-01** → **整筆被漏**
- 結果：2 月薪資**沒算到 1/30 - 2/3 這段請假**（尤其 2/1-2/3 應在 2 月扣）

**影響**：跨月請假的扣薪/扣勤在「請假起始月」和「結束月」都漏算 → 薪資錯

**正確修法**（非 Agent 的反向建議）：
```js
// 取 leave_requests 若其區間與 [startDate, endDate] 有重疊
.gte('end_date', startDate)      // end_date >= 月初
.lte('start_date', endDate)      // start_date <= 月底
// → 任意日與目標月有交集
```

然後在 JS 端依據交集天數計算（現有 `l.days` 是**整段總天數**，不是落在當月的天數 → 需另改 calc 邏輯）

**信心度**：🔴 高（親驗 + 實際業務情境推導）

**修復方向（一句話）**：改查詢條件為「起訖區間與目標月有交集」，並重新計算該月落入天數

---

## 🟠 重要（Agent 推論，未親驗）

### F2-I1 — AI 菜單匯入按鈕卡 disabled `[Agent 推論，未親驗]`
- **Agent 引用**：`modules/store.js:1441, 1466`
- **Agent 結論**：`btn.disabled = true` 無 `finally` 重置
- **但 F2-S1 同類指控已證偽**（payroll.js 有 finally）→ 本項**可能同類誤判**，必須親驗才信

### F2-I2 — 已離職員工薪資邊界模糊 `[Agent 中信心]`
- **檔案**：`modules/payroll.js:543-546`
- **情境**：員工 3/15 離職，計算 3 月薪資時 code 只判「離職日是否在該月份之前」，未處理「部分月」的薪資比例
- **實際業務影響**：可能整月發全額 or 整月不發，視 code 邏輯 — 需親驗
- **修復方向**：新增「當月離職比例計算」或用政策文件規範

### F2-I3 — 批次計算薪資無原子性 `[Agent 推論]`
- **檔案**：`modules/payroll.js:425-450`
- **情境**：100 員工批次計算，第 50 失敗 → 前 49 已寫入 DB
- **真實性**：取決於 UX 設計意圖（有些系統就是 partial commit 更合理）
- **修復方向**：若要原子性需用 Supabase RPC transaction

### F2-I4 — 審核人離職鏈斷 `[Agent 推論]`
- **檔案**：`modules/leave.js:85`
- **Agent 結論**：主管離職後其待審案件卡 pending
- **真實性**：視公司流程；可能用「部門主管自動重派」或「HR 接管」
- **修復方向**：若有業務需求，加定期 job 檢測 + 自動重派

---

## 🟡 打磨

### F2-P1 — 空資料 UX 無操作提示 `[Agent 自稱親驗]`
- **檔案**：`admin.html:368`
- 顯示「無員工」但無「請先到員工管理新增」CTA

### F2-P2 — 排班 upsert 覆蓋無確認提示 `[親驗修正]`
- **檔案**：`modules/schedules.js:228`
- `.upsert(..., { onConflict: 'employee_id,date' })` 會**靜默覆蓋**既有排班
- **真實業務**：員工當天改班是常見需求（非 bug），但**缺 UX 確認**
- **修復方向**：儲存前若偵測到「某員某日已有非 off_day 排班」→ 彈 confirm「將覆蓋既有排班，是否繼續？」

### F2-P3 — 公告到期日可設過去 `[Agent 高信心，未親驗]`
- **檔案**：`modules/settings.js:119`
- `expire_at` 無驗證，可設 `2020-01-01`
- **修復方向**：加 `if (new Date(expire) < new Date()) showToast('⚠️ 到期日已過')`

---

## 💡 功能建議

### F2-F1 — 缺「複製上月排班」`[Agent 推論]`
- 只有 `copyLastWeek()`，無 copyLastMonth
- **難點**：月份天數差（28/29/30/31），需定義「對應日期」或「對應星期」規則

### F2-F2 — 缺「審核軌跡」查詢頁 `[Agent 推論]`
- `approveLeave()` 有寫 audit log 但無管理員查詢 UI
- **修復方向**：設定頁加「審核歷史」tab

### F2-F3 — 缺「CSV 匯入員工」`[Agent 推論]`
- 僅單個新增
- **修復方向**：員工管理加「📥 匯入 CSV」

---

## ✅ 抽樣確認正常的（Agent 結論，但因 F2 agent 品質差，低信心採信）

- `saveAllSalarySettings` **有** try/finally 重置按鈕（**親驗糾正 F2-S1**）
- `saveSchedule` 用 upsert 覆蓋是**有意設計**（**親驗糾正 F2-M4**）

**建議**：上述兩項結論是親驗出的真相，可 100% 信任。Agent 其他「✅ 抽樣確認」項因品質差不可信。

---

## 📋 F2 彙總

| 分類 | 數量 | 狀態 |
|---|---|---|
| 🔴 親驗確認 | 1（F2-SR1 跨月請假查詢漏邊界）| 可修（需同步改 calc 邏輯） |
| 🟠 Agent 推論未親驗 | 4（I1/I2/I3/I4） | 動手前必親驗 |
| 🟡 打磨 | 3（P1/P2 親驗/P3） | 低優先 |
| 💡 功能建議 | 3（F1/F2/F3） | 取捨 |
| ❌ Agent 誤判 | 1（F2-S1） | 已排除 |
| ⚠️ Agent 嚴重度過高 | 1（F2-M4 降級 P2）| 修正後保留為打磨 |
| ⚠️ Agent 修法錯 | 1（F2-M2 升級 SR1 + 改修法）| 保留漏邊界結論但改修法 |

---

## 🎯 Agent 失準率追蹤

| Batch | 親驗數 | 誤判 | 嚴重度誤 | 方向對但細節錯 | 結論準確 |
|---|---|---|---|---|---|
| F1 | 3 | 2 | 0 | 0 | 1 |
| F2 | 3 | 1 | 1 | 1 | 0 |

**累計**：6 親驗項，**5 項有問題（83%）**，僅 1 項完全準確。

**強烈建議**：後續 batch 若要繼續用 Explore agent，必須：
1. Prompt 進一步加強：「禁止推論修法，若不確定就標 `[不確定]`」
2. 親驗率提升到 **100%**（所有 agent 列的項都要親驗，不能抽樣）
3. 或改用 Grep + Read 自己做審查，agent 僅用於「找可疑 pattern 的檔案」而非「下結論」

---

## 🎯 真正要處理的（F2 親驗後淨值）

| # | 事實 | 嚴重度 | 修復工程量 |
|---|---|---|---|
| **F2-SR1** | 跨月請假查詢漏邊界 → 薪資誤算 | 🔴 | 小改 query + calc（1-2 commits） |
| F2-P2 | 排班 upsert 靜默覆蓋無確認 | 🟡 | 小（加 confirm dialog） |
| F2-P3 | 公告到期可設過去 | 🟡 | 極小（1 行驗證） |
| F2-F1/F2/F3 | 3 個 feature 建議 | — | 新 sprint 級別 |

其餘 Agent 推論項一律需 user 動手修前**單項親驗**。

---

**產出**: 1 親驗確認 🔴（跨月請假）+ 4 未親驗 🟠 + 3 打磨 + 3 功能建議 + **1 誤判 + 2 部分錯誤已糾正**
**下一步**: F3 餐飲功能（或 user 若認為已夠多可跳 F4 彙整）
