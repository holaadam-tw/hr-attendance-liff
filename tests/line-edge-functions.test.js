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

  console.log('\n=== 130／131／132：員工管理、審核、排班、公司維護（身分＝LINE 驗證的 userId）===');
  {
    const EMP = '00000000-0000-0000-0000-0000000000e1';
    const REQ = '00000000-0000-0000-0000-00000000aa01';
    const REQ2 = '00000000-0000-0000-0000-00000000aa02';
    const rpcRoutes = (extra = []) => [...extra, ...liffRoutes(),
      ['/rpc/admin_update_employee', { body: { success: true, id: EMP, name: '員工一', updated_keys: ['role'] } }],
      ['/rpc/admin_create_employee', { body: { success: true, id: EMP, employee_number: 'E09' } }],
      ['/rpc/admin_delete_pending_employee', { body: { success: true, name: '待審' } }],
      ['/rpc/review_makeup_request', (b) => ({ body: b.p_request_id === REQ2 ? { success: false, error: '此申請已處理過', error_code: 'not_pending' } : { success: true, closed_duplicates: 1 } })],
      ['/rpc/review_overtime_request', { body: { success: true } }],
      ['/rpc/save_schedules_verified', { body: { success: true, saved_count: 2 } }],
      ['/rpc/review_shift_swap_request', { body: { success: true, status: 'approved', requester_id: EMP, target_id: EMP, swap_date: '2026-10-05' } }],
      ['/rpc/platform_company_save', { body: { success: true, id: COMPANY, company: { id: COMPANY, code: 'NEW', name: '新公司' } } }],
      ['/rpc/platform_company_set_status', { body: { success: true, id: COMPANY, status: 'active' } }],
      ['/rpc/platform_company_delete_pending', { body: { success: true, name: '待審公司' } }],
    ];
    const call = (f, name) => f.calls.find(c => c.url.includes('/rpc/' + name));
    const run = async (body, routes = rpcRoutes()) => {
      const f = fakeFetch(routes);
      const res = await push.handleLinePush(post('https://fn/line-push', { liff_access_token: 'liff-at', ...body }), { fetch: f.fn, env });
      return { f, res, out: await res.json() };
    };

    let t = await run({ action: 'employee_update', company_id: COMPANY, employee_id: EMP, updates: { role: 'admin' }, line_user_id: 'Uadmin', p_line_user_id: 'Uadmin' });
    let c = call(t.f, 'admin_update_employee');
    check('employee_update：以 LINE 驗出的 userId 呼叫 admin_update_employee（忽略前端夾帶的 line_user_id）',
      t.res.status === 200 && c && c.body.p_line_user_id === LIFF_USER && c.body.p_company_id === COMPANY && c.body.p_employee_id === EMP && c.body.p_updates.role === 'admin' && t.out.result?.id === EMP, JSON.stringify(c?.body));
    t = await run({ action: 'employee_update', company_id: COMPANY, employee_id: EMP, updates: { role: 'admin' } },
      rpcRoutes([['/rpc/admin_update_employee', { body: { success: false, error: '只有管理員可以變更角色', error_code: 'role_denied' } }]]));
    check('employee_update：DB 回 role_denied → 403、訊息照傳', t.res.status === 403 && t.out.code === 'role_denied' && /管理員/.test(t.out.error));
    t = await run({ action: 'employee_update', company_id: COMPANY, employee_id: EMP, updates: { line_user_id: 'Ux' } },
      rpcRoutes([['/rpc/admin_update_employee', { body: { success: false, error: '只有管理員可以修改管理員帳號', error_code: 'target_protected' } }]]));
    check('employee_update：受保護帳號 → 403', t.res.status === 403 && t.out.code === 'target_protected');
    t = await run({ action: 'employee_update', company_id: COMPANY, employee_id: 'bad', updates: {} });
    check('employee_update：員工 ID 不是 UUID → 400、不呼叫 RPC', t.res.status === 400 && !t.f.calls.some(x => x.url.includes('/rpc/')));
    t = await run({ action: 'employee_update', company_id: COMPANY, employee_id: EMP, updates: { role: 'admin' } }, rpcRoutes([['/v2/profile', { status: 401, body: {} }]]));
    check('employee_update：LIFF token 驗不過 → 401、不呼叫 RPC', t.res.status === 401 && t.out.code === 'unauthenticated' && !call(t.f, 'admin_update_employee'));
    t = await run({ action: 'employee_create', company_id: COMPANY, data: { name: '新人', employee_number: 'E09', id_card_last_4: '1234' } });
    c = call(t.f, 'admin_create_employee');
    check('employee_create：呼叫者＝LINE userId、回傳 RPC 結果', t.res.status === 200 && c.body.p_line_user_id === LIFF_USER && c.body.p_data.name === '新人' && t.out.result?.employee_number === 'E09');
    t = await run({ action: 'employee_delete_pending', company_id: COMPANY, employee_id: EMP });
    c = call(t.f, 'admin_delete_pending_employee');
    check('employee_delete_pending：呼叫者＝LINE userId', t.res.status === 200 && c.body.p_line_user_id === LIFF_USER && c.body.p_employee_id === EMP);
    t = await run({ action: 'employee_create', data: { name: 'x' } });
    check('沒帶 company_id → 400', t.res.status === 400 && t.f.calls.length === 0);

    t = await run({ action: 'makeup_review', company_id: COMPANY, request_ids: [REQ], decision: 'approve', approver_id: EMP, p_approver_id: EMP });
    c = call(t.f, 'review_makeup_request');
    check('makeup_review（單筆）：核准人＝LINE userId，前端夾帶的 approver_id 不會送進 DB',
      t.res.status === 200 && c.body.p_line_user_id === LIFF_USER && c.body.p_request_id === REQ && c.body.p_decision === 'approve'
      && !('p_approver_id' in c.body) && !JSON.stringify(c.body).includes(EMP) && t.out.result?.closed_duplicates === 1, JSON.stringify(c?.body));
    t = await run({ action: 'makeup_review', company_id: COMPANY, request_ids: [REQ2], decision: 'reject', reason: '不符' });
    check('makeup_review（單筆）：已處理 → 400 not_pending', t.res.status === 400 && t.out.code === 'not_pending');
    t = await run({ action: 'makeup_review', company_id: COMPANY, request_ids: [REQ, REQ2], decision: 'approve' });
    const verifyCalls = t.f.calls.filter(x => x.url.includes('/oauth2/v2.1/verify')).length;
    check('makeup_review（批次 2 筆）：只驗一次 LIFF、逐筆呼叫、回報各筆結果',
      t.res.status === 200 && verifyCalls === 1 && t.f.calls.filter(x => x.url.includes('/rpc/review_makeup_request')).length === 2
      && t.out.approved_count === 1 && t.out.results.length === 2 && t.out.results[1].error === '此申請已處理過', JSON.stringify(t.out));
    t = await run({ action: 'makeup_review', company_id: COMPANY, request_ids: [REQ, REQ2], decision: 'approve' },
      rpcRoutes([['/rpc/review_makeup_request', { body: { success: false, error: '需要管理員權限', error_code: 'access_denied' } }]]));
    check('makeup_review（批次）：第一筆就 access_denied → 403、不再繼續', t.res.status === 403 && t.f.calls.filter(x => x.url.includes('/rpc/review_makeup_request')).length === 1);
    t = await run({ action: 'makeup_review', company_id: COMPANY, request_ids: Array.from({ length: 51 }, () => REQ), decision: 'approve' });
    check('makeup_review：超過 50 筆 → 400、不呼叫 RPC', t.res.status === 400 && !t.f.calls.some(x => x.url.includes('/rpc/')));
    t = await run({ action: 'makeup_review', company_id: COMPANY, request_ids: [REQ], decision: 'delete' });
    check('makeup_review：decision 不合法 → 400、不呼叫 RPC', t.res.status === 400 && !t.f.calls.some(x => x.url.includes('/rpc/')));

    t = await run({ action: 'overtime_review', company_id: COMPANY, request_id: REQ, decision: 'approve', approved_hours: '1.5', reason_category: 'closing', note: '收攤', approver_id: EMP });
    c = call(t.f, 'review_overtime_request');
    check('overtime_review：核准人＝LINE userId、時數轉數字', t.res.status === 200 && c.body.p_line_user_id === LIFF_USER && c.body.p_approved_hours === 1.5 && c.body.p_reason_category === 'closing' && !JSON.stringify(c.body).includes(EMP));
    t = await run({ action: 'overtime_review', company_id: COMPANY, request_id: REQ, decision: 'approve', approved_hours: 'abc' });
    check('overtime_review：時數不是數字 → 400', t.res.status === 400 && !call(t.f, 'review_overtime_request'));

    const items = [{ employee_id: EMP, date: '2026-10-01', shift_type_id: REQ, is_off_day: false, scheduler_id: EMP }, { employee_id: EMP, date: '2026-10-02', delete: true }];
    t = await run({ action: 'schedule_save', company_id: COMPANY, items, scheduler_id: EMP });
    c = call(t.f, 'save_schedules_verified');
    check('schedule_save：排班人＝LINE userId、只轉送白名單欄位（前端夾帶的 scheduler_id 丟掉）',
      t.res.status === 200 && c.body.p_line_user_id === LIFF_USER && c.body.p_items.length === 2 && !('scheduler_id' in c.body.p_items[0]) && c.body.p_items[1].delete === true && t.out.saved_count === 2, JSON.stringify(c?.body));
    t = await run({ action: 'schedule_save', company_id: COMPANY, items: [{ employee_id: EMP, date: '10/01' }] });
    check('schedule_save：日期格式不對 → 400', t.res.status === 400 && !call(t.f, 'save_schedules_verified'));
    t = await run({ action: 'schedule_save', company_id: COMPANY, items: Array.from({ length: 401 }, () => ({ employee_id: EMP, date: '2026-10-01' })) });
    check('schedule_save：超過 400 筆 → 400、不呼叫 RPC', t.res.status === 400 && !t.f.calls.some(x => x.url.includes('/rpc/')));
    t = await run({ action: 'schedule_save', company_id: COMPANY, items: [{ employee_id: EMP, date: '2026-10-01' }] },
      rpcRoutes([['/rpc/save_schedules_verified', { body: { success: false, error: '沒有排班權限', error_code: 'access_denied' } }]]));
    check('schedule_save：DB 拒絕 → 403', t.res.status === 403 && t.out.code === 'access_denied');

    // 133：換班審核
    t = await run({ action: 'shift_swap_review', company_id: COMPANY, request_id: REQ, decision: 'approve', approver_id: EMP, p_line_user_id: 'Uadmin' });
    c = call(t.f, 'review_shift_swap_request');
    check('shift_swap_review：審核人＝LINE userId，前端夾帶的 approver_id／p_line_user_id 不會送進 DB',
      t.res.status === 200 && c.body.p_line_user_id === LIFF_USER && c.body.p_company_id === COMPANY && c.body.p_request_id === REQ && c.body.p_decision === 'approve'
      && c.body.p_reason === null && !('p_approver_id' in c.body) && !JSON.stringify(c.body).includes('Uadmin') && t.out.result?.status === 'approved', JSON.stringify(c?.body));
    t = await run({ action: 'shift_swap_review', company_id: COMPANY, request_id: REQ, decision: 'reject', reason: '人手不足' });
    check('shift_swap_review：拒絕帶原因', t.res.status === 200 && call(t.f, 'review_shift_swap_request').body.p_reason === '人手不足');
    t = await run({ action: 'shift_swap_review', company_id: COMPANY, request_id: 'bad', decision: 'approve' });
    check('shift_swap_review：申請 ID 不是 UUID → 400、不呼叫 RPC', t.res.status === 400 && !t.f.calls.some(x => x.url.includes('/rpc/')));
    t = await run({ action: 'shift_swap_review', company_id: COMPANY, request_id: REQ, decision: 'swap' });
    check('shift_swap_review：decision 不合法 → 400、不呼叫 RPC', t.res.status === 400 && !t.f.calls.some(x => x.url.includes('/rpc/')));
    t = await run({ action: 'shift_swap_review', request_id: REQ, decision: 'approve' });
    check('shift_swap_review：沒帶 company_id → 400', t.res.status === 400 && t.f.calls.length === 0);
    t = await run({ action: 'shift_swap_review', company_id: COMPANY, request_id: REQ, decision: 'approve' }, rpcRoutes([['/v2/profile', { status: 401, body: {} }]]));
    check('shift_swap_review：LIFF token 驗不過 → 401、不呼叫 RPC', t.res.status === 401 && !call(t.f, 'review_shift_swap_request'));
    t = await run({ action: 'shift_swap_review', company_id: COMPANY, request_id: REQ, decision: 'approve' },
      rpcRoutes([['/rpc/review_shift_swap_request', { body: { success: false, error: '需要管理員權限', error_code: 'access_denied' } }]]));
    check('shift_swap_review：DB 拒絕 → 403', t.res.status === 403 && t.out.code === 'access_denied');
    t = await run({ action: 'shift_swap_review', company_id: COMPANY, request_id: REQ, decision: 'approve' },
      rpcRoutes([['/rpc/review_shift_swap_request', { body: { success: false, error: '雙方當天都必須已有排班，才能核准換班', error_code: 'schedule_missing' } }]]));
    check('shift_swap_review：缺排班 → 400、訊息照傳', t.res.status === 400 && t.out.code === 'schedule_missing' && /雙方當天/.test(t.out.error));

    t = await run({ action: 'company_save', fields: { code: 'NEW', name: '新公司' } });
    c = call(t.f, 'platform_company_save');
    check('company_save（新增，不帶 company_id）：呼叫者＝LINE userId', t.res.status === 200 && c.body.p_caller_line_user_id === LIFF_USER && c.body.p_company_id === null && c.body.p_fields.code === 'NEW' && t.out.result?.company?.code === 'NEW');
    t = await run({ action: 'company_save', company_id: COMPANY, fields: { name: '改名' } });
    check('company_save（修改）：帶 company_id', t.res.status === 200 && call(t.f, 'platform_company_save').body.p_company_id === COMPANY);
    t = await run({ action: 'company_save', company_id: 'bad', fields: { name: 'x' } });
    check('company_save：company_id 不是 UUID → 400', t.res.status === 400 && t.f.calls.length === 0);
    t = await run({ action: 'company_save', fields: { code: 'NEW', name: 'x' } },
      rpcRoutes([['/rpc/platform_company_save', { body: { success: false, error: '需要平台管理員權限', error_code: 'access_denied' } }]]));
    check('company_save：非平台管理員 → 403', t.res.status === 403 && t.out.code === 'access_denied');
    t = await run({ action: 'company_set_status', company_id: COMPANY, status: 'active' });
    check('company_set_status：呼叫者＝LINE userId', t.res.status === 200 && call(t.f, 'platform_company_set_status').body.p_caller_line_user_id === LIFF_USER);
    t = await run({ action: 'company_set_status', company_id: COMPANY, status: 'deleted' });
    check('company_set_status：狀態不合法 → 400、不呼叫 RPC', t.res.status === 400 && !t.f.calls.some(x => x.url.includes('/rpc/')));
    t = await run({ action: 'company_delete_pending', company_id: COMPANY });
    check('company_delete_pending：呼叫者＝LINE userId', t.res.status === 200 && call(t.f, 'platform_company_delete_pending').body.p_caller_line_user_id === LIFF_USER);
    t = await run({ action: 'company_delete_pending', company_id: COMPANY }, rpcRoutes([['/rpc/platform_company_delete_pending', { status: 500, body: { message: 'boom' } }]]));
    check('RPC 連不上 → 503', t.res.status === 503 && t.out.code === 'service_unavailable');

    // L1：批次中途連不上 DB → 回報已處理的每一筆（已核准的 id、停在哪一筆、哪些沒處理）
    const REQ3 = '00000000-0000-0000-0000-00000000aa03';
    let n = 0;
    t = await run({ action: 'makeup_review', company_id: COMPANY, request_ids: [REQ, REQ2, REQ3], decision: 'approve' },
      rpcRoutes([['/rpc/review_makeup_request', (b) => (++n === 3 ? { status: 500, body: { message: 'boom' } }
        : { body: b.p_request_id === REQ2 ? { success: false, error: '此申請已處理過', error_code: 'not_pending' } : { success: true } })]]));
    check('makeup_review（批次）：第 3 筆 DB 失敗 → 503，並回報第 1 筆已核准、第 2 筆失敗原因、停在第 3 筆',
      t.res.status === 503 && t.out.ok === false && t.out.code === 'service_unavailable' && t.out.approved_count === 1
      && t.out.approved_ids.length === 1 && t.out.approved_ids[0] === REQ && t.out.results.length === 2 && t.out.results[1].error === '此申請已處理過'
      && t.out.failed_id === REQ3 && Array.isArray(t.out.not_processed_ids) && t.out.not_processed_ids.length === 0, JSON.stringify(t.out));
    // LOW：重複的 request_id 只處理一次
    n = 0;
    t = await run({ action: 'makeup_review', company_id: COMPANY, request_ids: [REQ, REQ, REQ3], decision: 'approve' });
    check('makeup_review：重複的 id 去重後只呼叫一次 RPC', t.res.status === 200 && t.f.calls.filter(x => x.url.includes('/rpc/review_makeup_request')).length === 2 && t.out.results.length === 2);
    // L5：RPC 不存在（migration 還沒套）→ 明確告知
    const missingRoute = (name) => rpcRoutes([['/rpc/' + name, { status: 404, body: { code: 'PGRST202', message: 'Could not find the function public.' + name } }]]);
    t = await run({ action: 'makeup_review', company_id: COMPANY, request_ids: [REQ], decision: 'approve' }, missingRoute('review_makeup_request'));
    check('RPC 不存在（131 未套）：503 db_not_migrated「資料庫尚未更新（131）」', t.res.status === 503 && t.out.code === 'db_not_migrated' && /資料庫尚未更新（131）/.test(t.out.error), JSON.stringify(t.out));
    t = await run({ action: 'company_save', fields: { code: 'X', name: 'x' } }, missingRoute('platform_company_save'));
    check('RPC 不存在（130 未套）：「資料庫尚未更新（130）」', t.res.status === 503 && /資料庫尚未更新（130）/.test(t.out.error));
    t = await run({ action: 'shift_swap_review', company_id: COMPANY, request_id: REQ, decision: 'approve' }, missingRoute('review_shift_swap_request'));
    check('RPC 不存在（133 未套）：「資料庫尚未更新（133）」', t.res.status === 503 && t.out.code === 'db_not_migrated' && /資料庫尚未更新（133）/.test(t.out.error));
    n = 0;
    t = await run({ action: 'makeup_review', company_id: COMPANY, request_ids: [REQ, REQ3], decision: 'approve' }, missingRoute('review_makeup_request'));
    check('批次第 1 筆就發現 RPC 不存在：db_not_migrated、0 筆核准、其餘列為未處理', t.res.status === 503 && t.out.code === 'db_not_migrated' && t.out.approved_count === 0 && t.out.failed_id === REQ && t.out.not_processed_ids[0] === REQ3);
    // ---- 136：薪酬密碼伺服器端比對 ----
    const unlockRoutes = (resp) => rpcRoutes([['/rpc/payroll_password_unlock', resp]]);
    t = await run({ action: 'payroll_unlock', company_id: COMPANY, password: 'pw-1234', line_user_id: 'Uadmin' },
      unlockRoutes({ body: { success: true, unlock_token: 'tok', expires_at: '2026-09-28T16:00:00+00:00', configured: true } }));
    c = call(t.f, 'payroll_password_unlock');
    check('payroll_unlock：以 LINE 驗出的 userId 呼叫 payroll_password_unlock（忽略前端夾帶的 line_user_id）、回短效解鎖',
      t.res.status === 200 && c && c.body.p_line_user_id === LIFF_USER && c.body.p_company_id === COMPANY && c.body.p_password === 'pw-1234'
      && t.out.unlock_token === 'tok' && t.out.expires_at === '2026-09-28T16:00:00+00:00' && t.out.configured === true, JSON.stringify(t.out));
    check('payroll_unlock：回應不含密碼', !JSON.stringify(t.out).includes('pw-1234'));
    t = await run({ action: 'payroll_unlock', company_id: COMPANY, password: 'nope' },
      unlockRoutes({ body: { success: false, error: '密碼錯誤', error_code: 'wrong_password' } }));
    check('payroll_unlock：密碼錯 → 403 wrong_password、沒有 unlock_token', t.res.status === 403 && t.out.code === 'wrong_password' && !t.out.unlock_token);
    t = await run({ action: 'payroll_unlock', company_id: COMPANY, password: 'nope' },
      unlockRoutes({ body: { success: false, error: '密碼錯誤次數太多，請 15 分鐘後再試', error_code: 'rate_limited' } }));
    check('payroll_unlock：錯太多次 → 429 rate_limited', t.res.status === 429 && t.out.code === 'rate_limited' && /15 分鐘/.test(t.out.error));
    t = await run({ action: 'payroll_unlock', company_id: COMPANY, password: 'x' },
      unlockRoutes({ body: { success: false, error: '您不是這家公司的成員', error_code: 'access_denied' } }));
    check('payroll_unlock：非公司成員 → 403 access_denied', t.res.status === 403 && t.out.code === 'access_denied');
    t = await run({ action: 'payroll_unlock', company_id: COMPANY, password: '' });
    check('payroll_unlock：沒帶密碼 → 400、不呼叫 RPC', t.res.status === 400 && !t.f.calls.some(x => x.url.includes('/rpc/')));
    t = await run({ action: 'payroll_unlock', company_id: COMPANY, password: 'x'.repeat(101) });
    check('payroll_unlock：密碼過長 → 400、不呼叫 RPC', t.res.status === 400 && !t.f.calls.some(x => x.url.includes('/rpc/')));
    t = await run({ action: 'payroll_unlock', password: 'pw' });
    check('payroll_unlock：沒帶公司 → 400', t.res.status === 400 && t.f.calls.length === 0);
    t = await run({ action: 'payroll_unlock', company_id: COMPANY, password: 'pw' }, rpcRoutes([['/v2/profile', { status: 401, body: {} }]]));
    check('payroll_unlock：LIFF token 驗不過 → 401、不比對密碼', t.res.status === 401 && !call(t.f, 'payroll_password_unlock'));
    t = await run({ action: 'payroll_unlock', company_id: COMPANY, password: 'pw' }, unlockRoutes({ status: 500, body: { message: 'boom' } }));
    check('payroll_unlock：RPC 連不上 → 503（fail-closed，不放行）', t.res.status === 503 && !t.out.unlock_token);
    t = await run({ action: 'payroll_unlock', company_id: COMPANY, password: 'pw' }, missingRoute('payroll_password_unlock'));
    check('payroll_unlock：136 未套 → 503「資料庫尚未更新（136）」、不放行', t.res.status === 503 && t.out.code === 'db_not_migrated' && /（136）/.test(t.out.error) && !t.out.unlock_token);
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
