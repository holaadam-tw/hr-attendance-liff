-- ============================================================
-- Adam 多公司管理權限設定腳本
-- 已根據實際資料修改完成，可直接執行
-- ============================================================

-- Adam 的 LINE User ID: U895669e3fe46a9008d4d612b884ef984
-- 公司 1: 大正科技機械股份有限公司 (PROPISTON)
-- 公司 2: 本米股份有限公司 (本米)

-- ===== Step 1: 建立/更新 Adam 的平台管理員記錄 =====

INSERT INTO platform_admins (line_user_id, name, role, is_active)
VALUES (
    'U895669e3fe46a9008d4d612b884ef984',  -- ⚠️ 請改為 Adam 的實際 LINE User ID
    'Adam',
    'platform_admin',
    true
)
ON CONFLICT (line_user_id)
DO UPDATE SET
    name = EXCLUDED.name,
    is_active = EXCLUDED.is_active;

-- 確認 Adam 的記錄
SELECT id, line_user_id, name, role, is_active, created_at
FROM platform_admins
WHERE line_user_id = 'U895669e3fe46a9008d4d612b884ef984';  -- ⚠️ 請改為 Adam 的實際 LINE User ID

-- ===== Step 2: 連結 Adam 到所有公司 =====

-- 連結 Adam 到兩間公司 (都是 owner 角色)
WITH adam AS (
    SELECT id FROM platform_admins WHERE line_user_id = 'U895669e3fe46a9008d4d612b884ef984'
)
INSERT INTO platform_admin_companies (platform_admin_id, company_id, role)
SELECT adam.id, c.id, 'owner'
FROM adam, companies c
WHERE c.code IN (
    'PROPISTON',  -- 大正科技機械股份有限公司
    '本米'         -- 本米股份有限公司
)
ON CONFLICT (platform_admin_id, company_id) DO NOTHING;

-- 確認連結結果
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
WHERE pa.line_user_id = 'U895669e3fe46a9008d4d612b884ef984'  -- ⚠️ 修改此處
ORDER BY c.name;

-- ===== Step 3: 設定各公司的功能 (companies.features) =====

-- 大正科技機械 - 製造業公司 (HR + 外勤 + 便當)
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

-- 本米 - 餐飲業公司 (HR + 訂單 + 會員 + 預約)
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

-- 顯示所有公司的功能設定
SELECT
    name,
    code,
    industry,
    status,
    (features->>'leave')::boolean AS "請假",
    (features->>'attendance')::boolean AS "考勤",
    (features->>'lunch')::boolean AS "便當",
    (features->>'fieldwork')::boolean AS "外勤",
    (features->>'store_ordering')::boolean AS "訂單",
    (features->>'qr_order')::boolean AS "掃碼",
    (features->>'kds')::boolean AS "廚房",
    (features->>'booking')::boolean AS "預約",
    (features->>'member')::boolean AS "會員"
FROM companies
ORDER BY industry, name;

-- 顯示 Adam 可管理的公司及其功能
SELECT
    c.name AS company_name,
    c.industry,
    pac.role AS adam_role,
    c.features
FROM platform_admin_companies pac
JOIN platform_admins pa ON pac.platform_admin_id = pa.id
JOIN companies c ON pac.company_id = c.id
WHERE pa.line_user_id = 'U895669e3fe46a9008d4d612b884ef984'  -- ⚠️ 修改此處
ORDER BY c.industry, c.name;

-- ===== 完成！=====
\echo ''
\echo '✅ 設定完成！請使用 verify-multicompany.sql 進行全面驗證'
