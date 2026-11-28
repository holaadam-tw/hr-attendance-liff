#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');

const root = path.join(__dirname, '..');
let migration = fs.readFileSync(path.join(root, 'migrations', '162_planb_batch2_admin_verified.sql'), 'utf8');
if (process.env.PLANB162_EDGE_SPEC_DRIFT === '1') {
  migration = migration.replace('p_line_user_id text, p_company_id uuid\n)', 'p_line_user_id text, p_company_id uuid, p_drift text\n)');
}

let pass = 0, fail = 0;
function check(name, ok, detail = '') {
  ok ? pass++ : fail++;
  console.log(`  ${ok ? '✅' : '❌'} ${name}${detail ? ` — ${detail}` : ''}`);
}

const COMPANY = '10000000-0000-0000-0000-000000000001';
const OTHER = '10000000-0000-0000-0000-000000000002';
const UUID = '20000000-0000-0000-0000-000000000001';
const LINE = 'U' + 'a'.repeat(32);
const env = key => ({ SUPABASE_URL: 'https://db.test', SUPABASE_SERVICE_ROLE_KEY: 'service-key' })[key];
const request = body => new Request('https://fn.test/line-push', {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ action: 'admin_rpc', liff_access_token: 'valid', company_id: COMPANY, ...body })
});

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

function sqlParams(sql) {
  const out = {};
  const re = /CREATE OR REPLACE FUNCTION public\.(\w+)_verified\(([\s\S]*?)\)\s+RETURNS/g;
  let m;
  while ((m = re.exec(sql))) {
    out[m[1]] = m[2].split(',').map(s => s.trim().match(/^(p_\w+)/)?.[1]).filter(Boolean)
      .filter(name => name !== 'p_line_user_id');
  }
  return out;
}

function sample(name, spec) {
  if (name === 'p_company_id') return COMPANY;
  if (spec.type === 'uuid') return UUID;
  if (spec.type === 'date') return '2026-11-28';
  if (spec.type === 'time') return '08:30';
  if (spec.type === 'text') return name === 'p_decision' ? 'approve' : 'sample';
  if (spec.type === 'integer') return Math.max(spec.min ?? 1, name === 'p_year' ? 2026 : name === 'p_month' ? 11 : 1);
  if (spec.type === 'boolean') return true;
  if (spec.type === 'text[]') return ['approved'];
  return { sample: true };
}

(async () => {
  console.log('\n=== Plan B 第二批 line-push admin_rpc ===');
  const handler = await import(pathToFileURL(path.join(root, 'supabase', 'functions', 'line-push', 'handler.ts')).href);
  const parsed = sqlParams(migration);
  const names = Object.keys(handler.ADMIN_RPC_SPECS);
  check('Edge 白名單恰為 29 支', names.length === 29, String(names.length));
  check('migration 與 Edge 函式名稱完全一致', JSON.stringify(Object.keys(parsed).sort()) === JSON.stringify(names.sort()));
  for (const fn of names) {
    check(`${fn} 參數白名單與 migration 一致`,
      JSON.stringify((parsed[fn] || []).sort()) === JSON.stringify(Object.keys(handler.ADMIN_RPC_SPECS[fn].params).sort()));
  }

  for (const fn of names) {
    const spec = handler.ADMIN_RPC_SPECS[fn];
    const args = {};
    for (const [name, param] of Object.entries(spec.params)) {
      if (param.required || name === 'p_company_id') args[name] = sample(name, param);
    }
    const fake = fakeFetch();
    const response = await handler.handleLinePush(request({ fn, args }), { fetch: fake.fetch, env });
    const output = await response.json();
    const rpc = fake.calls.find(call => call.url.includes('/rest/v1/rpc/'));
    check(`${fn} 僅路由至 ${fn}_verified 並注入已驗證 LINE ID`, response.status === 200 && output.ok === true
      && rpc?.url.endsWith(`/rpc/${fn}_verified`) && rpc.body.p_line_user_id === LINE
      && (!('p_company_id' in spec.params) || rpc.body.p_company_id === COMPANY));
  }

  for (const [label, payload] of [
    ['未知 fn', { fn: 'quick_check_in', args: {} }],
    ['未知 arg', { fn: 'get_company_shift_types', args: { p_company_id: COMPANY, surprise: true } }],
    ['夾帶 p_line_user_id', { fn: 'get_company_shift_types', args: { p_company_id: COMPANY, p_line_user_id: 'Uspoof' } }],
    ['公司不一致', { fn: 'get_company_shift_types', args: { p_company_id: OTHER } }],
    ['payload 多餘欄位', { fn: 'get_company_shift_types', args: { p_company_id: COMPANY }, extra: true }],
    ['UUID 型別錯誤', { fn: 'delete_shift_type', args: { p_company_id: COMPANY, p_id: 'bad' } }],
    ['日期不存在', { fn: 'get_company_holidays', args: { p_company_id: COMPANY, p_from: '2026-02-30', p_to: '2026-03-01' } }],
    ['時間型別錯誤', { fn: 'create_shift_type', args: { p_company_id: COMPANY, p_name: 'D', p_code: 'D', p_start_time: '25:00', p_end_time: '17:00' } }],
    ['整數超界', { fn: 'get_company_monthly_attendance', args: { p_company_id: COMPANY, p_year: 2026, p_month: 13 } }],
    ['boolean 型別錯誤', { fn: 'set_missing_work_hours_notification_enabled', args: { p_company_id: COMPANY, p_enabled: 'yes' } }],
    ['text[] 型別錯誤', { fn: 'get_company_leave_requests', args: { p_company_id: COMPANY, p_statuses: 'approved' } }],
  ]) {
    const fake = fakeFetch();
    const response = await handler.handleLinePush(request(payload), { fetch: fake.fetch, env });
    check(`${label}回 400 且不碰 RPC`, response.status === 400 && !fake.calls.some(c => c.url.includes('/rest/v1/rpc/')));
  }
  check('jsonb validator 限制 64 KiB', handler.validateAdminRpcValue({ a: 1 }, { type: 'jsonb' })
    && !handler.validateAdminRpcValue({ a: 'x'.repeat(70000) }, { type: 'jsonb' }));

  for (const [label, rpcBody, expected] of [
    ['TABLE array', [{ id: 1 }], [{ id: 1 }]],
    ['jsonb object', { enabled: true }, { enabled: true }],
    ['void null', null, null],
  ]) {
    const fake = fakeFetch(() => ({ status: 200, body: rpcBody }));
    const response = await handler.handleLinePush(request({ fn: 'get_company_shift_types', args: { p_company_id: COMPANY } }), { fetch: fake.fetch, env });
    const output = await response.json();
    check(`${label} 保留在 result`, response.status === 200 && JSON.stringify(output.result) === JSON.stringify(expected));
  }

  let fake = fakeFetch(() => ({ status: 400, body: { code: '42501', message: 'access_denied: manager required' } }));
  let response = await handler.handleLinePush(request({ fn: 'get_company_shift_types', args: { p_company_id: COMPANY } }), { fetch: fake.fetch, env });
  let output = await response.json();
  check('舊函式權限錯誤保留 code/message', response.status === 403 && output.code === '42501' && /manager required/.test(output.error));

  fake = fakeFetch(() => ({ status: 404, body: { code: 'PGRST202', message: 'not found' } }));
  response = await handler.handleLinePush(request({ fn: 'get_company_shift_types', args: { p_company_id: COMPANY } }), { fetch: fake.fetch, env });
  output = await response.json();
  check('缺少 verified RPC 回 db_not_migrated 162', response.status === 503 && output.code === 'db_not_migrated' && /162/.test(output.error));

  console.log(`\n結果：${pass} 通過，${fail} 失敗`);
  process.exitCode = fail ? 1 : 0;
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
