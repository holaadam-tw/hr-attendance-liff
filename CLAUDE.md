# RunPiston 專案記憶

請在每次對話開始時，主動讀取以下記憶檔案：
- .claude/memory/MEMORY.md
- .claude/memory/architecture.md

這些檔案包含本專案的開發規則、架構設計與重要決策，
所有修改必須遵守這些規則。

---

## 開發作業規則

### 完成標準
- 每次寫完程式，必須在 bash 環境執行並驗證
- 不允許只輸出程式碼而不執行
- 執行後必須對照預期結果，明確說明哪些通過、哪些沒通過
- 不能只說「執行成功」，必須給具體 output

### 驗收格式
每個功能完成後輸出：
- ✅ / ❌ 各測試案例結果
- 實際執行輸出（非預期中的結果要解釋原因）
- 若無法在 bash 執行（例如前端 LIFF 頁面），明確說明並改用 code review + logic walkthrough 替代

## Git 規則
- 永遠推到 main 分支：`git push origin master:main`
- 不要直接 `git push`（會推到 master）
- GitHub Pages 部署來源是 main 分支

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
