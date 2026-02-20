// ============================================================
// modules/auth.js — 登入與權限管理
// 依賴 common.js 全域: sb, initializeLiff, liffProfile, showStatus,
//   escapeHTML, populateYearSelect, loadSettings, friendlyError
// ============================================================

// URL hash → page ID 對照
const HASH_PAGE_MAP = {
    restaurant: 'restaurantPage',
    employee: 'employeePage',
    approval: 'approvalCenterPage',
    payroll: 'payrollPage',
    feature: 'featurePage'
};

function getHashTargetPage() {
    const hash = window.location.hash.replace('#', '').toLowerCase();
    return HASH_PAGE_MAP[hash] || null;
}

export let currentAdminEmployee = null;
export let currentCompanyId = null;
export let companyAllowedFeatures = null;

// ===== 頁面路由 =====
export function showPage(id) {
    document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
    document.getElementById(id).classList.add('active');

    if (id === 'locationPage') window.renderLocationList?.();
    if (id === 'employeePage') window.loadEmployeeList?.();
    if (id === 'approvalCenterPage') { window.switchApprovalType?.('leave', document.querySelector('.aprTab')); }
    if (id === 'announcementPage') window.loadAnnouncementList?.();
    if (id === 'featurePage') { window.switchSysTab?.('feature', document.querySelector('.sysTab')); }
    if (id === 'staffMgrPage') { window.loadShiftMgr?.(); window.loadMaxLeaveSetting?.(); window.loadStaffOverview?.(); window.loadSchedulingMode?.(); }
    if (id === 'lunchMgrPage') { window.loadLunchManagers?.(); window.loadAdminLunchStats?.(); }
    if (id === 'payrollPage') { window.switchPayTab?.('payroll', document.querySelector('.payTab')); }
    if (id === 'clientPage') { window.loadClientList?.(); window.loadServiceItemList?.(); }
    if (id === 'fieldSalesAdminPage') { window.switchFieldSalesAdmin?.('approval', document.querySelector('.fsaTab')); }
    if (id === 'restaurantPage') { window.loadRestaurantList?.(); }
    if (id === 'restaurantDetailPage') { /* loaded via openRestaurantDetail */ }
    if (id === 'bookingMgrPage') { window.loadBookingStoreList?.(); }
    if (id === 'memberMgrPage') { window.loadMemberStoreList?.(); }
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

        // === 先檢查平台管理員 ===
        const { data: padmin } = await sb.from('platform_admins')
            .select('*')
            .eq('line_user_id', liffProfile.userId)
            .eq('is_active', true)
            .maybeSingle();

        if (padmin) {
            console.log('👑 平台管理員:', padmin.name);
            window.isPlatformAdmin = true;
            window.currentPlatformAdmin = padmin;

            // 載入可管理公司列表
            const { data: pac } = await sb.from('platform_admin_companies')
                .select('company_id, role, companies(id, name, features, status)')
                .eq('platform_admin_id', padmin.id);
            window.managedCompanies = (pac || []).map(r => ({
                id: r.company_id,
                name: r.companies?.name || '未命名',
                features: r.companies?.features || null,
                status: r.companies?.status || 'active',
                role: r.role
            }));

            // 恢復上次選擇的公司
            const savedId = sessionStorage.getItem('selectedCompanyId');
            const saved = savedId && window.managedCompanies.find(c => c.id === savedId);
            const selected = saved || window.managedCompanies[0];

            if (selected) {
                currentCompanyId = selected.id;
                companyAllowedFeatures = selected.features;
                window.currentCompanyId = currentCompanyId;
                window.companyAllowedFeatures = companyAllowedFeatures;
                sessionStorage.setItem('selectedCompanyId', selected.id);

                const el = document.getElementById('adminCompanyName');
                if (el) { el.textContent = selected.name; el.style.display = 'block'; }
            }

            // 嘗試取得該公司的 employee 記錄
            const { data: empData } = await sb.from('employees')
                .select('*')
                .eq('line_user_id', liffProfile.userId)
                .eq('company_id', currentCompanyId)
                .maybeSingle();

            currentAdminEmployee = empData || {
                id: null,
                name: padmin.name,
                role: 'admin',
                department: '平台管理',
                position: '平台管理員',
                employee_number: 'PA-001',
                line_user_id: padmin.line_user_id,
                company_id: currentCompanyId
            };
            window.currentAdminEmployee = currentAdminEmployee;

            updateAdminInfo(currentAdminEmployee);
            await loadSettings();

            showStatus(statusEl, 'success', '✅ 平台管理員驗證通過');
            populateYearSelect('bonusYear');
            setTimeout(() => {
                // 檢查 URL hash 跳轉（例如 admin.html#restaurant）
                const hashPage = getHashTargetPage();
                showPage(hashPage || 'adminHomePage');
                document.getElementById('bottomNav').style.display = 'flex';
                // 平台管理員 — 不受角色限制，所有功能可見
                applyAdminFeatureVisibility();
                renderAdminCompanySwitcher();
            }, 800);
            return;
        }

        // === 一般管理員/主管流程（原邏輯）===
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
            const hashPage = getHashTargetPage();
            showPage(hashPage || 'adminHomePage');
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
    const roleLabel = window.isPlatformAdmin ? '平台管理員' : (data.role === 'admin' ? '管理員' : '主管');
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

// ===== admin.html 公司切換器 =====
export function renderAdminCompanySwitcher() {
    const companies = window.managedCompanies;
    if (!window.isPlatformAdmin || !companies || companies.length <= 1) return;
    if (document.getElementById('adminCompanySwitcher')) return;

    const target = document.getElementById('adminCompanyName');
    if (!target) return;

    // 隱藏原本文字
    target.style.display = 'none';

    const select = document.createElement('select');
    select.id = 'adminCompanySwitcher';
    select.style.cssText = 'width:100%;padding:8px 12px;border:none;border-radius:8px;font-size:15px;font-weight:700;color:#4F46E5;background:transparent;cursor:pointer;appearance:auto;margin-bottom:4px;';
    companies.forEach(c => {
        const opt = document.createElement('option');
        opt.value = c.id;
        opt.textContent = c.name + (c.role === 'manager' ? ' (代管)' : '');
        if (c.id === currentCompanyId) opt.selected = true;
        select.appendChild(opt);
    });
    select.addEventListener('change', () => switchCompanyAdmin(select.value));

    target.parentNode.insertBefore(select, target);
}

export async function switchCompanyAdmin(companyId) {
    const companies = window.managedCompanies;
    const company = companies?.find(c => c.id === companyId);
    if (!company) return;

    currentCompanyId = company.id;
    companyAllowedFeatures = company.features;
    window.currentCompanyId = currentCompanyId;
    window.companyAllowedFeatures = companyAllowedFeatures;
    sessionStorage.setItem('selectedCompanyId', company.id);

    // 嘗試取得該公司的 employee 記錄
    const { data: empData } = await sb.from('employees')
        .select('*')
        .eq('line_user_id', liffProfile.userId)
        .eq('company_id', companyId)
        .maybeSingle();

    currentAdminEmployee = empData || {
        id: null,
        name: window.currentPlatformAdmin.name,
        role: 'admin',
        department: '平台管理',
        position: '平台管理員',
        employee_number: 'PA-001',
        line_user_id: window.currentPlatformAdmin.line_user_id,
        company_id: companyId
    };
    window.currentAdminEmployee = currentAdminEmployee;
    updateAdminInfo(currentAdminEmployee);

    // 重新載入設定
    sessionStorage.removeItem('system_settings_cache');
    await loadSettings();

    // 重新套用功能可見性
    // 先顯示所有隱藏的項目，再重新過濾
    document.querySelectorAll('.menu-grid .menu-item[data-feature]').forEach(el => {
        el.style.display = '';
    });
    applyAdminFeatureVisibility();

    // 更新公司名稱
    const el = document.getElementById('adminCompanyName');
    if (el) el.textContent = company.name;

    // 回到首頁
    showPage('adminHomePage');
    if (typeof showToast === 'function') showToast('已切換至 ' + company.name);
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
