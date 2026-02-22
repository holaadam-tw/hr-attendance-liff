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
        if (window.currentCompanyId) q = q.or('company_id.eq.' + window.currentCompanyId + ',company_id.is.null');
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

        // 平台管理員 + 有商店 → 跳過列表，直接進第一間商店
        if (window.isPlatformAdmin && smStores.length > 0) {
            openRestaurantDetail(smStores[0].id);
            renderStoreSwitcher();
            return;
        }

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
    window.rdCurrentStoreId = storeId;
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

// ===== 商店切換器（平台管理員多店切換）=====
function renderStoreSwitcher() {
    if (!window.isPlatformAdmin || smStores.length <= 1) return;
    if (document.getElementById('storeSwitcherWrap')) return;

    const target = document.getElementById('rdStoreName');
    if (!target) return;

    const wrap = document.createElement('div');
    wrap.id = 'storeSwitcherWrap';
    wrap.style.cssText = 'display:flex;align-items:center;gap:8px;margin-bottom:8px;';

    const select = document.createElement('select');
    select.id = 'storeSwitcher';
    select.style.cssText = 'flex:1;padding:6px 10px;border:1px solid #ddd;border-radius:8px;font-size:13px;background:#fff;color:#333;cursor:pointer;';
    smStores.forEach(s => {
        const opt = document.createElement('option');
        opt.value = s.id;
        opt.textContent = s.store_name;
        if (s.id === rdCurrentStoreId) opt.selected = true;
        select.appendChild(opt);
    });
    select.addEventListener('change', () => {
        openRestaurantDetail(select.value);
    });

    wrap.appendChild(select);
    target.parentNode.insertBefore(wrap, target);
    target.style.display = 'none';

    // 修改返回按鈕：平台管理員回首頁而非商店列表
    const backBtn = document.querySelector('#restaurantDetailPage > button');
    if (backBtn) {
        backBtn.textContent = '← 返回';
        backBtn.onclick = () => window.showPage?.('adminHomePage');
    }
}

export function previewStoreOrder() {
    const s = smStores.find(x => x.id === rdCurrentStoreId);
    if (!s) return showToast('找不到商店資料');
    window.open(getStoreOrderUrl(s), '_blank');
}

export function openKDS() {
    const s = smStores.find(x => x.id === rdCurrentStoreId);
    if (!s) return showToast('找不到商店資料');
    const base = location.origin + location.pathname.replace(/\/[^/]*$/, '/');
    window.open(base + 'kds.html?store=' + encodeURIComponent(s.store_slug), '_blank');
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
    document.getElementById('rdReportTab').style.display = tab === 'report' ? '' : 'none';
    document.getElementById('rdSettingsTab').style.display = tab === 'settings' ? '' : 'none';
    if (tab === 'orders') loadStoreOrders();
    if (tab === 'menu') { loadMenuCategories(); loadMenuItems(); }
    if (tab === 'report') loadSalesReport();
    if (tab === 'settings') loadStoreSettings();
}

// ===== 訂單即時通知 =====
let _orderPollTimer = null;
let _lastOrderIds = new Set();
let _orderSoundEnabled = true;
const _orderSound = typeof Audio !== 'undefined' ? new Audio('data:audio/wav;base64,UklGRnoGAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQoGAACBhYqFbF1fdJivrJBhNjVgkKuslnRRRXKXrK2UZko+ZJCnp5RoTEFpmauspHdVSXOaraugeVlPd56sqp57XVR8oKeonX5hWICfqaadgGNagZ+op5+AZVuCn6imnoBmXIOeqKadgGZdg5+opZ2AZl2Dn6iknYBmXYOfp6OdgGZdg5+oo52AZl2Dn6ejnX9mXYOfp6SdgGZdg5+no52AZl2Dn6ejnYBmXYOfp6OdgGZdg5+no52AZl2Dn6ejnYBmXQ==') : null;

function startOrderPolling() {
    stopOrderPolling();
    // 記住目前的訂單 ID
    _lastOrderIds = new Set(rdOrders.map(o => o.id));
    _orderPollTimer = setInterval(async () => {
        if (!rdCurrentStoreId) return;
        try {
            const statusFilter = document.getElementById('rdStatusFilter')?.value;
            let q = sb.from('orders').select('*').eq('store_id', rdCurrentStoreId).order('created_at', { ascending: false }).limit(100);
            if (statusFilter) q = q.eq('status', statusFilter);
            const { data } = await q;
            if (!data) return;
            // 找新訂單
            const newOrders = data.filter(o => !_lastOrderIds.has(o.id));
            if (newOrders.length > 0) {
                // 播放音效
                if (_orderSoundEnabled && _orderSound) {
                    try { _orderSound.currentTime = 0; _orderSound.play(); } catch(e) {}
                }
                // 桌面通知
                if (Notification.permission === 'granted') {
                    const o = newOrders[0];
                    const itemCount = (o.items || []).reduce((s, i) => s + (i.qty || 1), 0);
                    new Notification('🔔 新訂單！', {
                        body: `#${o.order_number} · ${o.order_type === 'takeout' ? '外帶' : '桌' + (o.table_number || '?')} · ${itemCount}品 · $${o.total}`,
                        icon: '🍽️', tag: 'new-order'
                    });
                }
                showToast('🔔 收到 ' + newOrders.length + ' 筆新訂單！');
            }
            _lastOrderIds = new Set(data.map(o => o.id));
            rdOrders = data;
            renderStoreOrderList();
            updateStoreOrderStats();
            renderTopSelling();
        } catch(e) { console.warn('Order poll error:', e); }
    }, 30000); // 每 30 秒（降低 API 壓力）
}

function stopOrderPolling() {
    if (_orderPollTimer) { clearInterval(_orderPollTimer); _orderPollTimer = null; }
}

export function toggleOrderSound() {
    _orderSoundEnabled = !_orderSoundEnabled;
    const btn = document.getElementById('soundToggleBtn');
    if (btn) btn.textContent = _orderSoundEnabled ? '🔔' : '🔕';
    showToast(_orderSoundEnabled ? '音效已開啟' : '音效已關閉');
}

// ===== 訂單 Tab =====
export async function loadStoreOrders() {
    try {
        let q = sb.from('orders').select('*').eq('store_id', rdCurrentStoreId).order('created_at', { ascending: false }).limit(100);
        const statusFilter = document.getElementById('rdStatusFilter')?.value;
        if (statusFilter) q = q.eq('status', statusFilter);
        const { data } = await q;
        rdOrders = data || [];
        renderStoreOrderList();
        updateStoreOrderStats();
        renderTopSelling();
        // 啟動即時通知 polling
        startOrderPolling();
        // 請求桌面通知權限
        if (typeof Notification !== 'undefined' && Notification.permission === 'default') {
            Notification.requestPermission();
        }
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
        document.getElementById('storeBannerInput').value = s.banner_url || '';
        document.getElementById('storeLogoInput').value = s.logo_url || '';
        // 顯示圖片預覽
        if (s.banner_url) {
            document.getElementById('storeBannerPreviewImg').src = s.banner_url;
            document.getElementById('storeBannerPreview').style.display = 'block';
        } else {
            document.getElementById('storeBannerPreview').style.display = 'none';
        }
        if (s.logo_url) {
            document.getElementById('storeLogoPreviewImg').src = s.logo_url;
            document.getElementById('storeLogoPreview').style.display = 'block';
        } else {
            document.getElementById('storeLogoPreview').style.display = 'none';
        }
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
        document.getElementById('storeBannerInput').value = '';
        document.getElementById('storeLogoInput').value = '';
        document.getElementById('storeBannerPreview').style.display = 'none';
        document.getElementById('storeLogoPreview').style.display = 'none';
    }
    document.getElementById('storeModal').style.display = 'flex';
}

export function editStore(id) { showStoreModal(id); }
export function closeStoreModal() { document.getElementById('storeModal').style.display = 'none'; }

// 上傳商店圖片到 Supabase Storage
export async function uploadStoreImage(inputEl, type) {
    const file = inputEl.files[0];
    if (!file) return;
    if (file.size > 5 * 1024 * 1024) { showToast('圖片不能超過 5MB'); return; }

    const ext = file.name.split('.').pop().toLowerCase();
    const fileName = type + '_' + Date.now() + '.' + ext;
    const filePath = 'stores/' + fileName;

    showToast('上傳中...');
    try {
        const { data, error } = await sb.storage.from('store-images').upload(filePath, file, {
            cacheControl: '3600',
            upsert: true
        });
        if (error) throw error;

        const { data: urlData } = sb.storage.from('store-images').getPublicUrl(filePath);
        const publicUrl = urlData.publicUrl;

        if (type === 'banner') {
            document.getElementById('storeBannerInput').value = publicUrl;
            document.getElementById('storeBannerPreviewImg').src = publicUrl;
            document.getElementById('storeBannerPreview').style.display = 'block';
        } else {
            document.getElementById('storeLogoInput').value = publicUrl;
            document.getElementById('storeLogoPreviewImg').src = publicUrl;
            document.getElementById('storeLogoPreview').style.display = 'block';
        }
        showToast('✅ 圖片上傳成功');
    } catch (e) {
        showToast('❌ 上傳失敗：' + (e.message || e));
    }
    inputEl.value = '';
}

export function clearStoreImage(type) {
    if (type === 'banner') {
        document.getElementById('storeBannerInput').value = '';
        document.getElementById('storeBannerPreviewImg').src = '';
        document.getElementById('storeBannerPreview').style.display = 'none';
    } else {
        document.getElementById('storeLogoInput').value = '';
        document.getElementById('storeLogoPreviewImg').src = '';
        document.getElementById('storeLogoPreview').style.display = 'none';
    }
    showToast('已移除' + (type === 'banner' ? '品牌形象圖' : 'Logo'));
}

export async function saveStore() {
    const name = document.getElementById('storeNameInput').value.trim();
    if (!name) return showToast('請輸入商店名稱');
    let slug = document.getElementById('storeSlugInput').value.trim().toLowerCase().replace(/[^a-z0-9-]/g, '') || null;
    const editId = document.getElementById('storeEditId').value;

    // 若未填 slug，自動產生（s + 時間戳末6碼）
    if (!slug) {
        slug = 's' + Date.now().toString(36).slice(-6);
    }

    // 檢查 slug 是否重複，若重複自動加後綴
    let dupQ = sb.from('store_profiles').select('id').eq('store_slug', slug);
    if (editId) dupQ = dupQ.neq('id', editId);
    const { data: dupData } = await dupQ;
    if (dupData && dupData.length > 0) {
        slug = slug + '-' + Date.now().toString(36).slice(-4);
    }

    const record = {
        store_name: name,
        store_slug: slug,
        store_type: document.getElementById('storeTypeSelect').value,
        description: document.getElementById('storeDescInput').value.trim() || null,
        phone: document.getElementById('storePhoneInput').value.trim() || null,
        address: document.getElementById('storeAddressInput').value.trim() || null,
        theme_color: document.getElementById('storeColorInput').value,
        banner_url: document.getElementById('storeBannerInput').value.trim() || null,
        logo_url: document.getElementById('storeLogoInput').value.trim() || null
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
    if (smCategories.length === 0) { el.innerHTML = '<p style="font-size:12px;color:#94A3B8;">尚無分大類</p>'; return; }
    el.innerHTML = smCategories.map(c => {
        const tp = c.time_periods;
        const timeStr = tp && tp.length > 0
            ? tp.map(p => `${p.label || ''} ${p.from}-${p.to}`).join(', ')
            : '全天';
        return `<div style="display:flex;justify-content:space-between;align-items:center;padding:6px 0;border-bottom:1px solid #F1F5F9;">
            <div>
                <span style="font-size:13px;font-weight:600;">${escapeHTML(c.name)}</span>
                <span style="font-size:10px;color:#94A3B8;margin-left:6px;">🕐 ${escapeHTML(timeStr)}</span>
            </div>
            <div style="display:flex;gap:8px;">
                <button onclick="renameMenuCategory('${c.id}','${escapeHTML(c.name)}')" style="background:none;border:none;color:#4F46E5;cursor:pointer;font-size:12px;font-weight:600;">編輯</button>
                <button onclick="editCategoryTime('${c.id}')" style="background:none;border:none;color:#7C3AED;cursor:pointer;font-size:12px;">時段</button>
                <button onclick="deleteMenuCategory('${c.id}')" style="background:none;border:none;color:#EF4444;cursor:pointer;font-size:12px;">刪除</button>
            </div>
        </div>`;
    }).join('');
}

function updateMiCategorySelect() {
    document.getElementById('miCategory').innerHTML = '<option value="">-- 未分類 --</option>' +
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

export async function renameMenuCategory(id, currentName) {
    const newName = prompt('修改分大類名稱：', currentName);
    if (!newName || newName.trim() === '' || newName.trim() === currentName) return;
    try {
        await sb.from('menu_categories').update({ name: newName.trim() }).eq('id', id);
        showToast('✅ 已修改');
        await loadMenuCategories();
    } catch(e) { showToast('❌ 修改失敗'); }
}

export async function deleteMenuCategory(id) {
    if (!confirm('確定刪除此分大類？（品項不會被刪除）')) return;
    try { await sb.from('menu_categories').delete().eq('id', id); showToast('✅ 已刪除'); await loadMenuCategories(); }
    catch(e) { showToast('❌ 刪除失敗'); }
}

export function editCategoryTime(catId) {
    const cat = smCategories.find(c => c.id === catId);
    if (!cat) return;
    const periods = cat.time_periods || [];
    const presets = [
        { label: '全天候（清除時段）', value: 'all' },
        { label: '早餐 06:00-10:30', value: JSON.stringify([{ label: '早餐', from: '06:00', to: '10:30' }]) },
        { label: '午餐 11:00-14:00', value: JSON.stringify([{ label: '午餐', from: '11:00', to: '14:00' }]) },
        { label: '下午茶 14:00-17:00', value: JSON.stringify([{ label: '下午茶', from: '14:00', to: '17:00' }]) },
        { label: '晚餐 17:00-21:00', value: JSON.stringify([{ label: '晚餐', from: '17:00', to: '21:00' }]) },
        { label: '全日餐 11:00-21:00', value: JSON.stringify([{ label: '全日', from: '11:00', to: '21:00' }]) },
    ];
    const current = periods.length > 0 ? periods.map(p => `${p.label || ''} ${p.from}-${p.to}`).join(', ') : '全天候';
    const msg = `「${cat.name}」目前時段：${current}\n\n選擇預設時段（輸入數字）或輸入自訂時段（格式：HH:MM-HH:MM）\n\n` +
        presets.map((p, i) => `${i + 1}. ${p.label}`).join('\n');
    const input = prompt(msg, '1');
    if (input === null) return;
    const idx = parseInt(input) - 1;
    let newPeriods = null;
    if (idx >= 0 && idx < presets.length) {
        newPeriods = presets[idx].value === 'all' ? null : JSON.parse(presets[idx].value);
    } else {
        // Custom: parse "HH:MM-HH:MM" or "HH:MM-HH:MM,HH:MM-HH:MM"
        const parts = input.split(',').map(s => s.trim());
        newPeriods = parts.map(p => {
            const m = p.match(/(\d{1,2}:\d{2})\s*-\s*(\d{1,2}:\d{2})/);
            return m ? { from: m[1], to: m[2], label: '' } : null;
        }).filter(Boolean);
        if (newPeriods.length === 0) { showToast('格式錯誤'); return; }
    }
    saveCategoryTime(catId, newPeriods);
}

async function saveCategoryTime(catId, timePeriods) {
    try {
        await sb.from('menu_categories').update({ time_periods: timePeriods }).eq('id', catId);
        showToast('✅ 時段已更新');
        await loadMenuCategories();
    } catch(e) { showToast('❌ 更新失敗'); }
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
        ${s.store_slug ? '<div>商店代號：' + escapeHTML(s.store_slug) + '</div>' : ''}
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
    // 優先讀取會員 tab 的欄位（rdLoyaltySpend2），如果沒有就 fallback 到舊版 id
    const config = {
        spend_per_point: parseInt(document.getElementById('rdLoyaltySpend2')?.value || document.getElementById('rdLoyaltySpend')?.value) || 50,
        points_to_redeem: parseInt(document.getElementById('rdLoyaltyPoints2')?.value || document.getElementById('rdLoyaltyPoints')?.value) || 10,
        discount_amount: parseInt(document.getElementById('rdLoyaltyDiscount2')?.value || document.getElementById('rdLoyaltyDiscount')?.value) || 50
    };
    try {
        await sb.from('store_profiles').update({ loyalty_config: config, updated_at: new Date().toISOString() }).eq('id', rdCurrentStoreId);
        const s = smStores.find(x => x.id === rdCurrentStoreId);
        if (s) s.loyalty_config = config;
        showToast('✅ 集點設定已儲存');
    } catch(e) { showToast('❌ 儲存失敗'); }
}

// ===== 桌號 QR Code 產生 =====
function toLiffUrl(directUrl) {
    const liffId = typeof CONFIG !== 'undefined' && CONFIG.LIFF_ID ? CONFIG.LIFF_ID : null;
    if (!liffId) return directUrl;
    // 取出 path + query（order.html?store=xxx&mode=xxx）
    const match = directUrl.match(/\/([^/]+\.html\?.*)$/);
    if (!match) return directUrl;
    return 'https://liff.line.me/' + liffId + '/' + match[1];
}

export function generateTableQRCodes() {
    const s = smStores.find(x => x.id === rdCurrentStoreId);
    if (!s) return showToast('找不到商店資料');
    const count = parseInt(document.getElementById('rdTableCount').value) || 6;
    if (count < 1 || count > 50) return showToast('桌數請輸入 1~50');

    const baseUrl = getStoreOrderUrl(s).split('?')[0] + '?store=' + (s.store_slug || s.id);
    const grid = document.getElementById('rdTableQRGrid');
    grid.innerHTML = '';
    document.getElementById('rdTableQRList').style.display = 'block';

    if (typeof QRCode === 'undefined') {
        grid.innerHTML = '<p style="color:#DC2626;grid-column:1/-1;">QRCode 元件未載入</p>';
        return;
    }

    // 外帶 QR
    const takeoutCard = createQRCard('外帶點餐', toLiffUrl(baseUrl + '&mode=takeout'));
    grid.appendChild(takeoutCard);

    // 每桌 QR
    for (let i = 1; i <= count; i++) {
        const card = createQRCard('桌 ' + i, toLiffUrl(baseUrl + '&mode=dine-in&table=' + i));
        grid.appendChild(card);
    }
}

function createQRCard(label, url) {
    const card = document.createElement('div');
    card.className = 'qr-card';
    card.style.cssText = 'background:#fff;border:1px solid #E2E8F0;border-radius:10px;padding:10px;text-align:center;';
    card.innerHTML =
        '<div style="font-weight:700;font-size:13px;margin-bottom:6px;color:#4F46E5;">' + label + '</div>' +
        '<div class="qr-img"></div>' +
        '<div style="font-size:10px;color:#06C755;font-weight:700;margin-top:6px;">📱 請用 LINE 掃描</div>';
    new QRCode(card.querySelector('.qr-img'), { text: url, width: 140, height: 140 });
    return card;
}

export function printTableQRCodes() {
    const grid = document.getElementById('rdTableQRGrid');
    if (!grid) return;
    const w = window.open('', '_blank');
    const storeName = smStores.find(x => x.id === rdCurrentStoreId)?.store_name || '';
    w.document.write('<html><head><title>桌號 QR Code</title><style>body{font-family:sans-serif;padding:20px;}' +
        '.grid{display:grid;grid-template-columns:repeat(3,1fr);gap:16px;}' +
        '.card{border:2px solid #ddd;border-radius:12px;padding:14px;text-align:center;break-inside:avoid;}' +
        '.card h3{margin:0 0 8px;font-size:18px;color:#4F46E5;}' +
        '.card img{width:160px;height:160px;}' +
        '.card .line-hint{font-size:12px;color:#06C755;font-weight:700;margin-top:8px;}' +
        '@media print{body{padding:0;}.grid{gap:8px;}.card{border:1px solid #999;}}</style></head><body>');
    w.document.write('<h2 style="text-align:center;margin-bottom:16px;">' + escapeHTML(storeName) + ' — QR Code</h2>');
    w.document.write('<div class="grid">');
    grid.querySelectorAll('.qr-card').forEach(c => {
        const label = c.querySelector('div').textContent;
        const img = c.querySelector('.qr-img img') || c.querySelector('.qr-img canvas');
        let imgSrc = '';
        if (img && img.tagName === 'IMG') imgSrc = img.src;
        else if (img && img.tagName === 'CANVAS') imgSrc = img.toDataURL();
        w.document.write('<div class="card"><h3>' + label + '</h3>' + (imgSrc ? '<img src="' + imgSrc + '">' : '') + '<div class="line-hint">📱 請用 LINE 掃描</div></div>');
    });
    w.document.write('</div></body></html>');
    w.document.close();
    setTimeout(() => w.print(), 500);
}

// ===== AI 菜單辨識 =====
let _aiMenuData = null;
let _aiMenuBase64 = null;

export function handleMenuPhotoUpload(input) {
    const file = input.files[0];
    if (!file) return;
    if (file.size > 10 * 1024 * 1024) {
        showToast('圖片不能超過 10MB');
        input.value = '';
        return;
    }
    const reader = new FileReader();
    reader.onload = (e) => {
        const dataUrl = e.target.result;
        _aiMenuBase64 = dataUrl.split(',')[1];
        document.getElementById('menuPhotoImg').src = dataUrl;
        document.getElementById('menuPhotoPreview').style.display = 'block';
        document.getElementById('menuAIResult').style.display = 'none';
        document.getElementById('menuPhotoStatus').textContent = '';
    };
    reader.readAsDataURL(file);
}

export async function analyzeMenuPhoto() {
    if (!_aiMenuBase64) return showToast('請先選擇圖片');
    const btn = document.getElementById('menuPhotoAnalyzeBtn');
    const status = document.getElementById('menuPhotoStatus');
    btn.disabled = true;
    btn.textContent = '🤖 AI 辨識中...';
    status.textContent = '正在上傳圖片並分析，約需 10-30 秒...';

    try {
        const fnUrl = CONFIG.SUPABASE_URL + '/functions/v1/analyze-menu';
        const res = await fetch(fnUrl, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': 'Bearer ' + CONFIG.SUPABASE_ANON_KEY
            },
            body: JSON.stringify({ image_base64: _aiMenuBase64 })
        });
        const json = await res.json();
        if (!json.success || !json.data) {
            throw new Error(json.error || 'AI 回傳格式錯誤');
        }
        _aiMenuData = json.data;
        renderAIMenuPreview(_aiMenuData);
        status.textContent = '';
    } catch (err) {
        status.textContent = '❌ ' + err.message;
        showToast('辨識失敗：' + err.message);
    } finally {
        btn.disabled = false;
        btn.textContent = '🤖 AI 辨識菜單';
    }
}

function renderAIMenuPreview(data) {
    // Categories
    const catEl = document.getElementById('menuAICategories');
    const cats = data.categories || [];
    catEl.innerHTML = '<div style="font-size:12px;color:#64748B;margin-bottom:4px;">分類 (' + cats.length + ')</div>' +
        '<div style="display:flex;flex-wrap:wrap;gap:4px;">' +
        cats.map(c => '<span style="background:#EEF2FF;color:#4F46E5;padding:3px 8px;border-radius:12px;font-size:11px;font-weight:600;">' +
            (c.icon || '') + ' ' + escapeHTML(c.name) + '</span>').join('') +
        '</div>';

    // Items
    const itemEl = document.getElementById('menuAIItems');
    const items = data.items || [];
    itemEl.innerHTML = items.map((it, i) => {
        let sizeText = '';
        if (it.sizes && it.sizes.length > 0) {
            sizeText = it.sizes.map(s => s.name + ' $' + s.price).join(' / ');
        }
        return '<div style="padding:8px 10px;border-bottom:1px solid #F1F5F9;font-size:12px;display:flex;justify-content:space-between;align-items:center;">' +
            '<div>' +
                '<span style="font-weight:600;">' + escapeHTML(it.name) + '</span>' +
                (it.description ? '<span style="color:#94A3B8;margin-left:6px;">' + escapeHTML(it.description) + '</span>' : '') +
                (it.tags && it.tags.length ? it.tags.map(t => ' <span style="background:#FEF3C7;color:#D97706;padding:1px 5px;border-radius:8px;font-size:10px;">' + escapeHTML(t) + '</span>').join('') : '') +
                (sizeText ? '<div style="color:#6366F1;font-size:10px;margin-top:2px;">' + escapeHTML(sizeText) + '</div>' : '') +
            '</div>' +
            '<span style="font-weight:700;color:#059669;white-space:nowrap;">$' + (it.price || 0) + '</span>' +
        '</div>';
    }).join('');

    document.getElementById('menuAIResult').style.display = 'block';
    showToast('辨識完成！共 ' + cats.length + ' 分類、' + items.length + ' 品項');
}

export async function confirmAIMenu() {
    if (!_aiMenuData) return;
    const storeId = rdCurrentStoreId;
    if (!storeId) return showToast('請先選擇商店');

    const cats = _aiMenuData.categories || [];
    const items = _aiMenuData.items || [];
    if (items.length === 0) return showToast('沒有可匯入的品項');

    if (!confirm('確定要匯入 ' + cats.length + ' 個分類、' + items.length + ' 個品項嗎？\n（現有菜單不會被刪除，會新增在後面）')) return;

    try {
        showToast('匯入中...');
        // 1. Insert categories and build name → id mapping
        const catMap = {};
        for (let i = 0; i < cats.length; i++) {
            const c = cats[i];
            const catName = (c.icon ? c.icon + ' ' : '') + c.name;
            const { data, error } = await sb.from('menu_categories')
                .insert({ store_id: storeId, name: catName, sort_order: 100 + i })
                .select('id').single();
            if (error) throw error;
            catMap[c.name] = data.id;
        }

        // 2. Insert items
        for (let i = 0; i < items.length; i++) {
            const it = items[i];
            const catId = catMap[it.category] || Object.values(catMap)[0] || null;
            const opts = [];
            // sizes → option group
            if (it.sizes && it.sizes.length > 0) {
                opts.push({
                    group: '尺寸',
                    required: true,
                    items: it.sizes.map(s => ({ name: s.name, price: s.price || 0 }))
                });
            }
            // options
            if (it.options && it.options.length > 0) {
                it.options.forEach(og => {
                    opts.push({
                        group: og.group,
                        required: og.required || false,
                        items: (og.items || []).map(oi => ({ name: oi.name, price: oi.price || 0 }))
                    });
                });
            }

            const row = {
                store_id: storeId,
                category_id: catId,
                name: it.name,
                description: it.description || '',
                price: it.price || 0,
                sort_order: i + 1,
                is_available: true
            };
            if (opts.length > 0) row.options = opts;
            if (it.tags && it.tags.length > 0) row.tags = it.tags;

            const { error } = await sb.from('menu_items').insert(row);
            if (error) throw error;
        }

        showToast('✅ 匯入完成！' + cats.length + ' 分類、' + items.length + ' 品項');
        cancelAIMenu();
        // Reload menu
        loadMenuCategories(storeId);
        loadMenuItems(storeId);
    } catch (err) {
        showToast('匯入失敗：' + err.message);
    }
}

export function cancelAIMenu() {
    _aiMenuData = null;
    _aiMenuBase64 = null;
    document.getElementById('menuAIResult').style.display = 'none';
    document.getElementById('menuPhotoPreview').style.display = 'none';
    document.getElementById('menuPhotoInput').value = '';
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

// ===== 銷售報表 =====
let _dailyChart = null;
let _hourlyChart = null;
let _reportOrders = [];

export async function loadSalesReport() {
    const range = document.getElementById('reportRange')?.value || 'month';
    const fromEl = document.getElementById('reportFrom');
    const toEl = document.getElementById('reportTo');
    // Show/hide custom date inputs
    if (fromEl && toEl) {
        fromEl.style.display = range === 'custom' ? '' : 'none';
        toEl.style.display = range === 'custom' ? '' : 'none';
    }

    const now = new Date();
    let fromDate, toDate;
    if (range === 'today') {
        fromDate = fmtDate(now);
        toDate = fromDate;
    } else if (range === 'week') {
        const d = new Date(now); d.setDate(d.getDate() - d.getDay());
        fromDate = fmtDate(d);
        toDate = fmtDate(now);
    } else if (range === 'month') {
        fromDate = now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0') + '-01';
        toDate = fmtDate(now);
    } else {
        fromDate = fromEl?.value || fmtDate(now);
        toDate = toEl?.value || fmtDate(now);
    }

    try {
        const { data } = await sb.from('orders').select('*')
            .eq('store_id', rdCurrentStoreId)
            .gte('created_at', fromDate + 'T00:00:00')
            .lte('created_at', toDate + 'T23:59:59')
            .neq('status', 'cancelled')
            .order('created_at', { ascending: true });
        _reportOrders = data || [];
        renderSalesReport();
    } catch(e) { showToast('❌ 報表載入失敗'); console.error(e); }
}

function renderSalesReport() {
    const orders = _reportOrders;
    const revenue = orders.reduce((s, o) => s + (parseFloat(o.total) || 0), 0);
    const itemsSold = orders.reduce((s, o) => s + (o.items || []).reduce((ss, i) => ss + (i.qty || 1), 0), 0);
    const avg = orders.length > 0 ? Math.round(revenue / orders.length) : 0;

    document.getElementById('rptTotalRevenue').textContent = '$' + revenue.toLocaleString();
    document.getElementById('rptOrderCount').textContent = orders.length;
    document.getElementById('rptAvgOrder').textContent = '$' + avg.toLocaleString();
    document.getElementById('rptItemsSold').textContent = itemsSold;

    renderDailyChart(orders);
    renderHourlyChart(orders);
    renderTopItemsReport(orders);
    renderOrderTypes(orders);
}

function renderDailyChart(orders) {
    const daily = {};
    orders.forEach(o => {
        const d = o.created_at?.split('T')[0];
        if (d) daily[d] = (daily[d] || 0) + (parseFloat(o.total) || 0);
    });
    const labels = Object.keys(daily).sort();
    const data = labels.map(d => daily[d]);

    const ctx = document.getElementById('dailyRevenueChart');
    if (!ctx) return;
    if (_dailyChart) _dailyChart.destroy();
    _dailyChart = new Chart(ctx, {
        type: 'bar',
        data: {
            labels: labels.map(d => d.slice(5)), // MM-DD
            datasets: [{ label: '營業額', data, backgroundColor: '#3B82F6', borderRadius: 6 }]
        },
        options: {
            responsive: true,
            plugins: { legend: { display: false } },
            scales: { y: { beginAtZero: true, ticks: { callback: v => '$' + v } } }
        }
    });
}

function renderHourlyChart(orders) {
    const hourly = Array(24).fill(0);
    orders.forEach(o => {
        if (!o.created_at) return;
        const h = new Date(o.created_at).getHours();
        hourly[h] += (parseFloat(o.total) || 0);
    });
    const ctx = document.getElementById('hourlyChart');
    if (!ctx) return;
    if (_hourlyChart) _hourlyChart.destroy();
    _hourlyChart = new Chart(ctx, {
        type: 'line',
        data: {
            labels: Array.from({ length: 24 }, (_, i) => i + '時'),
            datasets: [{ label: '營業額', data: hourly, borderColor: '#8B5CF6', backgroundColor: 'rgba(139,92,246,0.1)', fill: true, tension: 0.3 }]
        },
        options: {
            responsive: true,
            plugins: { legend: { display: false } },
            scales: { y: { beginAtZero: true, ticks: { callback: v => '$' + v } } }
        }
    });
}

function renderTopItemsReport(orders) {
    const itemCount = {};
    const itemRevenue = {};
    orders.forEach(o => (o.items || []).forEach(i => {
        const name = i.name || '?';
        itemCount[name] = (itemCount[name] || 0) + (i.qty || 1);
        itemRevenue[name] = (itemRevenue[name] || 0) + (i.subtotal || i.price * (i.qty || 1) || 0);
    }));
    const sorted = Object.entries(itemCount).sort((a, b) => b[1] - a[1]).slice(0, 10);
    const el = document.getElementById('rptTopItems');
    if (!el) return;
    if (sorted.length === 0) { el.innerHTML = '<p style="color:#94A3B8;font-size:13px;">暫無資料</p>'; return; }
    el.innerHTML = sorted.map((s, i) => {
        const rev = itemRevenue[s[0]] || 0;
        const maxQty = sorted[0][1];
        const pct = Math.round(s[1] / maxQty * 100);
        return `<div style="display:flex;align-items:center;gap:8px;margin-bottom:6px;">
            <span style="font-weight:700;width:24px;text-align:right;font-size:13px;color:#64748B;">${i+1}</span>
            <div style="flex:1;">
                <div style="display:flex;justify-content:space-between;font-size:13px;margin-bottom:2px;">
                    <span style="font-weight:600;">${escapeHTML(s[0])}</span>
                    <span style="color:#64748B;">${s[1]}份 · $${rev.toLocaleString()}</span>
                </div>
                <div style="background:#E2E8F0;height:6px;border-radius:3px;overflow:hidden;">
                    <div style="background:#3B82F6;height:100%;width:${pct}%;border-radius:3px;"></div>
                </div>
            </div>
        </div>`;
    }).join('');
}

function renderOrderTypes(orders) {
    const types = {};
    orders.forEach(o => {
        const t = o.order_type || 'dine_in';
        types[t] = (types[t] || 0) + 1;
    });
    const labels = { dine_in: '內用', takeout: '外帶', delivery: '外送' };
    const colors = { dine_in: '#3B82F6', takeout: '#F59E0B', delivery: '#10B981' };
    const el = document.getElementById('rptOrderTypes');
    if (!el) return;
    const total = orders.length || 1;
    el.innerHTML = Object.entries(types).map(([k, v]) => {
        const pct = Math.round(v / total * 100);
        return `<div style="display:flex;align-items:center;gap:10px;margin-bottom:8px;">
            <span style="width:36px;font-size:13px;font-weight:600;">${labels[k] || k}</span>
            <div style="flex:1;background:#E2E8F0;height:24px;border-radius:12px;overflow:hidden;">
                <div style="background:${colors[k] || '#64748B'};height:100%;width:${pct}%;border-radius:12px;display:flex;align-items:center;justify-content:center;font-size:11px;color:#fff;font-weight:600;min-width:40px;">${pct}%</div>
            </div>
            <span style="font-size:13px;color:#64748B;width:40px;text-align:right;">${v}筆</span>
        </div>`;
    }).join('');
}

export function exportSalesCSV() {
    if (_reportOrders.length === 0) return showToast('無資料可匯出');
    const rows = [['訂單號', '日期', '時間', '類型', '品項', '金額', '狀態']];
    _reportOrders.forEach(o => {
        const dt = o.created_at ? new Date(o.created_at) : null;
        const dateStr = dt ? fmtDate(dt) : '';
        const timeStr = dt ? dt.toLocaleTimeString('zh-TW', { hour: '2-digit', minute: '2-digit' }) : '';
        const typeLabel = { dine_in: '內用', takeout: '外帶', delivery: '外送' };
        const items = (o.items || []).map(i => i.name + 'x' + (i.qty || 1)).join('; ');
        rows.push([o.order_number || '', dateStr, timeStr, typeLabel[o.order_type] || o.order_type || '', items, o.total || 0, o.status || '']);
    });
    const csv = rows.map(r => r.map(c => '"' + String(c).replace(/"/g, '""') + '"').join(',')).join('\n');
    const blob = new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'sales_report_' + fmtDate(new Date()) + '.csv';
    a.click();
    showToast('✅ 已匯出 CSV');
}

// ===== 會員管理 =====
let membersList = [];
let memberFilter = 'all';
let currentMemberPhone = null;
let adjustType = 'add';

export async function loadMembersTab() {
    await loadMemberStats();
    await loadMemberList();
    await loadTransactions();
    loadLoyaltyToggle();
    syncLoyaltyFields();
}

async function loadLoyaltyToggle() {
    const s = smStores.find(x => x.id === rdCurrentStoreId);
    const toggle = document.getElementById('loyaltyToggle');
    if (toggle && s) {
        toggle.checked = s.loyalty_enabled !== false;
        updateToggleStyle(toggle);
    }
}

function updateToggleStyle(toggle) {
    // 支援兩種 toggle 結構：
    // 1. 舊版：使用 left 定位
    // 2. 新版：使用 transform 定位
    const slider = toggle.parentElement.querySelectorAll('span');
    if (slider.length >= 2) {
        if (toggle.checked) {
            slider[0].style.background = '#4F46E5';
            // 嘗試兩種定位方式
            slider[1].style.left = '25px';
            slider[1].style.transform = 'translateX(22px)';
        } else {
            slider[0].style.background = '#CBD5E1';
            slider[1].style.left = '3px';
            slider[1].style.transform = 'translateX(0)';
        }
    }
}

export async function toggleLoyalty() {
    const toggle = document.getElementById('loyaltyToggle');
    updateToggleStyle(toggle);
    try {
        await sb.from('store_profiles')
            .update({ loyalty_enabled: toggle.checked, updated_at: new Date().toISOString() })
            .eq('id', rdCurrentStoreId);
        const s = smStores.find(x => x.id === rdCurrentStoreId);
        if (s) s.loyalty_enabled = toggle.checked;
        showToast(toggle.checked ? '✅ 集點功能已開啟' : '⏸️ 集點功能已暫停');
    } catch(e) { showToast('❌ 操作失敗'); }
}

function syncLoyaltyFields() {
    const s = smStores.find(x => x.id === rdCurrentStoreId);
    const cfg = s?.loyalty_config || {};
    const spend2 = document.getElementById('rdLoyaltySpend2');
    const points2 = document.getElementById('rdLoyaltyPoints2');
    const discount2 = document.getElementById('rdLoyaltyDiscount2');
    if (spend2) spend2.value = cfg.spend_per_point || '';
    if (points2) points2.value = cfg.points_to_redeem || '';
    if (discount2) discount2.value = cfg.discount_amount || '';
}

async function loadMemberStats() {
    const el = document.getElementById('memberStats');
    try {
        const { data, count } = await sb.from('store_customers')
            .select('*', { count: 'exact' })
            .eq('store_id', rdCurrentStoreId);

        const total = count || 0;
        const blacklisted = (data || []).filter(c => c.is_blacklisted).length;
        const totalSpent = (data || []).reduce((sum, c) => sum + parseFloat(c.total_spent || 0), 0);
        const vip = (data || []).filter(c => (c.total_orders || 0) >= 5).length;

        el.innerHTML = [
            { label: '總會員', value: total, color: '#4F46E5', bg: '#EEF2FF' },
            { label: '常客 ⭐', value: vip, color: '#059669', bg: '#D1FAE5' },
            { label: '黑名單', value: blacklisted, color: '#DC2626', bg: '#FEE2E2' },
            { label: '總營收', value: '$' + Math.round(totalSpent).toLocaleString(), color: '#D97706', bg: '#FEF3C7' }
        ].map(s =>
            '<div style="background:' + s.bg + ';border-radius:10px;padding:10px;text-align:center;">' +
            '<div style="font-size:18px;font-weight:800;color:' + s.color + ';">' + s.value + '</div>' +
            '<div style="font-size:10px;color:' + s.color + ';opacity:0.7;">' + s.label + '</div></div>'
        ).join('');
    } catch(e) { el.innerHTML = ''; }
}

export async function loadMemberList() {
    try {
        let query = sb.from('store_customers')
            .select('*')
            .eq('store_id', rdCurrentStoreId)
            .order('updated_at', { ascending: false })
            .limit(100);

        const { data } = await query;
        membersList = data || [];
        renderMemberList();
    } catch(e) { console.warn('Load members error:', e); }
}

export function searchMembers() {
    const q = document.getElementById('memberSearchInput').value.trim().toLowerCase();
    renderMemberList(q);
}

export function filterMembers(filter, el) {
    memberFilter = filter;
    document.querySelectorAll('.memberFilterBtn').forEach(b => {
        b.style.borderBottom = 'none'; b.style.color = '#94A3B8'; b.classList.remove('memberFilterActive');
    });
    if (el) { el.style.borderBottom = '2px solid #4F46E5'; el.style.color = '#4F46E5'; }
    renderMemberList();
}

function renderMemberList(searchQuery) {
    let filtered = membersList;
    if (memberFilter === 'vip') filtered = filtered.filter(c => (c.total_orders || 0) >= 5);
    if (memberFilter === 'blacklist') filtered = filtered.filter(c => c.is_blacklisted);
    if (searchQuery) {
        filtered = filtered.filter(c =>
            (c.phone || '').includes(searchQuery) ||
            (c.name || '').toLowerCase().includes(searchQuery)
        );
    }

    const el = document.getElementById('memberList');
    if (filtered.length === 0) {
        el.innerHTML = '<div style="text-align:center;padding:24px;color:#94A3B8;font-size:13px;">沒有符合的會員</div>';
        return;
    }

    el.innerHTML = filtered.map(c => {
        const isBlack = c.is_blacklisted;
        const isVip = (c.total_orders || 0) >= 5;
        const tags = [];
        if (isVip) tags.push('<span style="background:#D1FAE5;color:#065F46;padding:2px 6px;border-radius:4px;font-size:10px;">⭐ 常客</span>');
        if (isBlack) tags.push('<span style="background:#FEE2E2;color:#991B1B;padding:2px 6px;border-radius:4px;font-size:10px;">🚫 黑名單</span>');
        if (c.no_show_count > 0 && !isBlack) tags.push('<span style="background:#FEF3C7;color:#92400E;padding:2px 6px;border-radius:4px;font-size:10px;">⚠️ 未取餐x' + c.no_show_count + '</span>');

        const lastDate = c.updated_at ? new Date(c.updated_at).toLocaleDateString('zh-TW') : '-';

        return '<div onclick="openMemberDetail(\'' + esc(c.phone).replace(/'/g, "\\'") + '\')" style="display:flex;align-items:center;gap:10px;padding:12px 14px;border-bottom:1px solid #F1F5F9;cursor:pointer;transition:background 0.15s;' + (isBlack ? 'opacity:0.6;' : '') + '" onmouseover="this.style.background=\'#F8FAFC\'" onmouseout="this.style.background=\'\'">' +
            '<div style="width:40px;height:40px;border-radius:50%;background:#EEF2FF;display:flex;align-items:center;justify-content:center;font-size:16px;flex-shrink:0;">' + (isBlack ? '🚫' : (isVip ? '⭐' : '👤')) + '</div>' +
            '<div style="flex:1;min-width:0;">' +
                '<div style="display:flex;align-items:center;gap:6px;">' +
                    '<span style="font-weight:700;font-size:14px;">' + esc(c.name || '未命名') + '</span>' +
                    tags.join('') +
                '</div>' +
                '<div style="font-size:12px;color:#94A3B8;">' + esc(c.phone || '') + '</div>' +
            '</div>' +
            '<div style="text-align:right;flex-shrink:0;">' +
                '<div style="font-size:13px;font-weight:700;">' + (c.total_orders || 0) + ' 單</div>' +
                '<div style="font-size:11px;color:#94A3B8;">' + lastDate + '</div>' +
            '</div>' +
        '</div>';
    }).join('');
}

export async function openMemberDetail(phone) {
    currentMemberPhone = phone;
    const c = membersList.find(m => m.phone === phone);
    if (!c) return;

    document.getElementById('memberDetailTitle').textContent = (c.name || '未命名') + ' 的會員資料';

    // 基本資訊
    let ptsText = '-';
    try {
        const { data } = await sb.from('loyalty_points')
            .select('points')
            .eq('store_id', rdCurrentStoreId)
            .eq('customer_line_id', phone)
            .limit(1);
        if (data && data[0]) ptsText = data[0].points + ' 點';
    } catch(e) {}

    document.getElementById('memberDetailInfo').innerHTML =
        '<div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;">' +
            '<div>📱 <b>' + esc(c.phone || '') + '</b></div>' +
            '<div>🎯 <b>' + ptsText + '</b></div>' +
            '<div>📦 累計 <b>' + (c.total_orders || 0) + '</b> 筆</div>' +
            '<div>💰 消費 <b>$' + Math.round(c.total_spent || 0).toLocaleString() + '</b></div>' +
            (c.no_show_count > 0 ? '<div style="grid-column:1/-1;color:#DC2626;">⚠️ 未取餐 <b>' + c.no_show_count + '</b> 次</div>' : '') +
        '</div>' +
        (c.favorite_items && c.favorite_items.length > 0 ?
            '<div style="margin-top:8px;padding-top:8px;border-top:1px solid #E2E8F0;font-size:12px;">⭐ 常點：' +
            c.favorite_items.slice(0, 5).map(f => esc(f.name) + '(' + f.count + ')').join('、') + '</div>' : '');

    // 黑名單
    const bSection = document.getElementById('memberBlacklistSection');
    const bStatus = document.getElementById('memberBlacklistStatus');
    const bBtn = document.getElementById('blacklistToggleBtn');
    if (c.is_blacklisted) {
        bSection.style.background = '#FEF2F2';
        bStatus.innerHTML = '🚫 已列入黑名單<br><span style="font-size:11px;color:#94A3B8;">' + esc(c.blacklist_reason || '') + '</span>';
        bBtn.textContent = '✅ 解除黑名單';
        bBtn.style.background = '#10B981'; bBtn.style.color = '#fff';
    } else {
        bSection.style.background = '#F0FDF4';
        bStatus.innerHTML = '✅ 正常狀態（未取餐 ' + (c.no_show_count || 0) + ' 次）';
        bBtn.textContent = '🚫 加入黑名單';
        bBtn.style.background = '#EF4444'; bBtn.style.color = '#fff';
    }

    // 異動紀錄
    await loadMemberTransactions(phone);

    // Reset adjust form
    adjustType = 'add';
    setAdjustType('add');
    document.getElementById('adjPoints').value = '';
    document.getElementById('adjNote').value = '';

    // Show modal
    document.getElementById('memberDetailModal').style.display = 'flex';
}

export function closeMemberDetail() {
    document.getElementById('memberDetailModal').style.display = 'none';
    currentMemberPhone = null;
}

export function setAdjustType(type) {
    adjustType = type;
    const addBtn = document.getElementById('adjAddBtn');
    const dedBtn = document.getElementById('adjDeductBtn');
    if (type === 'add') {
        addBtn.style.borderColor = '#10B981'; addBtn.style.background = '#D1FAE5'; addBtn.style.color = '#065F46';
        dedBtn.style.borderColor = '#E2E8F0'; dedBtn.style.background = '#fff'; dedBtn.style.color = '#64748B';
    } else {
        dedBtn.style.borderColor = '#EF4444'; dedBtn.style.background = '#FEE2E2'; dedBtn.style.color = '#991B1B';
        addBtn.style.borderColor = '#E2E8F0'; addBtn.style.background = '#fff'; addBtn.style.color = '#64748B';
    }
}

export async function submitAdjustPoints() {
    const pts = parseInt(document.getElementById('adjPoints').value);
    const note = document.getElementById('adjNote').value.trim();
    if (!pts || pts <= 0) { showToast('請輸入正整數'); return; }
    if (!note) { showToast('請填寫原因備註'); return; }
    if (!currentMemberPhone) return;

    const actualPts = adjustType === 'deduct' ? -pts : pts;

    try {
        // 1. 更新 loyalty_points
        const { data: existing } = await sb.from('loyalty_points')
            .select('*')
            .eq('store_id', rdCurrentStoreId)
            .eq('customer_line_id', currentMemberPhone)
            .limit(1);

        let newBalance = 0;
        if (existing && existing[0]) {
            newBalance = Math.max(0, (existing[0].points || 0) + actualPts);
            await sb.from('loyalty_points')
                .update({ points: newBalance, updated_at: new Date().toISOString() })
                .eq('id', existing[0].id);
        } else if (adjustType === 'add') {
            newBalance = pts;
            await sb.from('loyalty_points').insert({
                store_id: rdCurrentStoreId,
                customer_line_id: currentMemberPhone,
                points: pts,
                total_earned: pts
            });
        }

        // 2. 寫異動紀錄
        await sb.from('loyalty_transactions').insert({
            store_id: rdCurrentStoreId,
            customer_phone: currentMemberPhone,
            type: adjustType === 'add' ? 'manual_add' : 'manual_deduct',
            points: actualPts,
            balance_after: newBalance,
            note: note,
            operator_name: window.currentEmployee?.name || '管理員'
        });

        showToast('✅ ' + (adjustType === 'add' ? '加' : '扣') + ' ' + pts + ' 點成功，餘額 ' + newBalance + ' 點');
        openMemberDetail(currentMemberPhone);
        loadMemberStats();

    } catch(e) { showToast('❌ 操作失敗：' + (e.message || e)); }
}

export async function toggleBlacklist() {
    if (!currentMemberPhone) return;
    const c = membersList.find(m => m.phone === currentMemberPhone);
    if (!c) return;

    const newStatus = !c.is_blacklisted;
    const reason = newStatus ? prompt('請輸入黑名單原因：', '多次未取餐') : null;
    if (newStatus && !reason) return;

    try {
        await sb.from('store_customers')
            .update({
                is_blacklisted: newStatus,
                blacklisted_at: newStatus ? new Date().toISOString() : null,
                blacklist_reason: newStatus ? reason : null,
                updated_at: new Date().toISOString()
            })
            .eq('id', c.id);

        c.is_blacklisted = newStatus;
        c.blacklist_reason = newStatus ? reason : null;
        showToast(newStatus ? '🚫 已加入黑名單' : '✅ 已解除黑名單');
        openMemberDetail(currentMemberPhone);
        loadMemberStats();
        renderMemberList();
    } catch(e) { showToast('❌ 操作失敗'); }
}

export async function loadTransactions() {
    const el = document.getElementById('transactionList');
    try {
        const { data } = await sb.from('loyalty_transactions')
            .select('*')
            .eq('store_id', rdCurrentStoreId)
            .order('created_at', { ascending: false })
            .limit(30);

        if (!data || data.length === 0) {
            el.innerHTML = '<div style="text-align:center;padding:16px;color:#94A3B8;font-size:12px;">尚無異動紀錄</div>';
            return;
        }

        el.innerHTML = data.map(tx => renderTxRow(tx)).join('');
    } catch(e) { el.innerHTML = ''; }
}

async function loadMemberTransactions(phone) {
    const el = document.getElementById('memberTxList');
    try {
        const { data } = await sb.from('loyalty_transactions')
            .select('*')
            .eq('store_id', rdCurrentStoreId)
            .eq('customer_phone', phone)
            .order('created_at', { ascending: false })
            .limit(20);

        if (!data || data.length === 0) {
            el.innerHTML = '<div style="text-align:center;padding:12px;color:#94A3B8;">尚無紀錄</div>';
            return;
        }
        el.innerHTML = data.map(tx => renderTxRow(tx)).join('');
    } catch(e) { el.innerHTML = ''; }
}

const TX_TYPE_MAP = {
    earn: { label: '消費集點', icon: '🛒', color: '#059669' },
    manual_add: { label: '手動加點', icon: '➕', color: '#4F46E5' },
    manual_deduct: { label: '手動扣點', icon: '➖', color: '#DC2626' },
    redeem: { label: '兌換折扣', icon: '🎁', color: '#D97706' },
    expire: { label: '點數過期', icon: '⏰', color: '#94A3B8' }
};

function renderTxRow(tx) {
    const t = TX_TYPE_MAP[tx.type] || { label: tx.type, icon: '📝', color: '#64748B' };
    const d = new Date(tx.created_at);
    const dateStr = (d.getMonth()+1) + '/' + d.getDate() + ' ' + String(d.getHours()).padStart(2,'0') + ':' + String(d.getMinutes()).padStart(2,'0');
    const ptsStr = tx.points > 0 ? '+' + tx.points : String(tx.points);

    return '<div style="display:flex;align-items:center;gap:8px;padding:8px 0;border-bottom:1px solid #F1F5F9;font-size:12px;">' +
        '<span>' + t.icon + '</span>' +
        '<div style="flex:1;">' +
            '<div style="font-weight:600;">' + t.label + (tx.customer_phone ? ' · ' + esc(tx.customer_phone) : '') + '</div>' +
            (tx.note ? '<div style="color:#94A3B8;font-size:11px;">' + esc(tx.note) + '</div>' : '') +
        '</div>' +
        '<div style="text-align:right;">' +
            '<div style="font-weight:700;color:' + t.color + ';">' + ptsStr + ' 點</div>' +
            '<div style="color:#94A3B8;font-size:10px;">' + dateStr + '</div>' +
        '</div>' +
    '</div>';
}

// ============================================================
// 預約管理（獨立頁面）
// ============================================================
let bookingCurrentStoreId = null;
let bookingCurrentFilter = 'today';

export async function loadBookingForStore() {
    const sel = document.getElementById('bookingStoreSelect');
    bookingCurrentStoreId = sel.value;
    const content = document.getElementById('bookingContent');
    if (!bookingCurrentStoreId) {
        content.style.display = 'none';
        return;
    }
    content.style.display = 'block';
    // 預設顯示預約列表 tab
    switchBookingTab('list');
}

export function switchBookingTab(tab) {
    const tabs = ['list', 'services', 'staff'];
    const tabBtns = { list: 'bTabList', services: 'bTabServices', staff: 'bTabStaff' };
    const tabDivs = { list: 'bookingTabList', services: 'bookingTabServices', staff: 'bookingTabStaff' };

    tabs.forEach(t => {
        const btn = document.getElementById(tabBtns[t]);
        const div = document.getElementById(tabDivs[t]);
        if (!btn || !div) return;
        const isActive = t === tab;
        btn.style.background = isActive ? '#fff' : 'transparent';
        btn.style.color = isActive ? '#1E293B' : '#64748B';
        btn.style.boxShadow = isActive ? '0 1px 3px rgba(0,0,0,0.1)' : 'none';
        div.style.display = isActive ? '' : 'none';
    });

    if (tab === 'list') loadBookingList(bookingCurrentFilter);
    else if (tab === 'services') loadBookingServices(bookingCurrentStoreId);
    else if (tab === 'staff') loadBookingStaff(bookingCurrentStoreId);
}

export async function loadBookingList(dateFilter) {
    bookingCurrentFilter = dateFilter || 'today';
    const storeId = bookingCurrentStoreId;
    if (!storeId) return;

    // 更新篩選按鈕樣式
    ['today','tomorrow','week','all'].forEach(f => {
        const btn = document.getElementById('bFilter' + f.charAt(0).toUpperCase() + f.slice(1));
        if (!btn) return;
        const active = f === bookingCurrentFilter;
        btn.style.background = active ? '#3B82F6' : '#fff';
        btn.style.color = active ? '#fff' : '#64748B';
        btn.style.borderColor = active ? '#3B82F6' : '#E2E8F0';
        btn.style.fontWeight = active ? '700' : '600';
    });

    const container = document.getElementById('bookingListContainer');
    container.innerHTML = '<p style="text-align:center;color:#94A3B8;padding:20px;">載入中...</p>';

    try {
        const today = new Date().toISOString().split('T')[0];
        let query = sb.from('bookings')
            .select('*, booking_services(name)')
            .eq('store_id', storeId);

        if (bookingCurrentFilter === 'today') {
            query = query.eq('booking_date', today);
        } else if (bookingCurrentFilter === 'tomorrow') {
            const tmr = new Date(); tmr.setDate(tmr.getDate() + 1);
            query = query.eq('booking_date', tmr.toISOString().split('T')[0]);
        } else if (bookingCurrentFilter === 'week') {
            const weekEnd = new Date(); weekEnd.setDate(weekEnd.getDate() + 7);
            query = query.gte('booking_date', today).lte('booking_date', weekEnd.toISOString().split('T')[0]);
        } else {
            query = query.gte('booking_date', today);
        }

        const { data: bookings, error } = await query.order('booking_date').order('booking_time');
        if (error) throw error;

        if (!bookings || bookings.length === 0) {
            container.innerHTML = '<p style="text-align:center;color:#94A3B8;padding:30px;">此期間沒有預約</p>';
            return;
        }

        const statusColors = { pending:'#F59E0B', confirmed:'#3B82F6', completed:'#10B981', cancelled:'#EF4444' };
        const statusLabels = { pending:'待確認', confirmed:'已確認', completed:'已完成', cancelled:'已取消' };

        let html = '';
        bookings.forEach(b => {
            const svcName = b.booking_services?.name || b.service_type || '';
            const statusColor = statusColors[b.status] || '#94A3B8';
            const statusLabel = statusLabels[b.status] || b.status;
            html += `<div style="padding:14px;background:#fff;border:1px solid #E2E8F0;border-radius:12px;margin-bottom:8px;">
  <div style="display:flex;justify-content:space-between;align-items:flex-start;">
    <div style="flex:1;">
      <div style="font-weight:700;font-size:15px;">${esc(b.customer_name)}</div>
      <div style="font-size:12px;color:#64748B;margin-top:2px;">📱 ${esc(b.customer_phone)}</div>
      <div style="font-size:12px;color:#94A3B8;margin-top:2px;">🗓 ${b.booking_date} ${b.booking_time ? b.booking_time.substring(0,5) : ''}</div>
      ${svcName ? `<div style="font-size:12px;color:#64748B;margin-top:2px;">🔧 ${esc(svcName)}</div>` : ''}
      ${b.notes ? `<div style="font-size:12px;color:#94A3B8;margin-top:2px;">💬 ${esc(b.notes)}</div>` : ''}
    </div>
    <div style="text-align:right;flex-shrink:0;margin-left:8px;">
      <div style="display:inline-block;padding:4px 10px;border-radius:20px;font-size:11px;font-weight:700;color:#fff;background:${statusColor};">${statusLabel}</div>
      ${b.status === 'pending' ? `
      <div style="margin-top:6px;display:flex;gap:4px;justify-content:flex-end;">
        <button onclick="updateBookingStatus('${b.id}','confirmed')" style="padding:4px 8px;border:none;border-radius:6px;background:#3B82F6;color:#fff;font-size:11px;font-weight:700;cursor:pointer;">✓ 確認</button>
        <button onclick="updateBookingStatus('${b.id}','cancelled')" style="padding:4px 8px;border:none;border-radius:6px;background:#EF4444;color:#fff;font-size:11px;font-weight:700;cursor:pointer;">✕ 取消</button>
      </div>` : ''}
      ${b.status === 'confirmed' ? `
      <div style="margin-top:6px;">
        <button onclick="updateBookingStatus('${b.id}','completed')" style="padding:4px 8px;border:none;border-radius:6px;background:#10B981;color:#fff;font-size:11px;font-weight:700;cursor:pointer;">✓ 完成</button>
      </div>` : ''}
    </div>
  </div>
</div>`;
        });
        container.innerHTML = html;
    } catch(e) {
        console.error('loadBookingList error:', e);
        container.innerHTML = '<p style="text-align:center;color:#EF4444;padding:20px;">載入失敗</p>';
    }
}

export async function updateBookingStatus(id, status) {
    try {
        const { error } = await sb.from('bookings').update({ status, updated_at: new Date().toISOString() }).eq('id', id);
        if (error) throw error;
        showToast('✅ 已更新狀態');
        loadBookingList(bookingCurrentFilter);
    } catch(e) {
        showToast('更新失敗');
    }
}

export async function loadBookingServices(storeId) {
    if (!storeId) return;
    const el = document.getElementById('bookingServiceList');
    el.innerHTML = '<p style="text-align:center;color:#94A3B8;padding:20px;">載入中...</p>';

    try {
        const { data: services, error } = await sb.from('booking_services')
            .select('*').eq('store_id', storeId).order('sort_order');
        if (error) throw error;

        if (!services || services.length === 0) {
            el.innerHTML = '<p style="text-align:center;color:#94A3B8;padding:20px;">尚無服務項目，請新增</p>';
            return;
        }

        el.innerHTML = services.map(s => `
<div style="padding:14px;background:#fff;border:1px solid #E2E8F0;border-radius:12px;margin-bottom:8px;display:flex;justify-content:space-between;align-items:center;">
  <div>
    <div style="font-weight:700;">${esc(s.name)}</div>
    <div style="font-size:12px;color:#64748B;margin-top:3px;">⏱ ${s.duration_minutes} 分鐘${s.price ? ' · $' + s.price : ' · 免費'}</div>
    ${s.description ? `<div style="font-size:11px;color:#94A3B8;margin-top:2px;">${esc(s.description)}</div>` : ''}
  </div>
  <div style="display:flex;align-items:center;gap:8px;flex-shrink:0;margin-left:8px;">
    <span style="font-size:12px;color:${s.is_active ? '#10B981' : '#94A3B8'};">${s.is_active ? '啟用' : '停用'}</span>
    <button onclick="deleteBookingService('${s.id}')" style="padding:4px 8px;border:none;border-radius:6px;background:#FEE2E2;color:#EF4444;font-size:12px;font-weight:600;cursor:pointer;">刪除</button>
  </div>
</div>`).join('');
    } catch(e) {
        el.innerHTML = '<p style="text-align:center;color:#EF4444;padding:20px;">載入失敗</p>';
    }
}

export async function addBookingService() {
    const storeId = bookingCurrentStoreId;
    if (!storeId) return;

    const name = prompt('服務名稱：');
    if (!name || !name.trim()) return;
    const duration = prompt('服務時長（分鐘）：', '30');
    const price = prompt('價格（留空=免費）：', '');
    const description = prompt('說明（選填）：', '');

    try {
        const { error } = await sb.from('booking_services').insert({
            store_id: storeId,
            name: name.trim(),
            duration_minutes: parseInt(duration) || 30,
            price: price && price.trim() ? parseInt(price) : null,
            description: description && description.trim() ? description.trim() : null,
            is_active: true
        });
        if (error) throw error;
        showToast('✅ 已新增服務');
        loadBookingServices(storeId);
    } catch(e) {
        showToast('新增失敗：' + (e.message || ''));
    }
}

export async function deleteBookingService(id) {
    if (!confirm('確定刪除此服務？')) return;
    try {
        const { error } = await sb.from('booking_services').delete().eq('id', id);
        if (error) throw error;
        showToast('✅ 已刪除');
        loadBookingServices(bookingCurrentStoreId);
    } catch(e) {
        showToast('刪除失敗');
    }
}

export async function loadBookingStaff(storeId) {
    if (!storeId) return;
    const el = document.getElementById('bookingStaffList');
    el.innerHTML = '<p style="text-align:center;color:#94A3B8;padding:20px;">載入中...</p>';

    try {
        const { data: staff, error } = await sb.from('booking_staff')
            .select('*').eq('store_id', storeId).order('sort_order');
        if (error) throw error;

        if (!staff || staff.length === 0) {
            el.innerHTML = '<p style="text-align:center;color:#94A3B8;padding:20px;">尚無服務人員，請新增</p>';
            return;
        }

        el.innerHTML = staff.map(s => `
<div style="padding:14px;background:#fff;border:1px solid #E2E8F0;border-radius:12px;margin-bottom:8px;display:flex;justify-content:space-between;align-items:center;">
  <div style="display:flex;align-items:center;gap:12px;">
    <div style="width:40px;height:40px;border-radius:20px;background:linear-gradient(135deg,#6366F1,#8B5CF6);display:flex;align-items:center;justify-content:center;color:#fff;font-weight:700;font-size:16px;flex-shrink:0;">${esc((s.display_name||'?').substring(0,1))}</div>
    <div>
      <div style="font-weight:700;">${esc(s.display_name)}</div>
      ${s.title ? `<div style="font-size:12px;color:#94A3B8;">${esc(s.title)}</div>` : ''}
      <div style="font-size:11px;color:${s.is_active ? '#10B981' : '#94A3B8'};margin-top:2px;">${s.is_active ? '啟用中' : '停用'}</div>
    </div>
  </div>
  <button onclick="deleteBookingStaff('${s.id}')" style="padding:4px 8px;border:none;border-radius:6px;background:#FEE2E2;color:#EF4444;font-size:12px;font-weight:600;cursor:pointer;flex-shrink:0;">刪除</button>
</div>`).join('');
    } catch(e) {
        el.innerHTML = '<p style="text-align:center;color:#EF4444;padding:20px;">載入失敗</p>';
    }
}

export async function addBookingStaff() {
    const storeId = bookingCurrentStoreId;
    if (!storeId) return;

    const name = prompt('人員姓名：');
    if (!name || !name.trim()) return;
    const title = prompt('職稱（選填，如：設計師、美甲師）：', '');

    try {
        const { error } = await sb.from('booking_staff').insert({
            store_id: storeId,
            display_name: name.trim(),
            title: title && title.trim() ? title.trim() : null,
            is_active: true
        });
        if (error) throw error;
        showToast('✅ 已新增人員');
        loadBookingStaff(storeId);
    } catch(e) {
        showToast('新增失敗：' + (e.message || ''));
    }
}

export async function deleteBookingStaff(id) {
    if (!confirm('確定刪除此人員？')) return;
    try {
        const { error } = await sb.from('booking_staff').delete().eq('id', id);
        if (error) throw error;
        showToast('✅ 已刪除');
        loadBookingStaff(bookingCurrentStoreId);
    } catch(e) {
        showToast('刪除失敗');
    }
}

// ============================================================
// 會員管理（獨立頁面）
// ============================================================
let memberCurrentStoreId = null;

export async function loadMembersForStore(storeId, skipLoading) {
    if (!storeId) {
        storeId = document.getElementById('memberStoreSelect')?.value;
    }
    memberCurrentStoreId = storeId;
    const content = document.getElementById('memberContent');
    if (!storeId || !content) return;

    content.style.display = '';
    if (!skipLoading) {
        content.innerHTML = '<p style="text-align:center;color:#999;padding:20px;">載入中...</p>';
    }

    try {
        // 同時查詢會員、集點設定、交易紀錄
        const [custResult, loyaltyResult, txResult] = await Promise.all([
            sb.from('store_customers').select('*').eq('store_id', storeId).order('updated_at', { ascending: false }),
            sb.from('loyalty_config').select('*').eq('store_id', storeId).maybeSingle(),
            sb.from('loyalty_transactions').select('customer_phone, type, points').eq('store_id', storeId)
        ]);

        let customers = custResult.data || [];
        const loyalty = loyaltyResult.data; // 可能是 null
        const txList = txResult.data || [];

        // 計算每個手機號碼的點數（從 loyalty_transactions）
        const pointsMap = {};
        txList.forEach(function(t) {
            if (!pointsMap[t.customer_phone]) pointsMap[t.customer_phone] = 0;
            if (t.type === 'earn') pointsMap[t.customer_phone] += (t.points || 0);
            else if (t.type === 'redeem') pointsMap[t.customer_phone] -= (t.points || 0);
        });

        // 過濾測試資料
        customers = customers.filter(function(c) { return !c.name?.startsWith('_'); });

        // 取得VIP門檻（從loyalty_config或localStorage）
        let vipThreshold = loyalty?.vip_threshold || parseInt(localStorage.getItem('vip_threshold_' + storeId)) || 10;

        let html = '';

        // ===== Tab 導航 =====
        html += '<div style="display:flex;gap:0;margin-bottom:16px;border-bottom:2px solid #E2E8F0;">';
        html += '<button id="tabMembers" onclick="switchMemberTab(\'members\')" style="flex:1;padding:12px;border:none;background:transparent;font-size:14px;font-weight:700;color:#6366F1;border-bottom:3px solid #6366F1;cursor:pointer;font-family:inherit;">👥 會員管理</button>';
        html += '<button id="tabPoints" onclick="switchMemberTab(\'points\')" style="flex:1;padding:12px;border:none;background:transparent;font-size:14px;font-weight:600;color:#94A3B8;border-bottom:3px solid transparent;cursor:pointer;font-family:inherit;">🎯 會員集點</button>';
        html += '</div>';

        // ===== 會員管理 Tab =====
        html += '<div id="membersMgrTab">';

        // ===== 集點設定區 =====
        html += '<div style="background:#F8FAFC;border-radius:14px;padding:16px;margin-bottom:16px;">';
        html += '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;">';
        html += '<div style="font-size:15px;font-weight:700;">🎯 集點設定</div>';
        // toggle
        html += '<label style="position:relative;display:inline-block;width:48px;height:26px;cursor:pointer;">';
        html += '<input type="checkbox" ' + (loyalty?.enabled ? 'checked' : '') + ' onchange="toggleLoyalty(\'' + storeId + '\', this.checked)" style="opacity:0;width:0;height:0;">';
        html += '<span style="position:absolute;top:0;left:0;right:0;bottom:0;background:' + (loyalty?.enabled ? '#6366F1' : '#CBD5E1') + ';border-radius:13px;transition:.3s;"></span>';
        html += '<span style="position:absolute;top:3px;left:' + (loyalty?.enabled ? '25px' : '3px') + ';width:20px;height:20px;background:#fff;border-radius:50%;transition:.3s;box-shadow:0 1px 3px rgba(0,0,0,.2);"></span>';
        html += '</label>';
        html += '</div>';

        // 集點規則 - inline 可編輯
        const dollarsPerPoint = loyalty ? Math.round(1 / (loyalty.points_per_dollar || 0.02)) : 50;
        const pointsToRedeem = loyalty?.points_to_redeem || 10;
        const discountAmount = loyalty?.discount_amount || 50;
        const redeemItemName = loyalty?.redeem_item_name || '';
        const minPurchase = loyalty?.min_purchase_for_points || 0;

        // 消費得點 + 兌換門檻
        html += '<div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:12px;">';

        // 卡片1：消費金額得點（上下佈局）
        html += '<div style="background:#fff;padding:14px;border-radius:10px;border:1px solid #E2E8F0;text-align:center;">';
        html += '<div style="font-size:12px;color:#94A3B8;margin-bottom:8px;">消費金額</div>';
        html += '<div style="display:flex;align-items:center;justify-content:center;gap:6px;">';
        html += '<span style="font-size:14px;color:#64748B;">每</span>';
        html += '<span style="font-size:14px;color:#64748B;">$</span>';
        html += '<input type="number" id="loyaltyDollarInput" value="' + dollarsPerPoint + '" min="1" style="width:80px;min-width:80px;padding:8px;border:2px solid #E2E8F0;border-radius:8px;text-align:center;font-size:18px;font-weight:700;color:#2563EB;">';
        html += '</div>';
        html += '<div style="font-size:12px;color:#94A3B8;margin-top:6px;">得 1 點</div>';
        html += '</div>';

        // 卡片2：兌換門檻（上下佈局）
        html += '<div style="background:#fff;padding:14px;border-radius:10px;border:1px solid #E2E8F0;text-align:center;">';
        html += '<div style="font-size:12px;color:#94A3B8;margin-bottom:8px;">兌換門檻</div>';
        html += '<div style="display:flex;align-items:center;justify-content:center;gap:6px;">';
        html += '<input type="number" id="loyaltyPointsInput" value="' + pointsToRedeem + '" min="1" style="width:80px;min-width:80px;padding:8px;border:2px solid #E2E8F0;border-radius:8px;text-align:center;font-size:18px;font-weight:700;color:#6366F1;">';
        html += '<span style="font-size:14px;color:#64748B;">點</span>';
        html += '</div>';
        html += '<div style="font-size:12px;color:#94A3B8;margin-top:6px;">可兌換</div>';
        html += '</div>';
        html += '</div>';

        // 兌換方式（同時支援折扣金額和等值商品）
        html += '<div style="background:#fff;padding:14px;border-radius:10px;border:1px solid #E2E8F0;margin-bottom:12px;">';
        html += '<div style="font-size:12px;color:#94A3B8;margin-bottom:8px;">兌換方式</div>';

        // 折抵金額
        html += '<div style="display:flex;align-items:center;gap:6px;margin-bottom:10px;">';
        html += '<span style="font-size:14px;color:#64748B;">折抵</span>';
        html += '<span style="font-size:14px;color:#64748B;">$</span>';
        html += '<input type="number" id="loyaltyDiscountInput" value="' + discountAmount + '" min="0" style="width:80px;min-width:80px;padding:8px;border:2px solid #E2E8F0;border-radius:8px;text-align:center;font-size:18px;font-weight:700;color:#059669;">';
        html += '</div>';

        // 或等值商品
        html += '<div style="display:flex;align-items:center;gap:6px;">';
        html += '<span style="font-size:14px;color:#64748B;">或</span>';
        html += '<input type="text" id="loyaltyItemInput" value="' + esc(redeemItemName) + '" placeholder="等值商品名稱（例：招牌麵包一個）" style="flex:1;padding:8px;border:2px solid #E2E8F0;border-radius:8px;font-size:14px;font-family:inherit;">';
        html += '</div>';

        html += '<div style="font-size:11px;color:#94A3B8;margin-top:6px;">可擇一或兩者皆設定，由店員操作時選擇</div>';
        html += '</div>';

        // 最低消費
        html += '<div style="display:flex;align-items:center;gap:6px;margin-bottom:14px;">';
        html += '<span style="font-size:13px;color:#64748B;">最低消費</span>';
        html += '<span style="font-size:14px;color:#64748B;">$</span>';
        html += '<input type="number" id="loyaltyMinInput" value="' + minPurchase + '" min="0" style="width:80px;min-width:80px;padding:8px;border:2px solid #E2E8F0;border-radius:8px;text-align:center;font-size:18px;font-weight:700;color:#F97316;">';
        html += '<span style="font-size:13px;color:#94A3B8;">才給點（0=不限）</span>';
        html += '</div>';

        // 儲存按鈕
        html += '<button onclick="saveLoyaltyRules(\'' + storeId + '\')" style="width:100%;padding:12px;border:none;border-radius:10px;background:#6366F1;color:#fff;font-size:14px;font-weight:700;cursor:pointer;font-family:inherit;">💾 儲存集點設定</button>';
        html += '</div>';

        // ===== VIP 設定（可開關）=====
        const vipEnabled = localStorage.getItem('vip_enabled_' + storeId) !== 'false';
        html += '<div style="background:#FFF7ED;border-radius:14px;padding:16px;margin-bottom:16px;">';
        html += '<div style="display:flex;justify-content:space-between;align-items:center;">';
        html += '<div style="font-size:15px;font-weight:700;">👑 VIP 門檻</div>';
        // toggle 開關
        html += '<label style="position:relative;display:inline-block;width:48px;height:26px;cursor:pointer;">';
        html += '<input type="checkbox" id="vipToggle" ' + (vipEnabled ? 'checked' : '') + ' onchange="toggleVipSection()" style="opacity:0;width:0;height:0;">';
        html += '<span style="position:absolute;top:0;left:0;right:0;bottom:0;background:' + (vipEnabled ? '#F97316' : '#CBD5E1') + ';border-radius:13px;transition:.3s;"></span>';
        html += '<span style="position:absolute;top:3px;left:' + (vipEnabled ? '25px' : '3px') + ';width:20px;height:20px;background:#fff;border-radius:50%;transition:.3s;box-shadow:0 1px 3px rgba(0,0,0,.2);"></span>';
        html += '</label>';
        html += '</div>';

        // VIP 設定內容（可收合）
        html += '<div id="vipSettingsArea" style="margin-top:12px;' + (vipEnabled ? '' : 'display:none;') + '">';
        html += '<div style="font-size:12px;color:#94A3B8;margin-bottom:8px;">累計訂單達門檻自動升級 VIP</div>';
        html += '<div style="display:flex;align-items:center;gap:6px;">';
        html += '<span style="font-size:14px;color:#64748B;">≥</span>';
        html += '<input type="number" id="vipThresholdInput" value="' + vipThreshold + '" min="1" style="width:70px;padding:8px;border:2px solid #E2E8F0;border-radius:8px;text-align:center;font-size:16px;font-weight:700;">';
        html += '<span style="font-size:14px;color:#64748B;">筆訂單</span>';
        html += '</div>';
        html += '</div>';
        html += '</div>';

        // ===== 統計卡片 =====
        const vipCount = customers.filter(function(c) { return (c.total_orders || 0) >= vipThreshold; }).length;
        const totalSpent = customers.reduce(function(s, c) { return s + (c.total_spent || 0); }, 0);
        const totalOrders = customers.reduce(function(s, c) { return s + (c.total_orders || 0); }, 0);

        html += '<div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:16px;">';
        html += '<div style="background:#EFF6FF;border-radius:10px;padding:12px;text-align:center;">';
        html += '<div style="font-size:11px;color:#64748B;">總會員數</div>';
        html += '<div style="font-size:24px;font-weight:800;color:#2563EB;">' + customers.length + '</div></div>';
        html += '<div style="background:#FFF7ED;border-radius:10px;padding:12px;text-align:center;">';
        html += '<div style="font-size:11px;color:#64748B;">VIP 會員</div>';
        html += '<div style="font-size:24px;font-weight:800;color:#F97316;">' + vipCount + '</div></div>';
        html += '<div style="background:#F0FDF4;border-radius:10px;padding:12px;text-align:center;">';
        html += '<div style="font-size:11px;color:#64748B;">總消費額</div>';
        html += '<div style="font-size:24px;font-weight:800;color:#059669;">$' + totalSpent.toLocaleString() + '</div></div>';
        html += '<div style="background:#F5F3FF;border-radius:10px;padding:12px;text-align:center;">';
        html += '<div style="font-size:11px;color:#64748B;">總訂單數</div>';
        html += '<div style="font-size:24px;font-weight:800;color:#6366F1;">' + totalOrders + '</div></div>';
        html += '</div>';

        // ===== 會員搜尋 =====
        html += '<input type="text" id="memberSearchInput" oninput="filterMemberList()" placeholder="🔍 搜尋會員（姓名/電話）" style="width:100%;padding:12px 14px;border:2px solid #E2E8F0;border-radius:10px;font-size:14px;margin-bottom:12px;box-sizing:border-box;font-family:inherit;">';

        // ===== 會員列表 =====
        html += '<div style="font-size:15px;font-weight:700;margin-bottom:10px;">📋 會員列表 (' + customers.length + ')</div>';

        if (customers.length === 0) {
            html += '<div style="text-align:center;padding:40px 20px;color:#94A3B8;">';
            html += '<div style="font-size:48px;margin-bottom:12px;">👥</div>';
            html += '<div style="font-size:15px;font-weight:600;">尚無會員</div>';
            html += '<div style="font-size:13px;margin-top:4px;">客人透過掃碼點餐後會自動建立</div>';
            html += '</div>';
        } else {
            html += '<div id="memberListContainer">';
            customers.forEach(function(c) {
                const joinDate = c.created_at ? new Date(c.created_at).toLocaleDateString('zh-TW') : '-';
                const lastDate = c.updated_at ? new Date(c.updated_at).toLocaleDateString('zh-TW') : '-';
                const isVip = (c.total_orders || 0) >= vipThreshold;

                html += '<div class="member-card" data-name="' + esc(c.name || '') + '" data-phone="' + esc(c.phone || '') + '" onclick="toggleMemberOrders(\'' + esc(c.phone) + '\', \'' + storeId + '\', this)" style="cursor:pointer;padding:14px;background:#fff;border:1px solid ' + (isVip ? '#F97316' : '#E2E8F0') + ';border-radius:12px;margin-bottom:8px;' + (isVip ? 'box-shadow:0 0 0 1px #FED7AA;' : '') + '">';

                // 主要內容區（flex layout）
                html += '<div style="display:flex;justify-content:space-between;align-items:center;">';
                // 左
                html += '<div style="display:flex;align-items:center;gap:12px;flex:1;min-width:0;">';
                html += '<div style="width:44px;height:44px;border-radius:22px;background:' + (isVip ? 'linear-gradient(135deg,#F97316,#FBBF24)' : 'linear-gradient(135deg,#6366F1,#8B5CF6)') + ';display:flex;align-items:center;justify-content:center;color:#fff;font-weight:700;font-size:16px;flex-shrink:0;">';
                html += esc((c.name || '?').substring(0, 1));
                html += '</div>';
                html += '<div style="min-width:0;">';
                html += '<div style="font-weight:700;font-size:15px;">' + esc(c.name || '匿名') + (isVip ? ' <span style="background:#FFF7ED;color:#F97316;font-size:10px;padding:2px 6px;border-radius:4px;font-weight:700;">VIP</span>' : '') + '</div>';
                html += '<div style="font-size:12px;color:#64748B;">📱 ' + esc(c.phone || '-') + '</div>';
                html += '<div style="font-size:11px;color:#94A3B8;">加入: ' + joinDate + ' · 最後: ' + lastDate + '</div>';
                html += '</div></div>';
                // 右
                html += '<div style="text-align:right;flex-shrink:0;margin-left:12px;">';
                html += '<div style="font-size:18px;font-weight:800;color:#059669;">$' + (c.total_spent || 0).toLocaleString() + '</div>';
                html += '<div style="font-size:12px;color:#64748B;">' + (c.total_orders || 0) + ' 筆訂單</div>';
                html += '</div>';
                html += '</div>'; // 結束 flex layout

                // 訂單展開區
                html += '<div class="member-orders-area" data-phone="' + esc(c.phone) + '" style="display:none;margin-top:10px;padding-top:10px;border-top:1px solid #E2E8F0;"></div>';

                html += '</div>'; // 結束 member-card
            });
            html += '</div>';
        }

        html += '</div>'; // 結束 membersMgrTab

        // ===== 會員集點 Tab =====
        html += '<div id="membersPointsTab" style="display:none;">';

        if (customers.length === 0) {
            html += '<div style="text-align:center;padding:40px;color:#94A3B8;">尚無會員</div>';
        } else {
            html += '<div style="font-size:14px;font-weight:700;margin-bottom:12px;">🎯 會員點數一覽</div>';
            // 搜尋
            html += '<input type="text" id="pointSearchInput" oninput="filterPointList()" placeholder="🔍 搜尋（姓名/電話）" style="width:100%;padding:10px;border:2px solid #E2E8F0;border-radius:10px;font-size:14px;margin-bottom:12px;box-sizing:border-box;font-family:inherit;">';

            html += '<div id="pointListContainer">';
            customers.forEach(function(c) {
                // 從 pointsMap 取得點數（已從 loyalty_transactions 計算）
                const pts = pointsMap[c.phone] || 0;

                html += '<div class="point-card" data-name="' + esc(c.name || '') + '" data-phone="' + esc(c.phone || '') + '" style="display:flex;justify-content:space-between;align-items:center;padding:14px;background:#fff;border:1px solid #E2E8F0;border-radius:12px;margin-bottom:8px;">';
                // 左
                html += '<div style="display:flex;align-items:center;gap:10px;">';
                html += '<div style="width:40px;height:40px;border-radius:20px;background:linear-gradient(135deg,#6366F1,#8B5CF6);display:flex;align-items:center;justify-content:center;color:#fff;font-weight:700;font-size:15px;">' + esc((c.name||'?').substring(0,1)) + '</div>';
                html += '<div>';
                html += '<div style="font-weight:700;font-size:14px;">' + esc(c.name || '匿名') + '</div>';
                html += '<div style="font-size:12px;color:#94A3B8;">' + esc(c.phone || '-') + '</div>';
                html += '</div></div>';
                // 右：點數（可調整）
                html += '<div style="text-align:center;">';
                html += '<div style="font-size:22px;font-weight:800;color:#6366F1;">' + pts + '</div>';
                html += '<div style="font-size:11px;color:#94A3B8;margin-bottom:6px;">點</div>';
                html += '<div style="display:flex;gap:4px;justify-content:center;">';
                html += '<button onclick="adjustPoints(\'' + esc(c.phone) + '\', -1, \'' + storeId + '\')" style="width:28px;height:28px;border:1px solid #E2E8F0;border-radius:6px;background:#fff;color:#EF4444;font-size:16px;font-weight:700;cursor:pointer;">−</button>';
                html += '<button onclick="adjustPoints(\'' + esc(c.phone) + '\', 1, \'' + storeId + '\')" style="width:28px;height:28px;border:1px solid #E2E8F0;border-radius:6px;background:#fff;color:#059669;font-size:16px;font-weight:700;cursor:pointer;">+</button>';
                html += '<button onclick="adjustPointsCustom(\'' + esc(c.phone) + '\', \'' + esc(c.name || '匿名') + '\', ' + pts + ', \'' + storeId + '\')" style="padding:4px 8px;border:1px solid #E2E8F0;border-radius:6px;background:#fff;color:#64748B;font-size:11px;cursor:pointer;">✏️</button>';
                html += '</div>';
                html += '</div>';
                html += '</div>';
            });
            html += '</div>';

            // ===== 交易紀錄區域 =====
            html += '<div style="margin-top:20px;">';
            html += '<div style="font-size:14px;font-weight:700;margin-bottom:10px;">📜 近期交易紀錄</div>';

            try {
                const { data: transactions } = await sb.from('loyalty_transactions')
                    .select('*')
                    .eq('store_id', storeId)
                    .order('created_at', { ascending: false })
                    .limit(20);

                if (transactions && transactions.length > 0) {
                    transactions.forEach(function(t) {
                        const dateStr = new Date(t.created_at).toLocaleString('zh-TW', {month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit'});
                        const icon = t.type === 'earn' ? '🟢 +' : '🔴 -';
                        const color = t.type === 'earn' ? '#059669' : '#EF4444';

                        html += '<div style="display:flex;justify-content:space-between;align-items:center;padding:10px 12px;border-bottom:1px solid #F1F5F9;">';
                        html += '<div>';
                        html += '<div style="font-size:13px;font-weight:600;">' + esc(t.note || (t.type === 'earn' ? '消費得點' : '兌換扣點')) + '</div>';
                        html += '<div style="font-size:11px;color:#94A3B8;">' + esc(t.customer_phone || '') + ' · ' + dateStr + '</div>';
                        if (t.operator_name) html += '<div style="font-size:10px;color:#CBD5E1;">操作人: ' + esc(t.operator_name) + '</div>';
                        html += '</div>';
                        html += '<div style="font-size:15px;font-weight:700;color:' + color + ';">' + icon + t.points + ' 點</div>';
                        html += '</div>';
                    });
                } else {
                    html += '<div style="text-align:center;padding:20px;color:#94A3B8;font-size:13px;">尚無交易紀錄</div>';
                }
            } catch(e) {
                // loyalty_transactions 表可能不存在
                html += '<div style="text-align:center;padding:20px;color:#94A3B8;font-size:13px;">交易紀錄功能準備中</div>';
            }
            html += '</div>';
        }
        html += '</div>'; // 結束 membersPointsTab

        content.innerHTML = html;
    } catch(e) {
        console.error('loadMembersForStore error:', e);
        content.innerHTML = '<p style="text-align:center;color:#EF4444;padding:20px;">載入失敗: ' + esc(e.message || '') + '</p>';
    }
}

// toggle 集點開關
window.toggleLoyalty = async function(storeId, enabled) {
    try {
        const { data: existing } = await sb.from('loyalty_config').select('id').eq('store_id', storeId).maybeSingle();
        if (existing) {
            await sb.from('loyalty_config').update({ enabled: enabled }).eq('store_id', storeId);
        } else if (enabled) {
            await sb.from('loyalty_config').insert({
                store_id: storeId,
                enabled: true,
                points_per_dollar: 1,
                points_to_redeem: 10,
                discount_amount: 50,
                min_purchase_for_points: 0
            });
        }
        loadMembersForStore(storeId);
    } catch(e) { console.error(e); alert('操作失敗'); }
};

// 儲存集點規則（從 input 讀取值）
window.saveLoyaltyRules = async function(storeId) {
    const dollarsPerPoint = parseInt(document.getElementById('loyaltyDollarInput')?.value) || 50;
    const pointsToRedeem = parseInt(document.getElementById('loyaltyPointsInput')?.value) || 10;
    const discountAmount = parseInt(document.getElementById('loyaltyDiscountInput')?.value) || 50;
    const redeemItemName = document.getElementById('loyaltyItemInput')?.value || '';
    const minPurchase = parseFloat(document.getElementById('loyaltyMinInput')?.value) || 0;

    // points_per_dollar = 1/dollarsPerPoint（例：每$50得1點 → points_per_dollar = 0.02）
    const pointsPerDollar = dollarsPerPoint > 0 ? (1 / dollarsPerPoint) : 0.02;

    const updateData = {
        points_per_dollar: pointsPerDollar,
        points_to_redeem: pointsToRedeem,
        discount_amount: discountAmount,
        min_purchase_for_points: minPurchase
    };

    // 嘗試儲存 redeem_item_name（如果欄位存在）
    if (redeemItemName) {
        updateData.redeem_item_name = redeemItemName;
    }

    try {
        const { data: existing } = await sb.from('loyalty_config').select('id').eq('store_id', storeId).maybeSingle();
        if (existing) {
            await sb.from('loyalty_config').update(updateData).eq('store_id', storeId);
        } else {
            updateData.store_id = storeId;
            updateData.enabled = true;
            await sb.from('loyalty_config').insert(updateData);
        }

        // 儲存 VIP 設定到 localStorage
        localStorage.setItem('vip_enabled_' + storeId, document.getElementById('vipToggle')?.checked ? 'true' : 'false');
        localStorage.setItem('vip_threshold_' + storeId, document.getElementById('vipThresholdInput')?.value || '10');

        alert('✅ 集點設定已儲存');
        loadMembersForStore(storeId);
    } catch(e) {
        console.error('Save loyalty error:', e);
        alert('儲存失敗: ' + (e.message || ''));
    }
};

// VIP 門檻儲存
window.saveVipThreshold = async function(storeId) {
    const val = parseInt(document.getElementById('vipThresholdInput')?.value);
    if (!val || val < 1) { alert('請輸入有效數字'); return; }

    try {
        // 存在 loyalty_config 的自訂欄位或 localStorage
        const { error } = await sb.from('loyalty_config').update({ vip_threshold: val }).eq('store_id', storeId);
        if (error) {
            // vip_threshold 欄位不存在，用 localStorage 暫存
            localStorage.setItem('vip_threshold_' + storeId, val);
        }
        loadMembersForStore(storeId);
        alert('VIP 門檻已更新為 ' + val + ' 筆');
    } catch(e) {
        localStorage.setItem('vip_threshold_' + storeId, val);
        loadMembersForStore(storeId);
        alert('VIP 門檻已更新為 ' + val + ' 筆');
    }
};

// 搜尋過濾
window.filterMemberList = function() {
    const keyword = (document.getElementById('memberSearchInput')?.value || '').toLowerCase();
    document.querySelectorAll('.member-card').forEach(function(card) {
        const name = (card.getAttribute('data-name') || '').toLowerCase();
        const phone = (card.getAttribute('data-phone') || '').toLowerCase();
        card.style.display = (name.includes(keyword) || phone.includes(keyword)) ? '' : 'none';
    });
};

// Tab 切換
window.switchMemberTab = function(tab) {
    const mgrTab = document.getElementById('membersMgrTab');
    const ptsTab = document.getElementById('membersPointsTab');
    const btnMembers = document.getElementById('tabMembers');
    const btnPoints = document.getElementById('tabPoints');

    if (tab === 'members') {
        if (mgrTab) mgrTab.style.display = '';
        if (ptsTab) ptsTab.style.display = 'none';
        if (btnMembers) { btnMembers.style.color = '#6366F1'; btnMembers.style.borderBottom = '3px solid #6366F1'; }
        if (btnPoints) { btnPoints.style.color = '#94A3B8'; btnPoints.style.borderBottom = '3px solid transparent'; }
    } else {
        if (mgrTab) mgrTab.style.display = 'none';
        if (ptsTab) ptsTab.style.display = '';
        if (btnPoints) { btnPoints.style.color = '#6366F1'; btnPoints.style.borderBottom = '3px solid #6366F1'; }
        if (btnMembers) { btnMembers.style.color = '#94A3B8'; btnMembers.style.borderBottom = '3px solid transparent'; }
    }
};

// 會員集點搜尋過濾
window.filterPointList = function() {
    const keyword = (document.getElementById('pointSearchInput')?.value || '').toLowerCase();
    document.querySelectorAll('.point-card').forEach(function(card) {
        const name = (card.getAttribute('data-name') || '').toLowerCase();
        const phone = (card.getAttribute('data-phone') || '').toLowerCase();
        card.style.display = (name.includes(keyword) || phone.includes(keyword)) ? '' : 'none';
    });
};

// VIP 門檻開關切換
window.toggleVipSection = function() {
    const checked = document.getElementById('vipToggle')?.checked;
    const area = document.getElementById('vipSettingsArea');
    if (area) area.style.display = checked ? '' : 'none';
};

// 調整點數（+1 或 -1）
window.adjustPoints = async function(customerPhone, delta, storeId) {
    try {
        await sb.from('loyalty_transactions').insert({
            store_id: storeId,
            customer_phone: customerPhone,
            type: delta > 0 ? 'earn' : 'redeem',
            points: Math.abs(delta),
            note: '手動調整 ' + (delta > 0 ? '+' : '') + delta,
            operator_name: window.currentEmployee?.name || 'admin'
        });

        await loadMembersForStore(storeId, true);
        if (typeof window.switchMemberTab === 'function') window.switchMemberTab('points');
    } catch(e) {
        console.error('adjustPoints error:', e);
        alert('操作失敗: ' + (e.message || ''));
    }
};

// 自訂點數調整
window.adjustPointsCustom = async function(customerPhone, customerName, currentPts, storeId) {
    const input = prompt(customerName + ' 目前 ' + currentPts + ' 點\n輸入要調整的點數（正數=加點，負數=扣點）：', '0');
    if (input === null) return;
    const delta = parseInt(input);
    if (isNaN(delta) || delta === 0) { alert('請輸入有效數字'); return; }

    try {
        await sb.from('loyalty_transactions').insert({
            store_id: storeId,
            customer_phone: customerPhone,
            type: delta > 0 ? 'earn' : 'redeem',
            points: Math.abs(delta),
            note: '手動設定 ' + (delta > 0 ? '+' : '') + delta + ' 點',
            operator_name: window.currentEmployee?.name || 'admin'
        });

        await loadMembersForStore(storeId, true);
        if (typeof window.switchMemberTab === 'function') window.switchMemberTab('points');
    } catch(e) {
        console.error(e);
        alert('操作失敗');
    }
};

// 展開/收合會員歷史訂單
window.toggleMemberOrders = async function(phone, storeId, cardEl) {
    const area = cardEl.querySelector('.member-orders-area');
    if (!area) return;

    // toggle 顯示
    if (area.style.display !== 'none') {
        area.style.display = 'none';
        return;
    }

    area.style.display = '';
    area.innerHTML = '<div style="text-align:center;color:#94A3B8;font-size:12px;padding:8px;">載入中...</div>';

    try {
        const { data: orders } = await sb.from('orders')
            .select('id, total, status, order_type, created_at, items')
            .eq('store_id', storeId)
            .eq('customer_phone', phone)
            .order('created_at', { ascending: false })
            .limit(10);

        if (!orders || orders.length === 0) {
            area.innerHTML = '<div style="text-align:center;color:#94A3B8;font-size:12px;padding:8px;">無訂單紀錄</div>';
            return;
        }

        let ohtml = '<div style="font-size:12px;font-weight:700;color:#64748B;margin-bottom:6px;">📦 最近訂單</div>';
        orders.forEach(function(o) {
            const dateStr = new Date(o.created_at).toLocaleString('zh-TW', {month:'numeric', day:'numeric', hour:'2-digit', minute:'2-digit'});
            const statusMap = {pending:'⏳待處理', confirmed:'✅已確認', preparing:'🔥製作中', ready:'📦可取餐', completed:'✅已完成', cancelled:'❌已取消'};
            const statusText = statusMap[o.status] || o.status;
            const typeText = o.order_type === 'takeout' ? '外帶' : '內用';

            // 解析品項
            let itemsText = '';
            try {
                const items = typeof o.items === 'string' ? JSON.parse(o.items) : (o.items || []);
                itemsText = items.map(function(it) { return it.name + ' x' + it.qty; }).join('、');
            } catch(e) { itemsText = '-'; }

            ohtml += '<div style="padding:8px;background:#F8FAFC;border-radius:8px;margin-bottom:6px;font-size:12px;">';
            ohtml += '<div style="display:flex;justify-content:space-between;">';
            ohtml += '<span style="color:#64748B;">' + dateStr + ' · ' + typeText + '</span>';
            ohtml += '<span style="font-weight:700;">$' + (o.total || 0) + '</span>';
            ohtml += '</div>';
            ohtml += '<div style="color:#94A3B8;margin-top:2px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">' + esc(itemsText) + '</div>';
            ohtml += '<div style="margin-top:2px;">' + statusText + '</div>';
            ohtml += '</div>';
        });

        area.innerHTML = ohtml;
    } catch(e) {
        console.error('Load member orders error:', e);
        area.innerHTML = '<div style="text-align:center;color:#EF4444;font-size:12px;padding:8px;">載入失敗</div>';
    }
};

export async function toggleMemberLoyalty() {
    const toggle = document.getElementById('memberLoyaltyEnabled');
    const enabled = toggle.checked;
    updateToggleStyle(toggle);

    if (!memberCurrentStoreId) return;

    try {
        await sb.from('store_profiles')
            .update({ loyalty_enabled: enabled })
            .eq('id', memberCurrentStoreId);

        showToast(enabled ? '✅ 已開啟集點功能' : '✅ 已關閉集點功能');
    } catch(e) {
        showToast('更新失敗');
        toggle.checked = !enabled;
        updateToggleStyle(toggle);
    }
}

let memberSearchTimer = null;
export function searchMemberByPhone() {
    clearTimeout(memberSearchTimer);
    const phone = document.getElementById('memberSearchPhone').value.trim();

    if (phone.length < 4) {
        document.getElementById('memberSearchResult').innerHTML = '';
        return;
    }

    memberSearchTimer = setTimeout(async () => {
        if (!memberCurrentStoreId) return;

        try {
            const { data: customer } = await sb.from('store_customers')
                .select('*')
                .eq('store_id', memberCurrentStoreId)
                .eq('phone', phone)
                .maybeSingle();

            const resultEl = document.getElementById('memberSearchResult');
            if (!customer) {
                resultEl.innerHTML = '<div style="text-align:center;padding:20px;color:#94A3B8;">查無此會員</div>';
                return;
            }

            const isVip = (customer.total_orders || 0) >= 10;
            const vipTag = isVip ? '<span style="background:#FCD34D;color:#78350F;padding:2px 6px;border-radius:4px;font-size:11px;font-weight:700;margin-left:4px;">⭐VIP</span>' : '';
            const blackTag = customer.is_blacklisted ? '<span style="background:#FEE2E2;color:#DC2626;padding:2px 6px;border-radius:4px;font-size:11px;font-weight:700;margin-left:4px;">🚫黑名單</span>' : '';

            resultEl.innerHTML = '<div style="background:#fff;border:2px solid #4F46E5;border-radius:12px;padding:16px;">' +
                '<div style="font-size:16px;font-weight:700;margin-bottom:8px;">' + esc(customer.name || '未命名') + vipTag + blackTag + '</div>' +
                '<div style="font-size:13px;color:#64748B;">📱 ' + esc(customer.phone) + '</div>' +
                '<div style="font-size:13px;color:#64748B;margin-top:4px;">💰 消費：<b>$' + (customer.total_spent || 0).toLocaleString() + '</b> · ' + (customer.total_orders || 0) + ' 筆</div>' +
            '</div>';
        } catch(e) {
            document.getElementById('memberSearchResult').innerHTML = '';
        }
    }, 400);
}


// 載入商店列表（用於預約管理和會員管理頁面）
export async function loadBookingStoreList() {
    const sel = document.getElementById('bookingStoreSelect');
    if (!sel) return;

    // 防禦檢查：確保有當前公司 ID
    if (!window.currentCompanyId) {
        sel.innerHTML = '<option value="">請先選擇公司</option>';
        return;
    }

    try {
        const { data: stores } = await sb.from('store_profiles')
            .select('*')
            .eq('company_id', window.currentCompanyId)
            .order('store_name');

        if (!stores || stores.length === 0) {
            sel.innerHTML = '<option value="">目前沒有商店</option>';
            return;
        }

        sel.innerHTML = stores.map(s => `<option value="${s.id}">${esc(s.store_name)}</option>`).join('');
    } catch(e) {
        console.error('loadBookingStoreList error:', e);
        showToast('載入商店列表失敗');
    }
}

export async function loadMemberStoreList() {
    const sel = document.getElementById('memberStoreSelect');
    if (!sel) return;

    // 防禦檢查：確保有當前公司 ID
    if (!window.currentCompanyId) {
        sel.innerHTML = '<option value="">請先選擇公司</option>';
        document.getElementById('memberContent').style.display = 'none';
        return;
    }

    try {
        const { data: stores } = await sb.from('store_profiles')
            .select('*')
            .eq('company_id', window.currentCompanyId) // 只載入當前公司的商店
            .order('store_name');

        if (!stores || stores.length === 0) {
            sel.innerHTML = '<option value="">目前沒有商店</option>';
            document.getElementById('memberContent').style.display = 'none';
            return;
        }

        // 填充下拉選單
        sel.innerHTML = stores.map(s => `<option value="${s.id}">${esc(s.store_name)}</option>`).join('');

        // 自動選第一家商店並載入會員資料
        sel.value = stores[0].id;
        await loadMembersForStore();
    } catch(e) {
        console.error('loadMemberStoreList error:', e);
        showToast('載入商店列表失敗');
    }
}
