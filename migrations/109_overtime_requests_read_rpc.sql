-- ============================================================
-- 109: overtime_requests 讀取改走 RPC（RLS 整治 P0 第一張表）
--
-- 背景：
--   2026-08-06 盤點（docs/RLS_REMEDIATION_INVENTORY.md）確認 overtime_requests
--   **RLS 完全未開啟、0 條政策**，而 anon 對該表有完整 DML 權限——公開的
--   anon key 就能讀寫所有公司的加班資料。
--
--   這張表被選為整治起手式，因為：
--     - 寫入已經 100% 走 RPC（072 的 approve/reject、108 的 confirm_daily_overtime），
--       沒有任何前端直接寫入，不必先處理寫入路徑
--     - 讀取只有 5 個呼叫點、集中在 3 個檔案，範圍最小
--
-- 本 migration 只做一件事：新增 get_company_overtime_requests()。
-- **刻意不在這裡 ENABLE ROW LEVEL SECURITY**——順序必須是
--   109 建 RPC → 前端改呼叫 → 部署驗證 → 110 才收 RLS。
-- 顛倒過來會在前端還在直接讀表時就把它們打死。
--
-- 取代的 5 個呼叫點（全部是 admin/manager 畫面）：
--   1. attendance_overview.html  加班確認卡片（近 14 天，全狀態）
--   2. modules/audit.js          薪資彙總報表（月範圍，status=approved）
--   3. modules/audit.js          加班報表匯出（無日期範圍，最新 200 筆，全狀態）
--   4. modules/payroll.js        薪資主表（月範圍，status=approved）
--   5. modules/payroll.js        薪資明細（月範圍，status=approved）
--
-- 回傳欄位是這 5 處需求的聯集，讓一支 RPC 就夠用，不必為每個畫面各開一支。
--
-- 權限：admin/manager（沿用 092/099/105 的驗證模式）。
--   員工查自己的加班另有 072 的 get_my_overtime_requests()，本函式不涉及。
--
-- 注意事項：
--   - STABLE：純讀取，不寫入
--   - 日期範圍兩端皆可為 NULL（NULL = 不限），供加班報表那種「最新 N 筆」的用法
--   - p_status 為 NULL 時回傳全部狀態
--   - 排序固定 ot_date DESC, created_at DESC，讓「最新 200 筆」的語意穩定
--   - 型別一律 ::TEXT / ::NUMERIC 明確轉換，避免 varchar 與 text 不符而報錯
-- ============================================================

CREATE OR REPLACE FUNCTION get_company_overtime_requests(
    p_company_id UUID,
    p_line_user_id TEXT,
    p_from DATE DEFAULT NULL,
    p_to DATE DEFAULT NULL,
    p_status TEXT DEFAULT NULL,
    p_limit INTEGER DEFAULT 1000
) RETURNS TABLE (
    id UUID,
    employee_id UUID,
    employee_name TEXT,
    employee_number TEXT,
    department TEXT,
    ot_date DATE,
    status TEXT,
    source_type TEXT,
    hours NUMERIC,
    planned_hours NUMERIC,
    actual_hours NUMERIC,
    approved_hours NUMERIC,
    final_hours NUMERIC,
    compensation_type TEXT,
    created_at TIMESTAMPTZ
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
    IF p_line_user_id IS NULL OR p_line_user_id = '' THEN
        RAISE EXCEPTION '未提供身份驗證資訊';
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM employees e
        WHERE e.company_id = p_company_id
          AND e.line_user_id = p_line_user_id
          AND e.is_active = true
          AND e.role IN ('admin', 'manager')
    ) THEN
        RAISE EXCEPTION '需要管理員權限';
    END IF;

    RETURN QUERY
    SELECT o.id,
           o.employee_id,
           e.name::TEXT,
           e.employee_number::TEXT,
           e.department::TEXT,
           o.ot_date,
           o.status::TEXT,
           COALESCE(o.source_type, 'manual')::TEXT,
           o.hours::NUMERIC,
           o.planned_hours::NUMERIC,
           o.actual_hours::NUMERIC,
           o.approved_hours::NUMERIC,
           o.final_hours::NUMERIC,
           o.compensation_type::TEXT,
           o.created_at
    FROM overtime_requests o
    JOIN employees e ON e.id = o.employee_id
    WHERE e.company_id = p_company_id          -- 多租戶隔離
      AND (p_from IS NULL OR o.ot_date >= p_from)
      AND (p_to IS NULL OR o.ot_date <= p_to)
      AND (p_status IS NULL OR o.status = p_status)
    ORDER BY o.ot_date DESC, o.created_at DESC
    LIMIT GREATEST(COALESCE(p_limit, 1000), 1);
END;
$$;

-- 前端用 anon key 呼叫（身分驗證在函式內），顯式授權
GRANT EXECUTE ON FUNCTION get_company_overtime_requests(UUID, TEXT, DATE, DATE, TEXT, INTEGER)
    TO anon, authenticated;
