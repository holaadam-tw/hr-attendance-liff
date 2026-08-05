// ============================================================
// modules/audit.js — 審計日誌與報表匯出
// 依賴 common.js 全域: sb, showToast, escapeHTML, friendlyError,
//   fmtDate, getTaiwanDate, formatNT, writeAuditLog
// ============================================================

let auditOffset = 0;

export async function loadAuditLogs(more = false) {
    const el = document.getElementById('auditLogList');
    if (!el) return;
    if (!more) { auditOffset = 0; el.innerHTML = ''; }
    try {
        const { data } = await sb.from('hr_audit_logs').select('*').eq('company_id', window.currentCompanyId).order('created_at', { ascending: false }).range(auditOffset, auditOffset + 29);
        if (!data || data.length === 0) { if (auditOffset === 0) el.innerHTML = '<p style="text-align:center;color:#999;">尚無記錄</p>'; return; }
        const ai = { create: '➕', update: '✏️', delete: '🗑️', approve: '✅', reject: '❌', export: '📊', acknowledge: '✍️' };
        const al = { create: '新增', update: '修改', delete: '刪除', approve: '通過', reject: '拒絕', export: '匯出', acknowledge: '簽署' };
        el.innerHTML += data.map(r => `
            <div style="padding:8px 0;border-bottom:1px solid #F1F5F9;font-size:13px;">
                <div style="display:flex;justify-content:space-between;">
                    <span>${ai[r.action] || '📝'} <b>${escapeHTML(r.actor_name || '?')}</b> ${al[r.action] || r.action} <span style="color:#7C3AED;">${escapeHTML(r.target_table || '')}</span></span>
                    <span style="font-size:10px;color:#94A3B8;">${r.created_at ? new Date(r.created_at).toLocaleString('zh-TW', { timeZone: 'Asia/Taipei' }) : ''}</span>
                </div>
                ${r.target_name ? `<div style="font-size:11px;color:#64748B;margin-top:2px;">對象：${escapeHTML(r.target_name)}</div>` : ''}
            </div>
        `).join('');
        auditOffset += data.length;
    } catch (e) { el.innerHTML = '<p style="text-align:center;color:#ef4444;">載入失敗</p>'; }
}

// 報表月份選擇器：預設當月，進入報表頁時初始化（showPage → reportPage）
export function initReportMonth() {
    const el = document.getElementById('reportMonth');
    if (!el) return;
    const nowTw = getTaiwanDate(0);            // YYYY-MM-DD（台灣時區）
    el.max = nowTw.substring(0, 7);
    if (!el.value) el.value = el.max;
}

// 使用者選的月份，沒選就用當月；回傳 { y, m, ms, first, last }
function getReportMonth() {
    const picked = document.getElementById('reportMonth')?.value;   // YYYY-MM
    const ms = /^\d{4}-\d{2}$/.test(picked || '') ? picked : getTaiwanDate(0).substring(0, 7);
    const y = Number(ms.substring(0, 4)), m = Number(ms.substring(5, 7));
    // 該月最後一天：下個月第 0 天
    const last = `${ms}-${String(new Date(y, m, 0).getDate()).padStart(2, '0')}`;
    return { y, m, ms, first: `${ms}-01`, last };
}

export async function exportReport(type) {
    showToast('📊 正在產生報表...');
    try {
        const { y, m, ms, first, last } = getReportMonth();
        let rows = [], fn = '';

        if (type === 'payroll_summary') {
            // 一人一列的薪資計算用彙總。資料來源與已知限制見 docs/PAYROLL_SUMMARY_REPORT.md
            const SHIFT_START_MIN = 8 * 60;     // 全公司上班 08:00（employees.fixed_shift_start 皆為此值）
            const OT_AFTER_MIN = 18 * 60;       // 下班 18:00 之後才算加班（17:0x 下班屬正常收工）
            const HALF_DAY_AFTER_MIN = 9 * 60 + 30;  // 晚於 09:30 才上班 → 疑似半天/外出，另計一欄

            const [attRes, lvRes, otRes] = await Promise.all([
                sb.from('attendance')
                    .select('employee_id, date, check_in_time, check_out_time, total_work_hours, employees!inner(name, employee_number, department, company_id)')
                    .eq('employees.company_id', window.currentCompanyId).gte('date', first).lte('date', last),
                sb.from('leave_requests')
                    .select('employee_id, leave_type, leave_period, leave_hours, days, start_date, end_date, employees!leave_requests_employee_id_fkey!inner(name, employee_number, department, company_id)')
                    .eq('employees.company_id', window.currentCompanyId).eq('status', 'approved')
                    .lte('start_date', last).gte('end_date', first),
                sb.from('overtime_requests')
                    .select('employee_id, ot_date, hours, approved_hours, final_hours, employees!overtime_requests_employee_id_fkey!inner(name, employee_number, department, company_id)')
                    .eq('employees.company_id', window.currentCompanyId).eq('status', 'approved')
                    .gte('ot_date', first).lte('ot_date', last)
            ]);

            // 台灣時區的當日分鐘數（0=00:00）。DB 存 UTC，不可用 getHours()
            const twMinutes = (ts) => {
                if (!ts) return null;
                const hm = new Date(ts).toLocaleTimeString('en-GB', { timeZone: 'Asia/Taipei', hourCycle: 'h23', hour: '2-digit', minute: '2-digit' });
                return Number(hm.substring(0, 2)) * 60 + Number(hm.substring(3, 5));
            };
            const dayDiff = (a, b) => Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / 86400000);

            const map = new Map();
            const pick = (id, emp) => {
                if (!map.has(id)) map.set(id, {
                    no: '', name: '', dept: '',
                    days: 0, hours: 0, otH: 0, otC: 0, otApproved: 0,
                    late: 0, lateEx: 0, halfDay: 0, noOut: 0,
                    annualD: 0, annualH: 0, otherD: 0, otherH: 0
                });
                const r = map.get(id);
                // 整月都在請假、完全沒打卡的人只會出現在 leave/overtime，姓名要從那邊補
                if (!r.no && emp) { r.no = emp.employee_number || ''; r.name = emp.name || ''; r.dept = emp.department || ''; }
                return r;
            };

            (attRes.data || []).forEach(a => {
                const r = pick(a.employee_id, a.employees);
                const inMin = twMinutes(a.check_in_time);
                const outMin = twMinutes(a.check_out_time);
                if (inMin !== null) {
                    r.days++;
                    const lateMin = Math.max(0, inMin - SHIFT_START_MIN);
                    r.late += lateMin;
                    if (inMin > HALF_DAY_AFTER_MIN) r.halfDay++; else r.lateEx += lateMin;
                }
                r.hours += Number(a.total_work_hours || 0);
                if (inMin !== null && outMin === null) r.noOut++;
                if (outMin !== null && outMin >= OT_AFTER_MIN) { r.otC++; r.otH += (outMin - 17 * 60) / 60; }
            });

            (lvRes.data || []).forEach(l => {
                const r = pick(l.employee_id, l.employees);
                // 跨月請假按落在本月的日曆天比例分攤
                const s = l.start_date, e = l.end_date || l.start_date;
                const span = dayDiff(s, e) + 1;
                const ovl = dayDiff(s > first ? s : first, e < last ? e : last) + 1;
                const ratio = span > 0 ? Math.max(0, Math.min(1, ovl / span)) : 0;
                // 半天假的 days 欄位存 1.0（既有資料問題），一律以 leave_period 為準
                const d = l.leave_period === 'hourly' ? 0
                    : (l.leave_period === 'am' || l.leave_period === 'pm') ? 0.5
                        : Number(l.days || 0) * ratio;
                const h = l.leave_period === 'hourly' ? Number(l.leave_hours || 0) * ratio : 0;
                if (l.leave_type === 'annual') { r.annualD += d; r.annualH += h; }
                else { r.otherD += d; r.otherH += h; }
            });

            (otRes.data || []).forEach(o => {
                pick(o.employee_id, o.employees).otApproved += Number(o.final_hours ?? o.approved_hours ?? o.hours ?? 0);
            });

            const r1 = (n) => Math.round(n * 10) / 10;
            rows.push(['工號', '姓名', '部門', '出勤天數', '總工時', '加班時數(推估)', '加班次數(推估)', '加班時數(已核准)',
                '遲到分鐘', '遲到分鐘(排除疑似半天)', '疑似半天天數', '特休天數', '特休時數', '其他假天數', '其他假時數', '缺下班卡天數']);
            [...map.values()]
                .filter(r => r.days > 0 || r.annualD || r.otherD || r.annualH || r.otherH || r.otApproved)
                .sort((a, b) => String(a.no).localeCompare(String(b.no)))
                .forEach(r => rows.push([r.no, r.name, r.dept, r.days, r1(r.hours), r1(r.otH), r.otC, r1(r.otApproved),
                    r.late, r.lateEx, r.halfDay, r1(r.annualD), r1(r.annualH), r1(r.otherD), r1(r.otherH), r.noOut]));
            fn = `薪資計算彙總_${ms}.csv`;
        } else if (type === 'attendance') {
            const { data } = await sb.from('attendance').select('*, employees!inner(name, employee_number, department, company_id)').eq('employees.company_id', window.currentCompanyId).gte('date', first).lte('date', last).order('date');
            rows.push(['日期', '工號', '姓名', '部門', '上班', '下班', '狀態', '遲到(分)', '補卡', '備註']);
            (data || []).forEach(r => rows.push([r.date, r.employees?.employee_number, r.employees?.name, r.employees?.department, r.check_in_time ? new Date(r.check_in_time).toLocaleTimeString('zh-TW', { timeZone: 'Asia/Taipei', hour: '2-digit', minute: '2-digit', hour12: false }) : '', r.check_out_time ? new Date(r.check_out_time).toLocaleTimeString('zh-TW', { timeZone: 'Asia/Taipei', hour: '2-digit', minute: '2-digit', hour12: false }) : '', r.status, r.late_minutes || 0, r.is_manual ? '是' : '', r.notes || '']));
            fn = `出勤報表_${ms}.csv`;
        } else if (type === 'leave') {
            const { data } = await sb.from('leave_requests').select('*, employees!leave_requests_employee_id_fkey!inner(name, employee_number, department, company_id)').eq('employees.company_id', window.currentCompanyId).order('created_at', { ascending: false }).limit(200);
            const tm = { annual: '特休', sick: '病假', personal: '事假', compensatory: '補休' };
            const periodLabel = (r) => {
                if (r.leave_period === 'hourly') return `${r.leave_hours || 0} 小時`;
                const periodMap = { full_day: '全日', am: '上午半天', pm: '下午半天' };
                return periodMap[r.leave_period || 'full_day'] || '全日';
            };
            rows.push(['工號', '姓名', '部門', '假別', '時段', '開始', '結束', '天數', '原因', '狀態', '拒絕原因']);
            (data || []).forEach(r => rows.push([r.employees?.employee_number, r.employees?.name, r.employees?.department, tm[r.leave_type] || r.leave_type, periodLabel(r), r.start_date, r.end_date, r.days || 1, r.reason || '', r.status, r.rejection_reason || '']));
            fn = `請假報表_${ms}.csv`;
        } else if (type === 'overtime') {
            const { data } = await sb.from('overtime_requests').select('*, employees!overtime_requests_employee_id_fkey!inner(name, employee_number, department, company_id)').eq('employees.company_id', window.currentCompanyId).order('ot_date', { ascending: false }).limit(200);
            rows.push(['工號', '姓名', '部門', '日期', '申請h', '核准h', '實際h', '計薪h', '補償', '狀態']);
            (data || []).forEach(r => rows.push([r.employees?.employee_number, r.employees?.name, r.employees?.department, r.ot_date, r.planned_hours, r.approved_hours || '', r.actual_hours || '', r.final_hours || '', r.compensation_type === 'pay' ? '加班費' : '補休', r.status]));
            fn = `加班報表_${ms}.csv`;
        } else if (type === 'lunch') {
            const { data } = await sb.from('lunch_orders').select('*, employees!inner(name, employee_number, company_id)').eq('employees.company_id', window.currentCompanyId).gte('order_date', first).lte('order_date', last).order('order_date');
            rows.push(['日期', '工號', '姓名', '類型', '狀態', '備註']);
            (data || []).forEach(r => rows.push([r.order_date, r.employees?.employee_number, r.employees?.name, r.is_vegetarian ? '素食' : '葷食', r.status === 'cancelled' ? '取消($50)' : '已訂', r.notes || '']));
            fn = `便當報表_${ms}.csv`;
        } else if (type === 'bonus') {
            const { data } = await sb.from('annual_bonus').select('*, employees!inner(name, employee_number, department, company_id)').eq('employees.company_id', window.currentCompanyId).eq('year', y);
            rows.push(['工號', '姓名', '部門', '年資(月)', '基本獎金', '調整', '最終', '詳細']);
            (data || []).forEach(r => {
                let detail = '';
                try { const d = JSON.parse(r.ai_recommendation); detail = `${d.performance_rating}/${d.attendance_grade} x${d.matrix_multiplier}`; } catch (e) { }
                rows.push([r.employees?.employee_number, r.employees?.name, r.employees?.department, r.months_worked, r.base_amount, r.adjustment || 0, r.final_bonus || 0, detail]);
            });
            fn = `獎金報表_${y}.csv`;
        } else if (type === 'payroll') {
            const { data } = await sb.rpc('get_company_payroll', { p_company_id: window.currentCompanyId, p_line_user_id: window.currentAdminEmployee?.line_user_id, p_year: y, p_month: m });
            rows.push(['工號', '姓名', '部門', '薪資類型', '底薪', '加班費', '全勤獎金', '伙食津貼', '職務加給', '勞保', '健保', '勞退', '所得稅', '遲到扣', '請假扣', '手動調整', '總收入', '總扣款', '實發', '狀態']);
            (data || []).forEach(r => {
                const typeMap = { monthly: '月薪', daily: '日薪', hourly: '時薪' };
                rows.push([r.employees?.employee_number, r.employees?.name, r.employees?.department, typeMap[r.salary_type] || r.salary_type, r.base_salary, r.overtime_pay, r.full_attendance_bonus, r.meal_allowance || 0, r.position_allowance || 0, r.labor_insurance, r.health_insurance, r.pension_self || 0, r.income_tax || 0, r.late_deduction, r.personal_leave_deduction || 0, r.manual_adjustment || 0, r.gross_salary, r.total_deduction, r.net_salary, r.is_published ? '已發布' : '草稿']);
            });
            fn = `薪資報表_${ms}.csv`;
        } else if (type === 'orders') {
            const threeMonthsAgo = new Date();
            threeMonthsAgo.setMonth(threeMonthsAgo.getMonth() - 3);
            const since = fmtDate(threeMonthsAgo);
            const { data: od } = await sb.from('orders').select('*, store_profiles!inner(store_name, company_id)').eq('store_profiles.company_id', window.currentCompanyId).gte('created_at', since + 'T00:00:00').order('created_at', { ascending: false });
            const typeLabel = { dine_in: '內用', takeout: '外帶', delivery: '外送' };
            const stLabel = { pending: '待處理', confirmed: '已確認', preparing: '準備中', ready: '可取餐', completed: '已完成', cancelled: '已取消' };
            rows.push(['訂單號', '商店', '取餐號', '客人', '電話', '類型', '品項明細', '合計', '狀態', '下單時間']);
            (od || []).forEach(o => {
                const itemStr = (o.items || []).map(i => `${i.name}x${i.qty}`).join('、');
                rows.push([o.order_number, o.store_profiles?.store_name || '', o.pickup_number || '', o.customer_name || '', o.customer_phone || '', typeLabel[o.order_type] || o.order_type || '', itemStr, o.total, stLabel[o.status] || o.status, o.created_at?.substring(0, 16).replace('T', ' ') || '']);
            });
            fn = `訂單報表_${ms}.csv`;
        } else if (type === 'loyalty') {
            const { data: members } = await sb.from('loyalty_members').select('*').eq('company_id', window.currentCompanyId).order('created_at', { ascending: false });
            rows.push(['姓名', '手機', 'LINE', '總點數', '已使用', '可用點數', '加入日期', '最後消費']);
            (members || []).forEach(m => rows.push([m.name || '', m.phone || '', m.line_user_id ? '是' : '否', m.total_points || 0, m.used_points || 0, m.available_points || 0, m.member_since || '', m.last_visit || '']));
            fn = `集點會員報表_${ms}.csv`;
        } else if (type === 'loyalty_transactions') {
            const threeMonthsAgo = new Date();
            threeMonthsAgo.setMonth(threeMonthsAgo.getMonth() - 3);
            const since = threeMonthsAgo.toLocaleDateString('en-CA', { timeZone: 'Asia/Taipei' });
            const { data: txns } = await sb.from('loyalty_transactions').select('*, loyalty_members(name, phone)').eq('company_id', window.currentCompanyId).gte('created_at', since + 'T00:00:00').order('created_at', { ascending: false });
            const srcLabel = { order: '消費', booking: '訂位', booking_service: '服務預約', manual: '手動' };
            rows.push(['日期', '會員', '手機', '類型', '點數', '金額', '來源', '說明']);
            (txns || []).forEach(t => {
                const dateStr = t.created_at ? new Date(t.created_at).toLocaleString('zh-TW', { timeZone: 'Asia/Taipei', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '';
                rows.push([dateStr, t.loyalty_members?.name || '', t.loyalty_members?.phone || '', t.type === 'earn' ? '集點' : '兌換', t.points, t.amount || '', srcLabel[t.source] || t.source || '', t.note || '']);
            });
            fn = `集點異動報表_${ms}.csv`;
        }

        if (rows.length <= 1) { showToast('⚠️ 無資料'); return; }
        const csv = '\uFEFF' + rows.map(r => r.map(c => `"${String(c ?? '').replace(/"/g, '""')}"`).join(',')).join('\n');
        const a = document.createElement('a');
        a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8;' }));
        a.download = fn; a.click();
        writeAuditLog('export', type, null, fn, { rows: rows.length - 1 });
        showToast(`✅ ${fn}（${rows.length - 1} 筆）`);
    } catch (e) { showToast('❌ 匯出失敗：' + friendlyError(e)); }
}
