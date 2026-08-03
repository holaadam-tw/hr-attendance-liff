// ============================================================
// 切換公司 UI 回歸測試（jsdom）
//
// 測的是「真實檔案裡的真實程式碼」，不是副本：
//   - index.html 的 inline script（pickCompanyFromOverlay /
//     showCompanySelector / mountCompanySwitchEntry）
//   - modules/auth.js 的 renderAdminCompanySwitcher（該模組無 import、
//     只依賴全域，可直接 import 進來測）
//
// 執行：npm run test:ui   （需要 devDependency jsdom）
//
// 注意：jsdom 的 location.reload 不可覆寫，改用 VirtualConsole 攔
//       jsdomError 的「Not implemented: navigation」訊息當作重載計數。
// ============================================================
const fs = require('fs');
const path = require('path');
const { JSDOM, VirtualConsole } = require('jsdom');

const ROOT = path.join(__dirname, '..');
const HTML = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');

const results = [];
function check(name, cond, detail) {
    results.push({ name, pass: !!cond });
    console.log((cond ? '  ✅ ' : '  ❌ ') + name + (detail ? '  → ' + detail : ''));
}

// 取出含切換公司邏輯的那段 inline script
const blocks = [...HTML.matchAll(/<script\b(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)].map(m => m[1]);
const INLINE = blocks.find(b => b.includes('mountCompanySwitchEntry') && b.includes('pickCompanyFromOverlay'));
if (!INLINE) {
    console.error('❌ index.html 找不到切換公司的 inline script — 結構可能已改變');
    process.exit(2);
}

const OPTIONS = [
    { id: 'c1', name: '大正科技機械股份有限公司', role: 'admin' },
    { id: 'c2', name: '本米股份有限公司', role: 'admin' }
];

function boot(url) {
    const counter = { reloads: 0 };
    const vc = new VirtualConsole();
    vc.on('jsdomError', (e) => {
        if (/navigation|reload/i.test(e.message || '')) counter.reloads++;
        else console.error('jsdomError:', e.message);
    });
    const dom = new JSDOM(HTML, {
        runScripts: 'outside-only',
        pretendToBeVisual: true,
        url: url || 'https://example.test/index.html',
        virtualConsole: vc
    });
    const w = dom.window;
    // inline script 依賴 common.js 的全域；common.js 不在此執行，補必要的樁
    w.eval('window.liff = undefined; window.showToast = function(){};');
    w.eval(INLINE);
    w.__counter = counter;
    return w;
}

function click(el, w) { el.dispatchEvent(new w.MouseEvent('click', { bubbles: true })); }

(async () => {
    console.log('\n=== 首頁切換公司入口 ===');

    // 單一公司不掛切換鈕
    {
        const w = boot();
        w.eval(`
            window.currentCompanyName = '大正科技機械股份有限公司';
            window.currentCompanyId = 'c1';
            window.myCompanyOptions = [{ id:'c1', name:'大正科技機械股份有限公司', role:'admin' }];
            window.isPlatformAdmin = false;
            document.getElementById('homeCompanyName').textContent = window.currentCompanyName;
            mountCompanySwitchEntry();
        `);
        const host = w.document.getElementById('homeCompanyName');
        check('單一公司不掛切換鈕', !host.querySelector('button') && host.textContent.includes('大正'));
    }

    // 多公司：掛鈕、取消、選同一家
    {
        const w = boot();
        w.eval(`
            window.currentCompanyName = ${JSON.stringify(OPTIONS[0].name)};
            window.currentCompanyId = 'c1';
            window.myCompanyOptions = ${JSON.stringify(OPTIONS)};
            window.isPlatformAdmin = false;
            document.getElementById('homeCompanyName').textContent = window.currentCompanyName;
            mountCompanySwitchEntry();
            mountCompanySwitchEntry();
        `);
        const doc = w.document;
        const host = doc.getElementById('homeCompanyName');
        const btns = host.querySelectorAll('button');
        check('多公司掛出切換鈕', btns.length === 1 && /切換公司|Đổi/.test(btns[0].textContent));
        check('重複 mount 不重覆掛鈕', btns.length === 1, 'buttons=' + btns.length);
        check('公司名稱未被切換鈕蓋掉', host.textContent.includes('大正科技'));

        click(btns[0], w);
        const overlay = doc.getElementById('company-selector-overlay');
        const names = [...doc.querySelectorAll('#company-selector-list .cs-name')].map(e => e.textContent);
        const roles = [...doc.querySelectorAll('#company-selector-list .cs-role')].map(e => e.textContent);
        check('overlay 開啟且列出兩家公司', overlay.style.display === 'flex' && names.length === 2, JSON.stringify(names));
        check('角色標籤正確', roles.every(r => r === '管理員'), JSON.stringify(roles));
        check('切換入口可取消', !!doc.getElementById('cs-cancel'));

        click(doc.getElementById('cs-cancel'), w);
        check('取消後 overlay 關閉', overlay.style.display === 'none');
        check('取消不寫入公司選擇', w.sessionStorage.getItem('selectedCompanyId') === null);
        check('取消鈕不殘留', !doc.getElementById('cs-cancel'));
        check('取消不重載', w.__counter.reloads === 0);

        click(host.querySelector('button'), w);
        click(doc.querySelectorAll('#company-selector-list .cs-item')[0], w);
        check('選同一家不寫入不重載',
            w.sessionStorage.getItem('selectedCompanyId') === null && w.__counter.reloads === 0);
    }

    // 切換到另一家 → 寫入 + 重載
    {
        const w = boot();
        w.eval(`
            window.currentCompanyName = ${JSON.stringify(OPTIONS[0].name)};
            window.currentCompanyId = 'c1';
            window.myCompanyOptions = ${JSON.stringify(OPTIONS)};
            window.isPlatformAdmin = false;
            mountCompanySwitchEntry();
        `);
        const doc = w.document;
        click(doc.querySelector('#homeCompanyName button'), w);
        click(doc.querySelectorAll('#company-selector-list .cs-item')[1], w);
        await new Promise(r => setTimeout(r, 50));
        check('切換寫入正確 company id', w.sessionStorage.getItem('selectedCompanyId') === 'c2',
            'saved=' + w.sessionStorage.getItem('selectedCompanyId'));
        check('切換觸發整頁重載', w.__counter.reloads === 1, 'reloads=' + w.__counter.reloads);
    }

    console.log('\n=== 首次登入的公司選單 ===');
    const RECORDS = [
        { company_id: 'c1', role: 'admin', name: '我', companies: { name: '大正科技' } },
        { company_id: 'c2', role: 'staff', name: '我', companies: { name: '本米' } },
        { company_id: 'c3', role: 'manager', name: '我', companies: { name: '第三家' } }
    ];

    // 一般情境：列出全部身份
    {
        const w = boot();
        w.eval(`window.__recs = ${JSON.stringify(RECORDS)}; window.__sel = null;
                window.showCompanySelector(window.__recs).then(function(s){ window.__sel = s; });`);
        await new Promise(r => setTimeout(r, 20));
        const doc = w.document;
        const items = doc.querySelectorAll('#company-selector-list .cs-item');
        const roles = [...doc.querySelectorAll('#company-selector-list .cs-role')].map(e => e.textContent);
        check('列出全部三家公司', items.length === 3, 'items=' + items.length);
        check('角色標籤含一般員工', roles[1] === '一般員工', JSON.stringify(roles));
        check('首次登入選單不可取消', !doc.getElementById('cs-cancel'));
        click(items[1], w);
        await new Promise(r => setTimeout(r, 50));
        const sel = w.eval('window.__sel');
        check('回傳被選中的員工記錄', sel && sel.company_id === 'c2' && sel.role === 'staff',
            sel ? sel.company_id + '/' + sel.role : 'null');
    }

    // scope=admin：只列有管理權限的公司（由 admin.html 導回時帶）
    {
        const w = boot('https://example.test/index.html?scope=admin&next=admin.html');
        w.eval(`window.__recs = ${JSON.stringify(RECORDS)}; window.__sel = null;
                window.showCompanySelector(window.__recs).then(function(s){ window.__sel = s; });`);
        await new Promise(r => setTimeout(r, 20));
        const doc = w.document;
        const names = [...doc.querySelectorAll('#company-selector-list .cs-name')].map(e => e.textContent);
        check('scope=admin 只列管理權限公司', names.length === 2 && !names.includes('本米'), JSON.stringify(names));
        click(doc.querySelectorAll('#company-selector-list .cs-item')[1], w);
        await new Promise(r => setTimeout(r, 50));
        const sel = w.eval('window.__sel');
        check('scope=admin 回傳過濾後的正確記錄', sel && sel.company_id === 'c3' && sel.role === 'manager',
            sel ? sel.company_id + '/' + sel.role : 'null');
    }

    console.log('\n=== 後台公司切換下拉（modules/auth.js）===');
    {
        const counter = { reloads: 0 };
        const vc = new VirtualConsole();
        vc.on('jsdomError', (e) => {
            if (/navigation|reload/i.test(e.message || '')) counter.reloads++;
            else console.error('jsdomError:', e.message);
        });
        const dom = new JSDOM('<body><div class="card"><div id="adminCompanyName" style="display:none"></div></div></body>',
            { url: 'https://example.test/admin.html', virtualConsole: vc });
        globalThis.window = dom.window;
        globalThis.document = dom.window.document;
        globalThis.sessionStorage = dom.window.sessionStorage;

        const auth = await import('file://' + path.join(ROOT, 'modules', 'auth.js').replace(/\\/g, '/'));

        window.isPlatformAdmin = false;
        window.myAdminCompanies = [{ id: 'c1', name: '大正科技', role: 'admin' }];
        auth.renderAdminCompanySwitcher();
        check('單一公司不顯示下拉', !document.getElementById('adminCompanySwitcher'));

        window.myAdminCompanies = [
            { id: 'c1', name: '大正科技機械股份有限公司', role: 'admin' },
            { id: 'c2', name: '本米股份有限公司', role: 'manager' }
        ];
        window.currentCompanyId = 'c1';
        const nameEl = document.getElementById('adminCompanyName');
        nameEl.textContent = '大正科技機械股份有限公司';
        nameEl.style.display = 'block';
        auth.renderAdminCompanySwitcher();
        const sel = document.getElementById('adminCompanySwitcher');
        check('跨公司管理員顯示下拉', !!sel);
        check('下拉列出兩家公司', sel && sel.options.length === 2);
        check('主管身份標註 (主管)', sel && sel.options[1].textContent.includes('(主管)'), sel && sel.options[1].textContent);
        check('原公司名稱文字隱藏', nameEl.style.display === 'none');

        auth.renderAdminCompanySwitcher();
        check('重複呼叫不重覆插入', document.querySelectorAll('#adminCompanySwitcher').length === 1);

        sel.value = 'c1';
        sel.dispatchEvent(new window.Event('change'));
        check('選同一家不寫入不重載',
            sessionStorage.getItem('selectedCompanyId') === null && counter.reloads === 0);

        sel.value = 'c2';
        sel.dispatchEvent(new window.Event('change'));
        await new Promise(r => setTimeout(r, 30));
        check('切換寫入正確 id', sessionStorage.getItem('selectedCompanyId') === 'c2');
        check('切換觸發整頁重載', counter.reloads === 1, 'reloads=' + counter.reloads);
    }

    const failed = results.filter(r => !r.pass);
    console.log('\n═══════════════════════════════════════');
    console.log(`  結果：✅ ${results.length - failed.length} 通過  ❌ ${failed.length} 失敗`);
    console.log('═══════════════════════════════════════\n');
    process.exit(failed.length ? 1 : 0);
})().catch(e => { console.error('測試異常:', e); process.exit(2); });
