// ============================================================
// modules/leave.js — 審核中心（請假）、人力管理、休假月表、便當管理
// 依賴 common.js 全域: sb, showToast, escapeHTML, friendlyError,
//   fmtDate, getTaiwanDate, writeAuditLog, sendUserNotify,
//   invalidateSettingsCache
// ============================================================

// ===== 審核中心 =====
export function switchApprovalType(type, btn) {
    document.querySelectorAll('.aprContent').forEach(el => el.style.display = 'none');
    document.querySelectorAll('.aprTab').forEach(t => {
        t.style.background = 'transparent'; t.style.color = '#94A3B8'; t.style.boxShadow = 'none';
    });
    if (btn) { btn.style.background = '#fff'; btn.style.color = '#4F46E5'; btn.style.boxShadow = '0 1px 4px rgba(0,0,0,0.08)'; }
    const map = { leave: 'aprLeave', makeup: 'aprMakeup', overtime: 'aprOvertime', swap: 'aprSwap' };
    const target = document.getElementById(map[type]);
    if (target) target.style.display = 'block';
    if (type === 'leave') loadLeaveApprovals('pending');
    if (type === 'makeup') window.loadMakeupApprovals?.('pending');
    if (type === 'overtime') window.loadOtApprovals?.('pending');
    if (type === 'swap') window.loadSwapApprovals?.();
}

// ===== 請假審核 =====
export function switchLeaveTab(status) {
    document.querySelectorAll('#leaveApprovalTabs .tab-btn').forEach(btn => { btn.className = 'tab-btn inactive'; });
    event.target.className = 'tab-btn active';
    loadLeaveApprovals(status);
}

export async function loadLeaveApprovals(status) {
    const listEl = document.getElementById('leaveApprovalList');
    if (!listEl) return;
    try {
        const { data, error } = await sb.from('leave_requests')
            .select(`*, employees!inner(name, employee_number, department, company_id)`)
            .eq('employees.company_id', window.currentCompanyId)
            .eq('status', status)
            .order('created_at', { ascending: false });
        if (error) throw error;
        const typeMap = { 'annual': '特休', 'sick': '病假', 'personal': '事假', 'compensatory': '補休' };
        const statusText = { 'pending': '待審核', 'approved': '已通過', 'rejected': '已拒絕' };
        let html = '';
        (data || []).forEach(request => {
            html += `
                <div class="attendance-item">
                    <div class="date">
                        <span>${request.employees?.name || '未知'} - ${typeMap[request.leave_type] || request.leave_type}</span>
                        <span style="font-size:12px;color:#999;">${request.created_at?.split('T')[0] || ''}</span>
                    </div>
                    <div class="details">
                        <span>${request.start_date} ~ ${request.end_date}</span>
                        <span>${request.employees?.department || '-'}</span>
                    </div>
                    <div style="font-size:12px;color:#666;margin-top:5px;">${request.reason || '無原因'}</div>
                    ${request.status === 'rejected' && request.rejection_reason ? `
                        <div style="font-size:12px;color:#DC2626;margin-top:6px;padding:8px 10px;background:#FEF2F2;border-radius:8px;">
                            ❌ 拒絕原因：${request.rejection_reason}
                        </div>` : ''}
                    ${status === 'pending' ? `
                        <div style="margin-top:8px;display:flex;gap:6px;">
                            <button class="btn-success" onclick="approveLeave('${request.id}', 'approved')" style="flex:1;font-size:12px;padding:8px;border:none;border-radius:8px;cursor:pointer;">✅ 通過</button>
                            <button class="btn-danger" onclick="approveLeave('${request.id}', 'rejected')" style="flex:1;font-size:12px;padding:8px;">❌ 拒絕</button>
                        </div>` : ''}
                </div>`;
        });
        listEl.innerHTML = html || `<p style="text-align:center;color:#999;">無${statusText[status] || ''}的請假申請</p>`;
    } catch (err) {
        console.error(err);
        listEl.innerHTML = '<p style="text-align:center;color:#ef4444;">載入失敗</p>';
    }
}

export async function approveLeave(requestId, newStatus) {
    let rejectionReason = null;
    if (newStatus === 'rejected') {
        rejectionReason = prompt('請輸入拒絕原因（選填）：');
        if (rejectionReason === null) return;
    }
    try {
        const { data: result, error } = await sb.rpc('approve_leave_request', {
            p_request_id: requestId,
            p_status: newStatus,
            p_approver_id: window.currentAdminEmployee?.id,
            p_rejection_reason: newStatus === 'rejected' ? (rejectionReason || '不符合規定') : null
        });
        if (error) throw error;
        if (!result?.success) throw new Error(result?.error || '審核失敗');

        if (result.employee_id) {
            const typeMap = { annual: '特休', sick: '病假', personal: '事假', compensatory: '補休' };
            const typeName = typeMap[result.leave_type] || result.leave_type;
            if (newStatus === 'approved') {
                sendUserNotify(result.employee_id, `✅ 您的${typeName}申請已通過\n📅 ${result.start_date} ~ ${result.end_date}`);
            } else {
                sendUserNotify(result.employee_id, `❌ 您的${typeName}申請已被拒絕\n📅 ${result.start_date} ~ ${result.end_date}\n原因：${rejectionReason || '不符合規定'}`);
            }
        }
        showToast(`✅ 請假申請已${newStatus === 'approved' ? '通過' : '拒絕'}`);
        writeAuditLog(newStatus === 'approved' ? 'approve' : 'reject', 'leave_requests', requestId, result?.employee_name);
        loadLeaveApprovals('pending');
    } catch (err) {
        console.error(err);
        showToast('❌ 審核失敗: ' + friendlyError(err));
    }
}

// ===== 人力管理 — 頁籤切換 =====
export function switchStaffTab(tab) {
    if (window.smHasUnsavedChanges?.()) {
        if (!confirm('您有未儲存的工時變更，確定離開？')) return;
    }
    document.querySelectorAll('.staffTabContent').forEach(el => el.style.display = 'none');
    document.querySelectorAll('.smTab').forEach(btn => {
        btn.style.background = 'transparent'; btn.style.color = '#94A3B8'; btn.style.boxShadow = 'none';
    });
    const tabMap = { shiftMode: 'tabShiftMode', shift: 'tabShift', shifts: 'tabShifts', leave: 'tabLeave', setting: 'tabSetting' };
    const tabEl = document.getElementById(tabMap[tab]);
    if (tabEl) tabEl.style.display = 'block';
    const btns = document.querySelectorAll('.smTab');
    const idx = { shiftMode: 0, shift: 1, shifts: 2, leave: 3, setting: 4 }[tab];
    if (btns[idx]) { btns[idx].style.background = '#fff'; btns[idx].style.color = '#4F46E5'; btns[idx].style.boxShadow = '0 1px 4px rgba(0,0,0,0.08)'; }
    if (tab === 'shiftMode') window.loadEmployeeShiftModes?.();
    if (tab === 'shift') window.loadShiftMgr?.();
    if (tab === 'shifts') window.loadShiftTypeList?.();
    if (tab === 'leave') loadLeaveCal();
    if (tab === 'setting') { loadMaxLeaveSetting(); loadStaffOverview(); }
}

export function clearLeaveState() {
    maxLeaveValue = 2;
    lunchManagerIds = [];
    const n = new Date(); lcYear = n.getFullYear(); lcMonth = n.getMonth();
}

// ===== 人力設定 =====
let maxLeaveValue = 2;

export function adjustMaxLeave(d) {
    maxLeaveValue = Math.max(1, Math.min(10, maxLeaveValue + d));
    document.getElementById('maxLeaveNum').textContent = maxLeaveValue;
}

export async function loadMaxLeaveSetting() {
    try {
        const { data } = await sb.from('system_settings').select('value').eq('key', 'max_concurrent_leave').eq('company_id', window.currentCompanyId).maybeSingle();
        if (data?.value?.max) maxLeaveValue = data.value.max;
    } catch (e) { }
    document.getElementById('maxLeaveNum').textContent = maxLeaveValue;
}

export async function saveMaxLeave() {
    const statusEl = document.getElementById('maxLeaveSaveStatus');
    try {
        const val = { max: maxLeaveValue };
        await saveSetting('max_concurrent_leave', val, '同時請假人數上限');
        statusEl.style.display = 'block'; statusEl.style.color = '#059669'; statusEl.textContent = '✅ 已儲存';
        setTimeout(() => { statusEl.style.display = 'none'; }, 2000);
    } catch (e) {
        statusEl.style.display = 'block'; statusEl.style.color = '#DC2626'; statusEl.textContent = '❌ 儲存失敗';
    }
}

// ===== 排班模式設定（已停用 2026-04-14，改用員工個別 shift_mode）=====
// 保留 export 避免 import 報錯，函數為空操作
export async function loadSchedulingMode() { }
export function selectSchedulingMode() { }
export function setFixedPreset() { }
export function applySchedulingModeUI() { }
export function applyShiftTabMode() { }
export async function saveSchedulingMode() { }

// ===== 便當管理員設定 =====
let lunchManagerIds = [];

export async function loadLunchManagers() {
    try {
        const { data } = await sb.from('system_settings').select('value').eq('key', 'lunch_managers').eq('company_id', window.currentCompanyId).maybeSingle();
        lunchManagerIds = data?.value?.employee_ids || [];
    } catch (e) { lunchManagerIds = []; }
    const sel = document.getElementById('lunchMgrSelect');
    if (!sel) return;
    try {
        const { data: emps } = await sb.from('employees').select('id, name, employee_number').eq('company_id', window.currentCompanyId).eq('is_active', true).order('name');
        sel.innerHTML = '<option value="">-- 選擇員工 --</option>';
        (emps || []).forEach(e => {
            if (!lunchManagerIds.includes(e.id)) {
                sel.innerHTML += `<option value="${e.id}">${escapeHTML(e.name)}（${escapeHTML(e.employee_number)}）</option>`;
            }
        });
    } catch (e) { }
    renderLunchManagerList();
}

function renderLunchManagerList() {
    const el = document.getElementById('lunchMgrList');
    if (!el) return;
    if (lunchManagerIds.length === 0) {
        el.innerHTML = '<p style="text-align:center;color:#94A3B8;font-size:12px;">尚未指定便當管理員</p>';
        return;
    }
    sb.from('employees').select('id, name, employee_number').in('id', lunchManagerIds).then(({ data }) => {
        if (!data || data.length === 0) { el.innerHTML = '<p style="color:#94A3B8;">無資料</p>'; return; }
        el.innerHTML = data.map(e => `
            <div style="display:flex;justify-content:space-between;align-items:center;padding:8px 0;border-bottom:1px solid #F1F5F9;">
                <span>🍱 ${escapeHTML(e.name)}（${escapeHTML(e.employee_number)}）</span>
                <button onclick="removeLunchManager('${e.id}')" style="font-size:12px;padding:4px 10px;border:1px solid #FCA5A5;border-radius:8px;background:#FEF2F2;color:#DC2626;cursor:pointer;">移除</button>
            </div>
        `).join('');
    });
}

export async function addLunchManager() {
    const sel = document.getElementById('lunchMgrSelect');
    if (!sel?.value) return showToast('請選擇員工');
    lunchManagerIds.push(sel.value);
    await saveLunchManagers();
    loadLunchManagers();
}

export async function removeLunchManager(empId) {
    lunchManagerIds = lunchManagerIds.filter(id => id !== empId);
    await saveLunchManagers();
    loadLunchManagers();
}

async function saveLunchManagers() {
    try {
        await saveSetting('lunch_managers', { employee_ids: lunchManagerIds }, '便當管理員名單');
        showToast('✅ 便當管理員已更新');
    } catch (e) { showToast('❌ 儲存失敗'); }
}

// ===== 訂餐截止時間設定 =====
export async function saveLunchDeadline() {
    const time = document.getElementById('lunchDeadlineTime').value;
    if (!time) return showToast('請選擇時間');
    await saveSetting('lunch_deadline', time, '訂餐截止時間');
    showToast('✅ 截止時間已儲存：' + time);
}

export async function loadLunchDeadline() {
    const val = getCachedSetting('lunch_deadline');
    if (val) {
        const el = document.getElementById('lunchDeadlineTime');
        if (el) el.value = val;
    }
}

// ===== 考勤設定 =====
export async function saveAttendanceSettings() {
    const weekdayStart = document.getElementById('defaultWeekdayWorkStart').value;
    const weekdayEnd = document.getElementById('defaultWeekdayWorkEnd').value;
    const weekendStart = document.getElementById('defaultWeekendWorkStart').value;
    const weekendEnd = document.getElementById('defaultWeekendWorkEnd').value;
    const earlyThreshold = document.getElementById('earlyLeaveThreshold').value;
    const checkoutLimit = document.getElementById('checkoutTimeLimitHours').value;
    if (!weekdayStart) return showToast('\u8acb\u8a2d\u5b9a\u5e73\u65e5\u9810\u8a2d\u4e0a\u73ed\u6642\u9593');
    if (!weekdayEnd) return showToast('\u8acb\u8a2d\u5b9a\u5e73\u65e5\u9810\u8a2d\u4e0b\u73ed\u6642\u9593');
    if (!weekendStart) return showToast('\u8acb\u8a2d\u5b9a\u516d\u65e5\u9810\u8a2d\u4e0a\u73ed\u6642\u9593');
    if (!weekendEnd) return showToast('\u8acb\u8a2d\u5b9a\u516d\u65e5\u9810\u8a2d\u4e0b\u73ed\u6642\u9593');
    await saveSetting('default_work_start', weekdayStart, '\u9810\u8a2d\u4e0a\u73ed\u6642\u9593\uff08\u5e73\u65e5 fallback\uff09');
    await saveSetting('default_work_end', weekdayEnd, '\u9810\u8a2d\u4e0b\u73ed\u6642\u9593\uff08\u5e73\u65e5 fallback\uff09');
    await saveSetting('default_weekday_work_start', weekdayStart, '\u5e73\u65e5\u9810\u8a2d\u4e0a\u73ed\u6642\u9593');
    await saveSetting('default_weekday_work_end', weekdayEnd, '\u5e73\u65e5\u9810\u8a2d\u4e0b\u73ed\u6642\u9593');
    await saveSetting('default_weekend_work_start', weekendStart, '\u516d\u65e5\u9810\u8a2d\u4e0a\u73ed\u6642\u9593');
    await saveSetting('default_weekend_work_end', weekendEnd, '\u516d\u65e5\u9810\u8a2d\u4e0b\u73ed\u6642\u9593');
    await saveSetting('late_threshold_minutes', 9999, '\u66ab\u4e0d\u6a19\u8a18\u9072\u5230');
    await saveSetting('early_leave_threshold_minutes', parseInt(earlyThreshold) || 0, '\u65e9\u9000\u5bb9\u5fcd\u5206\u9418');
    await saveSetting('checkout_time_limit_hours', parseInt(checkoutLimit) || 4, '\u4e0b\u73ed\u6253\u5361\u5ef6\u5f8c\u4e0a\u9650\uff08\u5c0f\u6642\uff09');
    showToast('\u8003\u52e4\u8a2d\u5b9a\u5df2\u5132\u5b58');
}

export async function loadAttendanceSettings() {
    const weekdayStart = getCachedSetting('default_weekday_work_start') || getCachedSetting('default_work_start');
    const weekdayEnd = getCachedSetting('default_weekday_work_end') || getCachedSetting('default_work_end');
    const weekendStart = getCachedSetting('default_weekend_work_start') || weekdayStart;
    const weekendEnd = getCachedSetting('default_weekend_work_end') || weekdayEnd;
    const earlyThreshold = getCachedSetting('early_leave_threshold_minutes');
    const checkoutLimit = getCachedSetting('checkout_time_limit_hours');
    const el1 = document.getElementById('defaultWeekdayWorkStart');
    const el3 = document.getElementById('defaultWeekdayWorkEnd');
    const el4 = document.getElementById('earlyLeaveThreshold');
    const el5 = document.getElementById('defaultWeekendWorkStart');
    const el6 = document.getElementById('defaultWeekendWorkEnd');
    const el7 = document.getElementById('checkoutTimeLimitHours');
    if (weekdayStart && el1) el1.value = weekdayStart;
    if (weekdayEnd && el3) el3.value = weekdayEnd;
    if (earlyThreshold !== null && earlyThreshold !== undefined && el4) el4.value = earlyThreshold;
    if (weekendStart && el5) el5.value = weekendStart;
    if (weekendEnd && el6) el6.value = weekendEnd;
    if (checkoutLimit !== null && checkoutLimit !== undefined && el7) el7.value = checkoutLimit;
}

export async function loadAdminLunchStats() {
    const el = document.getElementById('adminLunchStats');
    if (!el) return;
    const todayStr = getTaiwanDate(0);
    try {
        const { data } = await sb.from('lunch_orders').select('id, is_vegetarian, status, employees!inner(company_id)').eq('employees.company_id', window.currentCompanyId).eq('order_date', todayStr);
        const orders = (data || []).filter(o => o.status === 'ordered');
        const veg = orders.filter(o => o.is_vegetarian).length;
        const regular = orders.filter(o => !o.is_vegetarian).length;
        const cancelled = (data || []).filter(o => o.status === 'cancelled').length;
        el.innerHTML = `
            <div style="display:flex;gap:8px;">
                <div style="flex:1;text-align:center;padding:12px;background:#ECFDF5;border-radius:10px;">
                    <div style="font-size:22px;font-weight:900;color:#059669;">${orders.length}</div>
                    <div style="font-size:11px;font-weight:600;color:#059669;">已訂購</div>
                </div>
                <div style="flex:1;text-align:center;padding:12px;background:#EFF6FF;border-radius:10px;">
                    <div style="font-size:22px;font-weight:900;color:#2563EB;">${regular}</div>
                    <div style="font-size:11px;font-weight:600;color:#2563EB;">🍖 葷食</div>
                </div>
                <div style="flex:1;text-align:center;padding:12px;background:#F5F3FF;border-radius:10px;">
                    <div style="font-size:22px;font-weight:900;color:#7C3AED;">${veg}</div>
                    <div style="font-size:11px;font-weight:600;color:#7C3AED;">🥗 素食</div>
                </div>
                <div style="flex:1;text-align:center;padding:12px;background:#FEF2F2;border-radius:10px;">
                    <div style="font-size:22px;font-weight:900;color:#DC2626;">${cancelled}</div>
                    <div style="font-size:11px;font-weight:600;color:#DC2626;">🚫 不訂</div>
                </div>
            </div>`;
    } catch (e) { el.innerHTML = '<p style="color:#94A3B8;">載入失敗</p>'; }
}

export async function loadStaffOverview() {
    const el = document.getElementById('staffOverview');
    if (!el) return;
    try {
        const { data: emps } = await sb.from('employees').select('id, is_active').eq('company_id', window.currentCompanyId).eq('is_active', true);
        const total = emps?.length || 0;
        if (total === 0) {
            el.innerHTML = `
                <div style="text-align:center;padding:12px;">
                    <div style="font-size:14px;font-weight:700;color:#64748B;margin-bottom:8px;">目前沒有在職員工</div>
                    <button onclick="showPage('employeePage')" style="padding:10px 20px;border:none;border-radius:8px;background:#4F46E5;color:#fff;font-weight:700;font-size:13px;cursor:pointer;">👉 前往新增員工</button>
                </div>`;
            return;
        }
        const todayStr = getTaiwanDate();
        const { data: todayLeaves } = await sb.from('leave_requests').select('id, employees!inner(company_id)')
            .eq('employees.company_id', window.currentCompanyId)
            .in('status', ['approved', 'pending'])
            .lte('start_date', todayStr).gte('end_date', todayStr);
        const onLeave = todayLeaves?.length || 0;
        el.innerHTML = `
            <div style="display:flex;gap:8px;margin-bottom:8px;">
                <span style="padding:6px 12px;background:#ECFDF5;border-radius:8px;font-weight:700;color:#059669;">👥 在職 ${total} 人</span>
                <span style="padding:6px 12px;background:#FFF7ED;border-radius:8px;font-weight:700;color:#EA580C;">🏖️ 今日請假 ${onLeave} 人</span>
                <span style="padding:6px 12px;background:#EFF6FF;border-radius:8px;font-weight:700;color:#2563EB;">💪 今日可用 ${total - onLeave} 人</span>
            </div>
            <div style="font-size:12px;color:#94A3B8;">目前設定：同時最多 <b style="color:#DC2626;">${maxLeaveValue}</b> 人請假</div>`;
    } catch (e) { el.textContent = '載入失敗'; }
}

// ===== 休假月表 =====
let lcYear, lcMonth;
(function () { const n = new Date(); lcYear = n.getFullYear(); lcMonth = n.getMonth(); })();

export function changeLeaveCal(d) {
    lcMonth += d;
    if (lcMonth < 0) { lcMonth = 11; lcYear--; }
    if (lcMonth > 11) { lcMonth = 0; lcYear++; }
    loadLeaveCal();
}
export function resetLeaveCal() {
    const n = new Date(); lcYear = n.getFullYear(); lcMonth = n.getMonth();
    loadLeaveCal();
}

export async function loadLeaveCal() {
    document.getElementById('lcMonthLabel').textContent = `${lcYear}年 ${lcMonth + 1}月`;
    document.getElementById('lcBody').innerHTML = '<tr><td colspan="32" style="text-align:center;padding:30px;color:#94A3B8;font-size:13px;">⏳ 載入中...</td></tr>';
    document.getElementById('lcHead').innerHTML = '';
    const dim = new Date(lcYear, lcMonth + 1, 0).getDate();
    const ms = `${lcYear}-${String(lcMonth + 1).padStart(2, '0')}-01`;
    const me = `${lcYear}-${String(lcMonth + 1).padStart(2, '0')}-${dim}`;

    let maxC = maxLeaveValue || 2;
    try {
        const { data: s } = await sb.from('system_settings').select('value').eq('key', 'max_concurrent_leave').eq('company_id', window.currentCompanyId).maybeSingle();
        if (s?.value?.max) maxC = s.value.max;
    } catch (e) { }
    document.getElementById('lcMax').textContent = maxC;

    let employees = [], leaves = [];
    try {
        const { data: emps } = await sb.from('employees').select('id, name, department').eq('company_id', window.currentCompanyId).eq('is_active', true).order('department').order('name');
        employees = emps || [];
        const { data: lvs } = await sb.from('leave_requests').select('employee_id, start_date, end_date, leave_type, status, employees!inner(company_id)')
            .eq('employees.company_id', window.currentCompanyId)
            .in('status', ['approved', 'pending']).or(`and(start_date.lte.${me},end_date.gte.${ms})`);
        leaves = lvs || [];
    } catch (e) { console.error(e); }

    if (employees.length === 0) {
        document.getElementById('lcHead').innerHTML = '';
        document.getElementById('lcBody').innerHTML = `<tr><td style="text-align:center;padding:40px 20px;">
            <div style="font-size:48px;margin-bottom:12px;">👥</div>
            <div style="font-size:14px;font-weight:800;color:#0F172A;">尚無員工資料</div>
            <div style="font-size:12px;color:#94A3B8;margin-top:6px;">請先到「員工管理」新增員工</div>
        </td></tr>`;
        document.getElementById('lcTotal').textContent = '0';
        document.getElementById('lcAvail').textContent = '0';
        document.getElementById('lcOverWarn').style.display = 'none';
        return;
    }

    const wd = ['日', '一', '二', '三', '四', '五', '六'];
    const dayCount = {};
    for (let d = 1; d <= dim; d++) {
        const ds = `${lcYear}-${String(lcMonth + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
        dayCount[ds] = 0;
        leaves.forEach(l => { if (ds >= l.start_date && ds <= (l.end_date || l.start_date)) dayCount[ds]++; });
    }

    let headHtml = '<tr><th style="position:sticky;left:0;background:#fff;z-index:2;padding:6px 8px;min-width:60px;text-align:left;border-bottom:2px solid #E5E7EB;font-size:11px;">姓名</th>';
    for (let d = 1; d <= dim; d++) {
        const dt = new Date(lcYear, lcMonth, d);
        const isW = dt.getDay() === 0 || dt.getDay() === 6;
        const ds = `${lcYear}-${String(lcMonth + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
        const over = dayCount[ds] >= maxC && !isW;
        const bg = over ? '#FEE2E2' : isW ? '#F1F5F9' : '#fff';
        headHtml += `<th style="padding:4px 2px;min-width:28px;text-align:center;border-bottom:2px solid ${over ? '#FCA5A5' : '#E5E7EB'};background:${bg};font-size:10px;">
            <div style="${over ? 'color:#DC2626;font-weight:900;' : ''}">${d}</div><div style="color:#94A3B8;font-size:9px;">${wd[dt.getDay()]}</div>
            ${over ? '<div style="font-size:8px;color:#DC2626;font-weight:900;">滿</div>' : ''}
        </th>`;
    }
    headHtml += '</tr>';
    document.getElementById('lcHead').innerHTML = headHtml;

    const typeColor = { annual: '#DBEAFE', sick: '#FEE2E2', personal: '#FEF3C7', compensatory: '#E0E7FF' };
    const typeEmoji = { annual: '🏖', sick: '🤒', personal: '📋', compensatory: '💤' };
    let totalLeaves = 0;
    const todayStr = getTaiwanDate();
    let todayAvail = employees.length;
    let overDays = [];

    let bodyHtml = '';
    employees.forEach(emp => {
        const empLeaves = leaves.filter(l => l.employee_id === emp.id);
        bodyHtml += `<tr><td style="position:sticky;left:0;background:#fff;z-index:1;padding:6px 8px;font-weight:700;font-size:11px;white-space:nowrap;border-bottom:1px solid #F1F5F9;">${emp.name}</td>`;
        for (let d = 1; d <= dim; d++) {
            const ds = `${lcYear}-${String(lcMonth + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
            const dt = new Date(lcYear, lcMonth, d);
            const isW = dt.getDay() === 0 || dt.getDay() === 6;
            const lv = empLeaves.find(l => ds >= l.start_date && ds <= (l.end_date || l.start_date));
            const over = dayCount[ds] > maxC && !isW;
            if (lv) {
                totalLeaves++;
                if (ds === todayStr) todayAvail--;
                const bg = over ? '#FCA5A5' : (typeColor[lv.leave_type] || '#F1F5F9');
                const emoji = typeEmoji[lv.leave_type] || '📝';
                const pending = lv.status === 'pending' ? 'opacity:0.6;' : '';
                bodyHtml += `<td style="text-align:center;background:${bg};border-bottom:1px solid #F1F5F9;${pending}font-size:10px;cursor:default;" title="${emp.name} ${lv.leave_type}${lv.status === 'pending' ? ' (待審)' : ''}${over ? ' ⚠超限' : ''}">${emoji}</td>`;
            } else if (isW) {
                bodyHtml += `<td style="background:#F8FAFC;border-bottom:1px solid #F1F5F9;"></td>`;
            } else {
                bodyHtml += `<td style="border-bottom:1px solid #F1F5F9;"></td>`;
            }
        }
        bodyHtml += '</tr>';
    });

    bodyHtml += '<tr style="background:#F8FAFC;"><td style="position:sticky;left:0;background:#F8FAFC;z-index:1;padding:6px 8px;font-weight:700;font-size:10px;color:#64748B;">請假數</td>';
    for (let d = 1; d <= dim; d++) {
        const ds = `${lcYear}-${String(lcMonth + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
        const dt = new Date(lcYear, lcMonth, d);
        const isW = dt.getDay() === 0 || dt.getDay() === 6;
        const cnt = dayCount[ds] || 0;
        const over = cnt >= maxC && !isW;
        if (over && !isW) overDays.push(`${lcMonth + 1}/${d}`);
        bodyHtml += `<td style="text-align:center;font-size:10px;font-weight:900;color:${over ? '#DC2626' : cnt > 0 ? '#EA580C' : '#CBD5E1'};border-bottom:1px solid #F1F5F9;background:${over ? '#FEF2F2' : '#F8FAFC'};">${cnt || '-'}</td>`;
    }
    bodyHtml += '</tr>';

    document.getElementById('lcBody').innerHTML = bodyHtml;
    document.getElementById('lcTotal').textContent = totalLeaves;
    document.getElementById('lcAvail').textContent = Math.max(0, todayAvail);

    const warnEl = document.getElementById('lcOverWarn');
    if (overDays.length > 0) {
        warnEl.style.display = 'block';
        warnEl.innerHTML = `🚨 以下日期請假人數已達/超過上限（${maxC}人）：<br><b>${overDays.join('、')}</b><br><span style="font-size:11px;opacity:0.7;">員工在這些日期提交請假將被自動駁回</span>`;
    } else {
        warnEl.style.display = 'none';
    }
}
