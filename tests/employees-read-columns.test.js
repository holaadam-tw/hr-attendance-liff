#!/usr/bin/env node
// 產品檔掃描範圍：根目錄 HTML／JS 與 modules/*.js。
// 明確排除：tests、node_modules，以及非產品檔 e2e-test.js、health-check.js、
// health-check-v4.js、seed_benmi_console.js。
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const EXCLUDED_ROOT_FILES = new Set([
  'e2e-test.js',
  'health-check.js',
  'health-check-v4.js',
  'seed_benmi_console.js'
]);
const EXPECTED_COLUMNS = [
  'id', 'employee_number', 'name', 'department', 'position', 'join_date',
  'line_user_id', 'is_active', 'is_bound', 'bound_at', 'created_at',
  'updated_at', 'is_admin', 'company_id', 'role', 'hire_date',
  'employment_type', 'salary_type', 'status', 'resigned_date',
  'resign_reason', 'resign_note', 'shift_mode', 'fixed_shift_start',
  'fixed_shift_end', 'can_schedule', 'no_checkin', 'is_kiosk',
  'preferred_language', 'gps_relaxed', 'default_lunch'
];
const NOT_FRONTEND_READABLE = [
  'phone', 'email', 'emergency_contact', 'emergency_phone',
  'id_card_last_4', 'hourly_rate',
  'verify_code', 'id_last_four', 'device_info',
  'check_in_lat', 'check_in_lng', 'max_distance_meters'
];

let passed = 0;
let failed = 0;
function check(name, ok, detail = '') {
  ok ? passed++ : failed++;
  console.log(`  ${ok ? '✅' : '❌'} ${name}${detail ? ` → ${detail}` : ''}`);
}

function productFiles() {
  const rootFiles = fs.readdirSync(ROOT, { withFileTypes: true })
    .filter(entry => entry.isFile() && /\.(?:html|js)$/i.test(entry.name))
    .map(entry => entry.name)
    .filter(name => !EXCLUDED_ROOT_FILES.has(name));
  const moduleFiles = fs.readdirSync(path.join(ROOT, 'modules'), { withFileTypes: true })
    .filter(entry => entry.isFile() && entry.name.endsWith('.js'))
    .map(entry => path.join('modules', entry.name));
  return [...rootFiles, ...moduleFiles].sort();
}

function splitTopLevel(value) {
  const result = [];
  let start = 0;
  let depth = 0;
  for (let i = 0; i < value.length; i++) {
    if (value[i] === '(') depth++;
    else if (value[i] === ')') depth--;
    else if (value[i] === ',' && depth === 0) {
      result.push(value.slice(start, i).trim());
      start = i + 1;
    }
  }
  result.push(value.slice(start).trim());
  return result.filter(Boolean);
}

function readStringLiteral(source, quoteIndex) {
  const quote = source[quoteIndex];
  let escaped = false;
  for (let i = quoteIndex + 1; i < source.length; i++) {
    const ch = source[i];
    if (escaped) {
      escaped = false;
    } else if (ch === '\\') {
      escaped = true;
    } else if (ch === quote) {
      const value = source.slice(quoteIndex + 1, i);
      if (quote === '`' && value.includes('${')) return null;
      return { value, end: i + 1 };
    }
  }
  return null;
}

function readFirstArgument(source, openParenIndex) {
  let i = openParenIndex + 1;
  while (/\s/.test(source[i] || '')) i++;
  if (source[i] === ')') return { expression: '', end: i };
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
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') quote = ch;
    else if (ch === '(' || ch === '[' || ch === '{') depth++;
    else if (ch === ')' && depth === 0) return { expression: source.slice(start, i).trim(), end: i };
    else if (ch === ')' || ch === ']' || ch === '}') depth--;
    else if (ch === ',' && depth === 0) return { expression: source.slice(start, i).trim(), end: i };
  }
  return null;
}

function literalValue(expression) {
  const quote = expression[0];
  if (!['"', "'", '`'].includes(quote) || expression.at(-1) !== quote) return null;
  const body = expression.slice(1, -1);
  if (quote === '`' && body.includes('${')) return null;
  return body.replace(/\\([\\'"`])/g, '$1');
}

function selectedEmployeeColumns(selectValue) {
  const columns = [];
  for (const token of splitTopLevel(selectValue)) {
    if (token === '*') {
      columns.push('*');
      continue;
    }
    if (token.includes('(')) continue; // 其他關聯表，不是 employees 欄位。
    const column = token.includes(':') ? token.slice(token.lastIndexOf(':') + 1).trim() : token;
    columns.push(column);
  }
  return columns;
}

function embeddedEmployeesColumns(selectValue) {
  const groups = [];
  const relation = /(?:[A-Za-z_][A-Za-z0-9_]*:)?employees(?:![A-Za-z0-9_]+)*\s*\(/g;
  let match;
  while ((match = relation.exec(selectValue))) {
    const open = relation.lastIndex - 1;
    let depth = 1;
    let end = open + 1;
    for (; end < selectValue.length && depth > 0; end++) {
      if (selectValue[end] === '(') depth++;
      else if (selectValue[end] === ')') depth--;
    }
    if (depth !== 0) {
      groups.push({ label: match[0], columns: ['<unclosed>'] });
      break;
    }
    groups.push({
      label: match[0],
      columns: splitTopLevel(selectValue.slice(open + 1, end - 1)).map(token =>
        token.includes(':') ? token.slice(token.lastIndexOf(':') + 1).trim() : token.trim())
    });
    relation.lastIndex = end;
  }
  return groups;
}

const sharedColumnsSource = fs.readFileSync(path.join(ROOT, 'modules', 'employee-read-columns.js'), 'utf8');
const constantMatch = sharedColumnsSource.match(/const\s+EMPLOYEE_READ_COLUMNS\s*=\s*(['"`])([^'"`]+)\1\s*;/);
const actualColumns = constantMatch ? constantMatch[2].split(',').map(x => x.trim()).filter(Boolean) : [];
const allowed = new Set(actualColumns);

console.log('\n═══════════════════════════════════════');
console.log('  員工欄位明確讀取');
console.log('═══════════════════════════════════════');
check('EMPLOYEE_READ_COLUMNS 存在', Boolean(constantMatch));
check('EMPLOYEE_READ_COLUMNS 正好 31 欄', actualColumns.length === 31, `實際 ${actualColumns.length}`);
check('EMPLOYEE_READ_COLUMNS 無重複欄位', new Set(actualColumns).size === actualColumns.length);
check('EMPLOYEE_READ_COLUMNS 順序與允許清單一致',
  JSON.stringify(actualColumns) === JSON.stringify(EXPECTED_COLUMNS));
for (const column of NOT_FRONTEND_READABLE) {
  check(`${column} 不在前端可讀清單`, !allowed.has(column));
}

const files = productFiles();
const directProblems = [];
const embeddedProblems = [];
let directQueries = 0;
let embeddedRelations = 0;
for (const relative of files) {
  let source = fs.readFileSync(path.join(ROOT, relative), 'utf8');
  if (process.env.EMPLOYEE_READ_COLUMNS_MUTATION && relative === path.join('modules', 'employees.js')) {
    source += `\nasync function __mutation(sb) { return sb.from('employees').select('${process.env.EMPLOYEE_READ_COLUMNS_MUTATION}'); }\n`;
  }
  const fromEmployees = /\.from\(\s*(['"])employees\1\s*\)/g;
  let match;
  while ((match = fromEmployees.exec(source))) {
    directQueries++;
    const line = source.slice(0, match.index).split('\n').length;
    const after = source.slice(fromEmployees.lastIndex);
    const selectMatch = /^\s*\.select\s*\(/.exec(after);
    if (!selectMatch) {
      directProblems.push(`${relative}:${line} 缺少緊接的 select`);
      continue;
    }
    const open = fromEmployees.lastIndex + selectMatch.index + selectMatch[0].lastIndexOf('(');
    const arg = readFirstArgument(source, open);
    if (!arg || !arg.expression) {
      directProblems.push(`${relative}:${line} select 不可為空`);
      continue;
    }
    let selectValue;
    if (arg.expression === 'EMPLOYEE_READ_COLUMNS') {
      selectValue = actualColumns.join(',');
    } else {
      selectValue = literalValue(arg.expression);
    }
    if (selectValue === null) {
      directProblems.push(`${relative}:${line} select 必須是明確字串或 EMPLOYEE_READ_COLUMNS`);
      continue;
    }
    for (const column of selectedEmployeeColumns(selectValue)) {
      if (!allowed.has(column)) directProblems.push(`${relative}:${line} 欄位不在前端可讀清單：${column}`);
    }
  }

  const selectLiteral = /\.select\s*\(\s*(['"`])/g;
  while ((match = selectLiteral.exec(source))) {
    const quoteIndex = selectLiteral.lastIndex - 1;
    const literal = readStringLiteral(source, quoteIndex);
    if (!literal) continue;
    const line = source.slice(0, match.index).split('\n').length;
    for (const group of embeddedEmployeesColumns(literal.value)) {
      embeddedRelations++;
      for (const column of group.columns) {
        if (column === '*' || !allowed.has(column)) {
          embeddedProblems.push(`${relative}:${line} 嵌入欄位不在前端可讀清單：${column}`);
        }
      }
    }
    selectLiteral.lastIndex = literal.end;
  }
}

check(`掃描 ${files.length} 個產品檔`, files.length > 0, files.join(', '));
check(`${directQueries} 個 employees 直接查詢皆為明確欄位`, directProblems.length === 0,
  directProblems.join(' | '));
check(`${embeddedRelations} 個 employees 嵌入查詢皆為允許欄位`, embeddedProblems.length === 0,
  embeddedProblems.join(' | '));

console.log(`結果：✅ ${passed} 通過 ❌ ${failed} 失敗`);
process.exit(failed ? 1 : 0);
