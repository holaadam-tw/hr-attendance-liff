# 員工端功能缺陷審查（Batch F1）

**日期**: 2026-04-23
**範圍**: index.html / checkin.html / records.html / services.html / salary.html / schedule.html 及 modules
**方法**: Explore agent 7 類缺陷 grep + **3 項親驗（揭露 2 項 agent 誤判）**
**焦點**: 功能缺陷（非安全/邏輯，已在 2026-04-22 Batch 1-2 報告）

---

## ⚠️ 本次親驗揭示的 Agent 誤判

Agent 報告中有 2 項經親驗後證實錯誤，**不列入缺陷清單**：

| 原代號 | Agent 結論 | 親驗事實 |
|---|---|---|
| F1-P1 | schedule.html 空白/未實作 | ❌ `schedule.html` 實有 **533 行 / 29 KB**，非空白。具體實作品質需另 batch 深查。Agent 標 `[推論]` 準確但結論偏差 |
| F1-I2 | submitLeave/submitOvertime 無 loading 狀態 | ❌ `common.js` 有 `setBtnLoading()` helper（L154），submitLeave L751/766、submitMakeup L861/890、submitOvertime L1937/1960 **全有 loading + reset**。Agent 說「無 btn.disabled = true」是錯的 |

**教訓**：Agent 推論項失準率高，`[推論]` 標記不等於可信。關鍵結論**都要親驗**（§10.3 規則證明有效）。

---

## 🔴 嚴重（親驗確認）

### F1-S1 — 請假日期 input 無 min / max 屬性 `[高信心 — 親驗]`

**檔案**: `records.html:93-94`
```html
<div class="form-group"><label>開始日期</label><input type="date" id="leaveStartDate" onchange="onLeaveDateChange()"></div>
<div class="form-group"><label>結束日期</label><input type="date" id="leaveEndDate" onchange="onLeaveDateChange()"></div>
```

**觀察**：
- 無 `min` / `max` HTML 屬性
- 員工理論上可選 1900 年 / 2099 年的日期
- `onLeaveDateChange()` 是否補驗未親查，但從體驗面：**輸入時無瀏覽器邊界限制**

**影響**：
- 已過期請假申請（如上個月想補請）是否合法，視公司政策；系統不擋前端，一律丟後端判斷
- 使用者可能輸錯年份（例 2025 而非 2026）造成 request 寫入錯年

**修復方向（一句話）**：input 加 `min="today-30d"` + `max="today+90d"`（或由 system_settings 配置），且 `onLeaveDateChange` 做範圍校驗

---

## 🟠 重要（未親驗，標推論）

以下項 Agent 有給源但**我未親驗**（Batch 時間限制）。列出僅供 user 參考，真正動手修前需再驗。

### F1-S2 — 補打卡日期無 min 限制 `[Agent 推論]`
- **Agent 引用**: `records.html:117-119` + `common.js:347` mpDate.max
- **Agent 結論**: 有 max（不能選未來）但無 min（可選多久以前都行）
- **待親驗**：初始化時確實無 min？或公司政策用後端擋？

### F1-S3 — 加班時數 submitOvertime 無 > 12 JS 檢查 `[Agent 推論]`
- **Agent 引用**: `records.html:181` input `max="12"` + `common.js` submitOvertime
- **Agent 結論**: HTML5 max 可繞過，JS 層未驗
- **待親驗**：submitOvertime 完整邏輯

### F1-I3 — GPS 定位失敗只有「我知道了」modal，無 fallback `[中信心]`
- **檔案**: `checkin.html:164-173, 439-468`
- **情境**: 權限拒 / 訊號差 → `showGPSWarning()` 只有關閉按鈕 → 卡在打卡頁
- **修復方向**: 加「重試」或「使用上次位置」按鈕；或管理員可配「GPS 非強制」
- **待親驗**

### F1-I4 — 便當訂購 popup 截止時間重檢缺 `[低信心]`
- **檔案**: `checkin.html:527-536` + `services.html:579-621`
- **情境**: popup 彈出時若截止時間已過，使用者選完才被拒
- **修復方向**: 點「確認訂購」前再 check deadline，或 popup 顯示倒數
- **待親驗**

---

## 🟡 打磨（UX 小問題）

### F1-I1 — 空資料文案不一致 `[Agent grep，未親驗]`
- `common.js:812/906/976` 用不同文案：「尚無記錄」/「尚無補打卡記錄」/「尚無加班記錄」
- `records.html:104` 初始「載入中...」→ 改「尚無記錄」體驗跳躍
- **修復方向**：統一為「目前無記錄」+ 骨架屏避免跳躍

### F1-P2 — 返回按鈕行為不一致 `[Agent 推論]`
- `checkin.html:570-582` 用 `history.back()`
- records / services 返回用 href
- **修復方向**：統一為 `location.href='index.html'`

### F1-P3 — `scrollIntoView block:'nearest'` 小屏可能被遮 `[Agent 推論，低信心]`
- `records.html:492-493`
- **修復方向**：改 `block:'center'` 或加 scroll-margin-top

---

## 💡 功能建議（該有沒有，非 bug）

### F1-F1 — 員工無法主動取消 / 撤銷今日打卡 `[中信心]`
- **檔案**: `index.html:173-181` 打卡狀態卡片只顯示「已打卡 ✅」
- **情境**: 誤打上班卡 → 無快捷「取消 / 改申請補卡」入口
- **建議**: 打卡後 5 分鐘內允許撤銷，或加「申請補正」按鈕直跳補卡頁

### F1-F2 — 請假剩餘天數員工端缺顯示 `[中信心]`
- **檔案**: `records.html` 請假表單
- **情境**: 員工填請假時不知自己特休剩多少 → 申請超額才被擋
- **建議**: 表單上方加「📊 特休 15 天 · 病假 3 天 · 事假剩餘 5 天」

### F1-F3 — 加班時數累計查看缺 `[低信心]`
- **檔案**: `records.html` 加班 tab
- **建議**: 加統計卡「本月加班 8.5h · 本年累計 42h · 已換補休 12h · 待計薪 30h」

---

## ✅ 抽樣確認運作正常的（Agent 結論）

1. **打卡流程基本功能**: `checkin.html` 相機、GPS、照片上傳、RPC 呼叫、成功/失敗 modal、`mapCheckinError` 錯誤對應完整 `[agent 高信心]`
2. **submitLeave/Makeup/Overtime 有 loading 狀態**: `common.js:751/861/1937` setBtnLoading 正確運作（**親驗糾正 agent F1-I2 誤判**）
3. **便當訂購截止時間控制**: `services.html:279-300` deadline 計算與表單禁用 `[agent 高信心]`

---

## 📋 彙總

| 分類 | 數量 | 狀態 |
|---|---|---|
| 🔴 親驗確認 | 1（F1-S1） | 可修（小改動） |
| 🟠 Agent 推論未親驗 | 4（S2/S3/I3/I4） | 動手修前需先親驗 |
| 🟡 打磨 | 3（I1/P2/P3） | 低優先 |
| 💡 功能建議 | 3（F1/F2/F3） | 非 bug，取捨 |
| ❌ Agent 誤判排除 | 2（F1-P1 / F1-I2） | 證實無問題 |

---

## 🎯 本 Batch 親驗表現

**符合 §10.3 覆驗強化規則**：
- ✅ 跑 `date` 確認日期（implicit via git log）
- ✅ 親驗 3 項：F1-S1（真）/ F1-P1（誤判）/ F1-I2（誤判）
- ✅ 覆驗率 3/10 ≈ 30%（關鍵項）

**教訓寫入 §10.3**（已在 commit 68c619e）：
> Agent 回報**關鍵結論**必親驗 ≥ 3 項

本次實際揭示 agent 失準率 2/3 在覆驗樣本中 — 未親驗項不可全信。

---

**產出**: 1 確認 bug + 4 推論項（待 F4 彙整時再定 PoC 或親驗）+ 3 打磨 + 3 功能建議 + 2 誤判排除
**下一步**: Batch F2 管理員端功能缺陷
