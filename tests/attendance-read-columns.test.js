#!/usr/bin/env node
// 權限收緊前置：掃描產品檔中的 attendance 直接與嵌入讀取。
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const EXCLUDED_ROOT_FILES = new Set([
  'e2e-test.js', 'health-check.js', 'health-check-v4.js', 'seed_benmi_console.js'
]);
const EXPECTED = [
  'id', 'employee_id', 'date', 'check_in_time', 'check_out_time',
  'check_in_location', 'check_out_location', 'total_work_hours', 'is_late',
  'notes', 'schedule_id', 'shift_type_id', 'overtime_hours', 'is_manual',
  'late_minutes', 'status', 'is_early_leave',
  'checkout_latitude', 'checkout_longitude'
];
// 非字面值或無參數 select 必須逐筆確認不會展開 attendance，再以「相對路徑:行」加入。
const DYNAMIC_SELECT_ALLOWLIST = new Set([
  'booking_service.html:642',
  'booking_service_admin.html:425',
  'fieldwork.html:651',
  'fieldwork.html:782',
  'fieldwork.html:900',
  'fieldwork.html:916',
  'fieldwork.html:1212',
  'fieldwork.html:1649',
  'fieldwork.html:1664',
  'kds.html:618',
  'loyalty.html:204',
  'loyalty_admin.html:389',
  'modules/auth.js:125',
  'modules/auth.js:164',
  'modules/auth.js:197',
  'modules/auth.js:365',
  'modules/employees.js:185',
  'modules/employees.js:984',
  'modules/store.js:522',
  'modules/store.js:1709',
  'modules/store.js:2757',
  'order.html:3260',
  'register.html:302'
]);

let passed = 0;
let failed = 0;
function check(name, ok, detail = '') {
  ok ? passed++ : failed++;
  console.log(`  ${ok ? '✅' : '❌'} ${name}${detail ? ` → ${detail}` : ''}`);
}
function productFiles() {
  const roots = fs.readdirSync(ROOT, { withFileTypes: true })
    .filter(e => e.isFile() && /\.(?:html|js)$/i.test(e.name) && !EXCLUDED_ROOT_FILES.has(e.name))
    .map(e => e.name);
  const modules = fs.readdirSync(path.join(ROOT, 'modules'), { withFileTypes: true })
    .filter(e => e.isFile() && e.name.endsWith('.js')).map(e => path.join('modules', e.name));
  return [...roots, ...modules].sort();
}
function splitTopLevel(value) {
  const out = [];
  let start = 0;
  let depth = 0;
  for (let i = 0; i < value.length; i++) {
    if (value[i] === '(') depth++;
    else if (value[i] === ')') depth--;
    else if (value[i] === ',' && depth === 0) { out.push(value.slice(start, i).trim()); start = i + 1; }
  }
  out.push(value.slice(start).trim());
  return out.filter(Boolean);
}
function firstArgument(source, open) {
  let i = open + 1;
  while (/\s/.test(source[i] || '')) i++;
  const start = i;
  let depth = 0;
  let quote = '';
  let escaped = false;
  for (; i < source.length; i++) {
    const ch = source[i];
    if (quote) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === quote) quote = '';
    } else if (`'\"\``.includes(ch)) quote = ch;
    else if ('([{'.includes(ch)) depth++;
    else if (ch === ')' && depth === 0 || ch === ',' && depth === 0) return source.slice(start, i).trim();
    else if (')]}'.includes(ch)) depth--;
  }
  return null;
}
function literal(expression) {
  if (!expression || !`'\"\``.includes(expression[0]) || expression.at(-1) !== expression[0]) return null;
  const body = expression.slice(1, -1);
  return expression[0] === '`' && body.includes('${') ? null : body;
}
function directColumns(value) {
  return splitTopLevel(value).filter(t => !t.includes('('))
    .map(t => t.includes(':') ? t.slice(t.lastIndexOf(':') + 1).trim() : t);
}
function embeddedAttendance(value) {
  const groups = [];
  const relation = /(?:[A-Za-z_]\w*:)?attendance(?:![A-Za-z0-9_]+)*\s*\(/g;
  let match;
  while ((match = relation.exec(value))) {
    const open = relation.lastIndex - 1;
    let depth = 1;
    let end = open + 1;
    for (; end < value.length && depth > 0; end++) {
      if (value[end] === '(') depth++;
      else if (value[end] === ')') depth--;
    }
    groups.push(depth ? ['<unclosed>'] : directColumns(value.slice(open + 1, end - 1)));
    relation.lastIndex = end;
  }
  return groups;
}

const shared = fs.readFileSync(path.join(ROOT, 'modules', 'attendance-read-columns.js'), 'utf8');
const constant = shared.match(/const\s+ATTENDANCE_READ_COLUMNS\s*=\s*(['"`])([^'"`]+)\1\s*;/);
const actual = constant ? constant[2].split(',').map(x => x.trim()).filter(Boolean) : [];
const allowed = new Set(actual);
const directProblems = [];
const embeddedProblems = [];
const dynamicSeen = new Set();
let directQueries = 0;
let embeddedRelations = 0;
const files = productFiles();
for (const relative of files) {
  const source = fs.readFileSync(path.join(ROOT, relative), 'utf8');
  const fromAttendance = /\.from\(\s*(['"`])attendance\1\s*\)/g;
  let match;
  while ((match = fromAttendance.exec(source))) {
    directQueries++;
    const line = source.slice(0, match.index).split('\n').length;
    const key = `${relative.replace(/\\/g, '/')}:${line}`;
    const after = source.slice(fromAttendance.lastIndex);
    const select = /^\s*\.select\s*\(/.exec(after);
    if (!select) { directProblems.push(`${key} 缺少緊接的 select`); continue; }
    const open = fromAttendance.lastIndex + select[0].lastIndexOf('(');
    const expression = firstArgument(source, open);
    const value = expression === 'ATTENDANCE_READ_COLUMNS' ? actual.join(',') : literal(expression);
    if (value === null) {
      dynamicSeen.add(key);
      if (!DYNAMIC_SELECT_ALLOWLIST.has(key)) directProblems.push(`${key} 動態 select 未列入 allowlist`);
      continue;
    }
    for (const column of directColumns(value)) {
      if (column === '*' || !allowed.has(column)) directProblems.push(`${key} 欄位不在清單：${column}`);
    }
  }
  const selects = /\.select\s*\(/g;
  while ((match = selects.exec(source))) {
    const open = match.index + match[0].lastIndexOf('(');
    const expression = firstArgument(source, open);
    const line = source.slice(0, match.index).split('\n').length;
    const key = `${relative.replace(/\\/g, '/')}:${line}`;
    const value = expression === 'ATTENDANCE_READ_COLUMNS' ? actual.join(',') : literal(expression);
    if (value === null) {
      dynamicSeen.add(key);
      continue;
    }
    for (const columns of embeddedAttendance(value)) {
      embeddedRelations++;
      for (const column of columns) if (column === '*' || !allowed.has(column)) {
        embeddedProblems.push(`${relative}:${line} 嵌入欄位不在清單：${column}`);
      }
    }
  }
}

console.log('\n═══════════════════════════════════════');
console.log('  出勤欄位明確讀取');
console.log('═══════════════════════════════════════');
check('ATTENDANCE_READ_COLUMNS 存在', Boolean(constant));
check('ATTENDANCE_READ_COLUMNS 正好 19 欄', actual.length === 19, `實際 ${actual.length}`);
check('ATTENDANCE_READ_COLUMNS 無重複欄位', new Set(actual).size === actual.length);
check('ATTENDANCE_READ_COLUMNS 順序與允許清單一致', JSON.stringify(actual) === JSON.stringify(EXPECTED));
check(`掃描 ${files.length} 個產品檔`, files.length > 0);
check(`${directQueries} 個 attendance 直接查詢皆為明確欄位`, directProblems.length === 0, directProblems.join(' | '));
check(`${embeddedRelations} 個 attendance 嵌入查詢皆為明確欄位`, embeddedProblems.length === 0, embeddedProblems.join(' | '));
check('動態 select allowlist 與實際讀點一致',
  [...DYNAMIC_SELECT_ALLOWLIST].every(x => dynamicSeen.has(x)) && [...dynamicSeen].every(x => DYNAMIC_SELECT_ALLOWLIST.has(x)),
  `allowlist=${[...DYNAMIC_SELECT_ALLOWLIST].join(',') || '無'}；實際=${[...dynamicSeen].join(',') || '無'}`);
console.log(`結果：✅ ${passed} 通過 ❌ ${failed} 失敗`);
process.exit(failed ? 1 : 0);
