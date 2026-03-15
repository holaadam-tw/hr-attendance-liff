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

### 衝突變數檢查（每次修改 HTML 檔案必做）
修改任何 HTML 頁面後，執行：
grep -n "^let \|^const \|^var " 檔案名.html
確認沒有與 common.js 重複宣告的全域變數：
currentEmployee, currentCompanyId, liffProfile, sb, officeLocations
