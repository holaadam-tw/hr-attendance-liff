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

// 狀態顯示
function showStatus(el, type, msg) { 
    if (!el) return;
    el.className = `status-box show ${type}`; 
    el.innerHTML = msg; 
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

// ===== 系統設定 =====
async function loadSettings() {
    try {
        const { data, error } = await sb.from('system_settings')
            .select('value')
            .eq('key', 'office_locations')
            .maybeSingle();
        if (!error && data) {
            officeLocations = data.value || [];
        }
    } catch (e) { 
        console.error('載入地點失敗', e); 
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
            cachedLocation = { latitude: p.coords.latitude, longitude: p.coords.longitude };
            
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
            p => res({ latitude: p.coords.latitude, longitude: p.coords.longitude }), 
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
    const dateStr = getTaiwanDate(1);
    const lunchDateEl = document.getElementById('lunchDate');
    if (lunchDateEl) lunchDateEl.value = dateStr;
    
    try {
        const { data } = await sb.rpc('get_lunch_summary', { p_date: dateStr });
        if (data) {
            const el = (id) => document.getElementById(id);
            if (el('totalOrders')) el('totalOrders').textContent = data.total_orders || 0;
            if (el('vegCount')) el('vegCount').textContent = data.vegetarian_count || 0;
            if (el('regularCount')) el('regularCount').textContent = data.regular_count || 0;
            if (data.is_lunar_vegetarian_day) {
                if (el('lunarNotice')) el('lunarNotice').classList.add('show');
                if (el('lunchVegetarian')) el('lunchVegetarian').checked = true;
            }
        }
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
async function submitLeave() {
    if (!currentEmployee) return showToast('❌ 請先登入');
    const type = document.getElementById('leaveType')?.value;
    const start = document.getElementById('leaveStartDate')?.value;
    const end = document.getElementById('leaveEndDate')?.value;
    const reason = document.getElementById('leaveReason')?.value;
    if (!start || !end || !reason) return showToast('請填寫完整');
    
    // [BUG FIX] 驗證日期邏輯
    if (new Date(end) < new Date(start)) {
        return showToast('❌ 結束日期不能早於開始日期');
    }
    
    try {
        const { error } = await sb.from('leave_requests').insert({
            employee_id: currentEmployee.id, leave_type: type, 
            start_date: start, end_date: end, reason: reason, status: 'pending'
        });
        if (error) throw error;
        showToast('✅ 申請成功'); 
        loadLeaveHistory();
        const leaveStatusEl = document.getElementById('leaveStatus');
        if (leaveStatusEl) {
            leaveStatusEl.className = 'status-box show success';
            leaveStatusEl.textContent = '✅ 申請已提交';
        }
        // 清空表單
        if (document.getElementById('leaveReason')) document.getElementById('leaveReason').value = '';
    } catch(e) { 
        showToast('❌ 申請失敗：' + friendlyError(e)); 
    }
}

async function loadLeaveHistory() {
    const list = document.getElementById('leaveHistoryList');
    if (!currentEmployee || !list) return;
    try {
        const { data } = await sb.rpc('get_leave_history', { p_line_user_id: liffProfile.userId, p_limit: 5 });
        if (!data || data.length === 0) { 
            list.innerHTML = '<p style="text-align:center;color:#999;">尚無記錄</p>'; 
            return; 
        }
        
        const typeMap = { 'annual': '特休', 'sick': '病假', 'personal': '事假', 'compensatory': '補休' };
        const statusMap = { 'pending': '⏳ 待審', 'approved': '✅ 通過', 'rejected': '❌ 拒絕' };
        
        list.innerHTML = data.map(r => `
            <div class="attendance-item">
                <div class="date">
                    <span>${typeMap[r.leave_type] || r.leave_type}</span>
                    <span class="badge ${r.status === 'approved' ? 'badge-success' : r.status === 'rejected' ? 'badge-danger' : 'badge-warning'}">
                        ${statusMap[r.status] || r.status}
                    </span>
                </div>
                <div class="details">
                    <span>${r.start_date} ~ ${r.end_date}</span>
                </div>
                <div style="font-size:12px;color:#999;margin-top:4px;">${r.reason || ''}</div>
            </div>
        `).join('');
    } catch(e) { 
        console.error(e); 
        list.innerHTML = '<p style="text-align:center;color:#ef4444;">載入失敗</p>';
    }
}

// ===== 月度出勤查詢 =====
async function loadMonthlyAttendance() {
    const list = document.getElementById('attendanceList');
    const yearEl = document.getElementById('attendanceYear');
    const monthEl = document.getElementById('attendanceMonth');
    
    if (!list || !yearEl || !monthEl || !currentEmployee) return;
    
    const year = parseInt(yearEl.value);
    const month = parseInt(monthEl.value);
    
    list.innerHTML = '<p style="text-align:center;color:#666;">查詢中...</p>';
    
    try {
        const { data, error } = await sb.rpc('get_monthly_attendance', {
            p_line_user_id: liffProfile.userId,
            p_year: year,
            p_month: month
        });
        
        if (error) throw error;
        if (!data || data.length === 0) {
            list.innerHTML = `<p style="text-align:center;color:#999;">${year}年${month}月 無記錄</p>`;
            return;
        }
        
        const totalDays = data.length;
        const lateDays = data.filter(r => r.is_late).length;
        const totalHours = data.reduce((sum, r) => sum + (parseFloat(r.total_work_hours) || 0), 0);

        // 查詢當月請假天數
        let leaveDays = 0;
        try {
            const monthStart = `${year}-${String(month).padStart(2,'0')}-01`;
            const monthEnd = new Date(year, month, 0).toISOString().split('T')[0];
            const { data: leaveData } = await sb.from('leave_requests')
                .select('days, leave_type')
                .eq('employee_id', currentEmployee.id)
                .eq('status', 'approved')
                .gte('start_date', monthStart)
                .lte('start_date', monthEnd);
            if (leaveData) leaveDays = leaveData.reduce((s, r) => s + (parseFloat(r.days) || 0), 0);
        } catch(e) {}
        
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
            } catch(e) {}
            
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
                    ${r.photo_url ? `<div style="margin-top:5px;"><a href="${r.photo_url}" target="_blank" style="font-size:12px;color:#667eea;">📷 查看照片</a></div>` : ''}
                </div>
            `;
        }).join('');
        list.innerHTML = html;
    } catch (err) { 
        console.error(err); 
        list.innerHTML = `<p style="text-align:center;color:#ef4444;">查詢失敗：${friendlyError(err)}</p>`; 
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
        listEl.innerHTML = '<p style="color:#999;text-align:center;">尚未設定地點</p>';
        return;
    }
    listEl.innerHTML = officeLocations.map((loc, index) => `
        <div class="stat-row" style="align-items:center;">
            <div style="text-align:left;">
                <div style="font-weight:bold;">${loc.name}</div>
                <div style="font-size:11px;color:#999;">範圍: ${loc.radius}m</div>
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
async function checkIsAdmin() {
    if (!liffProfile) return false;
    
    try {
        const { data, error } = await sb.from('employees')
            .select('role')
            .eq('line_user_id', liffProfile.userId)
            .eq('is_active', true)
            .maybeSingle();
        
        if (error || !data) return false;
        return data.role === 'admin';
    } catch (err) {
        console.error('檢查管理員權限失敗:', err);
        return false;
    }
}

async function getAdminInfo() {
    if (!liffProfile) return null;
    
    try {
        const { data, error } = await sb.from('employees')
            .select('*')
            .eq('line_user_id', liffProfile.userId)
            .eq('role', 'admin')
            .eq('is_active', true)
            .maybeSingle();
        
        if (error || !data) return null;
        return data;
    } catch (err) {
        console.error('取得管理員資訊失敗:', err);
        return null;
    }
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

async function approveLeaveRequest(requestId, status, approverId, rejectionReason = null) {
    try {
        const updateData = {
            status: status,
            approver_id: approverId,
            approved_at: new Date().toISOString()
        };
        
        if (status === 'rejected' && rejectionReason) {
            updateData.rejection_reason = rejectionReason;
        }
        
        const { error } = await sb.from('leave_requests')
            .update(updateData)
            .eq('id', requestId);
        
        if (error) throw error;
        return { success: true };
    } catch (err) {
        console.error('審核請假失敗:', err);
        return { success: false, error: err.message };
    }
}

// ===== 底部導航列（管理員限定） =====
// 所有頁面的 bottom-nav 預設 display:none，登入後由此函數判斷
async function initBottomNav() {
    const nav = document.querySelector('.bottom-nav');
    if (!nav) return;
    
    try {
        const isAdmin = await checkIsAdmin();
        if (isAdmin) {
            nav.style.display = 'flex';
        } else {
            nav.style.display = 'none';
            // 移除 bottom padding（非管理員不需要留空間）
            document.querySelector('.container')?.style.setProperty('padding-bottom', '16px');
        }
    } catch(e) {
        nav.style.display = 'none';
    }
}

// ===== 功能顯示設定 =====
// 管理員可在 system_settings 中設定哪些功能對員工可見
// key: 'feature_visibility', value: { schedule: true, salary: true, leave: true, lunch: true, attendance: true }
const DEFAULT_FEATURES = {
    schedule: true,     // 班表查詢
    salary: true,       // 薪資查詢
    leave: true,        // 請假申請
    lunch: true,        // 便當訂購
    attendance: true,   // 考勤查詢
    bonus: true         // 年終獎金
};

async function getFeatureVisibility() {
    try {
        const { data } = await sb.from('system_settings')
            .select('value')
            .eq('key', 'feature_visibility')
            .maybeSingle();
        
        if (data?.value) {
            return { ...DEFAULT_FEATURES, ...data.value };
        }
    } catch(e) {}
    return DEFAULT_FEATURES;
}

// 根據設定隱藏首頁選單項目
async function applyFeatureVisibility() {
    const features = await getFeatureVisibility();
    
    // 首頁選單項目對應
    const menuMap = {
        'records.html': 'leave',
        'services.html': 'lunch',
        'records.html#attendance': 'attendance'
    };
    
    document.querySelectorAll('.menu-item').forEach(item => {
        const onclick = item.getAttribute('onclick') || '';
        for (const [url, feature] of Object.entries(menuMap)) {
            if (onclick.includes(url) && !features[feature]) {
                item.style.display = 'none';
            }
        }
    });
    
    // 底部導航對應
    const navMap = {
        'schedule.html': 'schedule',
        'salary.html': 'salary'
    };
    
    document.querySelectorAll('.nav-item').forEach(item => {
        const onclick = item.getAttribute('onclick') || '';
        for (const [url, feature] of Object.entries(navMap)) {
            if (onclick.includes(url) && !features[feature]) {
                item.style.display = 'none';
            }
        }
    });
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
