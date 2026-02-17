// ============================================================
// modules/auth.js — 登入與權限管理
// 依賴 common.js 全域: sb, initializeLiff, liffProfile, showStatus,
//   escapeHTML, populateYearSelect, loadSettings, friendlyError
// ============================================================

export let currentAdminEmployee = null;
export let currentCompanyId = null;
export let companyAllowedFeatures = null;

// ===== 頁面路由 =====
export function showPage(id) {
    document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
    document.getElementById(id).classList.add('active');

    if (id === 'bonusPage') window.loadHybridBonusData?.();
    if (id === 'locationPage') window.renderLocationList?.();
    if (id === 'employeePage') window.loadEmployeeList?.();
    if (id === 'approvalCenterPage') { window.switchApprovalType?.('leave', document.querySelector('.aprTab')); }
    if (id === 'announcementPage') window.loadAnnouncementList?.();
    if (id === 'auditLogPage') window.loadAuditLogs?.();
    if (id === 'featurePage') { window.loadFeatureSettings?.(); window.loadNotifyToken?.(); }
    if (id === 'staffMgrPage') { window.loadShiftMgr?.(); window.loadMaxLeaveSetting?.(); window.loadStaffOverview?.(); window.loadSchedulingMode?.(); }
    if (id === 'lunchMgrPage') { window.loadLunchManagers?.(); window.loadAdminLunchStats?.(); }
    if (id === 'payrollPage') { window.initPayrollPage?.(); }
    if (id === 'clientPage') { window.loadClientList?.(); window.loadServiceItemList?.(); }
    if (id === 'fieldSalesAdminPage') { window.switchFieldSalesAdmin?.('approval', document.querySelector('.fsaTab')); }
    if (id === 'insurancePage') { window.loadInsuranceBrackets?.(); }
    if (id === 'restaurantPage') { window.loadRestaurantList?.(); }
    if (id === 'restaurantDetailPage') { /* loaded via openRestaurantDetail */ }
}

// ===== 檢查管理員權限 =====
export async function checkAdminPermission() {
    const statusEl = document.getElementById('permissionStatus');
    const loadingPage = document.getElementById('loadingPage');

    try {
        const initialized = await initializeLiff();

        if (loadingPage) loadingPage.style.display = 'none';

        if (!initialized) {
            showStatus(statusEl, 'error', '❌ LIFF 初始化失敗，請從 LINE 開啟');
            return;
        }

        console.log('🔑 LINE User ID:', liffProfile?.userId);

        const { data, error } = await sb.from('employees')
            .select('*')
            .eq('line_user_id', liffProfile.userId)
            .in('role', ['admin', 'manager'])
            .eq('is_active', true)
            .maybeSingle();

        if (error) {
            console.error('❌ 資料庫查詢錯誤:', error);
            showStatus(statusEl, 'error', '❌ 資料庫查詢失敗: ' + error.message);
            return;
        }

        if (!data) {
            console.log('❌ 找不到管理員/主管資料，LINE ID:', liffProfile?.userId);
            showStatus(statusEl, 'error', '❌ 您沒有管理權限<br><small style="opacity:0.7">LINE ID: ' + escapeHTML(liffProfile?.userId || '未知') + '</small>', true);
            setTimeout(() => { window.location.href = 'index.html'; }, 5000);
            return;
        }

        currentAdminEmployee = data;
        currentCompanyId = data.company_id || null;
        window.currentAdminEmployee = data;
        window.currentCompanyId = currentCompanyId;
        updateAdminInfo(data);

        await loadSettings();

        if (data.company_id) {
            try {
                const { data: compData } = await sb.from('companies')
                    .select('name, features')
                    .eq('id', data.company_id)
                    .maybeSingle();
                companyAllowedFeatures = compData?.features || null;
                window.companyAllowedFeatures = companyAllowedFeatures;
                if (compData?.name) {
                    const el = document.getElementById('adminCompanyName');
                    if (el) { el.textContent = compData.name; el.style.display = 'block'; }
                }
            } catch (e) { console.log('載入公司功能設定失敗', e); }
        }

        showStatus(statusEl, 'success', '✅ 權限驗證通過');
        populateYearSelect('bonusYear');
        setTimeout(() => {
            showPage('adminHomePage');
            document.getElementById('bottomNav').style.display = 'flex';
            applyRoleVisibility();
            applyAdminFeatureVisibility();
        }, 800);

    } catch (err) {
        console.error('權限檢查異常:', err);
        if (loadingPage) loadingPage.style.display = 'none';
        showStatus(statusEl, 'error', '❌ 權限檢查失敗: ' + (typeof friendlyError === 'function' ? friendlyError(err) : err.message));
    }
}

// ===== 更新管理員資訊 =====
export function updateAdminInfo(data) {
    const roleLabel = data.role === 'admin' ? '管理員' : '主管';
    document.getElementById('adminName').textContent = data.name;
    document.getElementById('adminDept').textContent = `${data.department || '系統管理'} · ${roleLabel}`;
    document.getElementById('adminId').textContent = `ID: ${data.employee_number}`;

    const avatar = document.getElementById('adminAvatar');
    if (liffProfile?.pictureUrl) {
        avatar.style.backgroundImage = `url(${liffProfile.pictureUrl})`;
        avatar.style.backgroundSize = 'cover';
        avatar.textContent = '';
    } else {
        avatar.textContent = data.role === 'admin' ? '👑' : '👤';
    }
}

// ===== 角色可見性 =====
export function applyRoleVisibility() {
    if (!currentAdminEmployee) return;
    const role = currentAdminEmployee.role;
    if (role === 'admin') return;
    document.querySelectorAll('.menu-grid .menu-item[data-require="admin"]').forEach(el => {
        el.style.display = 'none';
    });
}

export function applyAdminFeatureVisibility() {
    if (!companyAllowedFeatures) return;
    document.querySelectorAll('.menu-grid .menu-item[data-feature]').forEach(el => {
        const keys = el.getAttribute('data-feature').split(',');
        const visible = keys.some(k => companyAllowedFeatures[k.trim()] === true);
        if (!visible) el.style.display = 'none';
    });
}

// ===== 外勤/業務 tab 切換 =====
export function switchFieldSalesAdmin(tab, btn) {
    document.querySelectorAll('.fsaTab').forEach(t => {
        t.style.background = 'transparent'; t.style.color = '#94A3B8'; t.style.boxShadow = 'none';
    });
    if (btn) { btn.style.background = '#fff'; btn.style.color = '#4F46E5'; btn.style.boxShadow = '0 1px 4px rgba(0,0,0,0.08)'; }
    document.getElementById('fsaApprovalTab').style.display = tab === 'approval' ? 'block' : 'none';
    document.getElementById('fsaTargetTab').style.display = tab === 'target' ? 'block' : 'none';
    if (tab === 'approval') window.initFieldWorkApproval?.();
    if (tab === 'target') window.initSalesTargetPage?.();
}
