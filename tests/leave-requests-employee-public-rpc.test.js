// ============================================================
// 149-C 員工端／公開頁 leave_requests 讀取 RPC 測試
//
// 全程使用靜態掃描與 vm sandbox；不連線、不讀寫資料庫。
// ============================================================

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
const read = file => fs.readFileSync(path.join(ROOT, file), 'utf8');
const commonSrc = read('common.js');
const recordsSrc = read('records.html');
const actualPublicSrc = read('attendance_public.html');
const publicSrc = process.env.MUTATE_PUBLIC_NOT_SHOWN_TO_ABSENT === '1'
  ? actualPublicSrc.replace("else clean.status = 'not_shown';", "else clean.status = 'absent';")
  : actualPublicSrc;

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

function walkProductFiles(dir = ROOT) {
  const files = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'tests' || entry.name === 'node_modules' || entry.name === '.git' || entry.name === '.codex') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...walkProductFiles(full));
    else if (/\.(?:js|html)$/i.test(entry.name)) files.push(full);
  }
  return files;
}

function callWindows(source, needle, size = 700) {
  const windows = [];
  let at = -1;
  while ((at = source.indexOf(needle, at + 1)) !== -1) windows.push(source.slice(at, at + size));
  return windows;
}

function taiwanLikeDate(value) {
  const d = new Date(value);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function legacyConflictSummary(leaves, startDate, endDate) {
  const start = new Date(startDate);
  const end = new Date(endDate);
  const conflicts = [];
  let maxDayConflict = 0;
  for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
    const ds = taiwanLikeDate(d);
    if (d.getDay() === 0 || d.getDay() === 6) continue;
    const dayLeaves = leaves.filter(row => ds >= row.start_date && ds <= (row.end_date || row.start_date));
    const names = dayLeaves.map(row => row.employees?.name || '同事').filter((value, index, all) => all.indexOf(value) === index);
    if (dayLeaves.length) conflicts.push({ date: ds, count: dayLeaves.length, names });
    maxDayConflict = Math.max(maxDayConflict, dayLeaves.length);
  }
  return { conflicts, maxDayConflict };
}

function buildAvailability(source, rpcResult, totalCount = 10) {
  const calls = [];
  const context = {
    currentEmployee: { id: 'employee-self', line_user_id: 'line-self' },
    liffProfile: { userId: 'line-profile' },
    window: { currentCompanyId: 'company-a' },
    getCachedSetting: key => key === 'max_concurrent_leave' ? { max: 2 } : null,
    fmtDate: taiwanLikeDate,
    console: { error() {}, warn() {} },
    sb: {
      rpc(name, args) {
        calls.push({ name, args });
        return Promise.resolve(rpcResult);
      },
      from(table) {
        if (table !== 'employees') throw new Error(`未預期直查：${table}`);
        let eqCount = 0;
        const chain = {
          select() { return chain; },
          eq() { eqCount++; return eqCount >= 2 ? Promise.resolve({ count: totalCount }) : chain; }
        };
        return chain;
      }
    }
  };
  vm.createContext(context);
  vm.runInContext(`${grabFunction(source, 'checkLeaveAvailability')}; this.checkLeaveAvailability = checkLeaveAvailability;`, context);
  return { fn: context.checkLeaveAvailability, calls };
}

function buildPublicContext(source = publicSrc) {
  const calls = [];
  const context = {
    companyId: 'company-a',
    getTaiwanDate: () => '2026-10-13',
    sb: {
      rpc(name, args) {
        calls.push({ name, args });
        return Promise.resolve({ data: [{ employee_id: 'employee-a', employee_name: '甲員工' }], error: null });
      }
    }
  };
  vm.createContext(context);
  vm.runInContext([
    grabFunction(source, 'runOptionalDailyQuery'),
    grabFunction(source, 'loadPublicTodayLeaveEmployees'),
    grabFunction(source, 'buildDailyLeaveMap'),
    grabFunction(source, 'sanitizePublicDailyRows'),
    grabFunction(source, 'isDailyStatRow')
  ].join('\n') + '\nthis.api = { loadPublicTodayLeaveEmployees, buildDailyLeaveMap, sanitizePublicDailyRows, isDailyStatRow };', context);
  return { context, calls };
}

(async () => {
  console.log('\n═══════════════════════════════════════');
  console.log('  149-C 員工端／公開頁請假讀取 RPC');
  console.log('═══════════════════════════════════════');

  console.log('\n=== 1. 全專案前端靜態掃描與 RPC 參數 ===');
  const productFiles = walkProductFiles();
  const directReadPattern = /\.from\(\s*['"]leave_requests['"]\s*\)/;
  const offenders = productFiles.filter(file => directReadPattern.test(fs.readFileSync(file, 'utf8')));
  check("排除 tests/ 後 0 處 from('leave_requests')", offenders.length === 0,
    offenders.map(file => path.relative(ROOT, file)).join(', '));

  const overlapCalls = callWindows(commonSrc, "sb.rpc('get_company_leave_overlap'");
  check('checkLeaveAvailability 恰有 1 個重疊 RPC', overlapCalls.length === 1);
  check('重疊 RPC 帶 p_company_id', overlapCalls[0]?.includes('p_company_id: window.currentCompanyId'));
  check('重疊 RPC 帶 p_line_user_id', overlapCalls[0]?.includes('p_line_user_id: lineUserId'));
  check('重疊 RPC 不再由前端 limit／排除本人', !/\.limit\(200\)|\.neq\('employee_id'/.test(grabFunction(commonSrc, 'checkLeaveAvailability')));

  const myCalls = [
    ...callWindows(commonSrc, "sb.rpc('get_my_leave_requests'"),
    ...callWindows(recordsSrc, "sb.rpc('get_my_leave_requests'")
  ];
  check('員工端恰有 3 個 get_my_leave_requests 呼叫', myCalls.length === 3, `實得 ${myCalls.length}`);
  myCalls.forEach((code, index) => {
    check(`#${index + 1} 本人 RPC 帶 p_company_id`, code.includes('p_company_id: window.currentCompanyId'));
    check(`#${index + 1} 本人 RPC 帶 p_line_user_id`, code.includes('p_line_user_id:'));
    check(`#${index + 1} 本人 RPC 明確限制 p_limit`, code.includes('p_limit:'));
  });
  check('三處 LINE ID 均沿用員工端既有 fallback',
    (commonSrc.match(/currentEmployee\?\.line_user_id \|\| liffProfile\?\.userId/g) || []).length >= 3
      && recordsSrc.includes('currentEmployee?.line_user_id || liffProfile?.userId'));

  const publicCall = callWindows(publicSrc, "sb.rpc('get_public_today_leave_employees'");
  const publicLoaderSource = grabFunction(publicSrc, 'loadPublicTodayLeaveEmployees');
  check('公開頁恰有 1 個今日請假 RPC', publicCall.length === 1);
  check('公開今日 RPC 只帶契約要求的 p_company_id',
    publicLoaderSource.includes('p_company_id: companyId') && !publicLoaderSource.includes('p_line_user_id'));

  const htmlFiles = fs.readdirSync(ROOT).filter(name => name.endsWith('.html'));
  const commonRefs = htmlFiles.flatMap(name => {
    const matches = [...read(name).matchAll(/common\.js\?v=([^"'\s<]+)/g)];
    return matches.map(match => ({ name, version: match[1] }));
  });
  check('所有 HTML 的 common.js 引用版本一致',
    commonRefs.length > 0 && commonRefs.every(ref => ref.version === '20261013-leaverpc149c'),
    [...new Set(commonRefs.map(ref => ref.version))].join(', '));

  console.log('\n=== 2. VM：checkLeaveAvailability 改前／改後行為 ===');
  const legacyRows = [
    { employee_id: 'employee-a', start_date: '2026-10-12', end_date: '2026-10-14', status: 'approved', employees: { name: '甲員工' } },
    { employee_id: 'employee-b', start_date: '2026-10-13', end_date: '2026-10-13', status: 'pending', employees: { name: '乙員工' } }
  ];
  const rpcRows = legacyRows.map(({ employees, ...row }) => ({ ...row, employee_name: employees.name }));
  const legacy = legacyConflictSummary(legacyRows, '2026-10-12', '2026-10-14');
  const availability = buildAvailability(commonSrc, { data: rpcRows, error: null });
  const current = await availability.fn('2026-10-12', '2026-10-14');
  check('衝突逐日人數與改前一致', JSON.stringify(current.conflicts) === JSON.stringify(legacy.conflicts), JSON.stringify(current.conflicts));
  check('最大衝突人數與改前一致', current.maxDayConflict === legacy.maxDayConflict, String(current.maxDayConflict));
  check('頂層 employee_name 正確顯示姓名', current.conflicts.some(row => row.names.includes('甲員工') && row.names.includes('乙員工')));
  check('第 3 人仍只警告、不阻擋', current.ok === true && current.thresholdExceeded === true);
  check('VM 實際送出正確重疊 RPC 參數',
    availability.calls.length === 1
      && availability.calls[0].name === 'get_company_leave_overlap'
      && availability.calls[0].args.p_line_user_id === 'line-self'
      && availability.calls[0].args.p_company_id === 'company-a'
      && availability.calls[0].args.p_from === '2026-10-12'
      && availability.calls[0].args.p_to === '2026-10-14');

  const failedAvailability = buildAvailability(commonSrc, { data: null, error: new Error('rpc failed') });
  const failedResult = await failedAvailability.fn('2026-10-12', '2026-10-14');
  check('重疊 RPC 失敗仍允許正常送假', failedResult.ok === true && failedResult.thresholdExceeded === false);
  check('重疊 RPC 失敗會顯示保守警告', failedResult.availabilityUnknown === true && /無法確認.*仍可送出/.test(failedResult.message), failedResult.message);

  const brokenAvailabilitySrc = commonSrc.replace("l.employee_name || '同事'", "l.employees?.name || '同事'");
  const brokenAvailability = buildAvailability(brokenAvailabilitySrc, { data: rpcRows, error: null });
  const brokenResult = await brokenAvailability.fn('2026-10-12', '2026-10-14');
  check('反向對照：改回舊巢狀姓名會被行為比對抓到',
    JSON.stringify(brokenResult.conflicts) !== JSON.stringify(legacy.conflicts));

  console.log('\n=== 3. VM：本人重疊 RPC 失敗退讓 ===');
  const findContext = {
    currentEmployee: { id: 'employee-self', line_user_id: 'line-self' },
    liffProfile: { userId: 'line-profile' },
    window: { currentCompanyId: 'company-a' },
    sb: { rpc: (name, args) => Promise.resolve({ data: null, error: new Error(`${name}:${args.p_company_id}`) }) }
  };
  vm.createContext(findContext);
  vm.runInContext([
    grabFunction(commonSrc, 'leaveDateRangesOverlap'),
    grabFunction(commonSrc, 'findMyOverlappingLeave'),
    'this.findMyOverlappingLeave = findMyOverlappingLeave;'
  ].join('\n'), findContext);
  check('本人重疊 RPC 失敗回 null、交由送出 RPC 防線',
    await findContext.findMyOverlappingLeave('2026-10-13', '2026-10-13') === null);

  console.log('\n=== 4. VM：公開頁只查今日且只顯示「請假」 ===');
  const publicVm = buildPublicContext();
  const todayResult = await publicVm.context.api.loadPublicTodayLeaveEmployees('2026-10-13');
  check('查看台灣今日會呼叫公開今日 RPC', todayResult.data.length === 1 && publicVm.calls.length === 1);
  check('今日公開 RPC 參數只有公司',
    Object.keys(publicVm.calls[0].args).length === 1 && publicVm.calls[0].args.p_company_id === 'company-a');
  const beforeHistoryCalls = publicVm.calls.length;
  const historyResult = await publicVm.context.api.loadPublicTodayLeaveEmployees('2026-10-12');
  check('非今日回空集合', Array.isArray(historyResult.data) && historyResult.data.length === 0);
  check('非今日完全不呼叫請假 RPC', publicVm.calls.length === beforeHistoryCalls);
  check('非今日不建立請假標記', publicVm.context.api.buildDailyLeaveMap(todayResult.data, '2026-10-12').size === 0);
  check('今日只以 employee_id 建立最小標記', publicVm.context.api.buildDailyLeaveMap(todayResult.data, '2026-10-13').has('employee-a'));

  const sanitized = publicVm.context.api.sanitizePublicDailyRows([
    { employee_id: 'a', status: 'on_leave', leave_type: 'annual', check_in_time: null, check_out_time: null },
    { employee_id: 'b', status: 'on_leave', leave_type: 'sick', check_in_time: 'in', check_out_time: null },
    { employee_id: 'c', status: 'on_leave', leave_type: 'sick', check_in_time: 'in', check_out_time: 'out' },
    { employee_id: 'd', status: 'on_leave', leave_type: 'sick', check_in_time: null, check_out_time: 'out' }
  ], '2026-10-12');
  check('非今日移除 RPC 主表附帶的假別', sanitized.every(row => row.leave_type === null));
  check('非今日不保留 on_leave 標記', sanitized.every(row => row.status !== 'on_leave'), JSON.stringify(sanitized));
  check('非今日 on_leave 無打卡改為 not_shown', sanitized[0].status === 'not_shown', JSON.stringify(sanitized[0]));
  check('非今日 on_leave 僅上班卡顯示 working', sanitized[1].status === 'working');
  check('非今日 on_leave 完整打卡顯示 completed', sanitized[2].status === 'completed');
  check('非今日 on_leave 僅下班卡仍顯示 completed', sanitized[3].status === 'completed');

  const todaySanitized = publicVm.context.api.sanitizePublicDailyRows([
    { employee_id: 'today', status: 'on_leave', leave_type: 'annual', check_in_time: null, check_out_time: null }
  ], '2026-10-13');
  check('今日 on_leave 狀態維持請假行為', todaySanitized[0].status === 'on_leave');

  const statRows = JSON.parse(JSON.stringify([
    ...sanitized,
    ...todaySanitized,
    { employee_id: 'absent', status: 'absent' },
    { employee_id: 'unchecked', status: 'not_checked' },
    { employee_id: 'off', status: 'off_day' }
  ]));
  const statElements = Object.fromEntries([
    'dExpected', 'dChecked', 'dNotChecked', 'dLate', 'dEarly', 'dLeave',
    'dPendingMakeup', 'dPendingMakeupCorrection'
  ].map(id => [id, { textContent: '' }]));
  const statContext = {
    dailyData: statRows,
    document: { getElementById: id => statElements[id] || null },
    hasPendingMakeup: () => false,
    hasDailyLeave: () => false,
    hasPurePendingMakeup: () => false,
    hasPendingMakeupCorrection: () => false
  };
  vm.createContext(statContext);
  vm.runInContext([
    grabFunction(publicSrc, 'isDailyStatRow'),
    grabFunction(publicSrc, 'updateDailyStats'),
    'this.updateDailyStats = updateDailyStats;'
  ].join('\n'), statContext);
  statContext.updateDailyStats();
  check('not_shown 不計入應到人數', statElements.dExpected.textContent === 6, String(statElements.dExpected.textContent));
  check('not_shown 不計入未打卡／缺勤統計', statElements.dNotChecked.textContent === 2, String(statElements.dNotChecked.textContent));
  check('not_shown 不計入請假統計', statElements.dLeave.textContent === 1, String(statElements.dLeave.textContent));

  const badgeContext = {
    hasPendingMakeup: () => false,
    pendingMakeupLabel: () => '',
    t: key => ({ leave: '請假', unknown: '未知', working: '上班中', completed: '完成', notChecked: '未打卡', absent: '缺勤', offDay: '休', late: '遲到', early: '早退' }[key] || key)
  };
  vm.createContext(badgeContext);
  vm.runInContext([
    grabFunction(publicSrc, 'hasDailyLeave'),
    grabFunction(publicSrc, 'dailyLeaveLabel'),
    grabFunction(publicSrc, 'dailyExportStatus'),
    grabFunction(publicSrc, 'statusBadge'),
    'this.statusBadge = statusBadge; this.dailyExportStatus = dailyExportStatus;'
  ].join('\n'), badgeContext);
  const badge = badgeContext.statusBadge({
    status: 'absent',
    daily_leave: { employee_id: 'a', employee_name: '甲員工', status: 'pending', leave_type: 'annual', leave_period: 'am' }
  });
  check('今日請假徽章只顯示「請假」', badge.includes('請假'));
  check('今日徽章不顯示假別／時段／待審', !/特休|病假|上午|下午|待審/.test(badge), badge);
  const neutralRow = { status: 'not_shown', is_early_leave: true, pending_makeups: [{ punch_type: 'clock_in' }] };
  const neutralBadge = badgeContext.statusBadge(neutralRow);
  check('not_shown 徽章顯示中性破折號', neutralBadge.includes('—') && !/請假|缺勤|未打卡|待審/.test(neutralBadge), neutralBadge);
  check('not_shown 匯出 Excel 狀態為破折號', badgeContext.dailyExportStatus(neutralRow) === '—');

  const brokenPublicSrc = publicSrc.replace("if (dateStr !== getTaiwanDate()) return { data: [], error: null };", '');
  const brokenPublicVm = buildPublicContext(brokenPublicSrc);
  await brokenPublicVm.context.api.loadPublicTodayLeaveEmployees('2026-10-12');
  check('反向對照：移除非今日 guard 會真的呼叫 RPC', brokenPublicVm.calls.length === 1);

  const absentMutationSrc = publicSrc.replace("else clean.status = 'not_shown';", "else clean.status = 'absent';");
  const absentMutationVm = buildPublicContext(absentMutationSrc);
  const absentMutationRow = absentMutationVm.context.api.sanitizePublicDailyRows([
    { employee_id: 'mutant', status: 'on_leave', leave_type: 'annual', check_in_time: null, check_out_time: null }
  ], '2026-10-12')[0];
  check('反向對照：還原成 absent 會違反 not_shown 驗收並被測試抓到',
    absentMutationRow.status !== 'not_shown' && absentMutationVm.context.api.isDailyStatRow(absentMutationRow));

  const mutatedFiles = productFiles.map(file => ({ file, source: fs.readFileSync(file, 'utf8') }));
  mutatedFiles[0].source += "\nsb.from('leave_requests')";
  check('反向對照：恢復任一直接查表會被全專案掃描抓到',
    mutatedFiles.some(item => directReadPattern.test(item.source)));

  console.log(`\n  結果：${pass} 通過，${fail} 失敗`);
  if (fail > 0) process.exit(1);
})().catch(error => {
  console.error('  ❌ 測試執行失敗', error);
  process.exit(1);
});
