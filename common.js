// common.js
const CONFIG = {
    LIFF_ID: '2008962829-bnsS1bbB', // 您的 LIFF ID
    SUPABASE_URL: 'https://nssuisyvlrqnqfxupklb.supabase.co',
    SUPABASE_ANON_KEY: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im5zc3Vpc3l2bHJxbnFmeHVwa2xiIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjkyOTAwMzUsImV4cCI6MjA4NDg2NjAzNX0.q_B6v3gf1TOCuAq7z0xIw10wDueCSJn0p37VzdMfmbc',
    BUCKET: 'selfies'
};

// 初始化 Supabase
const sb = window.supabase.createClient(CONFIG.SUPABASE_URL, CONFIG.SUPABASE_ANON_KEY);
let liffProfile = null;

// 初始化 LIFF (所有頁面通用)
async function initApp(callback) {
    try {
        await liff.init({ liffId: CONFIG.LIFF_ID });
        if (!liff.isLoggedIn()) {
            liff.login();
            return;
        }
        liffProfile = await liff.getProfile();
        if (callback) callback();
    } catch (e) {
        alert('LIFF 初始化失敗: ' + e.message);
    }
}

// 取得台灣日期
function getTaiwanDate(offsetDays = 0) {
    const date = new Date();
    date.setDate(date.getDate() + offsetDays);
    return date.toLocaleDateString('en-CA', { timeZone: 'Asia/Taipei' });
}

// 顯示 Toast
function showToast(msg) {
    const t = document.createElement('div');
    t.className = 'toast';
    t.textContent = msg;
    document.body.appendChild(t);
    setTimeout(() => t.remove(), 3000);
}

// 顯示狀態框
function showStatus(elId, type, msg) {
    const el = document.getElementById(elId);
    if(el) {
        el.className = `status-box show ${type}`;
        el.innerHTML = msg;
    }
}
