// ============================================================
// 133／134 前端：薪酬密碼改由伺服器端比對（jsdom 實跑 common.js／salary.html 原文）
//
//   - 讀設定時丟掉明碼，只留 {configured}（134 套用前 DB 仍有明碼也不進記憶體／sessionStorage）
//   - 管理後台密碼框（common.js verifyPayrollPw）與薪資頁（salary.html submitPayrollPassword）
//     都送 line-push action=payroll_unlock，前端不再自己比對
//   - 解鎖依伺服器給的 expires_at 與公司判斷
// 反向對照：COMMON_JS_FILE／SALARY_HTML_FILE 指向舊版副本（git show HEAD~:common.js）→ 應大量失敗
// ============================================================
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const root = path.join(__dirname, '..');
const commonSrc = fs.readFileSync(process.env.COMMON_JS_FILE || path.join(root, 'common.js'), 'utf8');
const salarySrc = fs.readFileSync(process.env.SALARY_HTML_FILE || path.join(root, 'salary.html'), 'utf8');

let pass = 0, fail = 0;
function check(name, condition, detail = '') {
  if (condition) { pass++; console.log(`  ✅ ${name}${detail ? `  → ${detail}` : ''}`); }
  else { fail++; console.log(`  ❌ ${name}${detail ? `  → ${detail}` : ''}`); }
}
// 從 start 開始抓到對應的右大括號（含）
function braceBlock(source, start) {
  if (start < 0) return '';
  let depth = 0, opened = false;
  for (let i = start; i < source.length; i++) {
    if (source[i] === '{') { depth++; opened = true; }
    if (source[i] === '}' && opened && --depth === 0) return source.slice(start, i + 1) + ';';
  }
  return '';
}
const fn = name => {
  const a = commonSrc.indexOf(`async function ${name}(`);
  return braceBlock(commonSrc, a >= 0 ? a : commonSrc.indexOf(`function ${name}(`));
};
const assigned = name => braceBlock(commonSrc, commonSrc.indexOf(`window.${name} = `));
const constLine = name => (commonSrc.match(new RegExp(`const ${name} = [^\\n]*`)) || [''])[0];

const COMMON_PART = [
  'var _settingsCache = null; var currentEmployee = null;',
  constLine('SECRET_SETTING_KEYS'),
  fn('stripSecretSettings'), fn('getCachedSetting'),
  fn('isPayrollPasswordConfigured'), fn('requestPayrollUnlock'), fn('isPayrollUnlockedInMemory'),
  assigned('verifyPayrollPw'),
  'window.__setCache = c => { _settingsCache = stripSecretSettings(c); };',
  'window.__getCache = () => _settingsCache;',
  'window.getCachedSetting = getCachedSetting;',
  'window.isPayrollPasswordConfigured = typeof isPayrollPasswordConfigured === "function" ? isPayrollPasswordConfigured : undefined;',
  'window.requestPayrollUnlock = typeof requestPayrollUnlock === "function" ? requestPayrollUnlock : undefined;',
].join('\n');

// salary.html 的密碼段落（從「薪資密碼驗證」註解到 load 事件前）
const sA = salarySrc.indexOf('// ===== 薪資密碼驗證 =====');
const sB = salarySrc.indexOf("window.addEventListener('load'", sA);
const SALARY_PART = sA > 0 && sB > sA ? salarySrc.slice(sA, sB) + '\nwindow.__checkPayrollPassword = checkPayrollPassword;' : '';

function page({ reply, cache, companyId = 'company-A', body = '', storage = {} }) {
  const dom = new JSDOM(`<!doctype html><body>${body}</body>`, { url: 'https://example.test/salary.html', runScripts: 'outside-only' });
  const w = dom.window;
  for (const [k, v] of Object.entries(storage)) w.localStorage.setItem(k, v);
  const calls = [];
  w.currentCompanyId = companyId;
  w.callVerifiedAction = async (action, payload) => { calls.push({ action, payload }); return reply(action, payload); };
  w.eval(COMMON_PART);
  w.__setCache(cache);
  return { w, calls };
}
const okReply = (expiresInMs = 3600e3) => async () => ({ ok: true, code: 'ok', data: { ok: true, unlock_token: 't', expires_at: new Date(Date.now() + expiresInMs).toISOString(), configured: true } });
const wrongReply = async () => ({ ok: false, code: 'wrong_password', message: '密碼錯誤' });

(async () => {
  console.log('\n═══════════════════════════════════════');
  console.log('  薪酬密碼前端改伺服器端比對（jsdom 實跑）');
  console.log('═══════════════════════════════════════');

  console.log('\n=== 設定快取：不保留明碼 ===');
  {
    const { w } = page({ reply: wrongReply, cache: { payroll_password: { password: 'plain-123' }, office_locations: [1] } });
    const cache = w.__getCache();
    check('134 前 DB 仍回明碼：快取裡只剩 configured=true', JSON.stringify(cache.payroll_password) === '{"configured":true}', JSON.stringify(cache.payroll_password));
    check('其他設定原樣保留', Array.isArray(cache.office_locations) && cache.office_locations[0] === 1);
    check('isPayrollPasswordConfigured()＝true', typeof w.isPayrollPasswordConfigured === 'function' && w.isPayrollPasswordConfigured() === true);
    const { w: w2 } = page({ reply: wrongReply, cache: { payroll_password: { configured: true } } });
    check('134 後的 {configured:true} 照樣判定有設', w2.isPayrollPasswordConfigured?.() === true);
    const { w: w3 } = page({ reply: wrongReply, cache: { office_locations: [] } });
    check('沒有這列：判定沒設', w3.isPayrollPasswordConfigured?.() === false);
    const { w: w4 } = page({ reply: wrongReply, cache: { payroll_password: { configured: false } } });
    check('{configured:false}：判定沒設', w4.isPayrollPasswordConfigured?.() === false);
  }

  const ADMIN_DIALOG = `<input id="payrollPwInput" value=""><div id="payrollPwError" style="display:none"></div>`;
  console.log('\n=== 管理後台密碼框（common.js verifyPayrollPw）===');
  {
    const { w, calls } = page({ reply: wrongReply, cache: { payroll_password: { password: 'plain-123' } }, body: ADMIN_DIALOG });
    let opened = 0;
    w._payrollCallback = () => { opened++; };
    w.document.getElementById('payrollPwInput').value = 'plain-123';
    await w.verifyPayrollPw();
    check('就算輸入的是 DB 舊明碼，伺服器說錯就不放行（前端不再自己比對）', opened === 0 && w._payrollUnlocked !== true);
    check('送 payroll_unlock、帶公司與密碼、不帶 line_user_id', calls.length === 1 && calls[0].action === 'payroll_unlock'
      && calls[0].payload.company_id === 'company-A' && calls[0].payload.password === 'plain-123' && !('line_user_id' in calls[0].payload), JSON.stringify(calls));
    const err = w.document.getElementById('payrollPwError');
    check('顯示「密碼錯誤」、清空輸入框', err.style.display === '' && /密碼錯誤/.test(err.textContent) && w.document.getElementById('payrollPwInput').value === '');
  }
  {
    const { w } = page({ reply: okReply(), cache: { payroll_password: { configured: true } }, body: ADMIN_DIALOG });
    let opened = 0;
    w._payrollCallback = () => { opened++; };
    w.document.getElementById('payrollPwInput').value = 'right';
    await w.verifyPayrollPw();
    check('伺服器放行 → 開啟薪酬頁、記下到期時間', opened === 1 && w._payrollUnlocked === true && w._payrollUnlockExpires > Date.now());
    check('到期前 isPayrollUnlockedInMemory()＝true', w.eval('isPayrollUnlockedInMemory()') === true);
    w._payrollUnlockExpires = Date.now() - 1;
    check('過了伺服器給的到期時間就要重輸', w.eval('isPayrollUnlockedInMemory()') === false);
  }
  {
    const { w } = page({ reply: async () => ({ ok: false, code: 'rate_limited', message: '密碼錯誤次數太多，請 15 分鐘後再試' }), cache: {}, body: ADMIN_DIALOG });
    w.document.getElementById('payrollPwInput').value = 'x';
    await w.verifyPayrollPw();
    check('錯太多次：顯示伺服器訊息', /15 分鐘/.test(w.document.getElementById('payrollPwError').textContent));
  }
  check('common.js 不再有前端比對（input === correctPw）', !/input === correctPw/.test(commonSrc));

  console.log('\n=== 薪資頁（salary.html）===');
  check('salary.html 不再讀 payroll_password 的 password 欄位', !/setting\.password/.test(salarySrc) && !/correctPw/.test(salarySrc));
  const MODAL = `<div id="payrollPasswordModal" style="display:none"></div><input id="payrollPasswordInput" value=""><p id="payrollPasswordError" style="display:none"></p>`;
  const salaryPage = (opts) => {
    const p = page({ body: MODAL, ...opts });
    p.w.isPlatformAdmin = false;
    try { p.w.eval(SALARY_PART); } catch (e) { p.err = e.message; }
    return p;
  };
  {
    const { w, err } = salaryPage({ reply: okReply(), cache: { payroll_password: { configured: true } } });
    check('薪資頁密碼段落可載入', !err && typeof w.__checkPayrollPassword === 'function', err);
    const pending = w.__checkPayrollPassword?.();
    check('有設密碼：跳出密碼框', w.document.getElementById('payrollPasswordModal').style.display === 'flex');
    w.document.getElementById('payrollPasswordInput').value = 'right';
    await w.submitPayrollPassword?.();
    const passed = await Promise.race([pending, new Promise(r => setTimeout(() => r('timeout'), 200))]);
    const saved = JSON.parse(w.localStorage.getItem('payroll_unlock_v2') || 'null');
    check('伺服器放行 → 關閉密碼框、進入薪資頁', passed === true && w.document.getElementById('payrollPasswordModal').style.display === 'none');
    check('本機記下公司＋到期時間（不是「今天日期」）', saved && saved.company_id === 'company-A' && saved.expires_at > Date.now());
  }
  {
    const { w, calls } = salaryPage({ reply: wrongReply, cache: { payroll_password: { password: 'plain-123' } } });
    const pending = w.__checkPayrollPassword?.();
    w.document.getElementById('payrollPasswordInput').value = 'plain-123';
    await w.submitPayrollPassword?.();
    const passed = await Promise.race([pending, new Promise(r => setTimeout(() => r('timeout'), 200))]);
    check('輸入 DB 舊明碼但伺服器說錯：不放行、顯示錯誤', passed === 'timeout' && w.document.getElementById('payrollPasswordError').style.display === 'block'
      && calls.length === 1 && calls[0].action === 'payroll_unlock');
  }
  {
    const { w, calls } = salaryPage({ reply: wrongReply, cache: {} });
    check('公司沒設密碼：不跳密碼框、直接進（同舊行為）', (await w.__checkPayrollPassword?.()) === true && calls.length === 0);
  }
  {
    const { w } = salaryPage({ reply: wrongReply, cache: { payroll_password: { configured: true } },
      storage: { payroll_unlock_v2: JSON.stringify({ company_id: 'company-A', expires_at: Date.now() + 60e3 }) } });
    check('本公司解鎖未過期：直接進', (await w.__checkPayrollPassword?.()) === true);
  }
  for (const [label, stored] of [
    ['解鎖已過期', { company_id: 'company-A', expires_at: Date.now() - 1 }],
    ['別家公司的解鎖', { company_id: 'company-B', expires_at: Date.now() + 60e3 }],
  ]) {
    const { w } = salaryPage({ reply: wrongReply, cache: { payroll_password: { configured: true } }, storage: { payroll_unlock_v2: JSON.stringify(stored) } });
    w.__checkPayrollPassword?.();
    check(`${label}：要重新輸入`, w.document.getElementById('payrollPasswordModal').style.display === 'flex');
  }
  {
    const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Taipei' });
    const { w } = salaryPage({ reply: wrongReply, cache: { payroll_password: { configured: true } }, storage: { payroll_unlocked: today } });
    w.__checkPayrollPassword?.();
    check('舊版「當日有效」旗標（前端自己比對得來的）不再採信、且被清掉', w.document.getElementById('payrollPasswordModal').style.display === 'flex'
      && w.localStorage.getItem('payroll_unlocked') === null);
  }

  console.log(`\n結果：${pass} 通過、${fail} 失敗`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('  ❌ 中途失敗：' + e.message); console.log(`\n結果：${pass} 通過、${fail + 1} 失敗`); process.exit(1); });
