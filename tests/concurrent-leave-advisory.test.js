// 同時請假警告門檻回歸測試（不連線、不寫 DB）
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const commonSrc = fs.readFileSync(path.join(root, 'common.js'), 'utf8');
const recordsSrc = fs.readFileSync(path.join(root, 'records.html'), 'utf8');
const adminSrc = fs.readFileSync(path.join(root, 'admin.html'), 'utf8');
const leaveModuleSrc = fs.readFileSync(path.join(root, 'modules', 'leave.js'), 'utf8');
const moduleIndexSrc = fs.readFileSync(path.join(root, 'modules', 'index.js'), 'utf8');

let pass = 0;
let fail = 0;
function check(name, condition, detail = '') {
  if (condition) {
    pass++;
    console.log(`  ✅ ${name}${detail ? `  → ${detail}` : ''}`);
  } else {
    fail++;
    console.log(`  ❌ ${name}${detail ? `  → ${detail}` : ''}`);
  }
}

function grabFunction(source, name) {
  const asyncStart = source.indexOf(`async function ${name}(`);
  const start = asyncStart >= 0 ? asyncStart : source.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`找不到函式：${name}`);
  let depth = 0;
  let opened = false;
  for (let i = start; i < source.length; i++) {
    if (source[i] === '{') { depth++; opened = true; }
    if (source[i] === '}' && opened && --depth === 0) return source.slice(start, i + 1);
  }
  throw new Error(`函式括號不完整：${name}`);
}

function createMockSb(leaves, totalCount = 10) {
  return {
    from(table) {
      if (table === 'leave_requests') {
        const chain = {
          select() { return chain; },
          eq() { return chain; },
          neq() { return chain; },
          in() { return chain; },
          or() { return chain; },
          limit() { return Promise.resolve({ data: leaves }); }
        };
        return chain;
      }
      if (table === 'employees') {
        let eqCount = 0;
        const chain = {
          select() { return chain; },
          eq() {
            eqCount++;
            return eqCount >= 2 ? Promise.resolve({ count: totalCount }) : chain;
          }
        };
        return chain;
      }
      throw new Error(`未預期的資料表：${table}`);
    }
  };
}

function buildAvailability(leaves, maxConcurrent) {
  const source = grabFunction(commonSrc, 'checkLeaveAvailability');
  const factory = new Function(
    'currentEmployee', 'sb', 'getCachedSetting', 'fmtDate', 'window', 'console',
    `${source}; return checkLeaveAvailability;`
  );
  return factory(
    { id: 'employee-self' },
    createMockSb(leaves),
    key => key === 'max_concurrent_leave' ? { max: maxConcurrent } : null,
    value => {
      const date = new Date(value);
      return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
    },
    { currentCompanyId: 'company-a' },
    { error() {}, warn() {} }
  );
}

const existingLeave = (id, name) => ({
  employee_id: id,
  start_date: '2026-09-01',
  end_date: '2026-09-01',
  status: 'pending',
  employees: { name, company_id: 'company-a' }
});

(async () => {
  console.log('\n═══════════════════════════════════════');
  console.log('  同時請假警告門檻回歸測試');
  console.log('═══════════════════════════════════════');

  const thirdApplicant = await buildAvailability([
    existingLeave('employee-1', '甲員工'),
    existingLeave('employee-2', '乙員工')
  ], 2)('2026-09-01', '2026-09-01');

  check('已有 2 人時第 3 人仍可送出', thirdApplicant.ok === true);
  check('第 3 人會被標記為超過警告門檻', thirdApplicant.thresholdExceeded === true);
  check('超額訊息明示仍可送出並由主管審核', /仍可送出，由主管審核/.test(thirdApplicant.message), thirdApplicant.message);
  check('預設門檻數值仍沿用公司設定 2 人', thirdApplicant.maxConcurrent === 2);

  const secondApplicant = await buildAvailability([
    existingLeave('employee-1', '甲員工')
  ], 2)('2026-09-01', '2026-09-01');
  check('計入後剛好 2 人不視為超額', secondApplicant.ok === true && secondApplicant.thresholdExceeded === false);

  const noConflicts = await buildAvailability([], 2)('2026-09-01', '2026-09-01');
  check('無衝突日期維持正常申請', noConflicts.ok === true && noConflicts.thresholdExceeded === false && noConflicts.conflicts.length === 0);

  const availabilitySrc = grabFunction(commonSrc, 'checkLeaveAvailability');
  const submitSrc = grabFunction(commonSrc, 'submitLeave');
  const dateChangeSrc = grabFunction(recordsSrc, 'onLeaveDateChange');
  check('衝突查詢仍以目前公司隔離', /eq\('employees\.company_id',\s*window\.currentCompanyId\)/.test(availabilitySrc));
  check('衝突查詢仍只計待審與已核准', /in\('status',\s*\['approved',\s*'pending'\]\)/.test(availabilitySrc));
  check('送出流程不再以 !check.ok 中止', !/if\s*\(\s*!check\.ok\s*\)/.test(submitSrc));
  check('送出仍使用既有 submit_leave_request RPC', /sb\.rpc\('submit_leave_request'/.test(submitSrc));
  check('超額日期畫面保持送出按鈕可用', /if\s*\(check\.thresholdExceeded\)[\s\S]*?btn\.disabled\s*=\s*false/.test(dateChangeSrc));
  check('合法日期檢查仍會暫時鎖按鈕等待結果', /檢查人力狀態[\s\S]*?btn\.disabled\s*=\s*true/.test(dateChangeSrc));
  check('錯誤日期與錯誤時數假仍維持硬性阻擋', /結束日期不能早於開始日期[\s\S]*?btn\.disabled\s*=\s*true/.test(dateChangeSrc) && /至少 1 小時[\s\S]*?btn\.disabled\s*=\s*true/.test(dateChangeSrc));
  check('管理端改稱同時請假警告門檻', /同時請假警告門檻/.test(adminSrc) && /同時請假警告門檻/.test(leaveModuleSrc));
  check('管理端不再宣稱自動駁回或表單鎖定', !/自動駁回|表單直接鎖定/.test(adminSrc + leaveModuleSrc));
  check('既有設定鍵保留以相容公司資料', /saveSetting\('max_concurrent_leave'/.test(leaveModuleSrc));
  check('管理月曆只在實際人數大於門檻時警告', /const over = dayCount\[ds\] > maxC/.test(leaveModuleSrc) && /const over = cnt > maxC/.test(leaveModuleSrc));
  check('管理模組快取版本已更新', /leave\.js\?v=20260901-linenotify/.test(moduleIndexSrc));

  const htmlFiles = fs.readdirSync(root).filter(name => name.endsWith('.html'));
  const commonRefs = htmlFiles
    .map(name => ({ name, src: fs.readFileSync(path.join(root, name), 'utf8') }))
    .filter(file => file.src.includes('common.js'));
  const staleRefs = commonRefs.filter(file => !file.src.includes('common.js?v=20260901-linenotify'));
  check('所有 common.js 引用已同步升版', staleRefs.length === 0, staleRefs.map(file => file.name).join(', '));

  console.log(`\n  結果：${pass} 通過，${fail} 失敗`);
  if (fail > 0) process.exit(1);
})().catch(error => {
  console.error('  ❌ 測試執行失敗', error);
  process.exit(1);
});
