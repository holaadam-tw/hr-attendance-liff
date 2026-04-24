# AUTONOMOUS_24H_GUARDRAILS.md

Version: v2
Updated: 2026-04-24
Scope: 本 repo（hr-attendance-liff-git）之 Claude Code 自動 / 長時間執行模式

> 專案背景：本 repo 為純前端靜態站，部署於 GitHub Pages，後端為 Supabase（PostgreSQL + RLS），認證走 LINE LIFF。所有 user-visible 頁面都是 HTML/CSS/JS，模組化於 `modules/*.js`，共用邏輯在 `common.js`。測試門檻為 `bash scripts/qa_check.sh`（0 FAIL）+ `npm test`（53 通過）。

---

## §0 目標

在 24 小時自動模式下，最大化產出、最小化越線風險，並避免：

- 幻覺式完成回報
- 無聲 idle 停機
- stale wakeup 造成的重複工作
- 未授權的外部副作用（Supabase 寫入、GitHub Pages 部署、push main）

定義：

- **外部副作用**：任何會改變 repo 以外狀態的行為，例如 Supabase DB 寫入（含 dev / staging / production）、git push main、GitHub Pages 部署、LIFF / LINE 官方帳號設定變更、發送 webhook、修改 Supabase secrets / env / RLS policy / migration。
- **未驗證目標**：目前證據不足以 100% 確認是 local / dev / test 的 Supabase schema、branch 或環境。未驗證目標一律視為高風險。

---

## §0.5 Runtime Summary

每次決策先套這 7 條：

1. 命中 §1 → **立即停止並回報**。
2. 命中 §3 → **請求明確授權**。
3. 其餘情況只可做 §2 / L1。
4. 任何 code change → **必跑 §6**。
5. 宣稱完成 → **必附 §7 證據**。
6. 每次 turn 結束前 → **必滿足 §10**。
7. 每次 wakeup 第一動作 → **必做 §12**。

---

## §1 絕對禁止（Hard Block）

以下項目在自動模式中 **不可執行**；命中即停止，等待使用者明確下一步。
**§1 不可被 §3 覆蓋。**

- Supabase production DB 寫入（INSERT / UPDATE / DELETE / UPSERT / DDL / migration apply）
- 對 **未驗證目標** 的任何 DB 寫入
- RLS 表（attendance / makeup_punch_requests / overtime_requests / leave_requests / schedules）直接 SQL 寫入（必須走 SECURITY DEFINER RPC）
- GitHub Pages deploy（含 `git push origin main`、`git merge dev` into main）
- 改 Supabase secrets / env / vault / RLS policy / auth / access control
- 改 LINE LIFF ID / LINE 官方帳號設定
- `git reset --hard`、`git clean -fd`、刪 migration、刪 Supabase 資料、不可逆破壞性操作
- 對 production 或未驗證目標執行任何外部副作用
- 聲稱完成但無 §7 證據
- 目標環境無法證明安全時，仍假設它是 dev/local

處理規則：

- 命中 §1 時只可做兩件事：
  1. 回報為何命中
  2. 提出安全替代方案（read-only、mock、文件、scaffold、測試、logic walkthrough）

---

## §2 允許範圍（L1）

以下可在未額外授權下執行，但仍需遵守 §6 / §7 / §10 / §12：

- read-only 操作：Supabase SELECT（含 dev / test project）、grep、search、讀檔、log 分析、schema / code recon
- 文件新增、整理、總結
- 新增測試腳本，但不得對 Supabase 造成寫入
- mock / fixture / local-only 驗證
- 非破壞性 code scaffolding，且必須同時滿足：
  - 可單一 revert 回滾
  - 不改 secrets / env / auth / RLS / migration / deploy path
  - 不直接接入 production runtime path
  - 不產生外部副作用
- 小範圍、低風險修改（≤ 8 檔、≤ 300 行），且未超出 §3 的門檻
- `git add` / `git commit` 到 **dev 分支**（本地 commit 無副作用）
- `git push origin dev`（不動 main；GitHub Pages 部署來源是 main，push dev 不觸發部署）

L1 的默認原則：

- 不確定是否屬於 L1 時，視為 §3
- 能用 read-only / mock 完成時，不做真實寫入
- 先縮小範圍，再動手

---

## §3 需明確授權（L2）

以下行為需 **明確、結構化授權** 後才可執行：

- 任何 Supabase DB 寫入（即使 local / dev / test）
- 執行 migration / 改 schema
- 破壞性操作（刪資料、批次 update、drop table）
- 大面積重構：**>8 檔案或 >300 changed lines**
- 觸碰 runtime 關鍵路徑：auth（`modules/auth.js`）、permission（`checkIsAdmin`、角色切換）、config、migration、data path
- 任何外部副作用，即使目標為 dev/staging
- 無法保證可單步回滾的修改
- 動 `common.js` 全域變數 / LIFF 初始化流程

門檻計算規則：

- 以 `git diff --shortstat` 的加總 changed lines 為準
- 預設 **不排除測試**
- 可排除純文件、lockfile、可重建 generated files，但仍需在證據中列出

### L2 授權格式

沒有以下格式，不算授權：

```text
AUTHORIZED_L2
scope: <一句話描述>
target: <local/dev/staging only>
allowed_commands:
- <精確命令 1>
- <精確命令 2>
expires: <this session only / until YYYY-MM-DD HH:mm TZ>
rollback: <一句話>
```

補充：

- production DB write / GitHub Pages deploy（push main）/ 改 RLS policy / 改 LIFF 仍屬 §1，**不可授權穿透**。
- 使用者若只說「繼續」、「可以」、「你做吧」，一律 **不視為 L2 授權**。

---

## §4 進度心跳（每 90 分鐘）

每 90 分鐘至少一次，或在即將進入可能超過 20 分鐘的長任務前，輸出心跳。

### 心跳主文（5 行）

```text
WORK: <現在在做什麼>
FILES: <這輪改了哪些檔 / 若無則寫 none>
RISK: <LOW | MEDIUM | HIGH>
NEXT: <下一步>
BLOCKERS: <阻塞 / 若無則寫 none>
```

### 續跑票據（4 行）

```text
NEXT_STEP: <下一個最小可執行步驟>
WAKEUP_AT: <YYYY-MM-DD HH:mm Asia/Taipei>
WAKEUP_REASON: <為何需要被喚回>
STOP_CONDITION: <達成何條件就停>
```

### 額外建議欄位（可加）

```text
BRANCH: <branch>
HEAD: <short sha>
LAST_TEST_STATUS: <pass/fail/not-run>
```

風險判準：

- **LOW**：read-only、文件、mock、純測試、無外部副作用
- **MEDIUM**：一般 code change、無外部副作用、可回滾
- **HIGH**：接近 §3 / §1、觸及 runtime / RLS / auth / config、多租戶查詢改動、風險不明

---

## §5 Commit 規範

每次 commit 必須符合：

- 單一目的
- 單一風險面
- 可一句話說明 rollback
- commit 前已通過 §6
- commit 後可附 §7 證據
- 只 commit 到 `dev` 分支（不動 main）

### Commit 回報格式

```text
COMMIT_PURPOSE: <一句話>
TESTS: <命令與結果（qa_check.sh、npm test）>
ROLLBACK: <一句話>
```

### 停下來回報條件

出現以下任一情況，**先停再回報，不得繼續擴散修改面**：

- 超過 8 檔案
- 超過 300 changed lines
- 改動面開始跨越多個子系統（例如同時改 auth + payroll + store）
- 原本低風險修改演變成架構性重構
- Hook `check-rls-bypass.sh` 或 `check-multitenant.sh` 跳新警告

---

## §6 測試門檻

### 專案真實命令

```bash
QA_CMD="bash scripts/qa_check.sh"   # 必須 0 FAIL
UNIT_CMD="npm test"                 # 必須 53 通過
```

### Hook 自動檢查（Edit / Write 後自動跑）

- `.claude/hooks/check-rls-bypass.sh` — 檢查 RLS 表是否直接寫入
- `.claude/hooks/check-multitenant.sh` — 檢查多租戶 company_id filter

### 規則

- 每次 **code change** 必跑 `QA_CMD` + `UNIT_CMD`
- 任一 fail → 不得 commit
- 任一 fail → 不得宣稱 `DONE`
- Hook 跳新警告 → 視同 fail，必須立即修正
- 若缺環境、憑證、依賴，導致無法執行 → 狀態只能是 `BLOCKED`
- 同一 failure signature 連續 2 次 fail，且中間沒有新證據或新假設 → 觸發 §8
- warnings **不作為 fail 條件**；errors 與 FAIL 才作為 fail 條件
- 改動 ≥ 3 檔或涉及多租戶 / RLS / RPC 時，commit 前必須派 `@rls-checker` subagent 做最終審查

### 前端頁面驗證

前端無法 bash 執行的（LIFF 頁面、瀏覽器頁面），改用 **code review + logic walkthrough** 替代，並在證據中明講「未實機驗證」。

補充：

- 不得用「看起來沒問題」、「理論上可過」取代實測
- 不得用較弱測試替代既定 qa_check + npm test

---

## §7 證據規範（防幻覺）

允許的狀態詞只有：

- `DONE`
- `NOT_DONE`
- `BLOCKED`
- `WAITING_FOR_USER_INPUT`

凡宣稱「已完成」或「已修好」，必附以下證據：

```text
STATUS: DONE
BRANCH: <branch>
HEAD: <short sha>

GIT_SHOW:
<git show --name-only --oneline -1>

TESTS_RUN:
- bash scripts/qa_check.sh => PASS/FAIL (X FAIL / Y WARN)
- npm test => PASS/FAIL (X/53 passed)
- <其他命令> => PASS/FAIL

DB_TOUCHED: <yes/no>
DB_BEFORE_AFTER: <required only when yes>

MULTITENANT_VERIFIED: <yes/no/n/a>
RLS_CHECKER_PASSED: <yes/no/n/a>

ARTIFACTS:
- <log path / screenshot / report path>
- <or none>

NOTES:
- [推論] <所有非直接驗證的推論都要標記>
```

補充規則：

- 純推論、純靜態閱讀、純肉眼判斷，不得寫成 `DONE`
- 若沒有 commit，最多只能回報 `NOT_DONE` 或 `BLOCKED`
- 若是部分完成，必須明確寫「完成了哪一部分；哪一部分未完成」
- DB 未觸碰時，必須明寫 `DB_TOUCHED: no`
- 前端頁面未實機驗證時，必須明寫「未實機驗證，僅 logic walkthrough」

---

## §8 自動收尾條件

觸發任一條件即停：

- 同一 failure signature 連續 2 次 fail，且無新證據
- 連續 2 小時處於 HIGH 風險工作
- 回報內容出現矛盾
- 重複犯同一錯誤 2 次
- 無法取得進一步所需權限 / 環境 / 命令定義
- 已完成 L1 可安全完成的部分，剩餘部分屬 §3 或 §1
- Hook 反覆跳同一類警告且無法消除

### Closeout 格式

```text
STATUS: DONE | NOT_DONE | BLOCKED
FIRST_NEXT_STEP: <下次第一步>
RISK_LIST:
- <風險 1>
- <風險 2>

ROLLBACK_HINT: <一句話>
LAST_SAFE_POINT: <branch + short sha>
```

補充：

- `DONE` 仍需附 §7
- `NOT_DONE` 與 `BLOCKED` 也要說清楚缺什麼

---

## §9 啟動語句

每次啟動先輸出：

```text
遵守 AUTONOMOUS_24H_GUARDRAILS.md。未經明確授權，不做任何 Supabase DB 寫入、GitHub Pages deploy、push main、外部副作用操作。每 90 分鐘固定心跳回報；每次 wakeup 先做 stale wakeup 檢查。
```

---

## §10 Turn End Contract（防 idle 停機）

每次 turn 結束前，三者擇一；否則違規：

1. 進入 §8 closeout
2. 呼叫 `ScheduleWakeup`（內容必含 §4 續跑票據）
3. 明確宣告 `WAITING_FOR_USER_INPUT`

### WAITING_FOR_USER_INPUT 格式

```text
WAITING_FOR_USER_INPUT
NEEDED: <缺的授權 / 決策 / 資料 / 命令>
REASON: <為何不能安全續跑>
NEXT_STEP_WHEN_RESUMED: <恢復後第一步>
```

補充：

- 不得無聲結束
- 不得把「之後再說」當成合法 turn end
- 長任務開始前若可能超過 20 分鐘，先排 wakeup 或先輸出心跳

### 10.1 Turn 中斷失誤防護（2026-04-23 事件驅動）

**事件**：2026-04-23 00:51 Batch 3 firing，讀完兩份 report 後僅輸出文字分析，未 Write 檔案、未 ScheduleWakeup，turn 結束 → 循環斷 6 小時才被 user 察覺。

**根因**：無「本 turn 必有 commit」硬檢查；純文字輸出後 turn 自然結束。

**規則**：

- 每個 batch 醒來後，**若非 Closeout**，本 turn 必須：
  - (a) 至少一個 Write / Edit 產生檔案變動
  - (b) 至少一個 commit（即使 docs-only）
  - (c) 結束前呼叫 ScheduleWakeup（或明確宣告 §8 closeout 不再 wakeup）
- 任一條件缺失 → 視為 **turn 中斷失誤**，應立即改交 §8 closeout 報告，而非靜默終止
- 若讀了大量 context（如多份 report）後只想「分析不動手」→ 應在 heartbeat 明說「本 batch 只分析不落檔」並交 §8 提前收尾，讓 user 裁決

---

## §11 Idle Watchdog（防呆）

符合以下條件時，視為 idle 風險：

- 20 分鐘無輸出
- 且未 closeout
- 且未 `WAITING_FOR_USER_INPUT`
- 且未 `ScheduleWakeup`
- 且沒有正在執行的已批准長任務 / monitor

處理規則：

- 有排程能力時：自動補排 wakeup
- 無排程能力時：在進入沉默前，必須回到 §10 的 3 選 1

### Wakeup 最少應攜帶的資訊

```text
NEXT_STEP
WAKEUP_AT
WAKEUP_REASON
STOP_CONDITION
BRANCH
HEAD
LAST_TEST_STATUS
```

---

## §12 Stale Wakeup Detection（防重複工作）

每次 wakeup 的第一動作，必須先驗證 `NEXT_STEP` 是否已完成，順序如下：

1. `git status --short`
2. `git branch --show-current`
3. `git rev-parse --short HEAD`
4. `git log --oneline -n 5`
5. 對比：
   - 上次 `NEXT_STEP`
   - 最近 commits
   - working tree / relevant files
   - 已有測試 / log / artifact

### 判斷結果

- **(a) 完全已做** → 不得重做；回報 `WAITING_FOR_USER_INPUT` 或提出新的安全 L1 下一步
- **(b) 部分已做** → 只做剩餘部分
- **(c) 未做** → 照計畫執行

### 回報要求

若結果為 (a) 或 (b)，回覆中必須明確標示：

```text
偵測到 stale wakeup
```

並補充：

```text
STALE_WAKEUP: true
ALREADY_DONE: <已完成部分>
REMAINING: <剩餘部分 / 若無則寫 none>
```

補充：

- 不能只看 commit message；必須同時看 uncommitted 狀態
- 不能因為 wakeup ticket 存在，就假設工作尚未完成

### 12.1 Stale wakeup 並存處理（2026-04-23 事件驅動）

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

---

## §13 Agent 輸出覆驗強化（2026-04-23 事件驅動）

**事件**：Batch 2 Explore agent 報告日期誤寫「2026-04-23」（實際 04-22）；引用 `migrations/032` 討論 race（實際最新 `migrations/069`）。

**規則**（派 Explore / 其他 subagent 時寫進 prompt）：

- 「用 `date` 指令取系統時間，不要推算日期」
- 「引用 migration 前先 `ls migrations/` 找最新版本號再讀」
- Agent 回報**關鍵結論**（影響修復決策 / 嚴重度）必親驗 ≥ 3 項（對齊 `.claude/memory/claude_code_analysis_checklist.md` Q4 硬規則）

---

## §14 每輪結束檢討

- 每輪 Closeout 後建議 user 提問「本輪是否有異常」 → Claude 誠實自查並列出
- 若發現可強化規則 → 更新對應小節（不擴大其他節），保留歷史脈絡

---

## 附錄 A：建議同步放入 `.gitignore`

```gitignore
# 已在 .gitignore 中
node_modules/

# 建議補上
.claude/scheduled_tasks.lock
artifacts/
.artifacts/
```

---

## 附錄 B：本專案測試命令快速表

| 命令 | 用途 | 通過標準 |
|---|---|---|
| `bash scripts/qa_check.sh` | QA 自動檢查（全域變數、多租戶、時區、RLS） | 0 FAIL |
| `npm test` | 單元測試 | 53 通過 |
| `@rls-checker` | RLS 處理完整性審查（subagent） | 無漏洞回報 |
| `.claude/hooks/check-rls-bypass.sh` | Edit/Write 後自動跑 | 無新警告 |
| `.claude/hooks/check-multitenant.sh` | Edit/Write 後自動跑 | 無新警告 |

---

## 附錄 C：Supabase / LIFF 環境資訊（read-only reference）

- **Supabase URL**：`https://nssuisyvlrqnqfxupklb.supabase.co`
- **LINE LIFF ID**：`2008962829-bnsS1bbB`
- **LINE 官方帳號**：`@130oqrak`
- **GitHub Pages**：`https://holaadam-tw.github.io/hr-attendance-liff/`
- **大正科技 company_id**：`8a669e2c-7521-43e9-9300-5c004c57e9db`
- **本米 company_id**：`fb1f6b5f-dcd5-4262-a7de-e7c357662639`

> 以上為 read-only 識別資訊，不可當作 secret。改動任一項屬 §1 絕對禁止。
