-- 034: 新增本米土城店打卡地點
-- 地址：新北市土城區中央路二段135號
-- GPS：24.976995, 121.442323
-- 半徑：300 公尺

INSERT INTO office_locations (company_id, name, latitude, longitude, radius, is_active)
SELECT id, '本米土城店', 24.976995, 121.442323, 300, true
FROM companies
WHERE id::text LIKE 'fb1f6b5f%'
  AND NOT EXISTS (
    SELECT 1 FROM office_locations ol
    WHERE ol.company_id = companies.id
      AND ol.name = '本米土城店'
  );
