# RunPiston 專案記憶

請在每次對話開始時，主動讀取以下記憶檔案：
- .claude/memory/MEMORY.md
- .claude/memory/architecture.md

這些檔案包含本專案的開發規則、架構設計與重要決策，
所有修改必須遵守這些規則。

---

## 強制自我驗證流程

每次寫程式必須執行：
1. `git diff` 列出改動
2. 對照 `docs/BUG_TRACKER.md` 列影響場景（至少 3 個）
3. 每個場景做 logic walkthrough
4. 驗證報告寫進 commit message
5. **任何場景失敗不准 commit**

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
