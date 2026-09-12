// 124 RLS 階段 1／employees 寫入鎖定 回歸測試（不連線、不寫 DB）
// 反向對照：MIGRATION124_FILE 環境變數可指向改壞的副本。
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const m124 = fs.readFileSync(process.env.MIGRATION124_FILE || path.join(root, 'migrations', '124_rls_employees_write_lock.sql'), 'utf8');
const code = m124.split('\n').filter(l => !/^\s*--/.test(l)).join('\n');
const read = f => fs.readFileSync(path.join(root, f), 'utf8');
const commonSrc = read('common.js'), empSrc = read('modules/employees.js'), regSrc = read('employee_register.html'), i18nSrc = read('i18n.js');

let pass = 0, fail = 0;
function check(name, condition, detail = '') {
  if (condition) { pass++; console.log(`  ✅ ${name}${detail ? `  → ${detail}` : ''}`); }
  else { fail++; console.log(`  ❌ ${name}${detail ? `  → ${detail}` : ''}`); }
}
function fn(name) {
  const re = new RegExp('CREATE OR REPLACE FUNCTION public\\.' + name + '\\([\\s\\S]*?\\n\\$\\$;', 'm');
  const m = code.match(re);
  return m ? m[0] : '';
}
function grab(source, name) {
  const start = source.indexOf('function ' + name + '(');
  if (start < 0) throw new Error('找不到函式：' + name);
  let depth = 0, opened = false;
  for (let i = start; i < source.length; i++) {
    if (source[i] === '{') { depth++; opened = true; }
    if (source[i] === '}' && --depth === 0 && opened) return source.slice(start, i + 1);
  }
  throw new Error('函式括號不完整：' + name);
}

console.log('\n=== 政策與 grant 收斂 ===');
check('DROP 全開 ALL 政策', /DROP POLICY IF EXISTS "Allow RPC access employees" ON public\.employees/.test(code));
check('DROP 全開 UPDATE 政策', /DROP POLICY IF EXISTS "允許更新員工資料" ON public\.employees/.test(code));
check('REVOKE anon/authenticated 寫入 grant', /REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON public\.employees FROM anon, authenticated/.test(code));
check('不撤 SELECT（階段 1 不鎖讀）', !/REVOKE[^;]*SELECT[^;]*ON public\.employees/.test(code) && !/DROP POLICY IF EXISTS "允許查看員工資料"/.test(code));
check('不新增任何 USING(true) 政策', !/CREATE POLICY/.test(code));

console.log('\n=== admin_update_employee ===');
const up = fn('admin_update_employee');
check('存在且驗 has_company_access(…, true)', /has_company_access\(p_line_user_id, p_company_id, true\)/.test(up));
check('欄位白名單、未知鍵拒絕', /v_allowed TEXT\[\]/.test(up) && /field_not_allowed/.test(up));
check('白名單不含 company_id／id／is_admin', !/'company_id'/.test(up.slice(up.indexOf('v_allowed'), up.indexOf('];'))) && !/'is_admin'/.test(up));
check('目標員工限同公司', /WHERE e\.id = p_employee_id AND e\.company_id = p_company_id/.test(up));
check('role 只有公司 admin／平台管理員可改', /IF p_updates \? 'role' THEN[\s\S]*?is_company_admin_caller\(p_line_user_id, p_company_id\)/.test(up));
check('role 值白名單 user/manager/admin', /v_role NOT IN \('user', 'manager', 'admin'\)/.test(up));
check('LINE ID 同公司重複檢查', /line_in_use/.test(up) && /e\.company_id = p_company_id AND e\.line_user_id = v_line AND e\.is_active = true AND e\.id <> p_employee_id/.test(up));
check('工號同公司重複檢查', /duplicate_number/.test(up));
check('UPDATE 再次限定 company_id', /WHERE e\.id = p_employee_id AND e\.company_id = p_company_id;/.test(up));
check('只更新有出現的鍵（CASE WHEN p_updates ? …）', (up.match(/CASE WHEN p_updates \? '/g) || []).length >= 25);
check('RECORD NULL 用 .id 判斷', /IF v_target\.id IS NULL THEN/.test(up) && /IF v_dup\.id IS NOT NULL THEN/.test(up) && !/IF v_target IS NOT NULL/.test(up));

console.log('\n=== admin_create_employee ===');
const cr = fn('admin_create_employee');
check('驗 has_company_access(…, true)', /has_company_access\(p_line_user_id, p_company_id, true\)/.test(cr));
check('company_id 只用 p_company_id', /INSERT INTO public\.employees \([\s\S]*?\) VALUES \(\s*p_company_id,/.test(cr) && !/p_data->>'company_id'/.test(cr));
check('非 user 角色需 admin', /v_role <> 'user' AND NOT public\.is_company_admin_caller/.test(cr));
check('強制 is_active=true、status=approved', /true, 'approved', now\(\)/.test(cr));

console.log('\n=== admin_delete_pending_employee ===');
const del = fn('admin_delete_pending_employee');
check('只能刪 pending 且未啟用', /e\.status = 'pending' AND COALESCE\(e\.is_active, false\) = false/.test(del));
check('限同公司', /e\.id = p_employee_id AND e\.company_id = p_company_id/.test(del));

console.log('\n=== register_employee（公開） ===');
const reg = fn('register_employee');
check('公司必須存在', /NOT EXISTS \(SELECT 1 FROM public\.companies c WHERE c\.id = p_company_id\)/.test(reg));
check('強制 pending／inactive／user', /false, 'pending', 'user', 'fulltime', now\(\)/.test(reg));
check('rejected 重新登記也強制 pending／user', /status = 'pending', is_active = false, role = 'user'/.test(reg));
check('不接受 p_data 的 role／status／is_active', !/p_data->>'role'/.test(reg) && !/p_data->>'status'/.test(reg) && !/p_data->>'is_active'/.test(reg));
check('同公司手機重複：pending／active 擋下', /already_pending/.test(reg) && /already_active/.test(reg));

console.log('\n=== set_my_preferred_language（員工自助） ===');
const lang = fn('set_my_preferred_language');
check('只能改自己（line_user_id＋company_id）', /WHERE e\.company_id = p_company_id AND e\.line_user_id = p_line_user_id AND e\.is_active = true/.test(lang));
check('語言白名單', /NOT IN \('zh-TW', 'vi-VN'\)/.test(lang));

console.log('\n=== 內部函式權限 ===');
check('is_company_admin_caller REVOKE anon', /REVOKE ALL ON FUNCTION public\.is_company_admin_caller\(TEXT, UUID\) FROM PUBLIC, anon, authenticated/.test(code));
['admin_create_employee(UUID, TEXT, JSONB)', 'admin_update_employee(UUID, TEXT, UUID, JSONB)', 'admin_delete_pending_employee(UUID, TEXT, UUID)', 'register_employee(UUID, TEXT, JSONB)', 'set_my_preferred_language(UUID, TEXT, TEXT)']
  .forEach(sig => check('對外 RPC GRANT anon/authenticated：' + sig.split('(')[0], code.includes('GRANT EXECUTE ON FUNCTION public.' + sig + ' TO anon, authenticated')));

console.log('\n=== 前端 helper ===');
let helper = '';
try { helper = grab(commonSrc, 'rpcUpdateEmployee'); } catch (e) { check('找得到 rpcUpdateEmployee', false, e.message); }
check('helper 走 admin_update_employee 並帶公司與身分', /rpc\('admin_update_employee'/.test(helper) && /p_company_id: companyId \|\| window\.currentCompanyId/.test(helper) && /p_line_user_id: adminCallerLineUserId\(\)/.test(helper));
check('helper 把 success=false 轉成 error（沿用既有 throw 寫法）', /if \(!data\?\.success\) return \{ data, error: new Error\(data\?\.error/.test(helper));
check('employees.js 不再直接寫 employees', !/from\('employees'\)[^;]{0,400}?\.(insert|update|delete)\(/.test(empSrc));
check('employees.js 新增員工不再由前端帶 company_id／is_active', !/company_id: window\.currentAdminEmployee\?\.company_id \|\| window\.currentCompanyId,\s*created_at/.test(empSrc));
check('employee_register 改走 register_employee', /rpc\('register_employee'/.test(regSrc) && !/from\('employees'\)\.insert/.test(regSrc));
check('i18n 改走 set_my_preferred_language', /rpc\('set_my_preferred_language'/.test(i18nSrc) && !/from\('employees'\)\s*\.update/.test(i18nSrc));

console.log(`\n結果：${pass} 通過 / ${fail} 失敗`);
process.exit(fail > 0 ? 1 : 0);
