#!/usr/bin/env node
// Plan B Batch 1：line-push 六個 verified action 的路由與輸入邊界。
// fetch 全為本機假物件，不連 LINE／Supabase／正式庫。
const path = require('path');
const fs = require('fs');
const os = require('os');
const { execFileSync } = require('child_process');
const { pathToFileURL } = require('url');

let pass = 0, fail = 0;
function check(name, ok, detail = '') {
  ok ? pass++ : fail++;
  console.log(`  ${ok ? '✅' : '❌'} ${name}${detail ? ` → ${detail}` : ''}`);
}

const COMPANY = '10000000-0000-0000-0000-000000000001';
const EMPLOYEE = '20000000-0000-0000-0000-000000000001';
const REQUEST = '30000000-0000-0000-0000-000000000001';
const LINE_USER = 'U' + 'a'.repeat(32);
const env = key => ({ SUPABASE_URL: 'https://db.test', SUPABASE_SERVICE_ROLE_KEY: 'service-key' })[key];
const request = body => new Request('https://fn.test/line-push', {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ liff_access_token: 'valid-liff-token', ...body })
});

function fetchFor(rpcResponder) {
  const calls = [];
  const fetch = async (url, init = {}) => {
    const body = init.body ? JSON.parse(init.body) : null;
    calls.push({ url, body, headers: init.headers || {} });
    if (url.includes('/oauth2/v2.1/verify')) return Response.json({ client_id: '2008962829', expires_in: 3600, scope: 'profile' });
    if (url.includes('/v2/profile')) return Response.json({ userId: LINE_USER, displayName: '測試主管' });
    if (url.includes('/rest/v1/rpc/')) {
      const fn = url.split('/').pop();
      const answer = rpcResponder ? rpcResponder(fn, body) : { status: 200, body: { success: true } };
      return Response.json(answer.body, { status: answer.status });
    }
    throw new Error(`unexpected fetch: ${url}`);
  };
  return { fetch, calls };
}

const record = (overrides = {}) => ({
  employee_id: EMPLOYEE, year: 2026, month: 11, salary_type: 'monthly', base_salary: 42000,
  overtime_pay: 1000, bonus: 0, full_attendance_bonus: 3000, meal_allowance: 2000,
  position_allowance: 1000, night_allowance: 0, late_deduction: 0, absence_deduction: 0,
  personal_leave_deduction: 0, labor_insurance: 1000, health_insurance: 800, pension_self: 0,
  income_tax: 0, manual_adjustment: 0, adjustment_note: '', total_deduction: 1800,
  gross_salary: 49000, net_salary: 47200, calculation_details: { actual_days: 22 },
  is_published: false, updated_at: '2026-11-27T00:00:00.000Z', ...overrides
});

(async () => {
  console.log('\n═══════════════════════════════════════');
  console.log('  Plan B Batch 1 line-push actions（161）');
  console.log('═══════════════════════════════════════');

  let handlerPath = path.join(__dirname, '..', 'supabase', 'functions', 'line-push', 'handler.ts');
  if (process.env.PLANB161_EDGE_GIT_REF) {
    handlerPath = path.join(os.tmpdir(), `planb161-edge-${process.pid}.ts`);
    fs.writeFileSync(handlerPath, execFileSync('git', ['show', `${process.env.PLANB161_EDGE_GIT_REF}:supabase/functions/line-push/handler.ts`], { encoding: 'utf8' }));
    process.on('exit', () => { try { fs.unlinkSync(handlerPath); } catch (_) { /* temp cleanup */ } });
  }
  let handler;
  try {
    handler = await import(pathToFileURL(handlerPath).href);
  } catch (error) {
    if (error?.code === 'ERR_UNKNOWN_FILE_EXTENSION') {
      console.log(`  ⚠️ 略過：Node ${process.version} 無法載入 .ts，請使用 Node 22.18 以上`);
      process.exit(0);
    }
    throw error;
  }

  const validCases = [
    ['payroll_company_get', { company_id: COMPANY, year: 2026, month: 11 }, 'get_company_payroll_verified',
      { p_line_user_id: LINE_USER, p_company_id: COMPANY, p_year: 2026, p_month: 11 }, [{ ok: 1 }]],
    ['payroll_salaries_get', { company_id: COMPANY }, 'get_company_current_salaries_verified',
      { p_line_user_id: LINE_USER, p_company_id: COMPANY }, [{ employee_id: EMPLOYEE }]],
    ['salary_setting_get', { company_id: COMPANY, employee_id: EMPLOYEE }, 'get_employee_current_salary_verified',
      { p_line_user_id: LINE_USER, p_company_id: COMPANY, p_employee_id: EMPLOYEE }, { employee_id: EMPLOYEE }],
    ['salary_setting_upsert', { company_id: COMPANY, employee_id: EMPLOYEE, salary_type: 'monthly', base_salary: 42000,
      meal_allowance: 2000, position_allowance: 1000, full_attendance_bonus: 3000, pension_self_rate: 6, sync_employee_rate: true },
      'upsert_salary_setting_verified', { p_line_user_id: LINE_USER, p_company_id: COMPANY, p_employee_id: EMPLOYEE,
        p_salary_type: 'monthly', p_base_salary: 42000, p_meal_allowance: 2000, p_position_allowance: 1000,
        p_full_attendance_bonus: 3000, p_pension_self_rate: 6, p_sync_employee_rate: true }, { success: true }],
    ['payroll_save', { company_id: COMPANY, year: 2026, month: 11, records: [record()], is_published: false },
      'save_payroll_records_verified', null, { success: true, count: 1 }],
    ['leave_review', { company_id: COMPANY, request_id: REQUEST, status: 'approved', rejection_reason: null },
      'approve_leave_request_verified', { p_line_user_id: LINE_USER, p_company_id: COMPANY, p_request_id: REQUEST,
        p_status: 'approved', p_rejection_reason: null }, { success: true, request_id: REQUEST }],
  ];

  for (const [action, payload, expectedRpc, expectedArgs, rpcData] of validCases) {
    const fake = fetchFor((fn) => ({ status: 200, body: rpcData }));
    const response = await handler.handleLinePush(request({ action, ...payload }), { fetch: fake.fetch, env });
    const output = await response.json();
    const rpcCall = fake.calls.find(call => call.url.includes('/rest/v1/rpc/'));
    const argsOk = expectedArgs === null
      ? rpcCall?.body?.p_line_user_id === LINE_USER && rpcCall?.body?.p_company_id === COMPANY
        && rpcCall?.body?.p_records?.length === 1 && !('line_user_id' in rpcCall.body.p_records[0])
      : JSON.stringify(rpcCall?.body) === JSON.stringify(expectedArgs);
    check(`${action} 路由到 ${expectedRpc}，LINE ID 取自驗證結果`, response.status === 200
      && output.ok === true && rpcCall?.url.endsWith(`/rpc/${expectedRpc}`) && argsOk,
      JSON.stringify(rpcCall?.body));
  }

  console.log('\n=== 白名單、型別、範圍與大小 ===');
  for (const [action, payload] of validCases.map(([a, p]) => [a, p])) {
    const fake = fetchFor();
    const response = await handler.handleLinePush(request({ action, ...payload, unexpected: true }), { fetch: fake.fetch, env });
    check(`${action} 拒絕白名單外欄位`, response.status === 400 && !fake.calls.some(c => c.url.includes('/rest/v1/rpc/')));
  }
  const invalids = [
    ['年月超出範圍', { action: 'payroll_company_get', company_id: COMPANY, year: 1999, month: 13 }],
    ['員工 ID 不是 UUID', { action: 'salary_setting_get', company_id: COMPANY, employee_id: 'not-uuid' }],
    ['薪資型別與數值範圍錯誤', { action: 'salary_setting_upsert', company_id: COMPANY, employee_id: EMPLOYEE,
      salary_type: 'weekly', base_salary: -1, meal_allowance: 0, position_allowance: 0,
      full_attendance_bonus: 0, pension_self_rate: 101, sync_employee_rate: 'yes' }],
    ['薪資陣列不可為空', { action: 'payroll_save', company_id: COMPANY, year: 2026, month: 11, records: [], is_published: false }],
    ['薪資列年月必須和外層一致', { action: 'payroll_save', company_id: COMPANY, year: 2026, month: 11,
      records: [record({ month: 10 })], is_published: false }],
    ['薪資列數上限 500', { action: 'payroll_save', company_id: COMPANY, year: 2026, month: 11,
      records: Array.from({ length: 501 }, () => record()), is_published: false }],
    ['薪資 JSON 上限 1 MiB', { action: 'payroll_save', company_id: COMPANY, year: 2026, month: 11,
      records: [record({ adjustment_note: 'x'.repeat(1024 * 1024) })], is_published: false }],
    ['請假狀態只允許核准或拒絕', { action: 'leave_review', company_id: COMPANY, request_id: REQUEST,
      status: 'pending', rejection_reason: null }],
    ['拒絕原因上限 500 字', { action: 'leave_review', company_id: COMPANY, request_id: REQUEST,
      status: 'rejected', rejection_reason: 'x'.repeat(501) }],
  ];
  for (const [name, payload] of invalids) {
    const fake = fetchFor();
    const response = await handler.handleLinePush(request(payload), { fetch: fake.fetch, env });
    check(name, response.status === 400 && !fake.calls.some(c => c.url.includes('/rest/v1/rpc/')));
  }

  const missing = fetchFor(() => ({ status: 404, body: { code: 'PGRST202', message: 'function not found' } }));
  const missingResponse = await handler.handleLinePush(request({ action: 'payroll_salaries_get', company_id: COMPANY }), { fetch: missing.fetch, env });
  const missingOutput = await missingResponse.json();
  check('verified RPC 尚未部署時明確回 db_not_migrated／161', missingResponse.status === 503
    && missingOutput.code === 'db_not_migrated' && /161/.test(missingOutput.error), JSON.stringify(missingOutput));

  console.log(`\n結果：${pass} 通過、${fail} 失敗`);
  process.exitCode = fail ? 1 : 0;
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
