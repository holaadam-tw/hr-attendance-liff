-- ============================================================
-- Adam 多公司管理權限設定 - 可直接執行
-- 執行日期: 2026-02-21
-- ============================================================
-- Adam LINE ID: U895669e3fe46a9008d4d612b884ef984
-- 公司 1: 大正科技機械 (PROPISTON) - 製造業
-- 公司 2: 本米 (本米) - 餐飲業
-- ============================================================

-- ===== Step 1: 建立 Adam 的平台管理員記錄 =====

INSERT INTO platform_admins (line_user_id, name, role, is_active)
VALUES (
    'U895669e3fe46a9008d4d612b884ef984',
    'Adam',
    'platform_admin',
    true
)
ON CONFLICT (line_user_id)
DO UPDATE SET
    name = EXCLUDED.name,
    is_active = EXCLUDED.is_active;

-- ===== Step 2: 連結 Adam 到兩間公司 =====

WITH adam AS (
    SELECT id FROM platform_admins WHERE line_user_id = 'U895669e3fe46a9008d4d612b884ef984'
)
INSERT INTO platform_admin_companies (platform_admin_id, company_id, role)
SELECT adam.id, c.id, 'owner'
FROM adam, companies c
WHERE c.code IN ('PROPISTON', '本米')
ON CONFLICT (platform_admin_id, company_id) DO NOTHING;

-- ===== Step 3: 設定各公司的功能 =====

-- 大正科技機械 - 製造業 (HR + 外勤 + 便當)
UPDATE companies
SET
    features = '{
        "leave": true,
        "attendance": true,
        "schedule": true,
        "salary": true,
        "lunch": true,
        "fieldwork": true,
        "sales_target": true,
        "store_ordering": false,
        "qr_order": false,
        "kds": false,
        "booking": false,
        "member": false
    }'::jsonb,
    industry = 'manufacturing'
WHERE code = 'PROPISTON';

-- 本米 - 餐飲業 (HR + 訂單 + 會員 + 預約)
UPDATE companies
SET
    features = '{
        "leave": true,
        "attendance": true,
        "schedule": true,
        "salary": true,
        "lunch": false,
        "fieldwork": false,
        "sales_target": false,
        "store_ordering": true,
        "qr_order": true,
        "kds": true,
        "booking": true,
        "member": true
    }'::jsonb,
    industry = 'restaurant'
WHERE code = '本米';

-- ===== Step 4: 驗證設定結果 =====

-- 顯示 Adam 的記錄
SELECT id, line_user_id, name, role, is_active, created_at
FROM platform_admins
WHERE line_user_id = 'U895669e3fe46a9008d4d612b884ef984';

-- 顯示 Adam 管理的公司
SELECT
    pa.name AS admin_name,
    c.name AS company_name,
    c.code,
    c.industry,
    pac.role,
    pac.created_at
FROM platform_admin_companies pac
JOIN platform_admins pa ON pac.platform_admin_id = pa.id
JOIN companies c ON pac.company_id = c.id
WHERE pa.line_user_id = 'U895669e3fe46a9008d4d612b884ef984'
ORDER BY c.name;

-- 顯示兩間公司的功能設定
SELECT
    name AS 公司名稱,
    code AS 代碼,
    industry AS 產業,
    (features->>'leave')::boolean AS 請假,
    (features->>'attendance')::boolean AS 考勤,
    (features->>'schedule')::boolean AS 排班,
    (features->>'salary')::boolean AS 薪資,
    (features->>'lunch')::boolean AS 便當,
    (features->>'fieldwork')::boolean AS 外勤,
    (features->>'sales_target')::boolean AS 業務,
    (features->>'store_ordering')::boolean AS 訂單,
    (features->>'qr_order')::boolean AS 掃碼,
    (features->>'kds')::boolean AS 廚房,
    (features->>'booking')::boolean AS 預約,
    (features->>'member')::boolean AS 會員
FROM companies
WHERE code IN ('PROPISTON', '本米')
ORDER BY industry, name;

-- ===== 完成！ =====
SELECT '✅ 設定完成！Adam 現在可管理兩間公司' AS 結果;
