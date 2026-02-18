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
