-- ============================================================
-- 多公司架構驗證腳本
-- 執行此腳本以檢查 Multi-Company 架構的資料庫狀態
-- ============================================================

-- ===== Step 1: 檢查 Migration 012 是否已執行 =====
\echo ''
\echo '===== Step 1: 檢查 Migration 012 ====='

SELECT
    CASE
        WHEN EXISTS (
            SELECT 1 FROM information_schema.tables
            WHERE table_name = 'platform_admin_companies'
        ) THEN '✅ platform_admin_companies 表已存在'
        ELSE '❌ platform_admin_companies 表不存在 - 需要執行 migration 012'
    END AS migration_status;

-- 檢查表結構
SELECT
    column_name,
    data_type,
    is_nullable,
    column_default
FROM information_schema.columns
WHERE table_name = 'platform_admin_companies'
ORDER BY ordinal_position;

-- ===== Step 2: 檢查現有的平台管理員 =====
\echo ''
\echo '===== Step 2: 平台管理員清單 ====='

SELECT
    id,
    line_user_id,
    name,
    role,
    is_active,
    created_at
FROM platform_admins
ORDER BY created_at DESC;

-- ===== Step 3: 檢查現有公司清單 =====
\echo ''
\echo '===== Step 3: 公司清單 ====='

SELECT
    id,
    code,
    name,
    industry,
    status,
    plan_type,
    features,
    created_at
FROM companies
ORDER BY created_at;

-- ===== Step 4: 檢查平台管理員與公司的連結 =====
\echo ''
\echo '===== Step 4: 平台管理員 ↔ 公司連結 ====='

SELECT
    pa.name AS admin_name,
    pa.line_user_id,
    c.name AS company_name,
    c.code AS company_code,
    c.industry,
    pac.role,
    pac.created_at
FROM platform_admin_companies pac
JOIN platform_admins pa ON pac.platform_admin_id = pa.id
JOIN companies c ON pac.company_id = c.id
ORDER BY pa.name, c.name;

-- ===== Step 5: 統計摘要 =====
\echo ''
\echo '===== Step 5: 統計摘要 ====='

WITH stats AS (
    SELECT
        (SELECT COUNT(*) FROM platform_admins WHERE is_active = true) AS active_admins,
        (SELECT COUNT(*) FROM companies WHERE status = 'active') AS active_companies,
        (SELECT COUNT(*) FROM platform_admin_companies) AS admin_company_links,
        (SELECT COUNT(DISTINCT platform_admin_id) FROM platform_admin_companies) AS admins_with_companies,
        (SELECT COUNT(*) FROM store_profiles) AS total_stores
)
SELECT
    '平台管理員 (活躍)' AS metric, active_admins::text AS value FROM stats
UNION ALL
SELECT '公司 (活躍)', active_companies::text FROM stats
UNION ALL
SELECT '管理員↔公司連結數', admin_company_links::text FROM stats
UNION ALL
SELECT '已分配公司的管理員數', admins_with_companies::text FROM stats
UNION ALL
SELECT '商店總數', total_stores::text FROM stats;

-- ===== Step 6: 功能設定檢查 =====
\echo ''
\echo '===== Step 6: 各公司的功能設定 ====='

SELECT
    name AS company_name,
    industry,
    (features->>'leave')::boolean AS leave,
    (features->>'attendance')::boolean AS attendance,
    (features->>'lunch')::boolean AS lunch,
    (features->>'fieldwork')::boolean AS fieldwork,
    (features->>'store_ordering')::boolean AS store_ordering,
    (features->>'qr_order')::boolean AS qr_order,
    (features->>'kds')::boolean AS kds,
    (features->>'booking')::boolean AS booking,
    (features->>'member')::boolean AS member
FROM companies
ORDER BY industry, name;
