// 119 假日維護 RPC／畫面 ＋ 2027 假日種子 ＋ approve_leave_request 呼叫者驗證 回歸測試（不連線、不寫 DB）
//
// 反向對照：COMMON_FILE / LEAVE_FILE / MIGRATION119_FILE 環境變數可指向改壞的副本。
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const commonSrc = fs.readFileSync(process.env.COMMON_FILE || path.join(root, 'common.js'), 'utf8');
const leaveSrc = fs.readFileSync(process.env.LEAVE_FILE || path.join(root, 'modules', 'leave.js'), 'utf8');
const adminSrc = fs.readFileSync(path.join(root, 'admin.html'), 'utf8');
const authSrc = fs.readFileSync(path.join(root, 'modules', 'auth.js'), 'utf8');
const m119 = fs.readFileSync(process.env.MIGRATION119_FILE || path.join(root, 'migrations', '119_holiday_admin_and_approve_leave_auth.sql'), 'utf8');
const m119Code = m119.split('\n').filter(l => !/^\s*--/.test(l)).join('\n');

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
// 依簽章第一個參數名抓 SQL 函式本體
function sqlFnBySig(name, firstParam) {
  const re = new RegExp('CREATE OR REPLACE FUNCTION public\\.' + name + '\\(\\s*' + firstParam + '[\\s\\S]*?\\n\\$\\$;', 'm');
  const m = m119Code.match(re);
  return m ? m[0] : '';
}

console.log('\n=== migration 119：2027 假日種子 ===');
const seed = m119Code.slice(m119Code.indexOf('INSERT INTO public.holidays'), m119Code.indexOf('ON CONFLICT (company_id, holiday_date) DO NOTHING'));
const seedDates = (seed.match(/DATE '2027-\d\d-\d\d'/g) || []).map(x => x.slice(6, 16));
check('2027 假日 24 筆', seedDates.length === 24, String(seedDates.length));
['2027-01-01', '2027-02-04', '2027-02-05', '2027-02-08', '2027-02-09', '2027-02-10', '2027-03-01', '2027-04-05', '2027-04-06', '2027-04-30', '2027-06-09', '2027-09-15', '2027-09-28', '2027-10-11', '2027-10-25', '2027-12-24', '2027-12-31']
  .forEach(d => check('含平日假日／補假 ' + d, seedDates.includes(d)));
check('補假標為 makeup、其餘 national', /'2027-04-30', '勞動節補假', 'makeup'/.test(seed) && /'2027-06-09', '端午節', 'national'/.test(seed));
check('只匯入大正', (seed.match(/8a669e2c-7521-43e9-9300-5c004c57e9db/g) || []).length === 1 && !/fb1f6b5f/.test(seed));
check('type 只用 CHECK 允許的值', (seed.match(/'(national|makeup|company)'\)/g) || []).length === 24);

console.log('\n=== migration 119：假日維護 RPC ===');
const up = sqlFnBySig('upsert_company_holiday', 'p_company_id');
check('upsert 驗管理員（has_company_access …, true）', /has_company_access\(p_line_user_id, p_company_id, true\)/.test(up));
check('upsert 檢查名稱與類型', /請輸入假日名稱/.test(up) && /NOT IN \('national', 'makeup', 'company'\)/.test(up));
check('upsert 以 (company_id, holiday_date) 衝突更新', /ON CONFLICT \(company_id, holiday_date\) DO UPDATE/.test(up));
check('upsert 只寫 p_company_id（不可跨公司）', /VALUES \(p_company_id, p_holiday_date, v_name, v_type\)/.test(up));
const del = sqlFnBySig('delete_company_holiday', 'p_company_id');
check('delete 驗管理員', /has_company_access\(p_line_user_id, p_company_id, true\)/.test(del));
check('delete 限定 company_id', /WHERE h\.company_id = p_company_id AND h\.holiday_date = p_holiday_date/.test(del));
check('兩支 RPC GRANT anon/authenticated', /GRANT EXECUTE ON FUNCTION public\.upsert_company_holiday\(UUID, TEXT, DATE, TEXT, TEXT\) TO anon, authenticated/.test(m119Code) && /GRANT EXECUTE ON FUNCTION public\.delete_company_holiday\(UUID, TEXT, DATE\) TO anon, authenticated/.test(m119Code));

console.log('\n=== migration 119：approve_leave_request 呼叫者驗證 ===');
const ap = sqlFnBySig('approve_leave_request', 'p_company_id');
check('新簽章存在（company + line_user_id）', ap.length > 0 && /p_line_user_id TEXT,\s*p_request_id UUID/.test(ap));
check('先驗 has_company_access(…, true)', /has_company_access\(p_line_user_id, p_company_id, true\)/.test(ap));
const apIdxAuth = ap.indexOf('has_company_access'), apIdxUpdate = ap.indexOf('UPDATE public.leave_requests');
check('驗證在 UPDATE 之前', apIdxAuth > 0 && apIdxUpdate > apIdxAuth);
check('假單必須屬於同公司', /WHERE lr\.id = p_request_id\s+AND e\.company_id = p_company_id/.test(ap));
check('approver_id 由呼叫者解析，不吃前端參數', /SELECT e\.id INTO v_approver_id/.test(ap) && /approver_id = v_approver_id/.test(ap) && !/p_approver_id/.test(ap));
check('保留 117：只處理 pending', /IF v_req\.status <> 'pending' THEN/.test(ap));
check('保留 117：核准時查重疊', /find_overlapping_leave\(\s*v_req\.employee_id/.test(ap));
check('UPDATE 再限 status = pending', /WHERE id = p_request_id\s+AND status = 'pending'/.test(ap));
check('RECORD NULL 判斷用 v_req.id', /IF v_req\.id IS NULL THEN/.test(ap) && !/IF v_req IS NOT NULL/.test(ap));
const old = sqlFnBySig('approve_leave_request', 'p_request_id');
check('舊 4 參數簽章改為直接回錯', old.length > 0 && /deprecated_signature/.test(old));
check('舊簽章不再 UPDATE', !/UPDATE public\.leave_requests/.test(old) && !/UPDATE leave_requests/.test(old));
check('新舊簽章都 GRANT（舊的只回訊息）', /GRANT EXECUTE ON FUNCTION public\.approve_leave_request\(UUID, TEXT, UUID, TEXT, TEXT\) TO anon, authenticated/.test(m119Code) && /GRANT EXECUTE ON FUNCTION public\.approve_leave_request\(UUID, TEXT, UUID, TEXT\) TO anon, authenticated/.test(m119Code));

console.log('\n=== 前端：leave.js 核准改新簽章 ===');
let apSrc = '';
try { apSrc = grab(leaveSrc, 'approveLeave'); } catch (e) { check('找得到 approveLeave', false, e.message); }
check('傳 p_company_id 與 p_line_user_id', /p_company_id: window\.currentCompanyId/.test(apSrc) && /p_line_user_id: window\.currentAdminEmployee\?\.line_user_id \|\| liffProfile\?\.userId \|\| null/.test(apSrc));
check('不再傳 p_approver_id', !/p_approver_id/.test(apSrc));
check('仍處理 result.success=false', /if \(!result\?\.success\) throw new Error/.test(apSrc));

console.log('\n=== 前端：假日維護畫面 ===');
check('admin.html 有假日卡片元素', /id="holidayYear"/.test(adminSrc) && /id="holidayList"/.test(adminSrc) && /id="newHolidayDate"/.test(adminSrc) && /onclick="addHoliday\(\)"/.test(adminSrc));
check('地點頁顯示時載入假日', /if \(id === 'locationPage'\) \{ window\.renderLocationList\?\.\(\); window\.loadHolidayList\?\.\(\); \}/.test(authSrc));
let loadSrc = '', addSrc = '', delSrc = '';
try { loadSrc = grab(commonSrc, 'loadHolidayList'); addSrc = grab(commonSrc, 'addHoliday'); delSrc = grab(commonSrc, 'deleteHoliday'); }
catch (e) { check('common.js 具備假日維護函式', false, e.message); }
check('讀取走 get_company_holidays 並帶公司', /rpc\('get_company_holidays'/.test(loadSrc) && /p_company_id: window\.currentCompanyId/.test(loadSrc));
check('新增走 upsert_company_holiday 並帶公司與身分', /rpc\('upsert_company_holiday'/.test(addSrc) && /p_company_id: window\.currentCompanyId/.test(addSrc) && /holidayAdminLineUserId\(\)/.test(addSrc));
check('刪除走 delete_company_holiday 且先 confirm', /rpc\('delete_company_holiday'/.test(delSrc) && /confirm\(/.test(delSrc));
check('沒有任何直接寫 holidays 表', !/from\('holidays'\)\s*\.(insert|update|upsert|delete)/.test(commonSrc));
check('RPC 回 success=false 會拋錯顯示', /if \(!data\?\.success\) throw new Error\(data\?\.error/.test(addSrc) && /if \(!data\?\.success\) throw new Error\(data\?\.error/.test(delSrc));
let lbl = null;
try { lbl = new Function(`${grab(commonSrc, 'holidayTypeLabel')}; return holidayTypeLabel;`)(); } catch (e) { check('抽得出 holidayTypeLabel', false, e.message); }
if (lbl) check('類型標籤', lbl('national') === '國定假日' && lbl('makeup') === '補假' && lbl('company') === '公司自訂');

console.log(`\n結果：${pass} 通過 / ${fail} 失敗`);
process.exit(fail > 0 ? 1 : 0);
