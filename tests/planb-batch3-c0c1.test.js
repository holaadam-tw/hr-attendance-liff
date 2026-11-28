#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { spawnSync } = require('child_process');
const { pathToFileURL } = require('url');

const root = path.join(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
const mutation = process.env.PLANB3C1_MUTATION || '';
let helper = read('modules/verified-rpc.js');
const pages = {
  salary: read('salary.html'),
  schedule: read('schedule.html'),
  fieldwork: read('fieldwork.html'),
  register: read('employee_register.html'),
};
if (mutation === 'direct_rpc') {
  pages.salary = pages.salary.replace("callSelfRpc('get_my_payslip'", "sb.rpc('get_my_payslip'");
}
if (mutation === 'relogin_read') {
  helper = helper.replace('const autoRelogin = options.autoRelogin === true;', 'const autoRelogin = true;');
}

let passed = 0;
let failed = 0;
function check(name, ok, detail = '') {
  if (ok) passed++; else failed++;
  console.log(`  ${ok ? '✅' : '❌'} ${name}${detail ? ` — ${detail}` : ''}`);
}

function makeHelperHarness({ token = 'token', edgeResult = { ok: true, result: { value: 1 } } } = {}) {
  const calls = [];
  const actions = [];
  const toasts = [];
  let tokenReads = 0;
  let reloads = 0;
  const context = {
    window: null,
    console,
    CONFIG: { SUPABASE_URL: 'https://db.test', SUPABASE_ANON_KEY: 'anon-key' },
    currentCompanyId: '10000000-0000-0000-0000-000000000001',
    getLiffAccessTokenSafe: () => { tokenReads++; return token; },
    showToast: message => toasts.push(String(message)),
    location: { reload: () => { reloads++; } },
    fetch: async (url, init) => {
      calls.push({ url, body: JSON.parse(init.body), headers: init.headers });
      return { json: async () => edgeResult };
    },
    callVerifiedAction: async (action, payload) => {
      actions.push({ action, payload });
      return { ok: true, data: { result: { via: 'action' } } };
    },
  };
  context.window = context;
  vm.createContext(context);
  vm.runInContext(helper, context);
  return { context, calls, actions, toasts, tokenReads: () => tokenReads, reloads: () => reloads };
}

function extractFunction(source, name) {
  const patterns = [`async function ${name}(`, `function ${name}(`];
  const start = patterns.map(pattern => source.indexOf(pattern)).find(index => index >= 0);
  if (start == null) throw new Error(`找不到 ${name}`);
  const brace = source.indexOf('{', start);
  let depth = 0;
  let quote = '';
  let escaped = false;
  for (let i = brace; i < source.length; i++) {
    const ch = source[i];
    if (quote) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === quote) quote = '';
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') { quote = ch; continue; }
    if (ch === '{') depth++;
    if (ch === '}' && --depth === 0) return source.slice(start, i + 1);
  }
  throw new Error(`${name} 大括號未閉合`);
}

function parseCalls(source, callee) {
  const calls = [];
  const re = new RegExp(`${callee}\\(\\s*['\"]([^'\"]+)['\"](?:\\s*,\\s*\\{([\\s\\S]*?)\\})?\\s*\\)`, 'g');
  let match;
  while ((match = re.exec(source))) {
    calls.push({ fn: match[1], params: [...(match[2] || '').matchAll(/\b(p_\w+)\s*:/g)].map(item => item[1]) });
  }
  return calls;
}

const gitOk = args => spawnSync('git', args, { cwd: root }).status === 0;
const diffBase = gitOk(['rev-parse', '--verify', '--quiet', 'origin/main']) ? 'origin/main'
  : (gitOk(['rev-parse', '--verify', '--quiet', 'HEAD^2']) ? 'HEAD^1' : 'HEAD');
function unchangedFromBase(file) {
  return spawnSync('git', ['diff', '--quiet', diffBase, '--', file], { cwd: root }).status === 0;
}

(async () => {
  console.log('\n=== Plan B 第三批 C0＋C1 員工頁 LINE 驗證 ===');
  const handler = await import(pathToFileURL(path.join(root, 'supabase', 'functions', 'line-push', 'handler.ts')).href);
  const specs = handler.SELF_RPC_SPECS;
  const needsCompany = Object.keys(specs).filter(fn => specs[fn].signatures.some(item => Object.hasOwn(item.params, 'p_company_id'))).sort();
  const helperListMatch = helper.match(/SELF_RPC_COMPANY_FNS\s*=\s*new Set\(\[([\s\S]*?)\]\)/);
  const helperCompanyFns = [...(helperListMatch?.[1] || '').matchAll(/'([^']+)'/g)].map(item => item[1]).sort();
  check('C0 需要公司的函式清單與 SELF_RPC_SPECS 自動一致', JSON.stringify(helperCompanyFns) === JSON.stringify(needsCompany), helperCompanyFns.join(', '));

  const h = makeHelperHarness();
  for (const fn of Object.keys(specs)) {
    const requiresCompany = needsCompany.includes(fn);
    const original = { p_line_user_id: 'Uspoof', p_company_id: '20000000-0000-0000-0000-000000000001' };
    const result = await h.context.callSelfRpc(fn, original);
    const body = h.calls.at(-1).body;
    check(`${fn} 回傳 Supabase {data,error} 形狀`, result.error === null && result.data?.value === 1);
    check(`${fn} 不改原 args 且不傳前端 LINE ID`, original.p_line_user_id === 'Uspoof' && !Object.hasOwn(body.args, 'p_line_user_id'));
    check(`${fn} company 只依簽名帶入`, requiresCompany
      ? body.company_id === original.p_company_id && body.args.p_company_id === original.p_company_id
      : !Object.hasOwn(body, 'company_id') && !Object.hasOwn(body.args, 'p_company_id'));
  }
  await h.context.callSelfRpc('get_my_current_salary');
  await h.context.callSelfRpc('get_my_current_salary');
  check('每次 self_rpc 呼叫都重新取得 LIFF token', h.tokenReads() === Object.keys(specs).length + 2, String(h.tokenReads()));

  const fallbackCompany = makeHelperHarness();
  await fallbackCompany.context.callSelfRpc('register_employee', { p_data: { name: '測試' } });
  check('需要公司且 args 未帶時採 currentCompanyId', fallbackCompany.calls[0].body.company_id === fallbackCompany.context.currentCompanyId
    && !Object.hasOwn(fallbackCompany.calls[0].body.args, 'p_company_id'));

  const noToken = makeHelperHarness({ token: null });
  const missing1 = await noToken.context.callSelfRpc('get_my_current_salary');
  const missing2 = await noToken.context.callSelfRpc('get_monthly_attendance', { p_year: 2026, p_month: 11 });
  check('autoRelogin=false 缺 token 回 unauthenticated', missing1.error?.code === 'unauthenticated' && missing2.error?.code === 'unauthenticated');
  check('autoRelogin=false 不呼叫重登 action 或 reload', noToken.actions.length === 0 && noToken.reloads() === 0);
  check('同頁缺 token 提示只顯示一次', noToken.toasts.length === 1, String(noToken.toasts.length));

  const expired = makeHelperHarness({ edgeResult: { ok: false, code: 'unauthenticated', error: 'token expired' } });
  const expired1 = await expired.context.callSelfRpc('get_my_current_salary');
  const expired2 = await expired.context.callSelfRpc('get_my_current_salary');
  check('伺服器 unauthenticated 保留 message/code', expired1.error?.code === 'unauthenticated' && expired1.error?.message === 'token expired');
  check('伺服器 unauthenticated 不重登且只提示一次', expired.actions.length === 0 && expired.reloads() === 0 && expired.toasts.length === 1 && expired2.error?.code === 'unauthenticated');

  const interactive = makeHelperHarness({ token: null });
  const interactiveResult = await interactive.context.callSelfRpc('register_employee', { p_company_id: interactive.context.currentCompanyId }, { autoRelogin: true });
  check('autoRelogin=true 沿用 callVerifiedAction', interactive.actions.length === 1
    && interactive.actions[0].action === 'self_rpc' && interactive.calls.length === 0
    && interactiveResult.data?.via === 'action');

  const adminCompat = makeHelperHarness();
  let adminPayload;
  adminCompat.context.callVerifiedAction = async (action, payload) => {
    adminPayload = { action, payload };
    return { ok: true, data: { result: [{ id: 1 }] } };
  };
  const adminResult = await adminCompat.context.callVerifiedRpc('get_company_shift_types', { p_line_user_id: 'Uspoof' });
  check('既有 callVerifiedRpc 行為不變', adminPayload.action === 'admin_rpc'
    && adminPayload.payload.company_id === adminCompat.context.currentCompanyId
    && !Object.hasOwn(adminPayload.payload.args, 'p_line_user_id')
    && adminResult.data?.[0]?.id === 1 && adminResult.error === null);

  const c1Fns = ['get_my_payslip', 'get_monthly_attendance', 'get_my_current_salary', 'get_employee_schedule', 'insert_fw_trackpoints', 'count_fw_trackpoints'];
  const c1Source = pages.salary + pages.schedule + pages.fieldwork;
  const direct = c1Fns.filter(fn => new RegExp(`sb\\.rpc\\(\\s*['\"]${fn}['\"]`).test(c1Source));
  check('C1 六支函式直接 sb.rpc 為 0', direct.length === 0, direct.join(', '));
  const pageCalls = parseCalls(c1Source, 'callSelfRpc').filter(call => c1Fns.includes(call.fn));
  check('三個既有員工頁共有 6 個 self_rpc 呼叫點', pageCalls.length === 6, String(pageCalls.length));
  for (const call of pageCalls) {
    const allowed = new Set(specs[call.fn].signatures.flatMap(item => Object.keys(item.params)));
    const unknown = call.params.filter(name => !allowed.has(name));
    check(`${call.fn} 參數名都在 SELF_RPC_SPECS`, unknown.length === 0, unknown.join(', '));
  }

  for (const [name, source] of [['schedule', pages.schedule], ['fieldwork', pages.fieldwork]]) {
    const commonPos = source.indexOf('common.js?v=20261127-lunchsum');
    const helperPos = source.indexOf('modules/verified-rpc.js?v=20261128-planb163c1');
    check(`${name} 載入順序為 common.js → verified-rpc.js`, commonPos >= 0 && commonPos < helperPos);
  }
  check('salary.html 使用 C1 helper cache 版本', pages.salary.includes('modules/verified-rpc.js?v=20261128-planb163c1'));

  check('註冊頁不直接呼叫 register_employee 或傳 p_line_user_id', !/sb\.rpc\(\s*['"]register_employee['"]/.test(pages.register)
    && !/p_line_user_id\s*:/.test(pages.register));
  check('註冊頁不再以 sessionStorage LINE ID fallback', !/lineUserId\s*=\s*sessionStorage\.getItem/.test(pages.register));
  const registerContext = {
    liff: { getAccessToken: () => null }, fetch: async () => { throw new Error('缺 token 不應 fetch'); },
    SUPABASE_URL: 'https://db.test', SUPABASE_ANON_KEY: 'anon', console,
  };
  vm.createContext(registerContext);
  vm.runInContext(extractFunction(pages.register, 'callRegisterSelfRpc'), registerContext);
  const registerMissing = await registerContext.callRegisterSelfRpc('register_employee', { p_company_id: 'company' });
  check('註冊頁缺 token 顯示 QR Code 重開指引', registerMissing.error?.code === 'unauthenticated' && /LINE QR Code/.test(registerMissing.error?.message));

  const flushSource = extractFunction(pages.fieldwork, 'fwFlushTrackpoints');
  const trackContext = {
    console, Date,
    fwTrackBuffer: [{ lat: 25, lng: 121 }], fwTrip: { id: 'trip' }, fwTrackLastFlush: 0, fwTrackCount: 0,
    FW_TRACK_BATCH: 3, FW_TRACK_FLUSH_MS: 180000,
    updateTrackStatus() {},
    callSelfRpc: async () => ({ data: null, error: { code: 'unauthenticated', message: 'expired' } }),
  };
  vm.createContext(trackContext);
  vm.runInContext(flushSource, trackContext);
  await trackContext.fwFlushTrackpoints(true);
  check('fieldwork 背景寫入失敗保留 buffer 且不轉頁', trackContext.fwTrackBuffer.length === 1);
  trackContext.callSelfRpc = async () => ({ data: 1, error: null });
  await trackContext.fwFlushTrackpoints(true);
  check('fieldwork 下一輪成功後才清除 buffer', trackContext.fwTrackBuffer.length === 0 && trackContext.fwTrackCount === 1);
  check('fieldwork 呼叫未啟用 autoRelogin', !/callSelfRpc\(\s*['"]insert_fw_trackpoints['"][\s\S]{0,300}autoRelogin\s*:\s*true/.test(pages.fieldwork));

  const protectedFiles = [
    'checkin.html', 'kiosk.html', 'attendance_overview.html', 'attendance_public.html',
    'supabase', 'migrations',
  ];
  for (const file of protectedFiles) check(`受保護檔 ${file} 對 ${diffBase} 無差異`, unchangedFromBase(file));

  if (!mutation) {
    for (const kind of ['direct_rpc', 'relogin_read']) {
      const child = spawnSync(process.execPath, [__filename], {
        cwd: root, encoding: 'utf8', env: { ...process.env, PLANB3C1_MUTATION: kind },
      });
      check(`反向突變 ${kind} 會被測試攔截`, child.status !== 0, `exit=${child.status}`);
    }
  }

  console.log(`\n結果：${passed} 通過，${failed} 失敗`);
  process.exitCode = failed ? 1 : 0;
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
