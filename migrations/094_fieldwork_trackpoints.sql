-- ============================================================
-- 094_fieldwork_trackpoints.sql
-- 外勤行程軌跡點：追蹤模式（LIFF 前景期間每 60s 記錄）+ 90 天自動清理
-- 搭配 093 field_work_trips；軌跡點只可寫入不可竄改（無 UPDATE/DELETE grant）
-- 可重複執行
-- ============================================================

-- ========================
-- 1. 軌跡點表
-- ========================
CREATE TABLE IF NOT EXISTS field_work_trackpoints (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    trip_id UUID NOT NULL REFERENCES field_work_trips(id),
    employee_id UUID NOT NULL REFERENCES employees(id),
    company_id UUID NOT NULL REFERENCES companies(id),
    recorded_at TIMESTAMPTZ NOT NULL,
    lat DOUBLE PRECISION NOT NULL,
    lng DOUBLE PRECISION NOT NULL,
    accuracy NUMERIC,
    created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_fwtp_trip_time ON field_work_trackpoints(trip_id, recorded_at);
CREATE INDEX IF NOT EXISTS idx_fwtp_company_time ON field_work_trackpoints(company_id, recorded_at);

-- ========================
-- 2. 權限：連續 GPS 軌跡屬敏感個資，DB 層 deny-all（RLS 無 policy），
--    讀寫一律走下方 SECURITY DEFINER RPC（比照 092 attendance_anomalies 模式）
--    注意：Supabase default privileges 會自動給新表完整權限，必須明確 REVOKE
-- ========================
ALTER TABLE field_work_trackpoints ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON field_work_trackpoints FROM anon, authenticated;

-- 093 補強：field_work_trips 也被 default privileges 給了 DELETE，收回（行程不可刪）
REVOKE DELETE ON field_work_trips FROM anon, authenticated;

-- ========================
-- 2a. RPC：寫入軌跡點（僅行程本人、行程必須 open；employee_id/company_id 以 DB 為準防偽造）
-- ========================
CREATE OR REPLACE FUNCTION insert_fw_trackpoints(p_line_user_id TEXT, p_trip_id UUID, p_points JSONB)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_trip RECORD;
    v_pt JSONB;
    v_total INTEGER;
    v_inserted INTEGER := 0;
BEGIN
    IF p_line_user_id IS NULL OR p_line_user_id = '' THEN
        RAISE EXCEPTION '未提供身份驗證資訊';
    END IF;
    IF p_points IS NULL OR jsonb_typeof(p_points) <> 'array' OR jsonb_array_length(p_points) = 0 THEN
        RAISE EXCEPTION '無軌跡點資料';
    END IF;
    IF jsonb_array_length(p_points) > 50 THEN
        RAISE EXCEPTION '單次最多 50 點';
    END IF;

    SELECT t.id, t.employee_id, t.company_id, t.status INTO v_trip
    FROM field_work_trips t
    JOIN employees e ON e.id = t.employee_id
    WHERE t.id = p_trip_id
      AND e.line_user_id = p_line_user_id
      AND e.is_active = true;

    IF v_trip.id IS NULL THEN
        RAISE EXCEPTION '找不到行程或無權限';
    END IF;
    IF v_trip.status <> 'open' THEN
        RAISE EXCEPTION '行程已收工，無法寫入軌跡';
    END IF;

    FOR v_pt IN SELECT * FROM jsonb_array_elements(p_points) LOOP
        IF v_pt->>'lat' IS NULL OR v_pt->>'lng' IS NULL OR v_pt->>'recorded_at' IS NULL THEN
            CONTINUE; -- 略過不完整的點
        END IF;
        INSERT INTO field_work_trackpoints (trip_id, employee_id, company_id, recorded_at, lat, lng, accuracy)
        VALUES (
            v_trip.id, v_trip.employee_id, v_trip.company_id,
            (v_pt->>'recorded_at')::TIMESTAMPTZ,
            (v_pt->>'lat')::DOUBLE PRECISION,
            (v_pt->>'lng')::DOUBLE PRECISION,
            NULLIF(v_pt->>'accuracy', '')::NUMERIC
        );
        v_inserted := v_inserted + 1;
    END LOOP;

    SELECT count(*)::INTEGER INTO v_total FROM field_work_trackpoints WHERE trip_id = v_trip.id;
    RETURN v_total;
END;
$$;

-- ========================
-- 2b. RPC：查詢軌跡點（行程本人，或該公司 admin/manager，或 platform_admin）
-- ========================
CREATE OR REPLACE FUNCTION get_fw_trackpoints(p_line_user_id TEXT, p_trip_id UUID)
RETURNS TABLE(recorded_at TIMESTAMPTZ, lat DOUBLE PRECISION, lng DOUBLE PRECISION)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_trip RECORD;
    v_allowed BOOLEAN := false;
BEGIN
    IF p_line_user_id IS NULL OR p_line_user_id = '' THEN
        RAISE EXCEPTION '未提供身份驗證資訊';
    END IF;

    SELECT t.id, t.employee_id, t.company_id INTO v_trip
    FROM field_work_trips t WHERE t.id = p_trip_id;
    IF v_trip.id IS NULL THEN
        RAISE EXCEPTION '找不到行程';
    END IF;

    -- 本人
    SELECT EXISTS (
        SELECT 1 FROM employees e
        WHERE e.id = v_trip.employee_id AND e.line_user_id = p_line_user_id AND e.is_active = true
    ) INTO v_allowed;
    -- 同公司 admin/manager
    IF NOT v_allowed THEN
        SELECT EXISTS (
            SELECT 1 FROM employees e
            WHERE e.company_id = v_trip.company_id
              AND e.line_user_id = p_line_user_id
              AND e.is_active = true
              AND e.role IN ('admin', 'manager')
        ) INTO v_allowed;
    END IF;
    -- platform_admin
    IF NOT v_allowed THEN
        SELECT EXISTS (
            SELECT 1 FROM platform_admins pa WHERE pa.line_user_id = p_line_user_id
        ) INTO v_allowed;
    END IF;

    IF NOT v_allowed THEN
        RAISE EXCEPTION '需要管理員權限';
    END IF;

    RETURN QUERY
    SELECT tp.recorded_at, tp.lat, tp.lng
    FROM field_work_trackpoints tp
    WHERE tp.trip_id = p_trip_id
    ORDER BY tp.recorded_at
    LIMIT 2000;
END;
$$;

-- ========================
-- 2c. RPC：軌跡點計數（權限同 2b；員工端顯示「已記 N 點」用）
-- ========================
CREATE OR REPLACE FUNCTION count_fw_trackpoints(p_line_user_id TEXT, p_trip_id UUID)
RETURNS INTEGER
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_cnt INTEGER;
BEGIN
    -- 借用 get_fw_trackpoints 的權限檢查（會在無權限時 RAISE）
    PERFORM 1 FROM get_fw_trackpoints(p_line_user_id, p_trip_id) LIMIT 1;
    SELECT count(*)::INTEGER INTO v_cnt FROM field_work_trackpoints WHERE trip_id = p_trip_id;
    RETURN v_cnt;
END;
$$;

GRANT EXECUTE ON FUNCTION insert_fw_trackpoints(TEXT, UUID, JSONB) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION get_fw_trackpoints(TEXT, UUID) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION count_fw_trackpoints(TEXT, UUID) TO anon, authenticated;

-- ========================
-- 3. 90 天自動清理（每日 18:30 UTC = 台灣 02:30）
-- ========================
DO $do$
BEGIN
    PERFORM cron.unschedule('purge-fw-trackpoints');
EXCEPTION WHEN OTHERS THEN
    NULL; -- job 不存在時忽略
END
$do$;

SELECT cron.schedule(
    'purge-fw-trackpoints',
    '30 18 * * *',
    $$DELETE FROM field_work_trackpoints WHERE recorded_at < now() - interval '90 days'$$
);
