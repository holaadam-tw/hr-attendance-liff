// ============================================================
// modules/audit.js — 審計日誌與報表匯出
// 依賴 common.js 全域: sb, showToast, escapeHTML, friendlyError,
//   fmtDate, formatNT, writeAuditLog
// ============================================================

let auditOffset = 0;

export async function loadAuditLogs(more = false) {
    const el = document.getElementById('auditLogList');
    if (!el) return;
    if (!more) { auditOffset = 0; el.innerHTML = ''; }
    try {
        const { data } = await sb.from('hr_audit_logs').select('*').order('created_at', { ascending: false }).range(auditOffset, auditOffset + 29);
        if (!data || data.length === 0) { if (auditOffset === 0) el.innerHTML = '<p style="text-align:center;color:#999;">尚無記錄</p>'; return; }
        const ai = { create: '➕', update: '✏️', delete: '🗑️', approve: '✅', reject: '❌', export: '📊', acknowledge: '✍️' };
        const al = { create: '新增', update: '修改', delete: '刪除', approve: '通過', reject: '拒絕', export: '匯出', acknowledge: '簽署' };
        el.innerHTML += data.map(r => `
            <div style="padding:8px 0;border-bottom:1px solid #F1F5F9;font-size:13px;">
                <div style="display:flex;justify-content:space-between;">
                    <span>${ai[r.action] || '📝'} <b>${r.actor_name || '?'}</b> ${al[r.action] || r.action} <span style="color:#7C3AED;">${r.target_table || ''}</span></span>
                    <span style="font-size:10px;color:#94A3B8;">${r.created_at ? new Date(r.created_at).toLocaleString('zh-TW') : ''}</span>
                </div>
                ${r.target_name ? `<div style="font-size:11px;color:#64748B;margin-top:2px;">對象：${r.target_name}</div>` : ''}
            </div>
        `).join('');
        auditOffset += data.length;
    } catch (e) { el.innerHTML = '<p style="text-align:center;color:#ef4444;">載入失敗</p>'; }
}

export async function exportReport(type) {
    showToast('📊 正在產生報表...');
    try {
        const now = new Date();
        const y = now.getFullYear(), m = now.getMonth() + 1, ms = `${y}-${String(m).padStart(2, '0')}`;
        let rows = [], fn = '';

        if (type === 'attendance') {
            const { data } = await sb.from('attendance').select('*, employees(name, employee_number, department)').gte('date', ms + '-01').lte('date', ms + '-31').order('date');
            rows.push(['日期', '工號', '姓名', '部門', '上班', '下班', '狀態', '遲到(分)', '補卡', '備註']);
            (data || []).forEach(r => rows.push([r.date, r.employees?.employee_number, r.employees?.name, r.employees?.department, r.check_in_time?.split('T')[1]?.substring(0, 5) || '', r.check_out_time?.split('T')[1]?.substring(0, 5) || '', r.status, r.late_minutes || 0, r.is_manual ? '是' : '', r.notes || '']));
            fn = `出勤報表_${ms}.csv`;
        } else if (type === 'leave') {
            const { data } = await sb.from('leave_requests').select('*, employees(name, employee_number, department)').order('created_at', { ascending: false }).limit(200);
            const tm = { annual: '特休', sick: '病假', personal: '事假', compensatory: '補休' };
            rows.push(['工號', '姓名', '部門', '假別', '開始', '結束', '天數', '原因', '狀態', '拒絕原因']);
            (data || []).forEach(r => rows.push([r.employees?.employee_number, r.employees?.name, r.employees?.department, tm[r.leave_type] || r.leave_type, r.start_date, r.end_date, r.days || 1, r.reason || '', r.status, r.rejection_reason || '']));
            fn = `請假報表_${ms}.csv`;
        } else if (type === 'overtime') {
            const { data } = await sb.from('overtime_requests').select('*, employees(name, employee_number, department)').order('ot_date', { ascending: false }).limit(200);
            rows.push(['工號', '姓名', '部門', '日期', '申請h', '核准h', '實際h', '計薪h', '補償', '狀態']);
            (data || []).forEach(r => rows.push([r.employees?.employee_number, r.employees?.name, r.employees?.department, r.ot_date, r.planned_hours, r.approved_hours || '', r.actual_hours || '', r.final_hours || '', r.compensation_type === 'pay' ? '加班費' : '補休', r.status]));
            fn = `加班報表_${ms}.csv`;
        } else if (type === 'lunch') {
            const { data } = await sb.from('lunch_orders').select('*, employees(name, employee_number)').gte('order_date', ms + '-01').lte('order_date', ms + '-31').order('order_date');
            rows.push(['日期', '工號', '姓名', '類型', '狀態', '備註']);
            (data || []).forEach(r => rows.push([r.order_date, r.employees?.employee_number, r.employees?.name, r.is_vegetarian ? '素食' : '葷食', r.status === 'cancelled' ? '取消($50)' : '已訂', r.notes || '']));
            fn = `便當報表_${ms}.csv`;
        } else if (type === 'bonus') {
            const { data } = await sb.from('annual_bonus').select('*, employees(name, employee_number, department)').eq('year', y);
            rows.push(['工號', '姓名', '部門', '年資(月)', '基本獎金', '調整', '最終', '詳細']);
            (data || []).forEach(r => {
                let detail = '';
                try { const d = JSON.parse(r.ai_recommendation); detail = `${d.performance_rating}/${d.attendance_grade} x${d.matrix_multiplier}`; } catch (e) { }
                rows.push([r.employees?.employee_number, r.employees?.name, r.employees?.department, r.months_worked, r.base_amount, r.adjustment || 0, r.final_bonus || 0, detail]);
            });
            fn = `獎金報表_${y}.csv`;
        } else if (type === 'payroll') {
            const { data } = await sb.from('payroll').select('*, employees(name, employee_number, department)').eq('year', y).eq('month', m).order('employees(employee_number)');
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
            const { data: od } = await sb.from('orders').select('*, store_profiles(store_name)').gte('created_at', since + 'T00:00:00').order('created_at', { ascending: false });
            const typeLabel = { dine_in: '內用', takeout: '外帶', delivery: '外送' };
            const stLabel = { pending: '待處理', confirmed: '已確認', preparing: '準備中', ready: '可取餐', completed: '已完成', cancelled: '已取消' };
            rows.push(['訂單號', '商店', '取餐號', '客人', '電話', '類型', '品項明細', '合計', '狀態', '下單時間']);
            (od || []).forEach(o => {
                const itemStr = (o.items || []).map(i => `${i.name}x${i.qty}`).join('、');
                rows.push([o.order_number, o.store_profiles?.store_name || '', o.pickup_number || '', o.customer_name || '', o.customer_phone || '', typeLabel[o.order_type] || o.order_type || '', itemStr, o.total, stLabel[o.status] || o.status, o.created_at?.substring(0, 16).replace('T', ' ') || '']);
            });
            fn = `訂單報表_${ms}.csv`;
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
