-- ============================================================
-- 015_menu_time_periods.sql
-- 多時段菜單：為分類加入可用時段設定
-- ============================================================

-- 加入時段欄位（JSONB 格式）
-- 範例值: [{"from":"06:00","to":"10:30","label":"早餐"},{"from":"11:00","to":"14:00","label":"午餐"}]
-- NULL 表示全天候可用（向下相容）
ALTER TABLE menu_categories ADD COLUMN IF NOT EXISTS time_periods JSONB DEFAULT NULL;

-- 加入 icon 欄位讓分類更易辨認
ALTER TABLE menu_categories ADD COLUMN IF NOT EXISTS icon TEXT DEFAULT NULL;
