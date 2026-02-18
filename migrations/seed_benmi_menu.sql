-- ============================================================
-- seed_benmi_menu.sql
-- 本米 Benmi - 土城中央路餐廳 菜單種子資料
-- Bánh mì Việt Nam 越式法國麵包
-- ============================================================

-- 先取得或建立商店 (使用 slug = 'benmi-tucheng')
-- 若商店已存在則更新資訊
INSERT INTO store_profiles (
    store_name, store_slug, description, phone, address,
    store_type, accept_orders, theme_color, is_active, business_hours
) VALUES (
    '本米 Benmi - 土城中央路餐廳',
    'benmi-tucheng',
    'Bánh mì Việt Nam 越式法國麵包',
    NULL,
    '新北市土城區中央路二段135號',
    'restaurant',
    true,
    '#E85D26',
    true,
    '{"mon":{"open":true,"start":"11:00","end":"21:00"},"tue":{"open":true,"start":"11:00","end":"21:00"},"wed":{"open":true,"start":"11:00","end":"21:00"},"thu":{"open":true,"start":"11:00","end":"21:00"},"fri":{"open":true,"start":"11:00","end":"21:00"},"sat":{"open":true,"start":"07:30","end":"21:00"},"sun":{"open":true,"start":"07:30","end":"21:00"}}'::jsonb
) ON CONFLICT (store_slug) DO UPDATE SET
    address = EXCLUDED.address,
    business_hours = EXCLUDED.business_hours,
    description = EXCLUDED.description;

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
    -- 每款有 Mini / L-SIZE 兩種尺寸
    -- ========================

    -- 1. 燒肉麵包
    INSERT INTO menu_items (store_id, category_id, name, description, price, sort_order, options, tags)
    VALUES (v_store_id, v_cat_bread,
        '燒肉麵包', 'Braised pork / Thịt nguội',
        80, 1,
        '[{"group":"尺寸","required":true,"items":[{"name":"Mini","price":56},{"name":"L-SIZE","price":80}]}]'::jsonb,
        ARRAY['推薦']
    );

    -- 2. 火腿麵包
    INSERT INTO menu_items (store_id, category_id, name, description, price, sort_order, options)
    VALUES (v_store_id, v_cat_bread,
        '火腿麵包', 'Ham / Chả',
        80, 2,
        '[{"group":"尺寸","required":true,"items":[{"name":"Mini","price":56},{"name":"L-SIZE","price":80}]}]'::jsonb
    );

    -- 3. 雞肉麵包
    INSERT INTO menu_items (store_id, category_id, name, description, price, sort_order, options)
    VALUES (v_store_id, v_cat_bread,
        '雞肉麵包', 'Chicken / Thịt gà',
        100, 3,
        '[{"group":"尺寸","required":true,"items":[{"name":"Mini","price":68},{"name":"L-SIZE","price":100}]}]'::jsonb
    );

    -- 4. 烤肉麵包
    INSERT INTO menu_items (store_id, category_id, name, description, price, sort_order, options)
    VALUES (v_store_id, v_cat_bread,
        '烤肉麵包', 'Grilled Meat / Thịt nướng',
        105, 4,
        '[{"group":"尺寸","required":true,"items":[{"name":"Mini","price":72},{"name":"L-SIZE","price":105}]}]'::jsonb
    );

    -- 5. 雙層烤肉麵包
    INSERT INTO menu_items (store_id, category_id, name, description, price, sort_order, options, tags)
    VALUES (v_store_id, v_cat_bread,
        '雙層烤肉麵包', 'Double Cheesebanhmi / Thịt nướng phô mai',
        115, 5,
        '[{"group":"尺寸","required":true,"items":[{"name":"Mini","price":78},{"name":"L-SIZE","price":115}]}]'::jsonb,
        ARRAY['推薦']
    );

    -- 6. 綜合麵包
    INSERT INTO menu_items (store_id, category_id, name, description, price, sort_order, options)
    VALUES (v_store_id, v_cat_bread,
        '綜合麵包', 'Mixed / Thập cẩm',
        130, 6,
        '[{"group":"尺寸","required":true,"items":[{"name":"Mini","price":79},{"name":"L-SIZE","price":130}]}]'::jsonb
    );

    -- ========================
    -- 大套餐 SET L-SIZE (麵包 L-SIZE + 飲料)
    -- ========================

    INSERT INTO menu_items (store_id, category_id, name, description, price, sort_order, options, tags)
    VALUES (v_store_id, v_cat_set_l,
        'Set 1 燒肉+飲料', 'L-SIZE 燒肉麵包+飲料',
        90, 1,
        '[{"group":"飲料","required":true,"items":[{"name":"越南咖啡","price":0},{"name":"豆漿","price":0},{"name":"紅茶","price":0},{"name":"可樂","price":0},{"name":"雪碧","price":0}]}]'::jsonb,
        ARRAY['套餐']
    );

    INSERT INTO menu_items (store_id, category_id, name, description, price, sort_order, options, tags)
    VALUES (v_store_id, v_cat_set_l,
        'Set 2 火腿+飲料', 'L-SIZE 火腿麵包+飲料',
        90, 2,
        '[{"group":"飲料","required":true,"items":[{"name":"越南咖啡","price":0},{"name":"豆漿","price":0},{"name":"紅茶","price":0},{"name":"可樂","price":0},{"name":"雪碧","price":0}]}]'::jsonb,
        ARRAY['套餐']
    );

    INSERT INTO menu_items (store_id, category_id, name, description, price, sort_order, options, tags)
    VALUES (v_store_id, v_cat_set_l,
        'Set 3 雞肉+飲料', 'L-SIZE 雞肉麵包+飲料',
        118, 3,
        '[{"group":"飲料","required":true,"items":[{"name":"越南咖啡","price":0},{"name":"豆漿","price":0},{"name":"紅茶","price":0},{"name":"可樂","price":0},{"name":"雪碧","price":0}]}]'::jsonb,
        ARRAY['套餐']
    );

    INSERT INTO menu_items (store_id, category_id, name, description, price, sort_order, options, tags)
    VALUES (v_store_id, v_cat_set_l,
        'Set 4 烤肉+飲料', 'L-SIZE 烤肉麵包+飲料',
        128, 4,
        '[{"group":"飲料","required":true,"items":[{"name":"越南咖啡","price":0},{"name":"豆漿","price":0},{"name":"紅茶","price":0},{"name":"可樂","price":0},{"name":"雪碧","price":0}]}]'::jsonb,
        ARRAY['套餐']
    );

    INSERT INTO menu_items (store_id, category_id, name, description, price, sort_order, options, tags)
    VALUES (v_store_id, v_cat_set_l,
        'Set 5 雙層烤肉+飲料', 'L-SIZE 雙層烤肉麵包+飲料',
        135, 5,
        '[{"group":"飲料","required":true,"items":[{"name":"越南咖啡","price":0},{"name":"豆漿","price":0},{"name":"紅茶","price":0},{"name":"可樂","price":0},{"name":"雪碧","price":0}]}]'::jsonb,
        ARRAY['套餐']
    );

    INSERT INTO menu_items (store_id, category_id, name, description, price, sort_order, options, tags)
    VALUES (v_store_id, v_cat_set_l,
        'Set 6 綜合+飲料', 'L-SIZE 綜合麵包+飲料',
        142, 6,
        '[{"group":"飲料","required":true,"items":[{"name":"越南咖啡","price":0},{"name":"豆漿","price":0},{"name":"紅茶","price":0},{"name":"可樂","price":0},{"name":"雪碧","price":0}]}]'::jsonb,
        ARRAY['套餐']
    );

    -- ========================
    -- 小套餐 SET Mini (麵包 Mini + 飲料)
    -- ========================

    INSERT INTO menu_items (store_id, category_id, name, description, price, sort_order, options, tags)
    VALUES (v_store_id, v_cat_set_m,
        'Set 7 燒肉/火腿+飲料', 'Mini 燒肉或火腿麵包+飲料',
        77, 1,
        '[{"group":"麵包","required":true,"items":[{"name":"燒肉","price":0},{"name":"火腿","price":0}]},{"group":"飲料","required":true,"items":[{"name":"越南咖啡","price":0},{"name":"豆漿","price":0},{"name":"紅茶","price":0},{"name":"可樂","price":0},{"name":"雪碧","price":0}]}]'::jsonb,
        ARRAY['套餐']
    );

    INSERT INTO menu_items (store_id, category_id, name, description, price, sort_order, options, tags)
    VALUES (v_store_id, v_cat_set_m,
        'Set 8 雞肉+飲料', 'Mini 雞肉麵包+飲料',
        88, 2,
        '[{"group":"飲料","required":true,"items":[{"name":"越南咖啡","price":0},{"name":"豆漿","price":0},{"name":"紅茶","price":0},{"name":"可樂","price":0},{"name":"雪碧","price":0}]}]'::jsonb,
        ARRAY['套餐']
    );

    INSERT INTO menu_items (store_id, category_id, name, description, price, sort_order, options, tags)
    VALUES (v_store_id, v_cat_set_m,
        'Set 9 烤肉+飲料', 'Mini 烤肉麵包+飲料',
        95, 3,
        '[{"group":"飲料","required":true,"items":[{"name":"越南咖啡","price":0},{"name":"豆漿","price":0},{"name":"紅茶","price":0},{"name":"可樂","price":0},{"name":"雪碧","price":0}]}]'::jsonb,
        ARRAY['套餐']
    );

    INSERT INTO menu_items (store_id, category_id, name, description, price, sort_order, options, tags)
    VALUES (v_store_id, v_cat_set_m,
        'Set 10 雙層烤肉+飲料', 'Mini 雙層烤肉麵包+飲料',
        99, 4,
        '[{"group":"飲料","required":true,"items":[{"name":"越南咖啡","price":0},{"name":"豆漿","price":0},{"name":"紅茶","price":0},{"name":"可樂","price":0},{"name":"雪碧","price":0}]}]'::jsonb,
        ARRAY['套餐']
    );

    INSERT INTO menu_items (store_id, category_id, name, description, price, sort_order, options, tags)
    VALUES (v_store_id, v_cat_set_m,
        'Set 11 綜合+飲料', 'Mini 綜合麵包+飲料',
        100, 5,
        '[{"group":"飲料","required":true,"items":[{"name":"越南咖啡","price":0},{"name":"豆漿","price":0},{"name":"紅茶","price":0},{"name":"可樂","price":0},{"name":"雪碧","price":0}]}]'::jsonb,
        ARRAY['套餐']
    );

    -- ========================
    -- 飲料 Drink
    -- ========================

    INSERT INTO menu_items (store_id, category_id, name, description, price, sort_order, tags)
    VALUES (v_store_id, v_cat_drink,
        '越南咖啡', 'Cà phê sữa / Coffee with Condensed Milk',
        48, 1, ARRAY['推薦']
    );

    INSERT INTO menu_items (store_id, category_id, name, description, price, sort_order)
    VALUES (v_store_id, v_cat_drink,
        '豆漿', 'Sữa đậu nành / Soy Milk',
        37, 2
    );

    INSERT INTO menu_items (store_id, category_id, name, description, price, sort_order)
    VALUES (v_store_id, v_cat_drink,
        '紅茶', 'Hồng trà / Black Tea',
        37, 3
    );

    INSERT INTO menu_items (store_id, category_id, name, description, price, sort_order, options)
    VALUES (v_store_id, v_cat_drink,
        '可樂/雪碧', 'Cocacola / Sprite',
        37, 4,
        '[{"group":"選擇","required":true,"items":[{"name":"可樂","price":0},{"name":"雪碧","price":0}]}]'::jsonb
    );

    -- ========================
    -- 加料 Add-on / Extra Filling
    -- ========================

    INSERT INTO menu_items (store_id, category_id, name, description, price, sort_order)
    VALUES (v_store_id, v_cat_addon,
        '加起司', 'Cheese / Phô mai',
        15, 1
    );

    INSERT INTO menu_items (store_id, category_id, name, description, price, sort_order)
    VALUES (v_store_id, v_cat_addon,
        '加火腿', 'Ham / Chả lụa',
        20, 2
    );

    INSERT INTO menu_items (store_id, category_id, name, description, price, sort_order)
    VALUES (v_store_id, v_cat_addon,
        '加燒肉', 'Braised Meat / Thịt nguội',
        20, 3
    );

    INSERT INTO menu_items (store_id, category_id, name, description, price, sort_order)
    VALUES (v_store_id, v_cat_addon,
        '加烤肉', 'Grilled Meat / Thịt nướng',
        25, 4
    );

    INSERT INTO menu_items (store_id, category_id, name, description, price, sort_order)
    VALUES (v_store_id, v_cat_addon,
        '加雞肉', 'Chicken / Thịt gà',
        25, 5
    );

    RAISE NOTICE '✅ Benmi 菜單建立完成！共 5 分類、22 品項';
END $$;
