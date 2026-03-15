-- 019: service_time_slots.day_of_week 改為 TEXT 支援多選
-- 原本 INTEGER (單一數字)，改為 TEXT (JSON 陣列字串或 NULL)

ALTER TABLE service_time_slots
ALTER COLUMN day_of_week TYPE TEXT USING day_of_week::TEXT;

COMMENT ON COLUMN service_time_slots.day_of_week IS
'NULL=每天，JSON 陣列字串如 "[1,3]"=週一+週三（0=日,1=一,...,6=六）';
