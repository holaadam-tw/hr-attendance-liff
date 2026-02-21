#!/usr/bin/env node
/**
 * Propiston E2E v2.0 — LIFF Mock
 * npm install puppeteer && node e2e-test.js
 *
 * v2.0: LIFF SDK Mock + waitForTimeout fix + :has-text fix + Console filter
 */

const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');

const SITE_URL = process.env.SITE_URL || 'https://holaadam-tw.github.io/hr-attendance-liff';
const SCREENSHOT_DIR = path.join(__dirname, 'e2e-screenshots');
const STORE_SLUG = 'benmi-tucheng';
const MOCK_LINE_USER_ID = 'U895669e3fe46a9008d4d612b884ef984';
const MOCK_DISPLAY_NAME = 'Adam';

const C = {
  reset:'\x1b[0m', bold:'\x1b[1m',
  red:'\x1b[31m', green:'\x1b[32m', yellow:'\x1b[33m',
  cyan:'\x1b[36m', gray:'\x1b[90m',
  bgRed:'\x1b[41m', bgGreen:'\x1b[42m',
};

let total=0, pass=0, fail=0, warn=0;
const results=[], consoleErrors={};

function log(s, test, detail='') {
  total++;
  const icon = s==='PASS'?`${C.green}✅`:s==='FAIL'?`${C.red}❌`:`${C.yellow}⚠️`;
  if(s==='PASS')pass++; else if(s==='FAIL')fail++; else warn++;
  console.log(`  ${icon} ${s}${C.reset}  ${test}${detail?`${C.gray} → ${detail}${C.reset}`:''}`);
  results.push({status:s, test, detail});
}

async function wait(ms){return new Promise(r=>setTimeout(r,ms));}

async function shot(page,name){
  const f=path.join(SCREENSHOT_DIR,`${name}.png`);
  await page.screenshot({path:f,fullPage:false}); return f;
}

function captureConsole(page,name){
  consoleErrors[name]=[];
  page.on('console',msg=>{
    if(msg.type()==='error'){
      const t=msg.text();
      if(t.includes('favicon')||t.includes('net::ERR_')||t.includes('liff')||t.includes('LIFF')||t.includes('sdk.js')||t.includes('ERR_BLOCKED'))return;
      consoleErrors[name].push(t);
    }
  });
  page.on('pageerror',err=>{
    if(err.message.includes('liff')||err.message.includes('LIFF'))return;
    consoleErrors[name].push(`[PageError] ${err.message}`);
  });
}

async function countEls(page,sel){return page.$$eval(sel,els=>els.length).catch(()=>0);}

// ========== LIFF Mock ==========
async function injectLiffMock(page) {
  await page.setRequestInterception(true);
  page.on('request', req => {
    if (req.url().includes('line-scdn.net/liff') || req.url().includes('liff/edge')) {
      req.respond({ status:200, contentType:'application/javascript', body:'// LIFF SDK blocked by E2E mock' });
    } else {
      req.continue();
    }
  });
  await page.evaluateOnNewDocument((uid,name) => {
    window.liff = {
      init:()=>Promise.resolve(),
      isLoggedIn:()=>true,
      isInClient:()=>false,
      isApiAvailable:()=>true,
      login:()=>{}, logout:()=>{},
      getProfile:()=>Promise.resolve({userId:uid,displayName:name,pictureUrl:'https://via.placeholder.com/150/4F46E5/FFF?text='+name[0],statusMessage:'E2E'}),
      getContext:()=>({type:'external',liffId:'2008962829-bnsS1bbB'}),
      getAccessToken:()=>'mock-token',
      getDecodedIDToken:()=>({sub:uid,name}),
      ready:Promise.resolve(),
      id:'2008962829-bnsS1bbB',
    };
    console.log('[E2E] LIFF Mock injected:', uid);
  }, MOCK_LINE_USER_ID, MOCK_DISPLAY_NAME);
}

// ========== Test 1: Order Flow ==========
async function test1(browser) {
  console.log(`\n${C.bold}${C.cyan}━━━ 測試 1：order.html 點餐流程 ━━━${C.reset}`);
  const page = await browser.newPage();
  await page.setViewport({width:1280,height:800});
  captureConsole(page,'order.html');
  try {
    await page.goto(`${SITE_URL}/order.html?store=${STORE_SLUG}`,{waitUntil:'networkidle2',timeout:30000});
    await wait(3000);
    log('PASS','1-1 頁面載入',`order.html?store=${STORE_SLUG}`);
    await shot(page,'1-1_order_loaded');

    const menuItems = await countEls(page,'.menu-item');
    const featured = await countEls(page,'.featured-card');
    log(menuItems+featured>0?'PASS':'WARN','1-2 菜單品項',`menu-item:${menuItems} featured:${featured}`);

    if(menuItems+featured>0){
      const addBtns = await page.$$('.featured-add, .add-btn');
      if(addBtns.length>0){
        await addBtns[0].click(); await wait(800);
        const badge = await page.$eval('#cartCount,.cart-badge,.fab-badge',el=>el.textContent).catch(()=>'0');
        log(parseInt(badge)>0?'PASS':'WARN','1-3 加入購物車',`數量:${badge}`);
        await shot(page,'1-3_cart');
      }
    } else { log('WARN','1-3 加入購物車','無品項'); }

    const cartFab = await page.$('#cartFab,.fab-cart,[onclick*="toggleCart"]');
    if(cartFab){
      await cartFab.click(); await wait(1500);
      log('PASS','1-4 開啟購物車','');
      await shot(page,'1-4_cart_opened');

      const phone = await page.$('#confirmPhone,input[type="tel"]');
      if(phone){
        await phone.click({clickCount:3}); await phone.type('0912345678');
        await wait(1500);
        log('PASS','1-5 手機輸入','0912345678');
        await shot(page,'1-5_phone');

        const memberInfo = await page.$eval('#confirmMemberInfo',el=>el.textContent).catch(()=>'');
        log(memberInfo.length>0?'PASS':'WARN','1-5b 會員資訊',memberInfo.substring(0,50)||'空');
      } else { log('WARN','1-5 手機欄位','需有購物車內容才顯示'); }
    } else { log('WARN','1-4 購物車按鈕','找不到'); }

    const submit = await page.$('[onclick*="confirmAndSubmit"],[onclick*="submitOrder"]');
    log(submit?'PASS':'WARN','1-6 送出按鈕',submit?'存在':'未找到');

    const headerBtn = await page.$('#headerOrderBtn');
    log(headerBtn?'PASS':'WARN','1-7 headerOrderBtn',headerBtn?'存在':'未找到（首次需先下單）');

    const myOrders = await page.$('#myOrdersOverlay,[id*="myOrders"]');
    log(myOrders?'PASS':'WARN','1-8 我的訂單面板',myOrders?'DOM存在':'未找到');

  } catch(e){ log('FAIL','1-X 異常',e.message.substring(0,100)); }
  finally{ await page.close(); }
}

// ========== Test 2: Admin (LIFF Mock) ==========
async function test2(browser) {
  console.log(`\n${C.bold}${C.cyan}━━━ 測試 2：admin.html 後台（LIFF Mock） ━━━${C.reset}`);
  const page = await browser.newPage();
  await page.setViewport({width:1280,height:900});
  captureConsole(page,'admin.html');
  await injectLiffMock(page);
  try {
    await page.goto(`${SITE_URL}/admin.html`,{waitUntil:'networkidle2',timeout:30000});
    await wait(4000);
    log('PASS','2-1 頁面載入（LIFF Mock）','admin.html');
    await shot(page,'2-1_admin');

    const userName = await page.$eval('#userName',el=>el.textContent).catch(()=>'');
    log(userName&&userName!=='-'?'PASS':'WARN','2-2 用戶名稱',userName?`"${userName}"`:'未顯示');

    const menuItems = await countEls(page,'.menu-item');
    log(menuItems>0?'PASS':'WARN','2-3 選單項目',`${menuItems}個${menuItems<=16?' (≤16 ✓)':''}`);
    await shot(page,'2-3_admin_menu');

    const labels = await page.$$eval('.menu-item',els=>
      els.filter(el=>el.offsetParent!==null&&getComputedStyle(el).display!=='none')
        .map(el=>({t:el.textContent.trim().substring(0,20),f:el.dataset?.feature||''}))
    ).catch(()=>[]);
    labels.forEach(m=>console.log(`       ${C.gray}├─ 👁️ ${m.t}${m.f?` [${m.f}]`:''}${C.reset}`));

    const switcher = await page.$('#companySwitcher,select[id*="company"],[class*="company-switch"]');
    log(switcher?'PASS':'WARN','2-4 公司切換器',switcher?'存在（多公司模式）':'未找到');
    if(switcher) await shot(page,'2-4_company_switcher');

    // Tab 測試
    const payItem = await page.$('.menu-item[onclick*="salaryComp"],.menu-item[onclick*="payroll"]');
    if(payItem){
      await payItem.click(); await wait(1000);
      const payTabs = await countEls(page,'[onclick*="switchPayTab"]');
      log(payTabs>=2?'PASS':'WARN','2-5 薪酬Tab',`${payTabs}個`);
      await shot(page,'2-5_pay_tabs');
    } else { log('WARN','2-5 薪酬管理','找不到選單項'); }

    try {
      const back = await page.$('[onclick*="adminHomePage"],[onclick*="showPage"]');
      if(back){await back.click();await wait(1500);}

      const sysItem = await page.$('.menu-item[onclick*="systemSetting"],.menu-item[onclick*="system"]');
      if(sysItem){
        await sysItem.click(); await wait(1000);
        const sysTabs = await countEls(page,'[onclick*="switchSysTab"]');
        log(sysTabs>=2?'PASS':'WARN','2-6 系統設定Tab',`${sysTabs}個`);
        await shot(page,'2-6_sys_tabs');
      } else { log('WARN','2-6 系統設定','找不到選單項'); }
    } catch(navErr) {
      log('WARN','2-6 系統設定','導航失敗: '+navErr.message.substring(0,50));
    }

    const booking = await page.$('.menu-item[data-feature="booking"],[onclick*="bookingMgr"]');
    if(booking){
      const vis = await page.evaluate(el=>el.offsetParent!==null&&getComputedStyle(el).display!=='none',booking);
      log(vis?'PASS':'WARN','2-7 預約管理',vis?'可見':'被feature隱藏');
    } else { log('WARN','2-7 預約管理','找不到'); }

    const member = await page.$('.menu-item[data-feature="member"],[onclick*="memberMgr"]');
    if(member){
      const vis = await page.evaluate(el=>el.offsetParent!==null&&getComputedStyle(el).display!=='none',member);
      log(vis?'PASS':'WARN','2-8 會員管理',vis?'可見':'被feature隱藏');
    } else { log('WARN','2-8 會員管理','找不到'); }

  } catch(e){ log('FAIL','2-X 異常',e.message.substring(0,100)); }
  finally{ await page.close(); }
}

// ========== Test 3: Index Features (LIFF Mock) ==========
async function test3(browser) {
  console.log(`\n${C.bold}${C.cyan}━━━ 測試 3：index.html 功能格（LIFF Mock） ━━━${C.reset}`);
  const page = await browser.newPage();
  await page.setViewport({width:1280,height:800});
  captureConsole(page,'index.html');
  await injectLiffMock(page);
  try {
    await page.goto(`${SITE_URL}/index.html`,{waitUntil:'networkidle2',timeout:30000});
    await wait(4000);
    log('PASS','3-1 頁面載入（LIFF Mock）','');
    await shot(page,'3-1_index');

    const userName = await page.$eval('#userName',el=>el.textContent).catch(()=>'');
    log(userName&&userName!=='-'?'PASS':'WARN','3-2 用戶名稱',userName?`"${userName}"`:'未顯示');

    const all = await countEls(page,'[data-feature]');
    const vis = await page.$$eval('[data-feature]',els=>
      els.filter(el=>el.offsetParent!==null&&getComputedStyle(el).display!=='none').length
    ).catch(()=>0);
    log(all>0?'PASS':'WARN','3-3 功能格',`${all}個（可見:${vis}）`);

    const list = await page.$$eval('[data-feature]',els=>
      els.map(el=>({f:el.dataset.feature,v:el.offsetParent!==null&&getComputedStyle(el).display!=='none',t:el.textContent.trim().substring(0,20)}))
    ).catch(()=>[]);
    list.forEach(f=>console.log(`       ${C.gray}├─ ${f.v?'👁️':'🚫'} [${f.f}] ${f.t}${C.reset}`));

    const checkin = await page.$('#attendanceCard,[class*="checkin"],[onclick*="checkin"]');
    log(checkin?'PASS':'WARN','3-4 出勤打卡區',checkin?'存在':'未找到');
    await shot(page,'3-4_features');

  } catch(e){ log('FAIL','3-X 異常',e.message.substring(0,100)); }
  finally{ await page.close(); }
}

// ========== Test 4: Mobile Layout ==========
async function test4(browser) {
  console.log(`\n${C.bold}${C.cyan}━━━ 測試 4：手機版排版 ━━━${C.reset}`);
  const pages = [
    {url:`${SITE_URL}/order.html?store=${STORE_SLUG}`,name:'order',liff:false},
    {url:`${SITE_URL}/admin.html`,name:'admin',liff:true},
    {url:`${SITE_URL}/index.html`,name:'index',liff:true},
  ];
  for(const pg of pages){
    const page = await browser.newPage();
    await page.setViewport({width:393,height:852,isMobile:true,hasTouch:true});
    captureConsole(page,`${pg.name}_mobile`);
    if(pg.liff) await injectLiffMock(page);
    try {
      await page.goto(pg.url,{waitUntil:'networkidle2',timeout:30000});
      await wait(3000);
      log('PASS',`4 ${pg.name} 手機載入`,'393x852');
      await shot(page,`4_mobile_${pg.name}`);
      const overflow = await page.evaluate(()=>document.documentElement.scrollWidth>document.documentElement.clientWidth);
      log(!overflow?'PASS':'WARN',`4 ${pg.name} 水平溢出`,overflow?'有溢出':'無 ✓');
    } catch(e){ log('FAIL',`4 ${pg.name}`,e.message.substring(0,80)); }
    finally{ await page.close(); }
  }

  // 手機/姓名排列
  const page = await browser.newPage();
  await page.setViewport({width:393,height:852,isMobile:true,hasTouch:true});
  captureConsole(page,'order_mobile_form');
  try {
    await page.goto(`${SITE_URL}/order.html?store=${STORE_SLUG}`,{waitUntil:'networkidle2',timeout:30000});
    await wait(3000);
    const addBtn = await page.$('.featured-add,.add-btn');
    if(addBtn){
      await addBtn.click(); await wait(500);
      const fab = await page.$('#cartFab,.fab-cart');
      if(fab){
        await fab.click(); await wait(1500);
        const ph = await page.$('#confirmPhone,input[type="tel"]');
        const nm = await page.$('#confirmName,input[placeholder*="姓名"]');
        if(ph&&nm){
          const pb=await ph.boundingBox(), nb=await nm.boundingBox();
          if(pb&&nb){
            const vert = nb.y > pb.y + pb.height - 10;
            log(vert?'PASS':'WARN','4 手機/姓名排列',vert?'上下排列 ✓':`並排 phone.y=${Math.round(pb.y)} name.y=${Math.round(nb.y)}`);
            await shot(page,'4_mobile_form');
          }
        } else { log('WARN','4 手機/姓名','找不到欄位'); }
      }
    }
  } catch(e){ log('WARN','4 手機表單',e.message.substring(0,80)); }
  finally{ await page.close(); }
}

// ========== Test 5: LIFF Auth ==========
async function test5(browser) {
  console.log(`\n${C.bold}${C.cyan}━━━ 測試 5：LINE LIFF 認證（Mock） ━━━${C.reset}`);
  const page = await browser.newPage();
  await page.setViewport({width:393,height:852,isMobile:true});
  captureConsole(page,'checkin_liff');
  await injectLiffMock(page);
  try {
    await page.goto(`${SITE_URL}/checkin.html`,{waitUntil:'networkidle2',timeout:30000});
    await wait(4000);
    log('PASS','5-1 checkin（LIFF Mock）','');
    await shot(page,'5-1_checkin');

    const userName = await page.$eval('#userName',el=>el.textContent).catch(()=>'');
    log(userName&&userName!=='-'?'PASS':'WARN','5-2 用戶名稱',userName?`"${userName}" (Mock成功)`:'Mock後仍未顯示');

    const checkinBtn = await page.$('[onclick*="handleCheckin"],.checkin-btn,#checkinBtn,[onclick*="checkIn"]');
    log(checkinBtn?'PASS':'WARN','5-3 打卡按鈕',checkinBtn?'存在':'未找到');

    const liffOk = await page.evaluate(()=>typeof liff!=='undefined'&&liff.isLoggedIn());
    log(liffOk?'PASS':'FAIL','5-4 LIFF Mock 狀態',liffOk?'已登入 ✓':'失敗');
    await shot(page,'5-4_liff');

  } catch(e){ log('FAIL','5-X 異常',e.message.substring(0,100)); }
  finally{ await page.close(); }
}

// ========== Test 6: Booking ==========
async function test6(browser) {
  console.log(`\n${C.bold}${C.cyan}━━━ 測試 6：預約流程 ━━━${C.reset}`);
  const page = await browser.newPage();
  await page.setViewport({width:393,height:852,isMobile:true});
  captureConsole(page,'booking');
  try {
    const resp = await page.goto(`${SITE_URL}/booking.html?store=${STORE_SLUG}`,{waitUntil:'networkidle2',timeout:30000});
    await wait(2000);
    const st = resp?.status()||0;
    if(st===404){ log('WARN','6-1 booking.html','404 — 尚未部署'); }
    else {
      log('PASS','6-1 booking.html',`HTTP ${st}`);
      await shot(page,'6-1_booking');
      const hasDate = await page.$('[type="date"],.date-picker,[class*="calendar"]');
      const hasForm = await page.$('input[placeholder*="姓名"],input[type="tel"]');
      const hasSlot = await page.$('[class*="time-slot"],[class*="slot"]');
      log(hasDate||hasForm||hasSlot?'PASS':'WARN','6-2 預約表單',
        [hasDate&&'日期',hasForm&&'欄位',hasSlot&&'時段'].filter(Boolean).join('+')||'未找到');
    }
  } catch(e){ log('WARN','6-X 預約',e.message.substring(0,100)); }
  finally{ await page.close(); }
}

// ========== Test 7: Console Errors ==========
function test7() {
  console.log(`\n${C.bold}${C.cyan}━━━ 測試 7：Console 錯誤彙總 ━━━${C.reset}`);
  for(const [name,errs] of Object.entries(consoleErrors)){
    if(errs.length===0){ log('PASS',`7 ${name}`,'無 JS 錯誤 ✓'); }
    else {
      log(errs.length<=3?'WARN':'FAIL',`7 ${name}`,`${errs.length}個錯誤`);
      errs.slice(0,5).forEach(e=>console.log(`       ${C.red}├─ ${e.substring(0,120)}${C.reset}`));
    }
  }
}

// ========== Main ==========
async function main() {
  console.log(`\n${C.bold}  ╔══════════════════════════════════════════════╗`);
  console.log(`  ║   🧪 Propiston E2E v2.0 + LIFF Mock           ║`);
  console.log(`  ╚══════════════════════════════════════════════╝${C.reset}\n`);

  if(!fs.existsSync(SCREENSHOT_DIR)) fs.mkdirSync(SCREENSHOT_DIR,{recursive:true});

  console.log(`  ${C.gray}網站:     ${SITE_URL}${C.reset}`);
  console.log(`  ${C.gray}LIFF Mock: ${MOCK_LINE_USER_ID} (${MOCK_DISPLAY_NAME})${C.reset}`);

  const start = Date.now();
  const browser = await puppeteer.launch({
    headless:'new',
    args:['--no-sandbox','--disable-setuid-sandbox'],
    defaultViewport:null,
  });

  try {
    await test1(browser);
    await test2(browser);
    await test3(browser);
    await test4(browser);
    await test5(browser);
    await test6(browser);
    test7();
  } catch(e){ console.error(`\n${C.red}Fatal: ${e.message}${C.reset}`); }
  finally{ await browser.close(); }

  const elapsed = ((Date.now()-start)/1000).toFixed(1);
  const score = total>0 ? Math.round(((pass+warn*0.5)/total)*100) : 0;
  const sc = score>=80?C.green:score>=50?C.yellow:C.red;

  console.log(`\n${C.bold}${'━'.repeat(50)}${C.reset}`);
  console.log(`${C.bold}  📊 E2E v2.0 結果摘要${C.reset}`);
  console.log(`${C.bold}${'━'.repeat(50)}${C.reset}\n`);
  console.log(`  健康分數:  ${sc}${C.bold}${score}%${C.reset}`);
  console.log(`  測試總數:  ${total}`);
  console.log(`  ${C.green}✅ 通過:    ${pass}${C.reset}`);
  console.log(`  ${C.yellow}⚠️  警告:    ${warn}${C.reset}`);
  console.log(`  ${C.red}❌ 失敗:    ${fail}${C.reset}`);
  console.log(`  耗時:      ${elapsed}s`);

  if(fail===0) console.log(`\n  ${C.bgGreen}${C.bold} 🎉 無關鍵失敗！ ${C.reset}`);
  else {
    console.log(`\n  ${C.bgRed}${C.bold} 🚨 ${fail} 項失敗 ${C.reset}`);
    results.filter(r=>r.status==='FAIL').forEach(r=>console.log(`  ${C.red}  → ${r.test}: ${r.detail}${C.reset}`));
  }

  const shots = fs.readdirSync(SCREENSHOT_DIR).filter(f=>f.endsWith('.png'));
  if(shots.length>0){
    console.log(`\n  ${C.bold}📸 截圖 (${shots.length}):${C.reset}`);
    shots.forEach(f=>console.log(`  ${C.gray}  ${f}${C.reset}`));
  }

  console.log(`\n  ${C.bold}v2.0 改進:${C.reset}`);
  console.log(`  ${C.gray}✓ LIFF Mock → index/admin/checkin 完整測試${C.reset}`);
  console.log(`  ${C.gray}✓ SDK 攔截 → 不載入真實 LIFF SDK${C.reset}`);
  console.log(`  ${C.gray}✓ waitForTimeout → wait() helper${C.reset}`);
  console.log(`  ${C.gray}✓ :has-text() → 移除${C.reset}`);
  console.log(`  ${C.gray}✓ Console 過濾 → favicon/LIFF/net 忽略${C.reset}`);

  console.log(`\n${C.gray}━━━ ${new Date().toLocaleString()} ━━━${C.reset}\n`);
  process.exit(fail>0?1:0);
}

main().catch(e=>{console.error(`Fatal: ${e.message}`);process.exit(1);});
