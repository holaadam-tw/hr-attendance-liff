#!/usr/bin/env node
/**
 * 🏥 Propiston 系統健康檢查 v4.0
 * 完整版：DB(47表) + 約束 + RLS讀寫 + 頁面載入 + 前端函數 + 功能測試 + 資料品質 + FK完整性 + 預約 + JS語法
 */

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://nssuisyvlrqnqfxupklb.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im5zc3Vpc3l2bHJxbnFmeHVwa2xiIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjkyOTAwMzUsImV4cCI6MjA4NDg2NjAzNX0.q_B6v3gf1TOCuAq7z0xIw10wDueCSJn0p37VzdMfmbc';
const SITE_URL = process.env.SITE_URL || 'https://holaadam-tw.github.io';

// ========== 顏色 ==========
const C = {
  reset:'\x1b[0m', bold:'\x1b[1m',
  red:'\x1b[31m', green:'\x1b[32m', yellow:'\x1b[33m', blue:'\x1b[34m',
  cyan:'\x1b[36m', gray:'\x1b[90m',
  bgRed:'\x1b[41m', bgGreen:'\x1b[42m',
};
const PASS = `${C.green}✅ PASS${C.reset}`;
const FAIL = `${C.red}❌ FAIL${C.reset}`;
const WARN = `${C.yellow}⚠️  WARN${C.reset}`;
const INFO = `${C.blue}ℹ️  INFO${C.reset}`;
const SKIP = `${C.gray}⏭️  SKIP${C.reset}`;

// ========== 計分 ==========
let total=0, pass=0, fail=0, warn=0, info_c=0, skip_c=0;
let criticals=[], todos=[];
const sections = {};
let currentSection = '';

function section(name) {
  currentSection = name;
  sections[name] = { pass:0, fail:0, warn:0, total:0 };
  console.log(`\n${C.bold}${C.cyan}━━━ ${name} ━━━${C.reset}`);
}

function log(s, cat, name, detail, crit=false) {
  if (s===SKIP) { skip_c++; console.log(`  ${s}  ${name}${detail?`${C.gray} → ${detail}${C.reset}`:''}`); return; }
  total++; sections[currentSection].total++;
  if (s===PASS) { pass++; sections[currentSection].pass++; }
  else if (s===FAIL) { fail++; sections[currentSection].fail++; if(crit)criticals.push(`${cat} > ${name}: ${detail||''}`); }
  else if (s===WARN) { warn++; sections[currentSection].warn++; }
  else if (s===INFO) { info_c++; }
  if (s===FAIL||s===WARN) todos.push({p:s===FAIL?'🔴':'🟡',m:`${name}: ${detail||''}`});
  const tag = crit ? `${C.red}[CRITICAL]${C.reset} ` : '';
  const det = detail ? `${C.gray} → ${detail}${C.reset}` : '';
  console.log(`  ${s}  ${tag}${name}${det}`);
}

// ========== DB 工具 ==========
const headers = { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` };

async function tableExists(table) {
  try {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/${table}?limit=0`, { method:'HEAD', headers });
    return r.status < 404;
  } catch { return false; }
}

async function tableQuery(table, params='') {
  try {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/${table}?${params}`, { headers });
    if (!r.ok) return { ok:false, data:null, status:r.status };
    return { ok:true, data: await r.json(), status:r.status };
  } catch { return { ok:false, data:null, status:0 }; }
}

async function testInsert(table, row) {
  try {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/${table}`, {
      method: 'POST',
      headers: { ...headers, 'Content-Type':'application/json', 'Prefer':'return=representation' },
      body: JSON.stringify(row),
    });
    const data = await r.json().catch(()=>null);
    return { ok: r.status >= 200 && r.status < 300, status: r.status, data };
  } catch { return { ok:false, status:0, data:null }; }
}

async function testUpdate(table, id, patch) {
  try {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/${table}?id=eq.${id}`, {
      method: 'PATCH',
      headers: { ...headers, 'Content-Type':'application/json' },
      body: JSON.stringify(patch),
    });
    return { ok: r.ok, status: r.status };
  } catch { return { ok:false, status:0 }; }
}

async function testDelete(table, id) {
  try { await fetch(`${SUPABASE_URL}/rest/v1/${table}?id=eq.${id}`, { method:'DELETE', headers }); } catch {}
}

async function fetchPage(path) {
  try {
    const r = await fetch(`${SITE_URL}/${path}`);
    const text = await r.text();
    return { ok: r.ok, status: r.status, text, size: text.length };
  } catch { return { ok:false, status:0, text:'', size:0 }; }
}

async function readLocalFile(path) {
  try {
    const fs = await import('fs').then(m=>m.promises);
    return await fs.readFile(path, 'utf8');
  } catch { return null; }
}

// ========== 批量檢查表存在 ==========
async function checkTables(tables) {
  for (const t of tables) {
    const e = await tableExists(t.name);
    if (e) {
      const q = await tableQuery(t.name, 'select=id&limit=3');
      log(PASS, 'DB', `${t.label} (${t.name})`, `存在${q.data?` (${q.data.length}筆)`:' (RLS限制)'}`, t.crit);
    } else {
      log(t.crit ? FAIL : WARN, 'DB', `${t.label} (${t.name})`, '表不存在', t.crit);
    }
  }
}

// ========== 主程式 ==========
async function main() {
  console.log(`\n${C.bold}  ╔══════════════════════════════════════════════╗`);
  console.log(`  ║   🏥 Propiston 系統健康檢查 v4.0              ║`);
  console.log(`  ║   完整版：DB+約束+RLS+頁面+功能+品質+FK+語法  ║`);
  console.log(`  ╚══════════════════════════════════════════════╝${C.reset}\n`);
  const start = Date.now();

  // =============================================
  //  1. DB 表存在（全 47 張分 6 區）
  // =============================================

  section('🗄️ DB：HR 核心 (17張)');
  await checkTables([
    { name:'companies',           crit:true,  label:'公司' },
    { name:'employees',           crit:true,  label:'員工' },
    { name:'attendance',          crit:true,  label:'打卡主表' },
    { name:'attendance_records',  crit:false, label:'考勤紀錄' },
    { name:'leave_requests',      crit:true,  label:'請假' },
    { name:'schedules',           crit:true,  label:'排班' },
    { name:'shift_types',         crit:true,  label:'班別定義' },
    { name:'system_settings',     crit:true,  label:'系統設定' },
    { name:'payroll',             crit:true,  label:'薪資主表' },
    { name:'payroll_records',     crit:false, label:'薪資紀錄' },
    { name:'salary_settings',     crit:true,  label:'薪資設定' },
    { name:'overtime_requests',   crit:false, label:'加班申請' },
    { name:'overtime_rules',      crit:false, label:'加班規則' },
    { name:'insurance_brackets',  crit:false, label:'勞健保級距' },
    { name:'annual_bonus',        crit:false, label:'年終獎金' },
    { name:'audit_logs',          crit:false, label:'操作日誌' },
    { name:'hr_audit_logs',       crit:false, label:'HR操作日誌' },
  ]);

  section('🍽️ DB：餐飲系統 (4張)');
  await checkTables([
    { name:'store_profiles',   crit:true, label:'商店' },
    { name:'menu_categories',  crit:true, label:'菜單分類' },
    { name:'menu_items',       crit:true, label:'菜單品項' },
    { name:'orders',           crit:true, label:'訂單' },
  ]);

  section('📅 DB：預約系統 (4張)');
  await checkTables([
    { name:'booking_settings',  crit:true, label:'預約設定' },
    { name:'booking_services',  crit:true, label:'預約服務' },
    { name:'booking_staff',     crit:true, label:'預約人員' },
    { name:'bookings',          crit:true, label:'預約紀錄' },
  ]);

  section('👥 DB：CRM / 集點 (4張)');
  await checkTables([
    { name:'store_customers',      crit:false, label:'客戶資料' },
    { name:'loyalty_config',       crit:false, label:'集點設定' },
    { name:'loyalty_points',       crit:false, label:'點數紀錄' },
    { name:'loyalty_transactions', crit:false, label:'集點交易' },
  ]);

  section('👷 DB：營運 / 外勤 (11張)');
  await checkTables([
    { name:'office_locations',      crit:false, label:'打卡地點' },
    { name:'lunch_orders',          crit:false, label:'午餐訂餐' },
    { name:'lunch_order_details',   crit:false, label:'午餐明細' },
    { name:'clients',               crit:false, label:'客戶/據點' },
    { name:'field_work_logs',       crit:false, label:'外勤日誌' },
    { name:'service_items',         crit:false, label:'服務項目' },
    { name:'sales_targets',         crit:false, label:'業績目標' },
    { name:'sales_activities',      crit:false, label:'業務活動' },
    { name:'shift_swap_requests',   crit:false, label:'換班申請' },
    { name:'shift_swaps',           crit:false, label:'換班紀錄' },
    { name:'makeup_punch_requests', crit:false, label:'補打卡' },
  ]);

  section('🔐 DB：平台 / 認證 (7張)');
  await checkTables([
    { name:'platform_admins',              crit:false, label:'平台管理員' },
    { name:'platform_admin_companies',     crit:false, label:'管理員-公司' },
    { name:'binding_attempts',             crit:false, label:'綁定嘗試' },
    { name:'binding_audit_log',            crit:false, label:'綁定日誌' },
    { name:'verification_codes',           crit:false, label:'驗證碼' },
    { name:'announcement_acknowledgments', crit:false, label:'公告已讀' },
    { name:'_migrations',                  crit:false, label:'Migration紀錄' },
  ]);

  // =============================================
  //  2. DB 約束檢查（用實際 INSERT 測試）
  // =============================================
  section('🔗 DB：約束與索引');

  const storeQ = await tableQuery('store_profiles', 'select=id&limit=1');
  const testStoreId = storeQ.data?.[0]?.id;

  // store_customers UNIQUE(store_id, phone)
  if (testStoreId) {
    const phone = `_hc_${Date.now()}`;
    const ins1 = await testInsert('store_customers', { store_id:testStoreId, phone, name:'_健檢' });
    if (ins1.ok) {
      const ins2 = await testInsert('store_customers', { store_id:testStoreId, phone, name:'_健檢2' });
      if (!ins2.ok) {
        log(PASS, '約束', 'store_customers UNIQUE(store_id,phone)', '重複被拒絕 ✓');
      } else {
        log(FAIL, '約束', 'store_customers UNIQUE(store_id,phone)', '重複插入成功！約束缺失', true);
        if (ins2.data?.[0]?.id) await testDelete('store_customers', ins2.data[0].id);
      }
      if (ins1.data?.[0]?.id) await testDelete('store_customers', ins1.data[0].id);
    } else {
      log(WARN, '約束', 'store_customers UNIQUE', `無法測試 (INSERT HTTP ${ins1.status})`);
    }
  }

  // employees UNIQUE(employee_number)
  const empQ = await tableQuery('employees', 'select=employee_number&limit=1');
  if (empQ.data?.[0]) {
    const dup = await testInsert('employees', { employee_number:empQ.data[0].employee_number, name:'_健檢', company_id:'00000000-0000-0000-0000-000000000000' });
    if (!dup.ok) {
      log(PASS, '約束', 'employees UNIQUE(employee_number)', '重複被拒絕 ✓');
    } else {
      log(FAIL, '約束', 'employees UNIQUE(employee_number)', '重複插入成功！', true);
      if (dup.data?.[0]?.id) await testDelete('employees', dup.data[0].id);
    }
  }

  // companies UNIQUE(code)
  const compQ = await tableQuery('companies', 'select=code&limit=1');
  if (compQ.data?.[0]) {
    const dup = await testInsert('companies', { code:compQ.data[0].code, name:'_健檢' });
    if (!dup.ok) {
      log(PASS, '約束', 'companies UNIQUE(code)', '重複被拒絕 ✓');
    } else {
      log(FAIL, '約束', 'companies UNIQUE(code)', '重複插入成功！', true);
      if (dup.data?.[0]?.id) await testDelete('companies', dup.data[0].id);
    }
  }

  // =============================================
  //  3. RLS 讀寫權限
  // =============================================
  section('🔒 RLS：讀取權限（anon SELECT）');

  const rlsReads = [
    ['store_profiles',  '商店',     true],
    ['menu_categories', '菜單分類', true],
    ['menu_items',      '菜單品項', true],
    ['orders',          '訂單',     true],
    ['store_customers', '客戶',     true],
    ['loyalty_config',  '集點設定', true],
    ['loyalty_points',  '點數',     true],
    ['companies',       '公司',     false],
    ['employees',       '員工',     false],
    ['system_settings', '系統設定', false],
    ['schedules',       '排班',     false],
    ['attendance',      '打卡',     false],
  ];
  for (const [t, label, required] of rlsReads) {
    const q = await tableQuery(t, 'select=id&limit=1');
    if (q.data !== null) {
      log(PASS, 'RLS', `${label} (${t}) SELECT`, 'anon 可讀 ✓');
    } else if (q.status === 0) {
      log(WARN, 'RLS', `${label} (${t}) SELECT`, '連線失敗');
    } else if (required) {
      log(FAIL, 'RLS', `${label} (${t}) SELECT`, `anon 無法讀取 (${q.status})，前端壞掉`, true);
    } else {
      log(INFO, 'RLS', `${label} (${t}) SELECT`, `anon 無法讀取 (${q.status})，HR表可接受`);
    }
  }

  section('🔒 RLS：寫入權限（anon INSERT/UPDATE）');

  if (testStoreId) {
    // orders INSERT
    const oi = await testInsert('orders', {
      store_id:testStoreId, order_number:`_hc_${Date.now()}`, customer_name:'_健檢',
      customer_phone:'0000000000', items:'[]', total:0, status:'cancelled',
      notes:'_健康檢查測試'
    });
    if (oi.ok) {
      log(PASS, 'RLS', 'orders INSERT', 'anon 可送出訂單 ✓', true);
      // orders UPDATE
      if (oi.data?.[0]?.id) {
        const ou = await testUpdate('orders', oi.data[0].id, { status:'cancelled' });
        log(ou.ok ? PASS : WARN, 'RLS', 'orders UPDATE', ou.ok ? 'anon 可更新狀態 ✓' : `HTTP ${ou.status}`);
        await testDelete('orders', oi.data[0].id);
      }
    } else {
      log(FAIL, 'RLS', 'orders INSERT', `anon 無法送出訂單 (${oi.status})，點餐壞掉！`, true);
    }

    // store_customers INSERT
    const ci = await testInsert('store_customers', { store_id:testStoreId, phone:`_hc_${Date.now()}`, name:'_健檢' });
    if (ci.ok) {
      log(PASS, 'RLS', 'store_customers INSERT', 'anon 可建客戶 ✓');
      if (ci.data?.[0]?.id) await testDelete('store_customers', ci.data[0].id);
    } else {
      log(WARN, 'RLS', 'store_customers INSERT', `anon 無法建客戶 (${ci.status})`);
    }

    // loyalty_points INSERT
    const lpi = await testInsert('loyalty_points', { store_id:testStoreId, customer_line_id:`_hc_${Date.now()}`, points:0 });
    if (lpi.ok) {
      log(PASS, 'RLS', 'loyalty_points INSERT', 'anon 可建點數 ✓');
      if (lpi.data?.[0]?.id) await testDelete('loyalty_points', lpi.data[0].id);
    } else {
      log(WARN, 'RLS', 'loyalty_points INSERT', `anon 無法建點數 (${lpi.status})`);
    }

    // loyalty_transactions INSERT
    const lti = await testInsert('loyalty_transactions', { store_id:testStoreId, customer_phone:'_hc', type:'earn', points:0 });
    if (lti.ok) {
      log(PASS, 'RLS', 'loyalty_transactions INSERT', 'anon 可建交易 ✓');
      if (lti.data?.[0]?.id) await testDelete('loyalty_transactions', lti.data[0].id);
    } else {
      log(WARN, 'RLS', 'loyalty_transactions INSERT', `anon 無法建交易 (${lti.status})`);
    }
  } else {
    log(SKIP, 'RLS', '寫入測試', '無商店資料');
  }

  // =============================================
  //  4. 餐飲資料品質
  // =============================================
  section('🍽️ 餐飲系統資料');

  const storeData = await tableQuery('store_profiles', 'select=id,store_name,store_slug,accept_orders,theme_color&limit=10');
  if (storeData.data?.length > 0) {
    log(PASS, '資料', '商店', `${storeData.data.length} 間`);
    storeData.data.forEach(s => console.log(`       ${C.gray}├─ ${s.store_name} (slug:${s.store_slug||'無'}) 接單:${s.accept_orders?'✓':'✗'}${C.reset}`));
  } else { log(WARN, '資料', '商店', '無'); }

  const catData = await tableQuery('menu_categories', 'select=id,name&order=sort_order&limit=20');
  log(catData.data?.length>0 ? PASS : WARN, '資料', '菜單分類', catData.data ? `${catData.data.length} 筆` : '無法讀取');

  const itemData = await tableQuery('menu_items', 'select=id,is_available&limit=100');
  if (itemData.data?.length>0) {
    const avail = itemData.data.filter(i=>i.is_available!==false).length;
    log(PASS, '資料', '菜單品項', `${itemData.data.length} 筆（上架:${avail} 下架:${itemData.data.length-avail}）`);
  } else { log(WARN, '資料', '菜單品項', '無品項'); }

  const since = new Date(); since.setDate(since.getDate()-7);
  const orderData = await tableQuery('orders', `select=id,status&created_at=gte.${since.toISOString()}&limit=100`);
  if (orderData.data) {
    const byS = {}; orderData.data.forEach(o=>{byS[o.status]=(byS[o.status]||0)+1;});
    log(PASS, '資料', '近7天訂單', `${orderData.data.length} 筆 (${Object.entries(byS).map(([k,v])=>`${k}:${v}`).join(' / ')||'無'})`);
  } else { log(WARN, '資料', '近7天訂單', '無法讀取'); }

  // 功能管理
  section('🎛️ 功能管理');
  const featQ = await tableQuery('system_settings', 'key=eq.feature_visibility&select=value');
  if (featQ.data?.[0]?.value) {
    const v = featQ.data[0].value;
    const on = Object.entries(v).filter(([,val])=>val).map(([k])=>k);
    const cnt = Object.keys(v).length;
    log(cnt>=8?PASS:WARN, '功能', 'feature_visibility', `${cnt} 項（開:${on.join(',')}）${cnt<8?' [目標≥8]':''}`);
  } else { log(WARN, '功能', 'feature_visibility', '未設定'); }

  const compData = await tableQuery('companies', 'select=name,industry&limit=5');
  if (compData.data) compData.data.forEach(c => {
    log(c.industry?PASS:WARN, '功能', `公司: ${c.name}`, `industry=${c.industry||'未設定'}`);
  });

  // =============================================
  //  5. 頁面載入 + 前端程式碼
  // =============================================
  section('📄 頁面載入 + 程式碼');

  const pageChecks = [
    { path:'index.html', checks:[
      { fn:'applyFeatureVisibility', min:1 },
      { pat:'data-feature="', label:'data-feature項目', min:8 },
    ]},
    { path:'order.html', checks:[
      { fn:'confirmPhone', min:3 },
      { fn:'onConfirmPhoneInput', min:2 },
      { fn:'loadConfirmMemberInfo', min:2 },
      { fn:'showMyOrdersPanel', min:3 },
      { fn:'myOrdersOverlay', min:2 },
      { fn:'headerOrderBtn', min:2 },
      { fn:'checkMyOrdersOnLoad', min:2 },
      { fn:'loadMyOrdersForPanel', min:2 },
      { fn:'renderMyOrderCard', min:2 },
      { fn:'loyaltyConfig', min:3 },
      { fn:'submitOrder', min:1 },
      { fn:'showOrderSuccess', min:1 },
    ]},
    { path:'admin.html', checks:[
      { fn:'switchPayTab', min:2 },
      { fn:'switchSysTab', min:2 },
      { pat:'id="bookingMgrPage"', label:'bookingMgrPage', min:1 },
      { pat:'id="memberMgrPage"', label:'memberMgrPage', min:1 },
      { pat:'data-feature="booking"', label:'data-feature=booking', min:1 },
      { pat:'data-feature="member"', label:'data-feature=member', min:1 },
      { pat:'class="menu-item"', label:'選單項目', min:10, max:16 },
    ]},
    { path:'checkin.html', checks:[] },
    { path:'schedule.html', checks:[] },
    { path:'salary.html', checks:[] },
    { path:'records.html', checks:[] },
    { path:'services.html', checks:[] },
    { path:'platform.html', checks:[] },
    { path:'common.js', checks:[
      { fn:'escapeHTML', min:5 },
      { fn:'getFeatureVisibility', min:1 },
      { fn:'applyFeatureVisibility', min:1 },
      { fn:'INDUSTRY_TEMPLATES', min:1 },
      { fn:'DEFAULT_FEATURES', min:1 },
    ]},
  ];

  let canFetch = true;

  for (const page of pageChecks) {
    let text = '';
    let source = '';

    // 嘗試遠端
    if (canFetch) {
      const pg = await fetchPage(page.path);
      if (pg.ok) {
        text = pg.text;
        source = `HTTP ${pg.status} (${(pg.size/1024).toFixed(0)}KB)`;
      } else if (pg.status === 0) {
        canFetch = false;
      }
    }

    // 回退本機
    if (!text) {
      const local = await readLocalFile(page.path);
      if (local) {
        text = local;
        source = `本機 (${(local.length/1024).toFixed(0)}KB)`;
      }
    }

    if (!text) {
      if (!canFetch) {
        log(SKIP, '頁面', page.path, '無法連外且本機不存在');
      } else {
        log(FAIL, '頁面', page.path, '無法載入', true);
      }
      continue;
    }

    log(PASS, '頁面', page.path, source);

    // 程式碼檢查
    for (const chk of page.checks) {
      const needle = chk.fn || chk.pat;
      const label = chk.fn || chk.label;
      const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const cnt = (text.match(new RegExp(escaped, 'g'))||[]).length;

      if (chk.max && cnt > chk.max) {
        log(WARN, '程式碼', `${page.path} → ${label}`, `${cnt} (目標≤${chk.max})`);
      } else if (cnt >= chk.min) {
        log(PASS, '程式碼', `${page.path} → ${label}`, `${cnt}`);
      } else {
        log(FAIL, '程式碼', `${page.path} → ${label}`, `${cnt} (需≥${chk.min})`, true);
      }
    }
  }

  // =============================================
  //  6. 端到端功能測試（API 層面）
  // =============================================
  section('🧪 功能測試：點餐流程');

  if (testStoreId) {
    // ① 載入菜單
    const menu = await tableQuery('menu_items', `store_id=eq.${testStoreId}&is_available=eq.true&select=id,name,price&limit=3`);
    log(menu.data?.length>0?PASS:FAIL, '流程', '① 載入菜單', menu.data?.length>0?`${menu.data.length}個品項`:'無品項', true);

    // ② 集點設定
    const lc = await tableQuery('loyalty_config', `store_id=eq.${testStoreId}&select=*&limit=1`);
    if (lc.data!==null) {
      log(PASS, '流程', '② 集點設定', lc.data.length>0?`$1=${lc.data[0].points_per_dollar}點, ${lc.data[0].points_to_redeem}點折$${lc.data[0].discount_amount}`:'未啟用（正常）');
    } else { log(WARN, '流程', '② 集點設定', '無法讀取'); }

    // ③ 送出訂單
    const item = menu.data?.[0] || { name:'測試', price:0 };
    const orderNum = `_HC_${Date.now()}`;
    const oi = await testInsert('orders', {
      store_id:testStoreId, order_number:orderNum,
      customer_name:'_健檢', customer_phone:'0900000000',
      items: JSON.stringify([{ id:item.id, name:item.name, qty:1, price:Number(item.price)||0 }]),
      total: Number(item.price)||0, status:'pending', order_type:'dine_in',
      notes:'_健康檢查，請忽略'
    });

    if (oi.ok) {
      log(PASS, '流程', '③ 送出訂單', `成功 (${orderNum})`);
      const oid = oi.data?.[0]?.id;

      // ④ 查詢我的訂單
      const myO = await tableQuery('orders', `store_id=eq.${testStoreId}&customer_phone=eq.0900000000&select=id,status&order=created_at.desc&limit=5`);
      log(myO.data?.length>0?PASS:FAIL, '流程', '④ 查我的訂單', myO.data?.length>0?`${myO.data.length}筆`:'查無', true);

      // ⑤ 建立客戶
      const ci = await testInsert('store_customers', { store_id:testStoreId, phone:'0900000000', name:'_健檢客戶', total_orders:1 });
      if (ci.ok) {
        log(PASS, '流程', '⑤ 自動建客戶', '成功');
        if (ci.data?.[0]?.id) await testDelete('store_customers', ci.data[0].id);
      } else if (String(ci.data?.code||'') === '23505') {
        log(PASS, '流程', '⑤ 客戶已存在', 'UNIQUE 約束正常');
      } else {
        log(WARN, '流程', '⑤ 建客戶', `HTTP ${ci.status}`);
      }

      // ⑥ 更新狀態
      if (oid) {
        const ou = await testUpdate('orders', oid, { status:'confirmed' });
        log(ou.ok?PASS:WARN, '流程', '⑥ 更新狀態', ou.ok?'pending→confirmed ✓':`HTTP ${ou.status}`);
        await testDelete('orders', oid);
      }
    } else {
      log(FAIL, '流程', '③ 送出訂單', `HTTP ${oi.status}`, true);
    }
  } else {
    log(SKIP, '流程', '點餐測試', '無商店');
  }

  section('🧪 功能測試：會員系統');
  if (testStoreId) {
    const cq = await tableQuery('store_customers', `store_id=eq.${testStoreId}&select=id,name,phone,total_orders&limit=3`);
    log(cq.data!==null?PASS:WARN, '功能', '客戶查詢', cq.data?`${cq.data.length}筆`:`HTTP ${cq.status}`);

    const pq = await tableQuery('loyalty_points', `store_id=eq.${testStoreId}&select=id,points&limit=3`);
    log(pq.data!==null?PASS:WARN, '功能', '點數查詢', pq.data?`${pq.data.length}筆`:`HTTP ${pq.status}`);
  }

  // =============================================
  //  7. 資料品質驗證
  // =============================================
  section('📊 資料品質');

  // 菜單品項：價格不能負數
  const badPrice = await tableQuery('menu_items', 'select=id,name,price&price=lt.0&limit=5');
  if (badPrice.data !== null) {
    log(badPrice.data.length===0?PASS:FAIL, '品質', '菜單價格≥0',
      badPrice.data.length===0?'全部正常':`${badPrice.data.length}筆負數: ${badPrice.data.map(i=>i.name).join(', ')}`, badPrice.data.length>0);
  }

  // 菜單品項：名稱不能空
  const noName = await tableQuery('menu_items', 'select=id,name&name=is.null&limit=5');
  if (noName.data !== null) {
    log(noName.data.length===0?PASS:WARN, '品質', '菜單名稱不為空', noName.data.length===0?'全部正常':`${noName.data.length}筆無名稱`);
  }

  // 訂單：items 必須是有效 JSON array
  const recentOrders = await tableQuery('orders', 'select=id,order_number,items,total,status&order=created_at.desc&limit=10');
  if (recentOrders.data?.length > 0) {
    let badItems = 0;
    let zeroTotal = 0;
    for (const o of recentOrders.data) {
      if (o.notes?.includes('_健康檢查') || o.order_number?.startsWith('_HC_')) continue; // 跳過測試訂單
      try {
        const items = typeof o.items === 'string' ? JSON.parse(o.items) : o.items;
        if (!Array.isArray(items) || items.length === 0) badItems++;
      } catch { badItems++; }
      if (Number(o.total) === 0 && o.status !== 'cancelled') zeroTotal++;
    }
    log(badItems===0?PASS:WARN, '品質', '訂單 items 格式', badItems===0?'全部有效':`${badItems}筆 items 無效`);
    log(zeroTotal===0?PASS:WARN, '品質', '非取消訂單金額>0', zeroTotal===0?'全部正常':`${zeroTotal}筆金額為 0`);
  }

  // 員工：必填欄位
  const empCheck = await tableQuery('employees', 'select=id,name,employee_number,company_id&limit=50');
  if (empCheck.data?.length > 0) {
    const noNum = empCheck.data.filter(e=>!e.employee_number).length;
    const noComp = empCheck.data.filter(e=>!e.company_id).length;
    log(noNum===0?PASS:FAIL, '品質', '員工有工號', noNum===0?`${empCheck.data.length}人全有`:`${noNum}人無工號`, noNum>0);
    log(noComp===0?PASS:FAIL, '品質', '員工有公司', noComp===0?'全部正常':`${noComp}人無 company_id`, noComp>0);
  }

  // store_profiles：slug 必須有
  const slugCheck = await tableQuery('store_profiles', 'select=id,store_name,store_slug&limit=10');
  if (slugCheck.data?.length > 0) {
    const noSlug = slugCheck.data.filter(s=>!s.store_slug).length;
    log(noSlug===0?PASS:WARN, '品質', '商店有 slug', noSlug===0?'全部正常':`${noSlug}間無 slug（點餐連結會壞）`);
  }

  // =============================================
  //  8. 外鍵完整性
  // =============================================
  section('🔗 外鍵完整性');

  // menu_items.store_id → store_profiles.id
  if (testStoreId && itemData.data?.length > 0) {
    const orphanItems = await tableQuery('menu_items', `store_id=not.in.(${slugCheck.data?.map(s=>s.id).join(',')})&select=id&limit=5`);
    if (orphanItems.data !== null) {
      log(orphanItems.data.length===0?PASS:WARN, 'FK', '品項→商店', orphanItems.data.length===0?'全部指向有效商店':`${orphanItems.data.length}筆孤兒品項`);
    }
  }

  // menu_items.category_id → menu_categories.id
  const orphanCat = await tableQuery('menu_items', 'category_id=is.null&select=id,name&limit=5');
  if (orphanCat.data !== null) {
    log(orphanCat.data.length===0?PASS:WARN, 'FK', '品項→分類', orphanCat.data.length===0?'全部有分類':`${orphanCat.data.length}筆無分類`);
  }

  // orders.store_id → store_profiles.id（取最近 20 筆）
  if (slugCheck.data?.length > 0) {
    const storeIdList = slugCheck.data.map(s=>s.id).join(',');
    const orphanOrders = await tableQuery('orders', `store_id=not.in.(${storeIdList})&select=id&limit=5`);
    if (orphanOrders.data !== null) {
      log(orphanOrders.data.length===0?PASS:WARN, 'FK', '訂單→商店', orphanOrders.data.length===0?'全部指向有效商店':`${orphanOrders.data.length}筆孤兒訂單`);
    }
  }

  // employees.company_id → companies.id
  if (compData.data?.length > 0) {
    const compIds = await tableQuery('companies', 'select=id');
    if (compIds.data) {
      const validIds = compIds.data.map(c=>c.id).join(',');
      const orphanEmp = await tableQuery('employees', `company_id=not.in.(${validIds})&select=id,name&limit=5`);
      if (orphanEmp.data !== null) {
        log(orphanEmp.data.length===0?PASS:WARN, 'FK', '員工→公司', orphanEmp.data.length===0?'全部指向有效公司':`${orphanEmp.data.length}筆孤兒員工`);
      }
    }
  }

  // =============================================
  //  9. 預約系統功能測試
  // =============================================
  section('🧪 功能測試：預約系統');

  if (testStoreId) {
    // 預約設定
    const bs = await tableQuery('booking_settings', `store_id=eq.${testStoreId}&select=*&limit=1`);
    if (bs.data !== null) {
      if (bs.data.length > 0) {
        const s = bs.data[0];
        log(PASS, '預約', '預約設定', `type=${s.booking_type}, ${s.slot_duration_minutes}分鐘/段, 提前${s.advance_booking_days}天`);

        // 營業時間
        const bh = s.business_hours || {};
        const daysOpen = Object.values(bh).filter(d=>d.enabled).length;
        log(daysOpen>0?PASS:WARN, '預約', '營業時間', `${daysOpen}/7 天開放`);
      } else {
        log(INFO, '預約', '預約設定', '此商店未啟用預約（正常）');
      }
    } else {
      log(WARN, '預約', '預約設定', `無法查詢 HTTP ${bs.status}`);
    }

    // 服務項目
    const svc = await tableQuery('booking_services', `store_id=eq.${testStoreId}&select=id,name,duration_minutes,is_active&limit=10`);
    if (svc.data !== null) {
      if (svc.data.length > 0) {
        const active = svc.data.filter(s=>s.is_active!==false).length;
        log(PASS, '預約', '服務項目', `${svc.data.length}個（啟用:${active}）`);
      } else {
        log(INFO, '預約', '服務項目', '尚未設定服務');
      }
    }

    // 可預約人員
    const staff = await tableQuery('booking_staff', `store_id=eq.${testStoreId}&select=id,display_name,is_active&limit=10`);
    if (staff.data !== null) {
      if (staff.data.length > 0) {
        log(PASS, '預約', '預約人員', `${staff.data.length}人`);
      } else {
        log(INFO, '預約', '預約人員', '尚未設定人員');
      }
    }

    // 預約 INSERT 測試
    const bi = await testInsert('bookings', {
      store_id: testStoreId,
      booking_number: `_HC_BK_${Date.now()}`,
      customer_name: '_健檢預約',
      customer_phone: '0900000000',
      booking_date: new Date().toISOString().split('T')[0],
      booking_time: '12:00',
      party_size: 2,
      status: 'cancelled',
      notes: '_健康檢查測試'
    });
    if (bi.ok) {
      log(PASS, '預約', '建立預約 INSERT', 'anon 可建立 ✓');
      if (bi.data?.[0]?.id) await testDelete('bookings', bi.data[0].id);
    } else {
      log(WARN, '預約', '建立預約 INSERT', `HTTP ${bi.status}（可能需要 RLS policy）`);
    }

    // 預約查詢
    const bq = await tableQuery('bookings', `store_id=eq.${testStoreId}&select=id,status,booking_date&order=created_at.desc&limit=5`);
    if (bq.data !== null) {
      log(PASS, '預約', '查詢預約', `${bq.data.length}筆`);
    } else {
      log(WARN, '預約', '查詢預約', `HTTP ${bq.status}`);
    }
  } else {
    log(SKIP, '預約', '預約測試', '無商店');
  }

  // =============================================
  //  10. JS 語法基本驗證
  // =============================================
  section('🔍 JS 語法檢查');

  // 檢查常見 JS 語法問題（在已取得的頁面內容中）
  const jsChecks = [
    { file: 'order.html', patterns: [
      { p: /function\s+\w+\s*\([^)]*\)\s*{/g, name: 'function 宣告', minCount: 20 },
      { p: /addEventListener/g, name: 'addEventListener', minCount: 1 },
      { p: /try\s*{/g, name: 'try-catch（錯誤處理）', minCount: 3 },
    ]},
    { file: 'common.js', patterns: [
      { p: /function\s+\w+/g, name: 'function 宣告', minCount: 5 },
      { p: /escapeHTML/g, name: 'escapeHTML（XSS防護）', minCount: 5 },
    ]},
  ];

  for (const jc of jsChecks) {
    // Try remote then local
    let text = '';
    if (canFetch) {
      const pg = await fetchPage(jc.file);
      if (pg.ok) text = pg.text;
    }
    if (!text) {
      const local = await readLocalFile(jc.file);
      if (local) text = local;
    }
    if (!text) { log(SKIP, 'JS', jc.file, '無法讀取'); continue; }

    for (const pat of jc.patterns) {
      const matches = text.match(pat.p) || [];
      log(matches.length >= pat.minCount ? PASS : WARN, 'JS',
        `${jc.file} → ${pat.name}`, `${matches.length}處${matches.length<pat.minCount?` (預期≥${pat.minCount})`:''}`);
    }

    // 檢查明顯語法錯誤
    const scriptBlocks = text.match(/<script[^>]*>([\s\S]*?)<\/script>/gi) || [text];
    let syntaxIssues = 0;
    const dangerPatterns = [
      { p: /\bconst\s+const\b/g, name: 'double const' },
      { p: /\bfunction\s+function\b/g, name: 'double function' },
      { p: /,\s*\)/g, name: 'trailing comma before )' },
      { p: /,\s*\]/g, name: 'trailing comma before ]' },
    ];
    for (const dp of dangerPatterns) {
      const found = text.match(dp.p);
      if (found) {
        syntaxIssues += found.length;
        log(WARN, 'JS', `${jc.file} → ${dp.name}`, `${found.length}處`);
      }
    }
    if (syntaxIssues === 0) {
      log(PASS, 'JS', `${jc.file} → 基本語法`, '未發現明顯問題');
    }
  }

  // =============================================
  //  11. 功能開關一致性
  // =============================================
  section('🎛️ 功能開關一致性');

  // 檢查 feature_visibility 和 companies.features 是否一致
  if (featQ.data?.[0]?.value && compData.data?.length > 0) {
    const platformFeats = featQ.data[0].value;
    for (const comp of compData.data) {
      // 查公司的 features
      const compDetail = await tableQuery('companies', `name=eq.${encodeURIComponent(comp.name)}&select=name,features,industry`);
      if (compDetail.data?.[0]?.features) {
        const cf = compDetail.data[0].features;
        // 平台關閉但公司開啟的功能 → 不一致（平台優先）
        const conflicts = Object.entries(cf).filter(([k,v]) => v && platformFeats[k] === false);
        if (conflicts.length > 0) {
          log(WARN, '一致性', `${comp.name} 功能衝突`, `平台關閉但公司開啟: ${conflicts.map(([k])=>k).join(', ')} → 以平台為準`);
        } else {
          log(PASS, '一致性', `${comp.name}`, '功能設定無衝突');
        }
      }
    }
  }

  // 檢查 store_profiles.accept_orders 和 feature_visibility.store_ordering 一致性
  if (featQ.data?.[0]?.value && slugCheck.data?.length > 0) {
    const storeOrdering = featQ.data[0].value.store_ordering;
    for (const store of slugCheck.data) {
      if (store.accept_orders && !storeOrdering) {
        log(WARN, '一致性', `商店 ${store.store_name}`, 'accept_orders=true 但平台 store_ordering=false');
      } else {
        log(PASS, '一致性', `商店 ${store.store_name} 接單設定`, storeOrdering ? 'accept_orders + store_ordering 一致' : '平台未開放接單（正常）');
      }
    }
  }

  // =============================================
  //  SUMMARY
  // =============================================
  const elapsed = ((Date.now()-start)/1000).toFixed(1);
  const score = total>0 ? Math.round(((pass+warn*0.5)/total)*100) : 0;
  const sc = score>=80?C.green:score>=50?C.yellow:C.red;

  console.log(`\n${C.bold}${'━'.repeat(50)}${C.reset}`);
  console.log(`${C.bold}  📊 健康檢查 v4.0 結果摘要${C.reset}`);
  console.log(`${C.bold}${'━'.repeat(50)}${C.reset}\n`);

  console.log(`  健康分數:  ${sc}${C.bold}${score}%${C.reset}`);
  console.log(`  檢查總數:  ${total}`);
  console.log(`  ${C.green}✅ 通過:    ${pass}${C.reset}`);
  console.log(`  ${C.yellow}⚠️  警告:    ${warn}${C.reset}`);
  console.log(`  ${C.red}❌ 失敗:    ${fail}${C.reset}`);
  console.log(`  ${C.blue}ℹ️  資訊:    ${info_c}${C.reset}`);
  if (skip_c>0) console.log(`  ${C.gray}⏭️  跳過:    ${skip_c}${C.reset}`);
  console.log(`  耗時:      ${elapsed}s`);

  // 分區
  console.log(`\n  ${C.bold}📋 分區:${C.reset}`);
  for (const [name,s] of Object.entries(sections)) {
    if (s.total===0) continue;
    const pct = Math.round(((s.pass+s.warn*0.5)/s.total)*100);
    const icon = s.fail>0?'❌':s.warn>0?'⚠️ ':'✅';
    console.log(`  ${icon} ${name}  ${pct}% (${s.pass}/${s.total})`);
  }

  if (criticals.length>0) {
    console.log(`\n  ${C.bgRed}${C.bold} 🚨 關鍵問題 (${criticals.length}) ${C.reset}`);
    criticals.forEach(f=>console.log(`  ${C.red}  → ${f}${C.reset}`));
  } else {
    console.log(`\n  ${C.bgGreen}${C.bold} 🎉 無關鍵問題！ ${C.reset}`);
  }

  if (todos.length>0) {
    console.log(`\n  ${C.bold}📋 待處理 (${todos.length}):${C.reset}`);
    todos.slice(0,25).forEach(t=>console.log(`  ${t.p} ${t.m}`));
    if (todos.length>25) console.log(`  ${C.gray}... 還有 ${todos.length-25} 項${C.reset}`);
  }

  console.log(`\n  ${C.bold}🖐️ 需手動測試（Node 無法自動化）:${C.reset}`);
  console.log(`  ${C.gray}  1. order.html → 點餐→輸手機→送出→查看我的訂單→Header按鈕${C.reset}`);
  console.log(`  ${C.gray}  2. admin.html → 選單≤15項 → 薪酬Tab → 系統設定Tab → 預約頁面 → 會員頁面${C.reset}`);
  console.log(`  ${C.gray}  3. index.html → 功能格 → 關閉功能後確認消失${C.reset}`);
  console.log(`  ${C.gray}  4. 手機版排版 → 手機/姓名上下排列 → 購物車正常${C.reset}`);
  console.log(`  ${C.gray}  5. LINE LIFF → 從LINE開啟 → 身分識別 → 出勤打卡${C.reset}`);
  console.log(`  ${C.gray}  6. 預約流程 → 選日期→選時段→填資訊→送出${C.reset}`);
  console.log(`  ${C.gray}  7. Console → 各頁開 F12 確認無紅色 JS 錯誤${C.reset}`);

  console.log(`\n${C.gray}━━━ ${new Date().toLocaleString()} ━━━${C.reset}\n`);
  process.exit(fail>0?1:0);
}

main().catch(e=>{console.error(`Fatal: ${e.message}`);process.exit(1);});
