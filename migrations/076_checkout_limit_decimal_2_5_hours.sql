-- ============================================================
-- 076: support decimal checkout limit and set Benmi to 2.5 hours
--
-- Policy:
-- Benmi employees may check out until 2.5 hours after scheduled end.
-- Example: 17:00 -> 19:30, 21:30 -> 00:00.
--
-- Fix:
-- quick_check_in now reads checkout_time_limit_hours as NUMERIC,
-- so fractional values like 2.5 are valid.
-- ============================================================

CREATE OR REPLACE FUNCTION quick_check_in(
    p_line_user_id TEXT,
    p_latitude DOUBLE PRECISION,
    p_longitude DOUBLE PRECISION,
    p_photo_url TEXT DEFAULT NULL,
    p_device_id TEXT DEFAULT NULL,
    p_action TEXT DEFAULT NULL
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
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
BEGIN
    v_now := now();
    v_today := (now() AT TIME ZONE 'Asia/Taipei')::date;
    v_tw_time := (now() AT TIME ZONE 'Asia/Taipei')::time;

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
                IF v_tw_time >= (v_shift_end - interval '2 hours')
                   AND v_tw_time < (v_shift_end - (v_early_threshold || ' minutes')::interval) THEN
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
$$;

UPDATE system_settings
SET
    value = to_jsonb(2.5::numeric),
    description = 'Benmi checkout limit hours (2.5h after scheduled end)',
    updated_at = now()
WHERE company_id = 'fb1f6b5f-dcd5-4262-a7de-e7c357662639'::uuid
  AND key = 'checkout_time_limit_hours';

INSERT INTO system_settings (company_id, key, value, description)
SELECT
    'fb1f6b5f-dcd5-4262-a7de-e7c357662639'::uuid,
    'checkout_time_limit_hours',
    to_jsonb(2.5::numeric),
    'Benmi checkout limit hours (2.5h after scheduled end)'
WHERE NOT EXISTS (
    SELECT 1
    FROM system_settings
    WHERE company_id = 'fb1f6b5f-dcd5-4262-a7de-e7c357662639'::uuid
      AND key = 'checkout_time_limit_hours'
);
