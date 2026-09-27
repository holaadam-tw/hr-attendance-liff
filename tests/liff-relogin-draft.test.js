// ============================================================
// M-2：LIFF 登入過期 → 保存表單 → 重新登入 → 回來還原（jsdom 實跑 common.js 原文）
// 另含：批次存設定 saveSettings、store.js 預約開放星期同步失敗不再顯示「已儲存」
// 反向對照：COMMON_JS_FILE／STORE_JS_FILE 可指向舊版副本
// ============================================================
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const root = path.join(__dirname, '..');
const commonSrc = fs.readFileSync(process.env.COMMON_JS_FILE || path.join(root, 'common.js'), 'utf8');
const storeSrc = fs.readFileSync(process.env.STORE_JS_FILE || path.join(root, 'modules', 'store.js'), 'utf8');

let pass = 0, fail = 0;
function check(name, condition, detail = '') {
  if (condition) { pass++; console.log(`  ✅ ${name}${detail ? `  → ${detail}` : ''}`); }
  else { fail++; console.log(`  ❌ ${name}${detail ? `  → ${detail}` : ''}`); }
}
function grab(source, name) {
  const a = source.indexOf(`async function ${name}(`);
  const start = a >= 0 ? a : source.indexOf(`function ${name}(`);
  if (start < 0) return '';
  let depth = 0, opened = false;
  for (let i = start; i < source.length; i++) {
    if (source[i] === '{') { depth++; opened = true; }
    if (source[i] === '}' && opened && --depth === 0) return source.slice(start, i + 1);
  }
  return '';
}
const grabConst = name => (commonSrc.match(new RegExp(`const ${name} = [^;]*?;`, 's')) || [''])[0];
const grabObj = name => (commonSrc.match(new RegExp(`const ${name} = [\\[\\{][\\s\\S]*?[\\]\\}];`)) || [''])[0];

const FORM = `
  <input id="lateThreshold" value="5">
  <select id="lineAdminRoute"><option value="digest">d</option><option value="group">g</option></select>
  <input id="featureLunch" type="checkbox">
  <textarea id="note">舊內容</textarea>
  <input id="lineChannelToken" type="text" value="">
  <input id="adminPw" type="password" value="">`;

// 建一個「頁面」：body＝FORM，注入假的 liff／fetch／showToast
function page({ url = 'https://example.test/admin.html#settingPage', inClient = false, accessToken = 'liff-at', response, body = FORM, storage } = {}) {
  const dom = new JSDOM(`<!doctype html><body>${body}</body>`, { url, runScripts: 'outside-only' });
  const w = dom.window;
  if (storage) for (const [k, v] of Object.entries(storage)) w.sessionStorage.setItem(k, v);
  const calls = { login: [], logout: 0, reload: 0, fetch: [], toast: [] };
  w.liff = {
    isInClient: () => inClient,
    getAccessToken: () => accessToken,
    logout: () => { calls.logout++; },
    login: (opts) => { calls.login.push(opts); },
  };
  w.fetch = async (u, init) => {
    calls.fetch.push(JSON.parse(init.body));
    const r = typeof response === 'function' ? response(JSON.parse(init.body)) : (response || { ok: true });
    return { ok: r.ok !== false, status: r.status || 200, json: async () => r };
  };
  w.showToast = (m) => calls.toast.push(m);
  w.CONFIG = { SUPABASE_ANON_KEY: 'anon' };
  w.invalidateSettingsCache = () => {};
  w.loadSettings = async () => {};
  w.currentEmployee = null;
  w.currentCompanyId = 'company-a';
  // jsdom 的 location.reload 不能覆寫 → 包一層
  const code = [grabObj('LINE_PUSH_DENY_MESSAGES'), grabObj('SECRET_SETTING_KEYS'),
    grabConst('FORM_DRAFT_PREFIX'), grabConst('LIFF_RELOGIN_MARKER'), grabConst('FORM_DRAFT_MAX_AGE_MS'), grabObj('FORM_DRAFT_SECRET_IDS'),
    ...['getLiffAccessTokenSafe', 'formDraftKey', 'collectFormDraft', 'saveFormDraft', 'applyFormDraftValues', 'restoreFormDraft',
      'clearReloginMarker', 'handleLiffSessionExpired', 'callVerifiedAction', 'saveSetting', 'saveSettings'].map(n => grab(commonSrc, n))]
    .join('\n').replace(/window\.location\.reload\(\)/g, '__reload()');
  w.__reload = () => { calls.reload++; };
  try { w.eval(code + '\n;window.__fns = { callVerifiedAction: typeof callVerifiedAction === "function" ? callVerifiedAction : null, restoreFormDraft: typeof restoreFormDraft === "function" ? restoreFormDraft : null, saveSetting: typeof saveSetting === "function" ? saveSetting : null, saveSettings: typeof saveSettings === "function" ? saveSettings : null };'); }
  catch (e) { w.__fns = {}; w.__evalError = e.message; }
  return { w, calls, fns: w.__fns || {} };
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  console.log('\n═══════════════════════════════════════');
  console.log('  LIFF 登入過期：保存表單→重登→還原（M-2，jsdom 實跑）');
  console.log('═══════════════════════════════════════');

  console.log('\n=== 過期 → 保存表單 → 重新登入 ===');
  const p1 = page({ response: { ok: false, status: 401, code: 'unauthenticated' } });
  const d1 = p1.w.document;
  d1.getElementById('lateThreshold').value = '15';
  d1.getElementById('lineAdminRoute').value = 'group';
  d1.getElementById('featureLunch').checked = true;
  d1.getElementById('note').value = '新的備註';
  d1.getElementById('lineChannelToken').value = 'SECRET-TOKEN';
  d1.getElementById('adminPw').value = 'pw123';
  const r1 = p1.fns.callVerifiedAction ? await p1.fns.callVerifiedAction('save_setting', { company_id: 'company-a', key: 'x', value: 1 }) : {};
  const draftRaw = p1.w.sessionStorage.getItem('form_draft:/admin.html');
  const draft = draftRaw ? JSON.parse(draftRaw) : { values: {} };
  check('伺服器回 unauthenticated：回 relogin_redirect，並告知內容會保留', r1.code === 'relogin_redirect' && /保留/.test(r1.message || ''), JSON.stringify(r1));
  check('表單值依頁面存進 sessionStorage（文字、下拉、勾選、多行）', draft.values.lateThreshold?.value === '15' && draft.values.lineAdminRoute?.value === 'group'
    && draft.values.featureLunch?.checked === true && draft.values.note?.value === '新的備註', draftRaw);
  check('LINE token 欄與密碼欄不落地', !draftRaw || (!draftRaw.includes('SECRET-TOKEN') && !draftRaw.includes('pw123') && !('lineChannelToken' in draft.values) && !('adminPw' in draft.values)));
  check('電腦瀏覽器：liff.logout() 後 liff.login({ redirectUri: 目前網址 })', p1.calls.logout === 1 && p1.calls.login.length === 1 && p1.calls.login[0].redirectUri === 'https://example.test/admin.html#settingPage');
  check('記下重登時間（防無限迴圈）', !!p1.w.sessionStorage.getItem('liff_relogin_attempt'));

  const r1b = p1.fns.callVerifiedAction ? await p1.fns.callVerifiedAction('save_setting', { company_id: 'company-a', key: 'x', value: 1 }) : {};
  check('2 分鐘內又過期：不再自動重登（不會無限轉圈），改顯示過期訊息', r1b.code === 'unauthenticated' && p1.calls.login.length === 1);

  const p2 = page({ inClient: true, response: { ok: false, status: 401, code: 'unauthenticated' } });
  const r2 = p2.fns.callVerifiedAction ? await p2.fns.callVerifiedAction('get_line_config', { company_id: 'company-a' }) : {};
  check('LINE App 內：改用重新整理（liff.login 在 App 內不可用）', r2.code === 'relogin_redirect' && p2.calls.reload === 1 && p2.calls.login.length === 0);

  const p3 = page({ accessToken: null });
  const r3 = p3.fns.callVerifiedAction ? await p3.fns.callVerifiedAction('save_setting', { company_id: 'company-a', key: 'x', value: 1 }) : {};
  check('本機拿不到 access token：同樣保存表單＋重登，不送出請求', r3.code === 'relogin_redirect' && p3.calls.fetch.length === 0 && p3.calls.login.length === 1);

  const p4 = page({ storage: { liff_relogin_attempt: String(Date.now()) }, response: { ok: true, status: 200 } });
  const r4 = p4.fns.callVerifiedAction ? await p4.fns.callVerifiedAction('save_setting', { company_id: 'company-a', key: 'x', value: 1 }) : {};
  check('重登回來後成功一次：清掉重登記號（下次過期仍可自動重登）', r4.ok === true && !p4.w.sessionStorage.getItem('liff_relogin_attempt'));

  console.log('\n=== 重登回來 → 還原 ===');
  const saved = JSON.stringify({ ts: Date.now(), values: draft.values });
  const later = `<input id="lateThreshold" value="5"><select id="lineAdminRoute"><option value="digest">d</option><option value="group">g</option></select>`;
  const p5 = page({ body: later, storage: { 'form_draft:/admin.html': saved } });
  const n5 = p5.fns.restoreFormDraft ? p5.fns.restoreFormDraft() : 0;
  const d5 = p5.w.document;
  check('已存在的欄位立即填回', n5 === 2 && d5.getElementById('lateThreshold').value === '15' && d5.getElementById('lineAdminRoute').value === 'group');
  check('提示使用者再按一次儲存', p5.calls.toast.some(t => /還原/.test(t)));
  const lazy = d5.createElement('div');
  lazy.innerHTML = '<input id="featureLunch" type="checkbox"><textarea id="note"></textarea>';
  d5.body.appendChild(lazy);
  await sleep(20);
  check('之後才出現的欄位（切換分頁才渲染）也會補填', d5.getElementById('featureLunch').checked === true && d5.getElementById('note').value === '新的備註');
  {
    // 頁面接著從 DB 載入設定、把剛還原的值蓋回舊值 → 0.8 秒後要再補回；使用者自己改的欄位不再動
    const p5b = page({ body: later, storage: { 'form_draft:/admin.html': saved } });
    p5b.fns.restoreFormDraft && p5b.fns.restoreFormDraft();
    const d = p5b.w.document;
    d.getElementById('lateThreshold').value = '5';                 // 模擬 loadAttendanceSettings 用 DB 值覆蓋
    d.getElementById('lineAdminRoute').value = 'digest';
    const sel = d.getElementById('lineAdminRoute');
    sel.value = 'digest';
    sel.dispatchEvent(new p5b.w.Event('change', { bubbles: true }));  // 使用者自己把下拉改回 digest
    await sleep(900);
    check('DB 載入蓋掉還原值 → 稍後自動補回', d.getElementById('lateThreshold').value === '15');
    check('使用者自己改過的欄位不會被草稿覆蓋', d.getElementById('lineAdminRoute').value === 'digest');
  }
  const p6 = page({ url: 'https://example.test/platform.html', storage: { 'form_draft:/admin.html': saved } });
  const n6 = p6.fns.restoreFormDraft ? p6.fns.restoreFormDraft() : -1;
  check('草稿以頁面為 key：別的頁面不會被填入', n6 === 0 && p6.w.document.getElementById('lateThreshold').value === '5');
  const p7 = page({ storage: { 'form_draft:/admin.html': JSON.stringify({ ts: Date.now() - 31 * 60 * 1000, values: draft.values }) } });
  const n7 = p7.fns.restoreFormDraft ? p7.fns.restoreFormDraft() : -1;
  check('超過 30 分鐘的草稿不還原並刪除', n7 === 0 && p7.w.document.getElementById('lateThreshold').value === '5' && !p7.w.sessionStorage.getItem('form_draft:/admin.html'));
  check('initializeLiff 登入成功後會呼叫 restoreFormDraft', /liffProfile = await liff\.getProfile\(\);[\s\S]{0,200}restoreFormDraft\(\)/.test(grab(commonSrc, 'initializeLiff')));

  console.log('\n=== saveSetting 過期時的行為 ===');
  const p8 = page({ response: { ok: false, status: 401, code: 'unauthenticated' } });
  let err8 = null;
  try { await p8.fns.saveSetting('late_threshold_minutes', 5, 'x'); } catch (e) { err8 = e; }
  check('saveSetting 遇到過期：throw「正在重新登入」＋已保存表單＋已轉去登入', !!err8 && /重新登入/.test(err8.message) && !!p8.w.sessionStorage.getItem('form_draft:/admin.html') && p8.calls.login.length === 1, err8 && err8.message);

  console.log('\n=== 批次存設定 saveSettings ===');
  const p9 = page({ response: { ok: true, status: 200, saved_count: 3 } });
  let err9 = null;
  try { await p9.fns.saveSettings([{ key: 'a', value: 1, description: 'A' }, { key: 'b', value: null }, { key: 'c', value: 'x' }]); } catch (e) { err9 = e; }
  const b9 = p9.calls.fetch[0] || {};
  check('saveSettings：一次請求（action=save_settings、帶 LIFF、3 筆）', !err9 && p9.calls.fetch.length === 1 && b9.action === 'save_settings' && b9.liff_access_token === 'liff-at' && b9.items.length === 3 && b9.items[1].value === null, err9 && err9.message);
  const p10 = page({ response: { ok: false, status: 403, code: 'admin_only', error: '只有管理員可以修改此設定', failed_key: 'line_monthly_budget' } });
  let err10 = null;
  try { await p10.fns.saveSettings([{ key: 'line_monthly_budget', value: 1 }]); } catch (e) { err10 = e; }
  check('saveSettings 失敗：throw 並指出哪個設定', !!err10 && /只有管理員/.test(err10.message) && /line_monthly_budget/.test(err10.message));
  const p11 = page();
  let err11 = null;
  try { await p11.fns.saveSettings([{ key: 'line_messaging_api', value: {} }]); } catch (e) { err11 = e; }
  check('saveSettings 拒絕夾帶 LINE token', !!err11 && p11.calls.fetch.length === 0);

  console.log('\n=== store.js：預約開放星期同步失敗不再顯示「已儲存」（L-1）===');
  const startIdx = storeSrc.indexOf('window.saveBookingSettings = async function');
  const fnSrc = startIdx >= 0 ? storeSrc.slice(startIdx, storeSrc.indexOf('\n};', startIdx) + 3) : '';
  const runBooking = async (saveImpl) => {
    const dom = new JSDOM('<!doctype html><body></body>', { url: 'https://example.test/admin.html', runScripts: 'outside-only' });
    const w = dom.window; const toasts = [];
    w.showToast = m => toasts.push(m); w.saveSetting = saveImpl;
    w.eval('var bookingSettings = {}; var bookingInterval = 30;\n' + fnSrc);
    await w.saveBookingSettings('store-1');
    return toasts;
  };
  const tFail = await runBooking(async () => { throw new Error('需要管理員權限'); });
  check('同步失敗：顯示警告與原因，不顯示「✅ 設定已儲存」', tFail.some(t => /⚠️/.test(t) && /管理員權限/.test(t)) && !tFail.some(t => /✅ 設定已儲存/.test(t)), tFail.join(' | '));
  const tOk = await runBooking(async () => {});
  check('同步成功：照常顯示「✅ 設定已儲存」', tOk.some(t => /✅ 設定已儲存/.test(t)));

  console.log(`\n結果：${pass} 通過、${fail} 失敗`);
  process.exit(fail > 0 ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
