#!/usr/bin/env node
// ============================================================
// 測試總入口（npm test）
//
// 依序跑完所有套件，任何一支失敗整體就是失敗。
// 個別套件仍可單獨執行，見 package.json 的 test:* scripts。
//
// 為什麼要有這支：
//   原本 npm test 只跑 smoke-test.js，attendance_overview.html（1300+ 行）
//   與 modules/payroll.js 的加班邏輯完全沒有自動測試——改壞了不會有人知道。
//   新增套件請一併加進下面的 SUITES，否則等於沒接上。
// ============================================================

const { spawnSync } = require('child_process');
const path = require('path');

const SUITES = [
  { name: '冒煙測試', file: 'smoke-test.js', env: { SKIP_EXTERNAL_SMOKE: '1' } },
  { name: '打卡相機／照片重試', file: 'checkin-photo-retry.test.js' },
  { name: '打卡環境自我檢查', file: 'checkin-health-check.test.js' },
  { name: '打卡總覽', file: 'attendance-overview.test.js' },
  { name: '薪資頁加班來源', file: 'payroll-overtime.test.js' },
  { name: 'RLS 已鎖定資料表', file: 'rls-locked-tables.test.js' },
  { name: '批次薪資設定', file: 'salary-batch.test.js' },
];

const results = [];
for (const s of SUITES) {
  const r = spawnSync(process.execPath, [path.join(__dirname, s.file)], {
    stdio: 'inherit',
    env: { ...process.env, ...(s.env || {}) }
  });
  results.push({ name: s.name, code: r.status === null ? 1 : r.status });
}

console.log('\n╔═══════════════════════════════════════╗');
console.log('║  總結                                 ║');
console.log('╚═══════════════════════════════════════╝');
results.forEach(r => console.log(`  ${r.code === 0 ? '✅' : '❌'} ${r.name}`));

const failedSuites = results.filter(r => r.code !== 0);
if (failedSuites.length > 0) {
  console.log(`\n  ❌ ${failedSuites.length} 個套件失敗\n`);
  process.exit(1);
}
console.log(`\n  ✅ ${results.length} 個套件全數通過\n`);
