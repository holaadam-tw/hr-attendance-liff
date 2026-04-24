# RunPiston HR AI Agent Master Rules

**Version:** v1
**Date:** 2026-04-24
**Purpose:** 本 repo（hr-attendance-liff-git）AI agent 的最高優先級政策文件。

---

## Quick Decision Table

1. 要判斷最高優先順序或衝突時，看 `docs/AI_AGENT_MASTER_RULES.md`（本文件）
2. 要判斷能不能做、需不需要授權、何時該停時，看 `docs/AUTONOMOUS_24H_GUARDRAILS.md`
3. 要判斷應該怎麼拆步驟、怎麼驗證、怎麼交付時，看 `docs/EXECUTION_RULES_AGENT_SKILLS.md`
4. 要接續既有工作時，看 `.claude/memory/MEMORY.md`、`.claude/memory/architecture.md`、`docs/BUG_TRACKER.md`、`docs/BACKLOG.md` 與對應的 `openspec/changes/`
5. 規則互相衝突時，優先順序一律是 `Master Rules > Guardrails > Execution Rules > CLAUDE.md > Sprint / OpenSpec 文件`

---

## 1. Rule Hierarchy

所有在本 repo 工作的 AI agent 必須遵守以下優先順序：

1. 本文件：`docs/AI_AGENT_MASTER_RULES.md`
2. Runtime guardrails：`docs/AUTONOMOUS_24H_GUARDRAILS.md`
3. Workflow appendix：`docs/EXECUTION_RULES_AGENT_SKILLS.md`
4. 專案層規則：`CLAUDE.md`（強制規則 + 核心檔案職責 + QA / RLS 檢查機制）
5. OpenSpec SDD 文件：`openspec/project.md`、`openspec/changes/*`、`openspec/specs/*`
6. 當前 session 使用者的直接指示

上位項目衝突時，上位者勝。

---

## 2. What This File Governs

本 master 文件定義：

- AI agent 的預設作業模式
- 動程式前必須檢查什麼
- 哪些工作可以不經額外授權直接做
- 何時該停、該問、該 handover
- 需要 runtime 或 workflow 細節時，去哪個 appendix

本文件刻意簡短；細節機制都放在 appendix。

---

## 3. Default Operating Model

每個非極小任務都應依此順序執行：

1. 先讀當前 repo 狀態（git status / git log / 目標檔案 / 相關 docs）
2. 對齊 scope、風險、完成條件
3. 做出最小合理變更
4. 用 build、smoke、測試或具體證據驗證
5. 回報結果、殘留風險、下一步

Agent 必須偏好小的、可回退的、有證據的變更，而非大規模臆測性重構。

---

## 4. Baseline Rules

所有 agent 必須遵守以下底線：

1. 不得假設。先檢查 codebase、git 狀態、docs、log、執行輸出。
2. 不得無聲擴大 scope。
3. 不得在無驗證證據的情況下宣稱完成。
4. 不得覆蓋或還原與本次任務無關的本地變更（包含 user 未提交的工作樹內容）。
5. 未經明確授權，不得執行破壞性 git 或檔案系統操作（`reset --hard`、`clean -fd`、刪 migration、刪 DB 資料等）。
6. 不得 push、deploy 或接觸外部系統，除非 user 明確要求且 runtime guardrails 允許。
7. 優先做低風險入口，再動深水區。

---

## 5. Runtime Safety

當 agent 實際在執行工作時，`docs/AUTONOMOUS_24H_GUARDRAILS.md` 是 runtime appendix。

它規範：

- Hard block 項目（§1）
- L1 允許範圍（§2）與 L2 明確授權（§3）
- 進度心跳與續跑票據
- 測試門檻
- 證據規範（防幻覺）
- Turn end contract（防 idle 停機）
- Stale wakeup detection（防重複工作）

任何觸及資料、部署、認證、設定、外部副作用的動作，必須先對照本 appendix 檢查。

---

## 6. Workflow Discipline

規劃和實作工作時，`docs/EXECUTION_RULES_AGENT_SKILLS.md` 是 workflow appendix。

它規範：

- Spec → Plan → Build → Verify → Review → Ship
- Atomic commit
- Rollback 意識
- 反合理化規則（禁止「先 push 再說」等）

用該 appendix 回答「怎麼做事」；用 guardrails 回答「現在做這件事安不安全」。

---

## 7. RunPiston HR 專案規則

針對本專案的特別規則：

1. **多租戶強制隔離**：所有 Supabase 查詢必須 `.eq('company_id', window.currentCompanyId)` 或用關聯 filter（employees!inner）或員工自查（`.eq('employee_id', currentEmployee.id)`）。絕對禁止無 filter SELECT。違反即視為 production 安全事件。
2. **RLS 表禁止直接寫入**：`attendance` / `makeup_punch_requests` / `overtime_requests` / `leave_requests` / `schedules` 必須用 SECURITY DEFINER RPC。hook `.claude/hooks/check-rls-bypass.sh` 會自動檢查。
3. **Git 紀律**：所有變更在 `dev` 分支上做。`git push origin dev` 後由使用者手動合併 `main`。**絕對禁止直接改 `main`**。GitHub Pages 從 `main` 自動部署。
4. **優先 L1 入口修復**：對 user-visible bug，先確認實際流程能重現，再動程式。
5. **文件與程式同步**：改動影響 `docs/BUG_TRACKER.md`（功能狀態）、`.claude/memory/architecture.md`（技術決策）、`SKILL.md`（若功能架構變）時，必須同步更新。
6. **複雜任務走 rls-checker**：改動 ≥ 3 個檔案或涉及多租戶 / RLS / RPC 時，commit 前必須派 `@rls-checker` 做最終審查。
7. **OpenSpec SDD**：新功能開發原則上用 `/opsx:propose` 起點，變更提案放 `openspec/changes/`，規格放 `openspec/specs/`。
8. **語言規範**：所有回應、文件、commit 訊息使用繁體中文。

---

## 8. Stop Conditions

Agent 必須停下來回報，而非繼續前進，當：

1. 任務越過 guarded 或高風險區（SQL 寫入、RLS、auth、deploy、secrets）
2. scope 明顯大於原始定義
3. 無法執行必要驗證（qa_check.sh 跑不起來、npm test 跑不了）
4. repo 狀態與假設衝突（例如 working tree 有 user 的未提交變更）
5. 需要 user 授權但尚未取得

**停下來不是失敗。無聲漂移才是失敗。**

---

## 9. Standard Invocation

要套用完整規則集，使用：

`請依照 docs/AI_AGENT_MASTER_RULES.md 執行。`

這代表：

- 用 master rules 作為最上層政策
- 用 runtime guardrails 處理執行安全
- 用 workflow appendix 處理交付紀律
- 遵守 `CLAUDE.md` 的專案強制規則（QA / RLS / Hook / 回歸測試清單）

若要強調 workflow 紀律：

`請依照 docs/AI_AGENT_MASTER_RULES.md 與 docs/EXECUTION_RULES_AGENT_SKILLS.md 執行。`

---

## 10. Appendices

- Appendix A（workflow 與交付紀律）：`docs/EXECUTION_RULES_AGENT_SKILLS.md`
- Appendix B（runtime 執行 guardrails）：`docs/AUTONOMOUS_24H_GUARDRAILS.md`
- Appendix C（專案強制規則 / QA / 回歸測試）：`CLAUDE.md`
- Appendix D（記憶 / 架構 / 決策）：`.claude/memory/MEMORY.md`、`.claude/memory/architecture.md`
- Appendix E（Bug 追蹤 / Backlog）：`docs/BUG_TRACKER.md`、`docs/BACKLOG.md`
- Appendix F（已知危險區）：`docs/DANGER_ZONES.md`
- Appendix G（測試場景）：`docs/TEST_SCENARIOS.md`
