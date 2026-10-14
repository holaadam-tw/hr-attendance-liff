// 公務機請假／補卡：真實 kiosk.html 靜態契約＋jsdom 執行送出流程。
// 反向對照：KIOSK_FRONTEND_GIT_REF=origin/main node tests/kiosk-leave-makeup-frontend.test.js
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { JSDOM } = require('jsdom');

const root = path.join(__dirname, '..');
const fromGit = process.env.KIOSK_FRONTEND_GIT_REF;
const read = file => fromGit
  ? execFileSync('git', ['show', `${fromGit}:${file}`], { cwd: root, encoding: 'utf8' })
  : fs.readFileSync(path.join(root, file), 'utf8');
const page = read('kiosk.html');
const i18n = read('i18n.js');
let pass = 0, fail = 0;
function check(name, ok, detail = '') {
  if (ok) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; console.log(`  ❌ ${name}${detail ? ` → ${detail}` : ''}`); }
}
function grab(source, name) {
  const start = source.search(new RegExp('(async\\s+)?function ' + name + '\\('));
  if (start < 0) return '';
  let depth = 0, opened = false;
  for (let i = start; i < source.length; i++) {
    if (source[i] === '{') { depth++; opened = true; }
    if (source[i] === '}' && opened && --depth === 0) return source.slice(start, i + 1);
  }
  return '';
}

console.log('\n═══════════════════════════════════════');
console.log('  公務機請假／補卡前端（jsdom）');
console.log('═══════════════════════════════════════');
const dom = new JSDOM(page, { url: 'https://example.test/kiosk.html', runScripts: 'outside-only' });
const d = dom.window.document;

check('Step 2 有請假與補卡入口', !!d.querySelector('#kioskLeaveEntry[onclick*="openKioskRequest"]') && !!d.querySelector('#kioskMakeupEntry[onclick*="openKioskRequest"]'));
check('兩張精簡表單欄位齊全', ['kioskLeaveType', 'kioskLeaveStart', 'kioskLeaveEnd', 'kioskLeavePeriod', 'kioskLeaveReason', 'kioskMakeupDate', 'kioskMakeupType', 'kioskMakeupTime', 'kioskMakeupReason'].every(id => d.getElementById(id)));
check('中越雙語鍵存在', ['kioskRequestHint', 'kioskBackEmployee', 'kioskRequestSubmitted', 'kioskCompleteForm', 'kioskMakeupWindowHint'].every(k => (i18n.match(new RegExp(`${k}:`, 'g')) || []).length === 2));
check('i18n 快取版本已更新', /i18n\.js\?v=20261014-kioskrequests/.test(page));
check('送出函式走正確 action', grab(page, 'submitKioskLeave').includes("callVerifiedAction('kiosk_leave'") && grab(page, 'submitKioskMakeup').includes("callVerifiedAction('kiosk_makeup'"));
check('送出 payload 不含核准控制欄位', !/status\s*:|approver|approved_at/.test(grab(page, 'submitKioskLeave') + grab(page, 'submitKioskMakeup')));
check('申請流程不拍照、不上傳', !/photo|storage|upload/i.test(grab(page, 'submitKioskLeave') + grab(page, 'submitKioskMakeup')));
check('新表單受閒置回首頁保護', /else resetToInput\(\)/.test(grab(page, 'resetIdleTimer')) && /resetIdleTimer\(\)/.test(grab(page, 'openKioskRequest')));

const actions = [];
dom.window.eval(`
  let currentEmployee = { employee_id: '00000000-0000-0000-0000-0000000000e3', name: '員工三' };
  function tk(k) { return k; }
  function getKioskTaiwanDate(offset = 0) { return offset === -6 ? '2026-10-08' : '2026-10-14'; }
  function kioskFormError(kind, msg) { document.getElementById(kind === 'leave' ? 'kioskLeaveError' : 'kioskMakeupError').textContent = msg; }
  function setKioskFormBusy() {}
  function showKioskRequestResult() { window.__shown = (window.__shown || 0) + 1; }
  async function callVerifiedAction(action, payload) { window.__capture(action, payload); return { ok: true, data: { result: { success: true } } }; }
  ${grab(page, 'submitKioskLeave')}
  ${grab(page, 'submitKioskMakeup')}
`);
dom.window.__capture = (action, payload) => actions.push({ action, payload });

(async () => {
  if (!d.getElementById('kioskLeaveType') || !d.getElementById('kioskMakeupDate') || !grab(page, 'submitKioskLeave') || !grab(page, 'submitKioskMakeup')) {
    check('jsdom：可執行兩種送出流程', false, '缺少 B 包表單或函式');
    console.log(`\n結果：${pass} 通過、${fail} 失敗`);
    process.exit(1);
  }
  d.getElementById('kioskLeaveType').value = 'annual';
  d.getElementById('kioskLeaveStart').value = '2026-10-20'; d.getElementById('kioskLeaveEnd').value = '2026-10-20';
  d.getElementById('kioskLeavePeriod').value = 'full_day'; d.getElementById('kioskLeaveReason').value = '家庭事務';
  await dom.window.submitKioskLeave();
  d.getElementById('kioskMakeupDate').value = '2026-10-14'; d.getElementById('kioskMakeupType').value = 'clock_out';
  d.getElementById('kioskMakeupTime').value = '17:05'; d.getElementById('kioskMakeupReason').value = '忘記打卡';
  await dom.window.submitKioskMakeup();
  check('jsdom：請假送 kiosk_leave 與目標員工', actions[0]?.action === 'kiosk_leave' && actions[0].payload.employee_id.endsWith('e3') && actions[0].payload.leave_type === 'annual');
  check('jsdom：補卡送 kiosk_makeup 與正確類型', actions[1]?.action === 'kiosk_makeup' && actions[1].payload.punch_type === 'clock_out' && actions[1].payload.punch_time === '17:05');
  check('jsdom：兩種 payload 都沒有 status／approver', actions.every(x => !Object.keys(x.payload).some(k => /status|approver|approved_at/.test(k))));
  check('jsdom：兩筆成功都進入等待審核結果畫面', dom.window.__shown === 2);

  const resultDom = new JSDOM(page, { runScripts: 'outside-only' });
  resultDom.window.setInterval = cb => { cb(); cb(); cb(); return 1; };
  resultDom.window.clearInterval = () => {};
  resultDom.window.eval(`
    let currentEmployee = { name: '員工三' }, resultTimer = null;
    function stopCamera() {} function tk() { return '已送出，等待主管審核'; }
    function resetToInput() { window.__returned = true; }
    ${grab(page, 'startResultCountdown')}
    ${grab(page, 'showKioskRequestResult')}
  `);
  resultDom.window.showKioskRequestResult();
  check('jsdom：成功顯示等待主管審核並自動回輸入畫面', resultDom.window.document.getElementById('resultMsg').textContent === '已送出，等待主管審核' && resultDom.window.__returned === true);

  console.log(`\n結果：${pass} 通過、${fail} 失敗`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
