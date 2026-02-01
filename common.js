// common.js
const CONFIG = {
    LIFF_ID: '2008962829-bnsS1bbB',
    SUPABASE_URL: 'https://nssuisyvlrqnqfxupklb.supabase.co',
    SUPABASE_ANON_KEY: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im5zc3Vpc3l2bHJxbnFmeHVwa2xiIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjkyOTAwMzUsImV4cCI6MjA4NDg2NjAzNX0.q_B6v3gf1TOCuAq7z0xIw10wDueCSJn0p37VzdMfmbc',
    BUCKET: 'selfies'
};

const sb = window.supabase.createClient(CONFIG.SUPABASE_URL, CONFIG.SUPABASE_ANON_KEY);
let liffProfile = null;

async function initApp(callback) {
    try {
        await liff.init({ liffId: CONFIG.LIFF_ID });
        if (!liff.isLoggedIn()) { liff.login(); return; }
        liffProfile = await liff.getProfile();
        if (callback) callback();
    } catch (e) {
        alert('初始化失敗: ' + e.message);
    }
}

function getTaiwanDate(offset = 0) {
    const d = new Date(); d.setDate(d.getDate() + offset);
    return d.toLocaleDateString('en-CA', { timeZone: 'Asia/Taipei' });
}

function showToast(msg) {
    const t = document.createElement('div');
    t.className = 'toast';
    t.textContent = msg;
    document.body.appendChild(t);
    setTimeout(() => t.remove(), 3000);
}

function showStatus(elId, type, msg) {
    const el = document.getElementById(elId);
    if(el) {
        el.className = `status-box show ${type}`;
        el.innerHTML = msg;
    }
}
