-- 023_service_time_slots_range.sql
-- service_time_slots 新增結束時間欄位，讓時段可以設定區間

ALTER TABLE service_time_slots
ADD COLUMN IF NOT EXISTS slot_end_time TEXT;

COMMENT ON COLUMN service_time_slots.slot_time IS '開始時間 HH:MM';
COMMENT ON COLUMN service_time_slots.slot_end_time IS '結束時間 HH:MM';
