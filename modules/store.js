// ============================================================
// modules/store.js — 餐飲業管理（商店、菜單、訂單）
// 依賴 common.js 全域: sb, showToast, escapeHTML, fmtDate, CONFIG
// ============================================================

// ===== 模組狀態 =====
let smStores = [];
let smCurrentStoreId = null;
let rdCurrentStoreId = null;
let smCategories = [];
let smItems = [];
let rdOrders = [];
let miOptionGroups = [];
let miComboGroups = [];
let miIsComboOn = false;
let miPreviewMode = false;

// ===== 商店列表 =====
export async function loadRestaurantList() {
    try {
        let q = sb.from('store_profiles').select('*').order('created_at', { ascending: false });
        if (window.currentCompanyId) q = q.eq('company_id', window.currentCompanyId);
        const { data } = await q;
        smStores = data || [];
        const today = fmtDate(new Date());
        const { data: todayOrders } = await sb.from('orders').select('store_id, status, total').gte('created_at', today + 'T00:00:00');
        const stats = {};
        (todayOrders || []).forEach(o => {
            if (!stats[o.store_id]) stats[o.store_id] = { total: 0, pending: 0, revenue: 0 };
            stats[o.store_id].total++;
            if (o.status === 'pending') stats[o.store_id].pending++;
            if (o.status !== 'cancelled') stats[o.store_id].revenue += parseFloat(o.total) || 0;
        });
        renderRestaurantList(stats);
    } catch(e) { console.error(e); }
}

function renderRestaurantList(stats) {
    const el = document.getElementById('restaurantStoreList');
    if (smStores.length === 0) {
        el.innerHTML = '<p style="text-align:center;color:#94A3B8;font-size:13px;padding:16px;">尚無商店，請點「+ 新增商店」建立</p>';
        return;
    }
    el.innerHTML = smStores.map(s => {
        const st = stats[s.id] || { total: 0, pending: 0, revenue: 0 };
        return `<div onclick="openRestaurantDetail('${s.id}')" style="background:#fff;border:1px solid #E2E8F0;border-radius:12px;padding:14px;margin-bottom:8px;cursor:pointer;">
            <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;">
                <span style="font-weight:700;font-size:15px;">${escapeHTML(s.store_name)}</span>
                <span style="font-size:11px;padding:2px 10px;border-radius:10px;background:${s.is_active !== false ? '#D1FAE5' : '#F1F5F9'};color:${s.is_active !== false ? '#059669' : '#94A3B8'};font-weight:600;">${s.is_active !== false ? '營業中' : '暫停'}</span>
            </div>
            <div style="display:flex;gap:12px;font-size:12px;color:#64748B;">
                <span>今日 <b style="color:#1E40AF;">${st.total}</b> 單</span>
                ${st.pending > 0 ? '<span style="color:#DC2626;font-weight:700;">待處理 ' + st.pending + '</span>' : ''}
                <span>營收 <b style="color:#059669;">$${st.revenue}</b></span>
            </div>
        </div>`;
    }).join('');
}

// ===== 商店詳情 =====
export async function openRestaurantDetail(storeId) {
    rdCurrentStoreId = storeId;
    smCurrentStoreId = storeId;
    const s = smStores.find(x => x.id === storeId);
    if (!s) return;
    document.getElementById('rdStoreName').textContent = s.store_name;
    const previewUrl = getStoreOrderUrl(s);
    document.getElementById('rdStorePreviewLink').innerHTML = `
        <div style="background:#EEF2FF;border-radius:8px;padding:8px 12px;display:flex;align-items:center;gap:8px;">
            <span style="font-size:11px;color:#4F46E5;flex:1;word-break:break-all;">${escapeHTML(previewUrl)}</span>
            <button onclick="navigator.clipboard.writeText('${previewUrl}').then(()=>showToast('✅ 已複製'))" style="padding:4px 8px;border:1px solid #C7D2FE;border-radius:6px;background:#fff;font-size:11px;cursor:pointer;white-space:nowrap;">📋 複製</button>
        </div>`;
    renderAcceptOrderToggle(s);
    switchRestaurantTab('orders', document.querySelector('.rdTab'));
    window.showPage?.('restaurantDetailPage');
}

export function previewStoreOrder() {
    const s = smStores.find(x => x.id === rdCurrentStoreId);
    if (!s) return showToast('找不到商店資料');
    window.open(getStoreOrderUrl(s), '_blank');
}

function renderAcceptOrderToggle(s) {
    const on = s.accept_orders !== false;
    document.getElementById('rdAcceptOrderToggle').innerHTML = `
        <button onclick="toggleAcceptOrders('${s.id}', ${!on})" style="width:100%;padding:10px;border:none;border-radius:10px;background:${on ? '#D1FAE5' : '#FEF2F2'};color:${on ? '#059669' : '#DC2626'};font-weight:700;font-size:13px;cursor:pointer;">
            ${on ? '🟢 開放接單中 — 點擊暫停' : '🔴 已暫停接單 — 點擊開放'}
        </button>`;
}

export async function toggleAcceptOrders(storeId, accept) {
    try {
        await sb.from('store_profiles').update({ accept_orders: accept, updated_at: new Date().toISOString() }).eq('id', storeId);
        const s = smStores.find(x => x.id === storeId);
        if (s) s.accept_orders = accept;
        renderAcceptOrderToggle(s || { accept_orders: accept });
        showToast(accept ? '🟢 已開放接單' : '🔴 已暫停接單');
    } catch(e) { showToast('❌ 操作失敗'); }
}

export function switchRestaurantTab(tab, el) {
    document.querySelectorAll('.rdTab').forEach(t => {
        t.style.borderBottom = 'none'; t.style.color = '#94A3B8'; t.classList.remove('rdTabActive');
    });
    if (el) { el.style.borderBottom = '3px solid #4F46E5'; el.style.color = '#4F46E5'; el.classList.add('rdTabActive'); }
    document.getElementById('rdOrdersTab').style.display = tab === 'orders' ? '' : 'none';
    document.getElementById('rdMenuTab').style.display = tab === 'menu' ? '' : 'none';
    document.getElementById('rdSettingsTab').style.display = tab === 'settings' ? '' : 'none';
    if (tab === 'orders') loadStoreOrders();
    if (tab === 'menu') { loadMenuCategories(); loadMenuItems(); }
    if (tab === 'settings') loadStoreSettings();
}

// ===== 訂單 Tab =====
export async function loadStoreOrders() {
    try {
        let q = sb.from('orders').select('*').eq('store_id', rdCurrentStoreId).order('created_at', { ascending: false }).limit(100);
        const statusFilter = document.getElementById('rdStatusFilter').value;
        if (statusFilter) q = q.eq('status', statusFilter);
        const { data } = await q;
        rdOrders = data || [];
        renderStoreOrderList();
        updateStoreOrderStats();
        renderTopSelling();
    } catch(e) { console.error(e); }
}

function updateStoreOrderStats() {
    const today = fmtDate(new Date());
    const todayOrders = rdOrders.filter(o => o.created_at && o.created_at.startsWith(today));
    const pending = rdOrders.filter(o => o.status === 'pending').length;
    const revenue = todayOrders.filter(o => o.status !== 'cancelled').reduce((s, o) => s + (parseFloat(o.total) || 0), 0);
    document.getElementById('rdPendingCount').textContent = pending;
    document.getElementById('rdTodayCount').textContent = todayOrders.length;
    document.getElementById('rdTodayRevenue').textContent = '$' + revenue;
}

function renderTopSelling() {
    const today = fmtDate(new Date());
    const todayOrders = rdOrders.filter(o => o.created_at && o.created_at.startsWith(today) && o.status !== 'cancelled');
    const itemCount = {};
    todayOrders.forEach(o => (o.items || []).forEach(i => {
        itemCount[i.name] = (itemCount[i.name] || 0) + (i.qty || 1);
    }));
    const sorted = Object.entries(itemCount).sort((a, b) => b[1] - a[1]).slice(0, 5);
    const el = document.getElementById('rdTopSelling');
    if (sorted.length === 0) { el.style.display = 'none'; return; }
    el.style.display = '';
    el.innerHTML = '<div style="font-weight:700;margin-bottom:4px;">🔥 今日熱銷</div>' +
        sorted.map((s, i) => `<span style="margin-right:10px;">${i+1}. ${escapeHTML(s[0])} ×${s[1]}</span>`).join('');
}

function renderStoreOrderList() {
    const el = document.getElementById('rdOrderList');
    if (rdOrders.length === 0) {
        el.innerHTML = '<p style="text-align:center;color:#94A3B8;font-size:13px;padding:16px;">尚無訂單</p>';
        return;
    }
    const statusMap = {
        pending: { label:'待處理', color:'#92400E', bg:'#FEF3C7' },
        confirmed: { label:'已確認', color:'#1E40AF', bg:'#DBEAFE' },
        preparing: { label:'準備中', color:'#7C3AED', bg:'#F5F3FF' },
        ready: { label:'可取餐', color:'#059669', bg:'#D1FAE5' },
        completed: { label:'已完成', color:'#64748B', bg:'#F1F5F9' },
        cancelled: { label:'已取消', color:'#DC2626', bg:'#FEF2F2' }
    };
    el.innerHTML = rdOrders.map(o => {
        const st = statusMap[o.status] || { label:o.status, color:'#64748B', bg:'#F1F5F9' };
        const time = o.created_at ? new Date(o.created_at).toLocaleString('zh-TW', { hour:'2-digit', minute:'2-digit' }) : '';
        const itemCount = (o.items || []).reduce((s, i) => s + (i.qty || 1), 0);
        const pickup = o.pickup_number ? '#' + String(o.pickup_number).padStart(3, '0') + ' ' : '';
        const typeLabel = { dine_in:'內用', takeout:'外帶', delivery:'外送' };
        return `<div onclick="showOrderDetail('${o.id}')" style="background:#fff;border:1px solid #E2E8F0;border-radius:12px;padding:14px;margin-bottom:8px;cursor:pointer;">
            <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px;">
                <span style="font-weight:700;font-size:14px;">${pickup}#${escapeHTML(o.order_number)}</span>
                <span style="font-size:11px;font-weight:600;padding:2px 10px;border-radius:10px;background:${st.bg};color:${st.color};">${st.label}</span>
            </div>
            <div style="font-size:12px;color:#64748B;">
                ${escapeHTML(o.customer_name || '?')}
                ${o.order_type ? ' · ' + (typeLabel[o.order_type] || o.order_type) : ''}
                ${o.table_number ? ' · 桌' + escapeHTML(o.table_number) : ''}
                ${o.pickup_time ? ' · 取餐 ' + escapeHTML(o.pickup_time) : ''}
                · ${itemCount}品 · <b>$${o.total}</b> · ${time}
            </div>
        </div>`;
    }).join('');
}

export function showOrderDetail(orderId) {
    const o = rdOrders.find(x => x.id === orderId);
    if (!o) return;
    const pickup = o.pickup_number ? ' 取餐號 #' + String(o.pickup_number).padStart(3, '0') : '';
    document.getElementById('odTitle').textContent = '#' + o.order_number + pickup;
    const typeLabel = { dine_in:'內用', takeout:'外帶', delivery:'外送' };
    const items = o.items || [];
    document.getElementById('odContent').innerHTML = `
        <div style="margin-bottom:12px;">
            <div style="font-size:13px;color:#64748B;">顧客</div>
            <div style="font-weight:600;">${escapeHTML(o.customer_name || '?')} ${o.customer_phone ? '· ' + escapeHTML(o.customer_phone) : ''}</div>
            <div style="font-size:13px;color:#64748B;">${typeLabel[o.order_type] || ''} ${o.table_number ? '· 桌號 ' + escapeHTML(o.table_number) : ''} ${o.pickup_time ? '· 取餐 ' + escapeHTML(o.pickup_time) : ''}</div>
        </div>
        <div style="border-top:1px solid #F1F5F9;padding-top:8px;">
            ${items.map(i => {
                const optStr = i.options ? '<div style="font-size:11px;color:#94A3B8;margin-left:16px;">' + escapeHTML(i.options) + '</div>' : '';
                return `<div style="padding:4px 0;font-size:14px;">
                    <div style="display:flex;justify-content:space-between;">
                        <span>${escapeHTML(i.name)} x${i.qty}</span>
                        <span style="font-weight:600;">$${i.subtotal || i.price * i.qty}</span>
                    </div>${optStr}
                </div>`;
            }).join('')}
            <div style="display:flex;justify-content:space-between;padding:8px 0;border-top:1px solid #E2E8F0;margin-top:4px;font-weight:800;">
                <span>合計</span><span>$${o.total}</span>
            </div>
        </div>
        ${o.notes ? '<div style="margin-top:8px;font-size:13px;color:#64748B;">備註：' + escapeHTML(o.notes) + '</div>' : ''}
    `;
    const actions = [];
    if (o.status === 'pending') {
        actions.push(`<button onclick="updateOrderStatus('${o.id}','confirmed')" style="flex:1;padding:10px;border:none;border-radius:10px;background:#2563EB;color:#fff;font-weight:600;cursor:pointer;">✅ 確認</button>`);
        actions.push(`<button onclick="updateOrderStatus('${o.id}','cancelled')" style="flex:1;padding:10px;border:none;border-radius:10px;background:#EF4444;color:#fff;font-weight:600;cursor:pointer;">❌ 取消</button>`);
    }
    if (o.status === 'confirmed') actions.push(`<button onclick="updateOrderStatus('${o.id}','preparing')" style="flex:1;padding:10px;border:none;border-radius:10px;background:#7C3AED;color:#fff;font-weight:600;cursor:pointer;">🍳 開始準備</button>`);
    if (o.status === 'preparing') actions.push(`<button onclick="updateOrderStatus('${o.id}','ready')" style="flex:1;padding:10px;border:none;border-radius:10px;background:#059669;color:#fff;font-weight:600;cursor:pointer;">🔔 可取餐</button>`);
    if (o.status === 'ready') actions.push(`<button onclick="updateOrderStatus('${o.id}','completed')" style="flex:1;padding:10px;border:none;border-radius:10px;background:#64748B;color:#fff;font-weight:600;cursor:pointer;">✅ 完成</button>`);
    document.getElementById('odActions').innerHTML = actions.join('');
    document.getElementById('orderDetailModal').style.display = 'flex';
}

export function closeOrderDetail() { document.getElementById('orderDetailModal').style.display = 'none'; }

export async function updateOrderStatus(orderId, newStatus) {
    try {
        await sb.from('orders').update({ status: newStatus, updated_at: new Date().toISOString() }).eq('id', orderId);
        const o = rdOrders.find(x => x.id === orderId);
        if (o?.customer_line_id) {
            const pickup = o.pickup_number ? '#' + String(o.pickup_number).padStart(3, '0') : '#' + o.order_number;
            const msgs = {
                confirmed: `✅ 您的訂單 ${pickup} 已確認，正在準備中`,
                ready: `🔔 您的餐點 ${pickup} 已完成，請取餐！`,
                cancelled: `❌ 您的訂單 ${pickup} 已取消`
            };
            if (msgs[newStatus]) {
                try { await sb.functions.invoke('send-line-notify', { body: { userId: o.customer_line_id, message: msgs[newStatus] } }); } catch(e2) { console.warn('推播失敗', e2); }
            }
        }
        showToast('✅ 狀態已更新');
        closeOrderDetail();
        await loadStoreOrders();
    } catch(e) {
        console.error(e);
        showToast('❌ 更新失敗');
    }
}

// ===== 商店基本 CRUD =====
export async function showStoreModal(storeId) {
    if (storeId) {
        let s = smStores.find(x => x.id === storeId);
        if (!s) {
            const { data } = await sb.from('store_profiles').select('*').eq('id', storeId).maybeSingle();
            if (!data) return showToast('找不到商店資料');
            s = data;
            smStores.push(s);
        }
        document.getElementById('storeModalTitle').textContent = '編輯商店';
        document.getElementById('storeEditId').value = s.id;
        document.getElementById('storeNameInput').value = s.store_name;
        document.getElementById('storeSlugInput').value = s.store_slug || '';
        document.getElementById('storeTypeSelect').value = s.store_type || 'restaurant';
        document.getElementById('storeDescInput').value = s.description || '';
        document.getElementById('storePhoneInput').value = s.phone || '';
        document.getElementById('storeAddressInput').value = s.address || '';
        document.getElementById('storeColorInput').value = s.theme_color || '#4F46E5';
    } else {
        document.getElementById('storeModalTitle').textContent = '新增商店';
        document.getElementById('storeEditId').value = '';
        document.getElementById('storeNameInput').value = '';
        document.getElementById('storeSlugInput').value = '';
        document.getElementById('storeTypeSelect').value = 'restaurant';
        document.getElementById('storeDescInput').value = '';
        document.getElementById('storePhoneInput').value = '';
        document.getElementById('storeAddressInput').value = '';
        document.getElementById('storeColorInput').value = '#4F46E5';
    }
    document.getElementById('storeModal').style.display = 'flex';
}

export function editStore(id) { showStoreModal(id); }
export function closeStoreModal() { document.getElementById('storeModal').style.display = 'none'; }

export async function saveStore() {
    const name = document.getElementById('storeNameInput').value.trim();
    if (!name) return showToast('請輸入商店名稱');
    const slug = document.getElementById('storeSlugInput').value.trim().toLowerCase().replace(/[^a-z0-9-]/g, '') || null;
    const editId = document.getElementById('storeEditId').value;

    // 檢查 slug 是否重複
    if (slug) {
        let dupQ = sb.from('store_profiles').select('id').eq('store_slug', slug);
        if (editId) dupQ = dupQ.neq('id', editId);
        const { data: dupData } = await dupQ;
        if (dupData && dupData.length > 0) {
            showToast('❌ URL 代碼「' + slug + '」已被使用，請換一個');
            document.getElementById('storeSlugInput').focus();
            return;
        }
    }

    const record = {
        store_name: name,
        store_slug: slug,
        store_type: document.getElementById('storeTypeSelect').value,
        description: document.getElementById('storeDescInput').value.trim() || null,
        phone: document.getElementById('storePhoneInput').value.trim() || null,
        address: document.getElementById('storeAddressInput').value.trim() || null,
        theme_color: document.getElementById('storeColorInput').value
    };
    if (window.currentCompanyId) record.company_id = window.currentCompanyId;
    try {
        let res;
        if (editId) {
            record.updated_at = new Date().toISOString();
            res = await sb.from('store_profiles').update(record).eq('id', editId);
        } else {
            res = await sb.from('store_profiles').insert(record);
        }
        if (res.error) throw res.error;
        showToast('✅ 商店已儲存');
        closeStoreModal();
        await loadRestaurantList();
    } catch(e) { showToast('❌ 儲存失敗：' + (e.message || e)); }
}

export function showStoreQR(storeId) {
    const s = smStores.find(x => x.id === storeId);
    if (!s) return showToast('找不到商店資料');
    const url = getStoreOrderUrl(s);
    document.getElementById('storeQRTitle').textContent = s.store_name;
    document.getElementById('storeQRUrl').textContent = url;
    const qrEl = document.getElementById('storeQRCode');
    qrEl.innerHTML = '';
    if (typeof QRCode !== 'undefined') {
        new QRCode(qrEl, { text: url, width: 200, height: 200 });
    } else { qrEl.innerHTML = '<p style="color:#94A3B8;">QRCode 元件未載入</p>'; }
    document.getElementById('storeQRModal').style.display = 'flex';
}

export function closeStoreQR() { document.getElementById('storeQRModal').style.display = 'none'; }

export function getStoreOrderUrl(s) {
    const slug = s.store_slug || s.id;
    const base = location.hostname === 'localhost' ? location.origin : 'https://' + location.hostname;
    return base + location.pathname.replace('admin.html', 'order.html') + '?store=' + slug;
}

export function copyStoreUrl() {
    const url = document.getElementById('storeQRUrl').textContent;
    navigator.clipboard.writeText(url).then(() => showToast('✅ 已複製連結')).catch(() => showToast('複製失敗'));
}

export function openStorePreview() {
    const url = document.getElementById('storeQRUrl').textContent;
    window.open(url, '_blank');
}

// ===== 菜單管理 =====
export async function loadMenuCategories() {
    const { data } = await sb.from('menu_categories').select('*').eq('store_id', smCurrentStoreId).order('sort_order');
    smCategories = data || [];
    renderMenuCatList();
    updateMiCategorySelect();
}

function renderMenuCatList() {
    const el = document.getElementById('menuCatList');
    if (smCategories.length === 0) { el.innerHTML = '<p style="font-size:12px;color:#94A3B8;">尚無分類</p>'; return; }
    el.innerHTML = smCategories.map(c => `
        <div style="display:flex;justify-content:space-between;align-items:center;padding:6px 0;border-bottom:1px solid #F1F5F9;">
            <span style="font-size:13px;font-weight:600;">${escapeHTML(c.name)}</span>
            <button onclick="deleteMenuCategory('${c.id}')" style="background:none;border:none;color:#EF4444;cursor:pointer;font-size:12px;">刪除</button>
        </div>`).join('');
}

function updateMiCategorySelect() {
    document.getElementById('miCategory').innerHTML = '<option value="">-- 不分類 --</option>' +
        smCategories.map(c => `<option value="${c.id}">${escapeHTML(c.name)}</option>`).join('');
}

export async function addMenuCategory() {
    const name = document.getElementById('newCatName').value.trim();
    if (!name) return showToast('請輸入分類名稱');
    try {
        await sb.from('menu_categories').insert({ store_id: smCurrentStoreId, name, sort_order: smCategories.length });
        document.getElementById('newCatName').value = '';
        showToast('✅ 分類已新增');
        await loadMenuCategories();
    } catch(e) { showToast('❌ 新增失敗'); }
}

export async function deleteMenuCategory(id) {
    if (!confirm('確定刪除此分類？（品項不會被刪除）')) return;
    try { await sb.from('menu_categories').delete().eq('id', id); showToast('✅ 已刪除'); await loadMenuCategories(); }
    catch(e) { showToast('❌ 刪除失敗'); }
}

export async function loadMenuItems() {
    const { data } = await sb.from('menu_items').select('*, menu_categories(name)').eq('store_id', smCurrentStoreId).order('sort_order');
    smItems = data || [];
    renderMenuItemList();
}

function renderMenuItemList() {
    const el = document.getElementById('menuItemList');
    const countEl = document.getElementById('menuItemCount');
    if (countEl) {
        const avail = smItems.filter(i => i.is_available !== false).length;
        countEl.textContent = smItems.length + ' 個品項 · ' + avail + ' 個上架中';
    }
    if (smItems.length === 0) { el.innerHTML = '<p style="font-size:12px;color:#94A3B8;text-align:center;padding:20px;">尚無品項，點擊上方按鈕新增</p>'; return; }
    const grouped = {};
    smItems.forEach(i => {
        const catName = i.menu_categories?.name || '未分類';
        const catId = i.category_id || '__none__';
        if (!grouped[catId]) grouped[catId] = { name: catName, items: [] };
        grouped[catId].items.push(i);
    });
    let html = '';
    for (const catId of Object.keys(grouped)) {
        const g = grouped[catId];
        html += `<div style="margin-bottom:16px;">
            <div style="display:flex;align-items:center;gap:6px;margin-bottom:8px;padding:0 4px;">
                <span style="font-size:13px;font-weight:800;color:#334155;">${escapeHTML(g.name)}</span>
                <span style="font-size:11px;color:#94A3B8;">${g.items.length}</span>
            </div>`;
        html += g.items.map(i => {
            const optCount = (i.options && Array.isArray(i.options)) ? i.options.length : 0;
            const imgHtml = i.image_url
                ? `<div class="mi-card-img"><img src="${i.image_url}" loading="lazy"></div>`
                : `<div class="mi-card-img">🍽</div>`;
            let badges = '';
            if (i.is_combo) badges += '<span class="mi-badge mi-badge-combo">套餐</span>';
            if (!i.is_available) badges += '<span class="mi-badge mi-badge-sold">售完</span>';
            return `<div class="mi-card${i.is_available === false ? ' sold-out' : ''}">
                ${imgHtml}
                <div class="mi-card-info">
                    <div class="name">${escapeHTML(i.name)} ${badges}</div>
                    <div class="meta">
                        <span class="price">$${i.price}</span>
                        ${optCount ? '<span>' + optCount + '組選項</span>' : ''}
                    </div>
                </div>
                <div style="display:flex;gap:4px;flex-shrink:0;">
                    <button onclick="toggleItemAvail('${i.id}',${!i.is_available})" style="padding:6px 10px;border:1px solid ${i.is_available ? '#E2E8F0' : '#059669'};border-radius:8px;background:${i.is_available ? '#fff' : '#ECFDF5'};color:${i.is_available ? '#64748B' : '#059669'};font-size:11px;font-weight:700;cursor:pointer;white-space:nowrap;">${i.is_available !== false ? '標售完' : '上架'}</button>
                    <button onclick="editMenuItem('${i.id}')" style="padding:6px 10px;border:1px solid #E2E8F0;border-radius:8px;background:#fff;color:#4F46E5;font-size:11px;font-weight:700;cursor:pointer;">編輯</button>
                </div>
            </div>`;
        }).join('');
        html += '</div>';
    }
    el.innerHTML = html;
}

// ===== 品項表單抽屜 =====
export function showMenuItemForm(itemId) {
    const drawer = document.getElementById('miDrawer');
    const mask = document.getElementById('miDrawerMask');
    drawer.style.display = 'flex';
    mask.style.display = 'block';
    miPreviewMode = false;
    document.getElementById('miPreviewPanel').style.display = 'none';
    document.getElementById('miFormPanel').style.display = '';
    document.getElementById('miPreviewBtn').style.borderColor = '#E2E8F0';
    document.getElementById('miPreviewBtn').style.background = '#fff';
    document.getElementById('miPreviewBtn').style.color = '#64748B';

    if (itemId) {
        const i = smItems.find(x => x.id === itemId);
        if (!i) return;
        document.getElementById('miEditId').value = i.id;
        document.getElementById('miDrawerTitle').textContent = '編輯品項';
        document.getElementById('miSaveBtn').textContent = '✅ 更新品項';
        document.getElementById('miDeleteBtn').style.display = '';
        document.getElementById('miName').value = i.name;
        document.getElementById('miCategory').value = i.category_id || '';
        document.getElementById('miPrice').value = i.price;
        document.getElementById('miDesc').value = i.description || '';
        document.getElementById('miImageUrl').value = i.image_url || '';
        const preview = document.getElementById('miImagePreview');
        const placeholder = document.getElementById('miImagePlaceholder');
        if (i.image_url) { preview.src = i.image_url; preview.style.display = 'block'; placeholder.style.display = 'none'; }
        else { preview.style.display = 'none'; placeholder.style.display = ''; }
        miOptionGroups = (i.options && Array.isArray(i.options)) ? JSON.parse(JSON.stringify(i.options)) : [];
        miIsComboOn = !!i.is_combo;
        miComboGroups = (i.combo_config && i.combo_config.groups) ? JSON.parse(JSON.stringify(i.combo_config.groups)) : [];
    } else {
        document.getElementById('miEditId').value = '';
        document.getElementById('miDrawerTitle').textContent = '新增品項';
        document.getElementById('miSaveBtn').textContent = '✅ 新增品項';
        document.getElementById('miDeleteBtn').style.display = 'none';
        document.getElementById('miName').value = '';
        document.getElementById('miCategory').value = '';
        document.getElementById('miPrice').value = '';
        document.getElementById('miDesc').value = '';
        document.getElementById('miImageUrl').value = '';
        document.getElementById('miImagePreview').style.display = 'none';
        document.getElementById('miImagePlaceholder').style.display = '';
        miOptionGroups = [];
        miIsComboOn = false;
        miComboGroups = [];
    }
    updateComboSwitchUI();
    renderOptionEditor();
    renderComboEditor();
    if (miOptionGroups.length > 0) {
        const sec = document.getElementById('miOptionsSection');
        if (sec) { sec.style.display = ''; sec.previousElementSibling.querySelector('.arrow').classList.add('open'); }
    }
    if (miIsComboOn) {
        const sec = document.getElementById('miComboSection');
        if (sec) { sec.style.display = ''; sec.previousElementSibling.querySelector('.arrow').classList.add('open'); }
        document.getElementById('miComboEditor').style.display = '';
    }
    updateOptBadge();
}

export function editMenuItem(id) { showMenuItemForm(id); }

export function cancelMenuItemForm() {
    document.getElementById('miDrawer').style.display = 'none';
    document.getElementById('miDrawerMask').style.display = 'none';
}

export function toggleMiSection(hd) {
    const bd = hd.nextElementSibling;
    const arrow = hd.querySelector('.arrow');
    if (bd.style.display === 'none') {
        bd.style.display = '';
        arrow.classList.add('open');
    } else {
        bd.style.display = 'none';
        arrow.classList.remove('open');
    }
}

export function toggleMiPreview() {
    miPreviewMode = !miPreviewMode;
    const btn = document.getElementById('miPreviewBtn');
    if (miPreviewMode) {
        syncOptionEditor();
        document.getElementById('miFormPanel').style.display = 'none';
        document.getElementById('miPreviewPanel').style.display = '';
        btn.style.borderColor = '#4F46E5'; btn.style.background = '#EEF2FF'; btn.style.color = '#4F46E5';
        renderMiPreview();
    } else {
        document.getElementById('miFormPanel').style.display = '';
        document.getElementById('miPreviewPanel').style.display = 'none';
        btn.style.borderColor = '#E2E8F0'; btn.style.background = '#fff'; btn.style.color = '#64748B';
    }
}

function renderMiPreview() {
    const name = document.getElementById('miName').value.trim() || '品名';
    const price = parseFloat(document.getElementById('miPrice').value) || 0;
    const desc = document.getElementById('miDesc').value.trim();
    const imgUrl = document.getElementById('miImageUrl').value;
    const imgHtml = imgUrl ? `<img src="${imgUrl}" style="width:100%;height:100%;object-fit:cover;">` : '📷';
    let optHtml = '';
    miOptionGroups.forEach(g => {
        if (!g.name) return;
        optHtml += `<div style="margin-bottom:10px;">
            <div style="display:flex;align-items:center;gap:6px;margin-bottom:6px;">
                <span style="font-size:12px;font-weight:800;color:#1E293B;">${escapeHTML(g.name)}</span>
                ${g.required ? '<span style="font-size:9px;padding:1px 5px;background:#FEE2E2;color:#DC2626;border-radius:4px;font-weight:700;">必選</span>' : ''}
                <span style="font-size:10px;color:#94A3B8;">${g.type === 'single' ? '單選' : '可多選'}</span>
            </div>
            <div style="display:flex;flex-wrap:wrap;gap:4px;">
                ${(g.choices || []).filter(c => c.label).map((c, j) => {
                    const sel = j === 0 && g.type === 'single';
                    return `<span style="padding:5px 10px;border:1.5px solid ${sel ? '#4F46E5' : '#E2E8F0'};border-radius:8px;background:${sel ? '#EEF2FF' : '#fff'};font-size:12px;font-weight:600;color:${sel ? '#4F46E5' : '#334155'};">${escapeHTML(c.label)}${c.price > 0 ? '<span style="color:#94A3B8;margin-left:4px;">+$' + c.price + '</span>' : ''}</span>`;
                }).join('')}
            </div>
        </div>`;
    });
    document.getElementById('miPreviewPanel').innerHTML = `
        <div class="mi-preview">
            <div style="font-size:10px;font-weight:700;color:#94A3B8;text-transform:uppercase;letter-spacing:1px;margin-bottom:10px;">📱 客人看到的樣子</div>
            <div class="mi-preview-phone">
                <div class="mi-preview-img">${imgHtml}</div>
                <div class="mi-preview-bd">
                    <div style="font-size:16px;font-weight:800;color:#0F172A;margin-bottom:4px;">${escapeHTML(name)}</div>
                    ${desc ? '<div style="font-size:12px;color:#64748B;margin-bottom:8px;">' + escapeHTML(desc) + '</div>' : ''}
                    <div style="font-size:18px;font-weight:900;color:#4F46E5;margin-bottom:12px;">$ ${price}</div>
                    ${optHtml}
                    <button style="width:100%;padding:12px;border:none;border-radius:12px;background:linear-gradient(135deg,#4F46E5,#3730A3);color:#fff;font-size:14px;font-weight:800;margin-top:8px;cursor:default;">🛒 加入購物車 · $${price}</button>
                </div>
            </div>
        </div>`;
}

export function updateOptBadge() {
    const badge = document.getElementById('miOptBadge');
    if (miOptionGroups.length > 0) {
        badge.textContent = miOptionGroups.length + '組';
        badge.style.display = '';
    } else {
        badge.style.display = 'none';
    }
}

// ===== 套餐 toggle =====
export function toggleComboSwitch() {
    miIsComboOn = !miIsComboOn;
    updateComboSwitchUI();
    document.getElementById('miComboEditor').style.display = miIsComboOn ? '' : 'none';
}

function updateComboSwitchUI() {
    const toggle = document.getElementById('miComboToggle');
    const knob = document.getElementById('miComboKnob');
    const label = document.getElementById('miComboLabel');
    if (miIsComboOn) {
        toggle.style.background = '#4F46E5';
        knob.style.left = '22px';
        label.style.color = '#4F46E5';
    } else {
        toggle.style.background = '#CBD5E1';
        knob.style.left = '2px';
        label.style.color = '#64748B';
    }
}

export async function saveMenuItem() {
    const name = document.getElementById('miName').value.trim();
    const price = parseFloat(document.getElementById('miPrice').value);
    if (!name) return showToast('請輸入品名');
    if (isNaN(price) || price < 0) return showToast('請輸入有效價格');
    syncOptionEditor();
    syncComboEditor();
    const record = {
        store_id: smCurrentStoreId, name,
        category_id: document.getElementById('miCategory').value || null,
        price,
        description: document.getElementById('miDesc').value.trim() || null,
        image_url: document.getElementById('miImageUrl').value || null,
        options: miOptionGroups.length > 0 ? miOptionGroups : null,
        is_combo: miIsComboOn,
        combo_config: miIsComboOn && miComboGroups.length > 0 ? { groups: miComboGroups } : null
    };
    try {
        const editId = document.getElementById('miEditId').value;
        let res;
        if (editId) {
            record.updated_at = new Date().toISOString();
            res = await sb.from('menu_items').update(record).eq('id', editId);
        } else {
            record.sort_order = smItems.length;
            res = await sb.from('menu_items').insert(record);
        }
        if (res.error) throw res.error;
        showToast('✅ 品項已儲存');
        cancelMenuItemForm();
        await loadMenuItems();
    } catch(e) { showToast('❌ 儲存失敗：' + (e.message || e)); }
}

export async function deleteMenuItem() {
    const editId = document.getElementById('miEditId').value;
    if (!editId) return;
    if (!confirm('確定要刪除此品項嗎？')) return;
    try {
        const res = await sb.from('menu_items').delete().eq('id', editId);
        if (res.error) throw res.error;
        showToast('✅ 品項已刪除');
        cancelMenuItemForm();
        await loadMenuItems();
    } catch(e) { showToast('❌ 刪除失敗：' + (e.message || e)); }
}

export async function toggleItemAvail(id, avail) {
    try {
        await sb.from('menu_items').update({ is_available: avail, updated_at: new Date().toISOString() }).eq('id', id);
        showToast(avail ? '✅ 已恢復上架' : '🔴 已標記售完');
        await loadMenuItems();
    } catch(e) { showToast('❌ 操作失敗'); }
}

// ===== 品項圖片上傳 =====
export async function handleMenuImageUpload(input) {
    const file = input.files[0];
    if (!file) return;
    try {
        showToast('☁️ 上傳中...');
        const bitmap = await createImageBitmap(file);
        let cw = bitmap.width, ch = bitmap.height;
        const MAX = 400;
        if (cw > MAX) { ch = Math.round(ch * MAX / cw); cw = MAX; }
        if (ch > MAX) { cw = Math.round(cw * MAX / ch); ch = MAX; }
        const canvas = document.createElement('canvas');
        canvas.width = cw; canvas.height = ch;
        canvas.getContext('2d').drawImage(bitmap, 0, 0, cw, ch);
        const blob = await new Promise(r => canvas.toBlob(r, 'image/jpeg', 0.7));
        const s = smStores.find(x => x.id === smCurrentStoreId);
        const slug = s?.store_slug || smCurrentStoreId;
        const fileName = `menu/${slug}/${Date.now()}.jpg`;
        const { error } = await sb.storage.from(CONFIG.BUCKET).upload(fileName, blob);
        if (error) throw error;
        const { data: urlData } = sb.storage.from(CONFIG.BUCKET).getPublicUrl(fileName);
        const url = urlData?.publicUrl || urlData?.publicURL;
        document.getElementById('miImageUrl').value = url;
        const preview = document.getElementById('miImagePreview');
        preview.src = url; preview.style.display = 'block';
        const placeholder = document.getElementById('miImagePlaceholder');
        if (placeholder) placeholder.style.display = 'none';
        showToast('✅ 圖片已上傳');
    } catch(e) { showToast('❌ 圖片上傳失敗：' + (e.message || e)); }
    input.value = '';
}

// ===== 客製化選項編輯器 =====
export const OPTION_TEMPLATES = {
    drink: [
        { name: '甜度', required: true, type: 'single', choices: [{label:'正常糖',price:0},{label:'少糖',price:0},{label:'半糖',price:0},{label:'微糖',price:0},{label:'無糖',price:0}] },
        { name: '冰量', required: true, type: 'single', choices: [{label:'正常冰',price:0},{label:'少冰',price:0},{label:'微冰',price:0},{label:'去冰',price:0},{label:'熱飲',price:0}] }
    ],
    food: [
        { name: '辣度', required: false, type: 'single', choices: [{label:'不辣',price:0},{label:'小辣',price:0},{label:'中辣',price:0},{label:'大辣',price:0}] },
        { name: '加料', required: false, type: 'multi', choices: [{label:'加蛋',price:10},{label:'加起司',price:15},{label:'加培根',price:20}] }
    ],
    size: [
        { name: '尺寸', required: true, type: 'single', choices: [{label:'小',price:0},{label:'中',price:10},{label:'大',price:20}] }
    ]
};

export function applyOptionTemplate(tpl) {
    syncOptionEditor();
    const newGroups = JSON.parse(JSON.stringify(OPTION_TEMPLATES[tpl] || []));
    miOptionGroups = [...miOptionGroups, ...newGroups];
    renderOptionEditor();
    updateOptBadge();
}

export function addOptionGroup() {
    syncOptionEditor();
    miOptionGroups.push({ name: '', required: false, type: 'single', choices: [{ label: '', price: 0 }] });
    renderOptionEditor();
    updateOptBadge();
}

export function removeOptionGroup(idx) { syncOptionEditor(); miOptionGroups.splice(idx, 1); renderOptionEditor(); updateOptBadge(); }

export function addOptionChoice(gIdx) {
    syncOptionEditor();
    miOptionGroups[gIdx].choices.push({ label: '', price: 0 });
    renderOptionEditor();
}

export function removeOptionChoice(gIdx, cIdx) { syncOptionEditor(); miOptionGroups[gIdx].choices.splice(cIdx, 1); renderOptionEditor(); }

export function toggleOptionType(gIdx, type) {
    syncOptionEditor();
    miOptionGroups[gIdx].type = type;
    renderOptionEditor();
}

export function toggleOptionReq(gIdx) {
    syncOptionEditor();
    miOptionGroups[gIdx].required = !miOptionGroups[gIdx].required;
    renderOptionEditor();
}

function syncOptionEditor() {
    document.querySelectorAll('.optGrp').forEach((grpEl, gIdx) => {
        if (!miOptionGroups[gIdx]) return;
        miOptionGroups[gIdx].name = grpEl.querySelector('.optGrpName').value;
        grpEl.querySelectorAll('.optChoice').forEach((cEl, cIdx) => {
            if (!miOptionGroups[gIdx].choices[cIdx]) return;
            miOptionGroups[gIdx].choices[cIdx].label = cEl.querySelector('.optCLabel').value;
            miOptionGroups[gIdx].choices[cIdx].price = parseFloat(cEl.querySelector('.optCPrice').value) || 0;
        });
    });
}

function renderOptionEditor() {
    const el = document.getElementById('miOptionsEditor');
    let html = `<div style="display:flex;gap:6px;margin-bottom:12px;flex-wrap:wrap;align-items:center;">
        <span style="font-size:11px;color:#94A3B8;">快速套用：</span>
        <button class="mi-tpl-btn" onclick="applyOptionTemplate('drink')">☕ 飲料</button>
        <button class="mi-tpl-btn" onclick="applyOptionTemplate('food')">🍜 餐點</button>
        <button class="mi-tpl-btn" onclick="applyOptionTemplate('size')">📏 尺寸</button>
    </div>`;
    if (miOptionGroups.length === 0) {
        html += '<p style="font-size:12px;color:#94A3B8;text-align:center;padding:8px;">尚無客製選項</p>';
    } else {
        html += miOptionGroups.map((g, gIdx) => `
            <div class="optGrp og-card">
                <div class="og-header">
                    <span style="color:#94A3B8;cursor:grab;font-size:14px;">⠿</span>
                    <input class="optGrpName" value="${escapeHTML(g.name)}" placeholder="群組名稱（如：辣度）" style="flex:1;padding:8px 10px;border:1.5px solid #E2E8F0;border-radius:8px;font-size:13px;font-weight:700;outline:none;background:#fff;">
                    <div class="og-toggle-group">
                        <button class="og-toggle${g.type==='single'?' active':''}" onclick="toggleOptionType(${gIdx},'single')">單選</button>
                        <button class="og-toggle${g.type==='multi'?' active':''}" onclick="toggleOptionType(${gIdx},'multi')">多選</button>
                    </div>
                    <button class="og-req-btn ${g.required?'on':'off'}" onclick="toggleOptionReq(${gIdx})">必選</button>
                    <button class="og-del-btn" onclick="removeOptionGroup(${gIdx})">✕</button>
                </div>
                ${g.choices.map((c, cIdx) => `
                    <div class="optChoice og-choice">
                        <span style="font-size:10px;color:#CBD5E1;">${g.type === 'single' ? '○' : '☐'}</span>
                        <input class="optCLabel og-choice-name" value="${escapeHTML(c.label)}" placeholder="選項名稱">
                        <div class="og-price-wrap">
                            <span class="prefix">+$</span>
                            <input class="optCPrice" type="number" value="${c.price}" min="0">
                        </div>
                        <button onclick="removeOptionChoice(${gIdx},${cIdx})" style="width:24px;height:24px;border:none;border-radius:6px;background:transparent;color:#94A3B8;font-size:12px;cursor:pointer;display:flex;align-items:center;justify-content:center;">✕</button>
                    </div>
                `).join('')}
                <button onclick="addOptionChoice(${gIdx})" style="padding:4px 10px;border:1px dashed #CBD5E1;border-radius:6px;background:transparent;font-size:11px;color:#64748B;cursor:pointer;margin-top:2px;margin-left:24px;">+ 新增選項</button>
            </div>
        `).join('');
    }
    html += `<button onclick="addOptionGroup()" style="width:100%;padding:10px;border:1.5px dashed #CBD5E1;border-radius:10px;background:transparent;font-size:12px;font-weight:700;color:#64748B;cursor:pointer;margin-top:4px;">+ 新增選項群組</button>`;
    el.innerHTML = html;
}

// ===== 套餐組合編輯器 =====
export function addComboGroup() {
    miComboGroups.push({ name: '', pick: 1, items: [] });
    renderComboEditor();
}

export function removeComboGroup(idx) { miComboGroups.splice(idx, 1); renderComboEditor(); }

function syncComboEditor() {
    document.querySelectorAll('#miComboGroups .comboGrp').forEach((grpEl, gIdx) => {
        if (!miComboGroups[gIdx]) return;
        miComboGroups[gIdx].name = grpEl.querySelector('.comboGrpName').value;
        miComboGroups[gIdx].pick = parseInt(grpEl.querySelector('.comboGrpPick').value) || 1;
        const checked = grpEl.querySelectorAll('.comboItemCheck:checked');
        miComboGroups[gIdx].items = Array.from(checked).map(c => c.value);
    });
}

function renderComboEditor() {
    const el = document.getElementById('miComboGroups');
    if (!el) return;
    if (miComboGroups.length === 0) { el.innerHTML = '<p style="font-size:11px;color:#94A3B8;">尚無套餐群組</p>'; return; }
    const editId = document.getElementById('miEditId').value;
    const availItems = smItems.filter(i => i.id !== editId);
    el.innerHTML = miComboGroups.map((g, gIdx) => `
        <div class="comboGrp" style="border:1px solid #E2E8F0;border-radius:8px;padding:10px;margin-bottom:8px;background:#fff;">
            <div style="display:flex;gap:4px;align-items:center;margin-bottom:6px;">
                <input class="comboGrpName" value="${escapeHTML(g.name)}" placeholder="群組名稱（如：主餐選1）" onchange="syncComboEditor()" style="flex:1;padding:6px;border:1px solid #E2E8F0;border-radius:6px;font-size:12px;">
                <span style="font-size:11px;white-space:nowrap;">選</span>
                <select class="comboGrpPick" onchange="syncComboEditor()" style="padding:4px;border:1px solid #E2E8F0;border-radius:6px;font-size:11px;">
                    <option value="-1" ${g.pick===-1?'selected':''}>任選</option>
                    <option value="1" ${g.pick===1?'selected':''}>1</option>
                    <option value="2" ${g.pick===2?'selected':''}>2</option>
                    <option value="3" ${g.pick===3?'selected':''}>3</option>
                </select>
                <button onclick="removeComboGroup(${gIdx})" style="background:none;border:none;color:#EF4444;cursor:pointer;font-size:14px;">×</button>
            </div>
            <div style="max-height:150px;overflow-y:auto;margin-left:8px;">
                ${availItems.length === 0 ? '<p style="font-size:11px;color:#94A3B8;">請先新增其他品項</p>' :
                availItems.map(item => `
                    <label style="display:flex;align-items:center;gap:6px;font-size:12px;padding:2px 0;cursor:pointer;">
                        <input type="checkbox" class="comboItemCheck" value="${item.id}" ${g.items.includes(item.id)?'checked':''} onchange="syncComboEditor()">
                        ${escapeHTML(item.name)} ($${item.price})
                    </label>
                `).join('')}
            </div>
        </div>
    `).join('');
}

// ===== 設定 Tab =====
function loadStoreSettings() {
    const s = smStores.find(x => x.id === rdCurrentStoreId);
    if (!s) return;
    document.getElementById('rdStoreInfo').innerHTML = `
        <div>名稱：${escapeHTML(s.store_name)}</div>
        <div>類型：${{ restaurant:'餐飲', service:'服務業', retail:'零售' }[s.store_type] || s.store_type}</div>
        ${s.phone ? '<div>電話：' + escapeHTML(s.phone) + '</div>' : ''}
        ${s.address ? '<div>地址：' + escapeHTML(s.address) + '</div>' : ''}
        ${s.store_slug ? '<div>Slug：' + escapeHTML(s.store_slug) + '</div>' : ''}
    `;
    const bh = s.business_hours || {};
    const days = [['mon','一'],['tue','二'],['wed','三'],['thu','四'],['fri','五'],['sat','六'],['sun','日']];
    document.getElementById('rdBusinessHours').innerHTML = days.map(([key, label]) => {
        const d = bh[key] || { open: true, start: '08:00', end: '20:00' };
        return `<div style="display:flex;align-items:center;gap:6px;margin-bottom:6px;font-size:13px;" data-day="${key}">
            <span style="width:24px;font-weight:600;">${label}</span>
            <label style="font-size:12px;"><input type="checkbox" class="bhOpen" ${d.open ? 'checked' : ''}> 營業</label>
            <input type="time" class="bhStart" value="${d.start || '08:00'}" style="padding:4px;border:1px solid #E2E8F0;border-radius:6px;font-size:12px;">
            <span>~</span>
            <input type="time" class="bhEnd" value="${d.end || '20:00'}" style="padding:4px;border:1px solid #E2E8F0;border-radius:6px;font-size:12px;">
        </div>`;
    }).join('');
    document.getElementById('rdLineGroupId').value = s.line_group_id || '';
    const lc = s.loyalty_config || {};
    document.getElementById('rdLoyaltySpend').value = lc.spend_per_point || '';
    document.getElementById('rdLoyaltyPoints').value = lc.points_to_redeem || '';
    document.getElementById('rdLoyaltyDiscount').value = lc.discount_amount || '';
}

export async function saveBusinessHours() {
    const bh = {};
    document.querySelectorAll('#rdBusinessHours [data-day]').forEach(row => {
        bh[row.dataset.day] = {
            open: row.querySelector('.bhOpen').checked,
            start: row.querySelector('.bhStart').value,
            end: row.querySelector('.bhEnd').value
        };
    });
    try {
        await sb.from('store_profiles').update({ business_hours: bh, updated_at: new Date().toISOString() }).eq('id', rdCurrentStoreId);
        const s = smStores.find(x => x.id === rdCurrentStoreId);
        if (s) s.business_hours = bh;
        showToast('✅ 營業時間已儲存');
    } catch(e) { showToast('❌ 儲存失敗'); }
}

export async function saveLineGroupId() {
    const gid = document.getElementById('rdLineGroupId').value.trim();
    try {
        await sb.from('store_profiles').update({ line_group_id: gid || null, updated_at: new Date().toISOString() }).eq('id', rdCurrentStoreId);
        const s = smStores.find(x => x.id === rdCurrentStoreId);
        if (s) s.line_group_id = gid || null;
        showToast('✅ LINE 群組已儲存');
    } catch(e) { showToast('❌ 儲存失敗'); }
}

export async function saveLoyaltyConfig() {
    const config = {
        spend_per_point: parseInt(document.getElementById('rdLoyaltySpend').value) || 50,
        points_to_redeem: parseInt(document.getElementById('rdLoyaltyPoints').value) || 10,
        discount_amount: parseInt(document.getElementById('rdLoyaltyDiscount').value) || 50
    };
    try {
        await sb.from('store_profiles').update({ loyalty_config: config, updated_at: new Date().toISOString() }).eq('id', rdCurrentStoreId);
        const s = smStores.find(x => x.id === rdCurrentStoreId);
        if (s) s.loyalty_config = config;
        showToast('✅ 集點設定已儲存');
    } catch(e) { showToast('❌ 儲存失敗'); }
}

// ===== 菜單複製 =====
export function showCopyMenuModal() {
    const targets = smStores.filter(s => s.id !== smCurrentStoreId);
    if (targets.length === 0) return showToast('沒有其他商店可以複製');
    document.getElementById('copyMenuTargets').innerHTML = targets.map(s => `
        <label style="display:flex;align-items:center;gap:8px;padding:8px 0;border-bottom:1px solid #F1F5F9;font-size:13px;">
            <input type="checkbox" class="copyTarget" value="${s.id}">
            ${escapeHTML(s.store_name)}
        </label>
    `).join('');
    document.getElementById('copyMenuModal').style.display = 'flex';
}

export function closeCopyMenuModal() { document.getElementById('copyMenuModal').style.display = 'none'; }

export async function executeCopyMenu() {
    const targets = [];
    document.querySelectorAll('.copyTarget:checked').forEach(cb => targets.push(cb.value));
    if (targets.length === 0) return showToast('請選擇目標商店');
    if (!confirm(`確定將菜單複製到 ${targets.length} 間商店？會覆蓋目標的現有菜單。`)) return;
    try {
        for (const targetId of targets) {
            await sb.from('menu_items').delete().eq('store_id', targetId);
            await sb.from('menu_categories').delete().eq('store_id', targetId);
            const catMap = {};
            for (const c of smCategories) {
                const { data } = await sb.from('menu_categories').insert({ store_id: targetId, name: c.name, sort_order: c.sort_order }).select().single();
                catMap[c.id] = data.id;
            }
            for (const i of smItems) {
                await sb.from('menu_items').insert({
                    store_id: targetId,
                    name: i.name, category_id: i.category_id ? catMap[i.category_id] : null,
                    price: i.price, description: i.description, image_url: i.image_url,
                    is_available: i.is_available, sort_order: i.sort_order, options: i.options, tags: i.tags
                });
            }
        }
        showToast(`✅ 已複製到 ${targets.length} 間商店`);
        closeCopyMenuModal();
    } catch(e) { showToast('❌ 複製失敗：' + (e.message || e)); }
}
