-- ============================================================
-- 測試用：attendance／schedules 寫入者在正式庫的現況快照（2026-09-28 唯讀查詢）
--   疊在 phase0_prod_snapshot.sql 之後載入（該檔已有 attendance／schedules 的正式庫政策與 grant）。
--   來源：information_schema.columns、pg_constraint、pg_policies、pg_class.relacl、pg_proc.proacl、pg_trigger、
--         pg_get_functiondef（下方「正式庫原文」逐字取自正式庫）
--   正式庫的 postgres（表與函式的擁有者）不是 superuser、有 BYPASSRLS：這裡用 prod_postgres 模擬。
--   測試把資料表、函式擁有者都改成它，migration 也以它的身分套用，避免 PGlite 的 superuser 把權限問題蓋掉。
-- ============================================================
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'prod_postgres') THEN CREATE ROLE prod_postgres NOLOGIN BYPASSRLS; END IF;
END $$;
GRANT USAGE, CREATE ON SCHEMA public TO prod_postgres;
GRANT anon, authenticated, service_role TO prod_postgres;

-- auth.jwt()：attendance 的「Users can read own attendance」政策用得到（PostgREST 的 request.jwt.claims）
CREATE SCHEMA IF NOT EXISTS auth;
CREATE OR REPLACE FUNCTION auth.jwt() RETURNS jsonb LANGUAGE sql STABLE AS
$$ SELECT coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb, '{}'::jsonb) $$;
GRANT USAGE ON SCHEMA auth TO anon, authenticated, service_role, prod_postgres;
GRANT EXECUTE ON FUNCTION auth.jwt() TO anon, authenticated, service_role, prod_postgres;

-- ---- 欄位補齊到正式庫（phase0 快照只放它用得到的欄位）----
ALTER TABLE public.attendance
  ALTER COLUMN employee_id SET NOT NULL,
  ALTER COLUMN date SET NOT NULL,
  ALTER COLUMN date SET DEFAULT ((now() AT TIME ZONE 'Asia/Taipei'::text))::date,
  ALTER COLUMN total_work_hours TYPE numeric(5,2),
  ADD COLUMN IF NOT EXISTS photo_url text,
  ADD COLUMN IF NOT EXISTS device_info text,
  ADD COLUMN IF NOT EXISTS created_at timestamptz DEFAULT now(),
  ADD COLUMN IF NOT EXISTS latitude double precision,
  ADD COLUMN IF NOT EXISTS longitude double precision,
  ADD COLUMN IF NOT EXISTS device_id text,
  ADD COLUMN IF NOT EXISTS schedule_id uuid,
  ADD COLUMN IF NOT EXISTS shift_type_id uuid,
  ADD COLUMN IF NOT EXISTS overtime_hours numeric DEFAULT 0,
  ADD COLUMN IF NOT EXISTS is_holiday_work boolean DEFAULT false,
  ADD COLUMN IF NOT EXISTS late_minutes integer DEFAULT 0,
  ADD COLUMN IF NOT EXISTS status text DEFAULT 'present'::text,
  ADD COLUMN IF NOT EXISTS checkout_latitude double precision,
  ADD COLUMN IF NOT EXISTS checkout_longitude double precision;
ALTER TABLE public.employees
  ADD COLUMN IF NOT EXISTS join_date date,
  ADD COLUMN IF NOT EXISTS id_last_four varchar(4),
  ADD COLUMN IF NOT EXISTS email varchar(100),
  ADD COLUMN IF NOT EXISTS check_in_lat numeric(10,8),
  ADD COLUMN IF NOT EXISTS check_in_lng numeric(11,8),
  ADD COLUMN IF NOT EXISTS max_distance_meters integer DEFAULT 100,
  ADD COLUMN IF NOT EXISTS is_admin boolean DEFAULT false,
  ADD COLUMN IF NOT EXISTS device_info text,
  ADD COLUMN IF NOT EXISTS salary_type text DEFAULT 'hourly'::text,
  ADD COLUMN IF NOT EXISTS hourly_rate numeric(10,2) DEFAULT 196,
  ADD COLUMN IF NOT EXISTS verify_code text;
ALTER TABLE public.schedules
  ALTER COLUMN date SET NOT NULL,
  ALTER COLUMN scheduled_at SET DEFAULT now(),
  ADD COLUMN IF NOT EXISTS is_holiday boolean DEFAULT false,
  ADD COLUMN IF NOT EXISTS created_by uuid,
  ADD COLUMN IF NOT EXISTS created_at timestamptz DEFAULT now(),
  ADD COLUMN IF NOT EXISTS updated_at timestamptz DEFAULT now();
ALTER TABLE public.shift_types
  ADD COLUMN IF NOT EXISTS work_hours numeric DEFAULT 8,
  ADD COLUMN IF NOT EXISTS break_minutes integer DEFAULT 60,
  ADD COLUMN IF NOT EXISTS night_allowance numeric DEFAULT 0,
  ADD COLUMN IF NOT EXISTS color text DEFAULT '#667eea'::text,
  ADD COLUMN IF NOT EXISTS created_at timestamptz DEFAULT now();

CREATE TABLE IF NOT EXISTS public.system_settings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), key varchar(100) NOT NULL, value jsonb NOT NULL, description text,
  updated_at timestamptz DEFAULT now(), company_id uuid NOT NULL REFERENCES public.companies(id)
);
ALTER TABLE public.system_settings ENABLE ROW LEVEL SECURITY;
GRANT ALL ON public.system_settings TO anon, authenticated, service_role;

CREATE TABLE IF NOT EXISTS public.attendance_anomalies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), company_id uuid NOT NULL REFERENCES public.companies(id),
  employee_id uuid NOT NULL REFERENCES public.employees(id), date date NOT NULL,
  anomaly_type text NOT NULL DEFAULT 'missing_checkout'::text,
  status text NOT NULL DEFAULT 'pending'::text CHECK (status = ANY (ARRAY['pending'::text, 'resolved'::text])),
  notify_count integer NOT NULL DEFAULT 0, notified_at timestamptz, resolved_at timestamptz,
  resolution text CHECK ((resolution IS NULL) OR (resolution = ANY (ARRAY['makeup'::text, 'leave'::text, 'manual'::text, 'system_reconciled'::text]))),
  resolved_by uuid REFERENCES public.employees(id), created_at timestamptz NOT NULL DEFAULT now(), details jsonb NOT NULL DEFAULT '{}'::jsonb,
  UNIQUE (employee_id, date, anomaly_type)
);
ALTER TABLE public.attendance_anomalies ENABLE ROW LEVEL SECURITY;
GRANT ALL ON public.attendance_anomalies TO anon, authenticated, service_role;

-- shift_swap_requests：正式庫 RLS 開，唯一政策「Allow all for authenticated」的套用對象其實是 PUBLIC（含 anon）
CREATE TABLE IF NOT EXISTS public.shift_swap_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), requester_id uuid REFERENCES public.employees(id), target_id uuid REFERENCES public.employees(id),
  swap_date date NOT NULL, requester_original_shift text, target_original_shift text, reason text,
  status text DEFAULT 'pending_target'::text CHECK (status = ANY (ARRAY['pending_target'::text, 'pending_admin'::text, 'approved'::text, 'rejected'::text, 'cancelled'::text])),
  target_agreed boolean, rejection_reason text, approved_by uuid REFERENCES public.employees(id), created_at timestamptz DEFAULT now(),
  approver_id uuid REFERENCES public.employees(id), approved_at timestamptz
);
ALTER TABLE public.shift_swap_requests ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Allow all for authenticated" ON public.shift_swap_requests FOR ALL TO public USING (true) WITH CHECK (true);
GRANT ALL ON public.shift_swap_requests TO anon, authenticated, service_role;

-- shift_types：正式庫 SELECT 政策 true、grant 全開（寫入沒有政策 → RLS 擋）
CREATE POLICY "shift_types_read" ON public.shift_types FOR SELECT TO public USING (true);
GRANT ALL ON public.shift_types TO anon, authenticated;

-- attendance 第 6 條政策（phase0 快照已有其餘 5 條）；grant 補到正式庫的 arwdDxtm（含 MAINTAIN）
CREATE POLICY "Users can read own attendance" ON public.attendance FOR SELECT TO anon, authenticated
  USING (employee_id IN (SELECT employees.id FROM employees WHERE ((employees.line_user_id)::text = (auth.jwt() ->> 'sub'::text))));
GRANT ALL ON public.attendance, public.schedules TO anon, authenticated;
ALTER TABLE public.attendance
  ADD CONSTRAINT attendance_schedule_id_fkey FOREIGN KEY (schedule_id) REFERENCES public.schedules(id),
  ADD CONSTRAINT attendance_shift_type_id_fkey FOREIGN KEY (shift_type_id) REFERENCES public.shift_types(id);

-- ↓↓↓ 正式庫原文（pg_get_functiondef，2026-09-28）↓↓↓
CREATE OR REPLACE FUNCTION public.lunch_overlap_hours(p_company_id uuid, p_date date, p_start timestamp without time zone, p_end timestamp without time zone)
 RETURNS numeric
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
AS $function$
DECLARE
    v_lunch_start TIME;
    v_lunch_end TIME;
    v_overlap NUMERIC := 0;
BEGIN
    IF p_company_id IS NULL OR p_date IS NULL
       OR p_start IS NULL OR p_end IS NULL OR p_end <= p_start THEN
        RETURN 0;
    END IF;

    SELECT NULLIF(value #>> '{}', '')::TIME INTO v_lunch_start
    FROM system_settings
    WHERE company_id = p_company_id AND key = 'lunch_break_start';

    SELECT NULLIF(value #>> '{}', '')::TIME INTO v_lunch_end
    FROM system_settings
    WHERE company_id = p_company_id AND key = 'lunch_break_end';

    IF v_lunch_start IS NULL OR v_lunch_end IS NULL OR v_lunch_end <= v_lunch_start THEN
        RETURN 0;
    END IF;

    -- 當日午休視窗重疊 + 翌日午休視窗重疊（跨日班）
    v_overlap :=
        GREATEST(0, EXTRACT(EPOCH FROM (
            LEAST(p_end, p_date + v_lunch_end) - GREATEST(p_start, p_date + v_lunch_start)
        )) / 3600.0)
      + GREATEST(0, EXTRACT(EPOCH FROM (
            LEAST(p_end, (p_date + 1) + v_lunch_end) - GREATEST(p_start, (p_date + 1) + v_lunch_start)
        )) / 3600.0);

    RETURN v_overlap::numeric;
END;
$function$;

CREATE OR REPLACE FUNCTION public.calc_work_hours()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
DECLARE
    v_company_id UUID;
    v_lunch NUMERIC := 0;
BEGIN
    IF NEW.check_in_time IS NOT NULL AND NEW.check_out_time IS NOT NULL THEN
        SELECT e.company_id INTO v_company_id
        FROM employees e
        WHERE e.id = NEW.employee_id;

        v_lunch := lunch_overlap_hours(
            v_company_id,
            NEW.date,
            (NEW.check_in_time AT TIME ZONE 'Asia/Taipei'),
            (NEW.check_out_time AT TIME ZONE 'Asia/Taipei')
        );

        NEW.total_work_hours := GREATEST(0, ROUND(
            (EXTRACT(EPOCH FROM (NEW.check_out_time - NEW.check_in_time)) / 3600.0 - v_lunch)::numeric,
            2
        ));
    END IF;
    NEW.updated_at := now();
    RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.resolve_anomaly_on_checkout()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
BEGIN
    IF NEW.check_out_time IS NOT NULL AND OLD.check_out_time IS NULL THEN
        UPDATE attendance_anomalies
        SET status = 'resolved',
            resolution = 'makeup',
            resolved_at = now()
        WHERE employee_id = NEW.employee_id
          AND date = NEW.date
          AND anomaly_type = 'missing_checkout'
          AND status = 'pending';
    END IF;
    RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.quick_check_in(p_line_user_id text, p_latitude double precision, p_longitude double precision, p_photo_url text DEFAULT NULL::text, p_device_id text DEFAULT NULL::text, p_action text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
DECLARE
    v_employee RECORD;
    v_today DATE;
    v_now TIMESTAMPTZ;
    v_tw_time TIME;
    v_existing RECORD;
    v_location_name TEXT;
    v_locations JSONB;
    v_loc JSONB;
    v_dist DOUBLE PRECISION;
    v_min_dist DOUBLE PRECISION := 999999;
    v_matched_location TEXT;
    v_is_late BOOLEAN := false;
    v_is_early_leave BOOLEAN := false;
    v_shift_start TIME;
    v_shift_end TIME;
    v_is_overnight BOOLEAN := false;
    v_late_threshold INTEGER;
    v_early_threshold INTEGER;
    v_checkout_limit NUMERIC;
    v_setting_val TEXT;
    v_schedule RECORD;
    v_schedule_found BOOLEAN := false;
    v_do_check_in BOOLEAN := false;
    v_do_check_out BOOLEAN := false;
    v_yesterday_is_overnight BOOLEAN := false;
    v_target_work_date DATE;
    v_is_weekend BOOLEAN := false;
    v_checkout_local TIMESTAMP;
    v_checkout_deadline TIMESTAMP;
    v_has_pending_checkin BOOLEAN := false;
BEGIN
    v_now := now();
    v_today := (now() AT TIME ZONE 'Asia/Taipei')::date;
    v_tw_time := (now() AT TIME ZONE 'Asia/Taipei')::time;
    -- 123：遲到／早退以「分」為單位判定，秒數捨去（08:00:47 是 08:00，不是遲到；08:01:00 起才是）
    v_tw_time := date_trunc('minute', (now() AT TIME ZONE 'Asia/Taipei'))::time;

    SELECT * INTO v_employee
    FROM employees
    WHERE line_user_id = p_line_user_id
      AND is_active = true
    LIMIT 1;

    IF v_employee.id IS NULL THEN
        RETURN jsonb_build_object('success', false, 'error', 'employee_not_found');
    END IF;

    IF COALESCE(v_employee.is_kiosk, false) THEN
        RETURN jsonb_build_object('success', false, 'error', 'kiosk_employee_must_use_kiosk');
    END IF;

    IF COALESCE(v_employee.no_checkin, false) THEN
        RETURN jsonb_build_object('success', false, 'error', 'employee_no_checkin');
    END IF;

    SELECT value #>> '{}' INTO v_setting_val
    FROM system_settings
    WHERE key = 'checkout_time_limit_hours'
      AND company_id = v_employee.company_id;
    v_checkout_limit := COALESCE(v_setting_val, '4')::numeric;

    SELECT * INTO v_existing
    FROM attendance
    WHERE employee_id = v_employee.id
      AND date = v_today;

    IF v_existing.id IS NOT NULL AND v_existing.check_out_time IS NOT NULL THEN
        IF p_action = 'check_in' THEN
            RETURN jsonb_build_object('success', false, 'error', 'already_checked_in_today');
        ELSE
            RETURN jsonb_build_object('success', false, 'error', 'already_checked_out_today');
        END IF;
    END IF;

    IF v_existing.id IS NULL AND p_action IS DISTINCT FROM 'check_in' THEN
        DECLARE
            v_yesterday_rec RECORD;
            v_yesterday_shift_end TIME;
            v_yesterday_setting_val TEXT;
            v_yesterday_deadline TIMESTAMP;
            v_yesterday_is_weekend BOOLEAN := false;
        BEGIN
            SELECT * INTO v_yesterday_rec
            FROM attendance
            WHERE employee_id = v_employee.id
              AND date = v_today - 1
              AND check_out_time IS NULL;

            IF v_yesterday_rec.id IS NOT NULL THEN
                SELECT st.end_time, COALESCE(st.is_overnight, false)
                INTO v_yesterday_shift_end, v_yesterday_is_overnight
                FROM schedules s
                JOIN shift_types st ON st.id = s.shift_type_id
                WHERE s.employee_id = v_employee.id
                  AND s.date = v_yesterday_rec.date
                  AND s.is_off_day = false
                LIMIT 1;

                IF v_yesterday_shift_end IS NULL AND v_employee.fixed_shift_end IS NOT NULL THEN
                    v_yesterday_shift_end := v_employee.fixed_shift_end;
                END IF;

                IF v_yesterday_shift_end IS NULL THEN
                    v_yesterday_is_weekend := EXTRACT(DOW FROM v_yesterday_rec.date) IN (0, 6);
                    SELECT value #>> '{}' INTO v_yesterday_setting_val
                    FROM system_settings
                    WHERE key = CASE
                            WHEN v_yesterday_is_weekend THEN 'default_weekend_work_end'
                            ELSE 'default_weekday_work_end'
                        END
                      AND company_id = v_employee.company_id;

                    IF COALESCE(v_yesterday_setting_val, '') = '' THEN
                        SELECT value #>> '{}' INTO v_yesterday_setting_val
                        FROM system_settings
                        WHERE key = 'default_work_end'
                          AND company_id = v_employee.company_id;
                    END IF;

                    v_yesterday_shift_end := COALESCE(v_yesterday_setting_val, '17:00')::time;
                END IF;

                v_yesterday_deadline := v_yesterday_rec.date::timestamp
                    + v_yesterday_shift_end
                    + (v_checkout_limit || ' hours')::interval;

                IF v_yesterday_is_overnight THEN
                    v_yesterday_deadline := v_yesterday_deadline + interval '1 day';
                END IF;

                IF (v_now AT TIME ZONE 'Asia/Taipei') <= v_yesterday_deadline THEN
                    v_existing := v_yesterday_rec;
                END IF;
            END IF;
        END;
    END IF;

    IF p_action = 'check_in' THEN
        IF v_existing.id IS NOT NULL AND v_existing.check_out_time IS NULL THEN
            IF v_existing.date = v_today THEN
                RETURN jsonb_build_object('success', false, 'error', 'already_checked_in_today');
            ELSIF v_yesterday_is_overnight THEN
                RETURN jsonb_build_object('success', false, 'error', 'overnight_shift_needs_check_out');
            END IF;
            v_existing := NULL;
        END IF;
        v_do_check_in := true;
    ELSIF p_action = 'check_out' THEN
        -- === 107：上班卡卡在 GPS 待審時，讓下班卡打得進去 ===
        -- GPS 失敗時不寫 attendance，只送 makeup_punch_requests 待審。當天沒有
        -- attendance 列，傍晚下班就被 no_open_check_in_record 擋掉——員工得等主管
        -- 核准上班卡才打得了下班卡（E815 2026-06 有四天等 6~16 天，直接缺卡）。
        -- 只在「當天確實有待審／已核准的上班補卡申請」時放行，先建立當日空白列；
        -- 之後主管核准上班卡，approve_makeup_request 的 ON CONFLICT DO UPDATE 會把
        -- check_in_time 填回同一列，trg_calc_work_hours 重算工時。
        -- 完全沒來上班、也沒有任何申請的人仍然擋著，不會產生幽靈下班卡。
        IF v_existing.id IS NULL THEN
            SELECT true INTO v_has_pending_checkin
            FROM makeup_punch_requests
            WHERE employee_id = v_employee.id
              AND punch_date = v_today
              AND punch_type IN ('clock_in', 'check_in')
              AND status IN ('pending', 'approved')
            LIMIT 1;

            IF COALESCE(v_has_pending_checkin, false) THEN
                INSERT INTO attendance (employee_id, date)
                VALUES (v_employee.id, v_today)
                ON CONFLICT (employee_id, date) DO NOTHING;

                SELECT * INTO v_existing
                FROM attendance
                WHERE employee_id = v_employee.id
                  AND date = v_today;
            END IF;
        END IF;

        IF v_existing.id IS NULL OR v_existing.check_out_time IS NOT NULL THEN
            RETURN jsonb_build_object('success', false, 'error', 'no_open_check_in_record');
        END IF;
        v_do_check_out := true;
    ELSE
        IF v_existing.id IS NOT NULL AND v_existing.check_out_time IS NULL THEN
            v_do_check_out := true;
        ELSE
            v_do_check_in := true;
        END IF;
    END IF;

    IF v_do_check_out THEN
        v_schedule_found := false;

        SELECT s.*, st.end_time AS shift_end_time,
               st.start_time AS shift_start_time,
               COALESCE(st.is_overnight, false) AS shift_is_overnight
        INTO v_schedule
        FROM schedules s
        JOIN shift_types st ON st.id = s.shift_type_id
        WHERE s.employee_id = v_employee.id
          AND s.date = v_existing.date
          AND s.is_off_day = false
        LIMIT 1;

        IF FOUND THEN
            v_schedule_found := true;
        END IF;

        IF v_schedule_found THEN
            v_shift_end := v_schedule.shift_end_time;
            v_is_overnight := v_schedule.shift_is_overnight;
        ELSIF v_employee.fixed_shift_end IS NOT NULL THEN
            v_shift_end := v_employee.fixed_shift_end;
            v_is_overnight := false;
        ELSE
            v_target_work_date := v_existing.date;
            v_is_weekend := EXTRACT(DOW FROM v_target_work_date) IN (0, 6);

            SELECT value #>> '{}' INTO v_setting_val
            FROM system_settings
            WHERE key = CASE
                    WHEN v_is_weekend THEN 'default_weekend_work_end'
                    ELSE 'default_weekday_work_end'
                END
              AND company_id = v_employee.company_id;

            IF COALESCE(v_setting_val, '') = '' THEN
                SELECT value #>> '{}' INTO v_setting_val
                FROM system_settings
                WHERE key = 'default_work_end'
                  AND company_id = v_employee.company_id;
            END IF;

            v_shift_end := COALESCE(v_setting_val, '17:00')::time;
            v_is_overnight := false;
        END IF;

        v_checkout_local := v_now AT TIME ZONE 'Asia/Taipei';
        v_checkout_deadline := v_existing.date::timestamp
            + v_shift_end
            + (v_checkout_limit || ' hours')::interval;

        IF v_is_overnight THEN
            v_checkout_deadline := v_checkout_deadline + interval '1 day';
        END IF;

        IF v_checkout_local > v_checkout_deadline THEN
            RETURN jsonb_build_object(
                'success', false,
                'error', 'checkout_time_expired',
                'checkout_deadline', to_char(v_checkout_deadline, 'YYYY-MM-DD HH24:MI:SS')
            );
        END IF;

        SELECT value #>> '{}' INTO v_setting_val
        FROM system_settings
        WHERE key = 'early_leave_threshold_minutes'
          AND company_id = v_employee.company_id;
        v_early_threshold := COALESCE(v_setting_val, '0')::integer;

        IF v_existing.date = v_today THEN
            IF v_is_overnight THEN
                IF v_tw_time < v_shift_end
                   AND v_tw_time < (v_shift_end - (v_early_threshold || ' minutes')::interval) THEN
                    v_is_early_leave := true;
                END IF;
            ELSE
                -- 122：一般班只要比下班時間早（扣容忍分鐘）就算早退，不再限「下班前 2 小時內」
                -- （035 的 2 小時窗口是為了避免凌晨誤判，跨日班另有分支；有請假的日子由請假抵銷）
                IF v_tw_time < (v_shift_end - (v_early_threshold || ' minutes')::interval) THEN
                    v_is_early_leave := true;
                END IF;
            END IF;
        END IF;

        UPDATE attendance SET
            check_out_time = v_now,
            check_out_location = COALESCE(v_matched_location, check_in_location),
            checkout_latitude = p_latitude,
            checkout_longitude = p_longitude,
            total_work_hours = CASE
                WHEN check_in_time IS NOT NULL
                THEN ROUND((EXTRACT(EPOCH FROM (v_now - check_in_time)) / 3600)::numeric, 2)
                ELSE 0
            END,
            is_early_leave = v_is_early_leave,
            updated_at = now()
        WHERE id = v_existing.id;

        RETURN jsonb_build_object(
            'success', true,
            'type', 'check_out',
            'location_name', COALESCE(v_matched_location, v_existing.check_in_location),
            'is_early_leave', v_is_early_leave,
            'shift_end', v_shift_end::text,
            'overnight', (v_existing.date < v_today)
        );
    END IF;

    SELECT value INTO v_locations
    FROM system_settings
    WHERE key = 'office_locations'
      AND company_id = v_employee.company_id;

    IF v_locations IS NOT NULL AND jsonb_typeof(v_locations) = 'array'
       AND jsonb_array_length(v_locations) > 0 THEN
        FOR v_loc IN SELECT * FROM jsonb_array_elements(v_locations)
        LOOP
            v_dist := 6371000 * 2 * asin(sqrt(
                power(sin(radians((v_loc->>'lat')::double precision - p_latitude) / 2), 2) +
                cos(radians(p_latitude)) * cos(radians((v_loc->>'lat')::double precision)) *
                power(sin(radians((v_loc->>'lng')::double precision - p_longitude) / 2), 2)
            ));
            IF v_dist <= COALESCE((v_loc->>'radius')::double precision, 100) AND v_dist < v_min_dist THEN
                v_min_dist := v_dist;
                v_matched_location := v_loc->>'name';
            END IF;
        END LOOP;

        IF v_matched_location IS NULL THEN
            RETURN jsonb_build_object(
                'success', false,
                'error', 'outside_allowed_location',
                'min_distance', round(v_min_dist::numeric, 0)
            );
        END IF;
    END IF;

    v_location_name := COALESCE(v_matched_location, 'unspecified_location');

    SELECT value #>> '{}' INTO v_setting_val
    FROM system_settings
    WHERE key = 'late_threshold_minutes'
      AND company_id = v_employee.company_id;
    v_late_threshold := COALESCE(v_setting_val, '9999')::integer;

    v_schedule_found := false;

    SELECT s.*, st.start_time AS shift_start_time,
           st.end_time AS shift_end_time,
           COALESCE(st.is_overnight, false) AS shift_is_overnight
    INTO v_schedule
    FROM schedules s
    JOIN shift_types st ON st.id = s.shift_type_id
    WHERE s.employee_id = v_employee.id
      AND s.date = v_today
      AND s.is_off_day = false
    LIMIT 1;

    IF FOUND THEN
        v_schedule_found := true;
    END IF;

    IF v_schedule_found THEN
        v_shift_start := v_schedule.shift_start_time;
    ELSIF v_employee.fixed_shift_start IS NOT NULL THEN
        v_shift_start := v_employee.fixed_shift_start;
    ELSE
        v_target_work_date := v_today;
        v_is_weekend := EXTRACT(DOW FROM v_target_work_date) IN (0, 6);

        SELECT value #>> '{}' INTO v_setting_val
        FROM system_settings
        WHERE key = CASE
                WHEN v_is_weekend THEN 'default_weekend_work_start'
                ELSE 'default_weekday_work_start'
            END
          AND company_id = v_employee.company_id;

        IF COALESCE(v_setting_val, '') = '' THEN
            SELECT value #>> '{}' INTO v_setting_val
            FROM system_settings
            WHERE key = 'default_work_start'
              AND company_id = v_employee.company_id;
        END IF;

        v_shift_start := COALESCE(v_setting_val, '08:00')::time;
    END IF;

    IF v_late_threshold >= 9999 THEN
        v_is_late := false;
    ELSIF v_tw_time > (v_shift_start + (v_late_threshold || ' minutes')::interval) THEN
        v_is_late := true;
    END IF;

    BEGIN
        INSERT INTO attendance (
            employee_id, date, check_in_time, photo_url,
            check_in_location, latitude, longitude,
            device_id, is_late, schedule_id, shift_type_id
        ) VALUES (
            v_employee.id, v_today, v_now, p_photo_url,
            v_location_name, p_latitude, p_longitude,
            p_device_id, v_is_late,
            CASE WHEN v_schedule_found THEN v_schedule.id ELSE NULL END,
            CASE WHEN v_schedule_found THEN v_schedule.shift_type_id ELSE NULL END
        );
    EXCEPTION WHEN unique_violation THEN
        SELECT * INTO v_existing
        FROM attendance
        WHERE employee_id = v_employee.id AND date = v_today;

        IF v_existing.id IS NOT NULL AND v_existing.check_out_time IS NULL AND p_action IS DISTINCT FROM 'check_in' THEN
            UPDATE attendance SET
                check_out_time = v_now,
                check_out_location = v_location_name,
                checkout_latitude = p_latitude,
                checkout_longitude = p_longitude,
                total_work_hours = CASE
                    WHEN v_existing.check_in_time IS NOT NULL
                    THEN ROUND((EXTRACT(EPOCH FROM (v_now - v_existing.check_in_time)) / 3600)::numeric, 2)
                    ELSE 0
                END,
                updated_at = now()
            WHERE id = v_existing.id;
            RETURN jsonb_build_object('success', true, 'type', 'check_out', 'location_name', v_location_name);
        END IF;

        IF p_action = 'check_in' THEN
            RETURN jsonb_build_object('success', false, 'error', 'already_checked_in_today');
        END IF;
        RETURN jsonb_build_object('success', false, 'error', 'already_checked_out_today');
    END;

    RETURN jsonb_build_object(
        'success', true,
        'type', 'check_in',
        'location_name', v_location_name,
        'is_late', v_is_late,
        'shift_start', v_shift_start::text
    );

EXCEPTION WHEN OTHERS THEN
    RETURN jsonb_build_object('success', false, 'error', SQLERRM);
END;
$function$;

CREATE OR REPLACE FUNCTION public.quick_check_out_after_clock_in_makeup(p_line_user_id text, p_latitude double precision, p_longitude double precision, p_photo_url text DEFAULT NULL::text, p_device_id text DEFAULT NULL::text, p_action text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
DECLARE
    v_employee RECORD;
    v_makeup RECORD;
    v_existing RECORD;
    v_today DATE;
    v_result JSONB;
    v_created_placeholder BOOLEAN := false;
BEGIN
    IF p_action IS DISTINCT FROM 'check_out' THEN
        RETURN jsonb_build_object('success', false, 'error', 'unsupported_action');
    END IF;

    v_today := (now() AT TIME ZONE 'Asia/Taipei')::date;

    SELECT *
    INTO v_employee
    FROM employees
    WHERE line_user_id = p_line_user_id
      AND is_active = true
    LIMIT 1;

    IF v_employee.id IS NULL THEN
        RETURN jsonb_build_object('success', false, 'error', 'employee_not_found');
    END IF;

    SELECT *
    INTO v_makeup
    FROM makeup_punch_requests
    WHERE employee_id = v_employee.id
      AND punch_date = v_today
      AND punch_type IN ('clock_in', 'check_in')
      AND status IN ('pending', 'approved')
    ORDER BY CASE WHEN status = 'approved' THEN 0 ELSE 1 END, created_at DESC
    LIMIT 1;

    IF v_makeup.id IS NULL THEN
        RETURN jsonb_build_object('success', false, 'error', 'no_open_check_in_record');
    END IF;

    SELECT *
    INTO v_existing
    FROM attendance
    WHERE employee_id = v_employee.id
      AND date = v_today;

    IF v_existing.id IS NULL THEN
        INSERT INTO attendance (
            employee_id, date, is_manual, notes
        ) VALUES (
            v_employee.id,
            v_today,
            true,
            '等待上班補打卡審核，已允許照實下班打卡'
        )
        ON CONFLICT (employee_id, date) DO NOTHING
        RETURNING * INTO v_existing;

        IF v_existing.id IS NULL THEN
            SELECT *
            INTO v_existing
            FROM attendance
            WHERE employee_id = v_employee.id
              AND date = v_today;
        ELSE
            v_created_placeholder := true;
        END IF;
    END IF;

    IF v_existing.check_out_time IS NOT NULL THEN
        RETURN jsonb_build_object('success', false, 'error', 'already_checked_out_today');
    END IF;

    v_result := quick_check_in(
        p_line_user_id,
        p_latitude,
        p_longitude,
        p_photo_url,
        p_device_id,
        'check_out'
    );

    IF COALESCE((v_result->>'success')::BOOLEAN, false) THEN
        UPDATE attendance
        SET notes = TRIM(COALESCE(notes, '') || ' 上班補打卡狀態：' || v_makeup.status),
            updated_at = now()
        WHERE employee_id = v_employee.id
          AND date = v_today;

        RETURN v_result || jsonb_build_object(
            'clock_in_makeup_status', v_makeup.status,
            'clock_in_makeup_request_id', v_makeup.id
        );
    END IF;

    IF v_created_placeholder THEN
        DELETE FROM attendance
        WHERE id = v_existing.id
          AND check_in_time IS NULL
          AND check_out_time IS NULL;
    END IF;

    RETURN v_result;

EXCEPTION WHEN OTHERS THEN
    IF v_created_placeholder AND v_existing.id IS NOT NULL THEN
        DELETE FROM attendance
        WHERE id = v_existing.id
          AND check_in_time IS NULL
          AND check_out_time IS NULL;
    END IF;

    RETURN jsonb_build_object('success', false, 'error', SQLERRM);
END;
$function$;

CREATE OR REPLACE FUNCTION public.kiosk_check_in(p_kiosk_line_user_id text, p_employee_id uuid, p_action text, p_photo_url text DEFAULT NULL::text, p_latitude double precision DEFAULT NULL::double precision, p_longitude double precision DEFAULT NULL::double precision)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
DECLARE
    v_kiosk RECORD;
    v_employee RECORD;
    v_today DATE;
    v_now TIMESTAMPTZ;
    v_tw_time TIME;
    v_existing RECORD;
    v_is_late BOOLEAN := false;
    v_is_early_leave BOOLEAN := false;
    v_shift_start TIME;
    v_shift_end TIME;
    v_late_threshold INTEGER;
    v_early_threshold INTEGER;
    v_setting_val TEXT;
    v_schedule RECORD;
    v_schedule_found BOOLEAN := false;
BEGIN
    v_now := now();
    v_today := (now() AT TIME ZONE 'Asia/Taipei')::date;
    v_tw_time := (now() AT TIME ZONE 'Asia/Taipei')::time;

    -- 驗證 caller 是公務機帳號
    SELECT id, company_id INTO v_kiosk
    FROM employees
    WHERE line_user_id = p_kiosk_line_user_id
      AND is_active = true
      AND COALESCE(is_kiosk, false) = true
    LIMIT 1;

    IF v_kiosk.id IS NULL THEN
        RETURN jsonb_build_object('success', false, 'error', '此帳號非公務機');
    END IF;

    -- 查詢目標員工（同公司）
    SELECT * INTO v_employee
    FROM employees
    WHERE id = p_employee_id
      AND is_active = true
      AND company_id = v_kiosk.company_id;

    IF v_employee.id IS NULL THEN
        RETURN jsonb_build_object('success', false, 'error', '找不到員工資料');
    END IF;

    -- 查詢今天打卡記錄
    SELECT * INTO v_existing
    FROM attendance
    WHERE employee_id = v_employee.id
      AND date = v_today;

    -- ========== 下班打卡 ==========
    IF p_action = 'check_out' THEN
        IF v_existing.id IS NULL OR v_existing.check_out_time IS NOT NULL THEN
            RETURN jsonb_build_object('success', false, 'error', '請先完成上班打卡');
        END IF;

        v_schedule_found := false;

        IF COALESCE(v_employee.shift_mode, 'fixed') = 'scheduled' THEN
            SELECT st.end_time AS shift_end_time
            INTO v_schedule
            FROM schedules s
            JOIN shift_types st ON st.id = s.shift_type_id
            WHERE s.employee_id = v_employee.id
              AND s.date = v_today
              AND s.is_off_day = false
            LIMIT 1;

            IF FOUND THEN
                v_schedule_found := true;
            END IF;
        END IF;

        IF v_schedule_found THEN
            IF v_schedule.shift_end_time IS NOT NULL THEN
                v_shift_end := v_schedule.shift_end_time;
            END IF;
        END IF;

        IF v_shift_end IS NULL THEN
            IF v_employee.fixed_shift_end IS NOT NULL THEN
                v_shift_end := v_employee.fixed_shift_end;
            ELSE
                SELECT value INTO v_setting_val
                FROM system_settings
                WHERE key = 'default_work_end'
                  AND company_id = v_employee.company_id;
                v_shift_end := COALESCE(v_setting_val, '17:00')::time;
            END IF;
        END IF;

        SELECT value INTO v_setting_val
        FROM system_settings
        WHERE key = 'early_leave_threshold_minutes'
          AND company_id = v_employee.company_id;
        v_early_threshold := COALESCE(v_setting_val, '0')::integer;

        IF v_tw_time >= (v_shift_end - interval '2 hours')
           AND v_tw_time < (v_shift_end - (v_early_threshold || ' minutes')::interval) THEN
            v_is_early_leave := true;
        END IF;

        UPDATE attendance SET
            check_out_time = v_now,
            check_out_location = '公務機打卡',
            total_work_hours = CASE
                WHEN check_in_time IS NOT NULL
                THEN ROUND((EXTRACT(EPOCH FROM (v_now - check_in_time)) / 3600)::numeric, 2)
                ELSE 0
            END,
            is_early_leave = v_is_early_leave,
            updated_at = now()
        WHERE id = v_existing.id;

        RETURN jsonb_build_object(
            'success', true,
            'type', 'check_out',
            'name', v_employee.name,
            'is_early_leave', v_is_early_leave
        );
    END IF;

    -- ========== 上班打卡 ==========
    IF v_existing.id IS NOT NULL THEN
        IF v_existing.check_out_time IS NOT NULL THEN
            RETURN jsonb_build_object('success', false, 'error', '今日已完成上下班打卡');
        ELSE
            RETURN jsonb_build_object('success', false, 'error', '今日已完成上班打卡');
        END IF;
    END IF;

    SELECT value INTO v_setting_val
    FROM system_settings
    WHERE key = 'late_threshold_minutes'
      AND company_id = v_employee.company_id;
    v_late_threshold := COALESCE(v_setting_val, '5')::integer;

    v_schedule_found := false;

    IF COALESCE(v_employee.shift_mode, 'fixed') = 'scheduled' THEN
        SELECT st.start_time AS shift_start
        INTO v_schedule
        FROM schedules s
        JOIN shift_types st ON st.id = s.shift_type_id
        WHERE s.employee_id = v_employee.id
          AND s.date = v_today
          AND s.is_off_day = false
        LIMIT 1;

        IF FOUND THEN
            v_schedule_found := true;
        END IF;
    END IF;

    IF v_schedule_found THEN
        IF v_schedule.shift_start IS NOT NULL THEN
            v_shift_start := v_schedule.shift_start;
        END IF;
    END IF;

    IF v_shift_start IS NULL THEN
        IF v_employee.fixed_shift_start IS NOT NULL THEN
            v_shift_start := v_employee.fixed_shift_start;
        ELSE
            SELECT value INTO v_setting_val
            FROM system_settings
            WHERE key = 'default_work_start'
              AND company_id = v_employee.company_id;
            v_shift_start := COALESCE(v_setting_val, '08:00')::time;
        END IF;
    END IF;

    IF v_tw_time > (v_shift_start + (v_late_threshold || ' minutes')::interval) THEN
        v_is_late := true;
    END IF;

    INSERT INTO attendance (
        employee_id, date, check_in_time, photo_url,
        check_in_location, latitude, longitude,
        device_id, is_late
    ) VALUES (
        v_employee.id, v_today, v_now, p_photo_url,
        '公務機打卡', p_latitude, p_longitude,
        'kiosk', v_is_late
    );

    RETURN jsonb_build_object(
        'success', true,
        'type', 'check_in',
        'name', v_employee.name,
        'is_late', v_is_late,
        'shift_start', v_shift_start::text
    );

EXCEPTION WHEN unique_violation THEN
    RETURN jsonb_build_object('success', false, 'error', '今日已完成打卡');
WHEN OTHERS THEN
    RETURN jsonb_build_object('success', false, 'error', SQLERRM);
END;
$function$;

CREATE OR REPLACE FUNCTION public.admin_makeup_punch(p_company_id uuid, p_line_user_id text, p_employee_id uuid, p_punch_date date, p_punch_type text, p_punch_time time without time zone, p_note text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
    v_today DATE;
    v_now_time TIME;
    v_operator RECORD;
    v_target RECORD;
    v_existing RECORD;
    v_in_time TIME;
    v_out_time TIME;
    v_normalized_type TEXT;
    v_check_time TIMESTAMPTZ;
    v_overwrote BOOLEAN := false;
    v_anomaly_resolved INTEGER := 0;
    v_closed_pending INTEGER := 0;
    v_reason TEXT;
BEGIN
    -- === 1. 呼叫者身分驗證（092 模式）===
    IF p_line_user_id IS NULL OR p_line_user_id = '' THEN
        RETURN jsonb_build_object('success', false, 'error', '未提供身份驗證資訊');
    END IF;

    SELECT e.id, e.name
    INTO v_operator
    FROM employees e
    WHERE e.company_id = p_company_id
      AND e.line_user_id = p_line_user_id
      AND e.is_active = true
      AND e.role IN ('admin', 'manager')
    LIMIT 1;

    IF v_operator.id IS NULL THEN
        RETURN jsonb_build_object('success', false, 'error', '需要管理員權限');
    END IF;

    -- === 2. 參數驗證 ===
    v_normalized_type := CASE
        WHEN p_punch_type IN ('check_in', 'clock_in') THEN 'clock_in'
        WHEN p_punch_type IN ('check_out', 'clock_out') THEN 'clock_out'
        ELSE p_punch_type
    END;

    IF v_normalized_type NOT IN ('clock_in', 'clock_out') THEN
        RETURN jsonb_build_object('success', false, 'error', 'invalid_punch_type');
    END IF;

    IF p_punch_date IS NULL THEN
        RETURN jsonb_build_object('success', false, 'error', '請選擇補登日期');
    END IF;

    IF p_punch_time IS NULL THEN
        RETURN jsonb_build_object('success', false, 'error', '請填寫補登時間');
    END IF;

    v_today := (now() AT TIME ZONE 'Asia/Taipei')::date;
    v_now_time := (now() AT TIME ZONE 'Asia/Taipei')::time;

    -- 不設回溯下限（管理員不限時間），但未來日期一律擋
    IF p_punch_date > v_today THEN
        RETURN jsonb_build_object(
            'success', false,
            'error', '補登日期不能是未來日期',
            'code', 'punch_date_in_future',
            'today', v_today
        );
    END IF;

    -- 補當天時，時間不得晚於現在（106）
    IF p_punch_date = v_today AND p_punch_time > v_now_time THEN
        RETURN jsonb_build_object(
            'success', false,
            'error', '補登時間不能是未來時間（現在 ' || to_char(v_now_time, 'HH24:MI') || '）',
            'code', 'punch_time_in_future',
            'now', to_char(v_now_time, 'HH24:MI')
        );
    END IF;

    -- === 3. 目標員工必須屬於同一家公司（多租戶隔離）===
    SELECT e.id, e.name, e.employee_number
    INTO v_target
    FROM employees e
    WHERE e.id = p_employee_id
      AND e.company_id = p_company_id
      AND e.is_active = true
    LIMIT 1;

    IF v_target.id IS NULL THEN
        RETURN jsonb_build_object('success', false, 'error', '找不到員工（或不屬於本公司）');
    END IF;

    -- === 4. 寫入 attendance（比照 086）===
    v_check_time := (p_punch_date::text || ' ' || p_punch_time::text || '+08')::timestamptz;
    v_reason := '管理員補登（' || COALESCE(v_operator.name, '') || '）';

    SELECT a.check_in_time, a.check_out_time
    INTO v_existing
    FROM attendance a
    WHERE a.employee_id = v_target.id
      AND a.date = p_punch_date;

    -- 與當日既有打卡的先後順序驗證（106）
    v_in_time  := (v_existing.check_in_time  AT TIME ZONE 'Asia/Taipei')::time;
    v_out_time := (v_existing.check_out_time AT TIME ZONE 'Asia/Taipei')::time;

    IF v_normalized_type = 'clock_out'
       AND v_in_time IS NOT NULL
       AND p_punch_time <= v_in_time THEN
        RETURN jsonb_build_object(
            'success', false,
            'error', '下班時間不能早於當日上班時間（' || to_char(v_in_time, 'HH24:MI') || '），請確認是否誤填上午／下午',
            'code', 'checkout_before_checkin',
            'check_in', to_char(v_in_time, 'HH24:MI')
        );
    END IF;

    IF v_normalized_type = 'clock_in'
       AND v_out_time IS NOT NULL
       AND p_punch_time >= v_out_time THEN
        RETURN jsonb_build_object(
            'success', false,
            'error', '上班時間不能晚於當日下班時間（' || to_char(v_out_time, 'HH24:MI') || '），請確認是否誤填上午／下午',
            'code', 'checkin_after_checkout',
            'check_out', to_char(v_out_time, 'HH24:MI')
        );
    END IF;

    IF v_normalized_type = 'clock_in' THEN
        v_overwrote := v_existing.check_in_time IS NOT NULL;

        INSERT INTO attendance (
            employee_id, date, check_in_time, check_in_location, is_manual, notes
        ) VALUES (
            v_target.id, p_punch_date, v_check_time, 'admin makeup', true,
            v_reason || COALESCE(' - ' || NULLIF(p_note, ''), '')
        )
        ON CONFLICT (employee_id, date) DO UPDATE
        SET check_in_time = v_check_time,
            check_in_location = 'admin makeup',
            is_manual = true,
            is_late = false,   -- 121：補登的上班卡不算遲到
            notes = TRIM(COALESCE(attendance.notes, '') || ' ' || v_reason
                         || COALESCE(' - ' || NULLIF(p_note, ''), '')),
            updated_at = now();
    ELSE
        v_overwrote := v_existing.check_out_time IS NOT NULL;

        UPDATE attendance
        SET check_out_time = v_check_time,
            check_out_location = 'admin makeup',
            is_manual = true,
            is_early_leave = false,   -- 121：補登的下班卡不算早退
            notes = TRIM(COALESCE(notes, '') || ' ' || v_reason
                         || COALESCE(' - ' || NULLIF(p_note, ''), '')),
            updated_at = now()
        WHERE employee_id = v_target.id
          AND date = p_punch_date;

        IF NOT FOUND THEN
            INSERT INTO attendance (
                employee_id, date, check_out_time, check_out_location, is_manual, notes
            ) VALUES (
                v_target.id, p_punch_date, v_check_time, 'admin makeup', true,
                v_reason || COALESCE(' - ' || NULLIF(p_note, ''), '')
            );
        END IF;
    END IF;

    -- === 5. 補打卡記錄留軌跡（已核准狀態）===
    INSERT INTO makeup_punch_requests (
        employee_id, punch_date, punch_type, punch_time,
        reason, note, status, approver_id, approved_at
    ) VALUES (
        v_target.id, p_punch_date, v_normalized_type, p_punch_time,
        v_reason, p_note, 'approved', v_operator.id, now()
    );

    -- === 6. 關掉同員工同日同類型仍 pending 的申請，避免重複核准再寫一次 ===
    UPDATE makeup_punch_requests
    SET status = 'rejected',
        approver_id = v_operator.id,
        approved_at = now(),
        rejection_reason = '管理員已直接補登，無需再審核'
    WHERE employee_id = v_target.id
      AND punch_date = p_punch_date
      AND (
          (v_normalized_type = 'clock_in' AND punch_type IN ('clock_in', 'check_in'))
          OR (v_normalized_type = 'clock_out' AND punch_type IN ('clock_out', 'check_out'))
      )
      AND status = 'pending';

    GET DIAGNOSTICS v_closed_pending = ROW_COUNT;

    -- === 7. 缺卡追蹤結案 ===
    -- 補下班卡時 trg_resolve_anomaly_on_checkout（092）會先自動結案，但 trigger
    -- 不知道操作者是誰、resolved_by 會留空。所以條件除了 pending，也涵蓋
    -- 「剛被 trigger 結成 makeup 但沒有 resolved_by」的那筆，把操作者補上。
    -- UNIQUE (employee_id, date, anomaly_type) 保證只會命中同一筆，不會誤傷別天。
    IF v_normalized_type = 'clock_out' THEN
        UPDATE attendance_anomalies
        SET status = 'resolved',
            resolution = 'makeup',
            resolved_at = now(),
            resolved_by = v_operator.id
        WHERE employee_id = v_target.id
          AND date = p_punch_date
          AND anomaly_type = 'missing_checkout'
          AND (
              status = 'pending'
              OR (status = 'resolved' AND resolution = 'makeup' AND resolved_by IS NULL)
          );

        GET DIAGNOSTICS v_anomaly_resolved = ROW_COUNT;
    END IF;

    RETURN jsonb_build_object(
        'success', true,
        'employee_name', v_target.name,
        'employee_number', v_target.employee_number,
        'punch_type', v_normalized_type,
        'overwrote', v_overwrote,
        'closed_pending', v_closed_pending,
        'anomaly_resolved', v_anomaly_resolved
    );

EXCEPTION WHEN OTHERS THEN
    RETURN jsonb_build_object('success', false, 'error', SQLERRM);
END;
$function$;

CREATE OR REPLACE FUNCTION public.submit_makeup_punch(p_line_user_id text, p_punch_date date, p_punch_type text, p_punch_time time without time zone, p_reason text, p_note text DEFAULT NULL::text, p_company_id uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
    -- 與前端 common.js MAKEUP_PUNCH_WINDOW_DAYS 同步（含當天回溯 7 天）
    v_window_days CONSTANT INTEGER := 7;
    v_today DATE;
    v_now_time TIME;
    v_earliest DATE;
    v_employee_id UUID;
    v_normalized_type TEXT;
    v_existing RECORD;
    v_att RECORD;
    v_in_time TIME;
    v_out_time TIME;
BEGIN
    v_normalized_type := CASE
        WHEN p_punch_type IN ('check_in', 'clock_in') THEN 'clock_in'
        WHEN p_punch_type IN ('check_out', 'clock_out') THEN 'clock_out'
        ELSE p_punch_type
    END;

    IF v_normalized_type NOT IN ('clock_in', 'clock_out') THEN
        RETURN jsonb_build_object(
            'success', false,
            'error', 'invalid_punch_type'
        );
    END IF;

    -- === 日期窗口驗證（097）===
    v_today := (now() AT TIME ZONE 'Asia/Taipei')::date;
    v_now_time := (now() AT TIME ZONE 'Asia/Taipei')::time;
    v_earliest := v_today - (v_window_days - 1);

    IF p_punch_date IS NULL THEN
        RETURN jsonb_build_object(
            'success', false,
            'error', '請選擇補打卡日期',
            'code', 'punch_date_required'
        );
    END IF;

    IF p_punch_date > v_today THEN
        RETURN jsonb_build_object(
            'success', false,
            'error', '補打卡日期不能是未來日期',
            'code', 'punch_date_in_future',
            'today', v_today
        );
    END IF;

    IF p_punch_date < v_earliest THEN
        RETURN jsonb_build_object(
            'success', false,
            'error', '補打卡限 ' || v_window_days || ' 天內（最早 ' || v_earliest || '），逾期請找主管處理',
            'code', 'punch_date_out_of_window',
            'earliest_allowed', v_earliest,
            'window_days', v_window_days
        );
    END IF;

    -- === 時間合理性驗證（106）===
    IF p_punch_time IS NULL THEN
        RETURN jsonb_build_object(
            'success', false,
            'error', '請填寫補打卡時間',
            'code', 'punch_time_required'
        );
    END IF;

    IF p_punch_date = v_today AND p_punch_time > v_now_time THEN
        RETURN jsonb_build_object(
            'success', false,
            'error', '補打卡時間不能是未來時間（現在 ' || to_char(v_now_time, 'HH24:MI') || '）',
            'code', 'punch_time_in_future',
            'now', to_char(v_now_time, 'HH24:MI')
        );
    END IF;

    -- === 員工認定：有帶 company_id 就限定該公司（098）===
    SELECT id
    INTO v_employee_id
    FROM employees
    WHERE line_user_id = p_line_user_id
      AND is_active = true
      AND (p_company_id IS NULL OR company_id = p_company_id)
    ORDER BY created_at
    LIMIT 1;

    IF v_employee_id IS NULL THEN
        RETURN jsonb_build_object(
            'success', false,
            'error', 'employee_not_found'
        );
    END IF;

    -- === 與當日既有打卡的先後順序驗證（106）===
    SELECT a.check_in_time, a.check_out_time
    INTO v_att
    FROM attendance a
    WHERE a.employee_id = v_employee_id
      AND a.date = p_punch_date;

    v_in_time  := (v_att.check_in_time  AT TIME ZONE 'Asia/Taipei')::time;
    v_out_time := (v_att.check_out_time AT TIME ZONE 'Asia/Taipei')::time;

    IF v_normalized_type = 'clock_out'
       AND v_in_time IS NOT NULL
       AND p_punch_time <= v_in_time THEN
        RETURN jsonb_build_object(
            'success', false,
            'error', '下班時間不能早於當日上班時間（' || to_char(v_in_time, 'HH24:MI') || '），請確認是否誤填上午／下午',
            'code', 'checkout_before_checkin',
            'check_in', to_char(v_in_time, 'HH24:MI')
        );
    END IF;

    IF v_normalized_type = 'clock_in'
       AND v_out_time IS NOT NULL
       AND p_punch_time >= v_out_time THEN
        RETURN jsonb_build_object(
            'success', false,
            'error', '上班時間不能晚於當日下班時間（' || to_char(v_out_time, 'HH24:MI') || '），請確認是否誤填上午／下午',
            'code', 'checkin_after_checkout',
            'check_out', to_char(v_out_time, 'HH24:MI')
        );
    END IF;

    SELECT id, status
    INTO v_existing
    FROM makeup_punch_requests
    WHERE employee_id = v_employee_id
      AND punch_date = p_punch_date
      AND punch_type = v_normalized_type
      AND status IN ('pending', 'approved')
    ORDER BY created_at DESC
    LIMIT 1;

    IF v_existing.id IS NOT NULL THEN
        RETURN jsonb_build_object(
            'success', false,
            'error', '同一天同類型已有補打卡申請，請勿重複送出',
            'code', 'duplicate_makeup_request',
            'existing_status', v_existing.status,
            'existing_request_id', v_existing.id
        );
    END IF;

    INSERT INTO makeup_punch_requests (
        employee_id,
        punch_date,
        punch_type,
        punch_time,
        reason,
        note,
        status
    ) VALUES (
        v_employee_id,
        p_punch_date,
        v_normalized_type,
        p_punch_time,
        p_reason,
        p_note,
        'pending'
    );

    RETURN jsonb_build_object('success', true);

EXCEPTION WHEN OTHERS THEN
    RETURN jsonb_build_object('success', false, 'error', SQLERRM);
END;
$function$;
-- ↑↑↑ 正式庫原文 ↑↑↑

CREATE TRIGGER trg_calc_work_hours BEFORE INSERT OR UPDATE OF check_in_time, check_out_time ON public.attendance FOR EACH ROW EXECUTE FUNCTION calc_work_hours();
CREATE TRIGGER trg_resolve_anomaly_on_checkout AFTER UPDATE ON public.attendance FOR EACH ROW EXECUTE FUNCTION resolve_anomaly_on_checkout();

-- 正式庫 proacl
REVOKE ALL ON FUNCTION public.lunch_overlap_hours(uuid, date, timestamp without time zone, timestamp without time zone), public.calc_work_hours(),
  public.quick_check_in(text, double precision, double precision, text, text, text),
  public.admin_makeup_punch(uuid, text, uuid, date, text, time without time zone, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.lunch_overlap_hours(uuid, date, timestamp without time zone, timestamp without time zone), public.calc_work_hours() TO service_role;
GRANT EXECUTE ON FUNCTION public.quick_check_in(text, double precision, double precision, text, text, text),
  public.admin_makeup_punch(uuid, text, uuid, date, text, time without time zone, text) TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.resolve_anomaly_on_checkout(),
  public.quick_check_out_after_clock_in_makeup(text, double precision, double precision, text, text, text),
  public.kiosk_check_in(text, uuid, text, text, double precision, double precision),
  public.submit_makeup_punch(text, date, text, time without time zone, text, text, uuid) TO PUBLIC, anon, authenticated, service_role;

-- 擁有者改成 prod_postgres（非 superuser、BYPASSRLS），與正式庫的 postgres 同處境
DO $$ DECLARE r record; BEGIN
  FOR r IN SELECT c.oid::regclass AS t FROM pg_class c WHERE c.relnamespace = 'public'::regnamespace AND c.relkind = 'r' LOOP
    EXECUTE format('ALTER TABLE %s OWNER TO prod_postgres', r.t);
  END LOOP;
  FOR r IN SELECT p.oid::regprocedure AS f FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace LOOP
    EXECUTE format('ALTER FUNCTION %s OWNER TO prod_postgres', r.f);
  END LOOP;
END $$;
