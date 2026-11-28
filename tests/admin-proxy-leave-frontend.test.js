// 管理員代員工請假：admin.html 靜態契約＋modules/leave.js jsdom 送出流程。
// 反向對照：ADMIN_PROXY_FRONTEND_GIT_REF=origin/main node tests/admin-proxy-leave-frontend.test.js
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { JSDOM } = require('jsdom');

const root = path.join(__dirname, '..');
const fromGit = process.env.ADMIN_PROXY_FRONTEND_GIT_REF;
const read = file => fromGit
  ? execFileSync('git', ['show', `${fromGit}:${file}`], { cwd: root, encoding: 'utf8' })
  : fs.readFileSync(path.join(root, file), 'utf8');
const page = read('admin.html');
const leave = read('modules/leave.js');
const index = read('modules/index.js');

let pass = 0, fail = 0;
function check(name, ok, detail = '') {
  if (ok) pass++; else fail++;
  console.log(`  ${ok ? '✅' : '❌'} ${name}${detail ? ` → ${detail}` : ''}`);
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
console.log('  管理員代員工請假前端（jsdom）');
console.log('═══════════════════════════════════════');

const dom = new JSDOM(page, { url: 'https://example.test/admin.html', runScripts: 'outside-only' });
const d = dom.window.document;
const button = d.querySelector('#aprLeave button[onclick="openAdminProxyLeaveModal()"]');
check('請假審核分頁有管理員限定的代請假按鈕', !!button && button.dataset.require === 'admin');
check('對話框欄位齊全', ['adminProxyLeaveModal', 'adminProxyLeaveEmployee', 'adminProxyLeaveType',
  'adminProxyLeavePeriod', 'adminProxyLeaveStart', 'adminProxyLeaveEnd', 'adminProxyLeaveStartTime',
  'adminProxyLeaveEndTime', 'adminProxyLeaveReason', 'adminProxyLeaveSubmit'].every(id => d.getElementById(id)));
const modalContent = d.querySelector('#adminProxyLeaveModal .modal-content');
check('手機高度以視窗扣除邊界並由 modal 內捲動', /calc\(100vh - 24px\)/.test(modalContent?.getAttribute('style') || '')
  && /overflow-y:auto/.test(modalContent?.getAttribute('style') || ''));
check('員工清單查詢限定公司與在職，並排除公務機', /from\('employees'\)[\s\S]*?eq\('company_id', window\.currentCompanyId\)[\s\S]*?eq\('is_active', true\)/.test(grab(leave, 'openAdminProxyLeaveModal'))
  && /is_kiosk !== true/.test(grab(leave, 'openAdminProxyLeaveModal')));
check('leave 模組 export 皆掛到 window', ['openAdminProxyLeaveModal', 'closeAdminProxyLeaveModal',
  'toggleAdminProxyLeaveTimes', 'submitAdminProxyLeave'].every(name => index.includes(`window.${name} = ${name}`)));
check('admin 入口與 leave 模組採 162 快取版本', /modules\/index\.js\?v=20261128-planb162/.test(page)
  && /leave\.js\?v=20261128-planb162/.test(index));

const submitSource = grab(leave, 'submitAdminProxyLeave');
check('送出使用 admin_proxy_leave 且不含核准控制欄位', submitSource.includes("callVerifiedAction('admin_proxy_leave'")
  && !/status\s*:|approver|approved_at/.test(submitSource));

const actions = [];
dom.window.currentCompanyId = '8a669e2c-7521-43e9-9300-5c004c57e9db';
dom.window.__capture = (action, payload) => actions.push({ action, payload });
dom.window.eval(`
  function setAdminProxyLeaveError(message) { document.getElementById('adminProxyLeaveError').textContent = message || ''; }
  function setAdminProxyLeaveBusy() {}
  function closeAdminProxyLeaveModal() { window.__closed = true; }
  function showToast(message) { window.__toast = message; }
  function loadLeaveApprovals(status) { window.__loaded = status; }
  async function callVerifiedAction(action, payload) {
    window.__capture(action, payload);
    return { ok: true, code: 'ok', data: { result: { success: true } } };
  }
  ${submitSource}
`);

(async () => {
  if (!submitSource || !d.getElementById('adminProxyLeaveEmployee')) {
    check('jsdom 可執行代請假送出流程', false, '缺少函式或表單');
  } else {
    d.getElementById('adminProxyLeaveEmployee').innerHTML = '<option value="20000000-0000-0000-0000-000000000004">員工</option>';
    d.getElementById('adminProxyLeaveEmployee').value = '20000000-0000-0000-0000-000000000004';
    d.getElementById('adminProxyLeaveType').value = 'annual';
    d.getElementById('adminProxyLeavePeriod').value = 'full_day';
    d.getElementById('adminProxyLeaveStart').value = '2026-11-23';
    d.getElementById('adminProxyLeaveEnd').value = '2026-11-23';
    d.getElementById('adminProxyLeaveReason').value = ' 家庭事務 ';
    await dom.window.submitAdminProxyLeave();

    const sent = actions[0];
    check('成功送出完整且正確的 verified action payload', sent?.action === 'admin_proxy_leave'
      && sent.payload.company_id === dom.window.currentCompanyId
      && sent.payload.employee_id.endsWith('0004') && sent.payload.leave_type === 'annual'
      && sent.payload.leave_period === 'full_day' && sent.payload.leave_start_time === null
      && sent.payload.leave_end_time === null && sent.payload.reason === '家庭事務');
    check('成功後關閉、提示並重載 pending 清單', dom.window.__closed === true
      && dom.window.__toast === '已代送，等待審核' && dom.window.__loaded === 'pending');

    d.getElementById('adminProxyLeavePeriod').value = 'hourly';
    d.getElementById('adminProxyLeaveStartTime').value = '11:00';
    d.getElementById('adminProxyLeaveEndTime').value = '10:00';
    await dom.window.submitAdminProxyLeave();
    check('驗證失敗不送出', actions.length === 1 && /完整填寫/.test(d.getElementById('adminProxyLeaveError').textContent));
  }

  console.log(`\n結果：${pass} 通過、${fail} 失敗`);
  process.exit(fail ? 1 : 0);
})().catch(error => {
  console.error(error);
  process.exit(1);
});
