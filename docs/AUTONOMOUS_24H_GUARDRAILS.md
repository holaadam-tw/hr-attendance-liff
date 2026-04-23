# AUTONOMOUS_24H_GUARDRAILS.md

## 0) 目標
24 小時自動模式下，最大化產出、最小化越線風險。

---

## 1) 絕對禁止（Hard Block）
- 禁止任何 production DB 寫入（INSERT/UPDATE/DELETE/DDL）
- 禁止 deploy（Supabase functions / production）
- 禁止改 secrets / env / vault / RLS
- 禁止 git push main / merge main
- 禁止「聲稱完成但無證據」

---

## 2) 允許範圍（L1）
- SELECT / grep / read-only recon
- 文件新增與整理
- 測試腳本新增（不觸發寫入）
- 非破壞性 code scaffolding（需可回滾）

---

## 3) 需明確授權（L2）
- 任何 DB 寫入（即使 dev）
- 破壞性操作（刪除、資料修正）
- 大面積重構（>8 檔案或 >300 行）

---

## 4) 進度心跳（每 90 分鐘）
固定回報：
1. 現在做什麼（1 行）
2. 目前改了哪些檔
3. 風險等級（低/中/高）
4. 下一步
5. 阻塞（若有）

---

## 5) Commit 規範
每個 commit 必須：
- 單一目的（One commit, one intent）
- 附測試結果
- 附 rollback 一句話

若超過 300 行或 8 檔案：先停下來回報再繼續。

---

## 6) 測試門檻（每次改 code）
- 必跑 build
- 必跑核心 smoke
- 任一 fail：不得 commit，先修或回報

---

## 7) 證據規範（防幻覺）
凡「已完成」必附：
- `git show --name-only --oneline -1`
- 測試命令與結果
- 若涉及 DB：前後對照（row count 或關鍵列）

推論必標 `[推論]`，不得寫成事實。

---

## 8) 自動收尾條件
觸發任一即停止改 code，轉收尾：
- 連續 2 次測試 fail
- 連續 2 小時高風險改動
- 回報出現矛盾或重複失誤

收尾輸出：
- done / not done / blocked
- 下次第一步
- 風險清單
- rollback 提示

---

## 9) 啟動語句（每次 session 開頭）
「遵守 AUTONOMOUS_24H_GUARDRAILS.md。
未經明確授權，不做任何 DB 寫入與 deploy。
每 90 分鐘固定心跳回報。」

---

## 10) 失誤紀錄與規則強化（2026-04-23 事件驅動）

### 10.1 Turn 中斷失誤防護

**事件**：2026-04-23 00:51 Batch 3 firing，讀完兩份 report 後僅輸出文字分析，未 Write 檔案、未 ScheduleWakeup，turn 結束 → 循環斷 6 小時才被 user 察覺。

**根因**：無「本 turn 必有 commit」硬檢查；純文字輸出後 turn 自然結束。

**規則**：
- 每個 batch 醒來後，**若非 Closeout**，本 turn 必須：
  (a) 至少一個 Write / Edit 產生檔案變動
  (b) 至少一個 commit（即使 docs-only）
  (c) 結束前呼叫 ScheduleWakeup（或明確宣告 §8 closeout 不再 wakeup）
- 任一條件缺失 → 視為 **turn 中斷失誤**，應立即改交 §8 closeout 報告，而非靜默終止
- 若讀了大量 context（如多份 report）後只想「分析不動手」→ 應在 heartbeat 明說「本 batch 只分析不落檔」並交 §8 提前收尾，讓 user 裁決

### 10.2 Stale wakeup 並存處理

**事件**：2026-04-23 08:43 排 1800s wakeup（Batch 5）、08:55 改 270s 超車 → 09:13 舊 wakeup 仍照 firing，帶 stale Batch 5 prompt。

**已證偽的假設**：「新 ScheduleWakeup 會 override 舊的」— **錯**，兩者並存不互斥。

**規則**：
- 同時段可能有多個 wakeup 並存 firing
- 改節奏（長→短）超車執行後，**必須接受舊 wakeup 仍會 firing**
- 醒來第一步 `git log --oneline -5` 驗本 batch prompt 對應工作是否已完成：
  - 已完成 → 不重做，只寫 heartbeat 說明「stale wakeup 已察覺」，**不觸發新 wakeup**（避免雪球），靜置
  - 未完成 → 正常執行
- 未來若 Claude Code runtime 提供 `CronDelete` 類工具 → 改節奏時優先清舊排程
- 為避免 stale 累積：**不要在短時間內連續改 wakeup 間隔**

### 10.3 Agent 輸出覆驗強化

**事件**：Batch 2 Explore agent 報告日期誤寫「2026-04-23」（實際 04-22）；引用 `migrations/032` 討論 race（實際最新 `migrations/069`）。

**規則**（派 Explore agent 時寫進 prompt）：
- 「用 `date` 指令取系統時間，不要推算日期」
- 「引用 migration 前先 `ls migrations/` 找最新版本號再讀」
- Agent 回報**關鍵結論**（影響修復決策 / 嚴重度）必親驗 ≥ 3 項（對齊 `claude_code_analysis_checklist.md` Q4 硬規則）

### 10.4 每輪結束檢討
- Batch 7 Closeout 後建議 user 提問「本輪是否有異常」 → Claude 誠實自查並列出
- 若發現可強化規則 → 更新 §10（不擴大其他節），保留歷史脈絡
