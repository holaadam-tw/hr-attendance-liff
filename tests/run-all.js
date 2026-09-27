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
  { name: '上班待審仍可下班', file: 'pending-checkout.test.js' },
  { name: '補打卡日期與時間導引', file: 'makeup-punch-guidance.test.js' },
  { name: '時數假與缺時稽核', file: 'leave-time-attendance-audit.test.js' },
  { name: '同時請假警告門檻', file: 'concurrent-leave-advisory.test.js' },
  { name: '請假重疊防呆與天數觸發器', file: 'leave-overlap-guard.test.js' },
  { name: '公司假日與缺工分鐘', file: 'holidays-missing-minutes.test.js' },
  { name: '假日維護與核准身分驗證', file: 'holiday-admin-approve-auth.test.js' },
  { name: '月統計請假小數與喪假', file: 'leave-numeric-bereavement.test.js' },
  { name: '補登不算遲到早退', file: 'makeup-not-late.test.js' },
  { name: '早退判定與月統計次數來源', file: 'early-leave-any-time.test.js' },
  { name: '遲到早退以分為單位', file: 'late-minute-granularity.test.js' },
  { name: 'RLS 階段1 employees 寫入鎖定', file: 'rls-employees-write-lock.test.js' },
  { name: '員工 RPC 補強：公務機／管理員帳號保護（128，PGlite 實跑）', file: 'employee-rpc-guard.pglite.test.js' },
  { name: 'LINE 通知結果回饋', file: 'line-notification-delivery.test.js' },
  { name: 'LIFF 過期重登保留表單＋批次存設定（jsdom 實跑）', file: 'liff-relogin-draft.test.js' },
  { name: '缺時 LINE 通知安全開關', file: 'missing-work-hours-notification-control.test.js' },
  { name: 'LINE 推播減量（125，PGlite 實跑）', file: 'line-push-reduction.pglite.test.js' },
  { name: 'LINE Edge Functions（push／webhook）', file: 'line-edge-functions.test.js' },
  { name: 'LINE token 伺服器端化＋設定／平台管理員寫入收斂（126／127／129，PGlite 實跑）', file: 'line-token-server-side.pglite.test.js' },
  { name: 'companies 寫入鎖＋管理動作改由 LINE 驗證身分（130／131／132，PGlite 實跑）', file: 'phase0-verified-admin.pglite.test.js' },
  { name: '前端管理動作改走 LIFF 驗證（130／131／132）', file: 'phase0-frontend-verified-calls.test.js' },
  { name: 'attendance／schedules 只能經伺服器端函式寫入（133／134／135，PGlite 實跑）', file: 'attendance-schedules-write-lock.pglite.test.js' },
  { name: '前端不直接寫 attendance／schedules、換班審核走 LIFF 驗證（133／135）', file: 'attendance-schedules-frontend.test.js' },
  { name: '薪酬密碼伺服器端比對（136／137，PGlite 實跑）', file: 'payroll-password-server.pglite.test.js' },
  { name: '薪酬密碼前端改伺服器端比對（jsdom 實跑）', file: 'payroll-password-frontend.test.js' },
  { name: 'P1 Phase 1：caller_line_user_id／line_auth_resolve（138，PGlite 實跑）', file: 'line-auth-phase1.pglite.test.js' },
  { name: 'P1 Phase 1：line-auth Edge Function', file: 'line-auth-edge.test.js' },
  { name: 'P1 Phase 1：前端背景建立 LINE session（jsdom 實跑）', file: 'line-auth-frontend.test.js' },
  { name: 'P1 Phase 1：真 supabase-js 驗證 session 與資料 client 隔離', file: 'line-auth-supabase-js.test.js' },
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
