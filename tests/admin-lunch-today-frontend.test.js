// 管理員補訂當天便當：admin.html 靜態契約＋modules/leave.js jsdom 送出流程。
// 反向對照：ADMIN_LUNCH_FRONTEND_GIT_REF=origin/main node tests/admin-lunch-today-frontend.test.js
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { JSDOM } = require('jsdom');

const root = path.join(__dirname, '..');
const fromGit = process.env.ADMIN_LUNCH_FRONTEND_GIT_REF;
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
console.log('  管理員補訂當天便當前端（jsdom）');
console.log('═══════════════════════════════════════');

const dom = new JSDOM(page, { url: 'https://example.test/admin.html', runScripts: 'outside-only' });
const d = dom.window.document;
const openButton = d.querySelector('#adminLunchStats + button[onclick="openAdminLunchTodayModal()"]');
check('今日便當統計卡有補訂按鈕', !!openButton && /幫員工補訂（今天）/.test(openButton.textContent));
check('對話框欄位與三個大按鈕齊全', !!d.getElementById('adminLunchTodayModal')
  && !!d.getElementById('adminLunchTodayEmployee') && !!d.getElementById('adminLunchTodayError')
  && d.querySelectorAll('#adminLunchTodayModal [data-admin-lunch-choice]').length === 3);
const modalContent = d.querySelector('#adminLunchTodayModal .modal-content');
check('360×640 高度以視窗扣除邊界並由 modal 內捲動', /calc\(100vh - 24px\)/.test(modalContent?.getAttribute('style') || '')
  && /overflow-y:auto/.test(modalContent?.getAttribute('style') || ''));

const statsSource = grab(leave, 'loadAdminLunchStats');
const openSource = grab(leave, 'openAdminLunchTodayModal');
check('今日訂單查詢帶 employee_id、台灣今天與 employees.company_id 隔離', /employee_id/.test(statsSource)
  && /eq\('employees\.company_id', window\.currentCompanyId\)/.test(statsSource)
  && /eq\('order_date', todayStr\)/.test(statsSource));
check('員工清單限定公司與在職，並排除公務機', /from\('employees'\)[\s\S]*?eq\('company_id', window\.currentCompanyId\)[\s\S]*?eq\('is_active', true\)/.test(openSource)
  && /is_kiosk !== true/.test(openSource));
check('下拉狀態沿用 loadAdminLunchStats 的同一份訂單資料', /await loadAdminLunchStats\(\)/.test(openSource)
  && /adminLunchTodayStatusByEmployee\.get\(emp\.id\)/.test(openSource));
check('leave 模組 export 皆掛到 window', ['openAdminLunchTodayModal', 'closeAdminLunchTodayModal', 'submitAdminLunchToday']
  .every(name => index.includes(`window.${name} = ${name}`)));
check('admin 與 leave 模組快取版本均更新', /modules\/index\.js\?v=20261119-adminlunch154/.test(page)
  && /leave\.js\?v=20261119-adminlunch154/.test(index));

const submitSource = grab(leave, 'submitAdminLunchToday');
check('送出只使用 admin_lunch_today 的公司、員工與 choice', submitSource.includes("callVerifiedAction('admin_lunch_today'")
  && /company_id: companyId/.test(submitSource) && /employee_id: employeeId/.test(submitSource)
  && !/order_date|line_user_id/.test(submitSource));

const actions = [];
dom.window.currentCompanyId = '8a669e2c-7521-43e9-9300-5c004c57e9db';
dom.window.__capture = (action, payload) => actions.push({ action, payload });
dom.window.eval(`
  function setAdminLunchTodayError(message) { document.getElementById('adminLunchTodayError').textContent = message || ''; }
  function setAdminLunchTodayBusy() {}
  function closeAdminLunchTodayModal() { window.__closed = true; }
  function showToast(message) { window.__toast = message; }
  async function loadAdminLunchStats() { window.__statsReloaded = true; return true; }
  async function callVerifiedAction(action, payload) {
    window.__capture(action, payload);
    return { ok: true, code: 'ok', data: { result: { success: true } } };
  }
  ${submitSource}
`);

(async () => {
  const select = d.getElementById('adminLunchTodayEmployee');
  select.innerHTML = '<option value="">請選擇員工</option>';
  select.value = '';
  await dom.window.submitAdminLunchToday('regular');
  check('未選員工不送出', actions.length === 0 && /請先選擇員工/.test(d.getElementById('adminLunchTodayError').textContent));

  select.innerHTML = '<option value="20000000-0000-0000-0000-000000000004" data-employee-name="測試員工">測試員工（未選）</option>';
  select.value = '20000000-0000-0000-0000-000000000004';
  await dom.window.submitAdminLunchToday('vegetarian');
  const sent = actions[0];
  check('成功送出正確 payload', sent?.action === 'admin_lunch_today'
    && sent.payload.company_id === dom.window.currentCompanyId
    && sent.payload.employee_id.endsWith('0004') && sent.payload.choice === 'vegetarian'
    && Object.keys(sent.payload).sort().join() === 'choice,company_id,employee_id');
  check('成功後提示姓名與素食、關閉並重載統計', dom.window.__closed === true
    && dom.window.__toast === '已幫 測試員工 補訂：素食' && dom.window.__statsReloaded === true);

  await dom.window.submitAdminLunchToday('invalid');
  check('錯誤 choice 不送出', actions.length === 1 && /選項不正確/.test(d.getElementById('adminLunchTodayError').textContent));

  console.log(`\n結果：${pass} 通過、${fail} 失敗`);
  process.exit(fail ? 1 : 0);
})().catch(error => {
  console.error(error);
  process.exit(1);
});
