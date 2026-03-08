const SUPABASE_URL = 'https://nssuisyvlrqnqfxupklb.supabase.co';
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im5zc3Vpc3l2bHJxbnFmeHVwa2xiIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjkyOTAwMzUsImV4cCI6MjA4NDg2NjAzNX0.q_B6v3gf1TOCuAq7z0xIw10wDueCSJn0p37VzdMfmbc';

const C = { reset:'\x1b[0m', bold:'\x1b[1m', red:'\x1b[31m', green:'\x1b[32m', yellow:'\x1b[33m', blue:'\x1b[34m', cyan:'\x1b[36m', gray:'\x1b[90m', bgRed:'\x1b[41m', bgGreen:'\x1b[42m' };
const PASS = `${C.green}✅ PASS${C.reset}`;
const FAIL = `${C.red}❌ FAIL${C.reset}`;
const WARN = `${C.yellow}⚠️  WARN${C.reset}`;
const INFO = `${C.blue}ℹ️  INFO${C.reset}`;

let total=0, pass=0, fail=0, warn=0, criticals=[], todos=[];

function log(s,cat,name,detail,crit=false) {
  total++;
  if(s===PASS)pass++; else if(s===FAIL){fail++;if(crit)criticals.push(`${cat} > ${name}`);}else if(s===WARN)warn++;
  if(s===FAIL||s===WARN)todos.push({p:s===FAIL?'🔴':'🟡',m:`${name}: ${detail||''}`});
  const tag=crit?`${C.red}[CRITICAL]${C.reset} `:'';
  const det=detail?`${C.gray} → ${detail}${C.reset}`:'';
  console.log(`  ${s}  ${tag}${name}${det}`);
}

const headers = { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` };

// 用 HEAD 請求檢查表是否存在（即使 RLS 擋 SELECT，HEAD 仍會回 200）
// 如果表不存在會回 404 或 400
async function tableCheck(table) {
  try {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/${table}?limit=0`, {
      method: 'HEAD', headers
    });
    // 200 = 表存在（可能有資料也可能沒有）
    // 406 = 表存在但 Accept header 問題
    // 404 / 400 = 表不存在
    return r.status < 404;
  } catch {
    return false;
  }
}

// 嘗試讀取資料（可能被 RLS 擋）
async function tableQuery(table, params='') {
  try {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/${table}?${params}`, { headers });
    if (!r.ok) return { exists: r.status < 404, data: null, status: r.status };
    const d = await r.json();
    return { exists: true, data: d, status: r.status };
  } catch {
    return { exists: false, data: null, status: 0 };
  }
}

async function main() {
  console.log(`\n${C.bold}  ╔══════════════════════════════════════╗`);
  console.log(`  ║   🏥 Propiston 系統健康檢查 v2.0     ║`);
  console.log(`  ║   RLS-aware 版本                      ║`);
  console.log(`  ╚══════════════════════════════════════╝${C.reset}\n`);
  const start = Date.now();

  // ===== 1. DB: Core Tables =====
  console.log(`${C.bold}${C.cyan}━━━ 🗄️ 資料庫：核心 Tables ━━━${C.reset}`);

  const coreTables = [
    ['companies', true], ['employees', true], ['attendance_records', true],
    ['leave_requests', true], ['system_settings', true], ['store_profiles', true],
    ['menu_categories', false], ['menu_items', false], ['orders', true],
    ['payroll_records', false], ['schedules', false], ['audit_logs', false],
  ];

  for (const [t, crit] of coreTables) {
    const exists = await tableCheck(t);
    if (exists) {
      const q = await tableQuery(t, 'select=id&limit=5');
      if (q.data !== null) {
        log(PASS, 'DB', t, `存在，可讀取 (${q.data.length} 筆 sample)`, crit);
      } else {
        log(PASS, 'DB', t, `存在（RLS 限制讀取，正常）`, crit);
      }
    } else {
      log(FAIL, 'DB', t, '表不存在', crit);
    }
  }

  // ===== 2. DB: Booking Tables =====
  console.log(`\n${C.bold}${C.cyan}━━━ 📅 資料庫：預約系統 ━━━${C.reset}`);

  for (const t of ['booking_settings', 'booking_services', 'booking_staff', 'bookings']) {
    const exists = await tableCheck(t);
    if (exists) {
      const q = await tableQuery(t, 'select=id&limit=5');
      const count = q.data ? q.data.length : '?';
      log(PASS, '預約', t, `存在 (${count} 筆)`, true);
    } else {
      log(FAIL, '預約', t, '表不存在（需執行 booking migration）', true);
    }
  }

  // ===== 3. DB: CRM =====
  console.log(`\n${C.bold}${C.cyan}━━━ 👥 資料庫：CRM / 集點 ━━━${C.reset}`);

  for (const [t, label] of [
    ['store_customers', '客戶資料'], ['loyalty_config', '集點設定'],
    ['loyalty_points', '點數紀錄'], ['loyalty_transactions', '集點交易']
  ]) {
    const exists = await tableCheck(t);
    if (exists) {
      const q = await tableQuery(t, 'select=id&limit=5');
      log(PASS, 'CRM', `${label} (${t})`, `存在 (${q.data ? q.data.length : '?'} 筆)`);
    } else {
      log(WARN, 'CRM', `${label} (${t})`, '表不存在（需 migration）');
    }
  }

  // ===== 4. 餐飲系統資料 =====
  console.log(`\n${C.bold}${C.cyan}━━━ 🍽️ 餐飲系統資料 ━━━${C.reset}`);

  // store_profiles
  const storeQ = await tableQuery('store_profiles', 'select=id,store_name,store_slug&limit=10');
  if (storeQ.data && storeQ.data.length > 0) {
    log(PASS, '餐飲', '商店列表', `${storeQ.data.length} 間`);
    storeQ.data.forEach(s => console.log(`       ${C.gray}├─ ${s.store_name || s.store_slug || s.id}${C.reset}`));
  } else if (storeQ.data) {
    log(WARN, '餐飲', '商店列表', '0 間（需新增商店）');
  } else {
    log(WARN, '餐飲', '商店列表', 'RLS 限制讀取');
  }

  // menu data
  for (const [t, label] of [['menu_categories', '菜單分類'], ['menu_items', '菜單品項']]) {
    const q = await tableQuery(t, 'select=id&limit=50');
    if (q.data) {
      log(q.data.length > 0 ? PASS : WARN, '餐飲', label, `${q.data.length} 筆`);
    } else {
      log(WARN, '餐飲', label, 'RLS 限制讀取');
    }
  }

  // 近 7 天訂單
  const since = new Date(); since.setDate(since.getDate() - 7);
  const orderQ = await tableQuery('orders', `select=id,status&created_at=gte.${since.toISOString()}&order=created_at.desc&limit=50`);
  if (orderQ.data) {
    const byStatus = {};
    orderQ.data.forEach(o => { byStatus[o.status] = (byStatus[o.status] || 0) + 1; });
    const str = Object.entries(byStatus).map(([k, v]) => `${k}:${v}`).join(' / ');
    log(PASS, '餐飲', '近7天訂單', `${orderQ.data.length} 筆 (${str || '無'})`);
  } else {
    log(WARN, '餐飲', '近7天訂單', 'RLS 限制讀取');
  }

  // ===== 5. 功能管理 =====
  console.log(`\n${C.bold}${C.cyan}━━━ 🎛️ 功能管理 ━━━${C.reset}`);

  const featQ = await tableQuery('system_settings', 'key=eq.feature_visibility&select=value');
  if (featQ.data && featQ.data.length > 0 && featQ.data[0].value) {
    const v = featQ.data[0].value;
    const on = Object.entries(v).filter(([, val]) => val).map(([k]) => k);
    const off = Object.entries(v).filter(([, val]) => !val).map(([k]) => k);
    log(PASS, '功能', 'feature_visibility', `開:${on.join(',')} / 關:${off.join(',')}`);
  } else if (featQ.data) {
    log(WARN, '功能', 'feature_visibility', '未設定（使用預設值）');
  } else {
    log(WARN, '功能', 'feature_visibility', 'RLS 限制讀取');
  }

  const compQ = await tableQuery('companies', 'select=id,name,industry,features&limit=5');
  if (compQ.data && compQ.data.length > 0) {
    compQ.data.forEach(c => {
      log(c.industry ? PASS : WARN, '功能', `公司: ${c.name}`, `industry=${c.industry || '未設定'}`);
    });
  } else {
    log(WARN, '功能', 'companies 資料', 'RLS 限制或無資料');
  }

  // LINE Messaging API
  const notifyQ = await tableQuery('system_settings', 'key=eq.line_messaging_api&select=value');
  if (notifyQ.data && notifyQ.data.length > 0 && notifyQ.data[0].value?.token) {
    log(PASS, '功能', 'LINE Messaging API', '已設定');
  } else {
    log(INFO, '功能', 'LINE Messaging API', '未設定');
  }

  // ===== 6. 預約系統資料 =====
  console.log(`\n${C.bold}${C.cyan}━━━ 📅 預約系統資料 ━━━${C.reset}`);
  const bkSettQ = await tableQuery('booking_settings', 'select=store_id,booking_type,slot_duration_minutes&limit=10');
  if (bkSettQ.data && bkSettQ.data.length > 0) {
    bkSettQ.data.forEach(s => log(PASS, '預約', `設定 (${s.booking_type})`, `${s.slot_duration_minutes}分鐘`));
  } else if (bkSettQ.exists !== false) {
    log(INFO, '預約', '預約設定', '尚未有商店開啟預約');
  } else {
    log(WARN, '預約', '預約設定', '表不存在');
  }

  // ===== 7. RLS 政策檢查 =====
  console.log(`\n${C.bold}${C.cyan}━━━ 🔒 RLS 讀取權限測試 ━━━${C.reset}`);

  const rlsTables = [
    ['companies', 'companies（公司）'],
    ['employees', 'employees（員工）'],
    ['system_settings', 'system_settings（設定）'],
    ['store_profiles', 'store_profiles（商店）'],
    ['menu_categories', 'menu_categories（分類）'],
    ['menu_items', 'menu_items（品項）'],
    ['orders', 'orders（訂單）'],
  ];

  for (const [t, label] of rlsTables) {
    const q = await tableQuery(t, 'select=id&limit=1');
    if (q.data !== null) {
      log(PASS, 'RLS', label, `anon 可讀取 ✓`);
    } else if (q.status === 0) {
      log(WARN, 'RLS', label, `連線失敗`);
    } else {
      log(WARN, 'RLS', label, `anon 無法讀取 (HTTP ${q.status})，前端可能受影響`);
    }
  }

  // ===== Summary =====
  const elapsed = ((Date.now() - start) / 1000).toFixed(1);
  const score = total > 0 ? Math.round(((pass + warn * 0.5) / total) * 100) : 0;
  const sc = score >= 80 ? C.green : score >= 50 ? C.yellow : C.red;

  console.log(`\n${C.bold}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${C.reset}`);
  console.log(`${C.bold}  📊 檢測結果摘要${C.reset}`);
  console.log(`${C.bold}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${C.reset}\n`);
  console.log(`  健康分數:  ${sc}${C.bold}${score}%${C.reset}`);
  console.log(`  檢查總數:  ${total}`);
  console.log(`  ${C.green}✅ 通過:    ${pass}${C.reset}`);
  console.log(`  ${C.yellow}⚠️  警告:    ${warn}${C.reset}`);
  console.log(`  ${C.red}❌ 失敗:    ${fail}${C.reset}`);
  console.log(`  耗時:      ${elapsed}s`);

  if (criticals.length > 0) {
    console.log(`\n  ${C.bgRed}${C.bold} 🚨 關鍵問題 (${criticals.length}) ${C.reset}`);
    criticals.forEach(f => console.log(`  ${C.red}  → ${f}${C.reset}`));
  }

  if (criticals.length === 0 && fail === 0) {
    console.log(`\n  ${C.bgGreen}${C.bold} 🎉 無關鍵問題！ ${C.reset}`);
  }

  if (todos.length > 0) {
    console.log(`\n  ${C.bold}📋 待處理:${C.reset}`);
    todos.slice(0, 20).forEach(t => console.log(`  ${t.p} ${t.m}`));
  }

  // ===== 頁面檢查提示 =====
  console.log(`\n  ${C.bold}💡 頁面檢查提示:${C.reset}`);
  console.log(`  ${C.gray}此環境無法連外，請手動確認：${C.reset}`);
  console.log(`  ${C.gray}  https://holaadam-tw.github.io/index.html${C.reset}`);
  console.log(`  ${C.gray}  https://holaadam-tw.github.io/order.html${C.reset}`);
  console.log(`  ${C.gray}  https://holaadam-tw.github.io/admin.html${C.reset}`);
  console.log(`  ${C.gray}  https://holaadam-tw.github.io/booking.html${C.reset}`);

  console.log(`\n${C.gray}━━━ ${new Date().toLocaleString()} ━━━${C.reset}\n`);
}

main().catch(e => { console.error(`Fatal: ${e.message}`); process.exit(1); });
