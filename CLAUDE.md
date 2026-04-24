# RunPiston 開發規則（每次 session 自動載入）

## AI Agent 主規範（優先順序由高到低）

1. `docs/AI_AGENT_MASTER_RULES.md` — 最高優先級政策、規則階層、停損條件
2. `docs/AUTONOMOUS_24H_GUARDRAILS.md` — Runtime 安全：Hard Block / L1/L2 / 心跳 / 證據 / stale wakeup
3. `docs/EXECUTION_RULES_AGENT_SKILLS.md` — 工作流程：Spec → Plan → Build → Verify → Review → Ship
4. 本文件 `CLAUDE.md` — 專案強制規則、QA / RLS / Hook、核心檔案職責、回歸測試清單
5. `openspec/` — 規格驅動開發（SDD）

規則衝突時，上位者勝。標準召喚語：`請依照 docs/AI_AGENT_MASTER_RULES.md 執行`。

請在每次對話開始時，主動讀取以下記憶檔案：
- .claude/memory/MEMORY.md
- .claude/memory/architecture.md

這些檔案包含本專案的開發規則、架構設計與重要決策，
所有修改必須遵守這些規則。

---

## 🔥 強制規則（不可跳過）

### 任務開始前

1. **讀規則文件**：
   - `docs/DANGER_ZONES.md` — 高風險區域與已知陷阱
   - `docs/TEST_SCENARIOS.md` — 測試場景清單
   - `docs/BUG_TRACKER.md` — 已知 bug 與修復狀態

2. **同步檢查**：
   - 如果任務涉及核心檔案（common.js / modules/auth.js / modules/store.js），先 grep 確認現有邏輯
   - 不要在不讀現有程式碼的情況下新增功能

### 改程式中

1. **Supabase 查詢鐵則**：
   - 任何 `sb.from()` 查詢必須有多租戶隔離
   - 隔離方式：
     - 直接 filter: `.eq('company_id', window.currentCompanyId)`
     - 關聯 filter: `.select('*, employees!inner(company_id)').eq('employees.company_id', window.currentCompanyId)`
     - 員工自查: `.eq('employee_id', currentEmployee.id)`（ID 來源已隔離）
   - **絕對禁止**：無 filter 的 SELECT

2. **RLS 表禁止直接寫入**：
   - attendance / makeup_punch_requests / overtime_requests / leave_requests / schedules
   - 必須用 SECURITY DEFINER RPC

3. **PostgreSQL RECORD NULL 陷阱**：
   - 禁止 `IF v_record IS NOT NULL`
   - 用 `IF v_record.id IS NOT NULL` 或 BOOLEAN 旗標

4. **Hook 自動檢查**：
   - 每次 Edit/Write 後 `.claude/hooks/check-rls-bypass.sh` 和 `.claude/hooks/check-multitenant.sh` 會自動跑
   - **看到 ⚠️ 警告必須立刻檢查**
   - 如果是新出現的警告，必須修正
   - 已知低風險警告（員工自查）可以忽略：
     - common.js:524, 614, 646, 1097
     - modules/employees.js:233, 801
     - modules/leave.js:280

### 改程式後（自我驗證 5 步）

每次修改必須：
1. `git diff` 列出所有改動
2. 找出至少 3 個受影響的情境
3. 對每個情境做 logic walkthrough
4. 跑 `bash scripts/qa_check.sh`（必須 0 FAIL）
5. 跑 `npm test`（必須 53 通過）

**如果任一情境走不通 → 不可 commit**

### 任務完成前

1. **複雜任務**（改動 3 個以上檔案，或涉及多租戶/RLS/RPC）：
   - 必須跑 `@rls-checker` 做最終審查
   - 等報告回來才 commit

2. **commit 訊息**：
   - 必須說明：改了什麼、為什麼、測試了什麼
   - 不可只寫「fix bug」

3. **Git 流程**：
   - 永遠在 `dev` 分支改
   - `git push origin dev` 後由使用者手動合併 main
   - **絕對禁止直接改 main**

---

## 核心檔案職責

| 檔案 | 職責 | 修改前必讀 |
|------|------|-----------|
| common.js | LIFF 初始化、全域變數、共用函數 | ✅ |
| modules/auth.js | 認證、綁定、角色切換 | ✅ |
| modules/store.js | 商店、預約、會員 | ✅ |
| modules/payroll.js | 薪資計算 | ✅ |
| modules/leave.js | 請假、便當、考勤設定 | ✅ |
| modules/schedules.js | 排班、換班 | ✅ |
| modules/employees.js | 員工管理 | ✅ |
| modules/audit.js | 審計日誌、報表匯出 | ✅ |
| modules/settings.js | 業主設定、客戶、公告 | ✅ |

## 重要系統資訊

- **LINE LIFF ID**: 2008962829-bnsS1bbB
- **LINE 官方帳號**: @130oqrak
- **大正科技 ID**: 8a669e2c-7521-43e9-9300-5c004c57e9db
- **本米 ID**: fb1f6b5f-dcd5-4262-a7de-e7c357662639
- **Supabase**: https://nssuisyvlrqnqfxupklb.supabase.co
- **GitHub Pages**: https://holaadam-tw.github.io/hr-attendance-liff/

---

## 開發作業規則

1. 寫完程式必須在 bash 執行並驗證
2. 不允許只輸出程式碼而不執行
3. 執行後對照預期結果，明確說明通過/未通過
4. 給具體 output，不能只說執行成功
5. 前端無法 bash 執行的，改用 code review + logic walkthrough 替代

### 驗收格式
每個功能完成後輸出：
- ✅ / ❌ 各測試案例結果
- 實際執行輸出（非預期中的結果要解釋原因）
- 若無法在 bash 執行（例如前端 LIFF 頁面），明確說明並改用 code review + logic walkthrough 替代

## 同步檢查

修改後同步更新：
- `docs/BUG_TRACKER.md`（功能狀態）
- `.claude/memory/architecture.md`（技術決策）
- `SKILL.md`（如果功能架構改變）

## 自動執行

修完後直接 `git add`, `commit`, `push origin dev`，不動 main branch。
合併到 main 必須 user 明確確認。

---

## Git 規則
- **所有變更先在 dev 分支進行**，測試沒問題才合併到 main
- 合併流程：`git checkout main && git merge dev && git push origin main`
- 不要直接在 main 上開發
- GitHub Pages 部署來源是 main 分支
- `node_modules/` 已加入 `.gitignore`，**絕對不可上傳到 git**
- 需要時用 `npm install` 還原即可

## OpenSpec SDD
- 專案已安裝 OpenSpec（`@fission-ai/openspec`）
- 新功能開發用 `/opsx:propose "你的想法"` 開始
- 規格文件放在 `openspec/specs/`，變更提案放在 `openspec/changes/`
- 專案總覽：`openspec/project.md`

## 全域錯誤監控
- 所有 HTML 頁面已加入 `window.onerror`，錯誤自動送到 Supabase `error_logs` 表
- 紀錄欄位：message, page, line, user_id, user_agent
- 定期檢查：Supabase → Table Editor → error_logs

## 語言規範
- 所有回應、文件、commit 訊息使用**繁體中文**

### QA 自動檢查（每次修改程式碼後必做）
每次修改完程式碼，commit 前必須執行：
```bash
bash scripts/qa_check.sh
```
檢查項目：
1. 全域變數衝突（HTML 與 common.js）
2. maybeSingle().catch() 陷阱
3. 時區問題（toLocale* 缺少 timeZone: 'Asia/Taipei'）
4. getHours/getMinutes 用於 DB 時間
5. 多租戶隔離（查詢缺 company_id）
6. 子頁面返回按鍵
7. 消費者頁面不應有 LIFF

**FAIL 必須修正才能 commit，WARN 需確認是否為預期行為。**

### RLS 檢查機制

每次修改 common.js / modules/*.js 時，Hook 會自動檢查 RLS 表殘留。

新功能涉及資料表時，主動派工給 rls-checker：
「@rls-checker 確認本次 RLS 處理完整」

### Bug 追蹤（每次修 bug / 測試後必做）
- 修 bug 後更新 `docs/BUG_TRACKER.md` 的狀態（標記已修復 + commit hash）
- 測試後在 BUG_TRACKER.md 標記通過/未通過
- 詳細測試清單與每日 SOP 見 `docs/BUG_TRACKER.md`

---

## 回歸測試清單（每次 commit 前必須確認）

### 核心頁面可開啟測試
修改任何 common.js / modules/auth.js / modules/*.js 後，必須確認：

| 頁面 | 開啟方式 | 預期結果 |
|------|---------|---------|
| admin.html | 瀏覽器直接開啟 | LINE 登入頁（不出現 400） |
| platform.html | 瀏覽器直接開啟 | LINE 登入頁（不出現 400） |
| index.html | 瀏覽器直接開啟 | 顯示「請從 LINE 開啟」 |
| index.html | LINE LIFF 開啟 | 正常顯示員工首頁 |
| booking.html | 瀏覽器直接開啟 | 正常顯示訂位頁 |
| booking_service.html | 瀏覽器直接開啟 | 正常顯示預約頁 |
| order.html | 瀏覽器直接開啟 | 正常顯示點餐頁 |

### 功能開關測試
修改 common.js DEFAULT_FEATURES / getFeatureVisibility 後：
- [ ] platform.html 開關儲存後 index.html 格子正確顯示/隱藏
- [ ] 業主第二層開關正確覆蓋（只能關不能開）

### 打卡測試
修改 checkin.html / common.js 打卡相關後：
- [ ] 從 liff.line.me 進入相機正常
- [ ] GPS 定位正常
- [ ] 打卡時間顯示台灣時間（不是 UTC）

### 多租戶測試
修改任何查詢後：
- [ ] 本米資料不會出現在大正科技
- [ ] 大正科技資料不會出現在本米

### 修改影響範圍對照表
| 修改檔案 | 必須測試的頁面 |
|---------|--------------|
| common.js | 所有頁面 |
| modules/auth.js | admin.html, platform.html, index.html |
| modules/store.js | booking.html, booking_service.html, order.html |
| modules/leave.js | records.html, services.html |
| modules/payroll.js | salary.html, admin.html |
| index.html | index.html, checkin.html |
| admin.html | admin.html |

---

## 今天完成的系統（2026-04-13）

- ✅ 24 個多租戶隔離漏洞修復（批次 1/2/3 + 補充）
- ✅ check-multitenant.sh Hook 自動檢查 company_id
- ✅ check-rls-bypass.sh Hook 自動檢查 RPC 直接寫入
- ✅ 公務機打卡重新設計（LIFF 認證取代 URL token）
- ✅ 排班管理系統 + 週班表公開查看
- ✅ 免打卡員工選項
- ✅ 加班/補打卡入口按鈕
- ✅ quick_check_in v_schedule bug 修復
- ✅ 固定班預設 08:00/17:00
