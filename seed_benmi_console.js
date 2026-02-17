// ============================================================
// 本米 Benmi 菜單資料 — 在 admin.html 頁面的瀏覽器 Console 貼上執行
// 前提：已登入 admin.html，sb (Supabase client) 已初始化
// ============================================================

(async function seedBenmi() {
    const log = (msg) => console.log('%c' + msg, 'color:#4CAF50;font-weight:bold');
    const err = (msg) => console.error('❌ ' + msg);

    // === 1. 建立商店 ===
    log('🏪 建立商店...');
    const storeRecord = {
        store_name: '本米 Benmi - 土城中央路餐廳',
        store_slug: 'benmi-tucheng',
        description: 'Bánh mì Việt Nam 越南法國麵包',
        address: '新北市土城區中央路二段149巷8-1號',
        store_type: 'restaurant',
        accept_orders: true,
        theme_color: '#E85D26',
        is_active: true
    };
    if (window.currentCompanyId) storeRecord.company_id = window.currentCompanyId;

    // 檢查是否已存在
    const { data: existing } = await sb.from('store_profiles').select('id').eq('store_slug', 'benmi-tucheng').maybeSingle();
    let storeId;
    if (existing) {
        storeId = existing.id;
        log('商店已存在，使用既有 ID: ' + storeId);
        // 清除舊菜單
        await sb.from('menu_items').delete().eq('store_id', storeId);
        await sb.from('menu_categories').delete().eq('store_id', storeId);
        log('已清除舊菜單資料');
    } else {
        const { data: newStore, error: storeErr } = await sb.from('store_profiles').insert(storeRecord).select().single();
        if (storeErr) { err('建立商店失敗: ' + storeErr.message); return; }
        storeId = newStore.id;
        log('商店建立成功 ID: ' + storeId);
    }

    // === 2. 建立分大類 ===
    log('📂 建立分大類...');
    const categories = [
        { name: '🥖 麵包單點 Bánh mì', sort_order: 1 },
        { name: '🍱 大套餐 SET L-SIZE', sort_order: 2 },
        { name: '🍱 小套餐 SET Mini', sort_order: 3 },
        { name: '🥤 飲料 Drink', sort_order: 4 },
        { name: '➕ 加料 Add-on', sort_order: 5 }
    ];

    const catMap = {};
    for (const cat of categories) {
        const { data, error } = await sb.from('menu_categories')
            .insert({ store_id: storeId, name: cat.name, sort_order: cat.sort_order })
            .select().single();
        if (error) { err('分類建立失敗: ' + cat.name + ' - ' + error.message); return; }
        catMap[cat.name] = data.id;
        log('  ✅ ' + cat.name);
    }

    const catBread  = catMap['🥖 麵包單點 Bánh mì'];
    const catSetL   = catMap['🍱 大套餐 SET L-SIZE'];
    const catSetM   = catMap['🍱 小套餐 SET Mini'];
    const catDrink  = catMap['🥤 飲料 Drink'];
    const catAddon  = catMap['➕ 加料 Add-on'];

    // === 3. 建立菜單品項 ===
    log('🍽️ 建立菜單品項...');

    const sizeOption = (miniPrice, lPrice) => JSON.stringify([
        { group: '尺寸', required: true, items: [
            { name: 'Mini', price: miniPrice },
            { name: 'L-SIZE', price: lPrice }
        ]}
    ]);

    const drinkOption = () => JSON.stringify([
        { group: '飲料', required: true, items: [
            { name: '豆漿', price: 0 },
            { name: '紅茶', price: 0 }
        ]}
    ]);

    const colaOption = () => JSON.stringify([
        { group: '選擇', required: true, items: [
            { name: '可樂', price: 0 },
            { name: '雪碧', price: 0 }
        ]}
    ]);

    const items = [
        // ---- 麵包單點 ----
        { category_id: catBread, name: '燒肉法國麵包', description: 'Bánh mì thịt nướng', price: 80, sort_order: 1, options: sizeOption(56, 80), tags: ['推薦'] },
        { category_id: catBread, name: '火腿法國麵包', description: 'Bánh mì chả lụa', price: 80, sort_order: 2, options: sizeOption(56, 80) },
        { category_id: catBread, name: '雞肉法國麵包', description: 'Bánh mì gà', price: 90, sort_order: 3, options: sizeOption(66, 90) },
        { category_id: catBread, name: '烤肉法國麵包', description: 'Bánh mì thịt nướng đặc biệt', price: 100, sort_order: 4, options: sizeOption(69, 100) },
        { category_id: catBread, name: '雙層烤肉法國麵包', description: 'Bánh mì thịt nướng x2', price: 130, sort_order: 5, options: sizeOption(79, 130) },
        { category_id: catBread, name: '綜合法國麵包', description: 'Bánh mì đặc biệt (tổng hợp)', price: 100, sort_order: 6, options: sizeOption(69, 100) },

        // ---- 大套餐 SET L-SIZE ----
        { category_id: catSetL, name: 'SET 1 燒肉 + 越南咖啡', description: '燒肉法國麵包 L-SIZE + 越南咖啡', price: 120, sort_order: 1, tags: ['套餐'] },
        { category_id: catSetL, name: 'SET 2 燒肉 + 豆漿/紅茶', description: '燒肉法國麵包 L-SIZE + 豆漿或紅茶', price: 110, sort_order: 2, options: drinkOption() },
        { category_id: catSetL, name: 'SET 3 火腿 + 越南咖啡', description: '火腿法國麵包 L-SIZE + 越南咖啡', price: 120, sort_order: 3 },
        { category_id: catSetL, name: 'SET 4 火腿 + 豆漿/紅茶', description: '火腿法國麵包 L-SIZE + 豆漿或紅茶', price: 110, sort_order: 4, options: drinkOption() },
        { category_id: catSetL, name: 'SET 5 雞肉 + 越南咖啡', description: '雞肉法國麵包 L-SIZE + 越南咖啡', price: 130, sort_order: 5 },
        { category_id: catSetL, name: 'SET 6 烤肉 + 越南咖啡', description: '烤肉法國麵包 L-SIZE + 越南咖啡', price: 142, sort_order: 6 },

        // ---- 小套餐 SET Mini ----
        { category_id: catSetM, name: 'SET 7 燒肉 Mini + 越南咖啡', description: '燒肉法國麵包 Mini + 越南咖啡', price: 100, sort_order: 1 },
        { category_id: catSetM, name: 'SET 8 燒肉 Mini + 豆漿/紅茶', description: '燒肉法國麵包 Mini + 豆漿或紅茶', price: 90, sort_order: 2, options: drinkOption() },
        { category_id: catSetM, name: 'SET 9 火腿 Mini + 越南咖啡', description: '火腿法國麵包 Mini + 越南咖啡', price: 100, sort_order: 3 },
        { category_id: catSetM, name: 'SET 10 火腿 Mini + 豆漿/紅茶', description: '火腿法國麵包 Mini + 豆漿或紅茶', price: 90, sort_order: 4, options: drinkOption() },
        { category_id: catSetM, name: 'SET 11 雞肉 Mini + 豆漿/紅茶', description: '雞肉法國麵包 Mini + 豆漿或紅茶', price: 100, sort_order: 5, options: drinkOption() },

        // ---- 飲料 ----
        { category_id: catDrink, name: '越南咖啡', description: 'Cà phê sữa đá', price: 48, sort_order: 1, tags: ['推薦'] },
        { category_id: catDrink, name: '豆漿', description: 'Sữa đậu nành', price: 37, sort_order: 2 },
        { category_id: catDrink, name: '紅茶', description: 'Trà đá', price: 37, sort_order: 3 },
        { category_id: catDrink, name: '可樂/雪碧', description: 'Coca-Cola / Sprite', price: 37, sort_order: 4, options: colaOption() },

        // ---- 加料 ----
        { category_id: catAddon, name: '加起司', description: 'Thêm phô mai', price: 15, sort_order: 1 },
        { category_id: catAddon, name: '加火腿', description: 'Thêm chả lụa', price: 20, sort_order: 2 },
        { category_id: catAddon, name: '加燒肉', description: 'Thêm thịt nướng', price: 20, sort_order: 3 },
        { category_id: catAddon, name: '加烤肉', description: 'Thêm thịt nướng đặc biệt', price: 25, sort_order: 4 },
        { category_id: catAddon, name: '加雞肉', description: 'Thêm gà', price: 25, sort_order: 5 }
    ];

    let count = 0;
    for (const item of items) {
        const record = {
            store_id: storeId,
            category_id: item.category_id,
            name: item.name,
            description: item.description || null,
            price: item.price,
            sort_order: item.sort_order,
            is_available: true
        };
        if (item.options) record.options = JSON.parse(item.options);
        if (item.tags) record.tags = item.tags;

        const { error } = await sb.from('menu_items').insert(record);
        if (error) {
            err('品項建立失敗: ' + item.name + ' - ' + error.message);
        } else {
            count++;
        }
    }

    log('🎉 完成！共建立 ' + categories.length + ' 個分類、' + count + ' 個品項');
    log('📱 點餐連結: https://holaadam-tw.github.io/hr-attendance-liff/order.html?store=benmi-tucheng');

    // 重新載入商店列表
    if (typeof loadRestaurantList === 'function') {
        await loadRestaurantList();
        log('商店列表已刷新');
    }
})();
