// ============================================================
// modules/settings.js — 功能管理、公告、客戶、外勤審核、公司、業務目標
// 依賴 common.js 全域: sb, showToast, escapeHTML, friendlyError,
//   writeAuditLog, sendAdminNotify, getGPS, getTaiwanDate,
//   invalidateSettingsCache, fmtDate
// ============================================================

// ===== 功能管理 =====
export const ADMIN_FEATURE_LIST = [
    { key: 'leave',          label: '我要請假',      desc: '請假申請與記錄查詢',   icon: '📝' },
    { key: 'lunch',          label: '便當訂購',      desc: '每日午餐訂購管理',     icon: '🍱' },
    { key: 'attendance',     label: '考勤查詢',      desc: '出勤月曆與記錄查詢',   icon: '📊' },
    { key: 'fieldwork,sales_target', label: '外勤/業務', desc: '外勤打卡、業務目標與週報', icon: '📍' },
    { key: 'store_ordering', label: '查看訂單',        desc: '線上預約與點餐服務',   icon: '🛍️' }
];

export let featureState = { leave: true, lunch: true, attendance: true, fieldwork: true, sales_target: true, store_ordering: false };

// ===== LINE Notify =====
export async function loadNotifyToken() {
    try {
        const { data } = await sb.from('system_settings')
            .select('value').eq('key', 'line_notify_token').maybeSingle();
        if (data?.value?.token) {
            const el = document.getElementById('lineNotifyToken');
            if (el) el.value = data.value.token;
        }
    } catch(e) {}
}

export async function saveNotifyToken() {
    const token = document.getElementById('lineNotifyToken')?.value?.trim();
    if (!token) return showToast('❌ 請輸入 Token');
    const status = document.getElementById('notifyStatus');
    try {
        const { data: existing } = await sb.from('system_settings')
            .select('id').eq('key', 'line_notify_token').maybeSingle();
        if (existing) {
            await sb.from('system_settings').update({ value: { token }, updated_at: new Date().toISOString() }).eq('key', 'line_notify_token');
        } else {
            await sb.from('system_settings').insert({ key: 'line_notify_token', value: { token }, description: 'LINE Notify 推播 Token' });
        }
        showToast('✅ Token 已儲存');
        if (status) { status.style.display = 'block'; status.style.color = '#059669'; status.textContent = '✅ 已儲存'; }
    } catch(e) { showToast('❌ 儲存失敗'); }
}

export async function testNotify() {
    const status = document.getElementById('notifyStatus');
    if (status) { status.style.display = 'block'; status.style.color = '#6D28D9'; status.textContent = '⏳ 發送測試...'; }
    try {
        await sendAdminNotify('🔔 HR 系統推播測試\n如果您收到此訊息，表示 LINE Notify 設定成功！');
        showToast('✅ 測試推播已發送');
        if (status) { status.style.color = '#059669'; status.textContent = '✅ 推播成功！請查看 LINE 群組'; }
    } catch(e) {
        showToast('❌ 推播失敗');
        if (status) { status.style.color = '#DC2626'; status.textContent = '❌ 推播失敗，請檢查 Token 或 Edge Function'; }
    }
}

// ===== 功能開關 =====
export async function loadFeatureSettings() {
    try {
        const { data } = await sb.from('system_settings')
            .select('value')
            .eq('key', 'feature_visibility')
            .maybeSingle();
        if (data?.value) {
            featureState = { ...featureState, ...data.value };
        }
    } catch(e) {}

    const allowed = window.companyAllowedFeatures || {};
    const defaultAllowed = { leave: true, lunch: true, attendance: true, fieldwork: true, sales_target: true, store_ordering: false };
    const visibleFeatures = ADMIN_FEATURE_LIST.filter(f => {
        const keys = f.key.split(',');
        if (window.companyAllowedFeatures) {
            return keys.some(k => allowed[k.trim()] === true);
        }
        return keys.some(k => defaultAllowed[k.trim()] !== false);
    });

    const container = document.getElementById('featureToggles');
    if (visibleFeatures.length === 0) {
        container.innerHTML = '<p style="text-align:center;color:#94A3B8;font-size:13px;">目前無可管理的功能，請聯繫平台管理員開通。</p>';
        return;
    }

    container.innerHTML = visibleFeatures.map(f => {
        const keys = f.key.split(',');
        const on = keys.some(k => featureState[k.trim()] !== false);
        const cardId = f.key.replace(',', '_');
        return `
        <div class="feature-toggle-card" id="ftCard_${cardId}" onclick="toggleFeature('${f.key}')"
             style="display:flex;align-items:center;gap:14px;padding:16px;background:${on ? '#F5F3FF' : '#F8FAFC'};border:2px solid ${on ? '#4F46E5' : '#E5E7EB'};border-radius:14px;cursor:pointer;transition:all 0.2s;">
            <div class="ft-indicator" style="width:26px;height:26px;border:2px solid ${on ? '#4F46E5' : '#CBD5E1'};border-radius:7px;display:flex;align-items:center;justify-content:center;flex-shrink:0;background:${on ? '#4F46E5' : '#fff'};color:#fff;font-size:16px;transition:all 0.2s;">${on ? '✓' : ''}</div>
            <span style="font-size:28px;">${f.icon}</span>
            <div style="flex:1;">
                <div style="font-weight:800;font-size:14px;color:#0F172A;">${f.label}</div>
                <div style="font-size:12px;color:#94A3B8;margin-top:2px;">${f.desc}</div>
            </div>
        </div>`;
    }).join('');
}

export function updateToggleCard(key) {
    const cardId = key.replace(',', '_');
    const card = document.getElementById('ftCard_' + cardId);
    if (!card) return;
    const keys = key.split(',');
    const on = keys.some(k => featureState[k.trim()] !== false);
    const box = card.querySelector('.ft-indicator');

    if (on) {
        card.style.borderColor = '#4F46E5';
        card.style.background = '#F5F3FF';
        box.style.borderColor = '#4F46E5';
        box.style.background = '#4F46E5';
        box.textContent = '✓';
    } else {
        card.style.borderColor = '#E5E7EB';
        card.style.background = '#F8FAFC';
        box.style.borderColor = '#CBD5E1';
        box.style.background = '#fff';
        box.textContent = '';
    }
}

export async function toggleFeature(key) {
    const keys = key.split(',');
    const currentlyOn = keys.some(k => featureState[k.trim()] !== false);
    keys.forEach(k => { featureState[k.trim()] = !currentlyOn; });
    updateToggleCard(key);

    try {
        const { data: existing } = await sb.from('system_settings')
            .select('id')
            .eq('key', 'feature_visibility')
            .maybeSingle();

        if (existing) {
            await sb.from('system_settings')
                .update({ value: featureState, updated_at: new Date().toISOString() })
                .eq('key', 'feature_visibility');
        } else {
            await sb.from('system_settings')
                .insert({ key: 'feature_visibility', value: featureState, description: '員工可見功能設定' });
        }

        invalidateSettingsCache();

        const el = document.getElementById('featureSaveStatus');
        el.style.display = 'block';
        el.textContent = featureState[key] ? '✅ 已開啟' : '⛔ 已關閉';
        el.style.color = featureState[key] ? '#059669' : '#DC2626';
        setTimeout(() => el.style.display = 'none', 1500);
    } catch(e) {
        console.error('儲存失敗', e);
        showToast('❌ 儲存失敗');
    }
}

// ===== 公告管理 =====
export function toggleAnnCheck(id) {
    const cb = document.getElementById(id);
    if (!cb) return;
    cb.checked = !cb.checked;
    const card = document.getElementById(id + 'Card');
    const box = document.getElementById(id + 'Box');
    if (cb.checked) {
        card.style.borderColor = '#4F46E5';
        card.style.background = '#F5F3FF';
        box.style.background = '#4F46E5';
        box.style.borderColor = '#4F46E5';
        box.innerHTML = '✓';
    } else {
        card.style.borderColor = '#E5E7EB';
        card.style.background = '#F8FAFC';
        box.style.background = '#fff';
        box.style.borderColor = '#CBD5E1';
        box.innerHTML = '';
    }
}

export async function publishAnnouncement() {
    const title = document.getElementById('annTitle')?.value;
    const content = document.getElementById('annContent')?.value;
    const type = document.getElementById('annType')?.value;
    const expire = document.getElementById('annExpire')?.value;
    const pinned = document.getElementById('annPinned')?.checked;
    const requireAck = document.getElementById('annRequireAck')?.checked;

    if (!title) return showToast('❌ 請輸入標題');

    try {
        const { data: existing } = await sb.from('system_settings')
            .select('value').eq('key', 'announcements').maybeSingle();

        const items = existing?.value?.items || [];
        items.unshift({
            id: Date.now().toString(),
            title, content, type, pinned,
            require_ack: requireAck || false,
            expire_date: expire || null,
            created_at: new Date().toISOString(),
            created_by: window.currentAdminEmployee?.name || 'admin'
        });

        if (existing) {
            await sb.from('system_settings').update({ value: { items }, updated_at: new Date().toISOString() }).eq('key', 'announcements');
        } else {
            await sb.from('system_settings').insert({ key: 'announcements', value: { items }, description: '公告系統' });
        }

        showToast('📢 公告已發布');
        document.getElementById('annTitle').value = '';
        document.getElementById('annContent').value = '';
        document.getElementById('annExpire').value = '';
        document.getElementById('annPinned').checked = false;
        if (document.getElementById('annRequireAck')) document.getElementById('annRequireAck').checked = false;
        loadAnnouncementList();
    } catch(e) { showToast('❌ 發布失敗：' + friendlyError(e)); }
}

export async function loadAnnouncementList() {
    const el = document.getElementById('announcementList');
    if (!el) return;

    try {
        const { data } = await sb.from('system_settings')
            .select('value').eq('key', 'announcements').maybeSingle();

        const items = data?.value?.items || [];
        if (items.length === 0) { el.innerHTML = '<p style="text-align:center;color:#999;">尚無公告</p>'; return; }

        const typeIcon = { info:'📢', warning:'⚠️', urgent:'🚨', event:'🎉' };
        const typeColor = { info:'#2563EB', warning:'#EA580C', urgent:'#DC2626', event:'#7C3AED' };
        const typeBg = { info:'#EFF6FF', warning:'#FFF7ED', urgent:'#FEF2F2', event:'#F5F3FF' };

        el.innerHTML = items.map(a => `
            <div style="background:${typeBg[a.type] || '#F1F5F9'};border-radius:12px;padding:14px;margin-bottom:10px;">
                <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;">
                    <span style="font-weight:800;color:${typeColor[a.type] || '#64748B'};">${typeIcon[a.type] || '📌'} ${a.title}</span>
                    <button onclick="deleteAnnouncement('${a.id}')" style="background:none;border:none;font-size:14px;cursor:pointer;padding:4px;">🗑️</button>
                </div>
                ${a.content ? `<div style="font-size:12px;color:#64748B;margin-bottom:4px;">${a.content}</div>` : ''}
                <div style="font-size:10px;color:#94A3B8;">
                    ${a.pinned ? '📌 置頂 · ' : ''}
                    ${a.expire_date ? '到期：' + a.expire_date + ' · ' : '永久 · '}
                    ${a.created_by || ''} · ${a.created_at ? new Date(a.created_at).toLocaleDateString() : ''}
                </div>
            </div>
        `).join('');
    } catch(e) { el.innerHTML = '<p style="text-align:center;color:#ef4444;">載入失敗</p>'; }
}

export async function deleteAnnouncement(id) {
    if (!confirm('確定刪除此公告？')) return;
    try {
        const { data } = await sb.from('system_settings')
            .select('value').eq('key', 'announcements').maybeSingle();
        if (!data?.value?.items) return;

        const items = data.value.items.filter(a => a.id !== id);
        await sb.from('system_settings').update({ value: { items }, updated_at: new Date().toISOString() }).eq('key', 'announcements');
        showToast('🗑️ 已刪除');
        loadAnnouncementList();
    } catch(e) { showToast('❌ 刪除失敗'); }
}

// ===== 客戶管理 =====
let adminClients = [];

export async function loadClientList() {
    try {
        const { data } = await sb.from('clients').select('*').order('company_name');
        adminClients = data || [];
        renderClientList(adminClients);
    } catch(e) { console.error('載入客戶失敗', e); }
}

export function filterClients() {
    const q = (document.getElementById('clientSearch')?.value || '').toLowerCase();
    const filtered = q ? adminClients.filter(c => c.company_name.toLowerCase().includes(q)) : adminClients;
    renderClientList(filtered);
}

function renderClientList(list) {
    const el = document.getElementById('clientList');
    if (!el) return;
    if (list.length === 0) {
        el.innerHTML = '<p style="text-align:center;color:#94A3B8;font-size:13px;padding:16px;">無客戶資料</p>';
        return;
    }
    el.innerHTML = list.map(c => {
        const catBadge = c.category === 'vip'
            ? '<span style="background:#FEF3C7;color:#92400E;padding:2px 8px;border-radius:6px;font-size:10px;font-weight:700;">VIP ⭐</span>'
            : '<span style="background:#F1F5F9;color:#64748B;padding:2px 8px;border-radius:6px;font-size:10px;font-weight:700;">一般</span>';
        return `<div style="background:#fff;border:1px solid #E2E8F0;border-radius:12px;padding:14px;margin-bottom:8px;">
            <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;">
                <span style="font-weight:700;font-size:14px;">${escapeHTML(c.company_name)}</span>
                ${catBadge}
            </div>
            <div style="font-size:12px;color:#64748B;">
                ${c.contact_name ? '👤 ' + escapeHTML(c.contact_name) + ' ' : ''}
                ${c.phone ? '📞 ' + escapeHTML(c.phone) : ''}
                ${c.industry ? ' · ' + escapeHTML(c.industry) : ''}
            </div>
            ${c.address ? '<div style="font-size:11px;color:#94A3B8;margin-top:4px;">📍 ' + escapeHTML(c.address) + '</div>' : ''}
            <div style="display:flex;gap:6px;margin-top:8px;">
                <button class="btn btn-secondary" onclick="editClient('${c.id}')" style="font-size:11px;padding:6px 12px;">編輯</button>
                <button class="btn btn-secondary" onclick="toggleClientActive('${c.id}',${c.is_active})" style="font-size:11px;padding:6px 12px;color:${c.is_active ? '#EF4444' : '#059669'};">${c.is_active ? '停用' : '啟用'}</button>
            </div>
        </div>`;
    }).join('');
}

export function showClientModal(id) {
    document.getElementById('clientModal').style.display = 'block';
    document.getElementById('clientEditId').value = id || '';
    document.getElementById('clientModalTitle').textContent = id ? '編輯客戶' : '新增客戶';
    if (!id) {
        ['clientCompanyName','clientContactName','clientPhone','clientAddress','clientLat','clientLng','clientIndustry','clientNotes'].forEach(f => {
            const el = document.getElementById(f); if (el) el.value = '';
        });
        document.getElementById('clientCategory').value = 'general';
    }
}

export function closeClientModal() {
    document.getElementById('clientModal').style.display = 'none';
}

export function editClient(id) {
    const c = adminClients.find(x => x.id === id);
    if (!c) return;
    showClientModal(id);
    document.getElementById('clientCompanyName').value = c.company_name || '';
    document.getElementById('clientContactName').value = c.contact_name || '';
    document.getElementById('clientPhone').value = c.phone || '';
    document.getElementById('clientAddress').value = c.address || '';
    document.getElementById('clientLat').value = c.latitude || '';
    document.getElementById('clientLng').value = c.longitude || '';
    document.getElementById('clientCategory').value = c.category || 'general';
    document.getElementById('clientIndustry').value = c.industry || '';
    document.getElementById('clientNotes').value = c.notes || '';
}

export async function getClientGPS() {
    try {
        showToast('📍 定位中...');
        const loc = await getGPS();
        document.getElementById('clientLat').value = loc.latitude.toFixed(6);
        document.getElementById('clientLng').value = loc.longitude.toFixed(6);
        showToast('✅ 座標已取得');
    } catch(e) { showToast('❌ 定位失敗：' + friendlyError(e)); }
}

export async function saveClient() {
    const name = document.getElementById('clientCompanyName').value.trim();
    if (!name) return showToast('請輸入公司名稱');
    const id = document.getElementById('clientEditId').value;
    const record = {
        company_name: name,
        contact_name: document.getElementById('clientContactName').value.trim(),
        phone: document.getElementById('clientPhone').value.trim(),
        address: document.getElementById('clientAddress').value.trim(),
        latitude: parseFloat(document.getElementById('clientLat').value) || null,
        longitude: parseFloat(document.getElementById('clientLng').value) || null,
        category: document.getElementById('clientCategory').value,
        industry: document.getElementById('clientIndustry').value.trim(),
        notes: document.getElementById('clientNotes').value.trim(),
        updated_at: new Date().toISOString()
    };
    try {
        if (id) {
            const { error } = await sb.from('clients').update(record).eq('id', id);
            if (error) throw error;
            writeAuditLog('update_client','clients',id,name);
            showToast('✅ 客戶已更新');
        } else {
            const { error } = await sb.from('clients').insert(record);
            if (error) throw error;
            writeAuditLog('create_client','clients',null,name);
            showToast('✅ 客戶已新增');
        }
        closeClientModal();
        loadClientList();
    } catch(e) { showToast('❌ 儲存失敗：' + friendlyError(e)); }
}

export async function toggleClientActive(id, isActive) {
    const action = isActive ? '停用' : '啟用';
    if (!confirm(`確定${action}此客戶？`)) return;
    try {
        const { error } = await sb.from('clients').update({ is_active: !isActive, updated_at: new Date().toISOString() }).eq('id', id);
        if (error) throw error;
        showToast(`✅ 已${action}`);
        loadClientList();
    } catch(e) { showToast('❌ 操作失敗：' + friendlyError(e)); }
}

// ===== 服務項目管理 =====
export async function loadServiceItemList() {
    try {
        const { data } = await sb.from('service_items').select('*').order('name');
        const el = document.getElementById('serviceItemList');
        if (!el) return;
        if (!data || data.length === 0) {
            el.innerHTML = '<p style="color:#94A3B8;font-size:12px;">尚無服務項目</p>';
            return;
        }
        el.innerHTML = data.map(s =>
            `<div style="display:flex;align-items:center;gap:8px;padding:8px 0;border-bottom:1px solid #F1F5F9;">
                <span style="flex:1;font-size:13px;font-weight:600;">${escapeHTML(s.name)}</span>
                <span style="font-size:11px;color:#94A3B8;">${escapeHTML(s.code || '')}</span>
                <button onclick="deleteServiceItem('${s.id}','${escapeHTML(s.name)}')" style="background:none;border:none;color:#EF4444;font-size:12px;cursor:pointer;">刪除</button>
            </div>`
        ).join('');
    } catch(e) { console.error(e); }
}

export async function addServiceItem() {
    const name = document.getElementById('newServiceItemName')?.value.trim();
    if (!name) return showToast('請輸入服務項目名稱');
    try {
        const { error } = await sb.from('service_items').insert({ name, code: name.substring(0, 10).toUpperCase() });
        if (error) throw error;
        document.getElementById('newServiceItemName').value = '';
        showToast('✅ 已新增');
        loadServiceItemList();
    } catch(e) { showToast('❌ 新增失敗：' + friendlyError(e)); }
}

export async function deleteServiceItem(id, name) {
    if (!confirm(`確定刪除「${name}」？`)) return;
    try {
        const { error } = await sb.from('service_items').update({ is_active: false }).eq('id', id);
        if (error) throw error;
        showToast('✅ 已刪除');
        loadServiceItemList();
    } catch(e) { showToast('❌ 刪除失敗：' + friendlyError(e)); }
}

// ===== 外勤審核 =====
let fwaLogs = [];

export function initFieldWorkApproval() {
    const today = getTaiwanDate();
    document.getElementById('fwaDateFrom').value = today;
    document.getElementById('fwaDateTo').value = today;
    loadFieldWorkApprovals();
}

export async function loadFieldWorkApprovals() {
    const from = document.getElementById('fwaDateFrom').value;
    const to = document.getElementById('fwaDateTo').value;
    const status = document.getElementById('fwaStatusFilter').value;
    if (!from || !to) return showToast('請選擇日期');

    try {
        let query = sb.from('field_work_logs')
            .select('*, employees(name, employee_number), clients(company_name), service_items(name)')
            .gte('work_date', from)
            .lte('work_date', to)
            .order('work_date', { ascending: false })
            .order('arrive_time', { ascending: false });
        if (status) query = query.eq('status', status);

        const { data, error } = await query;
        if (error) throw error;
        fwaLogs = data || [];

        document.getElementById('fwaTotal').textContent = fwaLogs.length;
        document.getElementById('fwaPending').textContent = fwaLogs.filter(l => l.status === 'submitted').length;
        const totalH = fwaLogs.reduce((s, l) => s + (l.work_hours || 0), 0);
        document.getElementById('fwaTotalHours').textContent = totalH.toFixed(1);

        renderFieldWorkApprovals();
    } catch(e) {
        console.error(e);
        showToast('❌ 查詢失敗：' + friendlyError(e));
    }
}

function renderFieldWorkApprovals() {
    const el = document.getElementById('fwaList');
    if (!el) return;
    if (fwaLogs.length === 0) {
        el.innerHTML = '<p style="text-align:center;color:#94A3B8;font-size:13px;padding:16px;">無符合條件的紀錄</p>';
        return;
    }
    el.innerHTML = fwaLogs.map(log => {
        const statusMap = { draft:'🟡 草稿', submitted:'🔵 待審核', approved:'🟢 已核准', rejected:'🔴 已退回' };
        const statusLabel = statusMap[log.status] || log.status;
        const empName = log.employees?.name || '?';
        const clientName = log.clients?.company_name || '-';
        const serviceName = log.service_items?.name || '';
        const arriveT = log.arrive_time ? new Date(log.arrive_time).toLocaleTimeString('zh-TW', { hour:'2-digit', minute:'2-digit' }) : '--:--';
        const leaveT = log.leave_time ? new Date(log.leave_time).toLocaleTimeString('zh-TW', { hour:'2-digit', minute:'2-digit' }) : '--:--';
        const hours = log.work_hours ? log.work_hours.toFixed(1) + 'h' : '';

        return `<div style="background:#fff;border:1px solid #E2E8F0;border-radius:12px;padding:14px;margin-bottom:8px;cursor:pointer;" onclick="showFwaDetail('${log.id}')">
            <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px;">
                <span style="font-weight:700;font-size:13px;">${escapeHTML(empName)}</span>
                <span style="font-size:12px;">${statusLabel}</span>
            </div>
            <div style="font-size:12px;color:#475569;margin-bottom:2px;">
                🏢 ${escapeHTML(clientName)}
                ${serviceName ? ' · ' + escapeHTML(serviceName) : ''}
            </div>
            <div style="font-size:11px;color:#94A3B8;">
                ${log.work_date} ${arriveT} → ${leaveT} ${hours ? '(' + hours + ')' : ''}
                ${log.mileage ? ' · ' + log.mileage + 'km' : ''}
            </div>
        </div>`;
    }).join('');
}

export function showFwaDetail(logId) {
    const log = fwaLogs.find(l => l.id === logId);
    if (!log) return;
    const modal = document.getElementById('fwaDetailModal');
    const content = document.getElementById('fwaDetailContent');
    const actions = document.getElementById('fwaDetailActions');

    const empName = log.employees?.name || '?';
    const empNo = log.employees?.employee_number || '';
    const clientName = log.clients?.company_name || '-';
    const serviceName = log.service_items?.name || '-';
    const arriveT = log.arrive_time ? new Date(log.arrive_time).toLocaleString('zh-TW') : '-';
    const leaveT = log.leave_time ? new Date(log.leave_time).toLocaleString('zh-TW') : '-';

    let photosHtml = '';
    if (log.photo_urls && log.photo_urls.length > 0) {
        photosHtml = '<div style="margin-top:8px;"><b style="font-size:12px;">照片：</b><div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:4px;">' +
            log.photo_urls.map(url => `<img src="${url}" style="width:100px;height:100px;object-fit:cover;border-radius:8px;border:1px solid #E2E8F0;cursor:pointer;" onclick="window.open('${url}','_blank')">`).join('') +
            '</div></div>';
    }

    let signatureHtml = '';
    if (log.signature_url) {
        signatureHtml = `<div style="margin-top:8px;"><b style="font-size:12px;">客戶簽名：</b><br><img src="${log.signature_url}" style="max-width:200px;border:1px solid #E2E8F0;border-radius:8px;margin-top:4px;"></div>`;
    }

    content.innerHTML = `
        <h3 style="margin-bottom:12px;">外勤明細</h3>
        <div style="font-size:13px;line-height:2;">
            <div><b>員工：</b>${escapeHTML(empName)} (${escapeHTML(empNo)})</div>
            <div><b>客戶：</b>${escapeHTML(clientName)}</div>
            <div><b>服務項目：</b>${escapeHTML(serviceName)}</div>
            <div><b>日期：</b>${log.work_date}</div>
            <div><b>到達：</b>${arriveT}</div>
            <div><b>離開：</b>${leaveT}</div>
            <div><b>工時：</b>${log.work_hours ? log.work_hours.toFixed(1) + ' 小時' : '-'}</div>
            <div><b>里程：</b>${log.mileage || 0} km</div>
            ${log.arrive_lat ? `<div><b>到達GPS：</b>${log.arrive_lat.toFixed(5)}, ${log.arrive_lng.toFixed(5)}</div>` : ''}
            ${log.leave_lat ? `<div><b>離開GPS：</b>${log.leave_lat.toFixed(5)}, ${log.leave_lng.toFixed(5)}</div>` : ''}
            ${log.work_content ? `<div style="margin-top:6px;"><b>工作內容：</b><div style="background:#F8FAFC;padding:8px;border-radius:8px;margin-top:4px;white-space:pre-wrap;">${escapeHTML(log.work_content)}</div></div>` : ''}
            ${log.notes ? `<div><b>備註：</b>${escapeHTML(log.notes)}</div>` : ''}
        </div>
        ${photosHtml}
        ${signatureHtml}
    `;

    if (log.status === 'submitted') {
        actions.innerHTML = `
            <button class="btn btn-success" onclick="approveFieldWork('${log.id}')" style="flex:1;font-size:14px;padding:12px;">✅ 核准</button>
            <button class="btn btn-secondary" onclick="rejectFieldWork('${log.id}')" style="flex:1;font-size:14px;padding:12px;color:#EF4444;">❌ 退回</button>
        `;
    } else {
        actions.innerHTML = '';
    }

    modal.style.display = 'block';
}

export function closeFwaDetailModal() {
    document.getElementById('fwaDetailModal').style.display = 'none';
}

export async function approveFieldWork(logId) {
    if (!confirm('確定核准此筆外勤紀錄？')) return;
    try {
        const { error } = await sb.from('field_work_logs').update({
            status: 'approved',
            updated_at: new Date().toISOString()
        }).eq('id', logId);
        if (error) throw error;
        writeAuditLog('approve_field_work','field_work_logs',logId,'核准');
        showToast('✅ 已核准');
        closeFwaDetailModal();
        loadFieldWorkApprovals();
    } catch(e) { showToast('❌ 操作失敗：' + friendlyError(e)); }
}

export async function rejectFieldWork(logId) {
    const reason = prompt('退回原因（選填）：');
    if (reason === null) return;
    try {
        const { error } = await sb.from('field_work_logs').update({
            status: 'rejected',
            notes: reason || '退回',
            updated_at: new Date().toISOString()
        }).eq('id', logId);
        if (error) throw error;
        writeAuditLog('reject_field_work','field_work_logs',logId,'退回');
        showToast('✅ 已退回');
        closeFwaDetailModal();
        loadFieldWorkApprovals();
    } catch(e) { showToast('❌ 操作失敗：' + friendlyError(e)); }
}

export function exportFieldWorkCSV() {
    if (fwaLogs.length === 0) return showToast('無資料可匯出');
    const rows = [['日期','工號','姓名','客戶','服務項目','到達時間','離開時間','工時','里程(km)','工作內容','狀態','備註']];
    fwaLogs.forEach(l => {
        rows.push([
            l.work_date,
            l.employees?.employee_number || '',
            l.employees?.name || '',
            l.clients?.company_name || '',
            l.service_items?.name || '',
            l.arrive_time ? new Date(l.arrive_time).toLocaleString('zh-TW') : '',
            l.leave_time ? new Date(l.leave_time).toLocaleString('zh-TW') : '',
            l.work_hours || 0,
            l.mileage || 0,
            l.work_content || '',
            l.status,
            l.notes || ''
        ]);
    });
    const csv = '\uFEFF' + rows.map(r => r.map(c => `"${String(c??'').replace(/"/g,'""')}"`).join(',')).join('\n');
    const a = document.createElement('a');
    const from = document.getElementById('fwaDateFrom').value;
    const to = document.getElementById('fwaDateTo').value;
    const fn = `外勤紀錄_${from}_${to}.csv`;
    a.href = URL.createObjectURL(new Blob([csv],{type:'text/csv;charset=utf-8;'}));
    a.download = fn; a.click();
    writeAuditLog('export','field_work_logs',null,fn,{rows:rows.length-1});
    showToast(`✅ 已匯出 ${fn}（${rows.length-1} 筆）`);
}

// ===== 公司管理 =====
let allCompanies = [];

export async function loadCompanyList() {
    try {
        const { data, error } = await sb.from('companies').select('*').order('created_at', { ascending: false });
        if (error) throw error;
        allCompanies = data || [];

        const { data: empCounts } = await sb.from('employees')
            .select('company_id').eq('is_active', true);
        const countMap = {};
        (empCounts || []).forEach(e => {
            countMap[e.company_id] = (countMap[e.company_id] || 0) + 1;
        });
        allCompanies.forEach(c => { c._empCount = countMap[c.id] || 0; });

        renderCompanyList(allCompanies);
    } catch(e) { showToast('❌ 載入公司列表失敗'); console.error(e); }
}

export function filterCompanies() {
    const q = (document.getElementById('companySearch').value || '').toLowerCase();
    const filtered = allCompanies.filter(c =>
        c.name.toLowerCase().includes(q) || (c.code || '').toLowerCase().includes(q)
    );
    renderCompanyList(filtered);
}

function renderCompanyList(list) {
    const el = document.getElementById('companyList');
    if (list.length === 0) {
        el.innerHTML = '<p style="text-align:center;color:#94A3B8;font-size:13px;padding:16px;">無公司資料</p>';
        return;
    }
    el.innerHTML = list.map(c => `
        <div style="background:#fff;border-radius:12px;padding:14px;margin-bottom:10px;box-shadow:0 1px 4px rgba(0,0,0,0.06);display:flex;justify-content:space-between;align-items:center;">
            <div>
                <div style="font-weight:700;font-size:15px;color:#0F172A;">${escapeHTML(c.name)}</div>
                <div style="font-size:12px;color:#64748B;margin-top:2px;">代碼：${escapeHTML(c.code)} ｜ 員工：${c._empCount} 人</div>
            </div>
            <div style="display:flex;gap:8px;align-items:center;">
                <span style="font-size:11px;padding:2px 8px;border-radius:20px;background:${c.is_active?'#D1FAE5':'#FEE2E2'};color:${c.is_active?'#065F46':'#991B1B'};">${c.is_active?'啟用':'停用'}</span>
                <span onclick="editCompany('${c.id}')" style="cursor:pointer;">✏️</span>
            </div>
        </div>
    `).join('');
}

export function showCompanyModal(editData) {
    document.getElementById('companyEditId').value = editData ? editData.id : '';
    document.getElementById('companyModalTitle').textContent = editData ? '編輯公司' : '新增公司';
    document.getElementById('companyCode').value = editData ? editData.code : '';
    document.getElementById('companyName').value = editData ? editData.name : '';
    document.getElementById('companyIsActive').value = editData ? String(editData.is_active) : 'true';
    document.getElementById('companyModal').style.display = 'block';
}

export function closeCompanyModal() { document.getElementById('companyModal').style.display = 'none'; }

export function editCompany(id) {
    const c = allCompanies.find(x => x.id === id);
    if (c) showCompanyModal(c);
}

export async function saveCompany() {
    const id = document.getElementById('companyEditId').value;
    const code = document.getElementById('companyCode').value.trim().toUpperCase();
    const name = document.getElementById('companyName').value.trim();
    const isActive = document.getElementById('companyIsActive').value === 'true';

    if (!code || !name) { showToast('⚠️ 請填寫代碼和名稱'); return; }

    const row = { code, name, is_active: isActive };

    try {
        if (id) {
            const { error } = await sb.from('companies').update(row).eq('id', id);
            if (error) throw error;
            writeAuditLog('update', 'companies', id, name);
        } else {
            const { error } = await sb.from('companies').insert(row);
            if (error) throw error;
            writeAuditLog('create', 'companies', null, `${name} (${code})`);
        }
        closeCompanyModal();
        showToast('✅ 已儲存');
        loadCompanyList();
    } catch(e) {
        if (String(e).includes('unique') || String(e?.message||'').includes('unique')) {
            showToast('⚠️ 公司代碼已存在');
        } else {
            showToast('❌ 儲存失敗'); console.error(e);
        }
    }
}

// ===== 業務目標管理 =====
let stWeekStart = null;
let stEmployees = [];

function stGetMonday(d) {
    const date = new Date(d);
    const day = date.getDay();
    const diff = date.getDate() - day + (day === 0 ? -6 : 1);
    date.setDate(diff);
    date.setHours(0, 0, 0, 0);
    return date;
}

function stGetSunday(monday) {
    const sun = new Date(monday);
    sun.setDate(sun.getDate() + 6);
    return sun;
}

export async function initSalesTargetPage() {
    stWeekStart = stGetMonday(new Date());
    await loadSalesTargetData();
}

export function stChangeWeek(offset) {
    stWeekStart.setDate(stWeekStart.getDate() + offset * 7);
    loadSalesTargetData();
}

async function loadSalesTargetData() {
    const monday = fmtDate(stWeekStart);
    const sunday = fmtDate(stGetSunday(stWeekStart));

    document.getElementById('stWeekLabel').textContent =
        `${monday.substring(5).replace('-','/')} ~ ${sunday.substring(5).replace('-','/')}`;

    try {
        const { data: defaultTarget } = await sb.from('sales_targets')
            .select('*')
            .is('employee_id', null)
            .eq('week_start', monday)
            .maybeSingle();

        document.getElementById('stDefaultCall').value = defaultTarget?.call_target || 0;
        document.getElementById('stDefaultVisit').value = defaultTarget?.visit_target || 0;

        let empQuery = sb.from('employees').select('id, name, employee_number, role, position').eq('is_active', true).eq('position', '業務');
        if (window.currentCompanyId) empQuery = empQuery.eq('company_id', window.currentCompanyId);
        const { data: employees } = await empQuery.order('name');
        stEmployees = employees || [];

        const { data: targets } = await sb.from('sales_targets')
            .select('*')
            .eq('week_start', monday)
            .not('employee_id', 'is', null);
        const targetMap = {};
        (targets || []).forEach(t => { targetMap[t.employee_id] = t; });

        const { data: activities } = await sb.from('sales_activities')
            .select('employee_id, activity_type')
            .gte('activity_date', monday)
            .lte('activity_date', sunday);

        const activityCount = {};
        (activities || []).forEach(a => {
            if (!activityCount[a.employee_id]) activityCount[a.employee_id] = { call: 0, visit: 0 };
            if (a.activity_type === 'call') activityCount[a.employee_id].call++;
            if (a.activity_type === 'visit') activityCount[a.employee_id].visit++;
        });

        renderSalesTargetProgress(targetMap, activityCount, defaultTarget);
    } catch(e) {
        console.error('載入業務目標失敗', e);
        document.getElementById('stProgressList').innerHTML = '<p style="color:#ef4444;text-align:center;">載入失敗</p>';
    }
}

function renderSalesTargetProgress(targetMap, activityCount, defaultTarget) {
    const el = document.getElementById('stProgressList');
    if (stEmployees.length === 0) {
        el.innerHTML = '<p style="text-align:center;color:#94A3B8;font-size:13px;">尚無員工資料</p>';
        return;
    }

    const defCall = defaultTarget?.call_target || 0;
    const defVisit = defaultTarget?.visit_target || 0;

    el.innerHTML = stEmployees.map(emp => {
        const t = targetMap[emp.id];
        const callTarget = t ? t.call_target : defCall;
        const visitTarget = t ? t.visit_target : defVisit;
        const done = activityCount[emp.id] || { call: 0, visit: 0 };
        const callPct = callTarget > 0 ? Math.min(100, Math.round(done.call / callTarget * 100)) : 0;
        const visitPct = visitTarget > 0 ? Math.min(100, Math.round(done.visit / visitTarget * 100)) : 0;

        return `<div style="background:#fff;border:1px solid #E2E8F0;border-radius:12px;padding:14px;margin-bottom:8px;">
            <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;">
                <span style="font-weight:700;font-size:14px;">${escapeHTML(emp.name)}</span>
                <span style="font-size:11px;color:#94A3B8;">${escapeHTML(emp.employee_number || '')}</span>
            </div>
            <div style="display:flex;gap:12px;">
                <div style="flex:1;">
                    <div style="display:flex;justify-content:space-between;font-size:12px;margin-bottom:2px;">
                        <span>📞 電話</span>
                        <span style="font-weight:700;">${done.call}/${callTarget}</span>
                    </div>
                    <div style="width:100%;height:6px;background:#E2E8F0;border-radius:3px;overflow:hidden;">
                        <div style="height:100%;background:${callPct >= 100 ? '#059669' : '#4F46E5'};width:${callPct}%;border-radius:3px;"></div>
                    </div>
                </div>
                <div style="flex:1;">
                    <div style="display:flex;justify-content:space-between;font-size:12px;margin-bottom:2px;">
                        <span>🏢 拜訪</span>
                        <span style="font-weight:700;">${done.visit}/${visitTarget}</span>
                    </div>
                    <div style="width:100%;height:6px;background:#E2E8F0;border-radius:3px;overflow:hidden;">
                        <div style="height:100%;background:${visitPct >= 100 ? '#059669' : '#10B981'};width:${visitPct}%;border-radius:3px;"></div>
                    </div>
                </div>
            </div>
        </div>`;
    }).join('');
}

export async function saveDefaultTarget() {
    const callTarget = parseInt(document.getElementById('stDefaultCall').value) || 0;
    const visitTarget = parseInt(document.getElementById('stDefaultVisit').value) || 0;
    const weekStart = fmtDate(stWeekStart);

    try {
        const record = {
            employee_id: null,
            week_start: weekStart,
            call_target: callTarget,
            visit_target: visitTarget,
            created_by: window.currentAdminEmployee?.id || null
        };
        if (window.currentCompanyId) record.company_id = window.currentCompanyId;

        const { data: existing } = await sb.from('sales_targets')
            .select('id')
            .is('employee_id', null)
            .eq('week_start', weekStart)
            .maybeSingle();

        if (existing) {
            await sb.from('sales_targets').update({
                call_target: callTarget,
                visit_target: visitTarget
            }).eq('id', existing.id);
        } else {
            await sb.from('sales_targets').insert(record);
        }

        showToast('✅ 預設目標已儲存');
        await loadSalesTargetData();
    } catch(e) {
        console.error(e);
        showToast('❌ 儲存失敗：' + friendlyError(e));
    }
}
