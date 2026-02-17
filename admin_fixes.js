// ============================================================
// admin_fixes.js
// HR Attendance LIFF — 補充優化補丁
// 載入方式：在 admin.html 的 </body> 前加入
//   <script src="admin_fixes.js"></script>
// ============================================================

// ========================
// 1. 動態載入部門選項（從現有員工資料）
// ========================
async function loadDepartmentOptions() {
    try {
        const companyId = currentAdminEmployee?.company_id || currentCompanyId;
        if (!companyId) return;

        const { data } = await sb.from('employees')
            .select('department')
            .eq('company_id', companyId)
            .eq('is_active', true)
            .not('department', 'is', null);

        const depts = [...new Set((data || []).map(d => d.department).filter(Boolean))].sort();

        ['newEmployeeDepartment', 'editEmpDept'].forEach(selId => {
            const sel = document.getElementById(selId);
            if (!sel) return;
            const currentVal = sel.value;
            sel.innerHTML = '';
            depts.forEach(d => {
                sel.innerHTML += `<option value="${escapeHTML(d)}">${escapeHTML(d)}</option>`;
            });
            if (!depts.includes('其他')) {
                sel.innerHTML += '<option value="其他">其他</option>';
            }
            if (currentVal) sel.value = currentVal;
        });
    } catch (e) {
        console.log('載入部門列表失敗（非致命）:', e);
    }
}

// 在員工頁面載入時也載入部門
const _origLoadEmployeeList = window.loadEmployeeList;
if (typeof _origLoadEmployeeList === 'function') {
    window.loadEmployeeList = async function () {
        await _origLoadEmployeeList.call(this);
        loadDepartmentOptions();
    };
}

// ========================
// 2. 千分位格式化函數（確保存在）
// ========================
if (typeof parseMoney !== 'function') {
    window.parseMoney = function (str) {
        if (typeof str === 'number') return str;
        return parseInt(String(str || '0').replace(/[^\d-]/g, ''), 10) || 0;
    };
}
if (typeof toMoneyStr !== 'function') {
    window.toMoneyStr = function (num) {
        return (num || 0).toLocaleString();
    };
}
if (typeof formatNT !== 'function') {
    window.formatNT = function (amount) {
        return '$' + Math.round(amount || 0).toLocaleString();
    };
}

// ========================
// 3. 防止重複提交工具函數
// ========================
window.setBtnLoading = window.setBtnLoading || function (btn, loading, origText) {
    if (!btn) return;
    if (loading) {
        btn._origText = btn.textContent;
        btn.disabled = true;
        btn.textContent = '⏳ 處理中...';
        btn.style.opacity = '0.6';
    } else {
        btn.disabled = false;
        btn.textContent = origText || btn._origText || '確定';
        btn.style.opacity = '1';
    }
};

// ========================
// 4. 加強發布薪資確認（顯示金額明細）
// ========================
const _origPublishPayroll = window.publishPayroll;
if (typeof _origPublishPayroll === 'function') {
    window.publishPayroll = async function () {
        if (typeof payrollEmployees !== 'undefined' && payrollEmployees.length === 0) {
            showToast('⚠️ 請先計算並儲存薪資');
            return;
        }
        const year = parseInt(document.getElementById('payrollYear')?.value);
        const month = parseInt(document.getElementById('payrollMonth')?.value);
        const total = (payrollEmployees || []).reduce((s, e) => s + (e.net_salary || 0), 0);

        if (!confirm(
            `⚠️ 確定發布 ${year}年${month}月 薪資？\n\n` +
            `員工人數：${(payrollEmployees || []).length} 人\n` +
            `薪資總額：$${Math.round(total).toLocaleString()}\n\n` +
            `發布後員工將在薪資頁面看到明細。`
        )) return;

        return _origPublishPayroll.call(this);
    };
}

// ========================
// 5. 動態載入職位選項
// ========================
const _origOpenEdit = window.openEditEmployeeModal;
if (typeof _origOpenEdit === 'function') {
    window.openEditEmployeeModal = async function (empId) {
        await _origOpenEdit.call(this, empId);

        // 動態載入職位
        try {
            const companyId = currentAdminEmployee?.company_id || currentCompanyId;
            if (!companyId) return;

            const { data } = await sb.from('employees')
                .select('position')
                .eq('company_id', companyId)
                .eq('is_active', true)
                .not('position', 'is', null);

            const positions = [...new Set((data || []).map(d => d.position).filter(Boolean))].sort();
            const posSelect = document.getElementById('editEmpPosition');
            if (!posSelect) return;

            const currentVal = posSelect.value;
            posSelect.innerHTML = '<option value="">-- 選擇職位 --</option>';
            positions.forEach(p => {
                posSelect.innerHTML += `<option value="${escapeHTML(p)}">${escapeHTML(p)}</option>`;
            });
            if (currentVal) posSelect.value = currentVal;
        } catch (e) { /* 非致命 */ }
    };
}

// ========================
// 完成
// ========================
console.log('✅ admin_fixes.js 已載入 — 5 項補充優化');
