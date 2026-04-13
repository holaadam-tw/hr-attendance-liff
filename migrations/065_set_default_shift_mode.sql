-- ============================================================
-- 065: 確保所有員工都有 shift_mode
--
-- 部分員工 shift_mode 為 NULL，導致排班/打卡邏輯不確定
-- 預設為 'fixed'（固定班），業主可在員工編輯中改為排班制
-- ============================================================

UPDATE employees
SET shift_mode = 'fixed',
    fixed_shift_start = COALESCE(fixed_shift_start, '08:00'),
    fixed_shift_end = COALESCE(fixed_shift_end, '17:00')
WHERE shift_mode IS NULL;
