// ============================================================
// P1 Phase 2 防呆：141 之後的 migration 不可以直接改 wrapper
//
// 141 把 54 支 RPC 改成 wrapper（先 assert_caller 再呼叫 <name>_impl）。之後若有 migration 對 public.<name>(…)
// 做 CREATE OR REPLACE／DROP／ALTER，wrapper 會被蓋掉或刪掉，身分檢查就消失了 → 要改邏輯請改 public.<name>_impl。
// 本測試掃描所有編號 > 141 的 migration（含回滾檔），出現 `FUNCTION public.<wrapped_name>(` 就失敗。
// 另外確認掃描器本身有效（對一段示範文字要抓得到、對 _impl 不誤報）。
// ============================================================
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const wrapped = JSON.parse(fs.readFileSync(path.join(root, 'scripts', 'line-auth', 'wrapped_rpcs.json'), 'utf8'));
const names = wrapped.rpc_names;

let pass = 0, fail = 0;
function check(name, condition, detail = '') {
  if (condition) { pass++; console.log(`  ✅ ${name}${detail ? `  → ${detail}` : ''}`); }
  else { fail++; console.log(`  ❌ ${name}${detail ? `  → ${detail}` : ''}`); }
}

// 允許 public."name"、大小寫、空白；不會誤中 <name>_impl
const pattern = new RegExp(`FUNCTION\\s+(?:public\\.)?"?(${names.join('|')})"?\\s*\\(`, 'gi');
const scan = (text) => {
  const hits = [];
  const src = text.replace(/--[^\n]*/g, '');
  let m;
  pattern.lastIndex = 0;
  while ((m = pattern.exec(src))) hits.push(m[1]);
  return hits;
};

console.log('\n═══════════════════════════════════════');
console.log('  P1 Phase 2 防呆：141 之後的 migration 不直接改 wrapper');
console.log('═══════════════════════════════════════');

check('掃描器：抓得到 CREATE OR REPLACE FUNCTION public.quick_check_in(', scan('CREATE OR REPLACE FUNCTION public.quick_check_in(p text)').join() === 'quick_check_in');
check('掃描器：抓得到 DROP FUNCTION "get_my_payslip" (', scan('drop function public."get_my_payslip" (text)').join() === 'get_my_payslip');
check('掃描器：不誤報 public.quick_check_in_impl(', scan('CREATE OR REPLACE FUNCTION public.quick_check_in_impl(p text)').length === 0);
check('掃描器：不看註解', scan('-- CREATE OR REPLACE FUNCTION public.quick_check_in(').length === 0);

const later = fs.readdirSync(path.join(root, 'migrations'))
  .filter(f => /^\d+_.*\.sql$/.test(f) && Number(f.match(/^(\d+)_/)[1]) > 141).sort();
const offenders = [];
for (const f of later) {
  const hits = scan(fs.readFileSync(path.join(root, 'migrations', f), 'utf8'));
  if (hits.length) offenders.push(`${f}: ${[...new Set(hits)].join(', ')}`);
}
check(`編號 > 141 的 migration（${later.length} 個）都沒有直接改 wrapper（請改 <name>_impl）`, offenders.length === 0, offenders.join('; '));

console.log(`\n結果：${pass} 通過、${fail} 失敗`);
process.exit(fail ? 1 : 0);
