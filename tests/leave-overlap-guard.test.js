// 117 請假重疊防呆 ＋ 日曆天觸發器移除 回歸測試（不連線、不寫 DB）
//
// 反向對照：COMMON_FILE / MIGRATION117_FILE 環境變數可指向改壞的副本，確認測試真的擋得住回歸。
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const commonPath = process.env.COMMON_FILE || path.join(root, 'common.js');
const migrationPath = process.env.MIGRATION117_FILE || path.join(root, 'migrations', '117_leave_overlap_guard.sql');
const commonSrc = fs.readFileSync(commonPath, 'utf8');
const m117 = fs.readFileSync(migrationPath, 'utf8');

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

// 抽出 SQL 中某個函式的本體（CREATE OR REPLACE FUNCTION public.<name>( ... 到下一個 $$; ）
function sqlFn(name) {
  const re = new RegExp('CREATE OR REPLACE FUNCTION public\\.' + name + '\\([\\s\\S]*?\\n\\$\\$;', 'm');
  const m = m117.match(re);
  return m ? m[0] : '';
}

console.log('\n=== 前端純函式 leaveDateRangesOverlap ===');
let helpers = null;
try {
  helpers = new Function(`
    ${grab(commonSrc, 'leaveDateRangesOverlap')}
    ${grab(commonSrc, 'leavePeriodLabel')}
    ${grab(commonSrc, 'formatLeaveOverlapMessage')}
    return { leaveDateRangesOverlap, leavePeriodLabel, formatLeaveOverlapMessage };
  `)();
} catch (e) {
  check('common.js 具備重疊輔助函式', false, e.message);
}
if (helpers) {
  const o = helpers.leaveDateRangesOverlap;
  check('同一天單日 vs 單日 → 重疊', o('2026-08-21', '2026-08-21', '2026-08-21', '2026-08-21') === true);
  check('end 缺省視同單日', o('2026-08-21', null, '2026-08-21', undefined) === true);
  check('新假在既有多日假中間 → 重疊', o('2026-09-05', '2026-09-05', '2026-09-03', '2026-09-07') === true);
  check('區間尾端相接（同一天）→ 重疊', o('2026-09-07', '2026-09-08', '2026-09-03', '2026-09-07') === true);
  check('相鄰不相交（隔天）→ 不重疊', o('2026-09-08', '2026-09-09', '2026-09-03', '2026-09-07') === false);
  check('完全在前 → 不重疊', o('2026-08-01', '2026-08-02', '2026-08-10', '2026-08-12') === false);
  check('缺 start → 不重疊（交給 RPC）', o(null, null, '2026-08-10', '2026-08-12') === false);

  const msg = helpers.formatLeaveOverlapMessage(
    { start_date: '2026-08-12', end_date: '2026-08-12', leave_period: 'am', status: 'approved' }, '❌ 同一天已有請假申請');
  check('訊息含日期／時段／狀態', /2026-08-12/.test(msg) && /上午半天/.test(msg) && /已核准/.test(msg), msg);
  const msg2 = helpers.formatLeaveOverlapMessage(
    { start_date: '2026-09-03', end_date: '2026-09-07', leave_period: 'full_day', status: 'pending' }, 'X');
  check('多日假單顯示區間與待審核', /2026-09-03 ~ 2026-09-07/.test(msg2) && /全日/.test(msg2) && /待審核/.test(msg2), msg2);
}

console.log('\n=== 前端 submitLeave 接線 ===');
let submitSrc = '';
try { submitSrc = grab(commonSrc, 'submitLeave'); } catch (e) { check('找得到 submitLeave', false, e.message); }
const idxMine = submitSrc.indexOf('findMyOverlappingLeave(start, end)');
const idxCheck = submitSrc.indexOf('checkLeaveAvailability(start, end)');
const idxRpc = submitSrc.indexOf("rpc('submit_leave_request'");
check('submitLeave 先查自己重疊', idxMine > 0);
check('重疊檢查在人力門檻檢查之前', idxMine > 0 && idxCheck > idxMine);
check('重疊檢查在 RPC 送出之前', idxMine > 0 && idxRpc > idxMine);
check('有重疊時 return 不送出', /if \(mine\) \{[\s\S]*?return showToast/.test(submitSrc));
check('有重疊時恢復按鈕狀態', /if \(mine\) \{[\s\S]*?setBtnLoading\(submitBtn, false\)/.test(submitSrc));

let findSrc = '';
try { findSrc = grab(commonSrc, 'findMyOverlappingLeave'); } catch (e) { check('找得到 findMyOverlappingLeave', false, e.message); }
check('自查限定 employee_id', /\.eq\('employee_id', currentEmployee\.id\)/.test(findSrc));
check('自查帶公司隔離', /employees\.company_id/.test(findSrc) && /window\.currentCompanyId/.test(findSrc));
check('自查只看 approved/pending', /\.in\('status', \['approved', 'pending'\]\)/.test(findSrc));
check('查詢失敗不阻擋送出（交給 RPC）', /if \(error\) return null/.test(findSrc));

console.log('\n=== migration 117：移除日曆天觸發器 ===');
check('DROP TRIGGER calculate_leave_days_trigger', /DROP TRIGGER IF EXISTS calculate_leave_days_trigger ON public\.leave_requests/.test(m117));
check('DROP FUNCTION calculate_leave_days', /DROP FUNCTION IF EXISTS public\.calculate_leave_days\(\)/.test(m117));
const m117Code = m117.split('\n').filter(l => !/^\s*--/.test(l)).join('\n');   // 去掉註解行再檢查
check('不再有人寫 end_date - start_date + 1 進 days', !/NEW\.days\s*:=/.test(m117Code));

console.log('\n=== migration 117：find_overlapping_leave ===');
const findFn = sqlFn('find_overlapping_leave');
check('定義存在', findFn.length > 0);
check('限定同員工', /lr\.employee_id = p_employee_id/.test(findFn));
check('狀態用參數（預設 pending+approved）', /lr\.status = ANY\(p_statuses\)/.test(findFn) && /ARRAY\['pending', 'approved'\]/.test(findFn));
check('日期交集條件', /lr\.start_date <= p_end/.test(findFn) && /COALESCE\(lr\.end_date, lr\.start_date\) >= p_start/.test(findFn));
check('可排除自己（核准時用）', /p_exclude_id IS NULL OR lr\.id <> p_exclude_id/.test(findFn));
check('REVOKE anon/authenticated', /REVOKE ALL ON FUNCTION public\.find_overlapping_leave[^\n]*FROM PUBLIC, anon, authenticated/.test(m117));

console.log('\n=== migration 117：submit_leave_request 重疊檢查 ===');
const submitFn = sqlFn('submit_leave_request');
check('9 參數版存在', /p_leave_start_time TIME,\s*p_leave_end_time TIME/.test(submitFn));
const sIdxConflict = submitFn.indexOf('find_overlapping_leave(v_employee_id, p_start_date, p_end_date, NULL)');
const sIdxInsert = submitFn.indexOf('INSERT INTO public.leave_requests');
const sIdxWorkdays = submitFn.indexOf('count_employee_workdays(v_employee_id');
check('送出前查重疊', sIdxConflict > 0);
check('重疊檢查在 INSERT 之前', sIdxConflict > 0 && sIdxInsert > sIdxConflict);
check('重疊檢查在工作日計算之前（不浪費）', sIdxConflict > 0 && sIdxWorkdays > sIdxConflict);
check('重疊回 error_code leave_overlap', /'error_code', 'leave_overlap'/.test(submitFn));
check('半天假仍存 0.5', /WHEN v_period IN \('am', 'pm'\) THEN 0\.5/.test(submitFn));
check('全日假仍用工作日數', /ELSE v_workdays/.test(submitFn));
check('GRANT anon/authenticated 維持', /GRANT EXECUTE ON FUNCTION public\.submit_leave_request\(TEXT, UUID[^\n]*TO anon, authenticated/.test(m117));

console.log('\n=== migration 117：approve_leave_request ===');
const approveFn = sqlFn('approve_leave_request');
check('定義存在', approveFn.length > 0);
check('只處理 pending', /IF v_req\.status <> 'pending' THEN/.test(approveFn));
check('核准時查同員工已核准假單並排除自己', /find_overlapping_leave\(\s*v_req\.employee_id, v_req\.start_date, COALESCE\(v_req\.end_date, v_req\.start_date\),\s*p_request_id, ARRAY\['approved'\]\s*\)/.test(approveFn));
check('重疊檢查僅在 approved 時', /IF p_status = 'approved' THEN[\s\S]*?find_overlapping_leave/.test(approveFn));
check('UPDATE 再次限定 status = pending（併發保護）', /WHERE id = p_request_id\s*AND status = 'pending'/.test(approveFn));
check('回傳欄位維持（前端 LINE 通知用）', /'employee_id', v_req\.emp_id/.test(approveFn) && /'leave_type', v_req\.leave_type/.test(approveFn));

console.log('\n=== migration 117：資料修正範圍 ===');
const fixIdx = m117.indexOf('UPDATE public.leave_requests lr');
const fixSrc = fixIdx > 0 ? m117.slice(fixIdx, m117.indexOf('RETURNING', fixIdx) + 200) : '';
check('資料修正段存在', fixIdx > 0);
check('只動 pending/approved', /l\.status IN \('pending', 'approved'\)/.test(fixSrc));
check('只動 2026-07-01 起', /l\.start_date >= DATE '2026-07-01'/.test(fixSrc));
check('只動 days 不同者', /lr\.days IS DISTINCT FROM calc\.expected_days/.test(fixSrc));
check('全日用 count_employee_workdays', /count_employee_workdays\(l\.employee_id, l\.start_date/.test(fixSrc));
check('半天 0.5／時數 hours÷8', /THEN 0\.5/.test(fixSrc) && /\/ 8\.0, 4\)/.test(fixSrc));
check('不把 days 改成 0 或 NULL', /calc\.expected_days IS NOT NULL/.test(fixSrc) && /calc\.expected_days > 0/.test(fixSrc));
check('有 RETURNING 供部署證據', /RETURNING lr\.id/.test(fixSrc));

console.log(`\n結果：${pass} 通過 / ${fail} 失敗`);
process.exit(fail > 0 ? 1 : 0);
