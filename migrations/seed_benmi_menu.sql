-- ============================================================
-- seed_benmi_menu.sql
-- 本米 Benmi - 土城中央路餐廳 菜單種子資料
-- Bánh mì Việt Nam 越南法國麵包
-- ============================================================

-- 先取得或建立商店 (使用 slug = 'benmi-tucheng')
-- 若商店已存在則跳過建立
INSERT INTO store_profiles (
    store_name, store_slug, description, phone, address,
    store_type, accept_orders, theme_color, is_active
) VALUES (
    '本米 Benmi - 土城中央路餐廳',
    'benmi-tucheng',
    'Bánh mì Việt Nam 越南法國麵包',
    NULL,
    '新北市土城區中央路二段149巷8-1號',
    'restaurant',
    true,
    '#E85D26',
    true
) ON CONFLICT (store_slug) DO NOTHING;

-- 取得 store_id
DO $$
DECLARE
    v_store_id UUID;
    v_cat_bread UUID;
    v_cat_set_l UUID;
    v_cat_set_m UUID;
    v_cat_drink UUID;
    v_cat_addon UUID;
BEGIN
    SELECT id INTO v_store_id FROM store_profiles WHERE store_slug = 'benmi-tucheng';
    IF v_store_id IS NULL THEN
        RAISE EXCEPTION 'Store benmi-tucheng not found';
    END IF;

    -- 清除舊菜單資料（若重複執行）
    DELETE FROM menu_items WHERE store_id = v_store_id;
    DELETE FROM menu_categories WHERE store_id = v_store_id;

    -- ========================
    -- 分大類 (Categories)
    -- ========================

    INSERT INTO menu_categories (store_id, name, sort_order)
    VALUES (v_store_id, '🥖 麵包單點 Bánh mì', 1)
    RETURNING id INTO v_cat_bread;

    INSERT INTO menu_categories (store_id, name, sort_order)
    VALUES (v_store_id, '🍱 大套餐 SET L-SIZE', 2)
    RETURNING id INTO v_cat_set_l;

    INSERT INTO menu_categories (store_id, name, sort_order)
    VALUES (v_store_id, '🍱 小套餐 SET Mini', 3)
    RETURNING id INTO v_cat_set_m;

    INSERT INTO menu_categories (store_id, name, sort_order)
    VALUES (v_store_id, '🥤 飲料 Drink', 4)
    RETURNING id INTO v_cat_drink;

    INSERT INTO menu_categories (store_id, name, sort_order)
    VALUES (v_store_id, '➕ 加料 Add-on', 5)
    RETURNING id INTO v_cat_addon;

    -- ========================
    -- 麵包單點 Bánh mì
    -- 每款有 Mini / L 兩種尺寸 (用 options)
    -- ========================

    -- 1. 燒肉法國麵包
    INSERT INTO menu_items (store_id, category_id, name, description, price, sort_order, options, tags)
    VALUES (v_store_id, v_cat_bread,
        '燒肉法國麵包', 'Bánh mì thịt nướng',
        80, 1,
        '[{"group":"尺寸","required":true,"items":[{"name":"Mini","price":56},{"name":"L-SIZE","price":80}]}]'::jsonb,
        ARRAY['推薦']
    );

    -- 2. 火腿法國麵包
    INSERT INTO menu_items (store_id, category_id, name, description, price, sort_order, options)
    VALUES (v_store_id, v_cat_bread,
        '火腿法國麵包', 'Bánh mì chả lụa',
        80, 2,
        '[{"group":"尺寸","required":true,"items":[{"name":"Mini","price":56},{"name":"L-SIZE","price":80}]}]'::jsonb
    );

    -- 3. 雞肉法國麵包
    INSERT INTO menu_items (store_id, category_id, name, description, price, sort_order, options)
    VALUES (v_store_id, v_cat_bread,
        '雞肉法國麵包', 'Bánh mì gà',
        90, 3,
        '[{"group":"尺寸","required":true,"items":[{"name":"Mini","price":66},{"name":"L-SIZE","price":90}]}]'::jsonb
    );

    -- 4. 烤肉法國麵包
    INSERT INTO menu_items (store_id, category_id, name, description, price, sort_order, options)
    VALUES (v_store_id, v_cat_bread,
        '烤肉法國麵包', 'Bánh mì thịt nướng đặc biệt',
        100, 4,
        '[{"group":"尺寸","required":true,"items":[{"name":"Mini","price":69},{"name":"L-SIZE","price":100}]}]'::jsonb
    );

    -- 5. 雙層烤肉法國麵包
    INSERT INTO menu_items (store_id, category_id, name, description, price, sort_order, options)
    VALUES (v_store_id, v_cat_bread,
        '雙層烤肉法國麵包', 'Bánh mì thịt nướng x2',
        130, 5,
        '[{"group":"尺寸","required":true,"items":[{"name":"Mini","price":79},{"name":"L-SIZE","price":130}]}]'::jsonb
    );

    -- 6. 綜合法國麵包
    INSERT INTO menu_items (store_id, category_id, name, description, price, sort_order, options)
    VALUES (v_store_id, v_cat_bread,
        '綜合法國麵包', 'Bánh mì đặc biệt (tổng hợp)',
        100, 6,
        '[{"group":"尺寸","required":true,"items":[{"name":"Mini","price":69},{"name":"L-SIZE","price":100}]}]'::jsonb
    );

    -- ========================
    -- 大套餐 SET L-SIZE (麵包 L + 飲料)
    -- ========================

    -- SET 1: 燒肉 + 越南咖啡
    INSERT INTO menu_items (store_id, category_id, name, description, price, sort_order, tags)
    VALUES (v_store_id, v_cat_set_l,
        'SET 1 燒肉 + 越南咖啡', '燒肉法國麵包 L-SIZE + 越南咖啡',
        120, 1, ARRAY['套餐']
    );

    -- SET 2: 燒肉 + 豆漿/紅茶
    INSERT INTO menu_items (store_id, category_id, name, description, price, sort_order, options)
    VALUES (v_store_id, v_cat_set_l,
        'SET 2 燒肉 + 豆漿/紅茶', '燒肉法國麵包 L-SIZE + 豆漿或紅茶',
        110, 2,
        '[{"group":"飲料","required":true,"items":[{"name":"豆漿","price":0},{"name":"紅茶","price":0}]}]'::jsonb
    );

    -- SET 3: 火腿 + 越南咖啡
    INSERT INTO menu_items (store_id, category_id, name, description, price, sort_order)
    VALUES (v_store_id, v_cat_set_l,
        'SET 3 火腿 + 越南咖啡', '火腿法國麵包 L-SIZE + 越南咖啡',
        120, 3
    );

    -- SET 4: 火腿 + 豆漿/紅茶
    INSERT INTO menu_items (store_id, category_id, name, description, price, sort_order, options)
    VALUES (v_store_id, v_cat_set_l,
        'SET 4 火腿 + 豆漿/紅茶', '火腿法國麵包 L-SIZE + 豆漿或紅茶',
        110, 4,
        '[{"group":"飲料","required":true,"items":[{"name":"豆漿","price":0},{"name":"紅茶","price":0}]}]'::jsonb
    );

    -- SET 5: 雞肉 + 越南咖啡
    INSERT INTO menu_items (store_id, category_id, name, description, price, sort_order)
    VALUES (v_store_id, v_cat_set_l,
        'SET 5 雞肉 + 越南咖啡', '雞肉法國麵包 L-SIZE + 越南咖啡',
        130, 5
    );

    -- SET 6: 烤肉 + 越南咖啡
    INSERT INTO menu_items (store_id, category_id, name, description, price, sort_order)
    VALUES (v_store_id, v_cat_set_l,
        'SET 6 烤肉 + 越南咖啡', '烤肉法國麵包 L-SIZE + 越南咖啡',
        142, 6
    );

    -- ========================
    -- 小套餐 SET Mini (麵包 Mini + 飲料)
    -- ========================

    -- SET 7: 燒肉 Mini + 越南咖啡
    INSERT INTO menu_items (store_id, category_id, name, description, price, sort_order)
    VALUES (v_store_id, v_cat_set_m,
        'SET 7 燒肉 Mini + 越南咖啡', '燒肉法國麵包 Mini + 越南咖啡',
        100, 1
    );

    -- SET 8: 燒肉 Mini + 豆漿/紅茶
    INSERT INTO menu_items (store_id, category_id, name, description, price, sort_order, options)
    VALUES (v_store_id, v_cat_set_m,
        'SET 8 燒肉 Mini + 豆漿/紅茶', '燒肉法國麵包 Mini + 豆漿或紅茶',
        90, 2,
        '[{"group":"飲料","required":true,"items":[{"name":"豆漿","price":0},{"name":"紅茶","price":0}]}]'::jsonb
    );

    -- SET 9: 火腿 Mini + 越南咖啡
    INSERT INTO menu_items (store_id, category_id, name, description, price, sort_order)
    VALUES (v_store_id, v_cat_set_m,
        'SET 9 火腿 Mini + 越南咖啡', '火腿法國麵包 Mini + 越南咖啡',
        100, 3
    );

    -- SET 10: 火腿 Mini + 豆漿/紅茶
    INSERT INTO menu_items (store_id, category_id, name, description, price, sort_order, options)
    VALUES (v_store_id, v_cat_set_m,
        'SET 10 火腿 Mini + 豆漿/紅茶', '火腿法國麵包 Mini + 豆漿或紅茶',
        90, 4,
        '[{"group":"飲料","required":true,"items":[{"name":"豆漿","price":0},{"name":"紅茶","price":0}]}]'::jsonb
    );

    -- SET 11: 雞肉 Mini + 豆漿/紅茶
    INSERT INTO menu_items (store_id, category_id, name, description, price, sort_order, options)
    VALUES (v_store_id, v_cat_set_m,
        'SET 11 雞肉 Mini + 豆漿/紅茶', '雞肉法國麵包 Mini + 豆漿或紅茶',
        100, 5,
        '[{"group":"飲料","required":true,"items":[{"name":"豆漿","price":0},{"name":"紅茶","price":0}]}]'::jsonb
    );

    -- ========================
    -- 飲料 Drink
    -- ========================

    INSERT INTO menu_items (store_id, category_id, name, description, price, sort_order, tags)
    VALUES (v_store_id, v_cat_drink,
        '越南咖啡', 'Cà phê sữa đá',
        48, 1, ARRAY['推薦']
    );

    INSERT INTO menu_items (store_id, category_id, name, description, price, sort_order)
    VALUES (v_store_id, v_cat_drink,
        '豆漿', 'Sữa đậu nành',
        37, 2
    );

    INSERT INTO menu_items (store_id, category_id, name, description, price, sort_order)
    VALUES (v_store_id, v_cat_drink,
        '紅茶', 'Trà đá',
        37, 3
    );

    INSERT INTO menu_items (store_id, category_id, name, description, price, sort_order, options)
    VALUES (v_store_id, v_cat_drink,
        '可樂/雪碧', 'Coca-Cola / Sprite',
        37, 4,
        '[{"group":"選擇","required":true,"items":[{"name":"可樂","price":0},{"name":"雪碧","price":0}]}]'::jsonb
    );

    -- ========================
    -- 加料 Add-on
    -- ========================

    INSERT INTO menu_items (store_id, category_id, name, description, price, sort_order)
    VALUES (v_store_id, v_cat_addon,
        '加起司', 'Thêm phô mai',
        15, 1
    );

    INSERT INTO menu_items (store_id, category_id, name, description, price, sort_order)
    VALUES (v_store_id, v_cat_addon,
        '加火腿', 'Thêm chả lụa',
        20, 2
    );

    INSERT INTO menu_items (store_id, category_id, name, description, price, sort_order)
    VALUES (v_store_id, v_cat_addon,
        '加燒肉', 'Thêm thịt nướng',
        20, 3
    );

    INSERT INTO menu_items (store_id, category_id, name, description, price, sort_order)
    VALUES (v_store_id, v_cat_addon,
        '加烤肉', 'Thêm thịt nướng đặc biệt',
        25, 4
    );

    INSERT INTO menu_items (store_id, category_id, name, description, price, sort_order)
    VALUES (v_store_id, v_cat_addon,
        '加雞肉', 'Thêm gà',
        25, 5
    );

    RAISE NOTICE '✅ Benmi 菜單建立完成！共 5 分類、22 品項';
END $$;
