// 公務機當天便當：真實 kiosk.html 靜態契約＋jsdom 流程＋360x640 Chromium 量測。
// 反向對照：KIOSK_LUNCH_FRONTEND_GIT_REF=origin/main node tests/kiosk-lunch-today-frontend.test.js
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { JSDOM } = require('jsdom');
const puppeteer = require('puppeteer');

const root = path.join(__dirname, '..');
const fromGit = process.env.KIOSK_LUNCH_FRONTEND_GIT_REF;
const read = file => fromGit
  ? execFileSync('git', ['show', `${fromGit}:${file}`], { cwd: root, encoding: 'utf8' })
  : fs.readFileSync(path.join(root, file), 'utf8');
const page = read('kiosk.html');
const i18n = read('i18n.js');
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
console.log('  公務機當天便當前端（jsdom／Chromium）');
console.log('═══════════════════════════════════════');

const dom = new JSDOM(page, { url: 'https://example.test/kiosk.html', runScripts: 'outside-only' });
const d = dom.window.document;
const entry = d.getElementById('kioskLunchEntry');
check('請假／補卡同排有 🍱 便當入口且預設隱藏', !!entry && /openKioskLunch/.test(entry.getAttribute('onclick') || '')
  && entry.style.display === 'none' && entry.parentElement?.classList.contains('request-entry'));
check('動作列固定三欄，沒有把便當按鈕另起一排', /grid-template-columns\s*:\s*repeat\(3\s*,\s*1fr\)/.test(page));
check('功能開關載入後同步便當入口顯示', /kioskLunchEnabled\s*=\s*enabled;\s*syncKioskLunchEntry\(\)/.test(grab(page, 'loadKioskLunchSettings'))
  && /kioskLunchEnabled\s*\?\s*''\s*:\s*'none'/.test(grab(page, 'syncKioskLunchEntry')));
check('前端便當截止預設已對齊 10:00', /let kioskLunchDeadline\s*=\s*'10:00'/.test(page)
  && /kioskLunchDeadline\s*\|\|\s*'10:00'/.test(grab(page, 'shouldPromptKioskLunch')));
check('新字串中越雙語都有', ['kioskLunchEntry', 'kioskLunchCurrentChoice', 'kioskLunchNotChosen', 'kioskLunchDeadlinePassed']
  .every(k => (i18n.match(new RegExp(`${k}:`, 'g')) || []).length === 2));
check('i18n 快取版本已更新', /i18n\.js\?v=20261119-kiosklunch/.test(page));
check('kiosk.html 已移除 lunch_orders 直接 upsert', !/from\(['"]lunch_orders['"]\)\s*\.upsert/.test(page));
check('打卡後與手動確認都走 verified action', grab(page, 'confirmKioskLunch').includes("callVerifiedAction('kiosk_lunch'")
  && grab(page, 'openKioskLunch').includes("callVerifiedAction('kiosk_lunch_status'"));
check('打卡後自動彈窗仍保留，並明確使用 result 模式', /showKioskLunchPopup\(employeeForLunch,\s*null,\s*'result'\)/.test(grab(page, 'showResult')));
check('彈窗標示目前選擇', /kioskLunchCurrentChoice/.test(grab(page, 'showKioskLunchPopup'))
  && /if \(currentChoice\) selectKioskLunch\(currentChoice\)/.test(grab(page, 'showKioskLunchPopup')));

const flowDom = new JSDOM(page, { url: 'https://example.test/kiosk.html', runScripts: 'outside-only' });
const calls = [], popups = [], alerts = [];
flowDom.window.__call = async (action, payload) => {
  calls.push({ action, payload });
  return flowDom.window.__reply;
};
flowDom.window.alert = msg => alerts.push(msg);
flowDom.window.eval(`
  let kioskLunchEnabled = true;
  let currentEmployee = { employee_id: '00000000-0000-0000-0000-0000000000e3', name: '員工三' };
  function tk(k) { return k; }
  async function callVerifiedAction(action, payload) { return window.__call(action, payload); }
  function showKioskLunchPopup(employee, choice, mode) { window.__popups.push({ employee, choice, mode }); }
  function resetIdleTimer() { window.__idleReset = (window.__idleReset || 0) + 1; }
  ${grab(page, 'openKioskLunch')}
`);
flowDom.window.__popups = popups;

(async () => {
  flowDom.window.__reply = { ok: true, data: { result: { success: true, choice: 'vegetarian', deadline: '10:00', deadline_passed: false } } };
  await flowDom.window.openKioskLunch();
  check('按鈕先查 status，只送 employee_id 且不送公司／日期', calls[0]?.action === 'kiosk_lunch_status'
    && Object.keys(calls[0].payload).join() === 'employee_id' && calls[0].payload.employee_id.endsWith('e3'), JSON.stringify(calls[0]));
  check('截止前開彈窗並帶入目前素食選擇', popups[0]?.choice === 'vegetarian' && popups[0]?.mode === 'employee');

  flowDom.window.__reply = { ok: true, data: { result: { success: true, choice: 'regular', deadline: '10:00', deadline_passed: true } } };
  await flowDom.window.openKioskLunch();
  check('截止後只顯示指定訊息、不開送單彈窗', alerts.at(-1) === 'kioskLunchDeadlinePassed'
    && popups.length === 1 && !calls.some(x => x.action === 'kiosk_lunch'));

  const confirmDom = new JSDOM(page, { url: 'https://example.test/kiosk.html', runScripts: 'outside-only' });
  const confirmCalls = [], confirmAlerts = [];
  confirmDom.window.alert = msg => confirmAlerts.push(msg);
  confirmDom.window.__call = async (action, payload) => {
    confirmCalls.push({ action, payload });
    return confirmDom.window.__reply;
  };
  confirmDom.window.eval(`
    let selectedLunch = 'none';
    let lunchPromptEmployee = { employee_id: '00000000-0000-0000-0000-0000000000e3' };
    let lunchSkipWarned = false;
    let lunchPromptMode = 'employee';
    function tk(k) { return k; }
    async function callVerifiedAction(action, payload) { return window.__call(action, payload); }
    function resetIdleTimer() { window.__idleReset = true; }
    function startResultCountdown() { window.__countdown = true; }
    window.__setLunchState = function(choice, employee, mode) {
      selectedLunch = choice; lunchPromptEmployee = employee; lunchPromptMode = mode;
    };
    ${grab(page, 'confirmKioskLunch')}
  `);
  const addOverlay = () => {
    const overlay = confirmDom.window.document.createElement('div'); overlay.id = 'kioskLunchOverlay';
    const button = confirmDom.window.document.createElement('button'); button.id = 'kioskLunchConfirmBtn';
    overlay.appendChild(button); confirmDom.window.document.body.appendChild(overlay);
  };
  addOverlay();
  confirmDom.window.__reply = { ok: true, data: { result: { success: true, status: 'cancelled', is_vegetarian: false } } };
  await confirmDom.window.confirmKioskLunch();
  check('確認送出 kiosk_lunch，只含 employee_id／choice', confirmCalls[0]?.action === 'kiosk_lunch'
    && confirmCalls[0].payload.choice === 'none'
    && Object.keys(confirmCalls[0].payload).sort().join() === 'choice,employee_id', JSON.stringify(confirmCalls[0]));
  check('手動重選成功後留在員工畫面並顯示結果', confirmAlerts.at(-1) === 'lunchRecordedNone'
    && confirmDom.window.__idleReset === true && !confirmDom.window.__countdown);

  confirmDom.window.__setLunchState('regular', { employee_id: '00000000-0000-0000-0000-0000000000e3' }, 'employee');
  addOverlay();
  confirmDom.window.__reply = { ok: false, code: 'deadline_passed', message: '今日便當已截止，請找管理員補訂' };
  await confirmDom.window.confirmKioskLunch();
  check('送出瞬間若伺服器判定截止，顯示指定訊息且不視為成功', confirmAlerts.at(-1) === 'kioskLunchDeadlinePassed'
    && confirmDom.window.document.getElementById('kioskLunchOverlay') === null);

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
      document.getElementById('kioskLunchEntry').style.display = '';
      document.getElementById('actionBtns').scrollIntoView({ block: 'center' });
      const r = document.getElementById('actionBtns').getBoundingClientRect();
      return { top: Math.round(r.top), bottom: Math.round(r.bottom), viewportHeight: innerHeight, scrollY: Math.round(scrollY) };
    });
    check('360×640：拍照完成並置中後，上下班按鈕完整在可視範圍', layout.top >= 0 && layout.bottom <= layout.viewportHeight, JSON.stringify(layout));
  } finally {
    if (browser) await browser.close();
  }

  console.log(`\n結果：${pass} 通過、${fail} 失敗`);
  process.exit(fail ? 1 : 0);
})().catch(error => {
  console.error(error);
  process.exit(1);
});
