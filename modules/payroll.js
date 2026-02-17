// ============================================================
// modules/payroll.js — 獎金試算 / 薪資發放 / 勞健保級距
// 依賴 common.js 全域: sb, showToast, escapeHTML, friendlyError,
//   writeAuditLog, setBtnLoading, parseMoney, formatNT, toMoneyStr,
//   formatMoneyInput, fmtDate
// ============================================================

// ===== 獎金常數 =====
export const BONUS_MATRIX = {
    S: { A: 2.0, B: 1.8, C: 1.5 },
    A: { A: 1.5, B: 1.3, C: 1.0 },
    B: { A: 1.0, B: 0.8, C: 0.5 }
};
const FULL_ATTENDANCE_BONUS = 3000;
const LATE_PENALTY_PER = 200;
const GRADE_LABELS = { A: '全勤', B: '正常', C: '待加強' };
const PERF_LABELS = { S: '卓越', A: '優良', B: '普通' };

// ===== 獎金模組狀態 =====
let bonusEmployees = [];
let bonusPerformance = {};
let bonusAdjustments = {};

// ===== 薪資模組狀態 =====
let payrollEmployees = [];
let payrollAdjustments = {};   // { empId: { amount: 0, note: '' } }
let payrollBrackets = [];
let payrollIsPublished = false;

// ===== 保險模組狀態 =====
let insBrackets = [];

// ===== 混合精算獎金系統 =====
export async function loadHybridBonusData() {
    const yearEl = document.getElementById('bonusYear');
    const listEl = document.getElementById('bonusList');
    const loadingEl = document.getElementById('bonusLoading');
    const summaryEl = document.getElementById('bonusSummary');
    const actionsEl = document.getElementById('bonusActions');
    const matrixRefEl = document.getElementById('matrixRef');
    if (!yearEl || !listEl) return;
    const year = parseInt(yearEl.value);

    if (loadingEl) loadingEl.style.display = 'block';
    if (summaryEl) summaryEl.style.display = 'none';
    if (actionsEl) actionsEl.style.display = 'none';
    if (matrixRefEl) matrixRefEl.style.display = 'none';
    listEl.innerHTML = '';

    try {
        const [empRes, salaryRes, attRes, leaveRes] = await Promise.all([
            sb.from('employees').select('id, name, employee_number, department, hire_date').eq('is_active', true).order('department').order('name'),
            sb.from('salary_settings').select('employee_id, base_salary').eq('is_current', true),
            sb.from('attendance').select('employee_id, is_late').gte('date', `${year}-01-01`).lte('date', `${year}-12-31`),
            sb.from('leave_requests').select('employee_id, days').eq('status', 'approved').gte('start_date', `${year}-01-01`).lte('start_date', `${year}-12-31`)
        ]);
        if (empRes.error) throw empRes.error;

        const salaryMap = {};
        (salaryRes.data || []).forEach(s => { salaryMap[s.employee_id] = s.base_salary; });
        const lateMap = {};
        (attRes.data || []).forEach(a => { if (!lateMap[a.employee_id]) lateMap[a.employee_id] = 0; if (a.is_late) lateMap[a.employee_id]++; });
        const leaveMap = {};
        (leaveRes.data || []).forEach(l => { if (!leaveMap[l.employee_id]) leaveMap[l.employee_id] = 0; leaveMap[l.employee_id] += (parseFloat(l.days) || 0); });

        const yearEnd = new Date(year, 11, 31);
        const today = new Date();
        const cutoffDate = yearEnd < today ? yearEnd : today;
        bonusEmployees = (empRes.data || []).map(emp => {
            const baseSalary = salaryMap[emp.id] || 0;
            const lateCount = lateMap[emp.id] || 0;
            const leaveDays = leaveMap[emp.id] || 0;
            let tenureRatio = 1.0;
            if (emp.hire_date) {
                const hireDate = new Date(emp.hire_date);
                const days = Math.max(0, (cutoffDate - hireDate) / 86400000);
                tenureRatio = Math.min(days / 365, 1.0);
            }
            let attendanceGrade = 'B';
            if (lateCount === 0 && leaveDays === 0) attendanceGrade = 'A';
            else if (lateCount >= 3 || leaveDays >= 3) attendanceGrade = 'C';

            return { id: emp.id, name: emp.name, employeeNumber: emp.employee_number, department: emp.department, hireDate: emp.hire_date, baseSalary, lateCount, leaveDays, tenureRatio, attendanceGrade, perfRating: bonusPerformance[emp.id] || 'A' };
        });

        populateBonusEmpDropdown();
        renderSelectedBonusCard();
        updateBonusSummary();
        renderMatrixRefTable();
        if (loadingEl) loadingEl.style.display = 'none';
        if (summaryEl) summaryEl.style.display = 'block';
        if (actionsEl) actionsEl.style.display = 'block';
        if (matrixRefEl) matrixRefEl.style.display = 'block';
        document.getElementById('bonusEmpSelect').style.display = 'block';
    } catch (err) {
        console.error('Bonus load failed:', err);
        if (loadingEl) loadingEl.style.display = 'none';
        listEl.innerHTML = '<p style="text-align:center;color:#ef4444;">載入失敗: ' + escapeHTML(friendlyError(err)) + '</p>';
    }
}

function calculateBonus(emp) {
    const perfRating = bonusPerformance[emp.id] || emp.perfRating || 'A';
    const manualAdj = bonusAdjustments[emp.id] || 0;
    const multiplier = BONUS_MATRIX[perfRating]?.[emp.attendanceGrade] ?? 1.0;
    const baseAmount = Math.round(emp.baseSalary * emp.tenureRatio * multiplier);
    const fullAtt = emp.attendanceGrade === 'A' ? FULL_ATTENDANCE_BONUS : 0;
    const latePen = emp.lateCount * LATE_PENALTY_PER;
    const finalAmount = Math.max(0, baseAmount + fullAtt - latePen + manualAdj);
    return { perfRating, multiplier, baseAmount, fullAtt, latePen, manualAdj, finalAmount };
}

function populateBonusEmpDropdown() {
    const sel = document.getElementById('bonusEmpDropdown');
    if (!sel) return;
    const prev = sel.value;
    sel.innerHTML = '<option value="_all">📋 全部員工總覽</option>';
    bonusEmployees.forEach(emp => {
        const c = calculateBonus(emp);
        sel.innerHTML += `<option value="${emp.id}">${escapeHTML(emp.name)}（${escapeHTML(emp.department || '-')}）— $${c.finalAmount.toLocaleString()}</option>`;
    });
    if (prev && sel.querySelector(`option[value="${prev}"]`)) sel.value = prev;
}

export function renderSelectedBonusCard() {
    const listEl = document.getElementById('bonusList');
    const sel = document.getElementById('bonusEmpDropdown');
    if (!listEl || !sel) return;
    if (bonusEmployees.length === 0) { listEl.innerHTML = '<p style="text-align:center;color:#999;">無員工資料</p>'; return; }

    const selectedId = sel.value;
    if (selectedId === '_all') { renderAllBonusSummaryTable(); return; }

    const emp = bonusEmployees.find(e => e.id === selectedId);
    if (!emp) { listEl.innerHTML = ''; return; }
    const c = calculateBonus(emp);

    listEl.innerHTML = `
    <div class="bonus-card grade-${emp.attendanceGrade}">
        <div class="bonus-card-header">
            <div><span class="bonus-card-name">${escapeHTML(emp.name)}</span><span class="bonus-card-dept">${escapeHTML(emp.department || '-')} (${escapeHTML(emp.employeeNumber)})</span></div>
            <span class="bonus-grade-badge bonus-grade-${emp.attendanceGrade}">出勤 ${emp.attendanceGrade} (${GRADE_LABELS[emp.attendanceGrade]})</span>
        </div>
        <div class="bonus-data-grid">
            <div><span class="label">遲到</span></div><div><span class="value">${emp.lateCount} 次</span></div>
            <div><span class="label">請假</span></div><div><span class="value">${emp.leaveDays} 天</span></div>
            <div><span class="label">底薪</span></div><div><span class="value">$${(emp.baseSalary || 0).toLocaleString()}</span></div>
            <div><span class="label">年資比例</span></div><div><span class="value">${(emp.tenureRatio * 100).toFixed(0)}%</span></div>
        </div>
        <div class="bonus-controls" style="margin-bottom:10px;">
            <label style="font-size:12px;font-weight:700;color:#4b5563;white-space:nowrap;">績效評等</label>
            <select onchange="updatePerformance('${emp.id}', this.value)">
                ${['S','A','B'].map(r => '<option value="' + r + '"' + (c.perfRating === r ? ' selected' : '') + '>' + r + ' (' + PERF_LABELS[r] + ')</option>').join('')}
            </select>
            <span style="font-size:13px;font-weight:800;color:#4F46E5;white-space:nowrap;">x${c.multiplier}</span>
        </div>
        <div class="bonus-breakdown">
            <div class="row" style="font-size:11px;color:#94A3B8;padding-bottom:6px;">
                <span><a href="salary.html" style="color:#4F46E5;text-decoration:underline;">底薪$${(emp.baseSalary||0).toLocaleString()}</a> x <a onclick="showPage('employeePage')" style="color:#4F46E5;text-decoration:underline;cursor:pointer;">年資${(emp.tenureRatio*100).toFixed(0)}%</a> x 倍率${c.multiplier}</span>
                <span>$${c.baseAmount.toLocaleString()}</span>
            </div>
            ${c.fullAtt > 0 ? '<div class="row"><span class="plus">+ 全勤獎金</span><span class="plus">+$' + c.fullAtt.toLocaleString() + '</span></div>' : ''}
            ${c.latePen > 0 ? '<div class="row"><span class="minus">- 遲到扣款 (' + emp.lateCount + 'x$' + LATE_PENALTY_PER + ')</span><span class="minus">-$' + c.latePen.toLocaleString() + '</span></div>' : ''}
            ${c.manualAdj !== 0 ? '<div class="row"><span>' + (c.manualAdj > 0 ? '+' : '') + ' 手動調整</span><span>' + (c.manualAdj > 0 ? '+' : '') + '$' + c.manualAdj.toLocaleString() + '</span></div>' : ''}
            <div class="row total"><span>最終金額</span><span>$${c.finalAmount.toLocaleString()}</span></div>
        </div>
        <div class="bonus-controls">
            <label style="font-size:12px;font-weight:700;color:#4b5563;white-space:nowrap;">手動調整</label>
            <input type="text" inputmode="numeric" placeholder="±金額" value="${c.manualAdj ? c.manualAdj.toLocaleString() : ''}" onchange="updateAdjustment('${emp.id}', this.value)">
        </div>
    </div>`;
}

function renderAllBonusSummaryTable() {
    const listEl = document.getElementById('bonusList');
    if (!listEl) return;
    let html = '<div style="overflow-x:auto;"><table class="matrix-table"><thead><tr><th style="text-align:left;">姓名</th><th>出勤</th><th>績效</th><th>倍率</th><th style="text-align:right;">獎金</th></tr></thead><tbody>';
    bonusEmployees.forEach(emp => {
        const c = calculateBonus(emp);
        html += `<tr style="cursor:pointer;" onclick="document.getElementById('bonusEmpDropdown').value='${emp.id}';renderSelectedBonusCard();">
            <td style="text-align:left;font-weight:700;">${escapeHTML(emp.name)}</td>
            <td><span class="bonus-grade-badge bonus-grade-${emp.attendanceGrade}" style="font-size:10px;padding:2px 6px;">${emp.attendanceGrade}</span></td>
            <td>${c.perfRating}</td>
            <td>x${c.multiplier}</td>
            <td style="text-align:right;font-weight:700;">$${c.finalAmount.toLocaleString()}</td>
        </tr>`;
    });
    html += '</tbody></table></div>';
    listEl.innerHTML = html;
}

export function updatePerformance(empId, rating) {
    bonusPerformance[empId] = rating;
    populateBonusEmpDropdown();
    renderSelectedBonusCard();
    updateBonusSummary();
}

export function updateAdjustment(empId, value) {
    const val = parseMoney(value);
    bonusAdjustments[empId] = val;
    populateBonusEmpDropdown();
    renderSelectedBonusCard();
    updateBonusSummary();
}

function updateBonusSummary() {
    let total = 0, count = 0;
    bonusEmployees.forEach(emp => { const c = calculateBonus(emp); if (c.finalAmount > 0) { count++; total += c.finalAmount; } });
    document.getElementById('eligibleCount').textContent = count;
    document.getElementById('totalBudget').textContent = `$${total.toLocaleString()}`;
    document.getElementById('avgBonus').textContent = count > 0 ? `$${Math.round(total / count).toLocaleString()}` : '$0';
}

export function toggleMatrixRef() {
    const body = document.getElementById('matrixRefBody');
    const arrow = document.getElementById('matrixRefArrow');
    if (body.style.display === 'none') { body.style.display = 'block'; arrow.textContent = '▲'; }
    else { body.style.display = 'none'; arrow.textContent = '▼'; }
}

function renderMatrixRefTable() {
    const el = document.getElementById('matrixRefBody');
    if (!el) return;
    let html = '<table class="matrix-table"><thead><tr><th>績效＼出勤</th>';
    ['A','B','C'].forEach(g => { html += `<th>${g} (${GRADE_LABELS[g]})</th>`; });
    html += '</tr></thead><tbody>';
    ['S','A','B'].forEach(p => {
        html += `<tr><th>${p} (${PERF_LABELS[p]})</th>`;
        ['A','B','C'].forEach(g => { html += `<td>${BONUS_MATRIX[p][g]}x</td>`; });
        html += '</tr>';
    });
    html += '</tbody></table><div style="font-size:11px;color:#94A3B8;">公式: 底薪 x 年資比 x 矩陣倍率 + 全勤$3,000(A級) - 遲到$200/次 + 手動調整</div>';
    el.innerHTML = html;
}

export async function saveAllBonuses() {
    const yearEl = document.getElementById('bonusYear');
    if (!yearEl) return;
    const year = parseInt(yearEl.value);
    const btn = document.getElementById('saveAllBonusBtn');
    if (!confirm(`確定要儲存 ${year} 年全部員工的獎金資料？`)) return;
    setBtnLoading(btn, true);
    try {
        const records = bonusEmployees.map(emp => {
            const c = calculateBonus(emp);
            return {
                employee_id: emp.id, year,
                calculated_bonus: c.baseAmount,
                adjusted_bonus: c.finalAmount,
                final_bonus: c.finalAmount,
                manager_adjustment: c.manualAdj,
                months_worked: Math.round(emp.tenureRatio * 12 * 10) / 10,
                is_approved: true,
                status: 'approved',
                ai_recommendation: JSON.stringify({ attendance_grade: emp.attendanceGrade, performance_rating: c.perfRating, matrix_multiplier: c.multiplier, full_attendance_bonus: c.fullAtt, late_penalty: c.latePen, base_salary: emp.baseSalary, tenure_ratio: emp.tenureRatio }),
                updated_at: new Date().toISOString()
            };
        });
        const { error } = await sb.from('annual_bonus').upsert(records, { onConflict: 'employee_id,year' });
        if (error) throw error;
        writeAuditLog('save_bonus', 'annual_bonus', null, `${year}年獎金`, { count: records.length, total: records.reduce((s, r) => s + r.final_bonus, 0) });
        showToast(`✅ 已儲存 ${records.length} 筆獎金資料`);
    } catch (err) {
        console.error('Save bonus failed:', err);
        showToast('❌ 儲存失敗: ' + friendlyError(err));
    } finally {
        setBtnLoading(btn, false, '💾 儲存全部獎金');
    }
}

export function exportBonusCSV() {
    const yearEl = document.getElementById('bonusYear');
    if (!yearEl) return;
    const year = parseInt(yearEl.value);
    const rows = [['工號','姓名','部門','底薪','年資比','出勤等級','績效評等','矩陣倍數','基本獎金','全勤獎金','遲到扣款','手動調整','最終獎金']];
    bonusEmployees.forEach(emp => {
        const c = calculateBonus(emp);
        rows.push([emp.employeeNumber, emp.name, emp.department || '-', emp.baseSalary, (emp.tenureRatio * 100).toFixed(0) + '%', emp.attendanceGrade + '(' + GRADE_LABELS[emp.attendanceGrade] + ')', c.perfRating + '(' + PERF_LABELS[c.perfRating] + ')', c.multiplier, c.baseAmount, c.fullAtt, c.latePen, c.manualAdj, c.finalAmount]);
    });
    const csv = '\uFEFF' + rows.map(r => r.map(c => `"${String(c ?? '').replace(/"/g, '""')}"`).join(',')).join('\n');
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8;' }));
    a.download = `獎金試算_${year}.csv`;
    a.click();
    showToast(`✅ 獎金試算_${year}.csv（${rows.length - 1} 筆）`);
}

// ===== 薪資發放 =====
export function initPayrollPage() {
    const yEl = document.getElementById('payrollYear');
    const mEl = document.getElementById('payrollMonth');
    if (yEl.options.length > 0) return;
    const now = new Date();
    const cy = now.getFullYear();
    for (let y = cy; y >= cy - 2; y--) yEl.innerHTML += `<option value="${y}">${y} 年</option>`;
    for (let m = 1; m <= 12; m++) mEl.innerHTML += `<option value="${m}">${m} 月</option>`;
    const prev = new Date(cy, now.getMonth() - 1, 1);
    yEl.value = prev.getFullYear();
    mEl.value = prev.getMonth() + 1;
    loadSalarySettingList();
}

export function toggleSalarySettingPanel() {
    const panel = document.getElementById('salarySettingPanel');
    const arrow = document.getElementById('salaryPanelArrow');
    if (panel.style.display === 'none') {
        panel.style.display = 'block'; arrow.textContent = '▲';
    } else {
        panel.style.display = 'none'; arrow.textContent = '▼';
    }
}

export async function loadSalarySettingList() {
    const listEl = document.getElementById('salarySettingList');
    try {
        const [empRes, ssRes] = await Promise.all([
            sb.from('employees').select('id, name, employee_number, department').eq('is_active', true).order('department'),
            sb.from('salary_settings').select('employee_id, salary_type, base_salary').eq('is_current', true)
        ]);
        const ssMap = {};
        (ssRes.data || []).forEach(s => { ssMap[s.employee_id] = s; });
        const typeLabel = { monthly: '月薪', daily: '日薪', hourly: '時薪' };
        const emps = empRes.data || [];
        if (emps.length === 0) { listEl.innerHTML = '<p style="text-align:center;color:#94A3B8;">無員工</p>'; return; }

        listEl.innerHTML = emps.map(emp => {
            const ss = ssMap[emp.id];
            const salaryText = ss ? `${typeLabel[ss.salary_type] || '月薪'} ${formatNT(ss.base_salary)}` : '<span style="color:#EF4444;">未設定</span>';
            return `<div style="display:flex;justify-content:space-between;align-items:center;padding:8px 4px;border-bottom:1px solid #F1F5F9;">
                <div>
                    <span style="font-weight:600;">${escapeHTML(emp.name)}</span>
                    <span style="color:#94A3B8;font-size:11px;margin-left:4px;">${emp.department || ''}</span>
                </div>
                <div style="display:flex;align-items:center;gap:8px;">
                    <span style="font-size:12px;color:#64748B;">${salaryText}</span>
                    <button onclick="openSalarySettingModal('${emp.id}','${escapeHTML(emp.name)}')" style="padding:4px 10px;border:1px solid #D1FAE5;border-radius:6px;background:#ECFDF5;font-size:11px;font-weight:700;cursor:pointer;color:#059669;">設定</button>
                </div>
            </div>`;
        }).join('');
    } catch(e) { listEl.innerHTML = '<p style="color:#EF4444;text-align:center;">載入失敗</p>'; console.error(e); }
}

export async function loadPayrollData() {
    const year = parseInt(document.getElementById('payrollYear').value);
    const month = parseInt(document.getElementById('payrollMonth').value);
    const startDate = `${year}-${String(month).padStart(2,'0')}-01`;
    const endDay = new Date(year, month, 0).getDate();
    const endDate = `${year}-${String(month).padStart(2,'0')}-${String(endDay).padStart(2,'0')}`;

    const loadEl = document.getElementById('payrollLoading');
    const sumEl = document.getElementById('payrollSummary');
    const selEl = document.getElementById('payrollEmpSelector');
    const actEl = document.getElementById('payrollActions');
    const contentEl = document.getElementById('payrollContent');
    const warnEl = document.getElementById('payrollPublishedWarn');
    loadEl.style.display = 'block';
    sumEl.style.display = 'none';
    selEl.style.display = 'none';
    actEl.style.display = 'none';
    contentEl.innerHTML = '';
    warnEl.style.display = 'none';
    payrollAdjustments = {};

    const btn = document.getElementById('calcPayrollBtn');
    const origText = btn.textContent;
    btn.disabled = true; btn.textContent = '⏳ 計算中...';

    try {
        const [empRes, salaryRes, attRes, leaveRes, otRes, existRes, bracketRes] = await Promise.all([
            sb.from('employees').select('id, name, employee_number, department, is_active').eq('is_active', true),
            sb.from('salary_settings').select('*').eq('is_current', true),
            sb.from('attendance').select('employee_id, date, is_late, total_work_hours, overtime_hours, check_in_time, check_out_time').gte('date', startDate).lte('date', endDate),
            sb.from('leave_requests').select('employee_id, days, leave_type').eq('status', 'approved').gte('start_date', startDate).lte('end_date', endDate),
            sb.from('overtime_requests').select('employee_id, hours, ot_date').eq('status', 'approved').gte('ot_date', startDate).lte('ot_date', endDate).then(r => r).catch(() => ({ data: [] })),
            sb.from('payroll').select('*').eq('year', year).eq('month', month),
            sb.from('insurance_brackets').select('*').eq('is_active', true).order('salary_min').then(r => r).catch(() => ({ data: [] }))
        ]);

        payrollBrackets = bracketRes.data || [];

        const salaryMap = {};
        (salaryRes.data || []).forEach(s => { salaryMap[s.employee_id] = s; });

        const attMap = {};
        (attRes.data || []).forEach(a => {
            if (!attMap[a.employee_id]) attMap[a.employee_id] = [];
            attMap[a.employee_id].push(a);
        });

        const leaveMap = {};
        (leaveRes.data || []).forEach(l => {
            if (!leaveMap[l.employee_id]) leaveMap[l.employee_id] = { total: 0, personal: 0 };
            leaveMap[l.employee_id].total += (l.days || 0);
            if (l.leave_type === 'personal') leaveMap[l.employee_id].personal += (l.days || 0);
        });

        const otMap = {};
        if ((otRes.data || []).length > 0) {
            (otRes.data).forEach(o => {
                otMap[o.employee_id] = (otMap[o.employee_id] || 0) + (o.hours || 0);
            });
        } else {
            (attRes.data || []).forEach(a => {
                if (a.overtime_hours > 0) {
                    otMap[a.employee_id] = (otMap[a.employee_id] || 0) + a.overtime_hours;
                }
            });
        }

        const existMap = {};
        (existRes.data || []).forEach(p => {
            existMap[p.employee_id] = p;
            if (p.manual_adjustment) {
                payrollAdjustments[p.employee_id] = { amount: p.manual_adjustment || 0, note: p.adjustment_note || '' };
            }
        });

        payrollIsPublished = (existRes.data || []).some(p => p.is_published);
        if (payrollIsPublished) warnEl.style.display = 'block';

        payrollEmployees = (empRes.data || []).map(emp => {
            const ss = salaryMap[emp.id];
            if (!ss) return null;
            const atts = attMap[emp.id] || [];
            const leaves = leaveMap[emp.id] || { total: 0, personal: 0 };
            const otHours = otMap[emp.id] || 0;
            return calcEmployeePayroll(emp, ss, atts, leaves, otHours, year, month);
        }).filter(Boolean);

        populatePayrollDropdown();
        renderPayrollSummary();
        renderPayrollView();

        loadEl.style.display = 'none';
        sumEl.style.display = 'block';
        selEl.style.display = 'block';
        actEl.style.display = 'flex';
    } catch(e) {
        loadEl.style.display = 'none';
        contentEl.innerHTML = `<p style="text-align:center;color:#DC2626;padding:20px;">❌ 計算失敗：${e.message}</p>`;
    } finally {
        btn.disabled = false; btn.textContent = origText;
    }
}

function prLookupBracket(salary) {
    if (payrollBrackets.length === 0) return null;
    const b = payrollBrackets.find(r => salary >= r.salary_min && salary <= r.salary_max);
    return b || payrollBrackets[payrollBrackets.length - 1];
}

function calcEmployeePayroll(emp, ss, atts, leaves, otHours, year, month) {
    const salaryType = ss.salary_type || 'monthly';
    const baseSalary = ss.base_salary || 0;
    const mealAllowance = ss.meal_allowance || 0;
    const posAllowance = ss.position_allowance || 0;
    const fullAttBonus = ss.full_attendance_bonus || 0;
    const pensionRate = ss.pension_self_rate || 0;
    const taxRate = ss.tax_rate || 5;

    const actualDays = atts.filter(a => a.check_in_time).length;
    const lateCount = atts.filter(a => a.is_late).length;
    const totalWorkHours = atts.reduce((s, a) => s + (a.total_work_hours || 0), 0);
    const leaveDays = leaves.total;
    const personalLeaveDays = leaves.personal;

    let monthSalary, dailyRate, hourlyRate;
    if (salaryType === 'monthly') {
        monthSalary = baseSalary;
        dailyRate = Math.round(baseSalary / 30);
        hourlyRate = Math.round(dailyRate / 8);
    } else if (salaryType === 'daily') {
        dailyRate = baseSalary;
        hourlyRate = Math.round(dailyRate / 8);
        monthSalary = dailyRate * actualDays;
    } else {
        hourlyRate = baseSalary;
        dailyRate = hourlyRate * 8;
        monthSalary = Math.round(hourlyRate * totalWorkHours);
    }

    const mealAmount = mealAllowance;
    const posAmount = posAllowance;
    const hasFullAtt = (lateCount === 0 && leaveDays === 0);
    const fullAttAmount = hasFullAtt ? fullAttBonus : 0;

    let otPay = 0;
    if (otHours > 0) {
        const h1 = Math.min(otHours, 2);
        const h2 = Math.max(Math.min(otHours - 2, 2), 0);
        otPay = Math.round(hourlyRate * 1.34 * h1) + Math.round(hourlyRate * 1.67 * h2);
    }

    const gross = monthSalary + otPay + fullAttAmount + mealAmount + posAmount;

    const bracket = prLookupBracket(salaryType === 'monthly' ? baseSalary : monthSalary);
    let laborIns = 0, healthIns = 0;
    if (bracket) {
        laborIns = Math.round(bracket.insured_amount * (bracket.labor_rate || 0.125) * (bracket.labor_employee_share || 0.2));
        healthIns = Math.round(bracket.insured_amount * (bracket.health_rate || 0.0517) * (bracket.health_employee_share || 0.3));
    } else {
        laborIns = Math.round(monthSalary * 0.125 * 0.2);
        healthIns = Math.round(monthSalary * 0.0517 * 0.3);
    }

    const pensionSelf = Math.round(monthSalary * pensionRate / 100);
    const incomeTax = Math.round(gross * taxRate / 100);
    const lateDed = lateCount * 100;
    const personalLeaveDed = Math.round(dailyRate * personalLeaveDays);
    const adj = payrollAdjustments[emp.id]?.amount || 0;
    const totalDeduct = laborIns + healthIns + pensionSelf + incomeTax + lateDed + personalLeaveDed - adj;
    const net = gross - totalDeduct;

    return {
        employee_id: emp.id, name: emp.name, employee_number: emp.employee_number,
        department: emp.department || '', year, month,
        salary_type: salaryType, base_salary: monthSalary,
        overtime_pay: otPay, full_attendance_bonus: fullAttAmount,
        meal_allowance: mealAmount, position_allowance: posAmount, night_allowance: 0,
        late_deduction: lateDed, absence_deduction: 0, personal_leave_deduction: personalLeaveDed,
        labor_insurance: laborIns, health_insurance: healthIns,
        pension_self: pensionSelf, income_tax: incomeTax,
        manual_adjustment: adj, adjustment_note: payrollAdjustments[emp.id]?.note || '',
        total_deduction: totalDeduct, gross_salary: gross, net_salary: net,
        calculation_details: {
            salary_type: salaryType, original_base: baseSalary,
            actual_days: actualDays, late_count: lateCount,
            leave_days: leaveDays, personal_leave_days: personalLeaveDays,
            overtime_hours: otHours, total_work_hours: Math.round(totalWorkHours * 10) / 10,
            daily_rate: dailyRate, hourly_rate: hourlyRate,
            pension_self_rate: pensionRate, tax_rate: taxRate, full_attendance: hasFullAtt
        }
    };
}

function populatePayrollDropdown() {
    const sel = document.getElementById('payrollEmpDropdown');
    const prev = sel.value;
    sel.innerHTML = '<option value="_all">📋 全部員工總覽</option>';
    payrollEmployees.forEach(emp => {
        sel.innerHTML += `<option value="${emp.employee_id}">${emp.employee_number} ${emp.name}（${emp.department}）— ${formatNT(emp.net_salary)}</option>`;
    });
    if (prev) sel.value = prev;
}

function renderPayrollSummary() {
    const total = payrollEmployees.reduce((s, e) => s + e.net_salary, 0);
    const avg = payrollEmployees.length > 0 ? Math.round(total / payrollEmployees.length) : 0;
    document.getElementById('prEmpCount').textContent = payrollEmployees.length;
    document.getElementById('prTotalNet').textContent = formatNT(total);
    document.getElementById('prAvgNet').textContent = formatNT(avg);
    document.getElementById('prStatus').textContent = payrollIsPublished ? '✅ 已發布' : '📝 草稿';
}

export function renderPayrollView() {
    const sel = document.getElementById('payrollEmpDropdown').value;
    if (sel === '_all') {
        renderAllPayrollTable();
    } else {
        renderPayrollCard(sel);
    }
}

function renderAllPayrollTable() {
    const el = document.getElementById('payrollContent');
    if (payrollEmployees.length === 0) {
        el.innerHTML = '<p style="text-align:center;color:#94A3B8;padding:20px;">無資料（請確認員工已設定薪資）</p>';
        return;
    }
    let html = '<div style="overflow-x:auto;"><table style="width:100%;border-collapse:collapse;font-size:12px;background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,0.08);">';
    html += '<thead><tr style="background:#F1F5F9;">';
    html += '<th style="padding:10px 8px;text-align:left;font-weight:800;color:#475569;">姓名</th>';
    html += '<th style="padding:10px 4px;text-align:right;font-weight:800;color:#475569;">底薪</th>';
    html += '<th style="padding:10px 4px;text-align:right;font-weight:800;color:#475569;">加班</th>';
    html += '<th style="padding:10px 4px;text-align:right;font-weight:800;color:#475569;">扣款</th>';
    html += '<th style="padding:10px 8px;text-align:right;font-weight:800;color:#059669;">實發</th>';
    html += '</tr></thead><tbody>';

    payrollEmployees.forEach(emp => {
        html += `<tr onclick="document.getElementById('payrollEmpDropdown').value='${emp.employee_id}';renderPayrollView();" style="cursor:pointer;border-bottom:1px solid #F1F5F9;transition:background 0.15s;" onmouseover="this.style.background='#F8FAFC'" onmouseout="this.style.background=''">`;
        html += `<td style="padding:10px 8px;"><div style="font-weight:700;color:#0F172A;">${emp.name}</div><div style="font-size:11px;color:#94A3B8;">${emp.employee_number} · ${emp.department}</div></td>`;
        html += `<td style="padding:10px 4px;text-align:right;color:#334155;">${Math.round(emp.base_salary).toLocaleString()}</td>`;
        html += `<td style="padding:10px 4px;text-align:right;color:#0369A1;">${emp.overtime_pay > 0 ? '+' + Math.round(emp.overtime_pay).toLocaleString() : '-'}</td>`;
        html += `<td style="padding:10px 4px;text-align:right;color:#DC2626;">-${Math.round(emp.total_deduction).toLocaleString()}</td>`;
        html += `<td style="padding:10px 8px;text-align:right;font-weight:900;color:#059669;">${Math.round(emp.net_salary).toLocaleString()}</td>`;
        html += '</tr>';
    });

    html += '</tbody></table></div>';
    el.innerHTML = html;
}

function renderPayrollCard(empId) {
    const el = document.getElementById('payrollContent');
    const emp = payrollEmployees.find(e => e.employee_id === empId);
    if (!emp) { el.innerHTML = '<p style="text-align:center;color:#94A3B8;">找不到此員工</p>'; return; }

    const cd = emp.calculation_details || {};
    const typeLabel = { monthly: '月薪制', daily: '日薪制', hourly: '時薪制' };

    const incomeItems = [
        { label: '基本薪資', value: emp.base_salary, desc: cd.salary_type === 'monthly' ? '固定月薪' : cd.salary_type === 'daily' ? `日薪 ${cd.original_base?.toLocaleString()} × ${cd.actual_days}天` : `時薪 ${cd.original_base?.toLocaleString()} × ${cd.total_work_hours}h` },
        { label: '加班費', value: emp.overtime_pay, desc: cd.overtime_hours > 0 ? `${cd.overtime_hours}小時` : '' },
        { label: '全勤獎金', value: emp.full_attendance_bonus, desc: cd.full_attendance ? '✅ 達成' : '❌ 未達成' },
        { label: '伙食津貼', value: emp.meal_allowance, desc: '每月固定' },
        { label: '職務加給', value: emp.position_allowance, desc: '每月固定' },
    ].filter(i => i.value > 0);

    const deductItems = [
        { label: '勞保自付', value: emp.labor_insurance, desc: '投保級距×12.5%×20%' },
        { label: '健保自付', value: emp.health_insurance, desc: '投保級距×5.17%×30%' },
        { label: '勞退自提', value: emp.pension_self, desc: cd.pension_self_rate > 0 ? `月薪×${cd.pension_self_rate}%` : '' },
        { label: '所得稅', value: emp.income_tax, desc: `總收入×${cd.tax_rate}%` },
        { label: '遲到扣款', value: emp.late_deduction, desc: cd.late_count > 0 ? `${cd.late_count}次×$100` : '' },
        { label: '事假扣款', value: emp.personal_leave_deduction, desc: cd.personal_leave_days > 0 ? `日薪×${cd.personal_leave_days}天` : '' },
    ].filter(i => i.value > 0);

    const totalIncome = incomeItems.reduce((s, i) => s + i.value, 0);
    const totalDeduct = deductItems.reduce((s, i) => s + i.value, 0);

    let html = `<div style="background:#fff;border-radius:16px;padding:20px;box-shadow:0 1px 3px rgba(0,0,0,0.08);">`;

    html += `<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px;">`;
    html += `<div><div style="font-size:18px;font-weight:900;color:#0F172A;">${emp.name}</div><div style="font-size:12px;color:#94A3B8;">${emp.employee_number} · ${emp.department} · ${typeLabel[emp.salary_type] || emp.salary_type}</div></div>`;
    html += `<div style="text-align:right;"><div style="font-size:11px;color:#94A3B8;">實發薪資</div><div style="font-size:22px;font-weight:900;color:#059669;">${formatNT(emp.net_salary)}</div></div>`;
    html += `</div>`;

    html += `<div style="display:grid;grid-template-columns:repeat(4,1fr);gap:8px;margin-bottom:16px;">`;
    html += `<div style="text-align:center;background:#F8FAFC;border-radius:10px;padding:10px;"><div style="font-size:11px;color:#94A3B8;">出勤</div><div style="font-size:16px;font-weight:800;color:#0F172A;">${cd.actual_days}天</div></div>`;
    html += `<div style="text-align:center;background:#F8FAFC;border-radius:10px;padding:10px;"><div style="font-size:11px;color:#94A3B8;">遲到</div><div style="font-size:16px;font-weight:800;color:${cd.late_count > 0 ? '#DC2626' : '#059669'};">${cd.late_count}次</div></div>`;
    html += `<div style="text-align:center;background:#F8FAFC;border-radius:10px;padding:10px;"><div style="font-size:11px;color:#94A3B8;">請假</div><div style="font-size:16px;font-weight:800;color:#0F172A;">${cd.leave_days}天</div></div>`;
    html += `<div style="text-align:center;background:#F8FAFC;border-radius:10px;padding:10px;"><div style="font-size:11px;color:#94A3B8;">加班</div><div style="font-size:16px;font-weight:800;color:#0369A1;">${cd.overtime_hours}h</div></div>`;
    html += `</div>`;

    html += `<div style="font-size:13px;font-weight:800;color:#059669;margin-bottom:8px;">📈 收入明細</div>`;
    incomeItems.forEach(i => {
        html += `<div style="display:flex;justify-content:space-between;padding:6px 0;border-bottom:1px solid #F1F5F9;font-size:13px;">`;
        html += `<div><span style="color:#334155;">${i.label}</span><span style="color:#94A3B8;font-size:11px;margin-left:6px;">${i.desc}</span></div>`;
        html += `<div style="font-weight:700;color:#059669;">+${Math.round(i.value).toLocaleString()}</div>`;
        html += `</div>`;
    });
    html += `<div style="display:flex;justify-content:space-between;padding:8px 0;font-size:14px;font-weight:800;color:#059669;border-top:2px solid #059669;margin-top:4px;">`;
    html += `<div>收入小計</div><div>${formatNT(totalIncome)}</div></div>`;

    html += `<div style="font-size:13px;font-weight:800;color:#DC2626;margin:16px 0 8px;">📉 扣款明細</div>`;
    deductItems.forEach(i => {
        html += `<div style="display:flex;justify-content:space-between;padding:6px 0;border-bottom:1px solid #F1F5F9;font-size:13px;">`;
        html += `<div><span style="color:#334155;">${i.label}</span><span style="color:#94A3B8;font-size:11px;margin-left:6px;">${i.desc}</span></div>`;
        html += `<div style="font-weight:700;color:#DC2626;">-${Math.round(i.value).toLocaleString()}</div>`;
        html += `</div>`;
    });
    html += `<div style="display:flex;justify-content:space-between;padding:8px 0;font-size:14px;font-weight:800;color:#DC2626;border-top:2px solid #DC2626;margin-top:4px;">`;
    html += `<div>扣款小計</div><div>-${formatNT(totalDeduct)}</div></div>`;

    html += `<div style="font-size:13px;font-weight:800;color:#7C3AED;margin:16px 0 8px;">✏️ 手動調整</div>`;
    html += `<div style="display:flex;gap:8px;align-items:center;">`;
    html += `<input id="prAdj_${emp.employee_id}" type="text" inputmode="numeric" value="${(emp.manual_adjustment || 0) !== 0 ? emp.manual_adjustment.toLocaleString() : ''}" placeholder="正數=加給，負數=扣款" style="flex:1;padding:10px;border:1px solid #E5E7EB;border-radius:10px;font-size:13px;" onchange="updatePayrollAdjustment('${emp.employee_id}')">`;
    html += `<input id="prAdjNote_${emp.employee_id}" type="text" value="${emp.adjustment_note || ''}" placeholder="備註" style="width:120px;padding:10px;border:1px solid #E5E7EB;border-radius:10px;font-size:13px;" onchange="updatePayrollAdjustment('${emp.employee_id}')">`;
    html += `</div>`;

    html += `</div>`;
    el.innerHTML = html;

    const adjEl = document.getElementById(`prAdj_${emp.employee_id}`);
    if (adjEl) {
        adjEl.addEventListener('input', function() {
            const neg = this.value.startsWith('-');
            const raw = this.value.replace(/[^\d]/g, '');
            this.value = raw ? (neg ? '-' : '') + parseInt(raw, 10).toLocaleString() : '';
        });
    }
}

export function updatePayrollAdjustment(empId) {
    const amtEl = document.getElementById(`prAdj_${empId}`);
    const noteEl = document.getElementById(`prAdjNote_${empId}`);
    const neg = amtEl.value.startsWith('-');
    const raw = parseInt(amtEl.value.replace(/[^\d]/g, ''), 10) || 0;
    const amount = neg ? -raw : raw;
    payrollAdjustments[empId] = { amount, note: noteEl.value || '' };

    const idx = payrollEmployees.findIndex(e => e.employee_id === empId);
    if (idx >= 0) {
        const old = payrollEmployees[idx];
        const adjDiff = amount - (old.manual_adjustment || 0);
        old.manual_adjustment = amount;
        old.adjustment_note = noteEl.value || '';
        old.total_deduction = old.total_deduction - adjDiff;
        old.net_salary = old.gross_salary - old.total_deduction;
        payrollEmployees[idx] = old;
    }

    renderPayrollSummary();
    populatePayrollDropdown();
    document.getElementById('payrollEmpDropdown').value = empId;
}

export async function saveAllPayroll() {
    if (payrollEmployees.length === 0) { showToast('⚠️ 無資料可儲存'); return; }
    const year = parseInt(document.getElementById('payrollYear').value);
    const month = parseInt(document.getElementById('payrollMonth').value);

    if (!confirm(`確定儲存 ${year}年${month}月 共 ${payrollEmployees.length} 人薪資（草稿）？`)) return;

    const btn = document.getElementById('savePayrollBtn');
    btn.disabled = true; btn.textContent = '⏳ 儲存中...';

    try {
        const records = payrollEmployees.map(emp => ({
            employee_id: emp.employee_id, year: emp.year, month: emp.month,
            salary_type: emp.salary_type, base_salary: emp.base_salary,
            overtime_pay: emp.overtime_pay, bonus: 0,
            full_attendance_bonus: emp.full_attendance_bonus,
            meal_allowance: emp.meal_allowance, position_allowance: emp.position_allowance,
            night_allowance: emp.night_allowance,
            late_deduction: emp.late_deduction, absence_deduction: emp.absence_deduction,
            personal_leave_deduction: emp.personal_leave_deduction,
            labor_insurance: emp.labor_insurance, health_insurance: emp.health_insurance,
            pension_self: emp.pension_self, income_tax: emp.income_tax,
            manual_adjustment: emp.manual_adjustment, adjustment_note: emp.adjustment_note,
            total_deduction: emp.total_deduction, gross_salary: emp.gross_salary,
            net_salary: emp.net_salary, calculation_details: emp.calculation_details,
            is_published: false, updated_at: new Date().toISOString()
        }));

        const { error } = await sb.from('payroll').upsert(records, { onConflict: 'employee_id,year,month' });
        if (error) throw error;

        writeAuditLog('save_payroll', 'payroll', null, `${year}年${month}月薪資草稿`, {
            count: records.length, total: records.reduce((s, r) => s + r.net_salary, 0)
        });

        payrollIsPublished = false;
        renderPayrollSummary();
        showToast(`✅ 已儲存 ${records.length} 筆薪資（草稿）`);
    } catch(e) {
        showToast('❌ 儲存失敗：' + friendlyError(e));
    } finally {
        btn.disabled = false; btn.textContent = '💾 儲存全部（草稿）';
    }
}

export async function publishPayroll() {
    if (payrollEmployees.length === 0) { showToast('⚠️ 請先計算並儲存薪資'); return; }
    const year = parseInt(document.getElementById('payrollYear').value);
    const month = parseInt(document.getElementById('payrollMonth').value);

    if (!confirm(`⚠️ 確定發布 ${year}年${month}月 薪資？\n\n發布後員工將在薪資頁面看到明細。`)) return;

    const btn = document.getElementById('publishPayrollBtn');
    btn.disabled = true; btn.textContent = '⏳ 發布中...';

    try {
        const records = payrollEmployees.map(emp => ({
            employee_id: emp.employee_id, year: emp.year, month: emp.month,
            salary_type: emp.salary_type, base_salary: emp.base_salary,
            overtime_pay: emp.overtime_pay, bonus: 0,
            full_attendance_bonus: emp.full_attendance_bonus,
            meal_allowance: emp.meal_allowance, position_allowance: emp.position_allowance,
            night_allowance: emp.night_allowance,
            late_deduction: emp.late_deduction, absence_deduction: emp.absence_deduction,
            personal_leave_deduction: emp.personal_leave_deduction,
            labor_insurance: emp.labor_insurance, health_insurance: emp.health_insurance,
            pension_self: emp.pension_self, income_tax: emp.income_tax,
            manual_adjustment: emp.manual_adjustment, adjustment_note: emp.adjustment_note,
            total_deduction: emp.total_deduction, gross_salary: emp.gross_salary,
            net_salary: emp.net_salary, calculation_details: emp.calculation_details,
            is_published: true, updated_at: new Date().toISOString()
        }));

        const { error } = await sb.from('payroll').upsert(records, { onConflict: 'employee_id,year,month' });
        if (error) throw error;

        writeAuditLog('publish_payroll', 'payroll', null, `${year}年${month}月薪資發布`, {
            count: records.length, total: records.reduce((s, r) => s + r.net_salary, 0)
        });

        payrollIsPublished = true;
        renderPayrollSummary();
        document.getElementById('payrollPublishedWarn').style.display = 'block';
        showToast(`✅ ${year}年${month}月 薪資已發布（${records.length} 人）`);
    } catch(e) {
        showToast('❌ 發布失敗：' + friendlyError(e));
    } finally {
        btn.disabled = false; btn.textContent = '📢 發布薪資（員工可見）';
    }
}

export function exportPayrollCSV() {
    if (payrollEmployees.length === 0) { showToast('⚠️ 請先計算薪資'); return; }
    const year = parseInt(document.getElementById('payrollYear').value);
    const month = parseInt(document.getElementById('payrollMonth').value);
    const typeMap = { monthly: '月薪', daily: '日薪', hourly: '時薪' };

    const rows = [['工號','姓名','部門','薪資類型','底薪','加班費','全勤獎金','伙食津貼','職務加給','勞保','健保','勞退','所得稅','遲到扣','請假扣','手動調整','調整備註','總收入','總扣款','實發']];

    payrollEmployees.forEach(emp => {
        rows.push([
            emp.employee_number, emp.name, emp.department,
            typeMap[emp.salary_type] || emp.salary_type,
            emp.base_salary, emp.overtime_pay, emp.full_attendance_bonus,
            emp.meal_allowance, emp.position_allowance,
            emp.labor_insurance, emp.health_insurance, emp.pension_self, emp.income_tax,
            emp.late_deduction, emp.personal_leave_deduction,
            emp.manual_adjustment, emp.adjustment_note,
            emp.gross_salary, emp.total_deduction, emp.net_salary
        ]);
    });

    const csv = '\uFEFF' + rows.map(r => r.map(c => `"${String(c ?? '').replace(/"/g, '""')}"`).join(',')).join('\n');
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8;' }));
    a.download = `薪資明細_${year}年${month}月.csv`;
    a.click();

    writeAuditLog('export', 'payroll', null, `薪資明細_${year}年${month}月.csv`, { rows: rows.length - 1 });
    showToast(`✅ 薪資明細_${year}年${month}月.csv（${rows.length - 1} 筆）`);
}

// ===== 勞健保級距管理 =====
export async function loadInsuranceBrackets() {
    try {
        const { data, error } = await sb.from('insurance_brackets')
            .select('*').eq('is_active', true).order('salary_min');
        if (error) throw error;
        insBrackets = data || [];
        renderInsTable();

        if (insBrackets.length > 0) {
            const b = insBrackets[0];
            document.getElementById('insLaborRate').value = ((b.labor_rate || 0.125) * 100).toFixed(2);
            document.getElementById('insLaborShare').value = ((b.labor_employee_share || 0.2) * 100).toFixed(2);
            document.getElementById('insHealthRate').value = ((b.health_rate || 0.0517) * 100).toFixed(2);
            document.getElementById('insHealthShare').value = ((b.health_employee_share || 0.3) * 100).toFixed(2);
        }
    } catch(e) { showToast('❌ 載入級距失敗'); console.error(e); }
}

function renderInsTable() {
    document.getElementById('insCount').textContent = insBrackets.length;
    const tbody = document.getElementById('insTableBody');
    if (insBrackets.length === 0) {
        tbody.innerHTML = '<tr><td colspan="4" style="padding:20px;text-align:center;color:#94A3B8;">尚無級距資料</td></tr>';
        return;
    }
    tbody.innerHTML = insBrackets.map(b => `
        <tr style="border-bottom:1px solid #F1F5F9;">
            <td style="padding:6px;text-align:right;">${Number(b.salary_min).toLocaleString()}</td>
            <td style="padding:6px;text-align:right;">${Number(b.salary_max).toLocaleString()}</td>
            <td style="padding:6px;text-align:right;font-weight:600;">${Number(b.insured_amount).toLocaleString()}</td>
            <td style="padding:6px;text-align:center;">
                <span onclick="editInsBracket('${b.id}')" style="cursor:pointer;margin-right:6px;">✏️</span>
                <span onclick="deleteInsBracket('${b.id}')" style="cursor:pointer;">🗑️</span>
            </td>
        </tr>
    `).join('');
}

export function showInsModal(editData) {
    document.getElementById('insEditId').value = editData ? editData.id : '';
    document.getElementById('insModalTitle').textContent = editData ? '編輯級距' : '新增級距';
    document.getElementById('insSalaryMin').value = editData ? editData.salary_min : '';
    document.getElementById('insSalaryMax').value = editData ? editData.salary_max : '';
    document.getElementById('insAmount').value = editData ? editData.insured_amount : '';
    document.getElementById('insModal').style.display = 'block';
}

export function closeInsModal() { document.getElementById('insModal').style.display = 'none'; }

export function editInsBracket(id) {
    const b = insBrackets.find(x => x.id === id);
    if (b) showInsModal(b);
}

export async function saveInsBracket() {
    const id = document.getElementById('insEditId').value;
    const salaryMin = parseFloat(document.getElementById('insSalaryMin').value);
    const salaryMax = parseFloat(document.getElementById('insSalaryMax').value);
    const insuredAmount = parseFloat(document.getElementById('insAmount').value);

    if (isNaN(salaryMin) || isNaN(salaryMax) || isNaN(insuredAmount)) {
        showToast('⚠️ 請填寫完整'); return;
    }

    const laborRate = parseFloat(document.getElementById('insLaborRate').value) / 100;
    const laborShare = parseFloat(document.getElementById('insLaborShare').value) / 100;
    const healthRate = parseFloat(document.getElementById('insHealthRate').value) / 100;
    const healthShare = parseFloat(document.getElementById('insHealthShare').value) / 100;

    const row = {
        salary_min: salaryMin, salary_max: salaryMax, insured_amount: insuredAmount,
        labor_rate: laborRate, labor_employee_share: laborShare,
        health_rate: healthRate, health_employee_share: healthShare, is_active: true
    };

    try {
        if (id) {
            const { error } = await sb.from('insurance_brackets').update(row).eq('id', id);
            if (error) throw error;
            writeAuditLog('update', 'insurance_brackets', id, `投保 ${insuredAmount}`);
        } else {
            const { error } = await sb.from('insurance_brackets').insert(row);
            if (error) throw error;
            writeAuditLog('create', 'insurance_brackets', null, `投保 ${insuredAmount}`);
        }
        closeInsModal();
        showToast('✅ 已儲存');
        loadInsuranceBrackets();
    } catch(e) { showToast('❌ 儲存失敗'); console.error(e); }
}

export async function deleteInsBracket(id) {
    if (!confirm('確定刪除此級距？')) return;
    try {
        const { error } = await sb.from('insurance_brackets').update({ is_active: false }).eq('id', id);
        if (error) throw error;
        writeAuditLog('delete', 'insurance_brackets', id);
        showToast('✅ 已刪除');
        loadInsuranceBrackets();
    } catch(e) { showToast('❌ 刪除失敗'); console.error(e); }
}

export async function updateAllInsRates() {
    if (!confirm('確定將費率套用到所有級距？')) return;
    const laborRate = parseFloat(document.getElementById('insLaborRate').value) / 100;
    const laborShare = parseFloat(document.getElementById('insLaborShare').value) / 100;
    const healthRate = parseFloat(document.getElementById('insHealthRate').value) / 100;
    const healthShare = parseFloat(document.getElementById('insHealthShare').value) / 100;

    if (isNaN(laborRate) || isNaN(laborShare) || isNaN(healthRate) || isNaN(healthShare)) {
        showToast('⚠️ 費率格式錯誤'); return;
    }

    try {
        const { error } = await sb.from('insurance_brackets').update({
            labor_rate: laborRate, labor_employee_share: laborShare,
            health_rate: healthRate, health_employee_share: healthShare
        }).eq('is_active', true);
        if (error) throw error;
        writeAuditLog('update', 'insurance_brackets', null, `費率更新：勞保${(laborRate*100).toFixed(2)}%/${(laborShare*100).toFixed(2)}% 健保${(healthRate*100).toFixed(2)}%/${(healthShare*100).toFixed(2)}%`);
        showToast('✅ 費率已更新');
        loadInsuranceBrackets();
    } catch(e) { showToast('❌ 更新失敗'); console.error(e); }
}
