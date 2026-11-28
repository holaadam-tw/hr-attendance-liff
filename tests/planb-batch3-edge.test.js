#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');

const root = path.join(__dirname, '..');
let migration = fs.readFileSync(path.join(root, 'migrations', '163_planb_batch3_self_verified.sql'), 'utf8');
const handlerSource = fs.readFileSync(path.join(root, 'supabase', 'functions', 'line-push', 'handler.ts'), 'utf8');
if (process.env.PLANB163_EDGE_SPEC_DRIFT === '1') {
  migration = migration.replace('p_line_user_id text, p_trip_id uuid', 'p_line_user_id text, p_trip_id uuid, p_drift text');
}

let pass = 0;
let fail = 0;
function check(name, ok, detail = '') {
  ok ? pass++ : fail++;
  console.log(`  ${ok ? '✅' : '❌'} ${name}${detail ? ` — ${detail}` : ''}`);
}

const COMPANY = '10000000-0000-0000-0000-000000000001';
const OTHER = '10000000-0000-0000-0000-000000000002';
const UUID = '20000000-0000-0000-0000-000000000001';
const LINE = 'U' + 'a'.repeat(32);
const env = key => ({ SUPABASE_URL: 'https://db.test', SUPABASE_SERVICE_ROLE_KEY: 'service-key' })[key];

function request(body) {
  return new Request('https://fn.test/line-push', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'self_rpc', liff_access_token: 'valid', ...body }),
  });
}

function fakeFetch(rpcResponder = () => ({ status: 200, body: { accepted: true } })) {
  const calls = [];
  const fetch = async (url, init = {}) => {
    const body = init.body ? JSON.parse(init.body) : null;
    calls.push({ url, body });
    if (url.includes('/oauth2/v2.1/verify')) return Response.json({ client_id: '2008962829', expires_in: 3600 });
    if (url.includes('/v2/profile')) return Response.json({ userId: LINE });
    if (url.includes('/rest/v1/rpc/')) {
      const answer = rpcResponder(url.split('/').pop(), body);
      return Response.json(answer.body, { status: answer.status });
    }
    throw new Error(`unexpected fetch ${url}`);
  };
  return { fetch, calls };
}

function sqlSignatures(sql) {
  const out = {};
  const re = /CREATE OR REPLACE FUNCTION public\.(\w+)_verified\(([\s\S]*?)\)\s+RETURNS/g;
  let match;
  while ((match = re.exec(sql))) {
    const params = match[2].split(',').map(value => value.trim().replace(/\s+/g, ' ')).map(definition => {
      const parsed = definition.match(/^(p_\w+)\s+(.+?)(\s+DEFAULT\s+[\s\S]+)?$/);
      if (!parsed) throw new Error(`cannot parse ${definition}`);
      return { name: parsed[1], sqlType: parsed[2], required: !parsed[3] };
    }).filter(param => param.name !== 'p_line_user_id');
    (out[match[1]] ||= []).push(params);
  }
  return out;
}

function edgeTypeForSql(sqlType) {
  if (sqlType === 'uuid') return 'uuid';
  if (sqlType === 'date') return 'date';
  if (/^time /.test(sqlType)) return 'time';
  if (sqlType === 'integer') return 'integer';
  if (sqlType === 'numeric') return 'number';
  if (sqlType === 'boolean') return 'boolean';
  if (sqlType === 'text[]') return 'text[]';
  if (sqlType === 'jsonb') return 'jsonb';
  if (sqlType === 'text' || sqlType === 'character varying') return 'text';
  throw new Error(`unmapped SQL type ${sqlType}`);
}

function normalizedSqlSignatures(items) {
  return items.map(params => params.map(param => ({
    name: param.name,
    type: edgeTypeForSql(param.sqlType),
    required: param.required,
  })).sort((a, b) => a.name.localeCompare(b.name)))
    .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
}

function normalizedEdgeSignatures(spec) {
  return spec.signatures.map(item => Object.entries(item.params).map(([name, param]) => ({
    name,
    type: param.type,
    required: param.required === true,
  })).sort((a, b) => a.name.localeCompare(b.name)))
    .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
}

function sample(name, spec) {
  if (spec.type === 'uuid') return UUID;
  if (spec.type === 'date') return '2026-11-28';
  if (spec.type === 'time') return name.includes('end') ? '17:00' : '08:00';
  if (spec.type === 'text') return spec.allowed?.[0] || (name === 'p_reason' ? 'sample reason' : 'sample');
  if (spec.type === 'integer') return name === 'p_year' ? 2026 : name === 'p_month' ? 11 : Math.max(spec.min ?? 1, 1);
  if (spec.type === 'number') return Math.max(spec.min ?? 1, 1);
  if (spec.type === 'boolean') return true;
  if (spec.type === 'text[]') return ['approved'];
  if (name === 'p_points') return [{ lat: 25, lng: 121, recorded_at: '2026-11-28T00:00:00Z' }];
  return { name: '王小明', phone: '0900000000' };
}

(async () => {
  console.log('\n=== Plan B 第三批 line-push self_rpc ===');
  const handler = await import(pathToFileURL(path.join(root, 'supabase', 'functions', 'line-push', 'handler.ts')).href);
  const parsed = sqlSignatures(migration);
  const names = Object.keys(handler.SELF_RPC_SPECS);
  check('Edge 白名單恰為 15 個函式名稱', names.length === 15, String(names.length));
  check('migration 共有 17 支 overload wrapper', Object.values(parsed).reduce((sum, list) => sum + list.length, 0) === 17);
  check('migration 與 Edge 函式名稱完全一致', JSON.stringify(Object.keys(parsed).sort()) === JSON.stringify([...names].sort()));

  for (const fn of names) {
    check(`${fn} 每個 overload 的名稱／型別／必填與 migration 一致`,
      JSON.stringify(normalizedSqlSignatures(parsed[fn] || [])) === JSON.stringify(normalizedEdgeSignatures(handler.SELF_RPC_SPECS[fn])));
  }

  for (const fn of names) {
    const spec = handler.SELF_RPC_SPECS[fn];
    const selected = spec.signatures.find(item => Object.hasOwn(item.params, 'p_company_id')) || spec.signatures[0];
    const args = {};
    for (const [name, param] of Object.entries(selected.params)) {
      if (name !== 'p_company_id' && param.required) args[name] = sample(name, param);
    }
    const needsCompany = spec.signatures.some(item => Object.hasOwn(item.params, 'p_company_id'));
    const fake = fakeFetch();
    const response = await handler.handleLinePush(request({ ...(needsCompany ? { company_id: COMPANY } : {}), fn, args }), { fetch: fake.fetch, env });
    const output = await response.json();
    const rpc = fake.calls.find(call => call.url.includes('/rest/v1/rpc/'));
    check(`${fn} 僅路由至 verified 並注入 LINE／必要公司`, response.status === 200 && output.ok === true
      && rpc?.url.endsWith(`/rpc/${fn}_verified`) && rpc.body.p_line_user_id === LINE
      && (!needsCompany || rpc.body.p_company_id === COMPANY));
  }

  for (const [label, payload] of [
    ['未知 fn', { fn: 'quick_check_in', args: {} }],
    ['原型鏈 fn __proto__', { fn: '__proto__', args: {} }],
    ['原型鏈 fn constructor', { fn: 'constructor', args: {} }],
    ['原型鏈 fn toString', { fn: 'toString', args: {} }],
    ['原型鏈 arg constructor', { fn: 'get_my_current_salary', args: { constructor: 'x' } }],
    ['未知 arg', { fn: 'get_my_current_salary', args: { surprise: true } }],
    ['夾帶 p_line_user_id', { fn: 'get_my_current_salary', args: { p_line_user_id: 'Uspoof' } }],
    ['公司不一致', { company_id: COMPANY, fn: 'get_company_leave_overlap', args: { p_company_id: OTHER, p_from: '2026-11-01', p_to: '2026-11-30' } }],
    ['缺少必要公司', { fn: 'get_company_leave_overlap', args: { p_from: '2026-11-01', p_to: '2026-11-30' } }],
    ['payload 多餘欄位', { fn: 'get_my_current_salary', args: {}, extra: true }],
    ['UUID 型別錯誤', { fn: 'count_fw_trackpoints', args: { p_trip_id: 'bad' } }],
    ['日期不存在', { fn: 'submit_overtime_request', args: { p_ot_date: '2026-02-30', p_hours: 1, p_reason: 'x' } }],
    ['整數超界', { fn: 'get_employee_schedule', args: { p_year: 2026, p_month: 13 } }],
    ['number 型別錯誤', { fn: 'submit_overtime_request', args: { p_ot_date: '2026-11-28', p_hours: '1', p_reason: 'x' } }],
    ['文字列舉錯誤', { company_id: COMPANY, fn: 'set_my_preferred_language', args: { p_language: 'en-US' } }],
    ['缺少必填參數', { fn: 'get_my_payslip', args: { p_year: 2026 } }],
    ['jsonb 過大', { fn: 'insert_fw_trackpoints', args: { p_trip_id: UUID, p_points: { value: 'x'.repeat(70000) } } }],
  ]) {
    const fake = fakeFetch();
    const response = await handler.handleLinePush(request(payload), { fetch: fake.fetch, env });
    check(`${label}回 400 且不碰 RPC`, response.status === 400 && !fake.calls.some(call => call.url.includes('/rest/v1/rpc/')));
  }

  let fake = fakeFetch();
  let response = await handler.handleLinePush(request({ fn: 'get_my_current_salary', args: {} }), { fetch: fake.fetch, env });
  check('不需公司的函式可省略 company_id', response.status === 200
    && fake.calls.some(call => call.url.endsWith('/rpc/get_my_current_salary_verified')));

  fake = fakeFetch(() => ({ status: 200, body: { success: true } }));
  response = await handler.handleLinePush(request({
    fn: 'submit_overtime_request',
    args: { p_ot_date: '2026-11-28', p_hours: 1.5, p_reason: '', p_compensation_type: 'comp_leave' },
  }), { fetch: fake.fetch, env });
  check('現行補休代碼 comp_leave 與空白加班理由仍可送出', response.status === 200
    && fake.calls.some(call => call.url.endsWith('/rpc/submit_overtime_request_verified')));

  fake = fakeFetch();
  response = await handler.handleLinePush(request({
    fn: 'submit_overtime_request',
    args: { p_ot_date: '2026-11-28', p_hours: 1.5, p_compensation_type: 'comp_leave' },
  }), { fetch: fake.fetch, env });
  check('加班理由參數不可省略', response.status === 400
    && !fake.calls.some(call => call.url.includes('/rest/v1/rpc/')));

  fake = fakeFetch();
  response = await handler.handleLinePush(request({
    fn: 'submit_overtime_request',
    args: { p_ot_date: '2026-11-28', p_hours: 1.5, p_reason: '', p_compensation_type: 'compensatory_leave' },
  }), { fetch: fake.fetch, env });
  check('錯誤補休代碼 compensatory_leave 被拒絕', response.status === 400
    && !fake.calls.some(call => call.url.includes('/rest/v1/rpc/')));

  fake = fakeFetch();
  response = await handler.handleLinePush(new Request('https://fn.test/line-push', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'admin_rpc', liff_access_token: 'valid', fn: 'get_company_shift_types', args: {} }),
  }), { fetch: fake.fetch, env });
  check('admin_rpc 缺公司仍維持 400 且不驗證 LINE', response.status === 400 && fake.calls.length === 0);

  for (const [label, rpcBody, expected] of [
    ['TABLE array', [{ id: 1 }], [{ id: 1 }]],
    ['jsonb object', { salary_type: 'monthly' }, { salary_type: 'monthly' }],
  ]) {
    fake = fakeFetch(() => ({ status: 200, body: rpcBody }));
    response = await handler.handleLinePush(request({ fn: 'get_my_current_salary', args: {} }), { fetch: fake.fetch, env });
    const output = await response.json();
    check(`${label} 保留在 result`, response.status === 200 && JSON.stringify(output.result) === JSON.stringify(expected));
  }

  fake = fakeFetch(() => ({ status: 400, body: { code: '42501', message: 'access_denied: employee required' } }));
  response = await handler.handleLinePush(request({ fn: 'get_my_current_salary', args: {} }), { fetch: fake.fetch, env });
  let output = await response.json();
  check('舊函式權限錯誤保留 code/message', response.status === 403 && output.code === '42501' && /employee required/.test(output.error));

  fake = fakeFetch(() => ({ status: 404, body: { code: 'PGRST202', message: 'not found' } }));
  response = await handler.handleLinePush(request({ fn: 'get_my_current_salary', args: {} }), { fetch: fake.fetch, env });
  output = await response.json();
  check('缺少 verified RPC 回 db_not_migrated 163', response.status === 503 && output.code === 'db_not_migrated' && /163/.test(output.error));

  const selfBranch = handlerSource.slice(handlerSource.indexOf("if (action === 'self_rpc')"), handlerSource.indexOf("if (action === 'payroll_company_get')"));
  check('self_rpc 白名單只用 hasOwnProperty，不使用 in 或未檢查直取',
    selfBranch.includes('Object.prototype.hasOwnProperty.call') && !/\s+in\s+body\.args/.test(selfBranch));

  console.log(`\n結果：${pass} 通過，${fail} 失敗`);
  process.exitCode = fail ? 1 : 0;
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
