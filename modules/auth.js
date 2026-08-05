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
    feature: 'featurePage',
    booking: 'bookingMgrPage',
    member: 'memberMgrPage'
};

// 一般員工（非 admin/manager）也可存取的頁面 hash
const EMPLOYEE_ALLOWED_HASHES = ['booking'];

function getHashTargetPage() {
    const hash = window.location.hash.replace('#', '').toLowerCase();
    return HASH_PAGE_MAP[hash] || null;
}

export let currentAdminEmployee = null;
export let currentCompanyId = null;
export let companyAllowedFeatures = null;

// ===== 頁面路由 =====
export function showPage(id) {
    // 薪酬相關頁面需要權限檢查
    if (id === 'payrollPage') {
        if (typeof checkPayrollAccess === 'function') {
            checkPayrollAccess(function() { _doShowPage(id); });
            return;
        }
    }
    _doShowPage(id);
}

function _doShowPage(id) {
    document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
    document.getElementById(id).classList.add('active');

    if (id === 'locationPage') window.renderLocationList?.();
    if (id === 'employeePage') window.loadEmployeeList?.();
    if (id === 'approvalCenterPage') { window.switchApprovalType?.('leave', document.querySelector('.aprTab')); }
    if (id === 'announcementPage') window.loadAnnouncementList?.();
    if (id === 'featurePage') { window.switchSysTab?.('setting', document.querySelector('.sysTab')); }
    if (id === 'staffMgrPage') { window.loadEmployeeShiftModes?.(); window.loadMaxLeaveSetting?.(); window.loadStaffOverview?.(); window.loadAttendanceSettings?.(); }
    if (id === 'lunchMgrPage') { window.loadLunchManagers?.(); window.loadAdminLunchStats?.(); window.loadLunchDeadline?.(); }
    if (id === 'payrollPage') { window.switchPayTab?.('payroll', document.querySelector('.payTab')); }
    if (id === 'clientPage') { window.loadClientList?.(); window.loadServiceItemList?.(); }
    if (id === 'fieldSalesAdminPage') { window.switchFieldSalesAdmin?.('approval', document.querySelector('.fsaTab')); }
    if (id === 'restaurantPage') { window.loadRestaurantList?.(); }
    if (id === 'restaurantDetailPage') { /* loaded via openRestaurantDetail */ }
    if (id === 'bookingMgrPage') { window.loadBookingStoreList?.(); }
    if (id === 'memberMgrPage') { window.loadMemberStoreList?.(); }
    if (id === 'requestsMgrPage') { window.loadAllRequests?.(); }
    if (id === 'reportPage') { window.initReportMonth?.(); }
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
                // 平台管理員 — 不受角色限制，所有功能可見
                applyAdminFeatureVisibility();
                if (typeof applyAdminPermissions === 'function') applyAdminPermissions();
                // 顯示薪酬密碼設定
                var pwSection = document.getElementById('payrollPwSection');
                if (pwSection) pwSection.style.display = '';
                renderAdminCompanySwitcher();
            }, 800);
            return;
        }

        // === 一般管理員/主管流程（原邏輯）===
        const { data: adminRows, error } = await sb.from('employees')
            .select('*')
            .eq('line_user_id', liffProfile.userId)
            .in('role', ['admin', 'manager'])
            .eq('is_active', true);

        if (error) {
            console.error('❌ 資料庫查詢錯誤:', error);
            showStatus(statusEl, 'error', '❌ 資料庫查詢失敗: ' + error.message);
            return;
        }

        const activeAdminRows = (adminRows || []).filter(row => row.is_active && row.status !== 'pending');
        const savedAdminCompanyId = sessionStorage.getItem('selectedCompanyId');

        // 跨公司管理員且本次尚未選過公司 → 先回首頁選，選完自動回到 admin.html
        // （不然這裡會隨機取第一家，子頁面又會因為沒有選擇記錄而把人踢回首頁）
        if (!savedAdminCompanyId && activeAdminRows.length > 1) {
            const backTo = 'admin.html' + window.location.search + window.location.hash;
            // scope=admin：讓首頁的公司選單只列出有管理權限的公司
            window.location.href = 'index.html?scope=admin&next=' + encodeURIComponent(backTo);
            return;
        }

        const data = savedAdminCompanyId
            ? (activeAdminRows.find(row => row.company_id === savedAdminCompanyId) || activeAdminRows[0] || null)
            : (activeAdminRows[0] || null);

        if (!data) {
            // 檢查是否為員工允許存取的頁面（如 #booking）
            const hash = window.location.hash.replace('#', '').toLowerCase();
            if (EMPLOYEE_ALLOWED_HASHES.includes(hash)) {
                // 以一般員工身分載入
                const { data: empData } = await sb.from('employees')
                    .select('*')
                    .eq('line_user_id', liffProfile.userId)
                    .eq('is_active', true)
                    .maybeSingle();

                if (empData) {
                    console.log('📅 一般員工透過 #' + hash + ' 存取');
                    currentAdminEmployee = empData;
                    currentCompanyId = empData.company_id || null;
                    window.currentAdminEmployee = empData;
                    window.currentCompanyId = currentCompanyId;
                    updateAdminInfo(empData);
                    await loadSettings();

                    if (empData.company_id) {
                        try {
                            const { data: compData } = await sb.from('companies')
                                .select('name, features')
                                .eq('id', empData.company_id)
                                .maybeSingle();
                            companyAllowedFeatures = compData?.features || null;
                            window.companyAllowedFeatures = companyAllowedFeatures;
                        } catch (e) { console.log('載入公司功能設定失敗', e); }
                    }

                    showStatus(statusEl, 'success', '✅ 驗證通過');
                    setTimeout(() => {
                        const hashPage = getHashTargetPage();
                        showPage(hashPage || 'adminHomePage');
                    }, 800);
                    return;
                }
            }

            console.log('❌ 找不到管理員/主管資料，LINE ID:', liffProfile?.userId);
            showStatus(statusEl, 'error', '❌ 您沒有管理權限<br><small style="opacity:0.7">LINE ID: ' + escapeHTML(liffProfile?.userId || '未知') + '</small>', true);
            setTimeout(() => { window.location.href = 'index.html'; }, 5000);
            return;
        }

        currentAdminEmployee = data;
        currentCompanyId = data.company_id || null;
        window.currentAdminEmployee = data;
        window.currentCompanyId = currentCompanyId;
        // 記住本次身份所屬公司，子頁面（打卡總覽等）才不會因為沒有選擇記錄而被導回首頁
        if (currentCompanyId) sessionStorage.setItem('selectedCompanyId', currentCompanyId);
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

        // 跨公司管理員：帶出所有可管理公司名稱，供後台切換器使用
        window.myAdminCompanies = [];
        if (activeAdminRows.length > 1) {
            try {
                const ids = [...new Set(activeAdminRows.map(row => row.company_id).filter(Boolean))];
                const { data: compRows } = await sb.from('companies').select('id, name').in('id', ids);
                const nameMap = new Map((compRows || []).map(c => [c.id, c.name]));
                window.myAdminCompanies = activeAdminRows
                    .filter(row => row.company_id)
                    .map(row => ({
                        id: row.company_id,
                        name: nameMap.get(row.company_id) || '未命名公司',
                        role: row.role
                    }));
            } catch (e) { console.log('載入可管理公司清單失敗', e); }
        }

        showStatus(statusEl, 'success', '✅ 權限驗證通過');
        populateYearSelect('bonusYear');
        setTimeout(() => {
            const hashPage = getHashTargetPage();
            showPage(hashPage || 'adminHomePage');
            applyRoleVisibility();
            applyAdminFeatureVisibility();
            if (typeof applyAdminPermissions === 'function') applyAdminPermissions();
            renderAdminCompanySwitcher();
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
    // 平台管理員用 managedCompanies（可即時切換）；
    // 一般跨公司管理員用 myAdminCompanies（改 sessionStorage 後整頁重載）
    const isPlatform = !!window.isPlatformAdmin;
    const companies = isPlatform ? window.managedCompanies : window.myAdminCompanies;
    if (!companies || companies.length <= 1) return;
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
        const suffix = c.role === 'manager' ? (isPlatform ? ' (代管)' : ' (主管)') : '';
        opt.textContent = c.name + suffix;
        if (c.id === currentCompanyId) opt.selected = true;
        select.appendChild(opt);
    });
    select.addEventListener('change', () => {
        if (isPlatform) return switchCompanyAdmin(select.value);
        // 一般管理員沒有 managedCompanies 那套即時換資料的路徑，
        // 直接寫回選擇並重載，確保 currentAdminEmployee / 功能開關 / 子頁面全部一致
        if (select.value === window.currentCompanyId) return;
        sessionStorage.setItem('selectedCompanyId', select.value);
        window.location.reload();
    });

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

    // 清除跨公司殘留狀態
    if (typeof window.clearPayrollState === 'function') window.clearPayrollState();
    if (typeof window.clearSchedulesState === 'function') window.clearSchedulesState();
    if (typeof window.clearLeaveState === 'function') window.clearLeaveState();

    // 重新載入設定
    sessionStorage.removeItem('system_settings_cache');
    await loadSettings();

    // 重新套用功能可見性
    // 先顯示所有隱藏的項目，再重新過濾
    document.querySelectorAll('.menu-grid .menu-item[data-feature]').forEach(el => {
        el.style.display = '';
    });
    applyAdminFeatureVisibility();
    if (typeof applyAdminPermissions === 'function') applyAdminPermissions();

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
