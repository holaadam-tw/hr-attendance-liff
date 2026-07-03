-- ============================================================
-- 091: 員工「寬鬆定位」旗標（指定員工放寬 GPS 精度要求）
--
-- 背景：部分員工手機（尤其 iPhone 精確位置關閉）在廠內定位精度差
--   （~1400m），每次打卡被前端「精度>500m」擋下轉待審，天天補卡。
--   根因應由裝置端（開精確位置）解決；此旗標為指定員工的放寬機制。
--
-- 機制（Option A：只用半徑）：被標記 gps_relaxed 的員工，前端跳過
--   「精度不足轉待審」，直接把回報座標送 quick_check_in。quick_check_in
--   （076）本就只用座標比對打卡點半徑（不檢查精度）→ 座標在範圍內即
--   正常打卡、在範圍外仍走既有「範圍外待審」。等於「信任座標、不卡精度」，
--   範圍檢查與自拍照稽核都保留。預設 false → 對現有所有員工零影響。
-- ============================================================

ALTER TABLE employees ADD COLUMN IF NOT EXISTS gps_relaxed BOOLEAN DEFAULT false;

INSERT INTO _migrations (filename) VALUES ('091_employee_gps_relaxed.sql')
ON CONFLICT (filename) DO NOTHING;
