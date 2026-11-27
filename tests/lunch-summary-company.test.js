// 便當頁統計只算本公司（common.js loadLunchSummary）
// 從 common.js 原樣抽出函式，用假的 sb 記錄查詢鏈，驗證有公司條件、沒公司不查。
// 反向對照：LUNCH_SUMMARY_FILE 指向改壞的副本。
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const file = process.env.LUNCH_SUMMARY_FILE || path.join(__dirname, '..', 'common.js');
const src = fs.readFileSync(file, 'utf8');
const start = src.indexOf('async function loadLunchSummary()');
if (start < 0) { console.error('❌ 找不到 loadLunchSummary'); process.exit(1); }
const next = src.indexOf('\n// =====', start);
const fnSrc = src.slice(start, next > 0 ? next : undefined);

let pass = 0, fail = 0;
function check(name, ok, detail) {
  if (ok) { pass++; console.log('  ✅ ' + name); }
  else { fail++; console.log('  ❌ ' + name + (detail ? '：' + detail : '')); }
}

async function run(companyId, rows) {
  const calls = [];
  const els = {};
  ['lunchDate', 'totalOrders', 'vegCount', 'regularCount'].forEach(id => { els[id] = { value: '', textContent: '' }; });
  const builder = {
    select(s) { calls.push(['select', s]); return builder; },
    eq(k, v) { calls.push(['eq', k, v]); return builder; },
    limit(n) { calls.push(['limit', n]); return Promise.resolve({ data: rows, error: null }); },
  };
  const ctx = {
    window: { currentCompanyId: companyId },
    sb: { from(t) { calls.push(['from', t]); return builder; } },
    document: { getElementById: id => els[id] || null },
    getTaiwanDate: () => '2026-11-27',
    console: { error() {}, log() {} },
  };
  vm.createContext(ctx);
  vm.runInContext(fnSrc + '\n;globalThis.__fn = loadLunchSummary;', ctx);
  await ctx.__fn();
  return { calls, els };
}

(async () => {
  console.log('\n━━━ 便當頁統計只算本公司 ━━━');
  const CO = '8a669e2c-7521-43e9-9300-5c004c57e9db';
  const rows = [
    { id: 1, is_vegetarian: false, status: 'ordered' },
    { id: 2, is_vegetarian: true, status: 'ordered' },
    { id: 3, is_vegetarian: false, status: 'cancelled' },
  ];
  const a = await run(CO, rows);
  const sel = a.calls.find(c => c[0] === 'select');
  check('查 lunch_orders', a.calls.some(c => c[0] === 'from' && c[1] === 'lunch_orders'));
  check('select 帶 employees!inner(company_id)', !!sel && /employees!inner\(\s*company_id\s*\)/.test(sel[1]), sel && sel[1]);
  check('有 employees.company_id = 本公司條件', a.calls.some(c => c[0] === 'eq' && c[1] === 'employees.company_id' && c[2] === CO));
  check('有日期條件', a.calls.some(c => c[0] === 'eq' && c[1] === 'order_date' && c[2] === '2026-11-27'));
  check('統計只算 ordered：總數 2', String(a.els.totalOrders.textContent) === '2', a.els.totalOrders.textContent);
  check('素 1／葷 1', String(a.els.vegCount.textContent) === '1' && String(a.els.regularCount.textContent) === '1');

  const b = await run(undefined, rows);
  check('沒有公司時不查詢', !b.calls.some(c => c[0] === 'from'), JSON.stringify(b.calls));

  console.log(`\n結果：${pass} 通過、${fail} 失敗`);
  process.exit(fail ? 1 : 0);
})();
