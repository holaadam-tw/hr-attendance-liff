// Supabase-compatible adapters for LINE-verified RPCs.
// callVerifiedRpc serves migration 162 admin RPCs and keeps its existing relogin behavior.
// callSelfRpc serves migration 163 employee RPCs; reads do not relogin unless autoRelogin is true.
// The Edge Function, never the browser, supplies the verified LINE user ID.
(function installVerifiedRpc(global) {
    // common.js 自 C2 起已內建同契約 adapter；同時載入時保留 common.js 的實作。
    if (typeof global.callVerifiedRpc === 'function' && typeof global.callSelfRpc === 'function') return;

    const SELF_RPC_COMPANY_FNS = new Set([
        'get_company_leave_overlap',
        'get_leave_history',
        'get_my_leave_requests',
        'register_employee',
        'set_my_preferred_language',
        'submit_leave_request'
    ]);
    let selfLoginNoticeShown = false;

    function verifiedRpcError(response, fallbackMessage) {
        return {
            data: null,
            error: {
                message: response?.message || response?.error || fallbackMessage,
                code: response?.code || 'verified_rpc_failed'
            }
        };
    }

    function notifySelfLoginRequired() {
        if (selfLoginNoticeShown) return;
        selfLoginNoticeShown = true;
        if (typeof global.showToast === 'function') {
            global.showToast('LINE 登入已失效，請從 LINE 重新開啟頁面');
        }
    }

    async function callVerifiedActionWithoutRelogin(action, payload) {
        const accessToken = typeof global.getLiffAccessTokenSafe === 'function'
            ? global.getLiffAccessTokenSafe()
            : null;
        if (!accessToken) {
            notifySelfLoginRequired();
            return { ok: false, code: 'unauthenticated', message: 'LINE 登入已失效，請從 LINE 重新開啟頁面' };
        }

        try {
            const config = typeof CONFIG !== 'undefined' ? CONFIG : global.CONFIG;
            if (!config?.SUPABASE_URL || !config?.SUPABASE_ANON_KEY) {
                return { ok: false, code: 'missing_config', message: '系統設定尚未就緒' };
            }
            const response = await global.fetch(config.SUPABASE_URL + '/functions/v1/line-push', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': 'Bearer ' + config.SUPABASE_ANON_KEY
                },
                body: JSON.stringify({ ...payload, action, liff_access_token: accessToken })
            });
            const result = await response.json().catch(() => null);
            if (!result) return { ok: false, code: 'invalid_response', message: '伺服器回傳無法辨識的結果' };
            if (!result.ok) {
                const code = result.code || 'failed';
                if (code === 'unauthenticated') notifySelfLoginRequired();
                return { ok: false, code, message: result.error || '操作失敗', data: result };
            }
            return { ok: true, code: 'ok', data: result };
        } catch (error) {
            return { ok: false, code: error?.code || 'network_error', message: error?.message || '目前無法連線伺服器，請檢查網路後重試' };
        }
    }

    global.callVerifiedRpc = async function callVerifiedRpc(fn, args = {}, options = {}) {
        const safeArgs = { ...args };
        delete safeArgs.p_line_user_id;
        const companyId = safeArgs.p_company_id || global.currentCompanyId;

        try {
            const payload = {
                company_id: companyId,
                fn,
                args: safeArgs
            };
            const response = options.autoRelogin === false
                ? await callVerifiedActionWithoutRelogin('admin_rpc', payload)
                : await global.callVerifiedAction('admin_rpc', payload);
            if (!response || response.ok !== true) {
                return {
                    data: null,
                    error: {
                        message: response?.message || '管理功能暫時無法使用',
                        code: response?.code || 'verified_rpc_failed'
                    }
                };
            }
            return { data: response.data?.result ?? null, error: null };
        } catch (error) {
            return {
                data: null,
                error: {
                    message: error?.message || '管理功能暫時無法使用',
                    code: error?.code || 'network_error'
                }
            };
        }
    };

    global.callSelfRpc = async function callSelfRpc(fn, args = {}, options = {}) {
        const safeArgs = { ...args };
        delete safeArgs.p_line_user_id;
        const needsCompany = SELF_RPC_COMPANY_FNS.has(fn);
        const companyId = needsCompany ? (safeArgs.p_company_id || global.currentCompanyId) : null;
        if (!needsCompany) delete safeArgs.p_company_id;
        const payload = { fn, args: safeArgs };
        if (companyId) payload.company_id = companyId;

        try {
            const autoRelogin = options.autoRelogin === true;
            const response = autoRelogin
                ? await global.callVerifiedAction('self_rpc', payload)
                : await callVerifiedActionWithoutRelogin('self_rpc', payload);
            if (!response || response.ok !== true) {
                return verifiedRpcError(response, '員工功能暫時無法使用');
            }
            return { data: response.data?.result ?? null, error: null };
        } catch (error) {
            return {
                data: null,
                error: {
                    message: error?.message || '員工功能暫時無法使用',
                    code: error?.code || 'network_error'
                }
            };
        }
    };
})(window);
