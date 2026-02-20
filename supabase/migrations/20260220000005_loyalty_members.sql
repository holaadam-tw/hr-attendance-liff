-- ============================================================
-- Migration: 會員管理 + 集點異動紀錄
-- ============================================================

-- 1. 集點異動紀錄（手動加減 + 兌換紀錄）
CREATE TABLE IF NOT EXISTS loyalty_transactions (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    store_id UUID NOT NULL REFERENCES store_profiles(id),
    customer_phone VARCHAR(20) NOT NULL,
    type VARCHAR(20) NOT NULL,
    -- type: 'earn'(消費集點), 'manual_add'(手動加點), 'manual_deduct'(手動扣點), 'redeem'(兌換折扣), 'expire'(過期)
    points INT NOT NULL,               -- 正數=加點, 負數=扣點
    balance_after INT,                 -- 異動後餘額
    order_id UUID REFERENCES orders(id),
    note TEXT,                         -- 備註（手動加減時填寫原因）
    operator_name VARCHAR(100),        -- 操作人
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_loyalty_tx_phone ON loyalty_transactions(store_id, customer_phone, created_at DESC);

-- 2. store_profiles 加集點開關
ALTER TABLE store_profiles ADD COLUMN IF NOT EXISTS loyalty_enabled BOOLEAN DEFAULT true;

COMMENT ON TABLE loyalty_transactions IS '集點異動紀錄（手動加減點/兌換/消費）';
COMMENT ON COLUMN store_profiles.loyalty_enabled IS '集點功能開關（關閉後消費者看不到集點區）';
