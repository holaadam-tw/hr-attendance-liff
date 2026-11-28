#!/usr/bin/env node
// Plan B Batch 1：12 個前端薪資／請假呼叫全部改走 LIFF verified action。
// 反向對照：PLANB161_FRONTEND_LEAK_LINE=1 會重新塞入前端 line_user_id，安全檢查必須失敗。
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.join(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
const sources = {
  audit: read('modules/audit.js'), employees: read('modules/employees.js'),
  leave: read('modules/leave.js'), payroll: read('modules/payroll.js')
};
if (process.env.PLANB161_FRONTEND_LEAK_LINE === '1') {
  sources.payroll = sources.payroll.replace(
    "{ company_id: window.currentCompanyId }, '薪資資料載入失敗'",
    "{ company_id: window.currentCompanyId, line_user_id: window.currentAdminEmployee?.line_user_id }, '薪資資料載入失敗'"
  );
}
const indexSource = read('modules/index.js');
const adminSource = read('admin.html');
const salarySource = read('salary.html');

let pass = 0, fail = 0;
function check(name, ok, detail = '') {
  ok ? pass++ : fail++;
  console.log(`  ${ok ? '✅' : '❌'} ${name}${detail ? ` → ${detail}` : ''}`);
}
const count = (source, pattern) => (source.match(pattern) || []).length;

(async () => {
  console.log('\n═══════════════════════════════════════');
  console.log('  Plan B Batch 1 前端 verified calls（161）');
  console.log('═══════════════════════════════════════');

  const expected = [
    ['payroll_salaries_get', 4], ['salary_setting_upsert', 2], ['payroll_company_get', 2],
    ['payroll_save', 2], ['salary_setting_get', 1], ['leave_review', 1]
  ];
  const all = Object.values(sources).join('\n');
  for (const [action, expectedCount] of expected) {
    const actual = count(all, new RegExp(`['"]${action}['"]`, 'g'));
    check(`${action} 呼叫點數量正確`, actual === expectedCount, `${actual}/${expectedCount}`);
  }
  check('工作單 12 個呼叫點全數切換', expected.reduce((sum, [, n]) => sum + n, 0) === 12);

  const oldFunctions = [
    'get_company_payroll', 'get_company_current_salaries', 'get_employee_current_salary',
    'upsert_salary_setting', 'save_payroll_records', 'approve_leave_request'
  ];
  for (const fn of oldFunctions) {
    check(`前端不再直接 sb.rpc('${fn}')`, !new RegExp(`sb\\.rpc\\(['"]${fn}['"]`).test(all));
  }

  const actionCalls = all.match(/(?:callVerifiedAction|callPayrollVerified)\(['"](?:payroll_company_get|payroll_salaries_get|salary_setting_get|salary_setting_upsert|payroll_save|leave_review)['"][\s\S]*?\}\s*(?:,\s*['"][^'"]*['"])?\)/g) || [];
  check('六類新 action 的 payload 不含前端 line_user_id', actionCalls.length === 12
    && actionCalls.every(call => !/line_user_id|liffProfile/.test(call)), `${actionCalls.length} calls`);
  check('六類新 action 的 payload 不含薪資 unlock token', actionCalls.every(call => !/unlock|payrollUnlockedUntil|sessionStorage/.test(call)));

  const helperMatch = sources.payroll.match(/async function callPayrollVerified[\s\S]*?\n\}/);
  check('payroll helper 存在並維持 {data,error} 介面', !!helperMatch);
  if (helperMatch) {
    const context = vm.createContext({ Error, callVerifiedAction: async () => ({ ok: true, data: { result: [{ id: 1 }] } }) });
    vm.runInContext(`${helperMatch[0]}; this.callPayrollVerified=callPayrollVerified;`, context);
    let result = await context.callPayrollVerified('payroll_salaries_get', {}, 'fallback');
    check('verified 成功時解包原 RPC result', Array.isArray(result.data) && result.data[0].id === 1 && result.error === null);
    context.callVerifiedAction = async () => ({ ok: false, code: 'access_denied', message: '需要管理員權限' });
    result = await context.callPayrollVerified('payroll_salaries_get', {}, 'fallback');
    check('verified 失敗時保留既有 error 拋出流程', result.data === null
      && result.error?.message === '需要管理員權限' && result.error?.code === 'access_denied');
  }

  check('員工薪資設定讀寫均檢查 verified ok 後才使用 result',
    /salary_setting_get[\s\S]*?if \(!salaryResult\.ok\) throw[\s\S]*?salaryResult\.data\?\.result/.test(sources.employees)
    && /salary_setting_upsert[\s\S]*?if \(!salaryResult\.ok\) throw[\s\S]*?salaryResult\.data\?\.result/.test(sources.employees));
  check('請假審核維持成功檢查、通知與 audit 流程',
    /leave_review[\s\S]*?if \(!reviewResult\.ok\) throw[\s\S]*?if \(!result\?\.success\) throw/.test(sources.leave)
    && /sendUserNotify/.test(sources.leave) && /writeAuditLog/.test(sources.leave));
  check('薪資草稿與發布仍分別送 false／true 並維持按鈕 finally 解鎖',
    /payroll_save[\s\S]*?is_published: false/.test(sources.payroll)
    && /payroll_save[\s\S]*?is_published: true/.test(sources.payroll)
    && count(sources.payroll, /finally\s*\{[\s\S]{0,160}btn\.disabled = false/g) >= 2);

  check('admin 升版 162 後仍保留第一批四個模組接線', /modules\/index\.js\?v=20261128-planb162/.test(adminSource)
    && ['audit', 'leave', 'payroll'].every(name => new RegExp(`${name}\\.js\\?v=20261128-planb162`).test(indexSource))
    && /employees\.js\?v=20261127-planb161/.test(indexSource));
  check('salary.html 保留 162 payroll 並載入 C1 verified-rpc 相容層', /modules\/payroll\.js\?v=20261128-planb162/.test(salarySource)
    && /modules\/verified-rpc\.js\?v=20261128-planb163c1/.test(salarySource));

  console.log(`\n結果：${pass} 通過、${fail} 失敗`);
  process.exitCode = fail ? 1 : 0;
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
