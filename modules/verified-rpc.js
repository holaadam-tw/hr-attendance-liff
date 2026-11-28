// Supabase-compatible adapter for migration 162 admin RPCs.
// The Edge Function, never the browser, supplies the verified LINE user ID.
(function installVerifiedRpc(global) {
    global.callVerifiedRpc = async function callVerifiedRpc(fn, args = {}) {
        const safeArgs = { ...args };
        delete safeArgs.p_line_user_id;
        const companyId = safeArgs.p_company_id || global.currentCompanyId;

        try {
            const response = await global.callVerifiedAction('admin_rpc', {
                company_id: companyId,
                fn,
                args: safeArgs
            });
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
})(window);
