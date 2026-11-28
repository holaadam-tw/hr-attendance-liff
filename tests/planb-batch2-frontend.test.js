#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { execFileSync } = require('child_process');

const root = path.join(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
let helper = read('modules/verified-rpc.js');
if (process.env.PLANB162_FRONTEND_LEAK_LINE === '1') helper = helper.replace('delete safeArgs.p_line_user_id;', '// mutation: leak line id');

const modules = ['schedules', 'leave', 'audit', 'payroll', 'settings'];
const sources = Object.fromEntries(modules.map(name => [name, read(`modules/${name}.js`)]));
const migration = read('migrations/162_planb_batch2_admin_verified.sql');
  const admin = read('admin.html');
  const index = read('modules/index.js');
  const salary = read('salary.html');

let pass = 0, fail = 0;
function check(name, ok, detail = '') {
  ok ? pass++ : fail++;
  console.log(`  ${ok ? '✅' : '❌'} ${name}${detail ? ` — ${detail}` : ''}`);
}

(async () => {
  console.log('\n=== Plan B 第二批前端 callVerifiedRpc ===');
  let captured;
  const context = vm.createContext({
    window: null,
    currentCompanyId: '10000000-0000-0000-0000-000000000001',
    callVerifiedAction: async (action, payload) => {
      captured = { action, payload };
      return { ok: true, data: { result: [{ id: 1 }] } };
    }
  });
  context.window = context;
  vm.runInContext(helper, context);

  const original = { p_company_id: context.currentCompanyId, p_line_user_id: 'Uspoof', p_status: 'pending' };
  let result = await context.callVerifiedRpc('get_leave_approval_requests_v2', original);
  check('成功回傳 Supabase {data,error} 形狀', Array.isArray(result.data) && result.data[0].id === 1 && result.error === null);
  check('只送 admin_rpc 固定 payload', captured.action === 'admin_rpc'
    && JSON.stringify(Object.keys(captured.payload).sort()) === JSON.stringify(['args', 'company_id', 'fn'].sort()));
  check('移除 p_line_user_id 且不改動呼叫端物件', !('p_line_user_id' in captured.payload.args)
    && original.p_line_user_id === 'Uspoof');
  check('company_id 優先取 args', captured.payload.company_id === original.p_company_id);

  context.callVerifiedAction = async () => ({ ok: false, code: 'relogin_redirect', message: '請重新登入' });
  result = await context.callVerifiedRpc('get_company_shift_types', {});
  check('relogin_redirect 不吞錯並維持 message/code', result.data === null
    && result.error?.code === 'relogin_redirect' && result.error?.message === '請重新登入');
  context.callVerifiedAction = async () => { throw Object.assign(new Error('network down'), { code: 'fetch_failed' }); };
  result = await context.callVerifiedRpc('get_company_shift_types', {});
  check('例外轉成 Supabase error 形狀', result.data === null
    && result.error?.code === 'fetch_failed' && result.error?.message === 'network down');

  const fnNames = [...migration.matchAll(/CREATE OR REPLACE FUNCTION public\.(\w+)_verified/g)].map(m => m[1]);
  const all = Object.values(sources).join('\n');
  check('migration 清單為 29 支', fnNames.length === 29);
  for (const fn of fnNames) {
    check(`五個 2a modules 無直接 sb.rpc('${fn}')`, !new RegExp(`sb\\.rpc\\(['"]${fn}['"]`).test(all));
  }
  check('五個 2a modules 均已改用 callVerifiedRpc', modules.every(name => /callVerifiedRpc\(/.test(sources[name])));

  const commonPos = admin.indexOf('common.js?v=20261128-planb163c2');
  const helperPos = admin.indexOf('modules/verified-rpc.js?v=20261128-planb163c2');
  const indexPos = admin.indexOf('modules/index.js?v=20261128-planb162');
  check('admin.html 載入順序為 common → verified-rpc → modules', commonPos >= 0 && commonPos < helperPos && helperPos < indexPos);
  check('五個 module cache key 同步為 planb162', modules.every(name => new RegExp(`${name}\\.js\\?v=20261128-planb162`).test(index)));
  check('salary.html 在 payroll 之前載入 C1 verified-rpc，payroll 維持 planb162',
    salary.indexOf('modules/verified-rpc.js?v=20261128-planb163c1') < salary.indexOf('modules/payroll.js?v=20261128-planb162'));

  const protectedFiles = ['checkin.html', 'kiosk.html'];
  for (const file of protectedFiles) {
    let unchanged = true;
    try { execFileSync('git', ['diff', '--quiet', 'HEAD', '--', file], { cwd: root }); } catch (_) { unchanged = false; }
    check(`受保護檔 ${file} 與 HEAD 無差異`, unchanged);
  }
  const diffNames = execFileSync('git', ['diff', '--name-only'], { cwd: root, encoding: 'utf8' });
  check('未修改 quick_check_in 所在既有 migration', !/quick_check_in/i.test(diffNames));

  console.log(`\n結果：${pass} 通過，${fail} 失敗`);
  process.exitCode = fail ? 1 : 0;
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
