-- ============================================================
-- 105: 打卡失敗記錄（把「打不了卡」從黑洞變成可查資料）
--
-- 背景（2026-08-04 調查）：
--   員工反映「有打卡但系統說沒打卡」「下班打不了卡」，但系統對失敗
--   完全沒有留痕——只有成功的打卡才會寫 attendance，失敗的一律無記錄。
--   隔天缺卡追蹤跳出來時，分不出是忘了打、還是打了打不進去。
--
--   已查明的失敗路徑（checkin.html 兩個拍照流程各一份）：
--     1. gps_unavailable   — 定位權限被拒 / 逾時，前端根本送不出去
--     2. gps_too_precise   — accuracy < 下限（疑似模擬定位 App）
--     3. gps_low_accuracy  — accuracy > 500m，轉待審（員工以為打成功了）
--     4. outside_range     — 超出打卡範圍，轉待審（只會發生在上班）
--     5. RPC 回傳的各種 error（checkout_time_expired、no_open_check_in_record、
--        already_checked_out_today、employee_no_checkin ...）
--     6. photo / system    — 拍照壓縮、上傳、其他例外
--
-- 設計：
--   - checkin_failures：deny-all RLS（比照 094 field_work_trackpoints），
--     anon 直讀直寫全擋，只能走兩支 SECURITY DEFINER RPC。
--   - log_checkin_failure()：寫入。employee 由 DB 依 line_user_id 認定，
--     company_id 也由 DB 從員工身上取，前端傳什麼都不影響歸屬（防偽造）。
--     查無員工就直接回 false 不寫入，避免 anon 亂灌資料。
--   - get_checkin_failures()：讀取，admin/manager 限定（092 驗證模式）。
--
--   outcome 兩種語意要分清楚：
--     blocked        = 完全打不進去，員工必須另外處理
--     pending_review = 有送出但變成待審，員工看到成功畫面，
--                      在主管核准前系統仍視為沒打卡（這是抱怨的主要來源）
--
-- 注意事項：
--   - 記錄失敗絕對不能影響打卡本身：前端呼叫一律 fire-and-forget 包 try/catch，
--     這支 RPC 也不 RAISE，任何狀況都回 JSONB。
--   - detail 存 JSONB（accuracy_m、min_distance_m、error 原文、device 等），
--     欄位不固定，之後要加新的診斷資訊不必改 schema。
--   - 保留期限未做自動清除：量級極小（每天數筆），一年約 2000 筆。
-- ============================================================

CREATE TABLE IF NOT EXISTS checkin_failures (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    company_id UUID NOT NULL REFERENCES companies(id),
    employee_id UUID NOT NULL REFERENCES employees(id),
    punch_type TEXT,
    stage TEXT NOT NULL,
    failure_code TEXT NOT NULL,
    outcome TEXT NOT NULL DEFAULT 'blocked',
    detail JSONB,
    occurred_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_checkin_failures_company_time
    ON checkin_failures (company_id, occurred_at DESC);

-- deny-all：開 RLS 但不建任何 policy，另外明確收回預設權限
-- （鐵則：Supabase default privileges 會自動給新表 anon/authenticated 完整權限）
ALTER TABLE checkin_failures ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE checkin_failures FROM PUBLIC, anon, authenticated;

-- ============================================================
-- 寫入：員工與公司由 DB 認定，前端無法偽造歸屬
-- ============================================================
CREATE OR REPLACE FUNCTION log_checkin_failure(
    p_line_user_id TEXT,
    p_punch_type TEXT,
    p_stage TEXT,
    p_failure_code TEXT,
    p_outcome TEXT DEFAULT 'blocked',
    p_detail JSONB DEFAULT NULL,
    p_company_id UUID DEFAULT NULL
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_emp RECORD;
BEGIN
    IF p_line_user_id IS NULL OR p_line_user_id = '' THEN
        RETURN jsonb_build_object('success', false, 'error', 'no_identity');
    END IF;

    IF p_stage IS NULL OR p_failure_code IS NULL THEN
        RETURN jsonb_build_object('success', false, 'error', 'missing_fields');
    END IF;

    -- 跨公司員工：有帶 company_id 就限定，沒帶取最早建檔那筆（098 模式）
    SELECT e.id, e.company_id
    INTO v_emp
    FROM employees e
    WHERE e.line_user_id = p_line_user_id
      AND e.is_active = true
      AND (p_company_id IS NULL OR e.company_id = p_company_id)
    ORDER BY e.created_at
    LIMIT 1;

    -- 查無員工不寫入（擋掉 anon 亂灌）
    IF v_emp.id IS NULL THEN
        RETURN jsonb_build_object('success', false, 'error', 'employee_not_found');
    END IF;

    INSERT INTO checkin_failures (
        company_id, employee_id, punch_type, stage, failure_code, outcome, detail
    ) VALUES (
        v_emp.company_id,
        v_emp.id,
        CASE
            WHEN p_punch_type IN ('check_in', 'clock_in') THEN 'check_in'
            WHEN p_punch_type IN ('check_out', 'clock_out') THEN 'check_out'
            ELSE NULL
        END,
        left(p_stage, 40),
        left(p_failure_code, 80),
        CASE WHEN p_outcome = 'pending_review' THEN 'pending_review' ELSE 'blocked' END,
        p_detail
    );

    RETURN jsonb_build_object('success', true);

EXCEPTION WHEN OTHERS THEN
    -- 記錄失敗不能影響打卡流程，一律吞掉
    RETURN jsonb_build_object('success', false, 'error', SQLERRM);
END;
$$;

GRANT EXECUTE ON FUNCTION log_checkin_failure(TEXT, TEXT, TEXT, TEXT, TEXT, JSONB, UUID)
    TO anon, authenticated;

-- ============================================================
-- 讀取：admin/manager 限定（092 驗證模式）
-- ============================================================
CREATE OR REPLACE FUNCTION get_checkin_failures(
    p_company_id UUID,
    p_line_user_id TEXT,
    p_days INTEGER DEFAULT 7
) RETURNS TABLE (
    occurred_at TIMESTAMPTZ,
    employee_name TEXT,
    employee_number TEXT,
    punch_type TEXT,
    stage TEXT,
    failure_code TEXT,
    outcome TEXT,
    detail JSONB
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
    SELECT f.occurred_at,
           e.name::TEXT,
           e.employee_number::TEXT,
           f.punch_type,
           f.stage,
           f.failure_code,
           f.outcome,
           f.detail
    FROM checkin_failures f
    JOIN employees e ON e.id = f.employee_id
    WHERE f.company_id = p_company_id
      AND f.occurred_at >= now() - (GREATEST(COALESCE(p_days, 7), 1) || ' days')::interval
    ORDER BY f.occurred_at DESC
    LIMIT 300;
END;
$$;

GRANT EXECUTE ON FUNCTION get_checkin_failures(UUID, TEXT, INTEGER) TO anon, authenticated;
