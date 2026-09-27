// ============================================================
// line-push / line-webhook Edge Function 核心邏輯（handler.ts）實跑測試
//
// Node 24 內建型別剝除，直接 import .ts；fetch 全部是假的，不打 LINE、不打 Supabase。
// ============================================================
const path = require('path');
const { pathToFileURL } = require('url');
const crypto = require('crypto');

let pass = 0, fail = 0;
function check(name, condition, detail = '') {
  if (condition) { pass++; console.log(`  ✅ ${name}${detail ? `  → ${detail}` : ''}`); }
  else { fail++; console.log(`  ❌ ${name}${detail ? `  → ${detail}` : ''}`); }
}

const COMPANY = '8a669e2c-7521-43e9-9300-5c004c57e9db';

function fakeFetch(routes) {
  const calls = [];
  const fn = async (url, init = {}) => {
    const body = init.body ? JSON.parse(init.body) : null;
    calls.push({ url, body, headers: init.headers || {} });
    for (const [pattern, responder] of routes) {
      if (url.includes(pattern)) {
        const r = typeof responder === 'function' ? responder(body) : responder;
        const text = typeof r.body === 'string' ? r.body : JSON.stringify(r.body ?? {});
        return new Response(text, { status: r.status || 200, headers: { 'Content-Type': 'application/json' } });
      }
    }
    throw new Error('unexpected fetch ' + url);
  };
  return { fn, calls };
}
const envOf = obj => key => obj[key];
const post = (url, body, headers = {}) => new Request(url, { method: 'POST', body: typeof body === 'string' ? body : JSON.stringify(body), headers: { 'Content-Type': 'application/json', ...headers } });

(async () => {
  console.log('\n═══════════════════════════════════════');
  console.log('  LINE Edge Functions（handler.ts 實跑）');
  console.log('═══════════════════════════════════════');

  const push = await import(pathToFileURL(path.join(__dirname, '..', 'supabase', 'functions', 'line-push', 'handler.ts')).href);
  const hook = await import(pathToFileURL(path.join(__dirname, '..', 'supabase', 'functions', 'line-webhook', 'handler.ts')).href);
  const env = envOf({ SUPABASE_URL: 'https://db.test', SUPABASE_SERVICE_ROLE_KEY: 'service-key', LINE_CHANNEL_TOKEN: 'line-token' });

  console.log('\n=== line-push ===');
  {
    const f = fakeFetch([['/rpc/line_push_reserve', { body: { allowed: true, log_id: 42, used: 10, limit: 180 } }],
                         ['/rpc/line_push_complete', { body: { updated: true } }],
                         ['api.line.me', { status: 200, body: {} }]]);
    const res = await push.handleLinePush(post('https://fn/line-push', { token: 't', to: 'Cgroup', text: 'hi', company_id: COMPANY, category: 'leave' }), { fetch: f.fn, env });
    const out = await res.json();
    const reserve = f.calls.find(c => c.url.includes('line_push_reserve'));
    const complete = f.calls.find(c => c.url.includes('line_push_complete'));
    const expectHash = crypto.createHash('sha256').update('t').digest('hex');
    check('帶 company_id：走 reserve_frontend、送 token 的 SHA-256（不送明文）、群組判為 group',
      reserve && reserve.url.endsWith('/rpc/line_push_reserve_frontend') && reserve.body.p_token_sha256 === expectHash
      && !JSON.stringify(reserve.body).includes('"t"') && reserve.body.p_recipient_kind === 'group' && reserve.body.p_category === 'leave');
    check('送出後回寫 HTTP 200 到推播紀錄', complete && complete.body.p_log_id === 42 && complete.body.p_http_status === 200);
    check('回傳 ok', out.ok === true && res.status === 200);
    check('service key 只放在 header，不出現在回傳', !JSON.stringify(out).includes('service-key'));
  }
  {
    const f = fakeFetch([['/rpc/line_push_reserve', { body: { allowed: false, used: 180, limit: 180 } }], ['api.line.me', { status: 200 }]]);
    const res = await push.handleLinePush(post('https://fn/line-push', { token: 't', to: 'U1', text: 'hi', company_id: COMPANY }), { fetch: f.fn, env });
    const out = await res.json();
    check('超過預算：不打 LINE、回 budget_blocked／429', !f.calls.some(c => c.url.includes('api.line.me')) && out.code === 'budget_blocked' && out.status === 429 && /預算/.test(out.error));
  }
  {
    const f = fakeFetch([['/rpc/line_push_reserve', { body: { allowed: true, log_id: 7 } }], ['/rpc/line_push_complete', { body: {} }],
                         ['api.line.me', { status: 429, body: { message: 'You have reached your monthly limit.' } }]]);
    const res = await push.handleLinePush(post('https://fn/line-push', { token: 't', to: 'U1', text: 'hi', company_id: COMPANY }), { fetch: f.fn, env });
    const out = await res.json();
    const complete = f.calls.find(c => c.url.includes('line_push_complete'));
    check('LINE 429：錯誤訊息寫回紀錄、回傳 429', complete.body.p_http_status === 429 && /monthly limit/.test(complete.body.p_error) && out.status === 429 && res.status === 429);
  }
  {
    const f = fakeFetch([['/rpc/line_push_reserve', { body: { allowed: null, reason: 'token_mismatch' } }], ['api.line.me', { status: 200 }]]);
    const res = await push.handleLinePush(post('https://fn/line-push', { token: 'other', to: 'U1', text: 'hi', company_id: COMPANY }), { fetch: f.fn, env });
    check('token 與公司設定不符：照送但不回寫紀錄', (await res.json()).ok === true && !f.calls.some(c => c.url.includes('line_push_complete')));
  }
  {
    const f = fakeFetch([['/rpc/line_push_reserve', { status: 404, body: { message: 'function not found' } }], ['api.line.me', { status: 200 }]]);
    const res = await push.handleLinePush(post('https://fn/line-push', { token: 't', to: 'U1', text: 'hi', company_id: COMPANY }), { fetch: f.fn, env });
    check('DB 還沒套 125（RPC 404）：照舊送出（fail-open）', (await res.json()).ok === true && f.calls.some(c => c.url.includes('api.line.me')));
  }
  {
    const f = fakeFetch([['api.line.me', { status: 200 }]]);
    const res = await push.handleLinePush(post('https://fn/line-push', { token: 't', to: 'U1', text: 'hi' }), { fetch: f.fn, env });
    check('舊版前端（沒帶 company_id）：不碰 DB、照舊送', (await res.json()).ok === true && f.calls.length === 1);
  }
  {
    const f = fakeFetch([]);
    const res = await push.handleLinePush(post('https://fn/line-push', { token: 't', to: 'U1' }), { fetch: f.fn, env });
    check('缺參數回 400', res.status === 400 && f.calls.length === 0);
  }

  console.log('\n=== line-webhook ===');
  const secret = 'channel-secret';
  const envS = envOf({ SUPABASE_URL: 'https://db.test', SUPABASE_SERVICE_ROLE_KEY: 'service-key', LINE_CHANNEL_TOKEN: 'line-token', LINE_CHANNEL_SECRET: secret });
  const sign = raw => crypto.createHmac('sha256', secret).update(raw).digest('base64');
  const ev = (text, source) => JSON.stringify({ events: [{ type: 'message', replyToken: 'rt', message: { type: 'text', text }, source }] });

  {
    const raw = ev('#待辦', { type: 'user', userId: 'U1' });
    const f = fakeFetch([['/rpc/line_pull_todo', { body: JSON.stringify('📋 我的待辦 10/02\n• 10/01 缺 45 分鐘') }], ['/message/reply', { status: 200 }]]);
    const res = await hook.handleLineWebhook(post('https://fn/line-webhook', raw, { 'x-line-signature': sign(raw) }), { fetch: f.fn, env: envS });
    const rpc = f.calls.find(c => c.url.includes('line_pull_todo'));
    const rep = f.calls.find(c => c.url.includes('/message/reply'));
    check('簽章正確＋私訊 #待辦：查 DB 並用 reply（免費）回覆', res.status === 200 && rpc && rpc.body.p_line_user_id === 'U1' && rep && /缺 45 分鐘/.test(rep.body.messages[0].text));
    check('webhook 從不呼叫 push API', !f.calls.some(c => c.url.includes('/message/push')));
  }
  {
    const raw = ev('#待辦', { type: 'user', userId: 'U1' });
    const f = fakeFetch([['/message/reply', { status: 200 }]]);
    const res = await hook.handleLineWebhook(post('https://fn/line-webhook', raw, { 'x-line-signature': 'forged' }), { fetch: f.fn, env: envS });
    check('簽章錯誤：401、不查資料、不回覆', res.status === 401 && f.calls.length === 0);
  }
  {
    const raw = ev('#待辦', { type: 'user', userId: 'U1' });
    const f = fakeFetch([['/message/reply', { status: 200 }]]);
    await hook.handleLineWebhook(post('https://fn/line-webhook', raw), { fetch: f.fn, env });
    const rep = f.calls.find(c => c.url.includes('/message/reply'));
    check('沒設定 Channel secret：#待辦 只回「尚未啟用」、不查 DB', rep && /尚未啟用/.test(rep.body.messages[0].text) && !f.calls.some(c => c.url.includes('line_pull_todo')));
  }
  {
    const raw = ev('#待辦', { type: 'group', groupId: 'Cgroup', userId: 'U1' });
    const f = fakeFetch([['/message/reply', { status: 200 }]]);
    await hook.handleLineWebhook(post('https://fn/line-webhook', raw, { 'x-line-signature': sign(raw) }), { fetch: f.fn, env: envS });
    const rep = f.calls.find(c => c.url.includes('/message/reply'));
    check('群組裡打 #待辦：只提示改私訊，不洩漏資料', rep && /請私訊/.test(rep.body.messages[0].text) && !f.calls.some(c => c.url.includes('line_pull_todo')));
  }
  {
    const raw = ev('#id', { type: 'group', groupId: 'Cabc' });
    const f = fakeFetch([['/message/reply', { status: 200 }]]);
    await hook.handleLineWebhook(post('https://fn/line-webhook', raw), { fetch: f.fn, env });
    const rep = f.calls.find(c => c.url.includes('/message/reply'));
    check('#id 原功能不變（未設 secret 也可用）', rep && rep.body.messages[0].text === 'Group ID:\nCabc');
  }
  {
    const raw = ev('今天天氣好', { type: 'user', userId: 'U1' });
    const f = fakeFetch([]);
    const res = await hook.handleLineWebhook(post('https://fn/line-webhook', raw, { 'x-line-signature': sign(raw) }), { fetch: f.fn, env: envS });
    check('一般聊天訊息：不回覆、不查詢', res.status === 200 && f.calls.length === 0);
  }

  console.log(`\n結果：${pass} 通過、${fail} 失敗`);
  process.exit(fail > 0 ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
