-- ============================================================
-- 064: 多租戶隔離修復 (批次 1)
--
-- hr_audit_logs 加 company_id 欄位
-- 既有記錄從 actor_id → employees 反推 company_id
-- ============================================================

ALTER TABLE hr_audit_logs ADD COLUMN IF NOT EXISTS company_id UUID REFERENCES companies(id);

-- 從 actor_id → employees 反推 company_id 補既有記錄
UPDATE hr_audit_logs h
SET company_id = e.company_id
FROM employees e
WHERE h.actor_id = e.id
  AND h.company_id IS NULL;
