-- ============================================================
-- 152: leave_requests 撤除最後的公開讀取（RLS 階段 2 收尾）
--
-- ⚠️ 套用前提（順序不可顛倒）：
--   1. migration 148、149、151 已套用。
--   2. 149-B／149-C 前端已合併並部署，線上讀取全部改走 149 的四支
--      SECURITY DEFINER RPC：get_company_leave_requests、get_my_leave_requests、
--      get_company_leave_overlap、get_public_today_leave_employees。
--   3. 套用當下必須用 curl 重新抓線上的 common.js、modules/*.js 與各 HTML，
--      確認 0 處出現 from('leave_requests') 或 from("leave_requests")；不可只檢查本機。
--      任一直接讀取仍存在時不得套用，否則該畫面會 permission denied。
--
-- 為何安全：
--   - 正式庫 2026-10-14 唯讀快照只有「允許查看請假單」這一條公開讀取政策，
--     anon／authenticated 只有 SELECT table grant；RLS 已開。
--   - 讀取已全部走 migration 149 的 SECURITY DEFINER RPC（owner=postgres）；
--     submit_leave_request、approve_leave_request 與 migration 151 公務機送單也都是
--     SECURITY DEFINER 委派路徑，不依賴 anon／authenticated 的 table 權限或政策。
--   - postgres／service_role 的既有 grant 不在本檔 REVOKE 對象內。
--
-- 結果：
--   leave_requests 維持 RLS on，且 PUBLIC／anon／authenticated 沒有 table 權限，
--   也沒有任何適用於這三個角色的 policy；與 overtime_requests（110）及
--   attendance_anomalies（092）的「公開角色只能走 RPC」設計一致。
--
-- 回滾：migrations/152_leave_requests_read_lock_rollback.sql
--   精確還原「允許查看請假單」原文與 anon／authenticated 的兩個 SELECT grant。
--   回滾會重新開放公開 key 直接讀整張 leave_requests，只供 152 導致線上故障時使用。
--
-- 套用身分：表擁有者 postgres；檔尾自我檢查失敗會使整筆交易回復。
-- 只建立 migration 檔，不得由開發流程直接套用正式資料庫。
-- ============================================================

BEGIN;

-- 先確認 149 的四支正式讀取入口存在；缺一支就拒絕收掉直接讀取。
DO $$
DECLARE
  f TEXT;
BEGIN
  FOREACH f IN ARRAY ARRAY[
    'public.get_company_leave_requests(text, uuid, date, date, text[], uuid, integer)',
    'public.get_my_leave_requests(text, uuid, date, date, text[], integer)',
    'public.get_company_leave_overlap(text, uuid, date, date)',
    'public.get_public_today_leave_employees(uuid)'
  ] LOOP
    IF to_regprocedure(f) IS NULL THEN
      RAISE EXCEPTION '149 尚未完整套用：缺少 %，不得撤除 leave_requests 公開讀取', f;
    END IF;
    IF NOT (SELECT p.prosecdef FROM pg_proc p WHERE p.oid = to_regprocedure(f)) THEN
      RAISE EXCEPTION '149 讀取入口不是 SECURITY DEFINER：%', f;
    END IF;
  END LOOP;
END;
$$;

ALTER TABLE public.leave_requests ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "允許查看請假單" ON public.leave_requests;

-- PUBLIC 也一併撤除，避免角色透過 PUBLIC 繼承到殘留權限；
-- 不動 postgres／service_role 的直接 grant。
REVOKE ALL PRIVILEGES ON TABLE public.leave_requests FROM PUBLIC, anon, authenticated;

-- 自我檢查（同一交易）：RLS、有效 table 權限或公開政策任一不符就整筆回復。
DO $$
DECLARE
  r TEXT;
  p TEXT;
BEGIN
  IF NOT (SELECT c.relrowsecurity FROM pg_class c WHERE c.oid = 'public.leave_requests'::regclass) THEN
    RAISE EXCEPTION 'leave_requests 的 RLS 應為開啟';
  END IF;

  -- 從本表 ACL 動態取得實際存在的權限種類（包含新版 PostgreSQL 的 MAINTAIN），
  -- 再以 has_table_privilege 檢查角色的有效權限，避免只檢查 SELECT 而漏掉殘留 grant。
  FOREACH r IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    FOR p IN
      SELECT DISTINCT a.privilege_type
      FROM pg_class c
      CROSS JOIN LATERAL aclexplode(COALESCE(c.relacl, acldefault('r', c.relowner))) a
      WHERE c.oid = 'public.leave_requests'::regclass
    LOOP
      IF has_table_privilege(r, 'public.leave_requests', p) THEN
        RAISE EXCEPTION '撤權未生效：% 仍有 leave_requests 的 %（請以表擁有者 postgres 身分套用）', r, p;
      END IF;
    END LOOP;
  END LOOP;

  IF EXISTS (
    SELECT 1
    FROM pg_policies pp
    CROSS JOIN LATERAL unnest(pp.roles) AS policy_role(role_name)
    WHERE pp.schemaname = 'public'
      AND pp.tablename = 'leave_requests'
      AND CASE
        WHEN policy_role.role_name = 'public' THEN true
        ELSE pg_has_role('anon', policy_role.role_name, 'MEMBER')
          OR pg_has_role('authenticated', policy_role.role_name, 'MEMBER')
      END
  ) THEN
    RAISE EXCEPTION 'leave_requests 仍有直接或經角色繼承適用於 PUBLIC／anon／authenticated 的政策';
  END IF;
END;
$$;

COMMIT;
