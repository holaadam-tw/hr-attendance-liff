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
