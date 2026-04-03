#!/usr/bin/env node
/**
 * RunPiston 冒煙測試
 * 用法：node tests/smoke-test.js
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const SUPABASE_URL = 'https://nssuisyvlrqnqfxupklb.supabase.co';
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im5zc3Vpc3l2bHJxbnFmeHVwa2xiIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjkyOTAwMzUsImV4cCI6MjA4NDg2NjAzNX0.q_B6v3gf1TOCuAq7z0xIw10wDueCSJn0p37VzdMfmbc';
const HEADERS = {
  'apikey': SUPABASE_KEY,
  'Authorization': 'Bearer ' + SUPABASE_KEY,
  'Content-Type': 'application/json',
};

let passed = 0;
let failed = 0;

function ok(name) { passed++; console.log(`  ✅ ${name}`); }
function fail(name, reason) { failed++; console.log(`  ❌ ${name} — ${reason}`); }

// ─── 取得所有 HTML 檔案（排除 node_modules） ───
function getHtmlFiles() {
  return fs.readdirSync(ROOT)
    .filter(f => f.endsWith('.html'))
    .map(f => path.join(ROOT, f));
}

// ═══════════════════════════════════════════
// 1. Supabase 連線測試
// ═══════════════════════════════════════════
async function testSupabaseConnection() {
  console.log('\n📡 1. Supabase 連線測試');
  try {
    const res = await fetch(SUPABASE_URL + '/rest/v1/companies?limit=1', { headers: HEADERS });
    if (res.ok) {
      const data = await res.json();
      ok(`連線成功，companies 表可讀取（${data.length} 筆）`);
    } else {
      fail('連線失敗', `HTTP ${res.status}`);
    }
  } catch (e) {
    fail('連線失敗', e.message);
  }

  // 測試多張核心表
  const tables = ['employees', 'system_settings', 'store_profiles'];
  for (const t of tables) {
    try {
      const res = await fetch(SUPABASE_URL + `/rest/v1/${t}?limit=0`, { method: 'HEAD', headers: HEADERS });
      if (res.ok) ok(`${t} 表可存取`);
      else fail(`${t} 表存取失敗`, `HTTP ${res.status}`);
    } catch (e) {
      fail(`${t} 表存取失敗`, e.message);
    }
  }
}

// ═══════════════════════════════════════════
// 2. HTML 語法檢查（未關閉 tag）
// ═══════════════════════════════════════════
function testHtmlSyntax() {
  console.log('\n📄 2. HTML 語法檢查');
  const selfClosing = new Set([
    'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input',
    'link', 'meta', 'param', 'source', 'track', 'wbr',
  ]);

  for (const file of getHtmlFiles()) {
    const name = path.basename(file);
    const html = fs.readFileSync(file, 'utf-8');

    // 移除 HTML 註解、<script>...</script> 內容、<style>...</style> 內容
    const cleaned = html
      .replace(/<!--[\s\S]*?-->/g, '')
      .replace(/<script[\s\S]*?<\/script>/gi, '<script></script>')
      .replace(/<style[\s\S]*?<\/style>/gi, '<style></style>');

    const tagRegex = /<\/?([a-zA-Z][a-zA-Z0-9]*)[^>]*?\/?>/g;
    const stack = [];
    let match;
    let errors = [];

    while ((match = tagRegex.exec(cleaned)) !== null) {
      const full = match[0];
      const tag = match[1].toLowerCase();

      if (selfClosing.has(tag)) continue;
      if (full.endsWith('/>')) continue;                 // self-closing XML style
      if (full.startsWith('<!')) continue;               // doctype

      if (full.startsWith('</')) {
        // 關閉 tag
        if (stack.length > 0 && stack[stack.length - 1] === tag) {
          stack.pop();
        } else {
          // 嘗試往回找配對（容忍小錯）
          const idx = stack.lastIndexOf(tag);
          if (idx !== -1) {
            const unclosed = stack.splice(idx);
            unclosed.pop(); // 移除配對的那個
            for (const u of unclosed) {
              errors.push(`<${u}> 未關閉`);
            }
          } else {
            errors.push(`</${tag}> 多餘的關閉標籤`);
          }
        }
      } else {
        stack.push(tag);
      }
    }

    // 忽略常見的 html/body/head（瀏覽器會自動補）
    const remaining = stack.filter(t => !['html', 'head', 'body'].includes(t));
    for (const t of remaining) {
      errors.push(`<${t}> 未關閉`);
    }

    if (errors.length === 0) {
      ok(name);
    } else {
      // 只報前 3 個錯誤
      fail(name, errors.slice(0, 3).join(', ') + (errors.length > 3 ? ` ...共 ${errors.length} 個問題` : ''));
    }
  }
}

// ═══════════════════════════════════════════
// 3. error_logs 表寫入測試
// ═══════════════════════════════════════════
async function testErrorLogs() {
  console.log('\n📝 3. error_logs 寫入測試');
  const testMsg = '__smoke_test_' + Date.now();
  try {
    // 寫入
    const writeRes = await fetch(SUPABASE_URL + '/rest/v1/error_logs', {
      method: 'POST',
      headers: { ...HEADERS, 'Prefer': 'return=representation' },
      body: JSON.stringify({
        message: testMsg,
        page: '/tests/smoke-test',
        line: 0,
        user_id: null,
        user_agent: 'smoke-test/1.0',
      }),
    });

    if (!writeRes.ok) {
      const errText = await writeRes.text();
      fail('寫入失敗', `HTTP ${writeRes.status}: ${errText}`);
      return;
    }

    const rows = await writeRes.json();
    if (!rows || rows.length === 0) {
      fail('寫入失敗', '未回傳資料');
      return;
    }
    ok('寫入成功');

    // 刪除
    const id = rows[0].id;
    const delRes = await fetch(SUPABASE_URL + `/rest/v1/error_logs?id=eq.${id}`, {
      method: 'DELETE',
      headers: HEADERS,
    });
    if (delRes.ok || delRes.status === 204) {
      ok('測試資料已清除');
    } else {
      fail('測試資料清除失敗', `HTTP ${delRes.status}`);
    }
  } catch (e) {
    fail('寫入測試異常', e.message);
  }
}

// ═══════════════════════════════════════════
// 4. Supabase config 一致性
// ═══════════════════════════════════════════
function testConfigConsistency() {
  console.log('\n🔑 4. Supabase config 一致性');
  const urlPattern = /https:\/\/[a-z]+\.supabase\.co/g;
  const keyPattern = /eyJhbGciOi[A-Za-z0-9_\-]+\.[A-Za-z0-9_\-]+\.[A-Za-z0-9_\-]+/g;

  const files = getHtmlFiles();
  // 也檢查 common.js
  files.push(path.join(ROOT, 'common.js'));

  const allUrls = new Set();
  const allKeys = new Set();
  const fileDetails = [];

  for (const file of files) {
    const name = path.basename(file);
    const content = fs.readFileSync(file, 'utf-8');
    const urls = content.match(urlPattern) || [];
    const keys = content.match(keyPattern) || [];

    urls.forEach(u => allUrls.add(u));
    keys.forEach(k => allKeys.add(k));

    if (urls.length > 0 || keys.length > 0) {
      fileDetails.push({ name, urls: [...new Set(urls)], keys: keys.length });
    }
  }

  if (allUrls.size === 1) {
    ok(`所有檔案使用同一個 SUPABASE_URL: ${[...allUrls][0]}`);
  } else if (allUrls.size === 0) {
    fail('未找到任何 SUPABASE_URL', '');
  } else {
    fail('SUPABASE_URL 不一致', [...allUrls].join(' vs '));
  }

  if (allKeys.size === 1) {
    ok('所有檔案使用同一組 ANON_KEY');
  } else if (allKeys.size === 0) {
    fail('未找到任何 ANON_KEY', '');
  } else {
    fail('ANON_KEY 不一致', `發現 ${allKeys.size} 組不同的 key`);
  }

  // 顯示哪些檔案有 Supabase config
  console.log(`    📎 含 Supabase 設定的檔案：${fileDetails.map(f => f.name).join(', ')}`);
}

// ═══════════════════════════════════════════
// 5. common.js 共用函數存在性
// ═══════════════════════════════════════════
function testCommonFunctions() {
  console.log('\n🔧 5. common.js 共用函數存在性');
  const commonJs = fs.readFileSync(path.join(ROOT, 'common.js'), 'utf-8');

  const requiredFunctions = [
    'initializeLiff',
    'checkUserStatus',
    'loadSettings',
    'invalidateSettingsCache',
    'getCachedSetting',
    'saveSetting',
    'showToast',
    'showStatus',
    'escapeHTML',
    'friendlyError',
    'getTaiwanDate',
    'calculateDistance',
    'getGPS',
    'preloadGPS',
    'sendLineMessage',
    'sendAdminNotify',
    'setBtnLoading',
    'formatNT',
    'populateYearSelect',
    'initCompanySettings',
  ];

  for (const fn of requiredFunctions) {
    // 匹配 function fn( 或 async function fn(
    const pattern = new RegExp(`(async\\s+)?function\\s+${fn}\\s*\\(`);
    if (pattern.test(commonJs)) {
      ok(fn);
    } else {
      fail(fn, '函數未定義');
    }
  }
}

// ═══════════════════════════════════════════
// 主程式
// ═══════════════════════════════════════════
async function main() {
  console.log('═══════════════════════════════════════');
  console.log('  RunPiston 冒煙測試');
  console.log('═══════════════════════════════════════');

  await testSupabaseConnection();
  testHtmlSyntax();
  await testErrorLogs();
  testConfigConsistency();
  testCommonFunctions();

  console.log('\n═══════════════════════════════════════');
  console.log(`  結果：✅ ${passed} 通過  ❌ ${failed} 失敗`);
  console.log('═══════════════════════════════════════\n');

  process.exit(failed > 0 ? 1 : 0);
}

main();
