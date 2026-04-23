# Feature Gap Audit Summary（Batch F4 彙整）

**日期**: 2026-04-23
**來源**: `reports/feature_gap_employee_2026-04-23.md`（F1）+ `reports/feature_gap_admin_2026-04-23.md`（F2）
**F3 跳過**: Agent 品質差 + 餐飲非核心 HR domain
**方法**: 不派新 agent，純彙整合併 + 去重

---

## 📊 總體數字

| 分類 | F1 員工端 | F2 管理員端 | 合計 |
|---|---|---|---|
| 🔴 真 bug（親驗） | 1 | 1 | **2** |
| 🟠 Agent 推論待親驗 | 4 | 4 | 8 |
| 🟡 打磨項 | 3 | 3 | 6 |
| 💡 功能建議 | 3 | 3 | 6 |
| ❌ Agent 誤判 | 2 | 1 | 3 |
| ⚠️ Agent 需糾正 | 0 | 2 | 2 |

**Agent 失準率**：6 親驗項中 5 有問題 → **83%**（僅 17% 完全準確）

---

## 🔴 真實 Bug 清單（親驗確認，修前需 User L2 授權）

### B1 — F1-S1 請假日期 input 無 min/max `[高信心]`

- **檔案**: `records.html:93-94`
- **現況**:
  ```html
  <input type="date" id="leaveStartDate">
  <input type="date" id="leaveEndDate">
  ```
- **問題**: 無 HTML5 邊界，可選 1900-2099 年任意日期
- **影響**: 使用者可能誤選年份（如 2025 而非 2026）；無前端護欄
- **修復方向**: 加 `min="today-30d"` + `max="today+90d"`（或由 system_settings 配置）+ `onLeaveDateChange()` 補驗
- **估工**: 1 commit（< 10 行）

### B2 — F2-SR1 跨月請假查詢漏邊界 `[高信心]`

- **檔案**: `modules/payroll.js:483`
- **現況**:
  ```js
  .gte('start_date', startDate)    // ← start_date 必須 >= 月初
  .lte('end_date', endDate)         // ← end_date 必須 <= 月底
  ```
- **問題**: 跨月請假完全漏算
  - 查 2 月薪資，員工 1/30~2/3 請假 → `start_date='2026-01-30' !>= '2026-02-01'` → 整筆漏
  - 結果：2 月薪資少扣 3 天（1/30-2/3 有 3 天落在 2 月）
- **正確修法**（非 Agent 的反向建議）:
  ```js
  .gte('end_date', startDate)      // end_date >= 月初
  .lte('start_date', endDate)      // start_date <= 月底
  ```
  然後在 JS 端重新計算該月**落入天數**（`l.days` 是整段總天數，不是當月天數）
- **影響**: 跨月請假的薪資扣除**兩側月份都漏**
- **修復方向**: 改 query + 改 calc（計算區間交集天數）
- **估工**: 2-3 commits（改 query + 改 calc + 測試跨月情境）

---

## 🟠 Agent 推論待親驗（動手修前需親驗 100%）

| 原代號 | 位置 | 推論內容 | 親驗優先級 |
|---|---|---|---|
| F1-S2 | `records.html:117` + `common.js:347` | 補卡日期有 max 無 min | 高 |
| F1-S3 | `records.html:181` submitOvertime | 加班 > 12 無 JS 檢查 | 中 |
| F1-I3 | `checkin.html:164-173, 439-468` | GPS fail 無 fallback（只「我知道了」）| 中 |
| F1-I4 | `checkin.html:527` + `services.html:579` | 便當截止 popup 重檢缺 | 低 |
| **F2-I1** | `modules/store.js:1441, 1466` | AI 菜單按鈕卡 disabled | **高（F2-S1 同類指控已證偽，本項極可能同樣誤判）** |
| F2-I2 | `modules/payroll.js:543-546` | 離職員工薪資邊界模糊（部分月份比例） | 中 |
| F2-I3 | `modules/payroll.js:425-450` | 批次計算薪資無原子性 | 中（但可能是設計選擇） |
| F2-I4 | `modules/leave.js:85` | 審核人離職鏈斷 | 中（業務流程取捨） |

---

## 🟡 打磨項（體驗不佳但不影響主功能）

| 代號 | 位置 | 議題 |
|---|---|---|
| F1-I1 | `common.js:812/906/976` | 空資料 3 種文案（「尚無記錄」/「尚無補打卡」/「尚無加班」）不一致 |
| F1-P2 | `checkin.html:570` | 返回按鈕邏輯不一致（history.back vs href） |
| F1-P3 | `records.html:492-493` | `scrollIntoView({ block:'nearest' })` 小屏可能被導航 bar 遮擋 |
| F2-P1 | `admin.html:368` | 「無員工」顯示無 CTA（應導向員工管理） |
| **F2-P2** | `modules/schedules.js:228` | 排班 upsert **靜默覆蓋**，缺「覆蓋既有排班」confirm 提示 `[親驗]` |
| F2-P3 | `modules/settings.js:119` | 公告 `expire_at` 可設過去日期 |

---

## 💡 功能建議（非 bug，新 sprint 級別）

### 員工端（F1）
- **F1-F1**: 取消 / 撤銷今日打卡（5 分鐘內允許 or 直跳補卡頁）
- **F1-F2**: 請假表單顯示假別剩餘天數（特休 / 病假 / 事假）
- **F1-F3**: 加班時數累計統計卡（本月 / 本年 / 已換補休）

### 管理員端（F2）
- **F2-F1**: 複製上月排班（難點：月份天數差 28/29/30/31）
- **F2-F2**: 審核軌跡查詢頁（audit log 有寫但無 UI）
- **F2-F3**: CSV 匯入員工 batch 入職（目前只有單個）

---

## ⚠️ Agent 失準記錄（寫入本專案知識庫）

### F1 誤判詳情
| 原代號 | Agent 結論 | 親驗事實 |
|---|---|---|
| F1-P1 | schedule.html 空白/未實作 | ❌ 實 533 行 29KB |
| F1-I2 | submit 無 loading 狀態 | ❌ `common.js:751/861/1937` setBtnLoading 都有 |

### F2 誤判詳情
| 原代號 | Agent 結論 | 親驗事實 |
|---|---|---|
| F2-S1 | 薪資按鈕卡 disabled 無 finally | ❌ `payroll.js:450` 明確有 finally |
| F2-M4 | 排班衝突未提示 | ⚠️ upsert 是**有意覆蓋設計**，降級為 F2-P2 打磨 |
| F2-M2 | 跨月請假漏邊界，建議 `gte('start_date', endDate)` | ⚠️ **方向對但修法反向**，升級為 B2 並給正確修法 |

### 未來改進（已寫 `docs/AUTONOMOUS_24H_GUARDRAILS.md §10.3）
1. **派 Explore agent prompt 必須強調「禁止推論修法」** — agent 給結論可以，但修法建議常常錯
2. **親驗率 100%**（不抽樣）— 6 親驗 5 問題證明抽樣無效，必須全驗
3. **或改用 Grep + Read 自己審查** — agent 僅用來找「可疑 pattern 的檔案」而非「下結論」
4. **實務教訓**：Explore agent 對業務邏輯推論能力弱（如 upsert 設計意圖、跨月請假計算），對語法 pattern 抓取還可以

---

## 🎯 User 決策清單（需 L2 授權才動手）

| # | 項目 | 工程量 | 動手前要問 User |
|---|---|---|---|
| 1 | **B1** F1-S1 請假日期 min/max | 1 commit | min/max 範圍值（30 天 / 90 天？由 system_settings 讀？）|
| 2 | **B2** F2-SR1 跨月請假查詢 + calc | 2-3 commits | 確認「跨月請假按日分攤到各月」的業務邏輯 |
| 3 | F2-P2 排班覆蓋 confirm | 1 commit | 確認要加 confirm dialog |
| 4 | F2-P3 公告到期驗證 | 1 commit | 允許「警告繼續」還是「強制擋」|

其他 🟠 推論項需先親驗才能列入修復清單。

---

## 📋 下一步

- **Batch F5 Closeout §8**（270s wakeup 後）— 交出完整 autonomous 輪次報告
- 若 user 醒來要開始修：直接說「修 B1」或「修 B2」
- 若 user 要親驗某項推論：說「親驗 F1-S2」等，我會讀 code 驗證

**F4 彙整完成。未寫任何 code，純文件產出。**
