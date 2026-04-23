# tests/poc/ Backlog

## PoC-4: 並行打卡 race（實測）

**狀態**: ❌ 未執行
**原因**: 需 L2 授權（會寫入 attendance 表）
**替代**: 已由 `poc5_rpc069_race_review.md` 做 RPC code review，結論「實務不觸發」
**觸發條件**: 若 user 日後授權實測，或 poc5 結論存疑

**執行方式（若授權後）**:
1. 建測試員工（非真員工）+ 綁測試 LINE ID
2. 開 2 個 Supabase client 實例
3. 同時呼叫：
   ```js
   Promise.all([
     sb.rpc('quick_check_in', { p_line_user_id: 'test_U123', p_latitude: ..., p_action: null }),
     sb.rpc('quick_check_in', { p_line_user_id: 'test_U123', p_latitude: ..., p_action: null })
   ])
   ```
4. 觀察第二筆結果：`{ type: 'check_in' }` vs `{ type: 'check_out' }`
5. **測試後清理 attendance 測試記錄**

**依據**: User 在 D3 回答 → 管理員才會有測試打卡需求 + 員工管理有關閉打卡按鈕 → 實務風險低

---

## 未來 PoC 候選（非本次 sprint）

### PoC-6: `shift_types` anon 寫入（P1 寫漏洞）
- 目前 PoC-1 只驗讀，寫漏洞未驗
- 執行方式：`sb.rpc('create_shift_type', { p_company_id: <other>, p_name: 'hacked', ... })` 用 anon key
- **會寫 DB** → 需 L2 授權 + 測試公司建立
- 若 user 授權 → 可證明「anon 可建立任何公司班別」

### PoC-7: `switchCompanyAdmin` state 殘留（P5）
- 模擬切公司流程觀察 payroll/bonus 全域變數
- 純前端 DevTools 觀察，0 DB 動作（L1）
- 但本地需手動跑 admin.html + 切公司，偏向 E2E 測試
- 暫列 backlog，等有空手動驗

### PoC-8: `baseSalary NULL` 無警告（P4）
- 建一個無 salary_settings 的員工 → 跑薪資計算 → 看是否 silent pass
- 純前端觀察，但需建測試員工（L2）
- 替代：對 `modules/payroll.js:95` 做 code review 已足夠

---

## 本次 Batch 4 完成的 PoC

- ✅ `poc1_shift_types_anon.mjs` — 可執行腳本（anon 讀取驗證）
- ✅ `poc2_bonus_negative.md` — code path 文件
- ✅ `poc3_promise_all_silent.md` — code path 文件 + DevTools override
- ✅ `poc5_rpc069_race_review.md` — RPC race 邏輯 review（折衷方案產物）

**不做**: PoC-4（見上）
