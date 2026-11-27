// 公務機當天便當（155）＋固定便當（156）：靜態契約、jsdom 流程、360×640 Chromium 量測。
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');
const puppeteer = require('puppeteer');

const root = path.join(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
const page = read('kiosk.html');
const i18n = read('i18n.js');
const admin = read('admin.html');
const employees = read('modules/employees.js');
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
console.log('  公務機固定便當前端（jsdom／Chromium）');
console.log('═══════════════════════════════════════');

const dom = new JSDOM(page, { url: 'https://example.test/kiosk.html', runScripts: 'outside-only' });
const d = dom.window.document;
const entry = d.getElementById('kioskLunchEntry');
const actions = d.getElementById('actionBtns');
check('🍱 入口移出請假／補卡列，緊接在上下班按鈕下方', !!entry && entry.previousElementSibling === actions
  && !entry.parentElement?.classList.contains('request-entry') && /openKioskLunch/.test(entry.getAttribute('onclick') || ''));
check('🍱 入口為整行大按鈕且預設隱藏', entry?.classList.contains('kiosk-lunch-entry')
  && /\.kiosk-lunch-entry\s*\{[^}]*display\s*:\s*none/.test(page));
check('請假／補卡列改為兩欄', /\.request-entry\s*\{[^}]*grid-template-columns\s*:\s*repeat\(2\s*,\s*1fr\)/.test(page));
check('功能開關載入後同步便當入口顯示', /kioskLunchEnabled\s*=\s*enabled;\s*syncKioskLunchEntry\(\)/.test(grab(page, 'loadKioskLunchSettings'))
  && /kioskLunchEnabled\s*\?\s*'block'\s*:\s*'none'/.test(grab(page, 'syncKioskLunchEntry')));
check('新字串中越雙語都有', [
  'kioskLunchEntry', 'kioskLunchChange', 'kioskLunchDefaultRegularApplied',
  'kioskLunchDefaultVegetarianApplied', 'kioskLunchDefaultNoneApplied'
].every(k => (i18n.match(new RegExp(`${k}:`, 'g')) || []).length === 2));
check('i18n 快取版本已更新', /i18n\.js\?v=20261127-defaultlunch/.test(page));
check('kiosk.html 不直接讀寫 lunch_orders', !/from\(['"]lunch_orders['"]\)/.test(page));
check('固定便當、狀態與重選都走 verified action', grab(page, 'showResult').includes("callVerifiedAction('kiosk_lunch_default'")
  && grab(page, 'shouldPromptKioskLunch').includes("callVerifiedAction('kiosk_lunch_status'")
  && grab(page, 'confirmKioskLunch').includes("callVerifiedAction('kiosk_lunch'"));

const popupSource = grab(page, 'showKioskLunchPopup');
check('result 模式沒有「稍後再決定」，employee 模式才有關閉鈕', !popupSource.includes("tk('decideLater')")
  && /mode\s*===\s*'employee'/.test(popupSource) && /tk\('close'\)/.test(popupSource));
check('選項與確認鈕符合放大規格', (popupSource.match(/min-height:64px/g) || []).length === 3
  && (popupSource.match(/font-size:18px/g) || []).length >= 4);
check('result 模式啟動 60 秒閒置計時', /setTimeout\([\s\S]*60000\)/.test(grab(page, 'startLunchPromptTimeout'))
  && /resetToInput\(\)/.test(grab(page, 'startLunchPromptTimeout')));

const flowDom = new JSDOM(page, { url: 'https://example.test/kiosk.html', runScripts: 'outside-only' });
const calls = [], popups = [], countdowns = [];
flowDom.window.__call = async (action, payload) => {
  calls.push({ action, payload });
  return flowDom.window.__replies.shift();
};
flowDom.window.__prompt = async () => flowDom.window.__shouldPrompt;
flowDom.window.eval(`
  let currentEmployee = { employee_id: '00000000-0000-0000-0000-0000000000e3', name: '員工三' };
  let resultLunchChoice = null;
  function stopCamera() {}
  function tk(k) { return k; }
  async function callVerifiedAction(action, payload) { return window.__call(action, payload); }
  async function shouldPromptKioskLunch(employee) { return window.__prompt(employee); }
  function showKioskLunchPopup(employee, choice, mode) { window.__popups.push({ employee, choice, mode }); }
  function startResultCountdown(sec, message) { window.__countdowns.push({ sec: sec || 3, message: message || '' }); }
  ${grab(page, 'showResult')}
`);
flowDom.window.__popups = popups;
flowDom.window.__countdowns = countdowns;
flowDom.window.__replies = [];

(async () => {
  flowDom.window.__replies.push({ ok: true, data: { result: { success: true, applied: true, choice: 'regular', order_date: '2026-11-27' } } });
  await flowDom.window.showResult({ success: true, type: 'check_in', name: '員工三' });
  check('applied：先呼叫 kiosk_lunch_default 且只送 employee_id', calls[0]?.action === 'kiosk_lunch_default'
    && Object.keys(calls[0].payload).join() === 'employee_id', JSON.stringify(calls[0]));
  check('applied：不彈窗、顯示改便當鈕並倒數 8 秒', popups.length === 0
    && flowDom.window.document.getElementById('resultLunchChange').style.display === 'block'
    && countdowns.at(-1)?.sec === 8 && countdowns.at(-1)?.message === 'kioskLunchDefaultRegularApplied', JSON.stringify(countdowns.at(-1)));

  flowDom.window.__replies.push({ ok: true, data: { result: { success: true, applied: false, reason: 'no_default' } } });
  flowDom.window.__shouldPrompt = true;
  await flowDom.window.showResult({ success: true, type: 'check_in', name: '員工三' });
  check('no_default：走既有 result 彈窗流程', popups.at(-1)?.mode === 'result' && popups.at(-1)?.choice === null);

  const popupCount = popups.length;
  flowDom.window.__replies.push({ ok: true, data: { result: { success: true, applied: false, reason: 'already_chosen', choice: 'none' } } });
  await flowDom.window.showResult({ success: true, type: 'check_in', name: '員工三' });
  check('already_chosen：不彈窗並直接走原倒數', popups.length === popupCount && countdowns.at(-1)?.sec === 3);

  flowDom.window.__replies.push({ ok: false, code: 'service_unavailable', message: '暫時無法使用' });
  flowDom.window.__shouldPrompt = true;
  await flowDom.window.showResult({ success: true, type: 'check_in', name: '員工三' });
  check('固定便當呼叫失敗不擋打卡結果，仍走既有彈窗', popups.at(-1)?.mode === 'result');

  const timeoutDom = new JSDOM('<!doctype html><body><div id="kioskLunchOverlay"></div></body>', { runScripts: 'outside-only' });
  timeoutDom.window.eval(`
    let lunchPromptTimer = null, lunchPromptEmployee = { employee_id: 'e' }, selectedLunch = 'regular';
    let lunchSkipWarned = true, lunchPromptMode = 'result';
    window.setTimeout = function(fn, ms) { window.__timer = { fn, ms }; return 1; };
    window.clearTimeout = function() {};
    function resetToInput() { window.__reset = true; }
    ${grab(page, 'startLunchPromptTimeout')}
  `);
  timeoutDom.window.startLunchPromptTimeout();
  timeoutDom.window.__timer.fn();
  check('60 秒無操作會關閉彈窗並回首頁且不送資料', timeoutDom.window.__timer.ms === 60000
    && !timeoutDom.window.document.getElementById('kioskLunchOverlay') && timeoutDom.window.__reset === true);

  check('後台 modal 有四種固定便當選項且公務機可隱藏', /id="editDefaultLunch"/.test(admin)
    && ['value=""', 'value="regular"', 'value="vegetarian"', 'value="none"'].every(v => admin.includes(v))
    && /editDefaultLunchGroup/.test(admin) && /this\.checked\?'none':''/.test(admin));
  check('openEdit 帶入 default_lunch，清單顯示固定葷／素／不訂標示', /defaultLunchEl\.value\s*=\s*data\.default_lunch\s*\|\|\s*''/.test(grab(employees, 'openEditEmployeeModal'))
    && /🍱固定\$\{label\}/.test(grab(employees, 'employeeDefaultLunchBadge')));

  const saveDom = new JSDOM(admin, { url: 'https://example.test/admin.html', runScripts: 'outside-only' });
  const sd = saveDom.window.document;
  const values = {
    editEmpId: '00000000-0000-0000-0000-0000000000e3', editEmpName: '員工三', editEmpDept: '生產部',
    editEmpPosition: '工程', editEmpPhone: '', editEmpHireDate: '2026-01-01', editEmpType: 'fulltime',
    editEmpPreferredLanguage: 'zh-TW', editEmpLineUserId: '', editDefaultLunch: 'vegetarian'
  };
  Object.entries(values).forEach(([id, value]) => { const el = sd.getElementById(id); if (el) el.value = value; });
  saveDom.window.__updates = null;
  saveDom.window.eval(`
    async function rpcUpdateEmployee(id, updates) { window.__updates = { id, updates }; return { error: null }; }
    function showToast() {}
    function closeEditEmployeeModal() {}
    function loadEmployeeList() {}
    ${grab(employees, 'saveEditEmployee')}
  `);
  await saveDom.window.saveEditEmployee();
  check('後台 saveEdit payload 透過 rpcUpdateEmployee 帶 default_lunch', saveDom.window.__updates?.updates.default_lunch === 'vegetarian'
    && saveDom.window.__updates.id.endsWith('e3'), JSON.stringify(saveDom.window.__updates));
  sd.getElementById('editDefaultLunch').value = '';
  await saveDom.window.saveEditEmployee();
  check('後台不固定送 null', saveDom.window.__updates?.updates.default_lunch === null, JSON.stringify(saveDom.window.__updates));

  let browser;
  try {
    const browserCandidates = [
      puppeteer.executablePath(),
      'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
      'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
      'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
      'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe'
    ];
    const executablePath = browserCandidates.find(candidate => candidate && fs.existsSync(candidate));
    if (!executablePath) throw new Error('找不到可供 360×640 量測的本機 Chromium／Edge');
    browser = await puppeteer.launch({
      headless: true,
      executablePath,
      args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'],
      timeout: 15000
    });
    const p = await browser.newPage();
    await p.setViewport({ width: 360, height: 640, deviceScaleFactor: 1 });
    const layoutHtml = page.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '');
    await p.setContent(layoutHtml, { waitUntil: 'domcontentloaded' });
    const layout = await p.evaluate(() => {
      document.getElementById('stepInput').classList.add('hidden');
      document.getElementById('stepEmployee').classList.remove('hidden');
      document.getElementById('empName').textContent = '員工三';
      document.getElementById('empInfo').textContent = 'E03 · 生產部';
      document.getElementById('photoBtn').disabled = true;
      document.getElementById('photoStatus').style.display = 'block';
      document.getElementById('actionBtns').style.display = 'flex';
      document.getElementById('kioskLunchEntry').style.display = 'block';
      document.getElementById('actionBtns').scrollIntoView({ block: 'center' });
      const ids = ['actionBtns', 'kioskLunchEntry'];
      const boxes = Object.fromEntries(ids.map(id => {
        const r = document.getElementById(id).getBoundingClientRect();
        return [id, { top: Math.round(r.top), bottom: Math.round(r.bottom), height: Math.round(r.height) }];
      }));
      return { width: innerWidth, height: innerHeight, scrollY: Math.round(scrollY), boxes };
    });
    const outputDir = path.join(root, 'output', 'playwright');
    fs.mkdirSync(outputDir, { recursive: true });
    const screenshot = path.join(outputDir, 'kiosk-default-lunch-360x640.png');
    await p.screenshot({ path: screenshot, fullPage: false });
    const visible = Object.values(layout.boxes).every(box => box.top >= 0 && box.bottom <= layout.height);
    check('360×640：上下班與 🍱 整行按鈕同時完整可視', layout.width === 360 && layout.height === 640 && visible, JSON.stringify(layout));
    check('360×640：量測截圖已寫入 output/playwright', fs.existsSync(screenshot), path.relative(root, screenshot));
  } finally {
    if (browser) await browser.close();
  }

  console.log(`\n結果：${pass} 通過、${fail} 失敗`);
  process.exit(fail ? 1 : 0);
})().catch(error => {
  console.error(error);
  process.exit(1);
});
