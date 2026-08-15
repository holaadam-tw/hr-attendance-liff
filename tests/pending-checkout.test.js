// 今日上班卡待審時仍可下班：真實 common.js 狀態函式回歸測試
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const commonSrc = fs.readFileSync(path.join(root, 'common.js'), 'utf8');
const indexSrc = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
let pass = 0, fail = 0;

function check(name, condition, detail = '') {
  if (condition) { pass++; console.log(`  ✅ ${name}${detail ? `  → ${detail}` : ''}`); }
  else { fail++; console.log(`  ❌ ${name}${detail ? `  → ${detail}` : ''}`); }
}

function grab(source, name) {
  const start = source.indexOf('function ' + name + '(');
  if (start < 0) throw new Error('找不到函式：' + name);
  let depth = 0, opened = false;
  for (let i = start; i < source.length; i++) {
    if (source[i] === '{') { depth++; opened = true; }
    if (source[i] === '}' && --depth === 0 && opened) return source.slice(start, i + 1);
  }
  throw new Error('函式括號不完整：' + name);
}

const realFunctions = [
  grab(commonSrc, 'getTodayPendingPunchState'),
  grab(commonSrc, 'formatPendingPunchTime'),
  grab(commonSrc, 'getYesterdayMissingCheckoutReminderHtml'),
  grab(commonSrc, 'updateCheckInButtons')
].join('\n');

function runScenario(input = {}) {
  return new Function('input', `
    let todayPendingMakeups = input.pendingMakeups;
    let todayAttendance = input.attendance || null;
    const window = {
      _pendingCheckout: input.pendingCheckout || null,
      _yesterdayForgotCheckout: input.yesterdayForgot || null
    };
    const makeButton = () => {
      const classes = new Set();
      return { classes, classList: {
        add: value => classes.add(value),
        remove: value => classes.delete(value),
        contains: value => classes.has(value)
      }};
    };
    const btnIn = makeButton();
    const btnOut = makeButton();
    const statusBox = {};
    const document = { getElementById(id) {
      return id === 'checkInBtn' ? btnIn : id === 'checkOutBtn' ? btnOut : id === 'checkInStatusBox' ? statusBox : null;
    }};
    const localStorage = { getItem: () => '工廠' };
    const escapeHTML = value => String(value ?? '')
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#039;');
    const showStatus = (el, type, message, allowHtml) => { el.result = { type, message, allowHtml }; };
    ${realFunctions}
    updateCheckInButtons();
    return {
      inDisabled: btnIn.classes.has('disabled'),
      outDisabled: btnOut.classes.has('disabled'),
      status: statusBox.result || {},
      pending: getTodayPendingPunchState(input.pendingMakeups)
    };
  `)(input);
}

function pending(type, time = '08:27:00') {
  return { status: 'pending', punch_type: type, punch_time: time };
}

console.log('\n═══════════════════════════════════════');
console.log('  上班待審仍可下班回歸測試');
console.log('═══════════════════════════════════════');

const aliases = runScenario({ pendingMakeups: [pending('check_in'), pending('check_out', '17:03:00')] });
check('兼容 check_in 上班別名', aliases.pending.pendingIn?.punch_type === 'check_in');
check('兼容 check_out 下班別名', aliases.pending.pendingOut?.punch_type === 'check_out');

const pendingInOnly = runScenario({ pendingMakeups: [pending('clock_in')] });
check('上班待審時停用重複上班', pendingInOnly.inDisabled);
check('上班待審時開放下班', !pendingInOnly.outDisabled);
check('上班待審顯示可先打下班卡', pendingInOnly.status.message.includes('下班按鈕已開放') && pendingInOnly.status.message.includes('08:27'));

const pendingBoth = runScenario({ pendingMakeups: [pending('clock_in'), pending('clock_out', '17:05:00')] });
check('下班已待審時兩個按鈕都停用', pendingBoth.inDisabled && pendingBoth.outDisabled);
check('下班已待審提示不要重複打卡', pendingBoth.status.message.includes('請勿重複打卡') && pendingBoth.status.message.includes('17:05'));

const noAttendance = runScenario({ pendingMakeups: [] });
check('完全無上班資料時仍只開放上班', !noAttendance.inDisabled && noAttendance.outDisabled);

const loadFailed = runScenario({ pendingMakeups: null });
check('待審載入失敗時保守停用下班', !loadFailed.inDisabled && loadFailed.outDisabled);

const openAttendance = runScenario({
  pendingMakeups: [],
  attendance: { check_in_time: '2026-08-11T00:27:00Z', check_out_time: null, check_in_location: '工廠', total_work_hours: null }
});
check('正式上班紀錄維持既有可下班行為', openAttendance.inDisabled && !openAttendance.outDisabled);

const completedAttendance = runScenario({
  pendingMakeups: [],
  attendance: { check_in_time: '2026-08-11T00:27:00Z', check_out_time: '2026-08-11T09:05:00Z', total_work_hours: 8 }
});
check('已完成下班時兩個按鈕都停用', completedAttendance.inDisabled && completedAttendance.outDisabled);

const overnight = runScenario({
  pendingMakeups: [pending('clock_in')],
  pendingCheckout: { check_in_location: '夜班廠區' }
});
check('昨日跨日班維持最高優先', overnight.inDisabled && !overnight.outDisabled && overnight.status.message.includes('昨日上班中'));

const pendingInWithYesterday = runScenario({
  pendingMakeups: [pending('clock_in')],
  yesterdayForgot: { date: '2026-08-10' }
});
check('今日上班待審不被昨日漏卡關閉下班', pendingInWithYesterday.inDisabled && !pendingInWithYesterday.outDisabled);
check('同時保留昨日補打卡提醒', pendingInWithYesterday.status.message.includes('08/10 未打下班卡') && pendingInWithYesterday.status.message.includes('records.html#makeup'));

const loadPendingCode = grab(commonSrc, 'loadTodayPendingMakeups');
check('待審 RPC 帶目前公司範圍', loadPendingCode.includes('p_company_id: window.currentCompanyId || null'));
check('首頁狀態卡共用待審類型 helper', indexSrc.includes('window.getTodayPendingPunchState(pendingMakeups)'));

const commonRefs = fs.readdirSync(root)
  .filter(name => name.endsWith('.html'))
  .map(name => ({ name, src: fs.readFileSync(path.join(root, name), 'utf8') }))
  .filter(file => /<script\s+src="common\.js/.test(file.src));
const staleRefs = commonRefs.filter(file => !file.src.includes('common.js?v=20260815-makeupguidance'));
check('所有 common.js 引用已同步升版', staleRefs.length === 0, staleRefs.map(file => file.name).join(', '));

const stateCode = [
  grab(commonSrc, 'getTodayPendingPunchState'),
  grab(commonSrc, 'updateCheckInButtons')
].join('\n');
check('按鈕狀態判定不含資料庫寫入或打卡 RPC', !/sb\.|quick_check_in|insert\(|update\(|delete\(/i.test(stateCode));

console.log(`\n  結果：✅ ${pass} 通過  ❌ ${fail} 失敗\n`);
process.exit(fail ? 1 : 0);
