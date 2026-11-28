#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const root = path.join(__dirname, '..');
const migration = fs.readFileSync(path.join(root, 'migrations', '163_planb_batch3_self_verified.sql'), 'utf8');
const rollback = fs.readFileSync(path.join(root, 'migrations', '163_planb_batch3_self_verified_rollback.sql'), 'utf8');
const handler = fs.readFileSync(path.join(root, 'supabase', 'functions', 'line-push', 'handler.ts'), 'utf8');

let pass = 0;
let fail = 0;
function check(name, ok, detail = '') {
  ok ? pass++ : fail++;
  console.log(`  ${ok ? '✅' : '❌'} ${name}${detail ? ` — ${detail}` : ''}`);
}

function git(args) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
}

function protectedBaseline() {
  try {
    return git(['rev-parse', '--verify', 'origin/main']);
  } catch (_) {
    const parents = git(['rev-list', '--parents', '-n', '1', 'HEAD']).split(/\s+/);
    return parents.length > 2 ? parents[1] : git(['rev-parse', 'HEAD']);
  }
}

console.log('\n=== Plan B 第三批受保護範圍 ===');
const baseline = protectedBaseline();
let changed = git(['diff', '--name-only', baseline, '--', '*.html', 'common.js', 'i18n.js', 'modules/*'])
  .split(/\r?\n/).filter(Boolean);
const untracked = git(['ls-files', '--others', '--exclude-standard', '--', '*.html', 'common.js', 'i18n.js', 'modules/*'])
  .split(/\r?\n/).filter(Boolean);
changed = [...new Set([...changed, ...untracked])];
if (process.env.PLANB163_PROTECTED_DIFF === '1') changed.push('common.js');

const allowed = new Set([
  'employee_register.html', 'fieldwork.html', 'schedule.html', 'salary.html', 'modules/verified-rpc.js',
  'common.js', 'records.html', 'index.html', 'services.html', 'admin.html', 'i18n.js',
]);
const protectedChanges = changed.filter(file => !allowed.has(file.replace(/\\/g, '/')));
check('C0～C2 只修改工作單允許的 HTML／module', protectedChanges.length === 0,
  protectedChanges.length ? protectedChanges.join(', ') : `baseline=${baseline.slice(0, 8)}`);
check('migration 與 rollback 不含交易控制語句',
  !/^\s*(BEGIN|COMMIT)\s*;/im.test(migration) && !/^\s*(BEGIN|COMMIT)\s*;/im.test(rollback));

const deferred = ['log_checkin_failure', 'quick_check_in', 'quick_check_out_after_clock_in_makeup', 'get_my_makeup_requests', 'submit_makeup_punch'];
check('163 未建立任何第四批 wrapper', deferred.every(name => !migration.includes(`public.${name}_verified`)));
const selfSpecSection = handler.slice(handler.indexOf('export const SELF_RPC_SPECS'), handler.indexOf('export function recipientKind'));
check('self_rpc 白名單未納入第四批函式', deferred.every(name => !new RegExp(`\\b${name}\\s*:`).test(selfSpecSection)));
check('既有 admin_rpc 白名單仍維持 29 支',
  (handler.slice(handler.indexOf('export const ADMIN_RPC_SPECS'), handler.indexOf('const signature')).match(/^\s{2}\w+: \{ params:/gm) || []).length === 29);

console.log(`\n結果：${pass} 通過，${fail} 失敗`);
process.exitCode = fail ? 1 : 0;
