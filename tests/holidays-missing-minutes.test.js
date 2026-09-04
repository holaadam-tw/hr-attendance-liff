// 118 公司假日納入計算 ＋ 缺時通知門檻 ＋ 月統計缺工分鐘 回歸測試（不連線、不寫 DB）
//
// 反向對照：PAYROLL_FILE / AO_FILE / MIGRATION118_FILE 環境變數可指向改壞的副本。
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const payrollSrc = fs.readFileSync(process.env.PAYROLL_FILE || path.join(root, 'modules', 'payroll.js'), 'utf8');
const aoSrc = fs.readFileSync(process.env.AO_FILE || path.join(root, 'attendance_overview.html'), 'utf8');
const publicSrc = fs.readFileSync(path.join(root, 'attendance_public.html'), 'utf8');
const m118 = fs.readFileSync(process.env.MIGRATION118_FILE || path.join(root, 'migrations', '118_company_holidays_and_missing_minutes.sql'), 'utf8');
const m118Code = m118.split('\n').filter(l => !/^\s*--/.test(l)).join('\n');

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
function sqlFn(name) {
  const re = new RegExp('CREATE OR REPLACE FUNCTION public\\.' + name + '\\([\\s\\S]*?\\n\\$(?:\\$|function\\$);', 'm');
  const m = m118.match(re);
  return m ? m[0] : '';
}

console.log('\n=== payroll.js computeEmployeeExpectedDays（假日排除） ===');
let calc = null;
try { calc = new Function(`${grab(payrollSrc, 'computeEmployeeExpectedDays')}; return computeEmployeeExpectedDays;`)(); }
catch (e) { check('抽得出 computeEmployeeExpectedDays', false, e.message); }
if (calc) {
  // 2026-02：平日 20 天；春節 2/16~2/20（5 個平日）＋ 2/27 補假 → 應出勤 14
  const feb = new Set(['2026-02-15', '2026-02-16', '2026-02-17', '2026-02-18', '2026-02-19', '2026-02-20', '2026-02-27', '2026-02-28']);
  check('2026-02 無假日集合 → 20 個平日', calc('e1', '2026-02-01', '2026-02-28', {}) === 20, String(calc('e1', '2026-02-01', '2026-02-28', {})));
  check('2026-02 含春節假日 → 14', calc('e1', '2026-02-01', '2026-02-28', {}, feb) === 14, String(calc('e1', '2026-02-01', '2026-02-28', {}, feb)));
  check('假日集合非 Set 時當作無假日（不爆）', calc('e1', '2026-02-01', '2026-02-28', {}, ['2026-02-16']) === 20);
  check('週末的假日不重複扣（2/15、2/28 本來就不算）', calc('e1', '2026-02-14', '2026-02-15', {}, feb) === 0);
  const sched = { e1: { '2026-02-16': { is_off_day: false } } };
  check('假日有排班（非排休）→ 排班優先算應出勤', calc('e1', '2026-02-16', '2026-02-16', sched, feb) === 1);
  const schedOff = { e1: { '2026-02-23': { is_off_day: true } } };
  check('平日排休 → 不算', calc('e1', '2026-02-23', '2026-02-23', schedOff, feb) === 0);
  check('2026-05-01 勞動節（五）→ 0', calc('e1', '2026-05-01', '2026-05-01', {}, new Set(['2026-05-01'])) === 0);
  check('2026-09-25 中秋＋9/28 教師節 → 9/21~9/30 應出勤 6', calc('e1', '2026-09-21', '2026-09-30', {}, new Set(['2026-09-25', '2026-09-28'])) === 6);
}
const loadSrc = (() => { try { return grab(payrollSrc, 'loadCompanyHolidaySet'); } catch (e) { return ''; } })();
check('loadCompanyHolidaySet 走 get_company_holidays RPC', /rpc\('get_company_holidays'/.test(loadSrc));
check('RPC 失敗回空 Set（不擋頁面）', /return new Set\(\)/.test(loadSrc));
check('稽核報表把假日集合傳進應出勤', /computeEmployeeExpectedDays\(emp\.id, startDate, effEnd, schedMap, auditHolidaySet\)/.test(payrollSrc));
check('薪資計算把假日集合傳進應出勤', /computeEmployeeExpectedDays\(emp\.id, startDate, effectiveEndDate, schedMap, payrollHolidaySet\)/.test(payrollSrc));

console.log('\n=== attendance_overview.html 月統計缺工分鐘 ===');
check('表頭有 遲到分／早退分／缺工分', /遲到分<\/th>/.test(aoSrc) && /早退分<\/th>/.test(aoSrc) && /缺工分<\/th>/.test(aoSrc));
check('載入 get_company_monthly_missing_minutes', /rpc\('get_company_monthly_missing_minutes'/.test(aoSrc));
check('RPC 失敗不擋主表', /\.catch\(e => \(\{ data: null, error: e \}\)\)/.test(aoSrc));
check('colspan 全部改 12', !/colspan="9"/.test(aoSrc) && (aoSrc.match(/colspan="12"/g) || []).length >= 4);
let fmt = null;
try { fmt = new Function(`${grab(aoSrc, 'fmtMinutesCell')}; return fmtMinutesCell;`)(); } catch (e) { check('抽得出 fmtMinutesCell', false, e.message); }
if (fmt) {
  check('null → --', /--/.test(fmt(null, '#000')));
  check('0 → 0 灰字', /">0<\/td>/.test(fmt(0, '#000')) && /#94A3B8/.test(fmt(0, '#000')));
  check('45 → 45分', /45分/.test(fmt(45, '#EA580C')));
  check('135 → 2h15', /2h15/.test(fmt(135, '#EA580C')));
}
let bm = null;
try { bm = new Function(`${grab(aoSrc, 'buildMonthlyMissingMap')}; return buildMonthlyMissingMap;`)(); } catch (e) { check('抽得出 buildMonthlyMissingMap', false, e.message); }
if (bm) {
  const map = bm([{ employee_id: 'a', late_minutes: '12', early_minutes: null, missing_minutes: 12, full_absence_days: 0 }, null]);
  check('map 轉型正確', map.a && map.a.late_minutes === 12 && map.a.early_minutes === 0 && map.a.missing_minutes === 12);
  check('null 輸入 → 空 map', Object.keys(bm(null)).length === 0);
}
check('匯出含三個分鐘欄', /'遲到分鐘'/.test(aoSrc) && /'早退分鐘'/.test(aoSrc) && /'缺工分鐘'/.test(aoSrc));

console.log('\n=== attendance_public.html 假日改走 RPC ===');
check('不再直接 select holidays', !/from\('holidays'\)/.test(publicSrc));
check('改用 get_company_holidays', /rpc\('get_company_holidays'/.test(publicSrc));

console.log('\n=== migration 118：holidays 表 ===');
check('date→holiday_date 冪等改名', /RENAME COLUMN date TO holiday_date/.test(m118Code) && /column_name = 'date'/.test(m118Code));
check('name→holiday_name 冪等改名', /RENAME COLUMN name TO holiday_name/.test(m118Code));
check('加 company_id', /ADD COLUMN IF NOT EXISTS company_id UUID REFERENCES public\.companies\(id\)/.test(m118Code));
check('既有無公司假日指派給大正', /UPDATE public\.holidays\s+SET company_id = '8a669e2c-7521-43e9-9300-5c004c57e9db'::uuid\s+WHERE company_id IS NULL/.test(m118Code));
check('移除 unique(date)（多公司各自維護）', /DROP INDEX IF EXISTS public\.holidays_date_key/.test(m118Code) && /DROP CONSTRAINT IF EXISTS holidays_date_key/.test(m118Code));
check('指派公司在 SET NOT NULL 之前', m118Code.indexOf('WHERE company_id IS NULL;') < m118Code.indexOf('ALTER COLUMN company_id SET NOT NULL'));
check('唯一索引 (company_id, holiday_date)', /UNIQUE INDEX IF NOT EXISTS holidays_company_date_uidx ON public\.holidays \(company_id, holiday_date\)/.test(m118Code));
check('RLS 維持啟用、不新增 USING(true)', /ALTER TABLE public\.holidays ENABLE ROW LEVEL SECURITY/.test(m118Code) && !/USING \(true\)/i.test(m118Code));
const seed = m118Code.slice(m118Code.indexOf('INSERT INTO public.holidays'), m118Code.indexOf('ON CONFLICT (company_id, holiday_date)'));
const seedDates = (seed.match(/DATE '2026-\d\d-\d\d'/g) || []).map(x => x.slice(6, 16));
check('2026 假日 22 筆', seedDates.length === 22, String(seedDates.length));
['2026-01-01', '2026-02-16', '2026-02-17', '2026-02-18', '2026-02-19', '2026-02-20', '2026-02-27', '2026-04-03', '2026-04-06', '2026-05-01', '2026-06-19', '2026-09-25', '2026-09-28', '2026-10-09', '2026-10-26', '2026-12-25']
  .forEach(d => check('含平日假日 ' + d, seedDates.includes(d)));
check('只匯入大正科技', (seed.match(/8a669e2c-7521-43e9-9300-5c004c57e9db/g) || []).length === 1 && !/fb1f6b5f/.test(seed));
check('重複匯入不報錯（ON CONFLICT DO NOTHING）', /ON CONFLICT \(company_id, holiday_date\) DO NOTHING/.test(m118Code));

console.log('\n=== migration 118：函式 ===');
check('is_company_holiday REVOKE anon', /REVOKE ALL ON FUNCTION public\.is_company_holiday\(UUID, DATE\) FROM PUBLIC, anon, authenticated/.test(m118Code));
const cw = sqlFn('count_employee_workdays');
check('count_employee_workdays 無排班日排除假日', /AND NOT public\.is_company_holiday\(v_company_id, d::DATE\)/.test(cw));
check('count_employee_workdays 排班優先邏輯保留', /COALESCE\(s\.is_off_day, false\) = false/.test(cw));
const mo = sqlFn('get_company_monthly_attendance');
check('月統計應出勤排除假日', /AND NOT public\.is_company_holiday\(p_company_id, d::DATE\)/.test(mo));
check('月統計仍有 has_company_access', /has_company_access\(p_line_user_id, p_company_id, true\)/.test(mo));
check('門檻函式預設 60', /get_missing_work_hours_min_minutes[\s\S]*?60\s*\n\s*\);/.test(m118Code));
check('大正寫入門檻 60', /'missing_work_hours_min_minutes', to_jsonb\(60\)/.test(m118Code));
const sc = sqlFn('scan_missing_work_hours');
check('每日掃描改用門檻', />= public\.get_missing_work_hours_min_minutes\(v_row\.company_id\) THEN/.test(sc) && !/missing_minutes'\)::INTEGER, 0\) > 0 THEN/.test(sc));
const pv = sqlFn('preview_company_missing_work_hours');
check('預覽掃描改用同一門檻', />= public\.get_missing_work_hours_min_minutes\(p_company_id\) THEN/.test(pv) && !/missing_minutes'\)::INTEGER, 0\) > 0 THEN/.test(pv));
check('預覽仍驗 has_missing_work_hours_notification_access', /has_missing_work_hours_notification_access\(p_line_user_id, p_company_id\)/.test(pv));
const mm = sqlFn('get_company_monthly_missing_minutes');
check('月缺工分鐘 RPC 存在且驗身分（manager）', /has_company_access\(p_line_user_id, p_company_id, true\)/.test(mm));
check('月缺工分鐘只算到昨天', /IF v_end >= v_today THEN v_end := v_today - 1; END IF;/.test(mm));
check('月缺工分鐘用 calculate_missing_work_hours 單一來源', /public\.calculate_missing_work_hours\(v_emp\.id, v_day\)/.test(mm));
check('月缺工分鐘排除免打卡／公務機', /no_checkin, false\) = false/.test(mm) && /is_kiosk, false\) = false/.test(mm));
check('get_company_holidays 驗身分且 GRANT anon/authenticated', /has_company_access\(p_line_user_id, p_company_id, false\)/.test(sqlFn('get_company_holidays')) && /GRANT EXECUTE ON FUNCTION public\.get_company_holidays\(UUID, TEXT, DATE, DATE\) TO anon, authenticated/.test(m118Code));
check('RECORD NULL 陷阱：沒有 IF v_xxx IS NOT NULL', !/IF v_\w+ IS NOT NULL/.test(m118Code) || /IF v_\w+\.\w+ IS NOT NULL/.test(m118Code));

console.log(`\n結果：${pass} 通過 / ${fail} 失敗`);
process.exit(fail > 0 ? 1 : 0);
