# PoC-5: `quick_check_in` RPC 並行打卡 race 邏輯 review（折衷方案）

## 背景
- 使用者回答 D3 → 走折衷：不實測 PoC-4（不動 DB）
- 替代：對最新版 RPC `migrations/069` 做完整 code review，判斷 race 邏輯
- L1 純 code read，0 DB 動作

## RPC 入口簽章
**檔案**: `migrations/069_block_kiosk_self_checkin.sql`
```sql
CREATE OR REPLACE FUNCTION quick_check_in(
    p_line_user_id TEXT,
    p_latitude DOUBLE PRECISION,
    p_longitude DOUBLE PRECISION,
    p_photo_url TEXT DEFAULT NULL,
    p_device_id TEXT DEFAULT NULL,
    p_action TEXT DEFAULT NULL      -- ← 關鍵：default NULL
)
```

## 關鍵 race 邏輯段（L329-366）

```sql
BEGIN
    INSERT INTO attendance (
        employee_id, date, check_in_time, ...
    ) VALUES (
        v_employee.id, v_today, v_now, ...
    );
EXCEPTION WHEN unique_violation THEN
    SELECT * INTO v_existing
    FROM attendance
    WHERE employee_id = v_employee.id AND date = v_today;

    -- L346 的關鍵條件
    IF v_existing.id IS NOT NULL
       AND v_existing.check_out_time IS NULL
       AND p_action IS DISTINCT FROM 'check_in' THEN
        -- 走下班流程 UPDATE check_out_time
        UPDATE attendance SET check_out_time = v_now, ...
        RETURN 'check_out';
    END IF;

    IF p_action = 'check_in' THEN
        RETURN 'error: 今日已打上班卡';
    END IF;
    RETURN 'error: 今日已完成打卡';
END;
```

## 並行 race 分析

### 情境 A: 兩台手機都傳 `p_action = 'check_in'`
```
手機 1: INSERT → 成功
手機 2: INSERT → UNIQUE violation → EXCEPTION
  → L346 檢查: p_action='check_in' → IS DISTINCT FROM 'check_in' → FALSE
  → 不走 UPDATE check_out → 跳到 L362
  → L362 檢查: p_action='check_in' → TRUE → RETURN 'error: 今日已打上班卡'
```
**✅ 安全** — 第二次打卡被正確擋下。

### 情境 B: 兩台手機都傳 `p_action = NULL`（default）
```
手機 1: INSERT → 成功
手機 2: INSERT → UNIQUE violation → EXCEPTION
  → L346 檢查: NULL IS DISTINCT FROM 'check_in' → TRUE
  → AND v_existing.check_out_time IS NULL → TRUE（手機 1 剛 INSERT 完）
  → AND v_existing.id IS NOT NULL → TRUE
  → 走 UPDATE check_out_time = v_now
  → total_work_hours = v_now - v_existing.check_in_time ≈ 0（毫秒級差）
  → RETURN 'check_out'
```
**⚠️ 誤作下班** — 員工看到「已完成打卡」但實際上工時 ≈ 0。

### 情境 C: 兩台手機都傳 `p_action = 'check_out'`
```
手機 1: INSERT → 成功（但 p_action='check_out' 進到 INSERT 很奇怪；RPC 前段會處理）
```
實際上 `p_action='check_out'` 會走 L117-231 的上半段下班流程（未在此 PoC 範圍），不會進到 INSERT。此情境不適用。

## 前端實際呼叫方式 — 決定性證據

需 grep `checkin.html` 看前端怎麼傳 `p_action`。

### Grep 結果（recon）
- `checkin.html:191-196` → 上班 call `sb.rpc('quick_check_in', { ..., p_action: 'check_in' })`
- `checkin.html:330-335` → 下班 call `sb.rpc('quick_check_in', { ..., p_action: 'check_out' })`

**✅ 前端明確傳 `'check_in'` / `'check_out'`，不傳 NULL**

## 結論

### Race 實際觸發情境

| 呼叫來源 | `p_action` | Race 狀況 |
|---|---|---|
| 正常 LIFF 前端 checkin.html | 明確傳 `'check_in'` | ✅ **安全**（情境 A） |
| 公務機模式 | 明確傳（參考 checkin.html） | ✅ **安全** |
| 其他 custom client / 直接打 RPC API | 若傳 NULL | ⚠️ **可能 race**（情境 B） |

### 風險評估
- **前端正常流程**：race 不觸發 → P6 **實務安全**
- **攻擊者直接打 RPC 且不傳 `p_action`**：race 觸發 → 但這同時暴露 P1（RPC 無身份驗證），攻擊者有更簡單的破壞方式，race 不是重點
- **使用者（管理員）已明確表示**：穩定後管理員不打卡 + 員工不會一人兩手機並行 → 實務觸發機率 ≈ 0

### 推薦修復（若要強制保險）
在 RPC L346 加時間差檢查：
```sql
IF v_existing.id IS NOT NULL
   AND v_existing.check_out_time IS NULL
   AND p_action IS DISTINCT FROM 'check_in'
   AND (v_now - v_existing.check_in_time) > INTERVAL '10 minutes' THEN  -- ← 新增
    -- 走下班
END IF;
```
意義：若上班打卡後 10 分鐘內又收到 UNIQUE conflict 且 p_action 非 'check_in'，視為誤觸，不走下班。

## 最終判定
- **P6 降級**：🔴 推論 → 🟡 **實務不觸發但理論存在**
- **優先級**：排在 P1/P2/P3 之後（先處理真正的安全漏洞）
- **不需 L2 實測**（折衷方案成功 — 使用者可省下授權 DB 寫入的風險）

**PoC 類型**: RPC 完整 code review
**L1 安全**: 純讀 migrations/069，0 DB 動作
**產出**: P6 嚴重度降級證據
