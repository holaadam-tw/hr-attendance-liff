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
        const { data, error } = await sb.from('employees')
            .select('*')
            .eq('line_user_id', liffProfile.userId)
            .maybeSingle();
        
        await loadSettings();

        if (loadingEl) loadingEl.style.display = 'none';

        if (data) {
            currentEmployee = data;
            currentCompanyId = data.company_id || null;
            // 載入公司功能設定
            if (currentCompanyId) {
                try {
                    const { data: company } = await sb.from('companies')
                        .select('features, status')
                        .eq('id', currentCompanyId)
                        .maybeSingle();
                    currentCompanyFeatures = company?.features || null;
                } catch(e) { console.log('載入公司功能設定失敗', e); }
            }
            updateUserInfo(data);
            await checkTodayAttendance();
            return true;
        } else {
            return false;
        }
    } catch (err) {
        console.error('檢查用戶狀態失敗:', err);
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

async function loadSettings() {
    try {
        // 優先從 sessionStorage 讀取快取（跨頁共用，減少 API 呼叫）
        const cached = sessionStorage.getItem('system_settings_cache');
        if (cached) {
            try {
                _settingsCache = JSON.parse(cached);
                officeLocations = _settingsCache['office_locations'] || [];
                return;
            } catch(e) { sessionStorage.removeItem('system_settings_cache'); }
        }

        // 一次查出所有 system_settings，避免多次查詢
        const { data, error } = await sb.from('system_settings')
            .select('key, value');
        if (!error && data) {
            _settingsCache = {};
            data.forEach(row => { _settingsCache[row.key] = row.value; });
            officeLocations = _settingsCache['office_locations'] || [];
            // 寫入 sessionStorage（關閉瀏覽器自動清除）
            try { sessionStorage.setItem('system_settings_cache', JSON.stringify(_settingsCache)); } catch(e) {}
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
    if (!currentEmployee) return;
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
        if (error) throw error;
        
        if (data && data.success) {
            showStatus(statusBox, 'success', '✅ 綁定成功！');
            setTimeout(() => { window.location.href = 'index.html'; }, 1500);
        } else {
            const errorMsg = (data && data.error) ? data.error : '綁定失敗，請檢查資料';
            showStatus(statusBox, 'error', errorMsg);
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

async function submitLunchOrder() {
    if (!currentEmployee) return showToast('❌ 請先登入');
    const date = document.getElementById('lunchDate')?.value;
    const isVeg = document.getElementById('lunchVegetarian')?.checked;
    const notes = document.getElementById('lunchNotes')?.value;
    if (!date) return showToast('請選擇日期');
    
    try {
        const { data, error } = await sb.rpc('order_lunch', {
            p_line_user_id: liffProfile.userId,
            p_order_date: date, p_is_vegetarian: isVeg, p_special_requirements: notes
        });
        if (error) throw error;
        showToast('✅ 訂購成功'); 
        loadLunchSummary();
    } catch(e) { 
        showToast('❌ 訂購失敗：' + friendlyError(e)); 
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
            const { count: totalCount } = await sb.from('employees').select('id', { count: 'exact', head: true }).eq('is_active', true);

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

// ===== LINE Notify 推播 =====
async function sendAdminNotify(message) {
    try {
        const setting = getCachedSetting('line_notify_token');
        if (!setting?.token) return;
        
        // 透過 Supabase Edge Function 發送（避免 CORS）
        await sb.functions.invoke('send-line-notify', {
            body: { token: setting.token, message }
        });
    } catch(e) {
        console.log('LINE Notify 發送失敗（非必要）', e);
    }
}

async function sendUserNotify(employeeId, message) {
    try {
        const { data: emp } = await sb.from('employees')
            .select('line_user_id').eq('id', employeeId).maybeSingle();
        if (!emp?.line_user_id) return;
        
        await sb.functions.invoke('send-line-notify', {
            body: { userId: emp.line_user_id, message }
        });
    } catch(e) { console.log('推播失敗', e); }
}

// ===== 公告系統 =====
async function loadAnnouncements() {
    const el = document.getElementById('announcementBanner');
    if (!el) return;
    
    try {
        const todayStr = getTaiwanDate();
        const annData = getCachedSetting('announcements');

        if (!annData?.items || annData.items.length === 0) {
            el.style.display = 'none';
            return;
        }
        
        // 過濾有效公告（未過期）
        const active = annData.items.filter(a => !a.expire_date || a.expire_date >= todayStr);
        if (active.length === 0) { el.style.display = 'none'; return; }
        
        const pinned = active.filter(a => a.pinned);
        const normal = active.filter(a => !a.pinned);
        const sorted = [...pinned, ...normal];
        
        el.style.display = 'block';
        el.innerHTML = sorted.map(a => {
            const typeStyle = {
                'info': { bg: '#EFF6FF', color: '#2563EB', icon: '📢' },
                'warning': { bg: '#FFF7ED', color: '#EA580C', icon: '⚠️' },
                'urgent': { bg: '#FEF2F2', color: '#DC2626', icon: '🚨' },
                'event': { bg: '#F5F3FF', color: '#7C3AED', icon: '🎉' }
            }[a.type] || { bg: '#F1F5F9', color: '#64748B', icon: '📌' };

            return `<div class="ann-block" style="background:${typeStyle.bg};color:${typeStyle.color};">
                <div class="ann-title">${typeStyle.icon} ${escapeHTML(a.title)}</div>
                ${a.content ? `<div class="ann-content">${escapeHTML(a.content)}</div>` : ''}
                ${a.expire_date ? `<div class="ann-expire">有效至 ${escapeHTML(a.expire_date)}</div>` : ''}
            </div>`;
        }).join('');
    } catch(e) { el.style.display = 'none'; }
}

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
        <div class="stat-row" style="align-items:center;">
            <div style="text-align:left;">
                <div style="font-weight:bold;">${escapeHTML(loc.name)}</div>
                <div style="font-size:11px;color:#999;">範圍: ${escapeHTML(String(loc.radius))}m</div>
            </div>
            <button onclick="deleteLocation(${index})" class="btn-danger" style="font-size:12px;padding:6px 12px;">刪除</button>
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
    const radiusEl = document.getElementById('newLocRadius') || document.getElementById('adminNewLocRadius');
    const latEl = document.getElementById('newLocLat') || document.getElementById('adminNewLocLat');
    const lngEl = document.getElementById('newLocLng') || document.getElementById('adminNewLocLng');
    
    const name = nameEl?.value.trim();
    const radius = parseInt(radiusEl?.value);
    const lat = parseFloat(latEl?.value);
    const lng = parseFloat(lngEl?.value);

    if (!name || !lat || !lng) return showToast('⚠️ 資料不完整');
    if (!radius || radius < 50) return showToast('⚠️ 打卡半徑至少 50 公尺');

    const newLocations = [...officeLocations, { name, lat, lng, radius }];
    await saveLocationsToDB(newLocations);
    
    if (nameEl) nameEl.value = '';
    if (latEl) latEl.value = '';
    if (lngEl) lngEl.value = '';
}

async function deleteLocation(index) {
    if (!confirm('確定要刪除此地點嗎？')) return;
    const newLocations = officeLocations.filter((_, i) => i !== index);
    await saveLocationsToDB(newLocations);
}

async function saveLocationsToDB(newLocations) {
    try {
        const { data, error } = await sb.rpc('update_office_locations', {
            p_locations: newLocations,
            p_line_user_id: liffProfile.userId
        });

        if (error) throw error;
        if (!data.success) { showToast('❌ ' + data.error); return; }
        
        officeLocations = newLocations;
        invalidateSettingsCache();
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

// ===== 管理員功能 =====
// [優化] 直接從已載入的 currentEmployee 判斷，不再額外查詢 DB
function checkIsAdmin() {
    if (!currentEmployee) return false;
    return currentEmployee.role === 'admin';
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

// ===== 底部導航列（管理員限定，動態產生） =====
function initBottomNav() {
    const isAdmin = checkIsAdmin();

    // 移除頁面上既有的靜態 bottom-nav（避免重複）
    document.querySelectorAll('.bottom-nav').forEach(n => n.remove());

    if (!isAdmin) {
        document.querySelector('.container')?.style.setProperty('padding-bottom', '16px');
        return;
    }

    // 判斷當前頁面以標記 active
    const page = window.location.pathname.split('/').pop() || 'index.html';
    const items = [
        { href: 'index.html',          icon: '🏠', label: '首頁' },
        { href: 'schedule.html',       icon: '📅', label: '班表' },
        { href: 'checkin.html?type=in', icon: '📍', label: '打卡' },
        { href: 'salary.html',         icon: '💰', label: '薪資' },
        { href: 'admin.html',          icon: '⚙️', label: '管理' }
    ];

    const nav = document.createElement('nav');
    nav.className = 'bottom-nav';
    nav.style.display = 'flex';
    nav.innerHTML = items.map(it => {
        const isActive = page === it.href.split('?')[0];
        return `<a class="nav-item${isActive ? ' active' : ''}" onclick="window.location.href='${it.href}'">
            <span class="nav-icon">${it.icon}</span><span class="nav-label">${it.label}</span>
        </a>`;
    }).join('');

    document.body.appendChild(nav);
}

// ===== 功能顯示設定 =====
// 優先從 companies.features 讀取（多租戶），fallback 到 system_settings
const DEFAULT_FEATURES = {
    leave: true,        // 我要請假
    lunch: true,        // 便當訂購
    attendance: true,   // 考勤查詢
    fieldwork: true,    // 外勤打卡
    sales_target: true, // 業務目標
    store_ordering: false // 線上點餐
};

function getFeatureVisibility() {
    // 雙層 AND 邏輯：平台允許 AND 管理員開啟 → 才顯示
    let result = { ...DEFAULT_FEATURES };

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
        for (const key of Object.keys(result)) {
            if (result[key] === true && adminSettings[key] === false) {
                result[key] = false;
            }
        }
    }

    return result;
}

// 根據設定隱藏首頁「中間選單」項目（不影響底部導航列）
function applyFeatureVisibility() {
    const features = getFeatureVisibility();

    // 用 data-feature 屬性精確控制每個選單項目
    // 支援逗號分隔多 key（OR 邏輯：任一為 true 就顯示）
    document.querySelectorAll('.menu-grid .menu-item[data-feature]').forEach(item => {
        const keys = item.getAttribute('data-feature').split(',');
        const visible = keys.some(k => features[k.trim()] !== false);
        if (!visible) {
            item.style.display = 'none';
        }
    });
}

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

// ===== 強制公告簽署 =====
async function checkForcedAnnouncements() {
    if (!currentEmployee) return;
    try {
        const settingValue = getCachedSetting('announcements');
        if (!settingValue?.items) return;
        
        const todayStr = getTaiwanDate();
        const forced = settingValue.items.filter(a =>
            a.require_ack && (!a.expire_date || a.expire_date >= todayStr)
        );
        if (forced.length === 0) return;
        
        // 查已簽署記錄
        const ids = forced.map(a => a.id);
        const { data: acks } = await sb.from('announcement_acknowledgments')
            .select('announcement_id')
            .eq('employee_id', currentEmployee.id)
            .in('announcement_id', ids);
        
        const ackedIds = new Set((acks || []).map(a => a.announcement_id));
        const unacked = forced.filter(a => !ackedIds.has(a.id));
        
        if (unacked.length === 0) return;
        
        // 顯示強制閱讀 Modal
        showForcedAnnouncementModal(unacked[0]);
    } catch(e) { console.log('Forced announcement check failed', e); }
}

function showForcedAnnouncementModal(announcement) {
    const existing = document.getElementById('forcedAnnModal');
    if (existing) existing.remove();
    
    const typeIcon = { info:'📢', warning:'⚠️', urgent:'🚨', event:'🎉' }[announcement.type] || '📌';
    const typeColor = { info:'#2563EB', warning:'#EA580C', urgent:'#DC2626', event:'#7C3AED' }[announcement.type] || '#64748B';
    
    const modal = document.createElement('div');
    modal.id = 'forcedAnnModal';
    modal.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.7);z-index:10000;display:flex;align-items:center;justify-content:center;padding:20px;';
    modal.innerHTML = `
        <div style="background:#fff;border-radius:20px;max-width:380px;width:100%;padding:24px;animation:pageIn 0.3s ease-out;">
            <div style="text-align:center;font-size:36px;margin-bottom:12px;">${typeIcon}</div>
            <h3 style="text-align:center;font-size:18px;font-weight:800;color:${typeColor};margin-bottom:12px;">${escapeHTML(announcement.title)}</h3>
            ${announcement.content ? `<div style="font-size:14px;color:#374151;line-height:1.8;padding:14px;background:#F8FAFC;border-radius:12px;margin-bottom:16px;max-height:300px;overflow-y:auto;white-space:pre-wrap;">${escapeHTML(announcement.content)}</div>` : ''}
            <div style="font-size:11px;color:#94A3B8;text-align:center;margin-bottom:16px;">
                發布者：${escapeHTML(announcement.created_by || '-')} · ${announcement.created_at ? new Date(announcement.created_at).toLocaleDateString() : ''}
            </div>
            <button id="forcedAckBtn" onclick="acknowledgeForcedAnnouncement('${escapeHTML(announcement.id)}')"
                style="width:100%;padding:14px;border:none;border-radius:12px;background:${typeColor};color:#fff;font-size:15px;font-weight:800;cursor:pointer;">
                ✅ 我已閱讀並確認
            </button>
            <p style="font-size:10px;color:#94A3B8;text-align:center;margin-top:8px;">確認後才能繼續使用系統</p>
        </div>
    `;
    document.body.appendChild(modal);
}

async function acknowledgeForcedAnnouncement(announcementId) {
    const btn = document.getElementById('forcedAckBtn');
    if (btn) { btn.disabled = true; btn.textContent = '處理中...'; }
    
    try {
        await sb.from('announcement_acknowledgments').insert({
            announcement_id: announcementId,
            employee_id: currentEmployee.id
        });
        
        writeAuditLog('acknowledge', 'announcements', announcementId, currentEmployee.name, { announcement_id: announcementId });
        
        const modal = document.getElementById('forcedAnnModal');
        if (modal) modal.remove();
        showToast('✅ 已確認');
        
        // 檢查是否還有未簽署的
        setTimeout(() => checkForcedAnnouncements(), 300);
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
