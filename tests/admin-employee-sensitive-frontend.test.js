#!/usr/bin/env node
// 管理端員工敏感欄位：基本資料照常顯示、verified 補值、失敗降級與編輯防空值覆寫。
// 反向對照：EMPLOYEES_FILE 可指向移除 sensitiveLoaded 防線的副本，測試必須失敗。
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.join(__dirname, '..');
const employeesPath = process.env.EMPLOYEES_FILE || path.join(root, 'modules', 'employees.js');
let employeesSource = fs.readFileSync(employeesPath, 'utf8');
if (process.env.EMPLOYEES_NO_SENSITIVE_WRITE_GUARD === '1') {
  employeesSource = employeesSource.replace(
    "if (phoneEl?.dataset.sensitiveLoaded === '1') {",
    'if (true) {'
  );
}
let payrollSource = fs.readFileSync(path.join(root, 'modules', 'payroll.js'), 'utf8');
if (process.env.PAYROLL_SALARY_TYPE_FALLBACK_MUTATION === '1') {
  payrollSource = payrollSource
    .replace(
      "sb.from('employees').select('id, name, employee_number, department, status, salary_type, resigned_date')",
      "sb.from('employees').select('id, name, employee_number, department, status, resigned_date')"
    )
    .replace(
      "const salaryType = (salaryMap[emp.id]?.salary_type) || emp.salary_type || 'monthly';",
      "const salaryType = salaryMap[emp.id]?.salary_type || 'monthly';"
    );
}
const indexSource = fs.readFileSync(path.join(root, 'modules', 'index.js'), 'utf8');
const adminSource = fs.readFileSync(path.join(root, 'admin.html'), 'utf8');

let pass = 0, fail = 0;
function check(name, ok, detail = '') {
  ok ? pass++ : fail++;
  console.log(`  ${ok ? '✅' : '❌'} ${name}${detail ? ` → ${detail}` : ''}`);
}

function makeElements() {
  const elements = new Map();
  return {
    elements,
    getElementById(id) {
      if (!elements.has(id)) elements.set(id, {
        id, value: '', innerHTML: '', textContent: '', placeholder: '', checked: false,
        dataset: {}, style: { display: 'none' }
      });
      return elements.get(id);
    }
  };
}

function makeContext({ verifiedResult, employeeRows = [] } = {}) {
  const document = makeElements();
  const toasts = [];
  const query = {
    select() { return this; }, eq() { return this; }, in() { return this; }, is() { return this; },
    not() { return this; }, order() { return this; }, maybeSingle() { return this; }, single() { return this; },
    then(resolve) { resolve({ data: employeeRows, error: null }); }
  };
  const context = vm.createContext({
    console: { log() {}, error() {} }, document, Map, Set, Promise,
    window: { currentCompanyId: '10000000-0000-0000-0000-000000000001', currentEmployee: null },
    sb: { from() { return query; } },
    showToast(message) { toasts.push(message); },
    escapeHTML(value) { return String(value ?? ''); },
    friendlyError(error) { return error?.message || String(error); },
    callVerifiedAction: async () => verifiedResult || { ok: false, message: 'verified failed', data: null },
    EMPLOYEE_READ_COLUMNS: 'id,name',
    getCachedSetting: () => [], saveSetting: async () => {}, fmtDate: () => '2026-11-27',
    confirm: () => true, prompt: () => null, alert: () => {}, QRCode: function () {}
  });
  const runnable = employeesSource
    .replace(/^import[^\n]+\n/m, '')
    .replace(/\bexport\s+/g, '');
  vm.runInContext(runnable, context, { filename: 'modules/employees.js' });
  return { context, document, toasts };
}

(async () => {
  console.log('\n═══════════════════════════════════════');
  console.log('  管理端員工敏感欄位前端');
  console.log('═══════════════════════════════════════');

  const baseEmployee = {
    id: '20000000-0000-0000-0000-000000000001', name: '測試員工', employee_number: 'E001',
    department: '生產部', position: '技術員', role: 'user', hire_date: '2026-01-01',
    employment_type: 'fulltime', line_user_id: null, preferred_language: 'zh-TW'
  };
  const sensitiveEmployee = {
    employee_id: baseEmployee.id, phone: '0912345678', email: 'employee@test',
    emergency_contact: '家人', emergency_phone: '0900000000', id_card_last_4: '1234', salary_type: 'monthly'
  };

  let env = makeContext({
    employeeRows: [baseEmployee],
    verifiedResult: { ok: true, data: { result: { success: true, employees: [sensitiveEmployee] } } }
  });
  vm.runInContext('loadPendingCount=()=>{}; loadVietnameseCount=()=>{}', env.context);
  await vm.runInContext('loadEmployeeList()', env.context);
  const html = env.document.getElementById('employeeList').innerHTML;
  check('基本清單以 verified 結果補上手機與身分證後四碼', /0912345678/.test(html) && /1234/.test(html), html);
  check('前端只送 company_id 與 employee_ids', /callVerifiedAction\('admin_employee_sensitive',[\s\S]*?company_id: window\.currentCompanyId,[\s\S]*?employee_ids: ids\.slice\(0, 500\)/.test(employeesSource));

  env = makeContext({ employeeRows: [baseEmployee], verifiedResult: { ok: false, message: '拒絕', data: null } });
  vm.runInContext('loadPendingCount=()=>{}; loadVietnameseCount=()=>{}', env.context);
  await vm.runInContext('loadEmployeeList()', env.context);
  await vm.runInContext('loadEmployeeSensitiveMap(["20000000-0000-0000-0000-000000000001"])', env.context);
  const fallbackHtml = env.document.getElementById('employeeList').innerHTML;
  check('verified 失敗時基本員工資料仍顯示且敏感欄位為破折號', /測試員工/.test(fallbackHtml) && /📱 —/.test(fallbackHtml) && /驗證碼: —/.test(fallbackHtml), fallbackHtml);
  check('verified 失敗只提示一次', env.toasts.filter(message => /敏感資料暫時無法載入/.test(message)).length === 1,
    JSON.stringify(env.toasts));

  env = makeContext();
  const values = {
    editEmpId: baseEmployee.id, editEmpName: '測試員工', editEmpDept: '生產部', editEmpPosition: '技術員',
    editEmpHireDate: '2026-01-01', editEmpType: 'fulltime', editEmpPreferredLanguage: 'zh-TW',
    editEmpLineUserId: '', editDefaultLunch: '', editEmpPhone: ''
  };
  for (const [id, value] of Object.entries(values)) env.document.getElementById(id).value = value;
  env.document.getElementById('editEmpPhone').dataset.sensitiveLoaded = '0';
  env.document.getElementById('editEmpRoleGroup').style.display = 'none';
  env.context.__updates = null;
  env.context.rpcUpdateEmployee = async (_id, updates) => { env.context.__updates = updates; return { error: null }; };
  vm.runInContext('closeEditEmployeeModal=()=>{}; loadEmployeeList=()=>{}', env.context);
  await vm.runInContext('saveEditEmployee()', env.context);
  check('敏感欄位未載入時儲存 payload 不含 phone', env.context.__updates && !Object.prototype.hasOwnProperty.call(env.context.__updates, 'phone'),
    JSON.stringify(env.context.__updates));

  env.document.getElementById('editEmpPhone').dataset.sensitiveLoaded = '1';
  env.document.getElementById('editEmpPhone').value = '0987654321';
  await vm.runInContext('saveEditEmployee()', env.context);
  check('敏感欄位成功載入後才允許儲存 phone', env.context.__updates?.phone === '0987654321', JSON.stringify(env.context.__updates));

  check('payroll 讀 employees.salary_type，查詢與 origin/main 相同', payrollSource.includes(
    "sb.from('employees').select('id, name, employee_number, department, status, salary_type, resigned_date')"
  ));
  check('薪資稽核以 salaryMap 優先、employees.salary_type fallback，且與 origin/main 相同', payrollSource.includes(
    "const salaryType = (salaryMap[emp.id]?.salary_type) || emp.salary_type || 'monthly';"
  ));
  check('admin 與 employees／payroll 模組快取版本皆維持目前批次', /modules\/index\.js\?v=20261128-planb162/.test(adminSource)
    && /employees\.js\?v=20261127-(?:empcols159|planb161)/.test(indexSource)
    && /payroll\.js\?v=20261128-planb162/.test(indexSource));

  console.log(`\n結果：${pass} 通過、${fail} 失敗`);
  process.exitCode = fail ? 1 : 0;
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
