// ============================================================
// modules/schedules.js — 排班管理、補打卡審核、加班審核、換班審核
// 依賴 common.js 全域: sb, showToast, escapeHTML, friendlyError,
//   fmtDate, writeAuditLog, sendUserNotify
// ============================================================

// ===== 排班管理 =====
let smWeekStart;
(function () {
    const n = new Date(); const dow = n.getDay();
    smWeekStart = new Date(n);
    smWeekStart.setDate(n.getDate() - ((dow + 6) % 7));
    smWeekStart.setHours(0, 0, 0, 0);
})();

let smEmployees = [];
let smScheduleData = {};
let smLeaveData = {};
const SHIFT_TYPES = [null, 'morning', 'afternoon', 'night', 'off'];
const SHIFT_DISPLAY = {
    null: { label: '⬜', bg: '#F8FAFC', color: '#94A3B8', name: '未排' },
    morning: { label: '☀️', bg: '#DBEAFE', color: '#1E40AF', name: '早班' },
    afternoon: { label: '🌤️', bg: '#FEF3C7', color: '#92400E', name: '中班' },
    night: { label: '🌙', bg: '#EDE9FE', color: '#6D28D9', name: '晚班' },
    off: { label: '🏖️', bg: '#ECFDF5', color: '#059669', name: '休假' }
};

export function changeShiftWeek(d) { smWeekStart.setDate(smWeekStart.getDate() + d * 7); loadShiftMgr(); }
export function resetShiftWeek() {
    const n = new Date(); const dow = n.getDay();
    smWeekStart = new Date(n);
    smWeekStart.setDate(n.getDate() - ((dow + 6) % 7));
    smWeekStart.setHours(0, 0, 0, 0);
    loadShiftMgr();
}

function getWeekDates() {
    const dates = [];
    for (let i = 0; i < 7; i++) { const d = new Date(smWeekStart); d.setDate(d.getDate() + i); dates.push(d); }
    return dates;
}

export async function loadShiftMgr() {
    const dates = getWeekDates();
    const startStr = fmtDate(dates[0]);
    const endStr = fmtDate(dates[6]);
    document.getElementById('smWeekLabel').textContent = `${startStr} ~ ${endStr}`;
    document.getElementById('smBody').innerHTML = '<tr><td colspan="8" style="text-align:center;padding:30px;color:#94A3B8;font-size:13px;">⏳ 載入中...</td></tr>';
    document.getElementById('smHead').innerHTML = '';
    document.getElementById('shiftDaySummary').innerHTML = '';
    try {
        const { data: emps } = await sb.from('employees').select('id, name, department').eq('company_id', window.currentCompanyId).eq('is_active', true).order('name');
        smEmployees = emps || [];
        const { data: scheds } = await sb.from('schedules').select('employee_id, date, shift_type_id, shift_types(name, code), employees!inner(company_id)')
            .eq('employees.company_id', window.currentCompanyId)
            .gte('date', startStr).lte('date', endStr);
        smScheduleData = {};
        (scheds || []).forEach(s => {
            const code = s.shift_types?.code || s.shift_types?.name || 'morning';
            smScheduleData[`${s.employee_id}_${s.date}`] = code;
        });
        const { data: lvs } = await sb.from('leave_requests').select('employee_id, start_date, end_date, status, employees!inner(company_id)')
            .eq('employees.company_id', window.currentCompanyId)
            .in('status', ['approved']).or(`and(start_date.lte.${endStr},end_date.gte.${startStr})`);
        smLeaveData = {};
        (lvs || []).forEach(l => {
            const rangeStart = l.start_date > startStr ? l.start_date : startStr;
            const rangeEnd = (l.end_date || l.start_date) < endStr ? (l.end_date || l.start_date) : endStr;
            let cur = new Date(rangeStart + 'T00:00:00');
            const end = new Date(rangeEnd + 'T00:00:00');
            while (cur <= end) {
                smLeaveData[`${l.employee_id}_${fmtDate(cur)}`] = true;
                cur.setDate(cur.getDate() + 1);
            }
        });
    } catch (e) { console.error(e); }
    renderShiftTable();
}

function renderShiftTable() {
    const dates = getWeekDates();
    const wd = ['日', '一', '二', '三', '四', '五', '六'];

    if (smEmployees.length === 0) {
        document.getElementById('smHead').innerHTML = '';
        document.getElementById('smBody').innerHTML = '';
        document.getElementById('shiftDaySummary').innerHTML = `
            <div style="width:100%;text-align:center;padding:40px 20px;">
                <div style="font-size:48px;margin-bottom:12px;">👥</div>
                <div style="font-size:16px;font-weight:800;color:#0F172A;margin-bottom:8px;">尚無員工資料</div>
                <div style="font-size:13px;color:#94A3B8;margin-bottom:16px;">請先到「員工管理」新增員工，才能排班</div>
                <button onclick="showPage('employeePage')" style="padding:12px 24px;border:none;border-radius:10px;background:linear-gradient(135deg,#4F46E5,#7C3AED);color:#fff;font-weight:700;font-size:14px;cursor:pointer;">👉 前往員工管理</button>
            </div>`;
        const w = document.getElementById('shiftStaffWarn');
        if (w) w.style.display = 'none';
        return;
    }

    let headHtml = '<tr><th style="position:sticky;left:0;background:#fff;z-index:2;padding:8px;min-width:60px;text-align:left;border-bottom:2px solid #E5E7EB;font-size:11px;">姓名</th>';
    dates.forEach(d => {
        const isW = d.getDay() === 0 || d.getDay() === 6;
        headHtml += `<th style="padding:6px 4px;min-width:46px;text-align:center;border-bottom:2px solid #E5E7EB;background:${isW ? '#F1F5F9' : '#fff'};">
            <div style="font-size:12px;">${d.getDate()}</div><div style="font-size:10px;color:#94A3B8;">週${wd[d.getDay()]}</div>
        </th>`;
    });
    headHtml += '</tr>';
    document.getElementById('smHead').innerHTML = headHtml;

    let bodyHtml = '';
    smEmployees.forEach(emp => {
        bodyHtml += `<tr><td style="position:sticky;left:0;background:#fff;z-index:1;padding:8px;font-weight:700;font-size:11px;white-space:nowrap;border-bottom:1px solid #F1F5F9;">${emp.name}</td>`;
        dates.forEach(d => {
            const ds = fmtDate(d);
            const key = `${emp.id}_${ds}`;
            const onLeave = smLeaveData[key];
            const shift = smScheduleData[key] || null;
            const disp = SHIFT_DISPLAY[shift] || SHIFT_DISPLAY[null];
            if (onLeave) {
                bodyHtml += `<td style="text-align:center;padding:8px 4px;border-bottom:1px solid #F1F5F9;background:#FEE2E2;font-size:14px;cursor:not-allowed;opacity:0.7;" title="${emp.name} 已請假">🏖️</td>`;
            } else {
                bodyHtml += `<td onclick="cycleShift('${key}')" style="text-align:center;padding:8px 4px;cursor:pointer;border-bottom:1px solid #F1F5F9;background:${disp.bg};font-size:14px;transition:all 0.15s;user-select:none;" title="${emp.name} ${ds} ${disp.name}">${disp.label}</td>`;
            }
        });
        bodyHtml += '</tr>';
    });

    bodyHtml += '<tr style="background:#F8FAFC;font-weight:700;"><td style="position:sticky;left:0;background:#F8FAFC;z-index:1;padding:6px 8px;font-size:10px;color:#64748B;">上班人數</td>';
    let warnDays = [];
    dates.forEach(d => {
        const ds = fmtDate(d);
        const isW = d.getDay() === 0 || d.getDay() === 6;
        let working = 0;
        smEmployees.forEach(emp => {
            const key = `${emp.id}_${ds}`;
            if (smLeaveData[key]) return;
            const shift = smScheduleData[key];
            if (shift && shift !== 'off') working++;
        });
        const low = working > 0 && working <= 2 && !isW;
        if (low) warnDays.push(`${d.getMonth() + 1}/${d.getDate()}(${working}人)`);
        bodyHtml += `<td style="text-align:center;font-size:11px;color:${low ? '#DC2626' : working > 0 ? '#059669' : '#94A3B8'};background:${low ? '#FEF2F2' : '#F8FAFC'};border-bottom:1px solid #F1F5F9;">${working || '-'}</td>`;
    });
    bodyHtml += '</tr>';
    document.getElementById('smBody').innerHTML = bodyHtml;

    let sumHtml = '';
    dates.forEach(d => {
        const ds = fmtDate(d);
        const isW = d.getDay() === 0 || d.getDay() === 6;
        const counts = { morning: 0, afternoon: 0, night: 0, off: 0, leave: 0, unset: 0 };
        smEmployees.forEach(emp => {
            const key = `${emp.id}_${ds}`;
            if (smLeaveData[key]) { counts.leave++; return; }
            const s = smScheduleData[key];
            if (s && counts.hasOwnProperty(s)) counts[s]++;
            else counts.unset++;
        });
        const total = counts.morning + counts.afternoon + counts.night;
        const low = total > 0 && total <= 2 && !isW;
        sumHtml += `<div style="min-width:60px;padding:6px 8px;background:${low ? '#FEF2F2' : '#F8FAFC'};border-radius:8px;text-align:center;flex-shrink:0;${low ? 'border:2px solid #FCA5A5;' : ''}">
            <div style="font-size:10px;font-weight:700;color:#64748B;">${d.getDate()}日</div>
            <div style="font-size:14px;font-weight:900;color:${low ? '#DC2626' : '#0F172A'};">${total}人</div>
            <div style="font-size:9px;color:#94A3B8;">☀${counts.morning} 🌤${counts.afternoon} 🌙${counts.night}</div>
            ${counts.leave > 0 ? `<div style="font-size:9px;color:#EA580C;">假${counts.leave}</div>` : ''}
        </div>`;
    });
    document.getElementById('shiftDaySummary').innerHTML = sumHtml;

    const warnEl = document.getElementById('shiftStaffWarn');
    if (warnDays.length > 0) {
        warnEl.style.display = 'block';
        warnEl.innerHTML = `⚠️ 人手不足警告：${warnDays.join('、')}<br><span style="font-size:11px;opacity:0.7;">建議調整排班或限制請假</span>`;
    } else {
        warnEl.style.display = 'none';
    }
}

export function cycleShift(key) {
    const current = smScheduleData[key] || null;
    const idx = SHIFT_TYPES.indexOf(current);
    smScheduleData[key] = SHIFT_TYPES[(idx + 1) % SHIFT_TYPES.length];
    renderShiftTable();
}

export async function saveSchedule() {
    const statusEl = document.getElementById('smSaveStatus');
    statusEl.style.display = 'block'; statusEl.style.color = '#F59E0B'; statusEl.textContent = '⏳ 儲存中...';
    try {
        const { data: shiftTypes } = await sb.from('shift_types').select('id, code, name').or(`company_id.eq.${window.currentCompanyId},company_id.is.null`);
        const stMap = {};
        (shiftTypes || []).forEach(st => { stMap[st.code || st.name] = st.id; });
        const upserts = [];
        for (const [key, shift] of Object.entries(smScheduleData)) {
            if (!shift) continue;
            const parts = key.split('_');
            const empId = parts[0];
            const date = parts.slice(1).join('-');
            const stId = stMap[shift];
            if (!stId) continue;
            upserts.push({ employee_id: empId, date, shift_type_id: stId });
        }
        if (upserts.length > 0) {
            const { error } = await sb.from('schedules').upsert(upserts, { onConflict: 'employee_id,date' });
            if (error) throw error;
        }
        statusEl.style.color = '#059669'; statusEl.textContent = `✅ 已儲存 ${upserts.length} 筆排班`;
        setTimeout(() => { statusEl.style.display = 'none'; }, 2500);
    } catch (e) {
        console.error(e);
        statusEl.style.color = '#DC2626'; statusEl.textContent = '❌ 儲存失敗: ' + e.message;
    }
}

export async function copyLastWeek() {
    if (!confirm('確定要複製上週排班到本週？\n（已有排班不會被覆蓋）')) return;
    const dates = getWeekDates();
    try {
        const lwStart = new Date(dates[0]); lwStart.setDate(lwStart.getDate() - 7);
        const lwEnd = new Date(dates[6]); lwEnd.setDate(lwEnd.getDate() - 7);
        const { data: lastScheds } = await sb.from('schedules').select('employee_id, date, shift_type_id, shift_types(code, name), employees!inner(company_id)')
            .eq('employees.company_id', window.currentCompanyId)
            .gte('date', fmtDate(lwStart)).lte('date', fmtDate(lwEnd));
        let copied = 0;
        (lastScheds || []).forEach(s => {
            const oldD = new Date(s.date + 'T00:00:00');
            const newD = new Date(oldD); newD.setDate(newD.getDate() + 7);
            const key = `${s.employee_id}_${fmtDate(newD)}`;
            if (!smScheduleData[key]) {
                smScheduleData[key] = s.shift_types?.code || s.shift_types?.name || 'morning';
                copied++;
            }
        });
        renderShiftTable();
        showToast(`📋 已複製上週 ${copied} 筆排班`);
    } catch (e) { console.error(e); showToast('❌ 複製失敗'); }
}

// ===== 補打卡審核 =====
export function switchMakeupTab(status) {
    document.querySelectorAll('#makeupApprovalTabs .tab-btn').forEach(btn => { btn.className = 'tab-btn inactive'; });
    event.target.className = 'tab-btn active';
    loadMakeupApprovals(status);
}

export async function loadMakeupApprovals(status) {
    const listEl = document.getElementById('makeupApprovalList');
    if (!listEl) return;
    listEl.innerHTML = '<p style="text-align:center;color:#666;">載入中...</p>';
    try {
        // 使用 SECURITY DEFINER RPC 繞過 RLS（049 SQL）
        const { data, error } = await sb.rpc('get_pending_makeup_requests', {
            p_company_id: window.currentCompanyId
        });
        if (error) throw error;

        if (!data || data.length === 0) {
            listEl.innerHTML = '<p style="text-align:center;color:#999;">無待審核的補打卡申請</p>';
            return;
        }
        const typeMap = { clock_in: '☀️ 上班', clock_out: '🌙 下班' };
        listEl.innerHTML = data.map(r => `
            <div style="background:#fff;border-radius:14px;padding:14px;margin-bottom:10px;box-shadow:0 1px 3px rgba(0,0,0,0.06);">
                <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;">
                    <span style="font-weight:800;font-size:14px;">${escapeHTML(r.employee_name || '?')}</span>
                    <span style="font-size:11px;color:#94A3B8;">${escapeHTML(r.department || '')} · ${escapeHTML(r.employee_number || '')}</span>
                </div>
                <div style="display:flex;gap:8px;margin-bottom:8px;font-size:13px;">
                    <span style="padding:4px 10px;background:#EFF6FF;border-radius:8px;color:#2563EB;font-weight:700;">📅 ${r.punch_date}</span>
                    <span style="padding:4px 10px;background:#F5F3FF;border-radius:8px;color:#7C3AED;font-weight:700;">${typeMap[r.punch_type] || r.punch_type} ${r.punch_time || ''}</span>
                </div>
                <div style="font-size:12px;color:#64748B;margin-bottom:8px;">${escapeHTML(r.reason || '')}</div>
                <div style="display:flex;gap:8px;">
                    <button onclick="approveMakeupPunch('${r.id}')" style="flex:1;padding:10px;border:none;border-radius:10px;background:#ECFDF5;color:#059669;font-weight:700;font-size:13px;cursor:pointer;">✅ 通過</button>
                    <button onclick="rejectMakeupPunchPrompt('${r.id}')" style="flex:1;padding:10px;border:none;border-radius:10px;background:#FEF2F2;color:#DC2626;font-weight:700;font-size:13px;cursor:pointer;">❌ 拒絕</button>
                </div>
            </div>
        `).join('');
    } catch (e) { console.error(e); listEl.innerHTML = '<p style="text-align:center;color:#ef4444;">載入失敗</p>'; }
}

export async function approveMakeupPunch(id) {
    try {
        const approverId = window.currentAdminEmployee?.id || null;
        const { data: result, error } = await sb.rpc('approve_makeup_request', {
            p_request_id: id,
            p_approver_id: approverId
        });
        if (error) throw error;
        if (result && !result.success) throw new Error(result.error);

        showToast('✅ 已通過並寫入出勤');
        writeAuditLog('approve', 'makeup_punch_requests', id, '');
        loadMakeupApprovals('pending');
    } catch (e) { console.error(e); showToast('❌ 審核失敗: ' + friendlyError(e)); }
}

export function rejectMakeupPunchPrompt(id) {
    const reason = prompt('請輸入拒絕原因（選填）：');
    if (reason === null) return;
    rejectMakeupPunch(id, reason);
}

export async function rejectMakeupPunch(id, reason) {
    try {
        const approverId = window.currentAdminEmployee?.id || null;
        const { data: result, error } = await sb.rpc('reject_makeup_request', {
            p_request_id: id,
            p_approver_id: approverId,
            p_reason: reason || '不符合規定'
        });
        if (error) throw error;
        if (result && !result.success) throw new Error(result.error);

        showToast('❌ 已拒絕');
        loadMakeupApprovals('pending');
    } catch (e) { showToast('❌ 操作失敗: ' + friendlyError(e)); }
}

// ===== 加班審核 =====
export function switchOtTab(status) {
    document.querySelectorAll('#overtimeApprovalTabs .tab-btn').forEach(btn => { btn.className = 'tab-btn inactive'; });
    event.target.className = 'tab-btn active';
    loadOtApprovals(status);
}

export async function loadOtApprovals(status) {
    const el = document.getElementById('otApprovalList');
    if (!el) return;
    el.innerHTML = '<p style="text-align:center;color:#666;">載入中...</p>';
    try {
        // 使用 SECURITY DEFINER RPC 繞過 RLS（050 SQL）
        const { data, error } = await sb.rpc('get_pending_overtime_requests', {
            p_company_id: window.currentCompanyId
        });
        if (error) throw error;

        if (!data || data.length === 0) { el.innerHTML = '<p style="text-align:center;color:#999;">無待審核的加班申請</p>'; return; }
        const compMap = { pay: '💰 加班費', comp_leave: '🏖️ 換補休' };
        el.innerHTML = data.map(r => `
            <div style="background:#fff;border-radius:14px;padding:14px;margin-bottom:10px;box-shadow:0 1px 3px rgba(0,0,0,0.06);">
                <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;">
                    <b>${escapeHTML(r.employee_name || '?')}</b>
                    <span style="font-size:11px;color:#94A3B8;">${escapeHTML(r.department || '')}</span>
                </div>
                <div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:6px;font-size:12px;">
                    <span style="padding:3px 8px;background:#EFF6FF;border-radius:6px;color:#2563EB;font-weight:700;">📅 ${r.ot_date}</span>
                    <span style="padding:3px 8px;background:#F5F3FF;border-radius:6px;color:#7C3AED;font-weight:700;">⏰ ${r.planned_hours || 0}h</span>
                    <span style="padding:3px 8px;background:#ECFDF5;border-radius:6px;color:#059669;font-weight:700;">${compMap[r.compensation_type] || ''}</span>
                </div>
                <div style="font-size:12px;color:#64748B;margin-bottom:6px;">${escapeHTML(r.reason || '')}</div>
                <div style="margin-bottom:8px;">
                    <label style="font-size:12px;font-weight:700;">核准時數：</label>
                    <input type="number" id="otAH_${r.id}" value="${r.planned_hours || 0}" min="0" max="12" step="0.5" style="width:70px;padding:4px;border:1px solid #E5E7EB;border-radius:6px;">h
                </div>
                <div style="display:flex;gap:8px;">
                    <button onclick="approveOt('${r.id}')" style="flex:1;padding:10px;border:none;border-radius:10px;background:#ECFDF5;color:#059669;font-weight:700;cursor:pointer;">✅ 通過</button>
                    <button onclick="rejectOtPrompt('${r.id}')" style="flex:1;padding:10px;border:none;border-radius:10px;background:#FEF2F2;color:#DC2626;font-weight:700;cursor:pointer;">❌ 拒絕</button>
                </div>
            </div>
        `).join('');
    } catch (e) { console.error(e); el.innerHTML = '<p style="text-align:center;color:#ef4444;">載入失敗</p>'; }
}

export async function approveOt(id) {
    const h = parseFloat(document.getElementById(`otAH_${id}`)?.value) || 0;
    if (h <= 0) return showToast('❌ 核准時數需大於 0');
    try {
        const approverId = window.currentAdminEmployee?.id || null;
        const { data: result, error } = await sb.rpc('approve_overtime_request', {
            p_request_id: id,
            p_approver_id: approverId,
            p_approved_hours: h
        });
        if (error) throw error;
        if (result && !result.success) throw new Error(result.error);

        writeAuditLog('approve', 'overtime_requests', id, '', { approved_hours: h });
        showToast('✅ 已通過'); loadOtApprovals('pending');
    } catch (e) { console.error(e); showToast('❌ 審核失敗: ' + friendlyError(e)); }
}
export function rejectOtPrompt(id) { const r = prompt('拒絕原因：'); if (r === null) return; rejectOt(id, r); }
export async function rejectOt(id, reason) {
    try {
        const approverId = window.currentAdminEmployee?.id || null;
        const { data: result, error } = await sb.rpc('reject_overtime_request', {
            p_request_id: id,
            p_approver_id: approverId,
            p_reason: reason || '不符合規定'
        });
        if (error) throw error;
        if (result && !result.success) throw new Error(result.error);

        showToast('❌ 已拒絕'); loadOtApprovals('pending');
    } catch (e) { showToast('❌ 操作失敗: ' + friendlyError(e)); }
}

// ===== 換班審核 =====
export async function loadSwapApprovals() {
    const el = document.getElementById('swapApprovalList');
    if (!el) return;
    el.innerHTML = '<p style="text-align:center;color:#666;">載入中...</p>';
    try {
        const { data } = await sb.from('shift_swap_requests')
            .select('*, requester:employees!shift_swap_requests_requester_id_fkey(name, department, company_id), target:employees!shift_swap_requests_target_id_fkey(name, department)')
            .eq('requester.company_id', window.currentCompanyId)
            .in('status', ['pending_admin', 'approved', 'rejected'])
            .order('created_at', { ascending: false }).limit(20);
        if (!data || data.length === 0) { el.innerHTML = '<p style="text-align:center;color:#999;">無換班申請</p>'; return; }
        const sMap = { pending_admin: '⏳ 待審', approved: '✅ 通過', rejected: '❌ 拒絕' };
        el.innerHTML = data.map(r => `
            <div style="background:#fff;border-radius:14px;padding:14px;margin-bottom:10px;box-shadow:0 1px 3px rgba(0,0,0,0.06);">
                <div style="display:flex;justify-content:space-between;margin-bottom:6px;">
                    <b style="font-size:14px;">${r.requester?.name} ↔ ${r.target?.name}</b>
                    <span style="font-size:11px;color:#94A3B8;">${sMap[r.status] || r.status}</span>
                </div>
                <div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:6px;font-size:12px;">
                    <span style="padding:3px 8px;background:#EFF6FF;border-radius:6px;color:#2563EB;font-weight:700;">📅 ${r.swap_date}</span>
                    <span style="padding:3px 8px;background:#FFF7ED;border-radius:6px;color:#EA580C;font-weight:700;">${r.requester_original_shift || '?'} ↔ ${r.target_original_shift || '?'}</span>
                </div>
                <div style="font-size:11px;color:#64748B;margin-bottom:6px;">✅ 雙方已同意${r.reason ? ' · 原因：' + r.reason : ''}</div>
                ${r.status === 'pending_admin' ? `
                    <div style="display:flex;gap:8px;">
                        <button onclick="approveSwap('${r.id}')" style="flex:1;padding:10px;border:none;border-radius:10px;background:#ECFDF5;color:#059669;font-weight:700;cursor:pointer;">✅ 核准</button>
                        <button onclick="rejectSwap('${r.id}')" style="flex:1;padding:10px;border:none;border-radius:10px;background:#FEF2F2;color:#DC2626;font-weight:700;cursor:pointer;">❌ 拒絕</button>
                    </div>` : ''}
            </div>
        `).join('');
    } catch (e) { el.innerHTML = '<p style="text-align:center;color:#ef4444;">載入失敗</p>'; }
}

export async function approveSwap(id) {
    try {
        const { data: req } = await sb.from('shift_swap_requests')
            .select('*, requester:employees!shift_swap_requests_requester_id_fkey(name, id, company_id), target:employees!shift_swap_requests_target_id_fkey(name, id)')
            .eq('id', id).single();
        if (!req || req.requester?.company_id !== window.currentCompanyId) { showToast('❌ 無權操作此換班'); return; }
        await sb.from('shift_swap_requests').update({
            status: 'approved', approver_id: window.currentAdminEmployee?.id, approved_at: new Date().toISOString()
        }).eq('id', id);
        if (req) {
            const date = req.swap_date;
            const { data: s1 } = await sb.from('schedules').select('id, shift_type_id').eq('employee_id', req.requester_id).eq('date', date).maybeSingle();
            const { data: s2 } = await sb.from('schedules').select('id, shift_type_id').eq('employee_id', req.target_id).eq('date', date).maybeSingle();
            if (s1 && s2) {
                await sb.from('schedules').update({ shift_type_id: s2.shift_type_id }).eq('id', s1.id);
                await sb.from('schedules').update({ shift_type_id: s1.shift_type_id }).eq('id', s2.id);
            }
            writeAuditLog('approve', 'shift_swap_requests', id, `${req.requester?.name} ↔ ${req.target?.name}`, { date });
            if (req.requester?.id) sendUserNotify(req.requester.id, `✅ 換班已核准\n📅 ${date} 班表已自動更新`);
            if (req.target?.id) sendUserNotify(req.target.id, `✅ 換班已核准\n📅 ${date} 班表已自動更新`);
        }
        showToast('✅ 已核准，班表已交換');
        loadSwapApprovals();
    } catch (e) { showToast('❌ 審核失敗：' + friendlyError(e)); }
}

export async function rejectSwap(id) {
    const reason = prompt('拒絕原因：');
    if (reason === null) return;
    try {
        const { data: chk } = await sb.from('shift_swap_requests')
            .select('requester:employees!shift_swap_requests_requester_id_fkey(company_id)')
            .eq('id', id).single();
        if (!chk || chk.requester?.company_id !== window.currentCompanyId) { showToast('❌ 無權操作'); return; }
        await sb.from('shift_swap_requests').update({
            status: 'rejected', rejection_reason: reason || '不符規定',
            approver_id: window.currentAdminEmployee?.id, approved_at: new Date().toISOString()
        }).eq('id', id);
        showToast('❌ 已拒絕'); loadSwapApprovals();
    } catch (e) { showToast('❌ 操作失敗'); }
}
