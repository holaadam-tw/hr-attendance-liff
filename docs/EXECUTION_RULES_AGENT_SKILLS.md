# RunPiston HR AI Agent 正式執行守則

> Appendix A to `docs/AI_AGENT_MASTER_RULES.md`
> Role: workflow and delivery discipline
> Status: 正式守則版 / Claude / Codex 共用版

**Version:** v1
**Date:** 2026-04-24
**Purpose:** 將 `addyosmani/agent-skills` 的核心方法，轉成本專案（hr-attendance-liff-git）的正式工作守則，作為 AI agent 在本 repo 內執行分析、修改、驗證與交付時的共同規範。
**Applies to:** Claude Code、Codex、以及其他會直接讀寫本 repo 的 AI coding agent。
**Authority:** 本文件為 Appendix A，負責定義工作流程、交付紀律、驗證習慣與提交原則；若與 `docs/AI_AGENT_MASTER_RULES.md` 或 `docs/AUTONOMOUS_24H_GUARDRAILS.md` 衝突，以較高優先級文件為準。

---

## 0. 文件定位

1. **正式守則版** — 這不是筆記或草稿，是專案層級的正式規範。
2. **Claude / Codex 共用版** — 不依賴單一 agent 的私有習慣。
3. **方法論附錄** — 回答「應該怎麼做事」；授權邊界與 runtime 風險控制以 master rules 與 guardrails 為準。

---

## 1. 核心原則

1. **先定義，再寫碼。** 需求、範圍、限制、驗證方式未清楚前，不直接展開大改。
2. **小步前進，不一次重構全世界。** 每次只做一個可驗證的小切片。
3. **驗證不是加分項，是完成條件。** 沒有 `qa_check.sh` 綠、`npm test` 通過、logic walkthrough 證據，不算完成。
4. **以現場事實為準。** 以目前 code、git 狀態、log、文件、Supabase 查詢結果為準，不憑記憶腦補。
5. **安全優先於速度。** 涉及 SQL、多租戶、RLS、認證、刪除、部署時，先收斂風險再求快。
6. **可回退比聰明更重要。** 任何修改都要能切分、定位、驗證、回退。

---

## 2. 標準工作流程

所有非極小修改，原則上依照以下順序執行：

1. **Spec** — 先確認目標、範圍、非目標、風險、完成條件。
2. **Plan** — 拆成 1 個以上可獨立驗證的小步驟，先做低風險入口。
3. **Build** — 只做單一意圖的修改，避免 bug fix / 重構 / 格式化混改。
4. **Verify** — 跑 `qa_check.sh`、`npm test`、logic walkthrough、前端頁面手驗或 Supabase 查詢對照。
5. **Review** — 檢查是否引入回歸、多租戶洩漏、RLS 破口、未覆蓋分支、過大 diff。
6. **Ship** — 整理 commit，`git push origin dev`（不動 main）；未經明確要求不部署。

---

## 3. Spec 規則

開始工作前，agent 必須先對齊以下 6 件事：

1. **目標** — 這次要修什麼、做什麼、驗證什麼。
2. **範圍** — 哪些頁面（admin.html / index.html / services.html / booking_service.html ...）、哪些模組（`modules/*.js`）、哪些資料表在 scope 內。
3. **非目標** — 哪些已知問題這次不處理，避免 scope creep。
4. **風險** — 多租戶洩漏、RLS 破口、SQL injection、資料寫入、LIFF 認證副作用、GitHub Pages 部署影響、相依流程（打卡 / 排班 / 請假 / 薪資）。
5. **完成條件** — 例如 `bash scripts/qa_check.sh` 0 FAIL、`npm test` 53 通過、特定頁面 LIFF 開啟正常、特定 RPC 路徑驗證、多租戶資料隔離驗證。
6. **停損點** — 一旦碰到 L2 深水區（改 RLS、改 migration、改 auth）、規格矛盾、未知副作用，先停下來回報，不硬推。

---

## 4. Plan 規則

1. 優先拆成 **小而可驗證** 的 task。
2. 一個 task 只處理一類問題。
3. 先做 entry-level、低風險、容易驗證的部分。
4. 每一批修改都要有對應驗證方法。
5. 跨多檔、多層、多責任的改動，必須分批，不一次提交巨大 diff。

---

## 5. Build 規則

1. **單一意圖修改** — 一次只做一個 bug fix、一段查詢 refactor、或一個明確功能切片。
2. **優先保守改法** — 先選最小可行修改，避免不必要的架構翻新。
3. **禁止混改** — 不把功能、重構、格式整理、文件大補一起塞進同一批。
4. **保留 rollback 能力** — 修改要可定位、可切割、可逆。
5. **遇到使用者輸入、Supabase 查詢、LIFF 認證、刪除邏輯時自動提高警戒** — 主動檢查多租戶 filter、RLS 表直寫、injection、條件遺漏、誤刪、越權、空值路徑。
6. **不覆寫未知變更** — 發現 user 或其他 agent 的未提交內容時，不自行回退、不擅自整理。
7. **全域變數紀律** — 跨檔案共用必須掛 `window.`；common.js 頂層 `let` 宣告的變數（如 `currentCompanyId`）不會自動掛 window，同檔案內直接用變數名。
8. **時區紀律** — 所有 `toLocale*` 必須加 `timeZone: 'Asia/Taipei'`；禁止對 DB 時間用 `getHours/getMinutes`（時區陷阱）。

---

## 6. Verify 規則

任何程式修改完成後，至少做出與風險相稱的驗證：

### 6.1 必跑命令（每次 code change）

```bash
bash scripts/qa_check.sh    # 必須 0 FAIL
npm test                    # 必須 53 通過
```

若 hook `.claude/hooks/check-rls-bypass.sh` 或 `.claude/hooks/check-multitenant.sh` 在 Edit / Write 後跳警告，**必須立即檢查**，新警告必須修正。

### 6.2 行為驗證

- 對 user-visible bug，至少驗證原本壞掉的流程確實恢復。
- 前端無法 bash 執行的（LIFF 頁面、瀏覽器頁面），改用 **code review + logic walkthrough** 替代，並明講「未實機驗證」。

### 6.3 回歸測試清單（見 CLAUDE.md §回歸測試清單）

依「修改影響範圍對照表」決定要驗證哪些頁面：

| 修改檔案 | 必須測試的頁面 |
|---------|--------------|
| common.js | 所有頁面 |
| modules/auth.js | admin.html / platform.html / index.html |
| modules/store.js | booking.html / booking_service.html / order.html |
| modules/leave.js | records.html / services.html |
| modules/payroll.js | salary.html / admin.html |

### 6.4 多租戶驗證

改查詢後必須至少驗一次：
- [ ] 本米資料不會出現在大正科技
- [ ] 大正科技資料不會出現在本米

### 6.5 副作用驗證

針對 Supabase 寫入流程，檢查是否多寫、漏寫、誤寫；針對刪除流程，檢查 cascade 與 orphan。

### 6.6 證據化

最後回報時要說清楚：
- 跑了什麼命令
- 哪些通過 / 哪些 fail / 哪些沒跑
- 哪些仍有風險

**無法驗證必須明講「未驗證」，不能以「看起來合理」代替。**

---

## 7. Review 規則

提交前，至少做以下 5 軸檢查：

1. **Correctness** — 是否真的修到目標問題。
2. **Regression** — 是否破壞既有流程（對照 CLAUDE.md §回歸測試清單）。
3. **Security** — 是否引入多租戶洩漏、RLS 破口、SQL injection、權限提升、secret 洩漏風險。
4. **Maintainability** — 是否讓程式更難讀、更難測、更難接手。
5. **Scope discipline** — 這次修改是否超出原先任務。

若 diff 明顯過大（> 8 檔或 > 300 行）、混雜、難回退，應拆分而非硬送。

---

## 8. Git 與提交規則

1. **Atomic commit** — 每個 commit 單一目的、可獨立理解、可單獨回退。
2. **Commit 前先驗證** — `qa_check.sh` + `npm test` 綠後再 commit。
3. **Dev 分支開發** — 所有變更先在 `dev` 分支；`git push origin dev` 後由使用者手動合併 main。**絕對禁止直接改 main**。
4. **不自動 push main / 不自動 deploy** — 除非使用者明確要求。
5. **不做破壞性 git 操作** — 未經同意，不做 `reset --hard`、強制覆蓋、回退他人變更。
6. **Dirty tree awareness** — 若工作樹本來就髒，agent 只能處理與本次任務直接相關的部分。
7. **Commit 訊息必含** — 改了什麼、為什麼、測試了什麼。不可只寫「fix bug」。使用繁體中文。

---

## 9. 安全規則

以下情境視為高風險區，必須特別保守：

1. 多租戶 `company_id` filter 組裝（無 filter SELECT 等同 production 洩漏事件）
2. RLS 表（attendance / makeup_punch_requests / overtime_requests / leave_requests / schedules）直接寫入 — **必須用 SECURITY DEFINER RPC**
3. 使用者輸入直接進 Supabase 查詢、filter、或 URL 參數
4. 認證、授權、角色判斷（platform_admin / admin / manager / user）
5. `viewAsEmployee` 切換下的權限流程
6. 刪除、批次更新、資料搬移
7. LIFF ID、Supabase key、OAuth secrets、connection strings
8. GitHub Pages 部署（來源 main 分支）

高風險修改需要：

1. 明確說明風險點
2. 優先採最小修改
3. 補對應驗證（含多租戶驗證）
4. 無把握時先停下來確認
5. 改動 ≥ 3 檔或涉及 RLS / RPC / 多租戶時，commit 前派 `@rls-checker`

---

## 10. RunPiston HR 專案專用補充規則

1. **遵守既有 sprint / OpenSpec 紀律** — 以 `openspec/changes/*`、`openspec/specs/*`、`docs/BUG_TRACKER.md`、`docs/BACKLOG.md` 為現場真相來源。
2. **先讀 CLAUDE.md 再動任務** — 本 repo 的強制規則、核心檔案職責、回歸測試清單都在 `CLAUDE.md`。
3. **L1 優先，L2 慎入** — 先做 entry-level、低風險修改；碰到改 migration / 改 RLS policy / 改 auth 先停。
4. **user-visible bug 優先驗證實際流程** — 尤其打卡（checkin.html + LIFF）、排班、請假、補打卡、加班申請、薪資計算。
5. **文件與程式同等重要** — 重大決策、scope lock、close criteria 要同步更新 `docs/BUG_TRACKER.md`、`.claude/memory/architecture.md`、`SKILL.md`（若功能架構改變）。
6. **設定快取紀律** — 改設定後必須 `invalidateSettingsCache()` + `loadSettings(true)`；`feature_visibility` 不可進 sessionStorage。

---

## 11. 禁止合理化

以下說法一律不接受：

1. 「這應該沒問題，先不測。」
2. 「順手把別的也一起改了。」
3. 「這看起來像同一類，就整包重構。」
4. 「雖然 qa_check.sh 沒跑，但理論上會過。」
5. 「先 push 再說，出事再修。」
6. 「這些未提交變更我先幫你整理掉。」
7. 「company_id filter 這筆應該是內部查詢，不用加。」（多租戶禁忌）
8. 「直接 UPDATE attendance 就好，不用走 RPC。」（RLS 禁忌）

---

## 12. Agent 回報格式

每次完成一輪工作，至少要交代：

1. 做了什麼
2. 改了哪些檔案
3. 怎麼驗證（含 `qa_check.sh` 結果、`npm test` 結果、logic walkthrough）
4. 還有什麼風險或未完成項目
5. 下一步建議是什麼

---

## 13. 本規則的實際使用方式

未來只要對 agent 說：

`請依照 docs/AI_AGENT_MASTER_RULES.md 執行。`

即表示：

1. 先對齊 spec 與範圍
2. 小步修改
3. 先驗證再交付（qa_check + npm test）
4. 不偷擴 scope
5. 不做未授權 push main / deploy / destructive git

若要明確指定本文件也一併生效：

`請依照 docs/AI_AGENT_MASTER_RULES.md 與 docs/EXECUTION_RULES_AGENT_SKILLS.md 執行。`

這句話在實務上表示：

1. 這次工作要遵守 master rules 的優先級與風險邊界
2. Claude 與 Codex 都要用同一套 Spec / Plan / Build / Verify / Review / Ship 節奏
3. 驗證、回報、提交、回退能力都必須納入完成條件

---

## Sources

- `addyosmani/agent-skills` README — development lifecycle commands、skills、verification-first design、anti-rationalization、workflow structure
  https://github.com/addyosmani/agent-skills
