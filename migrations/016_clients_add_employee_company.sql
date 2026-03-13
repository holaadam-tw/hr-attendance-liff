-- 016: clients 新增 employee_id 和 company_id 欄位
-- 用於多租戶篩選和業務員工分配

ALTER TABLE clients ADD COLUMN IF NOT EXISTS employee_id UUID REFERENCES employees(id);
ALTER TABLE clients ADD COLUMN IF NOT EXISTS company_id UUID REFERENCES companies(id);

-- 建立索引
CREATE INDEX IF NOT EXISTS idx_clients_employee_id ON clients(employee_id);
CREATE INDEX IF NOT EXISTS idx_clients_company_id ON clients(company_id);
CREATE INDEX IF NOT EXISTS idx_clients_company_active ON clients(company_id) WHERE is_active = true;
