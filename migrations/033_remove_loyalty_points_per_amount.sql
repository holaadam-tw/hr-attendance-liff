-- 033_remove_loyalty_points_per_amount.sql
-- 移除 system_settings 裡的舊 key，集點設定統一用 loyalty_settings 表
--
-- 背景：之前 admin.html 餐飲設定存了 loyalty_points_per_amount 到 system_settings，
-- 但 loyalty_admin.html 存到 loyalty_settings.points_per_amount，兩者不一致導致集點計算錯誤。
-- 統一只用 loyalty_settings 表。

DELETE FROM system_settings WHERE key = 'loyalty_points_per_amount';
