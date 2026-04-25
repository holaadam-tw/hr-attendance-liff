// ============================================================
// modules/employees.js — 員工管理 CRUD + 薪資設定
// 依賴 common.js 全域: sb, showToast, escapeHTML, friendlyError,
//   fmtDate, setBtnLoading, formatMoneyInput, parseMoney, toMoneyStr,
//   formatNT, writeAuditLog, CONFIG
// ============================================================

let currentSalaryEmpId = null;

// ===== 部門下拉選單 =====
export function loadDepartmentOptions(selectId, currentValue) {
    var depts = getCachedSetting('departments') || ['管理部', '生產部', '業務部', '倉管部'];
    var select = document.getElementById(selectId);
    if (!select) return;

    var html = '<option value="">選擇部門</option>';
    depts.forEach(function(d) {
        html += '<option value="' + escapeHTML(d) + '"' + (d === currentValue ? ' selected' : '') + '>' + escapeHTML(d) + '</option>';
    });
    select.innerHTML = html;
}

export async function addNewDepartment(selectId) {
    var name = prompt('輸入新部門名稱：');
    if (!name || !name.trim()) return;
    name = name.trim();

    var depts = getCachedSetting('departments') || [];
    if (depts.includes(name)) { alert('此部門已存在'); return; }

    depts.push(name);

    await saveSetting('departments', depts, '部門列表');

    loadDepartmentOptions(selectId, name);
    showToast('✅ 已新增部門：' + name);
}

// ===== 新增員工 Modal =====
export function showAddEmployeeModal() {
    document.getElementById('addEmployeeModal').style.display = 'flex';
    document.getElementById('newEmployeeHireDate').value = fmtDate(new Date());
    loadDepartmentOptions('newEmployeeDepartment', '');
}

export function closeAddEmployeeModal() {
    document.getElementById('addEmployeeModal').style.display = 'none';
    document.getElementById('addEmployeeForm').reset();
}

// ===== 新增員工表單提交 =====
export function initEmployeeFormHandler() {
    const form = document.getElementById('addEmployeeForm');
    if (!form) return;
    form.addEventListener('submit', async function (e) {
        e.preventDefault();

        const employeeData = {
            name: document.getElementById('newEmployeeName').value.trim(),
            employee_number: document.getElementById('newEmployeeNumber').value.trim(),
            department: document.getElementById('newEmployeeDepartment').value,
            position: document.getElementById('newEmployeePosition').value.trim() || '員工',
            id_card_last_4: document.getElementById('newEmployeeCode').value.trim(),
            hire_date: document.getElementById('newEmployeeHireDate').value,
            role: document.getElementById('newEmployeeRole').value,
            is_active: true,
            company_id: window.currentAdminEmployee?.company_id || window.currentCompanyId,
            created_at: new Date().toISOString()
        };

        if (!employeeData.name || !employeeData.employee_number || !employeeData.id_card_last_4) {
            showToast('⚠️ 請填寫所有必填欄位');
            return;
        }

        try {
            const { data, error } = await sb.from('employees').insert([employeeData]);
            if (error) throw error;

            showToast('✅ 員工新增成功！');
            closeAddEmployeeModal();
            loadEmployeeList();
        } catch (err) {
            console.error('新增員工失敗:', err);
            showToast('❌ 新增失敗: ' + friendlyError(err));
        }
    });
}

// ===== QR Code =====
export async function showJoinQRCode() {
    const modal = document.getElementById('qrModal');
    const qrcodeDiv = document.getElementById('qrcode');
    qrcodeDiv.innerHTML = '';

    let companyCode = 'UNKNOWN';
    let companyName = '';
    try {
        const { data } = await sb.from('companies').select('code, name').eq('id', window.currentCompanyId).maybeSingle();
        if (data) {
            companyCode = data.code;
            companyName = data.name;
        }
    } catch (e) {
        console.error('Failed to fetch company info for QR code', e);
    }

    const liffUrl = `https://liff.line.me/${CONFIG.LIFF_ID}?type=bind&company=${companyCode}`;

    new QRCode(qrcodeDiv, {
        text: liffUrl, width: 200, height: 200,
        colorDark: "#1f2937", colorLight: "#ffffff",
        correctLevel: QRCode.CorrectLevel.H
    });

    const nameEl = document.getElementById('qrCompanyName');
    const codeEl = document.getElementById('qrCompanyCode');
    if (nameEl) nameEl.textContent = companyName;
    if (codeEl) codeEl.textContent = companyCode;

    modal.style.display = 'flex';
}

export function closeQRModal() {
    document.getElementById('qrModal').style.display = 'none';
}

// ===== 載入員工列表 =====
export async function loadEmployeeList() {
    const listEl = document.getElementById('employeeList');
    if (!listEl) return;

    // 同時更新待審核 badge
    loadPendingCount();

    try {
        const { data, error } = await sb.from('employees')
            .select('*')
            .eq('company_id', window.currentCompanyId)
            .eq('is_active', true)
            .order('department', { ascending: true });

        if (error) throw error;

        const roleNames = { 'admin': '管理員', 'manager': '主管', 'user': '一般員工' };

        let html = '';
        data.forEach(emp => {
            html += `
                <div class="attendance-item">
                    <div class="date">
                        <div style="display:flex; align-items:center; flex-wrap:wrap; gap:4px;">
                            <span>${escapeHTML(emp.name)} - ${escapeHTML(emp.employee_number)}</span>
                            <span class="role-${emp.role || 'user'}" style="
                                padding: 3px 10px; border-radius: 15px; font-size: 11px;
                                display: inline-block; font-weight: bold;">
                                ${roleNames[emp.role] || '未知'}
                            </span>
                        </div>
                    </div>
                    <div class="details">
                        <span>${escapeHTML(emp.department || '-')} · ${escapeHTML(emp.position || '-')}</span>
                        <span style="font-size:12px;">驗證碼: ${escapeHTML(emp.id_card_last_4 || '未設定')}</span>
                    </div>
                    <div style="font-size:12px;color:#666;margin-top:5px;">
                        ${emp.phone ? '📱 ' + escapeHTML(emp.phone) + ' · ' : ''}到職: ${emp.hire_date || '未設定'} · ${emp.employment_type === 'parttime' ? '兼職' : '正職'} · ${emp.is_kiosk ? '📱 公務機' : emp.no_checkin ? '🚫 免打卡' : ''} · ${emp.line_user_id ? '✅ 已綁定' : '⏳ 未綁定'}
                    </div>
                    <div style="margin-top:8px;display:flex;gap:6px;flex-wrap:wrap;">
                        <button data-id="${emp.id}" onclick="openEditEmployeeModal(this.dataset.id)" style="padding:7px 12px;border:1px solid #E5E7EB;border-radius:8px;background:#fff;font-size:11px;font-weight:700;cursor:pointer;color:#4F46E5;">✏️ 編輯</button>
                        ${emp.line_user_id ? `
                            <button data-id="${emp.id}" data-role="${emp.role === 'admin' ? 'user' : 'admin'}" data-name="${escapeHTML(emp.name)}" onclick="updateEmployeeRoleAdmin(this.dataset.id, this.dataset.role, this.dataset.name)" style="padding:7px 12px;border:1px solid #E5E7EB;border-radius:8px;background:#fff;font-size:11px;font-weight:700;cursor:pointer;color:#EA580C;">
                                ${emp.role === 'admin' ? '取消管理員' : '設為管理員'}
                            </button>
                        ` : ''}
                        <button data-id="${emp.id}" data-name="${escapeHTML(emp.name)}" onclick="showResignModal(this.dataset.id, this.dataset.name)" style="padding:7px 12px;border:1px solid #FCA5A5;border-radius:8px;background:#FEF2F2;font-size:11px;font-weight:700;cursor:pointer;color:#DC2626;">📤 離職</button>
                    </div>
                </div>
            `;
        });

        listEl.innerHTML = html || '<p style="text-align:center;color:#999;">無員工資料</p>';

    } catch (err) {
        console.error(err);
        listEl.innerHTML = '<p style="text-align:center;color:#ef4444;">載入失敗</p>';
    }
}

// ===== 更新角色 =====
export async function updateEmployeeRoleAdmin(employeeId, newRole, employeeName) {
    const roleNames = { 'admin': '管理員', 'manager': '主管', 'user': '一般員工' };

    try {
        const { error } = await sb.from('employees')
            .update({ role: newRole })
            .eq('id', employeeId)
            .eq('company_id', window.currentCompanyId);

        if (error) throw error;
        showToast(`✅ ${employeeName} → ${roleNames[newRole]}`);
        loadEmployeeList();
    } catch (err) {
        console.error(err);
        showToast('❌ 更新失敗: ' + friendlyError(err));
    }
}

// ===== 搜尋員工 =====
export function searchEmployees() {
    const searchTerm = document.getElementById('employeeSearch').value.toLowerCase();
    const items = document.querySelectorAll('#employeeList .attendance-item');
    items.forEach(item => {
        const text = item.textContent.toLowerCase();
        item.style.display = text.includes(searchTerm) ? 'block' : 'none';
    });
}

// ===== 薪資設定 Modal =====
export async function openSalarySettingModal(empId, empName) {
    currentSalaryEmpId = empId;
    document.getElementById('salarySettingEmpName').textContent = empName + ' 的薪資設定';
    document.getElementById('ssSalaryType').value = 'monthly';
    document.getElementById('ssBaseSalary').value = '';
    document.getElementById('ssMealAllowance').value = '0';
    document.getElementById('ssPositionAllowance').value = '0';
    document.getElementById('ssFullAttBonus').value = '0';
    document.getElementById('ssPensionRate').value = '0';
    onSalaryTypeChange();
    ['ssBaseSalary', 'ssMealAllowance', 'ssPositionAllowance', 'ssFullAttBonus'].forEach(id => {
        formatMoneyInput(document.getElementById(id));
    });
    try {
        const { data } = await sb.from('salary_settings')
            .select('*')
            .eq('employee_id', empId)
            .eq('is_current', true)
            .maybeSingle();
        if (data) {
            document.getElementById('ssSalaryType').value = data.salary_type || 'monthly';
            document.getElementById('ssBaseSalary').value = toMoneyStr(data.base_salary) || '';
            document.getElementById('ssMealAllowance').value = toMoneyStr(data.meal_allowance || 0);
            document.getElementById('ssPositionAllowance').value = toMoneyStr(data.position_allowance || 0);
            document.getElementById('ssFullAttBonus').value = toMoneyStr(data.full_attendance_bonus || 0);
            document.getElementById('ssPensionRate').value = data.pension_self_rate || 0;
            onSalaryTypeChange();
        }
    } catch (e) { }
    document.getElementById('salarySettingModal').style.display = 'flex';
}

export function closeSalarySettingModal() {
    document.getElementById('salarySettingModal').style.display = 'none';
    currentSalaryEmpId = null;
}

export function onSalaryTypeChange() {
    const t = document.getElementById('ssSalaryType').value;
    const labels = { monthly: '基本月薪', daily: '基本日薪', hourly: '基本時薪' };
    document.getElementById('ssBaseLabel').textContent = labels[t] || '基本月薪';
}

export async function saveSalarySetting() {
    if (!currentSalaryEmpId) return;
    const base = parseMoney(document.getElementById('ssBaseSalary').value);
    if (!base || base <= 0) { showToast('⚠️ 請輸入基本薪資'); return; }

    const record = {
        employee_id: currentSalaryEmpId,
        salary_type: document.getElementById('ssSalaryType').value,
        base_salary: base,
        meal_allowance: parseMoney(document.getElementById('ssMealAllowance').value),
        position_allowance: parseMoney(document.getElementById('ssPositionAllowance').value),
        full_attendance_bonus: parseMoney(document.getElementById('ssFullAttBonus').value),
        pension_self_rate: parseFloat(document.getElementById('ssPensionRate').value) || 0,
        is_current: true,
        updated_at: new Date().toISOString()
    };

    try {
        await sb.from('salary_settings').update({ is_current: false }).eq('employee_id', currentSalaryEmpId).eq('is_current', true);
        const { error } = await sb.from('salary_settings').insert(record);
        if (error) throw error;
        showToast('✅ 薪資設定已儲存');
        closeSalarySettingModal();
        if (typeof window.loadSalarySettingList === 'function') window.loadSalarySettingList();
        if (typeof writeAuditLog === 'function') writeAuditLog('update', 'salary_settings', currentSalaryEmpId, '薪資設定', { employee_id: currentSalaryEmpId, base_salary: base, salary_type: record.salary_type });
    } catch (e) {
        showToast('❌ 儲存失敗: ' + friendlyError(e));
    }
}

// ===== 員工登記 QR Code =====
export async function showRegisterQRCode() {
    const modal = document.getElementById('registerQrModal');
    const qrcodeDiv = document.getElementById('registerQrcode');
    qrcodeDiv.innerHTML = '';

    let companyName = '';
    const companyId = window.currentAdminEmployee?.company_id || window.currentCompanyId;

    try {
        const { data } = await sb.from('companies').select('name').eq('id', companyId).maybeSingle();
        if (data) companyName = data.name;
    } catch (e) {
        console.error('Failed to fetch company info for register QR', e);
    }

    // 透過 LIFF URL 開啟，自動帶入 LINE userId
    const registerUrl = `https://liff.line.me/2008962829-bnsS1bbB?goto=register&company=${companyId}`;

    new QRCode(qrcodeDiv, {
        text: registerUrl, width: 200, height: 200,
        colorDark: "#059669", colorLight: "#ffffff",
        correctLevel: QRCode.CorrectLevel.H
    });

    const nameEl = document.getElementById('regQrCompanyName');
    if (nameEl) nameEl.textContent = companyName;

    modal.style.display = 'flex';
}

export function closeRegisterQrModal() {
    document.getElementById('registerQrModal').style.display = 'none';
}

export function downloadRegisterQR() {
    const canvas = document.querySelector('#registerQrcode canvas');
    if (!canvas) { showToast('⚠️ QR Code 尚未產生'); return; }
    const link = document.createElement('a');
    link.download = 'employee_register_qr.png';
    link.href = canvas.toDataURL('image/png');
    link.click();
}

// ===== 員工 Tab 切換 =====
let currentEmpTab = 'active';

export function switchEmployeeTab(tab) {
    currentEmpTab = tab;
    const tabs = ['active', 'unbind', 'pending', 'resigned', 'all'];
    const sections = {
        active: 'activeEmployeeSection',
        unbind: 'unbindEmployeeSection',
        pending: 'pendingEmployeeSection',
        resigned: 'resignedEmployeeSection',
        all: 'allEmployeeSection'
    };

    // 更新 tab 按鈕樣式
    tabs.forEach(t => {
        const btn = document.getElementById('empTab_' + t);
        if (!btn) return;
        if (t === tab) {
            btn.style.background = '#4F46E5';
            btn.style.color = '#fff';
        } else {
            btn.style.background = '#fff';
            btn.style.color = '#64748B';
        }
    });

    // 顯示/隱藏區塊
    tabs.forEach(t => {
        const el = document.getElementById(sections[t]);
        if (el) el.style.display = t === tab ? 'block' : 'none';
    });

    // 載入對應資料
    if (tab === 'active') loadEmployeeList();
    else if (tab === 'unbind') loadUnbindEmployees();
    else if (tab === 'pending') loadPendingEmployees();
    else if (tab === 'resigned') loadResignedEmployees();
    else if (tab === 'all') loadAllEmployees();
}

// ===== 待綁定 LINE 員工列表 =====
export async function loadUnbindEmployees() {
    const listEl = document.getElementById('unbindEmployeeList');
    if (!listEl) return;

    try {
        const { data, error } = await sb.from('employees')
            .select('id, name, employee_number, department, position')
            .eq('company_id', window.currentCompanyId)
            .eq('is_active', true)
            .eq('status', 'approved')
            .is('line_user_id', null)
            .order('employee_number', { ascending: true });

        if (error) throw error;

        // 更新 badge
        const badge = document.getElementById('unbindBadge');
        if (badge) {
            if (data && data.length > 0) {
                badge.textContent = data.length;
                badge.style.display = 'inline-block';
            } else {
                badge.style.display = 'none';
            }
        }

        if (!data || data.length === 0) {
            listEl.innerHTML = '<p style="text-align:center;color:#999;padding:40px 0;">🎉 所有員工都已綁定 LINE</p>';
            return;
        }

        let html = '';
        data.forEach(emp => {
            html += `
                <div class="attendance-item" style="border-left:4px solid #F59E0B;display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap;">
                    <div style="min-width:0;flex:1;">
                        <div style="font-weight:700;font-size:14px;">${escapeHTML(emp.name)}</div>
                        <div style="font-size:12px;color:#64748B;">${escapeHTML(emp.employee_number || '')} · ${escapeHTML(emp.department || '')} · ${escapeHTML(emp.position || '')}</div>
                    </div>
                    <div style="display:flex;gap:6px;align-items:center;">
                        <input type="text" id="bindLineInput_${emp.id}" placeholder="LINE User ID" style="width:140px;padding:8px;border:1px solid #E2E8F0;border-radius:8px;font-size:12px;font-family:monospace;">
                        <button data-id="${emp.id}" data-name="${escapeHTML(emp.name)}" onclick="quickBindLine(this.dataset.id, this.dataset.name)" style="padding:8px 14px;border:none;border-radius:8px;background:#4F46E5;color:#fff;font-size:12px;font-weight:700;cursor:pointer;font-family:inherit;white-space:nowrap;">
                            綁定
                        </button>
                    </div>
                </div>`;
        });
        listEl.innerHTML = html;

    } catch (err) {
        console.error('Load unbind error:', err);
        listEl.innerHTML = '<p style="text-align:center;color:#ef4444;">載入失敗</p>';
    }
}

// ===== 快速綁定 LINE =====
export async function quickBindLine(empId, empName) {
    const input = document.getElementById('bindLineInput_' + empId);
    const lineUserId = input?.value.trim();
    if (!lineUserId) { showToast('⚠️ 請輸入 LINE User ID'); return; }
    if (!lineUserId.startsWith('U') || lineUserId.length < 30) {
        showToast('⚠️ LINE User ID 格式不正確（應為 U 開頭的長字串）');
        return;
    }

    try {
        // 檢查是否已被其他員工使用
        const { data: existing } = await sb.from('employees')
            .select('id, name')
            .eq('line_user_id', lineUserId)
            .eq('is_active', true)
            .maybeSingle();

        if (existing && existing.id !== empId) {
            showToast(`⚠️ 此 LINE ID 已被「${existing.name}」使用`);
            return;
        }

        const { error } = await sb.from('employees').update({
            line_user_id: lineUserId,
            is_bound: true,
            updated_at: new Date().toISOString()
        }).eq('id', empId);

        if (error) throw error;
        showToast(`✅ ${empName} 已綁定 LINE`);
        loadUnbindEmployees();
    } catch (err) {
        console.error('Quick bind error:', err);
        showToast('❌ 綁定失敗: ' + friendlyError(err));
    }
}

// ===== 待審核員工列表 =====
export async function loadPendingEmployees() {
    const listEl = document.getElementById('pendingEmployeeList');
    if (!listEl) return;

    try {
        const { data, error } = await sb.from('employees')
            .select('id, name, phone, department, position, hire_date, line_user_id, emergency_contact, emergency_phone, created_at, status')
            .eq('company_id', window.currentCompanyId)
            .eq('status', 'pending')
            .eq('is_active', false)
            .order('created_at', { ascending: false });

        if (error) throw error;

        // 更新 badge
        const badge = document.getElementById('pendingBadge');
        if (badge) {
            if (data && data.length > 0) {
                badge.textContent = data.length;
                badge.style.display = 'inline-block';
            } else {
                badge.style.display = 'none';
            }
        }

        if (!data || data.length === 0) {
            listEl.innerHTML = '<p style="text-align:center;color:#999;padding:40px 0;">🎉 目前沒有待審核的員工</p>';
            return;
        }

        let html = '';
        data.forEach(emp => {
            const createdDate = emp.created_at ? new Date(emp.created_at).toLocaleDateString('zh-TW', { timeZone: 'Asia/Taipei' }) : '未知';
            html += `
                <div class="attendance-item" style="border-left:4px solid #F59E0B;">
                    <div class="date">
                        <div style="display:flex; align-items:center; gap:8px;">
                            <span style="font-weight:700;">${escapeHTML(emp.name)}</span>
                            <span style="padding:3px 10px; border-radius:15px; font-size:11px; background:#FEF3C7; color:#92400E; font-weight:bold;">
                                ⏳ 待審核
                            </span>
                        </div>
                    </div>
                    <div class="details" style="margin-top:6px;">
                        <span>📱 ${escapeHTML(emp.phone || '未填')}</span>
                        <span>${escapeHTML(emp.department || '未選')} · ${escapeHTML(emp.position || '未填')}</span>
                    </div>
                    <div style="font-size:12px;color:#666;margin-top:5px;">
                        到職: ${emp.hire_date || '未填'} · 登記: ${createdDate}
                    </div>
                    ${emp.emergency_contact ? `<div style="font-size:12px;color:#666;margin-top:3px;">🆘 緊急聯絡: ${escapeHTML(emp.emergency_contact)} ${escapeHTML(emp.emergency_phone || '')}</div>` : ''}
                    <div style="margin-top:10px;display:flex;gap:8px;">
                        <button data-id="${emp.id}" data-name="${escapeHTML(emp.name)}" onclick="approveEmployee(this.dataset.id, this.dataset.name)" style="flex:1;padding:10px;border:none;border-radius:8px;background:#10B981;color:#fff;font-size:13px;font-weight:700;cursor:pointer;font-family:inherit;">
                            ✅ 通過
                        </button>
                        <button data-id="${emp.id}" data-name="${escapeHTML(emp.name)}" onclick="rejectEmployee(this.dataset.id, this.dataset.name)" style="flex:1;padding:10px;border:none;border-radius:8px;background:#EF4444;color:#fff;font-size:13px;font-weight:700;cursor:pointer;font-family:inherit;">
                            ❌ 拒絕
                        </button>
                    </div>
                </div>
            `;
        });

        listEl.innerHTML = html;

    } catch (err) {
        console.error('Load pending employees error:', err);
        listEl.innerHTML = '<p style="text-align:center;color:#ef4444;">載入失敗</p>';
    }
}

// ===== 審核通過 =====
export async function approveEmployee(empId, empName) {
    if (!confirm(`確定通過「${empName}」的登記申請？`)) return;

    for (let attempt = 0; attempt < 3; attempt++) {
        try {
            const { data: allEmp } = await sb.from('employees')
                .select('employee_number')
                .not('employee_number', 'is', null);

            const usedNumbers = new Set((allEmp || []).map(e => e.employee_number));
            let maxN = 0;
            usedNumbers.forEach(num => {
                const m = (num || '').match(/\d+/);
                if (m) { const n = parseInt(m[0], 10); if (n > maxN) maxN = n; }
            });

            let nextNum = 'E' + String(maxN + 1 + attempt).padStart(3, '0');
            while (usedNumbers.has(nextNum)) {
                maxN++;
                nextNum = 'E' + String(maxN + 1 + attempt).padStart(3, '0');
            }

            const { error } = await sb.from('employees').update({
                is_active: true,
                is_bound: true,
                status: 'approved',
                employee_number: nextNum,
                updated_at: new Date().toISOString()
            }).eq('id', empId);

            if (error) {
                if (error.code === '23505' && attempt < 2) continue;
                throw error;
            }

            showToast(`✅ ${empName} 已通過審核（工號：${nextNum}）`);
            loadPendingEmployees();
            return;

        } catch (err) {
            if (err.code === '23505' && attempt < 2) continue;
            console.error('Approve error:', err);
            showToast('❌ 審核失敗: ' + friendlyError(err));
            return;
        }
    }
}

// ===== 拒絕登記 =====
export async function rejectEmployee(empId, empName) {
    if (!confirm(`確定拒絕「${empName}」的登記申請？\n拒絕後該筆資料將被刪除。`)) return;

    try {
        const { error } = await sb.from('employees').delete().eq('id', empId);

        if (error) throw error;

        showToast(`❌ 已拒絕 ${empName} 的登記`);
        loadPendingEmployees();

    } catch (err) {
        console.error('Reject error:', err);
        showToast('❌ 操作失敗: ' + friendlyError(err));
    }
}

// ===== 載入待審核數量（用於 badge 更新） =====
export async function loadPendingCount() {
    try {
        const { count, error } = await sb.from('employees')
            .select('id', { count: 'exact', head: true })
            .eq('company_id', window.currentCompanyId)
            .eq('status', 'pending')
            .eq('is_active', false);

        if (!error) {
            const badge = document.getElementById('pendingBadge');
            if (badge) {
                if (count > 0) {
                    badge.textContent = count;
                    badge.style.display = 'inline-block';
                } else {
                    badge.style.display = 'none';
                }
            }
        }
    } catch (e) {
        console.error('Load pending count error:', e);
    }
}

// ===== 離職管理 =====
export function showResignModal(empId, empName) {
    document.getElementById('resignEmpId').value = empId;
    document.getElementById('resignEmpName').textContent = empName + ' 離職處理';
    document.getElementById('resignDate').value = fmtDate(new Date());
    document.getElementById('resignReason').value = '';
    document.getElementById('resignNote').value = '';
    document.getElementById('resignModal').style.display = 'flex';
}

export function closeResignModal() {
    document.getElementById('resignModal').style.display = 'none';
}

export async function confirmResign() {
    const empId = document.getElementById('resignEmpId').value;
    const resignDate = document.getElementById('resignDate').value;
    const reason = document.getElementById('resignReason').value;
    const note = document.getElementById('resignNote').value.trim();

    if (!resignDate) { showToast('⚠️ 請選擇離職日期'); return; }
    if (!reason) { showToast('⚠️ 請選擇離職原因'); return; }

    try {
        const { error } = await sb.from('employees').update({
            is_active: false,
            status: 'resigned',
            resigned_date: resignDate,
            resign_reason: reason,
            resign_note: note || null,
            updated_at: new Date().toISOString()
        }).eq('id', empId);

        if (error) throw error;

        showToast('✅ 已設為離職');
        closeResignModal();
        loadEmployeeList();
    } catch (err) {
        console.error('Resign error:', err);
        showToast('❌ 操作失敗: ' + friendlyError(err));
    }
}

export async function restoreEmployee(empId, empName) {
    if (!confirm(`確定將「${empName}」恢復為在職？`)) return;

    try {
        const { error } = await sb.from('employees').update({
            is_active: true,
            status: 'approved',
            resigned_date: null,
            resign_reason: null,
            resign_note: null,
            updated_at: new Date().toISOString()
        }).eq('id', empId);

        if (error) throw error;
        showToast(`✅ ${empName} 已恢復在職`);
        loadResignedEmployees();
    } catch (err) {
        console.error('Restore error:', err);
        showToast('❌ 操作失敗: ' + friendlyError(err));
    }
}

// ===== 已離職員工列表 =====
export async function loadResignedEmployees() {
    const listEl = document.getElementById('resignedEmployeeList');
    if (!listEl) return;

    try {
        const { data, error } = await sb.from('employees')
            .select('id, name, employee_number, department, position, hire_date, resigned_date, resign_reason, resign_note, status')
            .eq('company_id', window.currentCompanyId)
            .eq('status', 'resigned')
            .order('resigned_date', { ascending: false });

        if (error) throw error;

        if (!data || data.length === 0) {
            listEl.innerHTML = '<p style="text-align:center;color:#999;padding:40px;">目前沒有已離職的員工</p>';
            return;
        }

        const reasonMap = { voluntary:'自願離職', terminated:'資遣', retired:'退休', contract_end:'合約到期', other:'其他' };
        let html = '';
        data.forEach(emp => {
            html += `
                <div class="attendance-item" style="border-left:4px solid #94A3B8; opacity:0.85;">
                    <div class="date">
                        <div style="display:flex; align-items:center; gap:8px;">
                            <span style="font-weight:700;">${escapeHTML(emp.name)} - ${escapeHTML(emp.employee_number || '-')}</span>
                            <span style="padding:3px 10px; border-radius:15px; font-size:11px; background:#F3F4F6; color:#6B7280; font-weight:bold;">已離職</span>
                        </div>
                    </div>
                    <div class="details" style="margin-top:6px;">
                        <span>${escapeHTML(emp.department || '-')} · ${escapeHTML(emp.position || '-')}</span>
                    </div>
                    <div style="font-size:12px;color:#666;margin-top:5px;">
                        離職日：${emp.resigned_date || '-'} · 原因：${reasonMap[emp.resign_reason] || emp.resign_reason || '-'}
                    </div>
                    ${emp.resign_note ? `<div style="font-size:12px;color:#94A3B8;margin-top:3px;">備註：${escapeHTML(emp.resign_note)}</div>` : ''}
                    <div style="margin-top:8px;">
                        <button data-id="${emp.id}" data-name="${escapeHTML(emp.name)}" onclick="restoreEmployee(this.dataset.id, this.dataset.name)" style="padding:7px 14px;border:1px solid #BBF7D0;border-radius:8px;background:#F0FDF4;font-size:11px;font-weight:700;cursor:pointer;color:#059669;">🔄 恢復在職</button>
                    </div>
                </div>
            `;
        });

        listEl.innerHTML = html;
    } catch (err) {
        console.error('Load resigned error:', err);
        listEl.innerHTML = '<p style="text-align:center;color:#ef4444;">載入失敗</p>';
    }
}

// ===== 全部員工列表 =====
export async function loadAllEmployees() {
    const listEl = document.getElementById('allEmployeeList');
    if (!listEl) return;

    try {
        const { data, error } = await sb.from('employees')
            .select('id, name, employee_number, department, position, is_active, status, hire_date, resigned_date')
            .eq('company_id', window.currentCompanyId)
            .in('status', ['approved', 'resigned'])
            .order('is_active', { ascending: false })
            .order('name');

        if (error) throw error;

        if (!data || data.length === 0) {
            listEl.innerHTML = '<p style="text-align:center;color:#999;padding:40px;">無員工資料</p>';
            return;
        }

        let html = '';
        data.forEach(emp => {
            const isResigned = emp.status === 'resigned';
            html += `
                <div class="attendance-item" style="${isResigned ? 'border-left:4px solid #94A3B8;opacity:0.75;' : ''}">
                    <div class="date">
                        <div style="display:flex; align-items:center; gap:8px;">
                            <span style="font-weight:700;">${escapeHTML(emp.name)} - ${escapeHTML(emp.employee_number || '-')}</span>
                            <span style="padding:3px 10px; border-radius:15px; font-size:11px; background:${isResigned ? '#F3F4F6' : '#DCFCE7'}; color:${isResigned ? '#6B7280' : '#059669'}; font-weight:bold;">
                                ${isResigned ? '已離職' : '在職'}
                            </span>
                        </div>
                    </div>
                    <div class="details" style="margin-top:4px;">
                        <span>${escapeHTML(emp.department || '-')} · ${escapeHTML(emp.position || '-')}</span>
                        <span style="font-size:12px;color:#94A3B8;">${isResigned ? '離職：' + (emp.resigned_date || '-') : '到職：' + (emp.hire_date || '-')}</span>
                    </div>
                </div>
            `;
        });

        listEl.innerHTML = html;
    } catch (err) {
        console.error('Load all error:', err);
        listEl.innerHTML = '<p style="text-align:center;color:#ef4444;">載入失敗</p>';
    }
}

// ===== 編輯員工 Modal =====
export async function openEditEmployeeModal(empId) {
    document.getElementById('editEmpId').value = empId;
    try {
        const { data } = await sb.from('employees').select('*').eq('id', empId).single();
        if (data) {
            document.getElementById('editEmpName').value = data.name || '';
            loadDepartmentOptions('editEmpDept', data.department || '');
            document.getElementById('editEmpPosition').value = data.position || '';
            document.getElementById('editEmpPhone').value = data.phone || '';
            document.getElementById('editEmpHireDate').value = data.hire_date || '';
            document.getElementById('editEmpType').value = data.employment_type || 'fulltime';
            // 排班權限 + 免打卡（工時模式改在人力管理 tab 設定）
            const canScheduleEl = document.getElementById('editCanSchedule');
            if (canScheduleEl) canScheduleEl.checked = !!data.can_schedule;
            const noCheckinEl = document.getElementById('editNoCheckin');
            if (noCheckinEl) noCheckinEl.checked = !!data.no_checkin;
            const isKioskEl = document.getElementById('editIsKiosk');
            if (isKioskEl) isKioskEl.checked = !!data.is_kiosk;
            // LINE 綁定狀態
            const lineStatusEl = document.getElementById('editEmpLineStatus');
            const lineInputEl = document.getElementById('editEmpLineUserId');
            if (lineInputEl) lineInputEl.value = data.line_user_id || '';
            if (lineStatusEl) {
                if (data.line_user_id) {
                    lineStatusEl.innerHTML = '<span style="color:#10B981;font-weight:600;">✅ 已綁定</span>';
                } else {
                    lineStatusEl.innerHTML = '<span style="color:#F59E0B;font-weight:600;">⚠️ 未綁定 LINE</span>';
                }
            }
            // 角色欄位：僅 platform_admin 可見，且不能改自己
            const roleGroup = document.getElementById('editEmpRoleGroup');
            const roleSel = document.getElementById('editEmpRole');
            if (roleGroup && roleSel) {
                const isPlatformAdmin = window.currentEmployee && window.currentEmployee.role === 'platform_admin';
                const isSelf = window.currentEmployee && window.currentEmployee.id === data.id;
                // platform_admin 目標員工：不給一般 admin/platform_admin 降級，直接隱藏欄位避免誤操作
                const targetIsPlatformAdmin = data.role === 'platform_admin';
                if (isPlatformAdmin && !isSelf && !targetIsPlatformAdmin) {
                    // 只保留三個選項，不含 platform_admin
                    // DB CHECK: role IN ('admin','user','manager')
                    const currentRole = data.role && ['user','manager','admin'].includes(data.role) ? data.role : 'user';
                    roleSel.value = currentRole;
                    roleGroup.style.display = '';
                } else {
                    roleGroup.style.display = 'none';
                }
            }
        }
    } catch (e) { }
    document.getElementById('editEmployeeModal').style.display = 'flex';
}

export function closeEditEmployeeModal() {
    document.getElementById('editEmployeeModal').style.display = 'none';
}

export async function saveEditEmployee() {
    const empId = document.getElementById('editEmpId').value;
    if (!empId) return;
    const lineVal = (document.getElementById('editEmpLineUserId')?.value || '').trim();
    const updates = {
        name: document.getElementById('editEmpName').value.trim(),
        department: document.getElementById('editEmpDept').value,
        position: document.getElementById('editEmpPosition').value.trim(),
        phone: document.getElementById('editEmpPhone').value.trim() || null,
        hire_date: document.getElementById('editEmpHireDate').value || null,
        employment_type: document.getElementById('editEmpType').value,
        line_user_id: lineVal || null,
        is_bound: !!lineVal,
        can_schedule: !!document.getElementById('editCanSchedule')?.checked,
        no_checkin: !!document.getElementById('editNoCheckin')?.checked,
        is_kiosk: !!document.getElementById('editIsKiosk')?.checked
    };
    // 角色欄位：只有 platform_admin 看得到這組 UI 時才寫入 role
    const roleGroup = document.getElementById('editEmpRoleGroup');
    const roleSel = document.getElementById('editEmpRole');
    if (roleGroup && roleSel && roleGroup.style.display !== 'none') {
        const v = roleSel.value;
        // 白名單：避免前端被改注入 platform_admin（DB CHECK 也只接受 admin/user/manager）
        if (['user','manager','admin'].includes(v)) {
            updates.role = v;
        }
    }
    if (!updates.name) { showToast('⚠️ 姓名不可為空'); return; }
    try {
        const { error } = await sb.from('employees').update(updates).eq('id', empId);
        if (error) throw error;
        showToast('✅ 員工資料已更新');
        closeEditEmployeeModal();
        loadEmployeeList();
    } catch (e) {
        showToast('❌ 更新失敗: ' + friendlyError(e));
    }
}
