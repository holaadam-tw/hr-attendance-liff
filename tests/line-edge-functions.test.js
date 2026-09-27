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

  let push, hook;
  try {
    // 反向對照：LINE_PUSH_HANDLER 可指向舊版 handler.ts（例如 git show origin/main:… 存出來的副本）
    push = await import(pathToFileURL(process.env.LINE_PUSH_HANDLER || path.join(__dirname, '..', 'supabase', 'functions', 'line-push', 'handler.ts')).href);
    hook = await import(pathToFileURL(path.join(__dirname, '..', 'supabase', 'functions', 'line-webhook', 'handler.ts')).href);
  } catch (e) {
    if (e && e.code === 'ERR_UNKNOWN_FILE_EXTENSION') {
      // Node < 22.18 不能直接載入 .ts（CI 已改用 Node 22）；本機舊版 Node 只提示、不算失敗
      console.log(`  ⚠️ 略過：Node ${process.version} 無法直接載入 .ts，請用 Node 22.18 以上執行`);
      process.exit(0);
    }
    throw e;
  }
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
    const out = await res.json();
    check('舊模式 token 與公司設定不符：403、不打 LINE（不再當任意 token 的轉發器）', res.status === 403 && out.code === 'token_mismatch' && !f.calls.some(c => c.url.includes('api.line.me')));
  }
  {
    const f = fakeFetch([['/rpc/line_push_reserve', { status: 404, body: { message: 'function not found' } }], ['api.line.me', { status: 200 }]]);
    const res = await push.handleLinePush(post('https://fn/line-push', { token: 't', to: 'U1', text: 'hi', company_id: COMPANY }), { fetch: f.fn, env });
    check('DB 還沒套 125（RPC 404）：照舊送出（fail-open）', (await res.json()).ok === true && f.calls.some(c => c.url.includes('api.line.me')));
  }
  {
    const f = fakeFetch([['api.line.me', { status: 200 }]]);
    const res = await push.handleLinePush(post('https://fn/line-push', { token: 't', to: 'U1', text: 'hi' }), { fetch: f.fn, env });
    check('舊模式沒帶 company_id：400、不打 LINE（125 前的頁面早已過期）', res.status === 400 && f.calls.length === 0);
  }
  {
    const f = fakeFetch([['api.line.me', { status: 200 }]]);
    const envOff = envOf({ SUPABASE_URL: 'https://db.test', SUPABASE_SERVICE_ROLE_KEY: 'service-key', LINE_PUSH_LEGACY_TOKEN_MODE: 'off' });
    const res = await push.handleLinePush(post('https://fn/line-push', { token: 't', to: 'U1', text: 'hi', company_id: COMPANY }), { fetch: f.fn, env: envOff });
    check('LINE_PUSH_LEGACY_TOKEN_MODE=off：舊模式整個關閉（410）', res.status === 410 && f.calls.length === 0);
  }

  console.log('\n=== line-push 新模式（126：伺服器端取 token、驗 LIFF）===');
  const LIFF_USER = 'U' + 'a'.repeat(32);
  const liffRoutes = (overrides = {}) => [
    ['/oauth2/v2.1/verify', overrides.verify || { status: 200, body: { client_id: '2008962829', expires_in: 3600, scope: 'profile' } }],
    ['/v2/profile', overrides.profile || { status: 200, body: { userId: LIFF_USER, displayName: 'x' } }],
    ['/rpc/line_push_authorize', overrides.authorize || { body: { allowed: true, log_id: 99, token: 'server-token', to: 'CgroupA', recipient_kind: 'group' } }],
    ['/rpc/line_push_complete', { body: { updated: true } }],
    ['/rpc/admin_save_setting', overrides.save || { body: { success: true } }],
    ['/message/push', overrides.push || { status: 200, body: {} }],
  ];
  const v2 = (extra = {}) => ({ liff_access_token: 'liff-at', company_id: COMPANY, target: 'admin_group', text: '請假', category: 'leave', ...extra });
  {
    const f = fakeFetch(liffRoutes());
    const res = await push.handleLinePush(post('https://fn/line-push', v2()), { fetch: f.fn, env });
    const out = await res.json();
    const verify = f.calls.find(c => c.url.includes('/oauth2/v2.1/verify'));
    const prof = f.calls.find(c => c.url.includes('/v2/profile'));
    const auth = f.calls.find(c => c.url.includes('/rpc/line_push_authorize'));
    const lp = f.calls.find(c => c.url.includes('/message/push'));
    check('前端不帶 token：先向 LINE 驗 LIFF access token、再取 profile', !!(verify && verify.url.includes('access_token=liff-at') && prof && prof.headers.Authorization === 'Bearer liff-at'));
    check('授權 RPC 帶的是 LINE 驗出來的 userId（不是前端報的）', !!(auth && auth.body.p_line_user_id === LIFF_USER && auth.body.p_company_id === COMPANY && auth.body.p_target === 'admin_group' && auth.body.p_category === 'leave'));
    check('用 DB 回傳的 token 與收件人送 LINE', !!(lp && lp.headers.Authorization === 'Bearer server-token' && lp.body.to === 'CgroupA'));
    check('回傳 ok，回應內容沒有 token', out.ok === true && res.status === 200 && !JSON.stringify(out).includes('server-token'));
    check('送出後回寫推播紀錄', f.calls.some(c => c.url.includes('line_push_complete') && c.body.p_log_id === 99 && c.body.p_http_status === 200));
  }
  {
    const f = fakeFetch(liffRoutes());
    const res = await push.handleLinePush(post('https://fn/line-push', v2({ line_user_id: 'Uadmin-spoofed', to: 'Cattacker' })), { fetch: f.fn, env });
    const auth = f.calls.find(c => c.url.includes('/rpc/line_push_authorize'));
    const lp = f.calls.find(c => c.url.includes('/message/push'));
    check('前端夾帶 line_user_id／to 一律忽略（無法冒充、無法指定任意收件人）', !!(res.status === 200 && auth && auth.body.p_line_user_id === LIFF_USER && lp && lp.body.to === 'CgroupA'));
  }
  {
    const f = fakeFetch(liffRoutes({ verify: { status: 200, body: { client_id: '1234567890', expires_in: 3600 } } }));
    const res = await push.handleLinePush(post('https://fn/line-push', v2()), { fetch: f.fn, env });
    check('別的 LINE channel 發的 access token：401、不查 DB、不送', res.status === 401 && !f.calls.some(c => c.url.includes('/rpc/')) && !f.calls.some(c => c.url.includes('/message/push')));
  }
  {
    const f = fakeFetch(liffRoutes({ verify: { status: 400, body: { error: 'invalid_request', error_description: 'access token expired' } } }));
    const res = await push.handleLinePush(post('https://fn/line-push', v2()), { fetch: f.fn, env });
    const out = await res.json().catch(() => ({}));
    check('過期／偽造的 access token：401', res.status === 401 && out.code === 'unauthenticated' && !f.calls.some(c => c.url.includes('/rpc/')));
  }
  {
    const envCh = envOf({ SUPABASE_URL: 'https://db.test', SUPABASE_SERVICE_ROLE_KEY: 'service-key', LINE_LOGIN_CHANNEL_ID: '1234567890' });
    const f = fakeFetch(liffRoutes({ verify: { status: 200, body: { client_id: '1234567890', expires_in: 3600 } } }));
    const res = await push.handleLinePush(post('https://fn/line-push', v2()), { fetch: f.fn, env: envCh });
    check('LINE_LOGIN_CHANNEL_ID 可覆寫允許的 channel', res.status === 200 && f.calls.some(c => c.url.includes('/message/push')));
  }
  {
    const f = fakeFetch(liffRoutes({ authorize: { body: { allowed: false, reason: 'manager_required' } } }));
    const res = await push.handleLinePush(post('https://fn/line-push', v2({ category: 'test' })), { fetch: f.fn, env });
    const out = await res.json().catch(() => ({}));
    check('DB 拒絕（員工發測試推播）：403 帶原因、不送', res.status === 403 && out.code === 'manager_required' && !f.calls.some(c => c.url.includes('/message/push')));
  }
  {
    const f = fakeFetch(liffRoutes({ authorize: { body: { allowed: false, reason: 'budget_exceeded', used: 180, limit: 180 } } }));
    const res = await push.handleLinePush(post('https://fn/line-push', v2()), { fetch: f.fn, env });
    const out = await res.json().catch(() => ({}));
    check('超過預算：budget_blocked（沿用 125 前端處理）', out.code === 'budget_blocked' && out.status === 429 && !f.calls.some(c => c.url.includes('/message/push')));
  }
  {
    const f = fakeFetch(liffRoutes({ authorize: { status: 404, body: { message: 'function not found' } } }));
    const res = await push.handleLinePush(post('https://fn/line-push', v2()), { fetch: f.fn, env });
    check('DB 還沒套 126（授權 RPC 404）：fail-closed 503、不送', res.status === 503 && !f.calls.some(c => c.url.includes('/message/push')));
  }
  {
    const f = fakeFetch(liffRoutes());
    const res = await push.handleLinePush(post('https://fn/line-push', v2({ target: 'employee' })), { fetch: f.fn, env });
    check('target=employee 沒帶 employee_id：400', res.status === 400 && !f.calls.some(c => c.url.includes('/oauth2/')));
  }
  {
    const f = fakeFetch(liffRoutes({ push: { status: 429, body: { message: 'You have reached your monthly limit.' } } }));
    const res = await push.handleLinePush(post('https://fn/line-push', v2()), { fetch: f.fn, env });
    const complete = f.calls.find(c => c.url.includes('line_push_complete'));
    check('LINE 回 429：結果寫回紀錄、回傳 429', res.status === 429 && !!complete && complete.body.p_http_status === 429);
  }

  console.log('\n=== line-push action=save_config（管理員存 token，不經瀏覽器讀回）===');
  {
    const f = fakeFetch(liffRoutes());
    const res = await push.handleLinePush(post('https://fn/line-push', { action: 'save_config', liff_access_token: 'liff-at', company_id: COMPANY, channel_token: ' new-token ', group_id: 'Cnew' }), { fetch: f.fn, env });
    const save = f.calls.find(c => c.url.includes('/rpc/admin_save_setting'));
    const out = await res.json().catch(() => ({}));
    check('驗 LIFF 後以驗出的 userId 呼叫 admin_save_setting（service role）', !!(save && save.body.p_line_user_id === LIFF_USER && save.body.p_key === 'line_messaging_api' && save.body.p_value.token === 'new-token' && save.body.p_value.groupId === 'Cnew' && save.headers.Authorization === 'Bearer service-key'));
    check('回傳 ok、不回 token', out.ok === true && !JSON.stringify(out).includes('new-token'));
    check('save_config 不會送任何 LINE 訊息', !f.calls.some(c => c.url.includes('/message/push')));
  }
  {
    const f = fakeFetch(liffRoutes());
    await push.handleLinePush(post('https://fn/line-push', { action: 'save_config', liff_access_token: 'liff-at', company_id: COMPANY, channel_token: '', group_id: 'Cnew' }), { fetch: f.fn, env });
    const save = f.calls.find(c => c.url.includes('/rpc/admin_save_setting'));
    check('token 留空：不帶 token 鍵（DB 沿用舊 token）', !!(save && !('token' in save.body.p_value)));
  }
  {
    const f = fakeFetch(liffRoutes({ save: { body: { success: false, error_code: 'admin_only', error: '只有管理員可以修改此設定' } } }));
    const res = await push.handleLinePush(post('https://fn/line-push', { action: 'save_config', liff_access_token: 'liff-at', company_id: COMPANY, group_id: 'C' }), { fetch: f.fn, env });
    const out = await res.json().catch(() => ({}));
    check('非管理員：403', res.status === 403 && out.code === 'admin_only');
  }
  {
    const f = fakeFetch(liffRoutes({ profile: { status: 401, body: {} } }));
    const res = await push.handleLinePush(post('https://fn/line-push', { action: 'save_config', liff_access_token: 'bad', company_id: COMPANY, group_id: 'C' }), { fetch: f.fn, env });
    check('LIFF 驗證失敗：401、不寫 DB', res.status === 401 && !f.calls.some(c => c.url.includes('/rpc/')));
  }
  {
    const f = fakeFetch([]);
    const res = await push.handleLinePush(post('https://fn/line-push', { token: 't', to: 'U1' }), { fetch: f.fn, env });
    check('缺參數回 400', res.status === 400 && f.calls.length === 0);
  }

  console.log('\n=== 寄件人前綴、頻率限制（M1／M2）===');
  {
    const f = fakeFetch(liffRoutes({ authorize: { body: { allowed: true, log_id: 5, token: 'server-token', to: 'CgroupA', recipient_kind: 'group', text_prefix: '［員工一 送出］\n' } } }));
    await push.handleLinePush(post('https://fn/line-push', v2({ text: '🚨 系統公告：請全員立即更改密碼' })), { fetch: f.fn, env });
    const lp = f.calls.find(c => c.url.includes('/message/push'));
    check('員工訊息一定以 DB 給的寄件人前綴開頭（無法偽裝系統公告）', !!lp && lp.body.messages[0].text === '［員工一 送出］\n🚨 系統公告：請全員立即更改密碼');
  }
  {
    const f = fakeFetch(liffRoutes({ authorize: { body: { allowed: false, reason: 'rate_limited', hour_count: 10, hour_limit: 10 } } }));
    const res = await push.handleLinePush(post('https://fn/line-push', v2()), { fetch: f.fn, env });
    const out = await res.json().catch(() => ({}));
    check('頻率限制：429 code=rate_limited、不送', res.status === 429 && out.code === 'rate_limited' && !f.calls.some(c => c.url.includes('/message/push')));
  }

  console.log('\n=== 其他驗證後動作（save_setting／get_line_config／平台管理員）===');
  {
    const f = fakeFetch(liffRoutes());
    const res = await push.handleLinePush(post('https://fn/line-push', { action: 'save_setting', liff_access_token: 'liff-at', company_id: COMPANY, key: 'office_locations', value: [{ name: 'x' }], description: '打卡地點', line_user_id: 'Uspoofed' }), { fetch: f.fn, env });
    const save = f.calls.find(c => c.url.includes('/rpc/admin_save_setting'));
    check('save_setting：以 LINE 驗出的 userId 代存（忽略前端夾帶的 line_user_id）', res.status === 200 && !!save && save.body.p_line_user_id === LIFF_USER && save.body.p_key === 'office_locations' && save.body.p_value[0].name === 'x');
  }
  {
    const f = fakeFetch(liffRoutes());
    const res = await push.handleLinePush(post('https://fn/line-push', { action: 'save_setting', liff_access_token: 'liff-at', company_id: COMPANY, key: 'line_messaging_api', value: { token: 'x' } }), { fetch: f.fn, env });
    check('save_setting 不能拿來存 LINE token（只能走 save_config）', res.status === 400 && !f.calls.some(c => c.url.includes('/rpc/')));
  }
  {
    const f = fakeFetch(liffRoutes({ save: { body: { success: false, error_code: 'admin_only', error: '只有管理員可以修改此設定' } } }));
    const res = await push.handleLinePush(post('https://fn/line-push', { action: 'save_setting', liff_access_token: 'liff-at', company_id: COMPANY, key: 'line_monthly_budget', value: 1 }), { fetch: f.fn, env });
    check('save_setting 被 DB 拒絕：403', res.status === 403 && (await res.json()).code === 'admin_only');
  }
  {
    const f = fakeFetch([...liffRoutes(), ['/rpc/get_line_messaging_config', { body: { success: true, has_token: true, token_hint: '…1234', group_id: 'CgroupA', token: 'SHOULD-NOT-LEAK' } }]]);
    const res = await push.handleLinePush(post('https://fn/line-push', { action: 'get_line_config', liff_access_token: 'liff-at', company_id: COMPANY }), { fetch: f.fn, env });
    const out = await res.json().catch(() => ({}));
    const call = f.calls.find(c => c.url.includes('/rpc/get_line_messaging_config'));
    check('get_line_config：只回 has_token／末 4 碼／群組，即使 DB 多回欄位也不外洩', res.status === 200 && out.has_token === true && out.token_hint === '…1234' && out.group_id === 'CgroupA' && !JSON.stringify(out).includes('SHOULD-NOT-LEAK') && call.body.p_line_user_id === LIFF_USER);
  }
  {
    const f = fakeFetch([...liffRoutes(), ['/rpc/platform_admin_save', { body: { success: true, id: 'new-id' } }]]);
    const res = await push.handleLinePush(post('https://fn/line-push', { action: 'platform_admin_save', liff_access_token: 'liff-at', line_user_id: ' U' + '1'.repeat(32) + ' ', name: '新', is_active: true, company_ids: [COMPANY, 'bad-id'] }), { fetch: f.fn, env });
    const call = f.calls.find(c => c.url.includes('/rpc/platform_admin_save'));
    check('platform_admin_save：呼叫者＝LINE 驗出的 userId、公司 ID 只收 UUID', res.status === 200 && !!call && call.body.p_caller_line_user_id === LIFF_USER && call.body.p_line_user_id === 'U' + '1'.repeat(32) && call.body.p_company_ids.length === 1 && (await res.json()).id === 'new-id');
  }
  {
    const f = fakeFetch([...liffRoutes(), ['/rpc/platform_link_company_owner', { body: { success: false, error_code: 'access_denied', error: '需要平台管理員權限' } }]]);
    const res = await push.handleLinePush(post('https://fn/line-push', { action: 'platform_link_company', liff_access_token: 'liff-at', company_id: COMPANY }), { fetch: f.fn, env });
    check('platform_link_company：非平台管理員 403', res.status === 403);
  }
  {
    const f = fakeFetch(liffRoutes({ verify: { status: 400, body: {} } }));
    const res = await push.handleLinePush(post('https://fn/line-push', { action: 'platform_admin_save', liff_access_token: 'forged', line_user_id: 'U' + '1'.repeat(32), name: 'x', company_ids: [COMPANY] }), { fetch: f.fn, env });
    check('LIFF 驗證失敗：平台管理員動作 401、不碰 DB', res.status === 401 && !f.calls.some(c => c.url.includes('/rpc/')));
  }

  console.log('\n=== save_settings（批次）===');
  {
    let n = 0;
    const f = fakeFetch(liffRoutes({ save: () => { n++; return { body: n === 2 ? { success: false, error_code: 'admin_only', error: '只有管理員可以修改此設定' } : { success: true } }; } }));
    const res = await push.handleLinePush(post('https://fn/line-push', { action: 'save_settings', liff_access_token: 'liff-at', company_id: COMPANY,
      items: [{ key: 'a', value: 1 }, { key: 'line_monthly_budget', value: 2 }, { key: 'c', value: 3 }] }), { fetch: f.fn, env });
    const out = await res.json().catch(() => ({}));
    const verifies = f.calls.filter(c => c.url.includes('/oauth2/v2.1/verify')).length;
    const saves = f.calls.filter(c => c.url.includes('/rpc/admin_save_setting'));
    check('批次：只驗一次 LIFF，每筆都以驗出的 userId 呼叫 admin_save_setting', verifies === 1 && saves.length === 2 && saves.every(c => c.body.p_line_user_id === LIFF_USER));
    check('批次：遇到第一筆失敗就停，回報 failed_key 與已存筆數', res.status === 403 && out.code === 'admin_only' && out.failed_key === 'line_monthly_budget' && out.saved_count === 1);
  }
  {
    const f = fakeFetch(liffRoutes());
    const res = await push.handleLinePush(post('https://fn/line-push', { action: 'save_settings', liff_access_token: 'liff-at', company_id: COMPANY,
      items: [{ key: 'a', value: 1 }, { key: 'line_messaging_api', value: { token: 'x' } }] }), { fetch: f.fn, env });
    check('批次不能夾帶 LINE token', res.status === 400 && !f.calls.some(c => c.url.includes('/rpc/')));
  }
  {
    const f = fakeFetch(liffRoutes());
    const items = Array.from({ length: 31 }, (_, i) => ({ key: 'k' + i, value: i }));
    const res = await push.handleLinePush(post('https://fn/line-push', { action: 'save_settings', liff_access_token: 'liff-at', company_id: COMPANY, items }), { fetch: f.fn, env });
    check('批次超過 30 筆：400', res.status === 400 && !f.calls.some(c => c.url.includes('/rpc/')));
  }

  console.log('\n=== line-webhook ===');
  const secret = 'channel-secret';
  const envS = envOf({ SUPABASE_URL: 'https://db.test', SUPABASE_SERVICE_ROLE_KEY: 'service-key', LINE_CHANNEL_TOKEN: 'line-token', LINE_CHANNEL_SECRET: secret });
  const sign = raw => crypto.createHmac('sha256', secret).update(raw).digest('base64');
  const ev = (text, source) => JSON.stringify({ events: [{ type: 'message', replyToken: 'rt', message: { type: 'text', text }, source }] });

  {
    const raw = ev('＃代辦　', { type: 'user', userId: 'U1' });
    const f = fakeFetch([['/rpc/line_pull_todo', { body: JSON.stringify('📋 我的待辦') }], ['/message/reply', { status: 200 }]]);
    await hook.handleLineWebhook(post('https://fn/line-webhook', raw, { 'x-line-signature': sign(raw) }), { fetch: f.fn, env: envS });
    check('全形「＃」＋全形空白＋同音「代辦」也認得（中文輸入法）', f.calls.some(c => c.url.includes('line_pull_todo')) && f.calls.some(c => c.url.includes('/message/reply')));
  }
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
