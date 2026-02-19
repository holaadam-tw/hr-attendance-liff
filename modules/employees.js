// ============================================================
// modules/employees.js — 員工管理 CRUD + 薪資設定
// 依賴 common.js 全域: sb, showToast, escapeHTML, friendlyError,
//   fmtDate, setBtnLoading, formatMoneyInput, parseMoney, toMoneyStr,
//   formatNT, writeAuditLog, CONFIG
// ============================================================

let currentSalaryEmpId = null;

// ===== 新增員工 Modal =====
export function showAddEmployeeModal() {
    document.getElementById('addEmployeeModal').style.display = 'flex';
    document.getElementById('newEmployeeHireDate').value = fmtDate(new Date());
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
export function showJoinQRCode() {
    const modal = document.getElementById('qrModal');
    const qrcodeDiv = document.getElementById('qrcode');
    qrcodeDiv.innerHTML = '';

    const liffUrl = `https://liff.line.me/${CONFIG.LIFF_ID}?type=bind&company=HR_SYSTEM_001`;

    new QRCode(qrcodeDiv, {
        text: liffUrl, width: 200, height: 200,
        colorDark: "#1f2937", colorLight: "#ffffff",
        correctLevel: QRCode.CorrectLevel.H
    });

    modal.style.display = 'flex';
}

export function closeQRModal() {
    document.getElementById('qrModal').style.display = 'none';
}

// ===== 載入員工列表 =====
export async function loadEmployeeList() {
    const listEl = document.getElementById('employeeList');
    if (!listEl) return;

    try {
        const { data, error } = await sb.from('employees')
            .select('*')
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
                        到職: ${emp.hire_date || '未設定'} · ${emp.employment_type === 'parttime' ? '兼職' : '正職'} · ${emp.line_user_id ? '✅ 已綁定' : '⏳ 未綁定'}
                    </div>
                    <div style="margin-top:8px;display:flex;gap:6px;flex-wrap:wrap;">
                        <button onclick="openEditEmployeeModal('${emp.id}')" style="padding:7px 12px;border:1px solid #E5E7EB;border-radius:8px;background:#fff;font-size:11px;font-weight:700;cursor:pointer;color:#4F46E5;">✏️ 編輯</button>
                        ${emp.line_user_id ? `
                            <button onclick="updateEmployeeRoleAdmin('${emp.id}', '${emp.role === 'admin' ? 'user' : 'admin'}', '${escapeHTML(emp.name)}')" style="padding:7px 12px;border:1px solid #E5E7EB;border-radius:8px;background:#fff;font-size:11px;font-weight:700;cursor:pointer;color:#EA580C;">
                                ${emp.role === 'admin' ? '取消管理員' : '設為管理員'}
                            </button>
                        ` : ''}
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
            .eq('id', employeeId);

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

// ===== 編輯員工 Modal =====
export async function openEditEmployeeModal(empId) {
    document.getElementById('editEmpId').value = empId;
    try {
        const { data } = await sb.from('employees').select('*').eq('id', empId).single();
        if (data) {
            document.getElementById('editEmpName').value = data.name || '';
            document.getElementById('editEmpDept').value = data.department || '管理部';
            document.getElementById('editEmpPosition').value = data.position || '';
            document.getElementById('editEmpHireDate').value = data.hire_date || '';
            document.getElementById('editEmpType').value = data.employment_type || 'fulltime';
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
    const updates = {
        name: document.getElementById('editEmpName').value.trim(),
        department: document.getElementById('editEmpDept').value,
        position: document.getElementById('editEmpPosition').value.trim(),
        hire_date: document.getElementById('editEmpHireDate').value,
        employment_type: document.getElementById('editEmpType').value
    };
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
