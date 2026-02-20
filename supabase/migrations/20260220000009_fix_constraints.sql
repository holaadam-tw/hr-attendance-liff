-- ===== 修復資料庫約束和外鍵 =====
-- 執行日期: 2026-02-20
-- 目的: 加入缺失的 UNIQUE 約束、索引和外鍵

-- ===== A-1. store_customers 加入 UNIQUE 約束 =====

-- 先清理可能的重複資料
DELETE FROM store_customers a USING store_customers b
WHERE a.id > b.id
  AND a.store_id = b.store_id
  AND a.phone = b.phone;

-- 加入 UNIQUE 約束（防止同一商店的同一手機號重複）
ALTER TABLE store_customers
DROP CONSTRAINT IF EXISTS store_customers_store_phone_unique;

ALTER TABLE store_customers
ADD CONSTRAINT store_customers_store_phone_unique UNIQUE (store_id, phone);

-- 加入索引（如果不存在）
CREATE INDEX IF NOT EXISTS idx_store_customers_store ON store_customers(store_id);
CREATE INDEX IF NOT EXISTS idx_store_customers_phone ON store_customers(store_id, phone);
CREATE INDEX IF NOT EXISTS idx_store_customers_line ON store_customers(store_id, line_uid);

COMMENT ON CONSTRAINT store_customers_store_phone_unique ON store_customers
IS '確保同一商店的同一手機號碼只能有一筆客戶記錄';

-- ===== A-2. loyalty_points 加入 UNIQUE 約束 =====

-- 先清理可能的重複資料
DELETE FROM loyalty_points a USING loyalty_points b
WHERE a.id > b.id
  AND a.store_id = b.store_id
  AND a.customer_line_id = b.customer_line_id;

-- 加入 UNIQUE 約束（防止同一客戶有多筆點數記錄）
ALTER TABLE loyalty_points
DROP CONSTRAINT IF EXISTS loyalty_points_store_customer_unique;

ALTER TABLE loyalty_points
ADD CONSTRAINT loyalty_points_store_customer_unique UNIQUE (store_id, customer_line_id);

COMMENT ON CONSTRAINT loyalty_points_store_customer_unique ON loyalty_points
IS '確保同一商店的同一客戶只能有一筆點數記錄';

-- ===== A-3. loyalty_config 加入外鍵 =====

-- 加入 store_id 外鍵（如果不存在）
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'loyalty_config_store_id_fkey'
  ) THEN
    ALTER TABLE loyalty_config
    ADD CONSTRAINT loyalty_config_store_id_fkey
    FOREIGN KEY (store_id) REFERENCES store_profiles(id) ON DELETE CASCADE;
  END IF;
END $$;

COMMENT ON CONSTRAINT loyalty_config_store_id_fkey ON loyalty_config
IS '集點設定必須關聯到有效的商店';

-- ===== 驗證約束 =====

-- 列出所有約束供確認
DO $$
DECLARE
  v_count INTEGER;
BEGIN
  -- 檢查 store_customers UNIQUE
  SELECT COUNT(*) INTO v_count
  FROM information_schema.table_constraints
  WHERE constraint_name = 'store_customers_store_phone_unique';

  IF v_count > 0 THEN
    RAISE NOTICE '✅ store_customers_store_phone_unique: 已建立';
  ELSE
    RAISE WARNING '❌ store_customers_store_phone_unique: 失敗';
  END IF;

  -- 檢查 loyalty_points UNIQUE
  SELECT COUNT(*) INTO v_count
  FROM information_schema.table_constraints
  WHERE constraint_name = 'loyalty_points_store_customer_unique';

  IF v_count > 0 THEN
    RAISE NOTICE '✅ loyalty_points_store_customer_unique: 已建立';
  ELSE
    RAISE WARNING '❌ loyalty_points_store_customer_unique: 失敗';
  END IF;

  -- 檢查 loyalty_config FK
  SELECT COUNT(*) INTO v_count
  FROM information_schema.table_constraints
  WHERE constraint_name = 'loyalty_config_store_id_fkey';

  IF v_count > 0 THEN
    RAISE NOTICE '✅ loyalty_config_store_id_fkey: 已建立';
  ELSE
    RAISE WARNING '❌ loyalty_config_store_id_fkey: 失敗';
  END IF;
END $$;
