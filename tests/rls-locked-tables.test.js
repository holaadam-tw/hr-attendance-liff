// ============================================================
// RLS 已鎖定資料表的直接存取防回歸測試
//
// 執行：npm run test:rls（或 npm test 一併跑）
//
// 用途：
//   RLS 整治（docs/RLS_REMEDIATION_INVENTORY.md）每完成一張表，就把它加進
//   下面的 LOCKED 清單。該表在正式庫已經是「RLS on ＋ 沒有給 anon 的政策」，
//   前端若有任何一處退回 sb.from('<table>') 直接存取，那個畫面會**靜默失敗**
//   （讀取回空陣列、寫入被拒），而且通常要等使用者回報才會發現。
//
//   這支測試就是那道網子：掃描所有前端檔案，確認已鎖定的表 0 處直接存取，
//   且取代它的 RPC 呼叫都有帶 p_company_id 與 p_line_user_id
//   （多租戶隔離與身分驗證都移到函式內，前端漏帶就等於呼叫失敗）。
//
// 新增一張表時要做的事：
//   1. 在 LOCKED 加一筆 { table, rpcs: [...], migration: '...' }
//   2. 跑 npm run test:rls 確認通過
// ============================================================

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
// 只掃真正會被瀏覽器載入的前端檔案
const SKIP_DIRS = ['node_modules', 'tests', 'migrations', 'docs', 'openspec', 'supabase', 'scripts', 'archive', '.git', '.claude', '.agents', '.codex'];

const LOCKED = [
  {
    table: 'overtime_requests',
    migration: '109 + 110',
    rpcs: ['get_company_overtime_requests'],
    note: '讀取改 RPC；寫入本來就走 072/108 的 RPC',
  },
  {
    table: 'payroll',
    migration: '111 + 112',
    rpcs: ['save_payroll_records'],
    note: '儲存草稿與發布改 RPC；讀取本來就走 get_company_payroll',
  },
  {
    table: 'salary_settings',
    migration: '111 + 112',
    rpcs: ['upsert_salary_setting'],
    note: '兩處寫入改 RPC，舊版失效與新版寫入同一交易',
  },
  {
    table: 'payroll_records',
    migration: '112',
    rpcs: [],
    note: '前端從未使用（僅健康檢查腳本），政策直接收掉',
  },
];

const files = [];
(function walk(d) {
  for (const f of fs.readdirSync(d, { withFileTypes: true })) {
    if (f.name.startsWith('.')) continue;
    const p = path.join(d, f.name);
    if (f.isDirectory()) { if (SKIP_DIRS.includes(f.name)) continue; walk(p); }
    else if (/\.(html|js)$/.test(f.name)) files.push(p);
  }
})(ROOT);

const sources = files.map(f => ({ rel: path.relative(ROOT, f).replace(/\\/g, '/'), text: fs.readFileSync(f, 'utf8') }));

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  ✅ ' + name + (extra ? '  → ' + extra : '')); }
  else { fail++; console.log('  ❌ ' + name + (extra ? '  → ' + extra : '')); }
}

console.log('\n═══════════════════════════════════════');
console.log('  RLS 已鎖定資料表的直接存取檢查');
console.log('═══════════════════════════════════════');
console.log('  掃描 ' + sources.length + ' 個前端檔案，' + LOCKED.length + ' 張已鎖定的表\n');

LOCKED.forEach(({ table, migration, rpcs, note }) => {
  console.log('--- ' + table + '（migration ' + migration + '）' + note + ' ---');

  // 1. 不得有任何直接存取
  const offenders = sources
    .filter(s => new RegExp("sb\\s*\\.\\s*from\\(\\s*['\"`]" + table + "['\"`]\\s*\\)").test(s.text))
    .map(s => s.rel);
  check(table + ' 前端 0 處直接存取', offenders.length === 0,
    offenders.length ? '違規：' + offenders.join(', ') : undefined);

  // 2. 取代它的 RPC 必須存在於前端，且每個呼叫都要帶身分與公司
  rpcs.forEach(rpc => {
    const users = sources.filter(s => s.text.includes(rpc));
    check(rpc + ' 有被前端呼叫', users.length > 0, users.map(u => u.rel).join(', '));

    const missingCompany = [];
    const missingCaller = [];
    users.forEach(s => {
      let i = -1;
      while ((i = s.text.indexOf(rpc, i + 1)) !== -1) {
        // 只檢查真正的呼叫點（rpc('name' 形式），略過註解裡提到的名字
        const before = s.text.slice(Math.max(0, i - 40), i);
        if (!/rpc\(\s*['"`]$/.test(before)) continue;
        const win = s.text.slice(i, i + 600);
        if (!win.includes('p_company_id')) missingCompany.push(s.rel);
        if (!win.includes('p_line_user_id')) missingCaller.push(s.rel);
      }
    });
    check(rpc + ' 每個呼叫都帶 p_company_id（多租戶）', missingCompany.length === 0,
      missingCompany.length ? '缺漏：' + [...new Set(missingCompany)].join(', ') : undefined);
    check(rpc + ' 每個呼叫都帶 p_line_user_id（身分驗證）', missingCaller.length === 0,
      missingCaller.length ? '缺漏：' + [...new Set(missingCaller)].join(', ') : undefined);
  });
  console.log('');
});

// 3. 反向健全性檢查：測試本身要有偵測能力，否則清單寫錯也不會有人發現
console.log('--- 測試自身健全性 ---');
const probe = "sb.from('overtime_requests')";
check('偵測邏輯確實抓得到 sb.from(...)（用探針字串驗證）',
  new RegExp("sb\\s*\\.\\s*from\\(\\s*['\"`]overtime_requests['\"`]\\s*\\)").test(probe));
check('掃描範圍涵蓋 modules/ 與根目錄頁面',
  sources.some(s => s.rel.startsWith('modules/')) && sources.some(s => !s.rel.includes('/')));

console.log('\n═══════════════════════════════════════');
console.log('  結果：✅ ' + pass + ' 通過  ❌ ' + fail + ' 失敗');
console.log('═══════════════════════════════════════\n');
process.exit(fail > 0 ? 1 : 0);
