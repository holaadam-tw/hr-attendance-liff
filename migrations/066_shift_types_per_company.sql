-- ============================================================
-- 066: shift_types 按公司隔離
--
-- 現有 3 個全域班別（company_id IS NULL）複製給每個公司
-- 確保每個公司有自己的班別可以自訂
-- ============================================================

-- 複製全域班別給每個公司（如果該公司還沒有）
INSERT INTO shift_types (company_id, code, name, start_time, end_time, is_overnight, work_hours, break_minutes, color, is_active)
SELECT c.id, st.code, st.name, st.start_time, st.end_time, st.is_overnight, st.work_hours, st.break_minutes, st.color, st.is_active
FROM companies c
CROSS JOIN shift_types st
WHERE st.company_id IS NULL
  AND NOT EXISTS (
    SELECT 1 FROM shift_types ex
    WHERE ex.company_id = c.id AND ex.code = st.code
  );

-- 標記全域班別為 inactive（已複製給各公司）
UPDATE shift_types SET is_active = false WHERE company_id IS NULL;
