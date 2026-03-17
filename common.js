// ================= 設定與初始化 =================
const CONFIG = {
    LIFF_ID: '2008962829-bnsS1bbB',
    SUPABASE_URL: 'https://nssuisyvlrqnqfxupklb.supabase.co',
    SUPABASE_ANON_KEY: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im5zc3Vpc3l2bHJxbnFmeHVwa2xiIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjkyOTAwMzUsImV4cCI6MjA4NDg2NjAzNX0.q_B6v3gf1TOCuAq7z0xIw10wDueCSJn0p37VzdMfmbc',
    BUCKET: 'selfies'
};

const sb = window.supabase.createClient(CONFIG.SUPABASE_URL, CONFIG.SUPABASE_ANON_KEY);

// 全域變數
let liffProfile = null;
let currentEmployee = null;
let currentCompanyId = null;    // 多租戶：當前公司 ID
let currentCompanyFeatures = null; // 多租戶：當前公司功能設定
let currentCompanyName = null;     // 多租戶：當前公司名稱
let currentCompanyIndustry = null; // 多租戶：當前公司產業別
let isPlatformAdmin = false;       // 是否為平台管理員
let currentPlatformAdmin = null;   // 平台管理員資料
let managedCompanies = [];         // 可管理的公司列表
let videoStream = null;
let cachedLocation = null;
let currentBindMode = 'id_card';
let todayAttendance = null;
let officeLocations = [];
let isProcessing = false;

// ===== 初始化 LIFF =====
async function initializeLiff() {
    try {
        console.log('🚀 系統初始化...');
        await liff.init({ liffId: CONFIG.LIFF_ID });
        if (!liff.isLoggedIn()) { 
            // [BUG FIX] 登入後導回當前頁面，而非只回 index.html
            liff.login({ redirectUri: window.location.href }); 
            return false;
        }
        
        liffProfile = await liff.getProfile();
        return true;
    } catch (error) {
        console.error('LIFF 初始化失敗:', error);
        showToast('⚠️ 系統初始化失敗，請重新整理');
        return false;
    }
}

// ===== 核心工具函數 =====

// 取得台灣時間 YYYY-MM-DD
function getTaiwanDate(offsetDays = 0) {
    const date = new Date();
    date.setDate(date.getDate() + offsetDays);
    return date.toLocaleDateString('en-CA', { timeZone: 'Asia/Taipei' });
}

// 任意 Date 物件 → YYYY-MM-DD（本地時區，避免 toISOString UTC 偏移）
function fmtDate(d) {
    return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}

// 貨幣顯示格式化（NT$ 千分位）
function formatNT(n) { return 'NT$ ' + Math.abs(Math.round(n)).toLocaleString(); }

// 金額輸入框千分位格式化（綁定到 input 事件）
function formatMoneyInput(el) {
    if (!el || el._moneyFormatted) return;
    el._moneyFormatted = true;
    el.addEventListener('input', function() {
        const raw = this.value.replace(/[^\d]/g, '');
        this.value = raw ? parseInt(raw, 10).toLocaleString() : '';
    });
}

// 解析帶逗點的金額字串為數字
function parseMoney(str) {
    if (typeof str === 'number') return str;
    return parseFloat(String(str || '0').replace(/[^\d.-]/g, '')) || 0;
}

// 將數字格式化為千分位字串（不含 NT$ 前綴）
function toMoneyStr(n) {
    if (!n && n !== 0) return '';
    return Math.round(Number(n)).toLocaleString();
}

// 計算距離 (Haversine)
function calculateDistance(lat1, lon1, lat2, lon2) {
    const R = 6371e3; 
    const φ1 = lat1 * Math.PI/180;
    const φ2 = lat2 * Math.PI/180;
    const Δφ = (lat2-lat1) * Math.PI/180;
    const Δλ = (lon2-lon1) * Math.PI/180;

    const a = Math.sin(Δφ/2) * Math.sin(Δφ/2) +
              Math.cos(φ1) * Math.cos(φ2) *
              Math.sin(Δλ/2) * Math.sin(Δλ/2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));

    return R * c;
}

// 狀態顯示（預設純文字，useHTML=true 時允許 HTML）
function showStatus(el, type, msg, useHTML = false) {
    if (!el) return;
    el.className = `status-box show ${type}`;
    if (useHTML) { el.innerHTML = msg; } else { el.textContent = msg; }
}

// [BUG FIX] Toast — 改進：避免重疊、限制同時顯示數量
function showToast(msg) { 
    // 移除舊的 toast 避免堆疊
    const oldToasts = document.querySelectorAll('.toast');
    if (oldToasts.length > 2) {
        oldToasts[0].remove();
    }
    
    const t = document.createElement('div'); 
    t.className = 'toast'; 
    t.textContent = msg; 
    document.body.appendChild(t); 
    setTimeout(() => {
        if (t.parentNode) t.remove();
    }, 3000); 
}

// 按鈕 loading 狀態（防重複提交）
function setBtnLoading(btn, loading, originalText) {
    if (!btn) return;
    if (loading) {
        btn._originalText = btn.textContent;
        btn.disabled = true;
        btn.textContent = '⏳ 處理中...';
        btn.style.opacity = '0.6';
    } else {
        btn.disabled = false;
        btn.textContent = originalText || btn._originalText || '提交';
        btn.style.opacity = '1';
    }
}

// HTML 跳脫（防 XSS）
function escapeHTML(str) {
    if (!str) return '';
    const div = document.createElement('div');
    div.textContent = String(str);
    return div.innerHTML;
}

// XSS 防護簡寫（供 HTML 模板使用）
function esc(str) {
    if (str == null) return '';
    return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}
window.esc = esc; // 供全域使用

// 動態填入年度選項（當年 + 前2年）
function populateYearSelect(selectId) {
    const sel = document.getElementById(selectId);
    if (!sel) return;
    const now = new Date();
    const currentYear = now.toLocaleString('en-US', { timeZone: 'Asia/Taipei', year: 'numeric' });
    for (let y = parseInt(currentYear); y >= parseInt(currentYear) - 2; y--) {
        const opt = document.createElement('option');
        opt.value = y;
        opt.textContent = y;
        sel.appendChild(opt);
    }
}

// 友善錯誤訊息
function friendlyError(err) {
    const msg = err?.message || String(err);
    if (msg.includes('fetch') || msg.includes('network') || msg.includes('Failed')) {
        return '網路連線異常，請檢查網路後重試';
    }
    if (msg.includes('timeout')) return '連線逾時，請稍後再試';
    if (msg.includes('permission') || msg.includes('denied')) return '權限不足';
    if (msg.includes('not found') || msg.includes('404')) return '找不到資料';
    return msg;
}

// ===== 用戶狀態 =====
async function checkUserStatus() {
    const loadingEl = document.getElementById('loadingPage');
    if (loadingEl) loadingEl.style.display = 'flex';

    try {
        const _td0 = document.getElementById('topDebug');
        if (_td0) _td0.innerHTML += '<br>🅰️ try 開始';
        // === 先檢查是否為平台管理員 ===
        const { data: padmin, error: padminErr } = await sb.from('platform_admins')
            .select('*')
            .eq('line_user_id', liffProfile.userId)
            .eq('is_active', true)
            .maybeSingle();
        if (_td0) _td0.innerHTML += '<br>🅱️ padmin=' + (padmin ? padmin.name : 'null') + ' err=' + (padminErr ? padminErr.message : 'null');

        if (padmin) {
            isPlatformAdmin = true;
            window.isPlatformAdmin = true;
            currentPlatformAdmin = padmin;
            // 載入可管理公司列表（含 role）
            const { data: pac } = await sb.from('platform_admin_companies')
                .select('company_id, role, companies(id, name, features, status, industry)')
                .eq('platform_admin_id', padmin.id);
            managedCompanies = (pac || []).map(r => ({
                id: r.company_id,
                name: r.companies?.name || '未命名',
                features: r.companies?.features || null,
                status: r.companies?.status || 'active',
                industry: r.companies?.industry || 'general',
                role: r.role
            }));

            // 恢復上次選擇的公司（sessionStorage）
            const savedCompanyId = sessionStorage.getItem('selectedCompanyId');
            const savedCompany = savedCompanyId && managedCompanies.find(c => c.id === savedCompanyId);
            const selected = savedCompany || managedCompanies[0];

            if (!selected) {
                if (loadingEl) loadingEl.style.display = 'none';
                showToast('⚠️ 尚無可管理的公司');
                return false;
            }

            if (selected) {
                currentCompanyId = selected.id;
                currentCompanyFeatures = selected.features;
                currentCompanyName = selected.name;
                currentCompanyIndustry = selected.industry || 'general';
                window.currentCompanyId = currentCompanyId;
                sessionStorage.setItem('selectedCompanyId', selected.id);
            }

            // 建立虛擬 employee 物件（平台管理員可能不在該公司有 employee 記錄）
            const { data: empData } = await sb.from('employees')
                .select('*')
                .eq('line_user_id', liffProfile.userId)
                .eq('company_id', currentCompanyId)
                .maybeSingle();

            currentEmployee = empData || {
                id: null,
                name: padmin.name,
                role: 'admin',
                department: '平台管理',
                position: '平台管理員',
                employee_number: 'PA-001',
                line_user_id: padmin.line_user_id,
                company_id: currentCompanyId
            };
            window.currentEmployee = currentEmployee;

            // 並行載入設定和考勤
            const parallelTasks = [loadSettings()];
            if (currentEmployee.id) parallelTasks.push(checkTodayAttendance());
            await Promise.all(parallelTasks);
            if (loadingEl) loadingEl.style.display = 'none';
            updateUserInfo(currentEmployee);
            // 顯示公司名稱
            const hcn = document.getElementById('homeCompanyName');
            if (hcn && currentCompanyName) { hcn.textContent = currentCompanyName; hcn.style.display = 'block'; }
            return true;
        }

        // === 一般員工流程（原邏輯）===
        const _td = document.getElementById('topDebug');
        if (_td) _td.innerHTML += '<br>🔍 查詢 employees by uid=' + liffProfile.userId;
        const { data, error } = await sb.from('employees')
            .select('*')
            .eq('line_user_id', liffProfile.userId)
            .maybeSingle();
        if (_td) _td.innerHTML += '<br>📋 data=' + (data ? data.name : 'null') + ' error=' + (error ? error.message : 'null');

        if (loadingEl) loadingEl.style.display = 'none';

        if (data) {
            currentEmployee = data;
            currentCompanyId = data.company_id || null;
            window.currentCompanyId = currentCompanyId;
            window.currentEmployee = currentEmployee;
            // 並行載入公司設定、system_settings、今日考勤
            if (currentCompanyId) {
                try {
                    const { data: company } = await sb.from('companies')
                        .select('name, features, status, industry')
                        .eq('id', currentCompanyId)
                        .maybeSingle();
                    currentCompanyFeatures = company?.features || null;
                    currentCompanyName = company?.name || null;
                    currentCompanyIndustry = company?.industry || 'general';
                } catch(e) { console.log('載入公司資料失敗', e); }
                await Promise.all([loadSettings(), checkTodayAttendance()]);
            }
            updateUserInfo(data);
            return true;
        } else {
            return false;
        }
    } catch (err) {
        console.error('檢查用戶狀態失敗:', err);
        const _td2 = document.getElementById('topDebug');
        if (_td2) _td2.innerHTML += '<br>💥 catch: ' + err.message;
        if (loadingEl) loadingEl.style.display = 'none';
        return false;
    }
}

// 更新用戶資訊
function updateUserInfo(data) {
    const userNameEl = document.getElementById('userName');
    const userDeptEl = document.getElementById('userDept');
    const userIdEl = document.getElementById('userId');
    const avatarEl = document.getElementById('userAvatar');
    
    if (userNameEl) userNameEl.textContent = data.name;
    if (userDeptEl) userDeptEl.textContent = `${data.department || '-'} ${data.position || ''}`;
    if (userIdEl) userIdEl.textContent = `ID: ${data.employee_number}`;
    
    if (avatarEl) {
        if (liffProfile?.pictureUrl) {
            avatarEl.style.backgroundImage = `url(${liffProfile.pictureUrl})`;
            avatarEl.style.backgroundSize = 'cover'; 
            avatarEl.textContent = '';
        } else {
            avatarEl.textContent = data.name?.charAt(0) || '?';
        }
    }
}

// ===== 系統設定（含快取） =====
let _settingsCache = null; // { key: value, ... }

async function loadSettings(forceRefresh) {
    try {
        const _loadCompanyId = window.currentCompanyId || window.currentEmployee?.company_id || currentEmployee?.company_id;

        // 優先從 sessionStorage 讀取快取（跨頁共用，減少 API 呼叫）
        // feature_visibility 不快取，每次從 DB 讀最新值
        if (!forceRefresh) {
            const cached = sessionStorage.getItem('system_settings_cache');
            if (cached) {
                try {
                    _settingsCache = JSON.parse(cached);
                    officeLocations = _settingsCache['office_locations'] || [];
                } catch(e) { sessionStorage.removeItem('system_settings_cache'); }
                // 即使有快取，也要從 DB 讀取最新的 feature_visibility
                if (_loadCompanyId) {
                    try {
                        const { data: fvData } = await sb.from('system_settings')
                            .select('value')
                            .eq('company_id', _loadCompanyId)
                            .eq('key', 'feature_visibility')
                            .maybeSingle();
                        if (fvData) _settingsCache['feature_visibility'] = fvData.value;
                    } catch(e) {}
                }
                return;
            }
        }

        // 一次查出所有 system_settings，避免多次查詢
        if (!_loadCompanyId) return;
        const { data, error } = await sb.from('system_settings')
            .select('key, value')
            .eq('company_id', _loadCompanyId);
        if (!error && data) {
            _settingsCache = {};
            data.forEach(row => { _settingsCache[row.key] = row.value; });
            officeLocations = _settingsCache['office_locations'] || [];
            // 寫入 sessionStorage，排除 feature_visibility（確保每次從 DB 讀最新值）
            try {
                const cacheToStore = { ..._settingsCache };
                delete cacheToStore['feature_visibility'];
                sessionStorage.setItem('system_settings_cache', JSON.stringify(cacheToStore));
            } catch(e) {}
        }
    } catch (e) {
        console.error('載入設定失敗', e);
    }
}

// 清除設定快取（管理員修改設定後呼叫）
function invalidateSettingsCache() {
    _settingsCache = null;
    try { sessionStorage.removeItem('system_settings_cache'); } catch(e) {}
}

// 從快取取得 system_settings 的值，避免重複查詢 DB
function getCachedSetting(key) {
    return _settingsCache ? _settingsCache[key] : null;
}

// 統一儲存 system_settings（先查再更新，避免重複 insert）
async function saveSetting(key, value, description) {
    var companyId = window.currentCompanyId || window.currentEmployee?.company_id || currentEmployee?.company_id;
    if (!companyId) { console.warn('saveSetting: no companyId'); return; }

    var { data: existing } = await sb.from('system_settings')
        .select('id')
        .eq('key', key)
        .eq('company_id', companyId)
        .maybeSingle();

    if (existing) {
        await sb.from('system_settings')
            .update({ value: value, updated_at: new Date().toISOString() })
            .eq('id', existing.id);
    } else {
        await sb.from('system_settings')
            .insert({ key: key, value: value, company_id: companyId, description: description || key });
    }

    invalidateSettingsCache();
    await loadSettings(true);
}

// 新公司初始化預設設定
async function initCompanySettings(companyId) {
    var defaults = [
        { key: 'feature_visibility', value: {leave:true, attendance:true, salary:true, lunch:true, fieldwork:true, sales_target:true, store_ordering:true, booking:true, loyalty:true}, description: '功能開關（第二層，業主微調）' },
        { key: 'work_hours', value: {start:'08:00', end:'18:00', break:60}, description: '工作時間' },
        { key: 'check_in_radius', value: {meters:1000}, description: '打卡距離' },
        { key: 'departments', value: ['管理部','生產部','業務部','倉管部'], description: '部門列表' }
    ];
    for (var d of defaults) {
        await sb.from('system_settings').insert({ ...d, company_id: companyId }).catch(function() {});
    }
}

// ===== GPS 功能 =====
function preloadGPS() {
    const el = document.getElementById('locationStatus');
    if (!el) return;
    
    el.className = 'location-status loading';
    el.innerHTML = '<div class="dot"></div><span>正在定位...</span>';

    navigator.geolocation.getCurrentPosition(
        p => { 
            cachedLocation = { latitude: p.coords.latitude, longitude: p.coords.longitude, accuracy: p.coords.accuracy };
            
            let foundLocation = null;
            let minDistance = Infinity;
            
            for (const loc of officeLocations) {
                const dist = calculateDistance(
                    cachedLocation.latitude, cachedLocation.longitude, 
                    loc.lat, loc.lng
                );
                if (dist <= loc.radius && dist < minDistance) {
                    minDistance = dist;
                    foundLocation = loc.name;
                }
            }

            el.className = 'location-status ready';
            if (foundLocation) {
                el.innerHTML = `<div class="dot" style="background:#10b981;"></div><span>📍 您在：${foundLocation}</span>`;
            } else {
                el.innerHTML = `<div class="dot" style="background:#f59e0b;"></div><span>⚠️ 未在打卡範圍內</span>`;
            }
        },
        e => { 
            el.className = 'location-status';
            el.innerHTML = '<span>❌ 定位失敗，請檢查權限</span>'; 
        },
        { timeout: 10000, enableHighAccuracy: true }
    );
}

function getGPS() { 
    return new Promise((res, rej) => {
        navigator.geolocation.getCurrentPosition(
            p => res({ latitude: p.coords.latitude, longitude: p.coords.longitude, accuracy: p.coords.accuracy }), 
            e => rej(e), 
            { enableHighAccuracy: true, timeout: 10000, maximumAge: 0 }
        );
    });
}

// ===== 考勤功能 =====
async function checkTodayAttendance() {
    if (!currentEmployee || !currentEmployee.id) return;
    try {
        const today = getTaiwanDate(0);
        const { data, error } = await sb.from('attendance')
            .select('*')
            .eq('employee_id', currentEmployee.id)
            .eq('date', today)
            .maybeSingle();
        
        if (error) {
            console.error('❌ 檢查考勤錯誤:', error);
            todayAttendance = null;
        } else {
            todayAttendance = data;
        }
        updateCheckInButtons();
    } catch(e) { 
        console.error(e); 
    }
}

function updateCheckInButtons() {
    const btnIn = document.getElementById('checkInBtn');
    const btnOut = document.getElementById('checkOutBtn');
    const statusBox = document.getElementById('checkInStatusBox');
    const lastLoc = localStorage.getItem('last_location') || '公司';

    if (!btnIn || !btnOut || !statusBox) return;

    if (!todayAttendance) {
        btnIn.classList.remove('disabled');
        btnOut.classList.add('disabled');
        showStatus(statusBox, 'info', `📍 上次打卡地點：${lastLoc}`);
    } else if (todayAttendance.check_out_time) {
        btnIn.classList.add('disabled');
        btnOut.classList.add('disabled');
        showStatus(statusBox, 'success', `✅ 今日完工 (工時 ${todayAttendance.total_work_hours?.toFixed(1) || '0'}h)`);
    } else {
        btnIn.classList.add('disabled');
        btnOut.classList.remove('disabled');
        const time = new Date(todayAttendance.check_in_time).toLocaleTimeString('zh-TW', {timeZone:'Asia/Taipei', hour:'2-digit', minute:'2-digit'});
        const locName = todayAttendance.check_in_location?.includes('(') ? todayAttendance.check_in_location.split('(')[0] : lastLoc;
        showStatus(statusBox, 'info', `🏢 上班中 @ ${locName} (${time})`);
    }
}

// ===== 綁定功能 =====
function switchBindMode(mode) {
    currentBindMode = mode;
    const modeIdCard = document.getElementById('modeIdCard');
    const modeCode = document.getElementById('modeCode');
    const tabIdCard = document.getElementById('tabIdCard');
    const tabCode = document.getElementById('tabCode');
    
    if (modeIdCard) modeIdCard.classList.toggle('hidden', mode !== 'id_card');
    if (modeCode) modeCode.classList.toggle('hidden', mode !== 'code');
    if (tabIdCard) tabIdCard.className = mode === 'id_card' ? 'tab-btn active' : 'tab-btn inactive';
    if (tabCode) tabCode.className = mode === 'code' ? 'tab-btn active' : 'tab-btn inactive';
}

async function handleBind() {
    const empId = document.getElementById('bindEmpId')?.value.trim();
    const idLast4 = document.getElementById('bindIdLast4')?.value.trim();
    const code = document.getElementById('bindCode')?.value.trim();
    const statusBox = document.getElementById('bindStatus');

    if (!empId) return showStatus(statusBox, 'error', '請輸入員編');

    const params = {
        p_line_user_id: liffProfile.userId,
        p_employee_number: empId, 
        p_device_info: navigator.userAgent,
        p_id_card_last_4: document.getElementById('modeIdCard')?.classList.contains('hidden') ? null : idLast4,
        p_verification_code: document.getElementById('modeCode')?.classList.contains('hidden') ? null : code
    };

    showStatus(statusBox, 'info', '驗證中...');
    try {
        const { data, error } = await sb.rpc('bind_employee', params);
        console.log('[handleBind] rpc result:', { data, error });
        if (error) throw error;

        // RPC 回傳格式可能是 {success:true}, true, 或 null（無 error 即成功）
        if (data && data.error) {
            showStatus(statusBox, 'error', data.error);
        } else if (data === false || (data && data.success === false)) {
            showStatus(statusBox, 'error', (data && data.message) || '綁定失敗，請檢查資料');
        } else {
            showStatus(statusBox, 'success', '✅ 綁定成功！');
            setTimeout(() => { window.location.href = 'index.html'; }, 1500);
        }
    } catch (err) {
        console.error('綁定錯誤:', err);
        showStatus(statusBox, 'error', friendlyError(err));
    }
}

// ===== 便當功能 =====
async function loadLunchSummary() {
    const dateStr = getTaiwanDate(0);
    const lunchDateEl = document.getElementById('lunchDate');
    if (lunchDateEl && !lunchDateEl.value) lunchDateEl.value = dateStr;

    try {
        const { data, error } = await sb.from('lunch_orders')
            .select('id, is_vegetarian, status')
            .eq('order_date', dateStr);

        if (error) throw error;

        const orders = (data || []).filter(o => o.status === 'ordered');
        const vegCount = orders.filter(o => o.is_vegetarian).length;
        const regularCount = orders.filter(o => !o.is_vegetarian).length;

        const el = (id) => document.getElementById(id);
        if (el('totalOrders')) el('totalOrders').textContent = orders.length;
        if (el('vegCount')) el('vegCount').textContent = vegCount;
        if (el('regularCount')) el('regularCount').textContent = regularCount;
    } catch(e) {
        console.error('便當統計失敗', e);
    }
}

// ===== 請假功能 =====
// ===== 請假可用性檢查 =====
async function checkLeaveAvailability(startDate, endDate) {
    if (!currentEmployee || !sb) return { ok: true };
    
    try {
        // 1. 從快取讀取最大同時請假人數設定
        let maxConcurrent = 2; // 預設
        const concurrentSetting = getCachedSetting('max_concurrent_leave');
        if (concurrentSetting?.max) maxConcurrent = concurrentSetting.max;

        // 2. 查詢日期範圍內所有已核准/待審假單（排除自己）
        const { data: leaves } = await sb.from('leave_requests')
            .select('employee_id, start_date, end_date, status, employees(name)')
            .neq('employee_id', currentEmployee.id)
            .in('status', ['approved', 'pending'])
            .or(`and(start_date.lte.${endDate},end_date.gte.${startDate})`);

        // 3. 查詢每一天的衝突人數
        const start = new Date(startDate), end = new Date(endDate);
        const conflicts = []; // { date, count, names }
        let maxDayConflict = 0;

        for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
            const ds = fmtDate(d);
            const dow = d.getDay();
            if (dow === 0 || dow === 6) continue; // 週末跳過

            const dayLeaves = (leaves || []).filter(l => ds >= l.start_date && ds <= (l.end_date || l.start_date));
            const count = dayLeaves.length;
            const names = dayLeaves.map(l => l.employees?.name || '同事').filter((v, i, a) => a.indexOf(v) === i);
            
            if (count > 0) {
                conflicts.push({ date: ds, count, names });
            }
            if (count > maxDayConflict) maxDayConflict = count;
        }

        // 4. 查排班資料，看該日是否人手不足（用 count 避免拉全部員工資料）
        let staffWarning = '';
        try {
            const { count: totalCount } = await sb.from('employees').select('id', { count: 'exact', head: true }).eq('company_id', window.currentCompanyId).eq('is_active', true);

            if (totalCount > 0 && maxDayConflict + 1 >= totalCount) {
                staffWarning = `⚠️ 若核准此假，最少只剩 ${totalCount - maxDayConflict - 1} 人上班`;
            }
        } catch(e) { console.warn('查詢員工人數失敗', e); }

        // 5. 判斷是否超過上限
        const wouldExceed = (maxDayConflict + 1) > maxConcurrent;

        return {
            ok: !wouldExceed,
            maxConcurrent,
            conflicts,
            maxDayConflict,
            staffWarning,
            message: wouldExceed 
                ? `❌ 無法請假：${conflicts.find(c => c.count >= maxConcurrent)?.date || ''} 已有 ${maxDayConflict} 人請假（上限 ${maxConcurrent} 人）`
                : conflicts.length > 0 
                    ? `⚠️ 提醒：期間已有 ${maxDayConflict} 人請假（上限 ${maxConcurrent} 人）`
                    : '✅ 該期間無人請假，可正常申請'
        };
    } catch(e) {
        console.error('檢查請假可用性失敗', e);
        return { ok: true, message: '' };
    }
}

async function submitLeave() {
    if (!currentEmployee) return showToast('❌ 請先登入');
    const type = document.getElementById('leaveType')?.value;
    const start = document.getElementById('leaveStartDate')?.value;
    const end = document.getElementById('leaveEndDate')?.value;
    const reason = document.getElementById('leaveReason')?.value;
    if (!start || !end || !reason) return showToast('請填寫完整');

    if (new Date(end) < new Date(start)) {
        return showToast('❌ 結束日期不能早於開始日期');
    }

    const submitBtn = document.getElementById('leaveSubmitBtn');
    setBtnLoading(submitBtn, true);

    const statusEl = document.getElementById('leaveStatus');
    if (statusEl) { statusEl.className = 'status-box show info'; statusEl.textContent = '⏳ 檢查人力狀態中...'; }

    // 先檢查是否超過同時請假上限
    const check = await checkLeaveAvailability(start, end);
    
    if (!check.ok) {
        // 自動駁回
        if (statusEl) {
            statusEl.className = 'status-box show error';
            statusEl.innerHTML = `${escapeHTML(check.message)}<br><span style="font-size:12px;color:#94A3B8;margin-top:4px;display:block;">已有同事請假：${check.conflicts.map(c => `${escapeHTML(c.date)}(${c.names.map(n => escapeHTML(n)).join(',')})`).slice(0,3).join('、')}</span>`;
        }
        showToast('❌ 該日期請假人數已達上限');
        setBtnLoading(submitBtn, false, '📤 提交申請');
        return;
    }

    try {
        const { error } = await sb.from('leave_requests').insert({
            employee_id: currentEmployee.id, leave_type: type,
            start_date: start, end_date: end, reason: reason, status: 'pending'
        });
        if (error) throw error;
        showToast('✅ 申請成功');
        loadLeaveHistory();
        if (statusEl) {
            statusEl.className = 'status-box show success';
            statusEl.innerHTML = '✅ 申請已提交' + (check.conflicts.length > 0 ? `<br><span style="font-size:12px;color:#F59E0B;">💡 提醒：期間已有 ${check.maxDayConflict} 人請假</span>` : '');
        }
        if (document.getElementById('leaveReason')) document.getElementById('leaveReason').value = '';
        // 清除衝突提示
        const warn = document.getElementById('leaveConflictWarn');
        if (warn) warn.style.display = 'none';

        // 通知管理員
        const typeNames = { annual:'特休', sick:'病假', personal:'事假', compensatory:'補休' };
        sendAdminNotify(`🔔 ${currentEmployee.name} 申請${typeNames[type]||type}\n📅 ${start} ~ ${end}\n📝 ${reason || '無附原因'}`);
    } catch(e) {
        showToast('❌ 申請失敗：' + friendlyError(e));
    } finally {
        setBtnLoading(submitBtn, false, '📤 提交申請');
    }
}

async function loadLeaveHistory() {
    const list = document.getElementById('leaveHistoryList');
    if (!currentEmployee || !list) return;
    try {
        // 先嘗試 RPC，如果失敗直接查表（包含 rejected）
        let records = [];
        try {
            const { data } = await sb.rpc('get_leave_history', { p_line_user_id: liffProfile.userId, p_limit: 10 });
            if (data) records = data;
        } catch(e) { console.warn('get_leave_history RPC 失敗，改用直接查表', e); }

        // 如果 RPC 沒有資料，直接查表（含 rejected）
        if (records.length === 0) {
            const { data } = await sb.from('leave_requests')
                .select('*')
                .eq('employee_id', currentEmployee.id)
                .order('created_at', { ascending: false })
                .limit(10);
            if (data) records = data;
        }
        
        if (!records || records.length === 0) { 
            list.innerHTML = '<p class="text-center-muted">尚無記錄</p>';
            return;
        }

        const typeMap = { 'annual': '特休', 'sick': '病假', 'personal': '事假', 'compensatory': '補休' };
        const statusMap = { 'pending': '⏳ 待審', 'approved': '✅ 通過', 'rejected': '❌ 拒絕' };
        const statusColor = { 'pending': '#F59E0B', 'approved': '#059669', 'rejected': '#DC2626' };

        list.innerHTML = records.map(r => `
            <div class="attendance-item" style="border-left-color:${statusColor[r.status] || '#ccc'};">
                <div class="date">
                    <span>${escapeHTML(typeMap[r.leave_type] || r.leave_type)}</span>
                    <span class="badge ${r.status === 'approved' ? 'badge-success' : r.status === 'rejected' ? 'badge-danger' : 'badge-warning'}">
                        ${statusMap[r.status] || escapeHTML(r.status)}
                    </span>
                </div>
                <div class="details">
                    <span>${escapeHTML(r.start_date)} ~ ${escapeHTML(r.end_date)}</span>
                    <span>${r.days || 1} 天</span>
                </div>
                <div class="text-sm-muted">${escapeHTML(r.reason)}</div>
                ${r.status === 'rejected' && r.rejection_reason ?
                    `<div class="rejection-box">
                        ❌ 拒絕原因：${escapeHTML(r.rejection_reason)}
                    </div>` : ''}
            </div>
        `).join('');
    } catch(e) {
        console.error(e);
        list.innerHTML = '<p class="text-center-error">載入失敗</p>';
    }
}

// ===== 補打卡申請 =====
async function submitMakeupPunch() {
    if (!currentEmployee) return showToast('❌ 請先登入');
    const date = document.getElementById('mpDate')?.value;
    const type = document.getElementById('mpType')?.value; // clock_in / clock_out
    const time = document.getElementById('mpTime')?.value;
    const reasonType = document.getElementById('mpReasonType')?.value;
    const reasonText = document.getElementById('mpReasonText')?.value;
    
    if (!date || !time || !reasonType) return showToast('❌ 請填寫完整');
    
    // ⭐ 每月補打卡限制 3 次
    const monthStart = date.substring(0, 7) + '-01';
    const monthEnd = date.substring(0, 7) + '-31';
    const { data: monthCount } = await sb.from('makeup_punch_requests')
        .select('id', { count: 'exact' })
        .eq('employee_id', currentEmployee.id)
        .gte('punch_date', monthStart).lte('punch_date', monthEnd)
        .in('status', ['pending', 'approved']);
    if (monthCount && monthCount.length >= 3) {
        return showToast('❌ 本月補打卡已達上限（3 次/月）');
    }
    
    const reason = `[${{'forgot':'忘記打卡','field':'外出公務','phone_dead':'手機沒電','system_error':'系統故障','other':'其他'}[reasonType] || reasonType}] ${reasonText || ''}`.trim();

    const statusEl = document.getElementById('mpStatus');
    const mpBtn = document.querySelector('#makeupPunchPage .btn-primary') || document.querySelector('[onclick="submitMakeupPunch()"]');
    setBtnLoading(mpBtn, true);

    try {
        const { error } = await sb.from('makeup_punch_requests').insert({
            employee_id: currentEmployee.id,
            punch_date: date,
            punch_type: type,
            punch_time: time,
            reason: reason,
            status: 'pending'
        });
        if (error) throw error;

        showToast('✅ 補打卡申請已提交');
        if (statusEl) { statusEl.className = 'status-box show success'; statusEl.textContent = '✅ 申請已提交，等待審核'; }
        loadMakeupHistory();

        // 通知管理員
        sendAdminNotify(`🔔 ${currentEmployee.name} 申請補打卡\n📅 ${date} ${type === 'clock_in' ? '上班' : '下班'} ${time}\n📝 ${reason}`);

        // 清空表單
        if (document.getElementById('mpReasonText')) document.getElementById('mpReasonText').value = '';
    } catch(e) {
        console.error(e);
        showToast('❌ 申請失敗：' + friendlyError(e));
    } finally {
        setBtnLoading(mpBtn, false, '📤 提交補打卡申請');
    }
}

async function loadMakeupHistory() {
    const list = document.getElementById('makeupHistoryList');
    if (!currentEmployee || !list) return;
    
    try {
        const { data } = await sb.from('makeup_punch_requests')
            .select('*')
            .eq('employee_id', currentEmployee.id)
            .order('created_at', { ascending: false })
            .limit(10);
        
        if (!data || data.length === 0) {
            list.innerHTML = '<p class="text-center-muted-sm">尚無補打卡記錄</p>';
            return;
        }

        const statusMap = { 'pending': '⏳ 待審', 'approved': '✅ 通過', 'rejected': '❌ 拒絕' };
        const statusColor = { 'pending': '#F59E0B', 'approved': '#059669', 'rejected': '#DC2626' };
        const typeMap = { 'clock_in': '上班', 'clock_out': '下班' };

        list.innerHTML = data.map(r => `
            <div class="attendance-item" style="border-left-color:${statusColor[r.status] || '#ccc'};">
                <div class="date">
                    <span>${escapeHTML(r.punch_date)} ${escapeHTML(typeMap[r.punch_type])} ${escapeHTML(r.punch_time)}</span>
                    <span class="badge ${r.status === 'approved' ? 'badge-success' : r.status === 'rejected' ? 'badge-danger' : 'badge-warning'}">
                        ${statusMap[r.status] || escapeHTML(r.status)}
                    </span>
                </div>
                <div class="text-sm-muted">${escapeHTML(r.reason)}</div>
                ${r.status === 'approved' ? '<div class="text-xs-success">✅ 已寫入出勤記錄</div>' : ''}
                ${r.status === 'rejected' && r.rejection_reason ?
                    `<div class="rejection-box">❌ ${escapeHTML(r.rejection_reason)}</div>` : ''}
            </div>
        `).join('');
    } catch(e) {
        console.error(e);
        list.innerHTML = '<p class="text-center-error">載入失敗</p>';
    }
}

// ===== LINE Messaging API 推播 =====
async function sendLineMessage(to, text) {
    const setting = getCachedSetting('line_messaging_api');
    console.log('[LINE Push] token:', setting?.token ? '有' : '無', 'to:', to ? (to.substring(0, 8) + '...') : '無');
    if (!setting?.token || !to) { console.warn('[LINE Push] 未設定，跳過'); return; }
    try {
        const res = await fetch('https://nssuisyvlrqnqfxupklb.supabase.co/functions/v1/line-push', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': 'Bearer ' + CONFIG.SUPABASE_ANON_KEY
            },
            body: JSON.stringify({ token: setting.token, to, text })
        });
        const result = await res.json().catch(() => ({}));
        console.log('[LINE Push] 回傳:', result);
    } catch(e) {
        console.error('[LINE Push] 錯誤:', e);
    }
}

async function sendAdminNotify(message) {
    try {
        const setting = getCachedSetting('line_messaging_api');
        if (!setting?.token || !setting?.groupId) return;
        await sendLineMessage(setting.groupId, message);
    } catch(e) {
        console.log('LINE 推播失敗（非必要）', e);
    }
}

async function sendUserNotify(employeeId, message) {
    try {
        const setting = getCachedSetting('line_messaging_api');
        if (!setting?.token) return;
        const { data: emp } = await sb.from('employees')
            .select('line_user_id').eq('id', employeeId).maybeSingle();
        if (!emp?.line_user_id) return;
        await sendLineMessage(emp.line_user_id, message);
    } catch(e) { console.log('推播失敗', e); }
}

// ===== 公告系統（使用 announcements 資料表） =====
async function loadAnnouncements() {
    try {
        var now = new Date().toISOString();
        var query = sb.from('announcements')
            .select('*')
            .eq('is_active', true)
            .lte('publish_at', now)
            .order('created_at', { ascending: false })
            .limit(20);
        if (currentCompanyId) query = query.eq('company_id', currentCompanyId);

        var { data: announcements } = await query;
        announcements = (announcements || []).filter(function(a) {
            return !a.expire_at || new Date(a.expire_at) > new Date();
        });

        // 公告小卡（員工卡右側）
        var card = document.getElementById('announcementCard');
        if (card && announcements.length > 0) {
            card.style.display = '';

            // 未讀數
            var empId = currentEmployee?.id;
            var ackedIds = [];
            if (empId) {
                var { data: acks } = await sb.from('announcement_acknowledgments')
                    .select('announcement_id').eq('employee_id', empId);
                ackedIds = (acks || []).map(function(a) { return a.announcement_id; });
            }
            var unread = announcements.filter(function(a) { return ackedIds.indexOf(a.id) === -1; });

            var badge = document.getElementById('announceBadge');
            if (badge) {
                if (unread.length > 0) { badge.textContent = unread.length; badge.style.display = ''; }
                else { badge.style.display = 'none'; }
            }

            var preview = document.getElementById('announcePreview');
            if (preview) {
                var icons = { urgent:'🔴', important:'🟡', info:'📋' };
                preview.innerHTML = announcements.slice(0, 2).map(function(a) {
                    return '<div style="margin-bottom:4px;font-size:11px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">' +
                        (icons[a.type] || '📋') + ' ' + escapeHTML(a.title) + '</div>';
                }).join('');
            }

            window._announcements = announcements;
            window._unreadAnnouncements = unread;
        }
    } catch(e) {
        console.error('載入公告失敗:', e);
    }
}

// 公告列表彈窗
window.showAnnouncementList = function() {
    var announcements = window._announcements || [];
    var unreadIds = (window._unreadAnnouncements || []).map(function(u) { return u.id; });
    var icons = { urgent:'🔴', important:'🟡', info:'📋' };

    var html = announcements.map(function(a) {
        var isUnread = unreadIds.indexOf(a.id) !== -1;
        var date = new Date(a.created_at);
        var dateStr = (date.getMonth() + 1) + '/' + date.getDate();
        return '<div style="padding:14px;background:#fff;border-radius:12px;margin-bottom:8px;cursor:pointer;' +
            (isUnread ? 'border-left:4px solid #6366F1;' : 'border-left:4px solid #E2E8F0;opacity:.7;') +
            '" onclick="event.stopPropagation();viewAnnouncement(\'' + a.id + '\')">' +
            '<div style="display:flex;justify-content:space-between;align-items:center;">' +
            '<div style="font-size:14px;font-weight:700;">' + (icons[a.type] || '📋') + ' ' + escapeHTML(a.title) + '</div>' +
            '<span style="font-size:11px;color:#94A3B8;">' + dateStr + '</span></div>' +
            (a.content ? '<div style="font-size:12px;color:#64748B;margin-top:4px;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;">' + escapeHTML(a.content) + '</div>' : '') +
            (isUnread ? '<div style="font-size:10px;color:#6366F1;font-weight:600;margin-top:4px;">● 未讀</div>' : '') +
            '</div>';
    }).join('');

    var overlay = document.createElement('div');
    overlay.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,.5);z-index:9999;display:flex;align-items:flex-end;justify-content:center;';
    overlay.onclick = function() { document.body.removeChild(overlay); };
    overlay.innerHTML = '<div style="background:#F8FAFC;border-radius:20px 20px 0 0;padding:20px;max-height:70vh;overflow-y:auto;width:100%;max-width:480px;" onclick="event.stopPropagation()">' +
        '<div style="text-align:center;margin-bottom:16px;"><div style="width:40px;height:4px;background:#CBD5E1;border-radius:2px;margin:0 auto 12px;"></div>' +
        '<div style="font-size:18px;font-weight:800;">📢 公告</div></div>' +
        (html || '<div style="text-align:center;padding:30px;color:#94A3B8;">目前沒有公告</div>') +
        '</div>';
    document.body.appendChild(overlay);
};

// 查看單則公告 + 標記已讀
window.viewAnnouncement = async function(id) {
    var a = (window._announcements || []).find(function(x) { return x.id === id; });
    if (!a) return;

    var empId = currentEmployee?.id;
    if (empId) {
        try {
            await sb.from('announcement_acknowledgments').upsert({
                announcement_id: a.id,
                employee_id: empId
            }, { onConflict: 'announcement_id,employee_id', ignoreDuplicates: true });
        } catch(e) {}
    }

    var typeLabels = { urgent:'🔴 緊急公告', important:'🟡 重要公告', info:'📋 一般公告' };
    var typeColors = { urgent:'#DC2626', important:'#EA580C', info:'#2563EB' };
    var date = new Date(a.created_at);
    var dateStr = date.getFullYear() + '/' + (date.getMonth() + 1) + '/' + date.getDate();

    var overlay = document.createElement('div');
    overlay.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,.5);z-index:10000;display:flex;align-items:center;justify-content:center;padding:20px;';
    overlay.onclick = function() { document.body.removeChild(overlay); loadAnnouncements(); };
    overlay.innerHTML = '<div style="background:#fff;border-radius:20px;padding:24px;max-width:440px;width:100%;max-height:80vh;overflow-y:auto;" onclick="event.stopPropagation()">' +
        '<div style="font-size:12px;color:' + (typeColors[a.type] || '#2563EB') + ';font-weight:600;margin-bottom:4px;">' + (typeLabels[a.type] || '') + '</div>' +
        '<div style="font-size:20px;font-weight:800;margin-bottom:8px;">' + escapeHTML(a.title) + '</div>' +
        '<div style="font-size:12px;color:#94A3B8;margin-bottom:16px;">' + dateStr + '</div>' +
        '<div style="font-size:14px;line-height:1.7;color:#475569;white-space:pre-wrap;">' + escapeHTML(a.content || '') + '</div>' +
        '<button onclick="this.closest(\'div\').parentElement.remove();loadAnnouncements();" style="width:100%;padding:14px;background:#6366F1;color:#fff;border:none;border-radius:12px;font-size:15px;font-weight:700;cursor:pointer;margin-top:20px;font-family:inherit;">已讀</button>' +
        '</div>';
    document.body.appendChild(overlay);
};

// ===== 月度出勤查詢 =====
async function loadMonthlyAttendance() {
    const list = document.getElementById('attendanceList');
    const yearEl = document.getElementById('attendanceYear');
    const monthEl = document.getElementById('attendanceMonth');
    
    if (!list || !yearEl || !monthEl || !currentEmployee) return;
    
    const year = parseInt(yearEl.value);
    const month = parseInt(monthEl.value);
    
    list.innerHTML = '<p class="text-center-gray">查詢中...</p>';
    
    try {
        const { data, error } = await sb.rpc('get_monthly_attendance', {
            p_line_user_id: liffProfile.userId,
            p_year: year,
            p_month: month
        });
        
        if (error) throw error;
        if (!data || data.length === 0) {
            list.innerHTML = `<p class="text-center-muted">${year}年${month}月 無記錄</p>`;
            return;
        }
        
        const totalDays = data.length;
        const lateDays = data.filter(r => r.is_late).length;
        const totalHours = data.reduce((sum, r) => sum + (parseFloat(r.total_work_hours) || 0), 0);

        // 查詢當月請假天數
        let leaveDays = 0;
        try {
            const monthStart = `${year}-${String(month).padStart(2,'0')}-01`;
            const monthEnd = fmtDate(new Date(year, month, 0));
            const { data: leaveData } = await sb.from('leave_requests')
                .select('days, leave_type')
                .eq('employee_id', currentEmployee.id)
                .eq('status', 'approved')
                .gte('start_date', monthStart)
                .lte('start_date', monthEnd);
            if (leaveData) leaveDays = leaveData.reduce((s, r) => s + (parseFloat(r.days) || 0), 0);
        } catch(e) { console.warn('查詢當月請假天數失敗', e); }
        
        let html = `
            <div class="lunch-summary" style="margin-bottom:15px;">
                <div class="stat-row"><span>📅 出勤</span><span><b>${totalDays}</b> 天</span></div>
                <div class="stat-row"><span>⏰ 遲到</span><span style="color:${lateDays > 0 ? '#ef4444' : '#1f2937'}"><b>${lateDays}</b> 次</span></div>
                <div class="stat-row"><span>📝 請假</span><span><b>${leaveDays}</b> 天</span></div>
                <div class="stat-row"><span>⏱️ 總工時</span><span><b>${totalHours.toFixed(1)}</b> h</span></div>
            </div>
        `;
        
        html += data.map(r => {
            const badge = r.is_late 
                ? '<span class="badge badge-warning">遲到</span>' 
                : '<span class="badge badge-success">正常</span>';
            const hours = r.total_work_hours ? `${parseFloat(r.total_work_hours).toFixed(1)}h` : '-';
            
            // 安全解析時間
            let checkInTime = '-';
            let checkOutTime = '-';
            let lateMinutes = '';
            try {
                if (r.check_in_time) {
                    const parts = r.check_in_time.split(' ');
                    checkInTime = parts.length > 1 ? parts[1].substring(0,5) : r.check_in_time.substring(0,5);
                }
                if (r.check_out_time) {
                    const parts = r.check_out_time.split(' ');
                    checkOutTime = parts.length > 1 ? parts[1].substring(0,5) : r.check_out_time.substring(0,5);
                }
                // 計算遲到時間（假設上班時間 08:00）
                if (r.is_late && r.check_in_time) {
                    const inTime = new Date(r.check_in_time);
                    const scheduled = new Date(inTime);
                    scheduled.setHours(8, 0, 0, 0); // 預設 08:00
                    const diffMin = Math.round((inTime - scheduled) / 60000);
                    if (diffMin > 0) {
                        lateMinutes = `<span style="font-size:11px;color:#ef4444;margin-left:4px;">遲到 ${diffMin} 分鐘</span>`;
                    }
                }
            } catch(e) { console.warn('計算遲到分鐘數失敗', e); }
            
            return `
                <div class="attendance-item ${r.is_late ? 'late' : 'normal'}">
                    <div class="date">
                        <span>${r.date}</span>
                        <span>${badge} <span style="font-size:12px;color:#6b7280;">${hours}</span></span>
                    </div>
                    <div class="details">
                        <span>上班: ${checkInTime}${lateMinutes}</span>
                        <span>下班: ${checkOutTime}</span>
                    </div>
                    ${r.photo_url ? `<div style="margin-top:5px;"><a href="${escapeHTML(r.photo_url)}" target="_blank" rel="noopener" class="photo-link">📷 查看照片</a></div>` : ''}
                </div>
            `;
        }).join('');
        list.innerHTML = html;
    } catch (err) { 
        console.error(err); 
        list.innerHTML = `<p class="text-center-error">查詢失敗：${friendlyError(err)}</p>`;
    }
}

// ===== 年終統計 =====
// [BUG FIX] 移除 event listener 洩漏問題，用 onchange 替代 addEventListener
async function loadAnnualSummary() {
    const yearEl = document.getElementById('salaryYear');
    const statusCard = document.getElementById('yearEndStatusCard');
    const statsGrid = document.getElementById('statsGrid');
    
    if (!yearEl || !statusCard || !statsGrid || !currentEmployee) return;

    const year = parseInt(yearEl.value);
    
    statusCard.style.display = 'block';
    statusCard.className = 'status-card';
    document.getElementById('statusResult').textContent = '計算中...';
    document.getElementById('statusReason').textContent = '正在分析您的年度考勤資料...';
    statsGrid.style.display = 'none';
    
    try {
        const { data, error } = await sb.rpc('get_my_year_end_stats', { 
            p_line_user_id: liffProfile.userId, 
            p_year: year 
        });
        
        if (error) throw error;
        if (data.error) throw new Error(data.error);
        
        statusCard.className = 'status-card';
        document.getElementById('statusResult').textContent = '📊 年度考勤統計';
        document.getElementById('statusReason').textContent = '';
        
        const el = (id) => document.getElementById(id);
        const bonusHireDateEl = el('bonusHireDate');
        const bonusMonthsEl = el('bonusMonths');
        
        if (bonusHireDateEl) {
            bonusHireDateEl.value = data.hire_date || '2026-01-01';
            // [BUG FIX] 使用 onchange 避免重複綁定 event listener
            bonusHireDateEl.onchange = () => {
                calculateAndUpdateMonthsWorked(bonusHireDateEl.value, bonusMonthsEl);
            };
        }
        
        if (bonusMonthsEl) bonusMonthsEl.textContent = `${data.months_worked} 個月`;
        if (el('bonusDays')) el('bonusDays').textContent = `${data.total_attendance_days} 天`;
        if (el('attendanceRate')) {
            el('attendanceRate').textContent = `${data.attendance_rate}%`;
            el('attendanceRate').style.color = data.attendance_rate < 85 ? '#ef4444' : '#1f2937';
        }
        if (el('bonusLate')) {
            el('bonusLate').textContent = `${data.late_count} 次`;
            el('bonusLate').style.color = data.late_count > 5 ? '#ef4444' : '#1f2937';
        }
        if (el('lateRate')) {
            el('lateRate').textContent = `${data.late_rate}%`;
            el('lateRate').style.color = data.late_rate > 5 ? '#ef4444' : '#1f2937';
        }
        if (el('bonusHours')) el('bonusHours').textContent = `${data.total_work_hours} 小時`;
        if (el('bonusAvgHours')) el('bonusAvgHours').textContent = `${data.avg_daily_hours} 小時`;
        
        statsGrid.style.display = 'grid';
        
    } catch (err) { 
        console.error(err); 
        statusCard.className = 'status-card error';
        document.getElementById('statusResult').textContent = '❌ 載入失敗';
        document.getElementById('statusReason').textContent = friendlyError(err);
    }
}

// ===== 地點管理功能 =====
function renderLocationList() {
    // [BUG FIX] 同時支援 settings 和 admin 頁面的地點列表容器
    const listEl = document.getElementById('locationList') || document.getElementById('adminLocationList');
    if (!listEl) return;

    if (officeLocations.length === 0) {
        listEl.innerHTML = '<p class="text-center-muted">尚未設定地點</p>';
        return;
    }
    listEl.innerHTML = officeLocations.map((loc, index) => `
        <div style="background:#F8FAFC;border:1px solid #E2E8F0;border-radius:12px;padding:14px;margin-bottom:10px;">
            <div style="font-weight:700;font-size:15px;color:#1E293B;margin-bottom:6px;">📍 ${escapeHTML(loc.name)}</div>
            ${loc.address ? '<div style="font-size:13px;color:#64748B;margin-bottom:4px;">地址：' + escapeHTML(loc.address) + '</div>' : ''}
            <div style="font-size:12px;color:#94A3B8;margin-bottom:4px;">座標：${loc.lat}, ${loc.lng}</div>
            <div style="font-size:12px;color:#94A3B8;margin-bottom:8px;">打卡半徑：${loc.radius}m</div>
            <div style="display:flex;gap:8px;">
                <button onclick="editLocation(${index})" style="font-size:12px;padding:6px 14px;border:1px solid #6366F1;border-radius:8px;background:#EEF2FF;color:#6366F1;cursor:pointer;">✏️ 編輯</button>
                <button onclick="deleteLocation(${index})" style="font-size:12px;padding:6px 14px;border:1px solid #EF4444;border-radius:8px;background:#FEF2F2;color:#EF4444;cursor:pointer;">🗑️ 刪除</button>
            </div>
        </div>
    `).join('');
}

function getCurrentGPSForSetting() {
    showToast('📍 定位中...');
    navigator.geolocation.getCurrentPosition(
        (pos) => {
            // [BUG FIX] 同時支援 settings 和 admin 頁面的座標輸入框
            const latEl = document.getElementById('newLocLat') || document.getElementById('adminNewLocLat');
            const lngEl = document.getElementById('newLocLng') || document.getElementById('adminNewLocLng');
            if (latEl) latEl.value = pos.coords.latitude;
            if (lngEl) lngEl.value = pos.coords.longitude;
            showToast('✅ 已填入座標');
        },
        (err) => showToast('❌ 定位失敗: ' + err.message),
        { enableHighAccuracy: true, timeout: 10000, maximumAge: 0 }
    );
}

async function addNewLocation() {
    // [BUG FIX] 同時支援 settings 和 admin 頁面的元素 ID
    const nameEl = document.getElementById('newLocName') || document.getElementById('adminNewLocName');
    const addressEl = document.getElementById('newLocAddress') || document.getElementById('adminNewLocAddress');
    const radiusEl = document.getElementById('newLocRadius') || document.getElementById('adminNewLocRadius');
    const latEl = document.getElementById('newLocLat') || document.getElementById('adminNewLocLat');
    const lngEl = document.getElementById('newLocLng') || document.getElementById('adminNewLocLng');

    const name = nameEl?.value.trim();
    const address = addressEl?.value.trim() || '';
    const radius = parseInt(radiusEl?.value);
    const lat = parseFloat(latEl?.value);
    const lng = parseFloat(lngEl?.value);

    if (!name || !lat || !lng) return showToast('⚠️ 資料不完整');
    if (!radius || radius < 50) return showToast('⚠️ 打卡半徑至少 50 公尺');

    var loc = { name, lat, lng, radius };
    if (address) loc.address = address;
    const newLocations = [...officeLocations, loc];
    await saveLocationsToDB(newLocations);

    if (nameEl) nameEl.value = '';
    if (addressEl) addressEl.value = '';
    if (latEl) latEl.value = '';
    if (lngEl) lngEl.value = '';
}

function editLocation(index) {
    var loc = officeLocations[index];
    if (!loc) return;

    var newName = prompt('地點名稱：', loc.name);
    if (newName === null) return;
    newName = newName.trim();
    if (!newName) return showToast('⚠️ 名稱不可為空');

    var newAddress = prompt('地址（可留空）：', loc.address || '');
    if (newAddress === null) return;

    var newLat = prompt('緯度：', loc.lat);
    if (newLat === null) return;
    newLat = parseFloat(newLat);
    if (isNaN(newLat)) return showToast('⚠️ 緯度格式錯誤');

    var newLng = prompt('經度：', loc.lng);
    if (newLng === null) return;
    newLng = parseFloat(newLng);
    if (isNaN(newLng)) return showToast('⚠️ 經度格式錯誤');

    var newRadius = prompt('打卡半徑 (公尺)：', loc.radius);
    if (newRadius === null) return;
    newRadius = parseInt(newRadius);
    if (!newRadius || newRadius < 50) return showToast('⚠️ 打卡半徑至少 50 公尺');

    var updated = officeLocations.map(function(l, i) {
        if (i !== index) return l;
        var copy = { name: newName, lat: newLat, lng: newLng, radius: newRadius };
        if (newAddress.trim()) copy.address = newAddress.trim();
        return copy;
    });
    saveLocationsToDB(updated);
}

async function deleteLocation(index) {
    if (!confirm('確定要刪除此地點嗎？')) return;
    const newLocations = officeLocations.filter((_, i) => i !== index);
    await saveLocationsToDB(newLocations);
}

async function saveLocationsToDB(newLocations) {
    try {
        await saveSetting('office_locations', newLocations, '打卡地點');
        officeLocations = newLocations;
        showToast('✅ 設定已更新');
        renderLocationList();
        preloadGPS();
    } catch (err) {
        console.error(err);
        showToast('❌ 儲存失敗：' + friendlyError(err));
    }
}

// ===== 前端計算年資 =====
function calculateAndUpdateMonthsWorked(hireDate, targetElement) {
    if (!hireDate || !targetElement) return;
    
    const hire = new Date(hireDate);
    const today = new Date();
    
    if (hire > today) {
        targetElement.textContent = '0 個月';
        return;
    }
    
    let months = (today.getFullYear() - hire.getFullYear()) * 12 + (today.getMonth() - hire.getMonth());
    if (today.getDate() < hire.getDate()) months--;
    months = Math.max(0, months);
    
    targetElement.textContent = `${months} 個月`;
}

// ===== 權限分級 =====
var ROLE_PERMISSIONS = {
    platform_admin: {
        admin_pages: ['employees', 'leave', 'attendance', 'schedule', 'payroll', 'settings', 'announcements', 'requests', 'restaurant', 'booking', 'members', 'location', 'report', 'staff', 'lunch', 'client', 'fieldwork'],
        payroll_locked: true
    },
    admin: {
        admin_pages: ['employees', 'leave', 'attendance', 'schedule', 'settings', 'announcements', 'requests', 'restaurant', 'booking', 'members', 'location', 'report', 'staff', 'lunch', 'client', 'fieldwork'],
        payroll_locked: false
    },
    manager: {
        admin_pages: ['leave', 'attendance', 'schedule', 'announcements'],
        payroll_locked: false
    },
    user: {
        admin_pages: [],
        payroll_locked: false
    }
};

function getCurrentRole() {
    if (isPlatformAdmin && !window.viewAsEmployee) return 'platform_admin';
    return (currentEmployee && currentEmployee.role) || 'user';
}

function getRolePermissions() {
    return ROLE_PERMISSIONS[getCurrentRole()] || ROLE_PERMISSIONS.user;
}

// 套用 admin 頁面權限（隱藏無權限的格子）
function applyAdminPermissions() {
    var perms = getRolePermissions();
    var allowed = perms.admin_pages || [];
    document.querySelectorAll('[data-permission]').forEach(function(el) {
        var perm = el.getAttribute('data-permission');
        el.style.display = allowed.includes(perm) ? '' : 'none';
    });
}

// ===== 薪酬密碼鎖 =====
function checkPayrollAccess(callback) {
    var perms = getRolePermissions();
    if (!perms.admin_pages.includes('payroll')) {
        showToast('⛔ 您沒有權限查看薪酬資料');
        return;
    }
    if (perms.payroll_locked) {
        showPayrollPasswordDialog(callback);
    } else {
        callback();
    }
}

function showPayrollPasswordDialog(callback) {
    if (window._payrollUnlocked) { callback(); return; }

    var overlay = document.createElement('div');
    overlay.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,.6);z-index:10000;display:flex;align-items:center;justify-content:center;padding:20px;';
    overlay.innerHTML = '<div style="background:#fff;border-radius:20px;padding:28px;max-width:360px;width:100%;text-align:center;">' +
        '<div style="font-size:40px;margin-bottom:12px;">🔒</div>' +
        '<div style="font-size:18px;font-weight:800;margin-bottom:4px;">薪酬管理</div>' +
        '<div style="font-size:13px;color:#64748B;margin-bottom:20px;">請輸入管理密碼</div>' +
        '<input type="password" id="payrollPwInput" placeholder="輸入密碼" style="width:100%;padding:14px;border:2px solid #E2E8F0;border-radius:12px;font-size:16px;text-align:center;font-family:inherit;margin-bottom:16px;box-sizing:border-box;" onkeypress="if(event.key===\'Enter\')verifyPayrollPw()">' +
        '<div style="display:flex;gap:10px;">' +
        '<button onclick="this.closest(\'div\').parentElement.parentElement.remove()" style="flex:1;padding:12px;background:#F1F5F9;border:none;border-radius:10px;font-size:14px;font-weight:600;cursor:pointer;font-family:inherit;">取消</button>' +
        '<button onclick="verifyPayrollPw()" style="flex:1;padding:12px;background:#6366F1;color:#fff;border:none;border-radius:10px;font-size:14px;font-weight:700;cursor:pointer;font-family:inherit;">確認</button>' +
        '</div>' +
        '<div id="payrollPwError" style="color:#EF4444;font-size:12px;margin-top:10px;display:none;">密碼錯誤</div>' +
        '</div>';
    document.body.appendChild(overlay);

    window._payrollCallback = callback;
    window._payrollOverlay = overlay;

    setTimeout(function() { document.getElementById('payrollPwInput')?.focus(); }, 100);
}

window.verifyPayrollPw = function() {
    var input = document.getElementById('payrollPwInput')?.value;
    var setting = getCachedSetting('payroll_password');
    var correctPw = (setting && setting.password) ? setting.password : '0000';

    if (input === correctPw) {
        window._payrollUnlocked = true;
        if (window._payrollOverlay) window._payrollOverlay.remove();
        if (window._payrollCallback) window._payrollCallback();
    } else {
        var err = document.getElementById('payrollPwError');
        if (err) err.style.display = '';
        var inp = document.getElementById('payrollPwInput');
        if (inp) { inp.value = ''; inp.focus(); }
    }
};

window.savePayrollPassword = async function() {
    var pw = document.getElementById('payrollNewPw')?.value.trim();
    if (!pw) { showToast('⚠️ 請輸入密碼'); return; }
    await saveSetting('payroll_password', { password: pw }, '薪酬管理密碼');
    showToast('✅ 密碼已更新');
    document.getElementById('payrollNewPw').value = '';
    window._payrollUnlocked = false;
};

// ===== 視角切換（platform_admin 專用） =====
window.viewAsEmployee = false;

window.toggleViewMode = function() {
    window.viewAsEmployee = !window.viewAsEmployee;
    var btn = document.getElementById('viewToggleBtn');
    if (btn) {
        if (window.viewAsEmployee) {
            btn.innerHTML = '👑 關閉員工視角';
            btn.style.background = '#6366F1';
            btn.style.color = '#fff';
        } else {
            btn.innerHTML = '👁 開啟員工視角';
            btn.style.background = '#fff';
            btn.style.color = '#6366F1';
        }
    }

    // 員工視角隱藏 toggle 開關和管理後台入口
    document.querySelectorAll('.feature-toggle').forEach(function(t) {
        t.style.display = window.viewAsEmployee ? 'none' : '';
    });
    var adminEntry = document.getElementById('adminEntry');
    if (adminEntry) adminEntry.style.display = window.viewAsEmployee ? 'none' : 'block';

    // 切換視角時直接用已有快取重新套用，不清除快取（避免 companyId 為空時設定丟失）
    applyFeatureVisibility();
};

// ===== 管理員功能 =====
// [優化] 直接從已載入的 currentEmployee 判斷，不再額外查詢 DB
function checkIsAdmin() {
    if (!currentEmployee) return false;
    if (window.viewAsEmployee) return false;
    return currentEmployee.role === 'admin' || isPlatformAdmin;
}

// [優化] 直接從已載入的 currentEmployee 取得，不再額外查詢 DB
function getAdminInfo() {
    if (!currentEmployee || currentEmployee.role !== 'admin') return null;
    return currentEmployee;
}

async function updateEmployeeRole(employeeId, newRole) {
    try {
        const { error } = await sb.from('employees')
            .update({ role: newRole })
            .eq('id', employeeId);
        
        if (error) throw error;
        return { success: true };
    } catch (err) {
        console.error('更新員工角色失敗:', err);
        return { success: false, error: err.message };
    }
}

async function adjustEmployeeBonus(employeeId, year, bonusAmount, reason) {
    try {
        const { error } = await sb.from('annual_bonus')
            .upsert({
                employee_id: employeeId,
                year: year,
                final_bonus: bonusAmount,
                manager_adjustment: bonusAmount,
                ai_recommendation: reason,
                is_approved: true,
                updated_at: new Date().toISOString()
            });
        
        if (error) throw error;
        return { success: true };
    } catch (err) {
        console.error('調整獎金失敗:', err);
        return { success: false, error: err.message };
    }
}

function initBottomNav() { /* 已停用 */ }


// ===== 申請管理（管理後台） =====
var reqMgrFilter = 'all';

function switchReqMgrFilter(filter, btn) {
    reqMgrFilter = filter;
    document.querySelectorAll('.reqMgrTab').forEach(function(b) {
        b.style.background = 'transparent'; b.style.color = '#94A3B8'; b.style.boxShadow = 'none';
    });
    if (btn) { btn.style.background = '#fff'; btn.style.color = '#4F46E5'; btn.style.boxShadow = '0 1px 4px rgba(0,0,0,.08)'; }
    loadAllRequests();
}

async function loadAllRequests() {
    var el = document.getElementById('reqMgrList');
    if (!el) return;
    el.innerHTML = '<p style="text-align:center;color:#666;">載入中...</p>';

    try {
        var query = sb.from('requests')
            .select('*, employees!requests_employee_id_fkey(name, department)')
            .order('created_at', { ascending: false })
            .limit(50);

        if (currentCompanyId) query = query.eq('company_id', currentCompanyId);
        if (reqMgrFilter !== 'all') {
            if (reqMgrFilter === 'completed') {
                query = query.in('status', ['completed', 'rejected']);
            } else {
                query = query.eq('status', reqMgrFilter);
            }
        }

        var { data, error } = await query;
        if (error) throw error;

        if (!data || data.length === 0) {
            el.innerHTML = '<p style="text-align:center;color:#94A3B8;padding:30px;">沒有申請紀錄</p>';
            return;
        }

        el.innerHTML = data.map(function(r) {
            return renderAdminRequestCard(r);
        }).join('');
    } catch(e) {
        console.error(e);
        el.innerHTML = '<p style="text-align:center;color:#EF4444;">載入失敗</p>';
    }
}

function renderAdminRequestCard(r) {
    var typeLabel = r.type === 'repair' ? '🔧 報修' : '🛒 採購';
    var typeBg = r.type === 'repair' ? '#DBEAFE' : '#F3E8FF';
    var typeColor = r.type === 'repair' ? '#1E40AF' : '#6B21A8';

    var statusMap = {
        pending:     { label: '待審核', bg: '#FEF3C7', color: '#92400E' },
        approved:    { label: '已核准', bg: '#DBEAFE', color: '#1E40AF' },
        in_progress: { label: '進行中', bg: '#D1FAE5', color: '#065F46' },
        completed:   { label: '已完成', bg: '#EDE9FE', color: '#5B21B6' },
        rejected:    { label: '已退回', bg: '#FEE2E2', color: '#991B1B' }
    };
    var st = statusMap[r.status] || statusMap.pending;

    var urgencyMap = {
        urgent: { label: '🔴 急迫', bg: '#FEE2E2', color: '#991B1B' },
        high:   { label: '⚡ 緊急', bg: '#FEF3C7', color: '#92400E' }
    };
    var urg = urgencyMap[r.urgency];

    var empName = r.employees?.name || '未知';
    var empDept = r.employees?.department ? ' (' + r.employees.department + ')' : '';

    var date = new Date(r.created_at);
    var dateStr = (date.getMonth() + 1) + '/' + date.getDate() + ' ' +
        String(date.getHours()).padStart(2, '0') + ':' + String(date.getMinutes()).padStart(2, '0');

    var costStr = r.estimated_cost ? ' | $' + Number(r.estimated_cost).toLocaleString() : '';

    var html = '<div style="background:#fff;border-radius:14px;padding:14px 14px 14px 18px;margin-bottom:10px;box-shadow:0 2px 8px rgba(0,0,0,.04);border-left:4px solid ' +
        (r.status === 'pending' ? '#F59E0B' : r.status === 'approved' ? '#3B82F6' : r.status === 'in_progress' ? '#10B981' : r.status === 'completed' ? '#8B5CF6' : '#EF4444') + ';">';
    html += '<div style="display:flex;align-items:center;gap:6px;margin-bottom:6px;flex-wrap:wrap;">';
    html += '<span style="display:inline-block;padding:2px 8px;border-radius:12px;font-size:11px;font-weight:700;background:' + typeBg + ';color:' + typeColor + ';">' + typeLabel + '</span>';
    html += '<span style="display:inline-block;padding:2px 8px;border-radius:12px;font-size:11px;font-weight:700;background:' + st.bg + ';color:' + st.color + ';">' + st.label + '</span>';
    if (urg) html += '<span style="display:inline-block;padding:2px 8px;border-radius:12px;font-size:11px;font-weight:700;background:' + urg.bg + ';color:' + urg.color + ';">' + urg.label + '</span>';
    html += '</div>';
    html += '<div style="font-size:14px;font-weight:700;color:#1F2937;margin-bottom:2px;">' + escapeHTML(r.title) + '</div>';
    html += '<div style="font-size:12px;color:#64748B;margin-bottom:6px;">' + escapeHTML(empName) + empDept + ' · ' + dateStr + costStr + '</div>';
    if (r.description) html += '<div style="font-size:12px;color:#94A3B8;margin-bottom:8px;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;">' + escapeHTML(r.description) + '</div>';

    // 操作按鈕
    if (r.status === 'pending') {
        html += '<div style="display:flex;gap:6px;">';
        html += '<button onclick="approveRequest(\'' + r.id + '\')" style="flex:1;padding:8px;border:none;border-radius:8px;background:#D1FAE5;color:#065F46;font-weight:700;font-size:12px;cursor:pointer;">✓ 核准</button>';
        html += '<button onclick="rejectRequest(\'' + r.id + '\')" style="flex:1;padding:8px;border:none;border-radius:8px;background:#FEE2E2;color:#991B1B;font-weight:700;font-size:12px;cursor:pointer;">✕ 退回</button>';
        html += '</div>';
    } else if (r.status === 'approved') {
        html += '<button onclick="updateRequestStatus(\'' + r.id + '\',\'in_progress\')" style="width:100%;padding:8px;border:none;border-radius:8px;background:#DBEAFE;color:#1E40AF;font-weight:700;font-size:12px;cursor:pointer;">🔄 標記進行中</button>';
    } else if (r.status === 'in_progress') {
        html += '<button onclick="updateRequestStatus(\'' + r.id + '\',\'completed\')" style="width:100%;padding:8px;border:none;border-radius:8px;background:#EDE9FE;color:#5B21B6;font-weight:700;font-size:12px;cursor:pointer;">✔ 標記完成</button>';
    }
    if (r.status === 'rejected' && r.rejection_reason) {
        html += '<div style="margin-top:6px;padding:6px 10px;background:#FEE2E2;border-radius:8px;font-size:12px;color:#991B1B;">退回原因：' + escapeHTML(r.rejection_reason) + '</div>';
    }

    html += '</div>';
    return html;
}

async function approveRequest(id) {
    try {
        await sb.from('requests').update({
            status: 'approved',
            approver_id: currentEmployee.id,
            approved_at: new Date().toISOString(),
            updated_at: new Date().toISOString()
        }).eq('id', id);
        showToast('✅ 已核准');
        loadAllRequests();
    } catch(e) { showToast('❌ 操作失敗'); }
}

async function rejectRequest(id) {
    var reason = prompt('請輸入退回原因：');
    if (reason === null) return;
    try {
        await sb.from('requests').update({
            status: 'rejected',
            approver_id: currentEmployee.id,
            rejection_reason: reason || '',
            updated_at: new Date().toISOString()
        }).eq('id', id);
        showToast('已退回');
        loadAllRequests();
    } catch(e) { showToast('❌ 操作失敗'); }
}

async function updateRequestStatus(id, status) {
    try {
        var update = { status: status, updated_at: new Date().toISOString() };
        await sb.from('requests').update(update).eq('id', id);
        showToast('✅ 已更新');
        loadAllRequests();
    } catch(e) { showToast('❌ 操作失敗'); }
}

// ===== 功能顯示設定 =====
// 優先從 companies.features 讀取（多租戶），fallback 到 system_settings
const DEFAULT_FEATURES = {
    leave: true,         // 我要請假（預設開啟）
    attendance: true,    // 考勤查詢（預設開啟）
    salary: true,        // 薪資查詢（預設開啟）
    lunch: false,        // 便當訂購（需 Platform Admin 開啟）
    fieldwork: false,    // 外勤/業務（需 Platform Admin 開啟）
    sales_target: false, // 業務目標（需 Platform Admin 開啟）
    store_ordering: false,// 線上點餐（需 Platform Admin 開啟，餐飲業）
    booking: false,      // 預約系統（需 Platform Admin 開啟，餐飲業）
    loyalty: false,      // 集點會員（需 Platform Admin 開啟，付費）
    requests: true,      // 申請管理（預設開啟）
    booking_service: false // 預約系統-服務業（需 Platform Admin 開啟）
};

function getFeatureVisibility() {
    // 三層 AND 邏輯：產業預設 × 平台允許 × 管理員開啟 → 才顯示
    let result = { ...DEFAULT_FEATURES };

    // 第 0 層：產業別預設（使用 INDUSTRY_TEMPLATES）
    const industry = currentCompanyIndustry || 'general';
    const template = window.INDUSTRY_TEMPLATES?.[industry];
    if (template && template.features) {
        Object.keys(template.features).forEach(k => {
            result[k] = template.features[k];
        });
    }

    // 第一層：平台管理員設定（companies.features）
    if (currentCompanyFeatures) {
        for (const key of Object.keys(result)) {
            if (currentCompanyFeatures[key] === true) result[key] = true;
            if (currentCompanyFeatures[key] === false) result[key] = false;
        }
    }

    // 第二層：公司管理員設定（system_settings.feature_visibility）
    // 只能進一步關閉平台允許的功能，不能開啟平台禁止的功能
    const adminSettings = getCachedSetting('feature_visibility');
    if (adminSettings) {
        // 只套用已知的 feature key，忽略舊格式的 schedule/requests 等
        for (const key of Object.keys(result)) {
            if (result[key] === true && adminSettings[key] === false) {
                result[key] = false;
            }
        }
    }

    return result;
}

// 根據設定隱藏首頁「中間選單」項目
function applyFeatureVisibility() {
    const features = getFeatureVisibility();
    console.log('[applyFeatureVisibility] features:', JSON.stringify(features));

    document.querySelectorAll('.menu-grid .menu-item[data-feature]').forEach(item => {
        const keys = item.getAttribute('data-feature').split(',').map(k => k.trim());
        const visible = keys.some(k => features[k] === true);

        if (checkIsAdmin() && !window.viewAsEmployee) {
            // 業主視角：顯示所有「第一層允許」的格子，讓業主知道可控制哪些
            // 第一層（companies.features）決定格子是否存在
            const firstLayerVisible = keys.some(k => {
                let v = DEFAULT_FEATURES[k] !== undefined ? DEFAULT_FEATURES[k] : false;
                if (currentCompanyFeatures && currentCompanyFeatures[k] !== undefined) v = currentCompanyFeatures[k];
                return v === true;
            });
            item.style.display = firstLayerVisible ? '' : 'none';
            item.style.opacity = '1';
        } else {
            // 員工視角：兩層都 true 才顯示
            item.style.display = visible ? '' : 'none';
            item.style.opacity = '1';
            // 職位限制：外勤/業務只有「業務」職位才看得到
            if (visible && (keys.includes('fieldwork') || keys.includes('sales_target'))) {
                if (currentEmployee && currentEmployee.position !== '業務') {
                    item.style.display = 'none';
                }
            }
        }
    });
}

// ===== 首頁功能 toggle 開關（業主專用，控制第二層 feature_visibility）=====
function renderFeatureToggles() {
    if (!checkIsAdmin() || window.viewAsEmployee) {
        // 非業主或員工視角：移除所有已存在的 toggle
        document.querySelectorAll('.feature-toggle').forEach(function(t) { t.remove(); });
        return;
    }

    var fvSetting = getCachedSetting('feature_visibility') || {};

    document.querySelectorAll('.menu-grid .menu-item[data-feature]').forEach(function(el) {
        // 已有 toggle 就跳過
        if (el.querySelector('.feature-toggle')) return;

        var featureKeys = el.getAttribute('data-feature');
        var firstKey = featureKeys.split(',')[0].trim();
        // feature_visibility 預設全 true
        var isOn = fvSetting[firstKey] !== undefined ? fvSetting[firstKey] : true;

        var toggle = document.createElement('div');
        toggle.className = 'feature-toggle';
        toggle.style.cssText = 'position:absolute;top:6px;right:6px;z-index:5;';
        toggle.innerHTML = '<label style="display:flex;align-items:center;cursor:pointer;">' +
            '<input type="checkbox" data-feature-key="' + featureKeys + '" ' + (isOn ? 'checked' : '') +
            ' onchange="toggleFeatureSwitch(this)" style="display:none;">' +
            '<div style="width:36px;height:20px;background:' + (isOn ? '#22C55E' : '#CBD5E1') +
            ';border-radius:10px;position:relative;transition:background .2s;">' +
            '<div style="width:16px;height:16px;background:#fff;border-radius:50%;position:absolute;top:2px;' +
            (isOn ? 'right:2px;' : 'left:2px;') + 'transition:all .2s;box-shadow:0 1px 3px rgba(0,0,0,.2);"></div>' +
            '</div></label>';

        toggle.querySelector('label').onclick = function(e) { e.stopPropagation(); };
        el.appendChild(toggle);
    });
}

window.toggleFeatureSwitch = async function(checkbox) {
    var keys = checkbox.getAttribute('data-feature-key').split(',');
    var isOn = checkbox.checked;

    var companyId = window.currentCompanyId || currentEmployee?.company_id;
    if (!companyId) {
        console.warn('toggleFeatureSwitch: no companyId');
        checkbox.checked = !isOn;
        return;
    }

    // 讀取現有 feature_visibility，更新指定 key
    var fv = Object.assign({}, getCachedSetting('feature_visibility') || {
        leave:true, attendance:true, salary:true, lunch:true,
        fieldwork:true, sales_target:true, store_ordering:true, booking:true, loyalty:true
    });
    keys.forEach(function(k) { fv[k.trim()] = isOn; });

    try {
        // 寫入 system_settings.feature_visibility（第二層）
        await saveSetting('feature_visibility', fv, '功能開關（第二層，業主微調）');

        // saveSetting 已呼叫 invalidateSettingsCache + loadSettings(true)
        // 額外確保記憶體快取同步（避免 getCachedSetting 讀到舊值）
        if (_settingsCache) _settingsCache['feature_visibility'] = fv;

        // 更新 toggle 外觀
        var track = checkbox.nextElementSibling;
        track.style.background = isOn ? '#22C55E' : '#CBD5E1';
        var knob = track.firstElementChild;
        if (isOn) { knob.style.left = ''; knob.style.right = '2px'; }
        else { knob.style.right = ''; knob.style.left = '2px'; }

        // 立即重新套用顯示邏輯
        applyFeatureVisibility();
    } catch(e) {
        console.error('儲存失敗:', e);
        checkbox.checked = !isOn;
        showToast('❌ 儲存失敗');
    }
};

// ===== 加班申請 =====
async function submitOvertime() {
    if (!currentEmployee) return showToast('❌ 請先登入');
    const date = document.getElementById('otDate')?.value;
    const hours = parseFloat(document.getElementById('otHours')?.value);
    const reason = document.getElementById('otReason')?.value;
    const compType = document.getElementById('otCompType')?.value || 'pay';
    const statusEl = document.getElementById('otStatus');

    if (!date || !hours || hours <= 0) return showToast('❌ 請填寫日期與時數');
    if (hours > 12) return showToast('❌ 加班時數不可超過 12 小時');

    const otBtn = document.querySelector('[onclick="submitOvertime()"]');
    setBtnLoading(otBtn, true);

    try {
        const { error } = await sb.from('overtime_requests').insert({
            employee_id: currentEmployee.id,
            ot_date: date,
            planned_hours: hours,
            reason: reason || '',
            compensation_type: compType,
            status: 'pending'
        });
        if (error) throw error;

        showToast('✅ 加班申請已提交');
        if (statusEl) { statusEl.className = 'status-box show success'; statusEl.textContent = '✅ 申請已提交，等待審核'; }
        loadOvertimeHistory();

        const compLabel = compType === 'pay' ? '加班費' : '補休';
        sendAdminNotify(`🔔 ${currentEmployee.name} 申請加班\n📅 ${date} ${hours}小時\n💰 ${compLabel}\n📝 ${reason || '無附原因'}`);
    } catch(e) {
        showToast('❌ 申請失敗：' + friendlyError(e));
    } finally {
        setBtnLoading(otBtn, false, '📤 提交加班申請');
    }
}

async function loadOvertimeHistory() {
    const list = document.getElementById('overtimeHistoryList');
    if (!currentEmployee || !list) return;
    
    try {
        const { data } = await sb.from('overtime_requests')
            .select('*')
            .eq('employee_id', currentEmployee.id)
            .order('created_at', { ascending: false })
            .limit(10);
        
        if (!data || data.length === 0) {
            list.innerHTML = '<p class="text-center-muted-sm">尚無加班記錄</p>';
            return;
        }

        const statusMap = { pending: '⏳ 待審', approved: '✅ 通過', rejected: '❌ 拒絕' };
        const statusColor = { pending: '#F59E0B', approved: '#059669', rejected: '#DC2626' };

        list.innerHTML = data.map(r => {
            const comp = r.compensation_type === 'pay' ? '💰 加班費' : '🏖️ 換補休';
            const finalH = r.final_hours != null ? ` → 計薪 ${r.final_hours}h` : '';
            return `
            <div class="attendance-item" style="border-left-color:${statusColor[r.status] || '#ccc'};">
                <div class="date">
                    <span>📅 ${escapeHTML(r.ot_date)} · ${r.planned_hours}h · ${comp}</span>
                    <span class="badge ${r.status === 'approved' ? 'badge-success' : r.status === 'rejected' ? 'badge-danger' : 'badge-warning'}">
                        ${statusMap[r.status] || escapeHTML(r.status)}${finalH}
                    </span>
                </div>
                <div class="text-sm-muted">${escapeHTML(r.reason)}</div>
                ${r.status === 'approved' && r.approved_hours ? `<div class="text-xs-success">核准 ${r.approved_hours}h${r.actual_hours != null ? ` · 實際 ${r.actual_hours}h` : ''}${finalH}</div>` : ''}
                ${r.status === 'rejected' && r.rejection_reason ? `<div class="rejection-box">❌ ${escapeHTML(r.rejection_reason)}</div>` : ''}
            </div>`;
        }).join('');
    } catch(e) {
        list.innerHTML = '<p class="text-center-error">載入失敗</p>';
    }
}

// ===== 操作日誌 =====
async function writeAuditLog(action, targetTable, targetId, targetName, details = null) {
    try {
        await sb.from('hr_audit_logs').insert({
            actor_id: currentEmployee?.id || null,
            actor_name: currentEmployee?.name || 'System',
            action, target_table: targetTable,
            target_id: String(targetId || ''),
            target_name: targetName || '',
            details: details
        });
    } catch(e) { console.log('Audit log failed (non-critical)', e); }
}

// ===== 重要公告彈窗（登入時自動跳出） =====
async function checkForcedAnnouncements() {
    if (!currentEmployee) return;
    try {
        var now = new Date().toISOString();
        var query = sb.from('announcements')
            .select('*')
            .eq('is_active', true)
            .eq('is_popup', true)
            .eq('type', 'urgent')
            .lte('publish_at', now)
            .order('created_at', { ascending: false });
        if (currentCompanyId) query = query.eq('company_id', currentCompanyId);

        var { data: forced } = await query;
        forced = (forced || []).filter(function(a) {
            return !a.expire_at || new Date(a.expire_at) > new Date();
        });
        if (forced.length === 0) return;

        var ids = forced.map(function(a) { return a.id; });
        var { data: acks } = await sb.from('announcement_acknowledgments')
            .select('announcement_id')
            .eq('employee_id', currentEmployee.id)
            .in('announcement_id', ids);

        var ackedIds = (acks || []).map(function(a) { return a.announcement_id; });
        var unacked = forced.filter(function(a) { return ackedIds.indexOf(a.id) === -1; });
        if (unacked.length === 0) return;

        showPopupAnnouncement(unacked[0]);
    } catch(e) { console.log('Forced announcement check failed', e); }
}

function showPopupAnnouncement(a) {
    var existing = document.getElementById('forcedAnnModal');
    if (existing) existing.remove();

    var typeColor = { urgent:'#DC2626', important:'#EA580C', info:'#2563EB' }[a.type] || '#64748B';

    var modal = document.createElement('div');
    modal.id = 'forcedAnnModal';
    modal.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.7);z-index:10000;display:flex;align-items:center;justify-content:center;padding:20px;';
    modal.innerHTML = '<div style="background:#fff;border-radius:20px;max-width:380px;width:100%;padding:24px;animation:pageIn 0.3s ease-out;">' +
        '<div style="text-align:center;font-size:48px;margin-bottom:12px;">🚨</div>' +
        '<div style="text-align:center;font-size:12px;color:#EF4444;font-weight:700;margin-bottom:4px;">緊急公告</div>' +
        '<h3 style="text-align:center;font-size:18px;font-weight:800;color:' + typeColor + ';margin-bottom:12px;">' + escapeHTML(a.title) + '</h3>' +
        (a.content ? '<div style="font-size:14px;color:#374151;line-height:1.8;padding:14px;background:#F8FAFC;border-radius:12px;margin-bottom:16px;max-height:300px;overflow-y:auto;white-space:pre-wrap;">' + escapeHTML(a.content) + '</div>' : '') +
        '<button id="forcedAckBtn" onclick="acknowledgeForcedAnnouncement(\'' + a.id + '\')" style="width:100%;padding:14px;border:none;border-radius:12px;background:' + typeColor + ';color:#fff;font-size:15px;font-weight:800;cursor:pointer;font-family:inherit;">✅ 我已閱讀並確認</button>' +
        '<p style="font-size:10px;color:#94A3B8;text-align:center;margin-top:8px;">確認後才能繼續使用系統</p>' +
    '</div>';
    document.body.appendChild(modal);
}

async function acknowledgeForcedAnnouncement(announcementId) {
    var btn = document.getElementById('forcedAckBtn');
    if (btn) { btn.disabled = true; btn.textContent = '處理中...'; }
    try {
        await sb.from('announcement_acknowledgments').insert({
            announcement_id: announcementId,
            employee_id: currentEmployee.id
        });
        writeAuditLog('acknowledge', 'announcements', announcementId, currentEmployee.name, { announcement_id: announcementId });
        var modal = document.getElementById('forcedAnnModal');
        if (modal) modal.remove();
        showToast('✅ 已確認');
        setTimeout(function() { checkForcedAnnouncements(); }, 300);
    } catch(e) {
        showToast('❌ 確認失敗');
        if (btn) { btn.disabled = false; btn.textContent = '✅ 我已閱讀並確認'; }
    }
}

// ===== 勞健保級距查表 =====
async function getInsuranceBracket(monthlySalary) {
    try {
        const { data } = await sb.rpc('get_insurance_bracket', { p_salary: monthlySalary });
        if (data && data.length > 0) return data[0];
    } catch(e) { console.log('級距查詢失敗，使用預設計算', e); }
    
    // fallback: 直接計算
    return {
        insured_amount: monthlySalary,
        labor_self: Math.round(monthlySalary * 0.125 * 0.2),
        health_self: Math.round(monthlySalary * 0.0517 * 0.3),
        pension: Math.round(monthlySalary * 0.06)
    };
}

// ===== Debug 模式 =====
// [BUG FIX] 移除 window.addEventListener('load') — 各頁面自行處理初始化
// 之前這裡有一個重複的 load 事件監聯器會導致雙重初始化
if (location.search.includes('debug=true')) {
    const script = document.createElement('script');
    script.src = 'https://unpkg.com/vconsole@latest/dist/vconsole.min.js';
    script.onload = () => new window.VConsole();
    document.head.appendChild(script);
}
