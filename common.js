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
let currentCheckInType = 'in';
let cachedLocation = null;
let currentBindMode = 'id_card';
let todayAttendance = null;
let officeLocations = []; 
let isProcessing = false;

// 初始化 LIFF
async function initializeLiff() {
    try {
        console.log('🚀 系統初始化...');
        await liff.init({ liffId: CONFIG.LIFF_ID });
        if (!liff.isLoggedIn()) { 
            liff.login(); 
            return false;
        }
        
        liffProfile = await liff.getProfile();
        return true;
    } catch (error) {
        alert('初始化失敗: ' + error.message);
        return false;
    }
}

// 核心：取得台灣時間 YYYY-MM-DD
function getTaiwanDate(offsetDays = 0) {
    const date = new Date();
    date.setDate(date.getDate() + offsetDays);
    return date.toLocaleDateString('en-CA', { timeZone: 'Asia/Taipei' });
}

// 計算距離公式 (Haversine)
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

// 檢查用戶狀態
async function checkUserStatus() {
    document.getElementById('loadingPage').style.display = 'flex';
    
    try {
        const { data, error } = await sb.from('employees').select('*').eq('line_user_id', liffProfile.userId).single();
        
        await loadSettings();

        document.getElementById('loadingPage').style.display = 'none';

        if (data) {
            currentEmployee = data;
            updateUserInfo(data);
            await checkTodayAttendance();
            return true;
        } else {
            return false;
        }
    } catch (err) {
        document.getElementById('loadingPage').style.display = 'none';
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
        if(liffProfile.pictureUrl) {
            avatarEl.style.backgroundImage = `url(${liffProfile.pictureUrl})`;
            avatarEl.style.backgroundSize = 'cover'; 
            avatarEl.textContent='';
        } else {
            avatarEl.textContent = data.name.charAt(0);
        }
    }
}

// 載入系統設定
async function loadSettings() {
    try {
        const { data, error } = await sb.from('system_settings').select('value').eq('key', 'office_locations').single();
        if (!error && data) {
            officeLocations = data.value || [];
        }
    } catch (e) { 
        console.error('載入地點失敗', e); 
    }
}

// 預載 GPS
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
                    cachedLocation.latitude, 
                    cachedLocation.longitude, 
                    loc.lat, 
                    loc.lng
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

// 取得 GPS
function getGPS() { 
    return new Promise((res, rej) => {
        navigator.geolocation.getCurrentPosition(
            p => res({latitude:p.coords.latitude, longitude:p.coords.longitude}), 
            e => rej(e), 
            { enableHighAccuracy: true, timeout: 10000, maximumAge: 0 }
        );
    });
}

// 檢查今日考勤
async function checkTodayAttendance() {
    if (!currentEmployee) return;
    try {
        const today = getTaiwanDate(0);
        const { data, error } = await sb.from('attendance')
            .select('*')
            .eq('employee_id', currentEmployee.id)
            .eq('date', today)
            .single();
        
        if (error) {
            if (error.code === 'PGRST116') {
                todayAttendance = null; 
            } else {
                console.error('❌ 檢查考勤錯誤:', error);
                todayAttendance = null;
            }
        } else {
            todayAttendance = data;
        }
        updateCheckInButtons();
    } catch(e) { 
        console.error(e); 
    }
}

// 更新打卡按鈕狀態
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
        showStatus(statusBox, 'success', `✅ 今日完工 (工時 ${todayAttendance.total_work_hours?.toFixed(1)}h)`);
    } else {
        btnIn.classList.add('disabled');
        btnOut.classList.remove('disabled');
        const time = new Date(todayAttendance.check_in_time).toLocaleTimeString('zh-TW', {timeZone:'Asia/Taipei', hour:'2-digit', minute:'2-digit'});
        const locName = todayAttendance.check_in_location?.includes('(') ? todayAttendance.check_in_location.split('(')[0] : lastLoc;
        showStatus(statusBox, 'info', `🏢 上班中 @ ${locName} (${time})`);
    }
}

// 綁定模式切換
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

// 處理員工綁定
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
        if (data.success) {
            showStatus(statusBox, 'success', '✅ 綁定成功！');
            setTimeout(() => {
                window.location.href = 'index.html';
            }, 1500);
        } else {
            showStatus(statusBox, 'error', data.error);
        }
    } catch (err) {
        showStatus(statusBox, 'error', err.message);
    }
}

// 便當相關功能
async function loadLunchSummary() {
    const dateStr = getTaiwanDate(1);
    const lunchDateEl = document.getElementById('lunchDate');
    if (lunchDateEl) lunchDateEl.value = dateStr;
    
    try {
        const { data } = await sb.rpc('get_lunch_summary', { p_date: dateStr });
        if(data) {
            const totalOrdersEl = document.getElementById('totalOrders');
            const vegCountEl = document.getElementById('vegCount');
            const regularCountEl = document.getElementById('regularCount');
            const lunarNoticeEl = document.getElementById('lunarNotice');
            const lunchVegetarianEl = document.getElementById('lunchVegetarian');
            
            if (totalOrdersEl) totalOrdersEl.textContent = data.total_orders || 0;
            if (vegCountEl) vegCountEl.textContent = data.vegetarian_count || 0;
            if (regularCountEl) regularCountEl.textContent = data.regular_count || 0;
            if (data.is_lunar_vegetarian_day) {
                if (lunarNoticeEl) lunarNoticeEl.classList.add('show');
                if (lunchVegetarianEl) lunchVegetarianEl.checked = true;
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
        if(error) throw error;
        showToast('✅ 訂購成功'); 
        loadLunchSummary();
    } catch(e) { 
        showToast('失敗:'+e.message); 
    }
}

// 請假相關功能
async function submitLeave() {
    if (!currentEmployee) return showToast('❌ 請先登入');
    const type = document.getElementById('leaveType')?.value;
    const start = document.getElementById('leaveStartDate')?.value;
    const end = document.getElementById('leaveEndDate')?.value;
    const reason = document.getElementById('leaveReason')?.value;
    if(!start || !end || !reason) return showToast('請填寫完整');
    
    try {
        const { error } = await sb.from('leave_requests').insert({
            employee_id: currentEmployee.id, leave_type: type, start_date: start, end_date: end, reason: reason, status: 'pending'
        });
        if(error) throw error;
        showToast('✅ 申請成功'); 
        loadLeaveHistory();
        const leaveStatusEl = document.getElementById('leaveStatus');
        if (leaveStatusEl) {
            leaveStatusEl.className = 'status-box show success';
            leaveStatusEl.textContent = '✅ 申請已提交';
        }
    } catch(e) { 
        showToast('失敗:'+e.message); 
    }
}

async function loadLeaveHistory() {
    const list = document.getElementById('leaveHistoryList');
    if (!currentEmployee || !list) return;
    try {
        const { data } = await sb.rpc('get_leave_history', { p_line_user_id: liffProfile.userId, p_limit: 5 });
        if (!data || data.length === 0) { 
            list.innerHTML = '<p style="text-align:center;">尚無記錄</p>'; 
            return; 
        }
        
        const typeMap = { 'annual': '特休', 'sick': '病假', 'personal': '事假', 'compensatory': '補休' };
        const statusMap = { 'pending': '⏳', 'approved': '✅', 'rejected': '❌' };
        
        list.innerHTML = data.map(r => `
            <div class="attendance-item">
                <div class="date">${typeMap[r.leave_type]} ${statusMap[r.status]}</div>
                <div class="details">
                    <div>${r.start_date} ~ ${r.end_date}</div>
                    <div style="color:#999;">${r.reason}</div>
                </div>
            </div>
        `).join('');
    } catch(e) { 
        console.error(e); 
    }
}

// 月度出勤查詢
async function loadMonthlyAttendance() {
    const list = document.getElementById('attendanceList');
    const yearEl = document.getElementById('attendanceYear');
    const monthEl = document.getElementById('attendanceMonth');
    
    if (!list || !yearEl || !monthEl || !currentEmployee) return;
    
    const year = parseInt(yearEl.value);
    const month = parseInt(monthEl.value);
    
    list.innerHTML = '<p style="text-align:center;">查詢中...</p>';
    
    try {
        const { data, error } = await sb.rpc('get_monthly_attendance', {
            p_line_user_id: liffProfile.userId,
            p_year: year,
            p_month: month
        });
        
        if (error) throw error;
        if (!data || data.length === 0) {
            list.innerHTML = `<p style="text-align:center;">${year}年${month}月 無記錄</p>`;
            return;
        }
        
        const totalDays = data.length;
        const lateDays = data.filter(r => r.is_late).length;
        const totalHours = data.reduce((sum, r) => sum + (parseFloat(r.total_work_hours) || 0), 0);
        
        let html = `
            <div class="lunch-summary" style="margin-bottom:15px;">
                <div class="stat-row"><span>出勤</span><span>${totalDays}天</span></div>
                <div class="stat-row"><span>遲到</span><span>${lateDays}次</span></div>
                <div class="stat-row"><span>工時</span><span>${totalHours.toFixed(1)}h</span></div>
            </div>
        `;
        
        html += data.map(r => {
            const badge = r.is_late ? '<span class="badge badge-warning">遲到</span>' : '<span class="badge badge-success">正常</span>';
            const hours = r.total_work_hours ? `${parseFloat(r.total_work_hours).toFixed(1)}h` : '-';
            return `
                <div class="attendance-item ${r.is_late ? 'late' : 'normal'}">
                    <div class="date">${r.date} ${badge} <span style="font-size:12px;">${hours}</span></div>
                    <div class="details">
                        <span>上班: ${r.check_in_time ? r.check_in_time.split(' ')[1].substr(0,5) : '-'}</span>
                        <span>下班: ${r.check_out_time ? r.check_out_time.split(' ')[1].substr(0,5) : '-'}</span>
                    </div>
                    ${r.photo_url ? `<div style="margin-top:5px;"><a href="${r.photo_url}" target="_blank" style="font-size:12px;">📷 照片</a></div>` : ''}
                </div>
            `;
        }).join('');
        list.innerHTML = html;
    } catch (err) { 
        console.error(err); 
        list.innerHTML = '查詢失敗'; 
    }
}

// 年終統計
async function loadAnnualSummary() {
    const yearEl = document.getElementById('salaryYear');
    const statusCard = document.getElementById('yearEndStatusCard');
    const statsGrid = document.getElementById('statsGrid');
    
    if (!yearEl || !statusCard || !statsGrid || !currentEmployee) return;

    const year = parseInt(yearEl.value);
    
    // 顯示載入狀態
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
        
        // 更新狀態卡片
        const isEligible = data.bonus_status === '符合資格';
        statusCard.className = isEligible ? 'status-card success' : 'status-card error';
        document.getElementById('statusResult').textContent = isEligible ? '✅ 符合資格' : '❌ 已取消';
        document.getElementById('statusReason').textContent = data.bonus_status;
        
        // 更新統計資料
        const bonusHireDateEl = document.getElementById('bonusHireDate');
        const bonusMonthsEl = document.getElementById('bonusMonths');
        const bonusDaysEl = document.getElementById('bonusDays');
        const attendanceRateEl = document.getElementById('attendanceRate');
        const bonusLateEl = document.getElementById('bonusLate');
        const lateRateEl = document.getElementById('lateRate');
        const bonusHoursEl = document.getElementById('bonusHours');
        const bonusAvgHoursEl = document.getElementById('bonusAvgHours');
        
        if (bonusHireDateEl) bonusHireDateEl.textContent = data.hire_date || '-';
        if (bonusMonthsEl) bonusMonthsEl.textContent = `${data.months_worked} 個月`;
        if (bonusDaysEl) bonusDaysEl.textContent = `${data.total_attendance_days} 天`;
        if (attendanceRateEl) attendanceRateEl.textContent = `${data.attendance_rate}%`;
        if (bonusLateEl) {
            bonusLateEl.textContent = `${data.late_count} 次`;
            bonusLateEl.style.color = data.late_count > 5 ? '#ef4444' : '#1f2937';
        }
        if (lateRateEl) {
            lateRateEl.textContent = `${data.late_rate}%`;
            lateRateEl.style.color = data.late_rate > 5 ? '#ef4444' : '#1f2937';
        }
        if (bonusHoursEl) bonusHoursEl.textContent = `${data.total_work_hours} 小時`;
        if (bonusAvgHoursEl) bonusAvgHoursEl.textContent = `${data.avg_daily_hours} 小時`;
        
        statsGrid.style.display = 'grid';
        
    } catch (err) { 
        console.error(err); 
        statusCard.className = 'status-card error';
        document.getElementById('statusResult').textContent = '❌ 載入失敗';
        document.getElementById('statusReason').textContent = err.message;
    }
}

// 設定頁面功能
function renderLocationList() {
    const listEl = document.getElementById('locationList');
    if (!listEl) return;
    
    if (officeLocations.length === 0) {
        listEl.innerHTML = '<p style="color:#666;text-align:center;">尚未設定地點</p>';
        return;
    }
    listEl.innerHTML = officeLocations.map((loc, index) => `
        <div class="stat-row" style="align-items:center;">
            <div style="text-align:left;">
                <div style="font-weight:bold;">${loc.name}</div>
                <div style="font-size:11px;color:#999;">範圍: ${loc.radius}m</div>
            </div>
            <button onclick="deleteLocation(${index})" class="btn-danger">刪除</button>
        </div>
    `).join('');
}

function getCurrentGPSForSetting() {
    showToast('📍 定位中...');
    navigator.geolocation.getCurrentPosition(
        (pos) => {
            const newLocLatEl = document.getElementById('newLocLat');
            const newLocLngEl = document.getElementById('newLocLng');
            if (newLocLatEl) newLocLatEl.value = pos.coords.latitude;
            if (newLocLngEl) newLocLngEl.value = pos.coords.longitude;
            showToast('✅ 已填入座標');
        },
        (err) => showToast('定位失敗: ' + err.message),
        { enableHighAccuracy: true, timeout: 10000, maximumAge: 0 }
    );
}

async function addNewLocation() {
    const nameEl = document.getElementById('newLocName');
    const radiusEl = document.getElementById('newLocRadius');
    const latEl = document.getElementById('newLocLat');
    const lngEl = document.getElementById('newLocLng');
    
    const name = nameEl?.value.trim();
    const radius = parseInt(radiusEl?.value);
    const lat = parseFloat(latEl?.value);
    const lng = parseFloat(lngEl?.value);

    if (!name || !lat || !lng) return showToast('⚠️ 資料不完整');

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
        showToast('❌ 儲存失敗');
    }
}

// 工具函數
function showStatus(el, type, msg) { 
    if (!el) return;
    el.className=`status-box show ${type}`; 
    el.innerHTML=msg; 
}

function showToast(msg) { 
    const t=document.createElement('div'); 
    t.className='toast'; 
    t.textContent=msg; 
    document.body.appendChild(t); 
    setTimeout(()=>t.remove(), 3000); 
}

// 檢查是否為管理員
async function checkIsAdmin() {
    if (!liffProfile) return false;
    
    try {
        const { data, error } = await sb.from('employees')
            .select('role')
            .eq('line_user_id', liffProfile.userId)
            .eq('is_active', true)
            .single();
        
        if (error || !data) return false;
        return data.role === 'admin';
    } catch (err) {
        console.error('檢查管理員權限失敗:', err);
        return false;
    }
}

// 取得管理員資訊
async function getAdminInfo() {
    if (!liffProfile) return null;
    
    try {
        const { data, error } = await sb.from('employees')
            .select('*')
            .eq('line_user_id', liffProfile.userId)
            .eq('role', 'admin')
            .eq('is_active', true)
            .single();
        
        if (error || !data) return null;
        return data;
    } catch (err) {
        console.error('取得管理員資訊失敗:', err);
        return null;
    }
}

// 管理員專用：更新員工角色
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

// 管理員專用：手動調整獎金
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

// 管理員專用：審核請假
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

// 頁面載入時初始化
window.addEventListener('load', async () => {
    // 添加 debug console
    if(location.search.includes('debug=true')) {
        const script = document.createElement('script');
        script.src = 'https://unpkg.com/vconsole@latest/dist/vconsole.min.js';
        script.onload = () => new window.VConsole();
        document.head.appendChild(script);
    }
    
    const initialized = await initializeLiff();
    if (initialized) {
        const isLoggedIn = await checkUserStatus();
        if (isLoggedIn) {
            preloadGPS();
        }
    }
});
