-- ============================================================
-- Migration: 多語菜單翻譯 — name_translations JSONB 欄位
-- ============================================================

-- 1. 新增欄位
ALTER TABLE menu_categories ADD COLUMN IF NOT EXISTS name_translations JSONB DEFAULT '{}';
ALTER TABLE menu_items ADD COLUMN IF NOT EXISTS name_translations JSONB DEFAULT '{}';
ALTER TABLE menu_items ADD COLUMN IF NOT EXISTS desc_translations JSONB DEFAULT '{}';

-- 2. 分類翻譯
UPDATE menu_categories SET name_translations = '{"en":"Bánh Mì Singles","vi":"Bánh mì đơn","ja":"バインミー単品","ko":"반미 단품","th":"บั๋นหมี่ สั่งเดี่ยว"}'::jsonb WHERE name LIKE '%麵包單點%';
UPDATE menu_categories SET name_translations = '{"en":"Set Meal L-SIZE","vi":"Combo cỡ lớn","ja":"Lセットメニュー","ko":"L사이즈 세트","th":"เซ็ตใหญ่"}'::jsonb WHERE name LIKE '%大套餐%';
UPDATE menu_categories SET name_translations = '{"en":"Set Meal Mini","vi":"Combo cỡ nhỏ","ja":"ミニセットメニュー","ko":"미니 세트","th":"เซ็ตเล็ก"}'::jsonb WHERE name LIKE '%小套餐%';
UPDATE menu_categories SET name_translations = '{"en":"Drinks","vi":"Nước uống","ja":"ドリンク","ko":"음료","th":"เครื่องดื่ม"}'::jsonb WHERE name LIKE '%飲料%';
UPDATE menu_categories SET name_translations = '{"en":"Add-ons","vi":"Thêm topping","ja":"トッピング","ko":"추가 토핑","th":"ท็อปปิ้ง"}'::jsonb WHERE name LIKE '%加料%';

-- 3. 麵包單點翻譯
UPDATE menu_items SET name_translations = '{"en":"Grilled Pork Bánh Mì","vi":"Bánh mì thịt nướng","ja":"焼肉バインミー","ko":"숯불고기 반미","th":"บั๋นหมี่หมูย่าง"}'::jsonb WHERE name = '燒肉法國麵包';
UPDATE menu_items SET name_translations = '{"en":"Ham Bánh Mì","vi":"Bánh mì chả lụa","ja":"ハムバインミー","ko":"햄 반미","th":"บั๋นหมี่แฮม"}'::jsonb WHERE name = '火腿法國麵包';
UPDATE menu_items SET name_translations = '{"en":"Chicken Bánh Mì","vi":"Bánh mì gà","ja":"チキンバインミー","ko":"치킨 반미","th":"บั๋นหมี่ไก่"}'::jsonb WHERE name = '雞肉法國麵包';
UPDATE menu_items SET name_translations = '{"en":"BBQ Pork Bánh Mì","vi":"Bánh mì thịt nướng đặc biệt","ja":"BBQポークバインミー","ko":"바베큐 반미","th":"บั๋นหมี่หมูบาร์บีคิว"}'::jsonb WHERE name = '烤肉法國麵包';
UPDATE menu_items SET name_translations = '{"en":"Double BBQ Pork Bánh Mì","vi":"Bánh mì thịt nướng x2","ja":"ダブルBBQバインミー","ko":"더블 바베큐 반미","th":"บั๋นหมี่หมูบาร์บีคิวคู่"}'::jsonb WHERE name = '雙層烤肉法國麵包';
UPDATE menu_items SET name_translations = '{"en":"Mixed Bánh Mì","vi":"Bánh mì đặc biệt tổng hợp","ja":"ミックスバインミー","ko":"모듬 반미","th":"บั๋นหมี่รวม"}'::jsonb WHERE name = '綜合法國麵包';

-- 4. 大套餐翻譯
UPDATE menu_items SET name_translations = '{"en":"SET 1: Grilled Pork + Viet Coffee","vi":"SET 1: Thịt nướng + Cà phê Việt","ja":"SET 1: 焼肉 + ベトナムコーヒー","ko":"SET 1: 숯불고기 + 베트남커피","th":"SET 1: หมูย่าง + กาแฟเวียดนาม"}'::jsonb WHERE name = 'SET 1 燒肉 + 越南咖啡';
UPDATE menu_items SET name_translations = '{"en":"SET 2: Grilled Pork + Soy Milk/Tea","vi":"SET 2: Thịt nướng + Sữa đậu/Trà","ja":"SET 2: 焼肉 + 豆乳/紅茶","ko":"SET 2: 숯불고기 + 두유/홍차","th":"SET 2: หมูย่าง + นมถั่วเหลือง/ชา"}'::jsonb WHERE name = 'SET 2 燒肉 + 豆漿/紅茶';
UPDATE menu_items SET name_translations = '{"en":"SET 3: Ham + Viet Coffee","vi":"SET 3: Chả lụa + Cà phê Việt","ja":"SET 3: ハム + ベトナムコーヒー","ko":"SET 3: 햄 + 베트남커피","th":"SET 3: แฮม + กาแฟเวียดนาม"}'::jsonb WHERE name = 'SET 3 火腿 + 越南咖啡';
UPDATE menu_items SET name_translations = '{"en":"SET 4: Ham + Soy Milk/Tea","vi":"SET 4: Chả lụa + Sữa đậu/Trà","ja":"SET 4: ハム + 豆乳/紅茶","ko":"SET 4: 햄 + 두유/홍차","th":"SET 4: แฮม + นมถั่วเหลือง/ชา"}'::jsonb WHERE name = 'SET 4 火腿 + 豆漿/紅茶';
UPDATE menu_items SET name_translations = '{"en":"SET 5: Chicken + Viet Coffee","vi":"SET 5: Gà + Cà phê Việt","ja":"SET 5: チキン + ベトナムコーヒー","ko":"SET 5: 치킨 + 베트남커피","th":"SET 5: ไก่ + กาแฟเวียดนาม"}'::jsonb WHERE name = 'SET 5 雞肉 + 越南咖啡';
UPDATE menu_items SET name_translations = '{"en":"SET 6: BBQ Pork + Viet Coffee","vi":"SET 6: Thịt nướng ĐB + Cà phê Việt","ja":"SET 6: BBQポーク + ベトナムコーヒー","ko":"SET 6: 바베큐 + 베트남커피","th":"SET 6: หมูบาร์บีคิว + กาแฟเวียดนาม"}'::jsonb WHERE name = 'SET 6 烤肉 + 越南咖啡';

-- 5. 小套餐翻譯
UPDATE menu_items SET name_translations = '{"en":"SET 7: Grilled Pork Mini + Viet Coffee","vi":"SET 7: Thịt nướng Mini + Cà phê Việt","ja":"SET 7: 焼肉ミニ + ベトナムコーヒー","ko":"SET 7: 숯불고기 미니 + 베트남커피","th":"SET 7: หมูย่างมินิ + กาแฟเวียดนาม"}'::jsonb WHERE name = 'SET 7 燒肉 Mini + 越南咖啡';
UPDATE menu_items SET name_translations = '{"en":"SET 8: Grilled Pork Mini + Soy Milk/Tea","vi":"SET 8: Thịt nướng Mini + Sữa đậu/Trà","ja":"SET 8: 焼肉ミニ + 豆乳/紅茶","ko":"SET 8: 숯불고기 미니 + 두유/홍차","th":"SET 8: หมูย่างมินิ + นมถั่วเหลือง/ชา"}'::jsonb WHERE name = 'SET 8 燒肉 Mini + 豆漿/紅茶';
UPDATE menu_items SET name_translations = '{"en":"SET 9: Ham Mini + Viet Coffee","vi":"SET 9: Chả lụa Mini + Cà phê Việt","ja":"SET 9: ハムミニ + ベトナムコーヒー","ko":"SET 9: 햄 미니 + 베트남커피","th":"SET 9: แฮมมินิ + กาแฟเวียดนาม"}'::jsonb WHERE name = 'SET 9 火腿 Mini + 越南咖啡';
UPDATE menu_items SET name_translations = '{"en":"SET 10: Ham Mini + Soy Milk/Tea","vi":"SET 10: Chả lụa Mini + Sữa đậu/Trà","ja":"SET 10: ハムミニ + 豆乳/紅茶","ko":"SET 10: 햄 미니 + 두유/홍차","th":"SET 10: แฮมมินิ + นมถั่วเหลือง/ชา"}'::jsonb WHERE name = 'SET 10 火腿 Mini + 豆漿/紅茶';
UPDATE menu_items SET name_translations = '{"en":"SET 11: Chicken Mini + Soy Milk/Tea","vi":"SET 11: Gà Mini + Sữa đậu/Trà","ja":"SET 11: チキンミニ + 豆乳/紅茶","ko":"SET 11: 치킨 미니 + 두유/홍차","th":"SET 11: ไก่มินิ + นมถั่วเหลือง/ชา"}'::jsonb WHERE name = 'SET 11 雞肉 Mini + 豆漿/紅茶';

-- 6. 飲料翻譯
UPDATE menu_items SET name_translations = '{"en":"Vietnamese Coffee","vi":"Cà phê sữa đá","ja":"ベトナムコーヒー","ko":"베트남 커피","th":"กาแฟเวียดนาม"}'::jsonb WHERE name = '越南咖啡';
UPDATE menu_items SET name_translations = '{"en":"Soy Milk","vi":"Sữa đậu nành","ja":"豆乳","ko":"두유","th":"นมถั่วเหลือง"}'::jsonb WHERE name = '豆漿';
UPDATE menu_items SET name_translations = '{"en":"Black Tea","vi":"Trà đá","ja":"アイスティー","ko":"홍차","th":"ชาดำเย็น"}'::jsonb WHERE name = '紅茶';
UPDATE menu_items SET name_translations = '{"en":"Coke / Sprite","vi":"Coca / Sprite","ja":"コーラ/スプライト","ko":"콜라/사이다","th":"โค้ก/สไปรท์"}'::jsonb WHERE name = '可樂/雪碧';

-- 7. 加料翻譯
UPDATE menu_items SET name_translations = '{"en":"+ Cheese","vi":"Thêm phô mai","ja":"+チーズ","ko":"+치즈","th":"+ชีส"}'::jsonb WHERE name = '加起司';
UPDATE menu_items SET name_translations = '{"en":"+ Ham","vi":"Thêm chả lụa","ja":"+ハム","ko":"+햄","th":"+แฮม"}'::jsonb WHERE name = '加火腿';
UPDATE menu_items SET name_translations = '{"en":"+ Grilled Pork","vi":"Thêm thịt nướng","ja":"+焼肉","ko":"+숯불고기","th":"+หมูย่าง"}'::jsonb WHERE name = '加燒肉';
UPDATE menu_items SET name_translations = '{"en":"+ BBQ Pork","vi":"Thêm thịt nướng ĐB","ja":"+BBQポーク","ko":"+바베큐","th":"+หมูบาร์บีคิว"}'::jsonb WHERE name = '加烤肉';
UPDATE menu_items SET name_translations = '{"en":"+ Chicken","vi":"Thêm gà","ja":"+チキン","ko":"+치킨","th":"+ไก่"}'::jsonb WHERE name = '加雞肉';
