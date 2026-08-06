// ============================================================
// 批次薪資設定的變更偵測與津貼保留測試
//
// 測的是 modules/payroll.js 裡真實的 collectSalarySettingChanges()：
// 用正規表示式把該函式原樣抽出來執行，不另抄一份被測邏輯。
//
// 執行：npm run test:salary-batch（或 npm test 一併跑）
//
// 為什麼要有這支（2026-08-06 查正式庫發現）：
//   後台「薪資設定（批次）」那頁只送「制度」與「金額」兩個欄位，其他津貼
//   一律被寫成 0。當時 Adam 有職務津貼 5,000＋全勤 2,000＋勞退自提 6%，
//   TA-004 有伙食津貼 2,400——只要有人按下那顆「全部儲存」，這些全部無聲消失。
//   而且它不分有沒有改動，一次把所有員工都重寫一遍，每按一次就替每個人長一筆
//   版本歷史，使用者也無從得知自己動到了誰。
//
//   修法：載入時記快照 → 儲存時只挑真的有變的 → 津貼原值帶回 RPC → 存檔前
//   跳確認框列出「誰、從什麼變成什麼」。
// ============================================================

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const SRC = process.env.PAYROLL_FILE || path.join(ROOT, 'modules', 'payroll.js');
const src = fs.readFileSync(SRC, 'utf8');

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  ✅ ' + name + (extra ? '  → ' + extra : '')); }
  else { fail++; console.log('  ❌ ' + name + (extra ? '  → ' + extra : '')); }
}

console.log('\n═══════════════════════════════════════');
console.log('  批次薪資設定測試');
console.log('═══════════════════════════════════════');

console.log('\n=== 1. 抽出真實程式碼 ===');
const grab = (name) => {
  const i = src.indexOf('function ' + name + '(');
  if (i < 0) throw new Error('找不到函式：' + name);
  let depth = 0, started = false;
  for (let j = i; j < src.length; j++) {
    if (src[j] === '{') { depth++; started = true; }
    else if (src[j] === '}') { depth--; if (started && depth === 0) return src.slice(i, j + 1); }
  }
  throw new Error('括號不對稱：' + name);
};
let collectSrc, labelSrc;
try {
  collectSrc = grab('collectSalarySettingChanges');
  labelSrc = src.match(/const SALARY_TYPE_LABEL = \{[^}]*\};[\s\S]*?const fmtSalary = [^;]*;/)[0];
  check('抽出 collectSalarySettingChanges 與格式化常數', true);
} catch (e) {
  check('抽出 collectSalarySettingChanges 與格式化常數', false, e.message);
  console.log('\n  結果：❌ 抽取失敗\n'); process.exit(1);
}

// ---- DOM 替身：只需要 querySelectorAll / querySelector ----
function buildDom(rows) {
  const t = (r) => (r.touched ? { touched: '1' } : {});
  const selects = rows.map(r => ({ dataset: Object.assign({ empId: r.empId, field: 'type' }, t(r)), value: r.uiType }));
  const inputs = rows.map(r => ({ dataset: Object.assign({ empId: r.empId, field: 'base' }, t(r)), value: String(r.uiBase) }));
  return {
    querySelectorAll: () => selects,
    querySelector: (sel) => {
      const m = /data-emp-id="([^"]+)"/.exec(sel);
      return inputs.find(i => i.dataset.empId === m[1]);
    }
  };
}

const run = (snapshot, rows) => {
  const fn = new Function('document', 'salarySettingSnapshot',
    labelSrc + '\n' + collectSrc + '\nreturn collectSalarySettingChanges();');
  return fn(buildDom(rows), snapshot);
};

// 有津貼的既有設定（正是 2026-08-06 之前 Adam 與 TA-004 的樣子）
const SNAP = {
  A: { name: 'Adam', hadSetting: true, type: 'monthly', base: 35000, meal: 0, pos: 5000, fab: 2000, pension: 6 },
  B: { name: '黃律瑋', hadSetting: true, type: 'hourly', base: 196, meal: 2400, pos: 0, fab: 0, pension: 0 },
  C: { name: '李銘坤', hadSetting: false, type: null, base: null, meal: 0, pos: 0, fab: 0, pension: 0 },
};

console.log('\n=== 2. 只寫有變更的那幾筆 ===');
let r = run(SNAP, [
  { empId: 'A', uiType: 'monthly', uiBase: 35000 },   // 沒改
  { empId: 'B', uiType: 'hourly', uiBase: 196 },      // 沒改
  { empId: 'C', uiType: 'hourly', uiBase: 196 },      // 本來無設定、畫面顯示預設佔位值
]);
check('三人都沒動 → 0 筆變更（不再每次重寫全部人）', r.changes.length === 0, r.changes.length + ' 筆');

r = run(SNAP, [
  { empId: 'A', uiType: 'monthly', uiBase: 35000 },
  { empId: 'B', uiType: 'monthly', uiBase: 30000 },   // 改制度＋金額
  { empId: 'C', uiType: 'hourly', uiBase: 196 },
]);
check('只有一人有動 → 只挑出那一筆', r.changes.length === 1 && r.changes[0].empId === 'B', r.changes.length + ' 筆');
check('未變更者不在清單內（Adam 不會被重寫）', !r.changes.some(c => c.empId === 'A'));

console.log('\n=== 3. 津貼必須原值帶回（本次修復的重點） ===');
const bChange = r.changes[0];
check('伙食津貼 2,400 保留', bChange.meal === 2400, String(bChange.meal));
check('職務／全勤／勞退自提一併帶回', bChange.pos === 0 && bChange.fab === 0 && bChange.pension === 0);

r = run(SNAP, [{ empId: 'A', uiType: 'monthly', uiBase: 40000 }]);
check('Adam 改底薪時，職務 5,000 不會被歸零', r.changes[0].pos === 5000, String(r.changes[0].pos));
check('Adam 改底薪時，全勤 2,000 不會被歸零', r.changes[0].fab === 2000, String(r.changes[0].fab));
check('Adam 改底薪時，勞退自提 6% 不會被歸零', r.changes[0].pension === 6, String(r.changes[0].pension));

console.log('\n=== 4. 沒有設定的人（預設佔位值不可自動變成正式資料） ===');
r = run(SNAP, [{ empId: 'C', uiType: 'hourly', uiBase: 196, touched: false }]);
check('沒動過 → 畫面上的時薪 196 只是佔位值，不建立設定', r.changes.length === 0, r.changes.length + ' 筆');
r = run(SNAP, [{ empId: 'C', uiType: 'monthly', uiBase: 30000, touched: true }]);
check('動過且有填金額 → 列為新增', r.changes.length === 1 && r.changes[0].before === '（無設定）', r.changes[0]?.before);
r = run(SNAP, [{ empId: 'C', uiType: 'hourly', uiBase: 196, touched: true }]);
check('動過但值剛好等於佔位值 → 仍要建立（使用者是真的想設 196）', r.changes.length === 1, r.changes.length + ' 筆');
r = run(SNAP, [{ empId: 'C', uiType: 'hourly', uiBase: '' }]);
check('本來無設定、金額留空 → 不寫入也不算失敗', r.changes.length === 0 && r.invalid.length === 0);

console.log('\n=== 5. 既有設定被清空金額 → 擋下 ===');
r = run(SNAP, [{ empId: 'A', uiType: 'monthly', uiBase: '' }]);
check('已有設定者金額留空 → 列入 invalid 並阻止儲存', r.invalid.length === 1 && r.invalid[0] === 'Adam', JSON.stringify(r.invalid));
check('invalid 時不產生變更', r.changes.length === 0);

console.log('\n=== 6. 確認框與旗標（靜態檢查） ===');
check('儲存前有 confirm 對話框', /if \(!confirm\(msg\)\) return;/.test(src));
check('確認框列出「從什麼變成什麼」', src.includes('c.before') && src.includes('c.after'));
check('確認框說明津貼維持原值', src.includes('維持原值不變'));
check('沒有變更時直接提示不寫入', src.includes("showToast('沒有任何變更')"));
check('RPC 呼叫有帶四個津貼參數',
  ['p_meal_allowance: c.meal', 'p_position_allowance: c.pos', 'p_full_attendance_bonus: c.fab', 'p_pension_self_rate: c.pension']
    .every(s => src.includes(s)));
check('存檔後重載清單以更新快照', src.includes('if (ok > 0) loadSalarySettingList();'));

console.log('\n═══════════════════════════════════════');
console.log('  結果：✅ ' + pass + ' 通過  ❌ ' + fail + ' 失敗');
console.log('═══════════════════════════════════════\n');
process.exit(fail > 0 ? 1 : 0);
