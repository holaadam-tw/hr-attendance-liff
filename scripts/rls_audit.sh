#!/bin/bash
# ============================================================
# RLS 正式庫稽核（需連線，不在 qa_check.sh 每次跑）
#
# 用法：bash scripts/rls_audit.sh
# 需要：supabase CLI 已 link 到正式專案
#
# 背景（2026-08-05 盤點）：
#   公開的 anon key（寫在 common.js 裡，打開網頁就看得到）對 employees /
#   attendance / payroll_records / overtime_requests 都有完整 DML 權限，
#   唯一防線是 RLS。而當時實況是：
#     - overtime_requests：RLS 完全關閉、0 條 policy
#     - employees / attendance：允許查看／允許更新 皆 USING (true)，
#       角色明確是 anon, authenticated
#     - payroll_records：payroll_select / payroll_update 皆 USING (true)，PUBLIC
#   同表那條 Block direct access USING (false) 沒有作用——permissive policy
#   是 OR 起來的，只要有一條 true 就全開。
#
# 這支腳本只讀 metadata（pg_class / pg_policy / information_schema），
# 不撈任何一筆業務資料。
#
# 修復方向（尚未執行，需單獨排期）：
#   前端是 LIFF 認證、沒有 Supabase auth session，直接收緊成 auth.jwt() 型
#   政策會讓所有頁面壞掉。正解是全面改走 SECURITY DEFINER RPC，再把 USING(true)
#   政策撤掉。詳見 docs/BUG_TRACKER.md。
# ============================================================

set -u
TABLES="'employees','attendance','payroll_records','overtime_requests','leave_requests','makeup_punch_requests','schedules','system_settings','attendance_anomalies','checkin_failures'"

echo "========================================"
echo "  RLS 正式庫稽核"
echo "========================================"
echo ""

echo "--- 1. RLS 未開啟的表（anon 可直接讀寫全部）---"
supabase db query --linked " SELECT c.relname AS 資料表, count(p.polname)::text AS 政策數
 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
 LEFT JOIN pg_policy p ON p.polrelid=c.oid
 WHERE n.nspname='public' AND c.relkind='r' AND c.relrowsecurity=false
   AND c.relname NOT LIKE '\\_%'
 GROUP BY 1 ORDER BY 1;" 2>&1 | sed -n '/rows/,/]/p'
echo ""

echo "--- 2. USING(true) 且套用到 anon/PUBLIC 的政策（等於 RLS 全開）---"
supabase db query --linked " SELECT c.relname AS 資料表, p.polname AS 政策,
 CASE p.polcmd WHEN 'r' THEN 'SELECT' WHEN 'a' THEN 'INSERT' WHEN 'w' THEN 'UPDATE' WHEN 'd' THEN 'DELETE' ELSE 'ALL' END AS 動作,
 CASE WHEN p.polroles='{0}' THEN 'PUBLIC' ELSE (SELECT string_agg(r.rolname,',') FROM pg_roles r WHERE r.oid=ANY(p.polroles)) END AS 角色
 FROM pg_policy p JOIN pg_class c ON c.oid=p.polrelid
 WHERE p.polpermissive AND pg_get_expr(p.polqual,p.polrelid)='true'
   AND (p.polroles='{0}' OR EXISTS (SELECT 1 FROM pg_roles r WHERE r.oid=ANY(p.polroles) AND r.rolname IN ('anon','authenticated')))
 ORDER BY 1,2;" 2>&1 | sed -n '/rows/,/]/p'
echo ""

echo "--- 3. RLS 已開但 0 條政策（全擋，須確認是走 RPC 的設計）---"
supabase db query --linked " SELECT c.relname AS 資料表
 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
 WHERE n.nspname='public' AND c.relkind='r' AND c.relrowsecurity=true
   AND NOT EXISTS (SELECT 1 FROM pg_policy p WHERE p.polrelid=c.oid)
 ORDER BY 1;" 2>&1 | sed -n '/rows/,/]/p'
echo ""

echo "--- 4. anon 對關鍵表的 table-level 權限 ---"
supabase db query --linked " SELECT table_name AS 資料表, string_agg(DISTINCT privilege_type,',' ORDER BY privilege_type) AS 權限
 FROM information_schema.role_table_grants
 WHERE table_schema='public' AND grantee='anon' AND table_name IN ($TABLES)
 GROUP BY 1 ORDER BY 1;" 2>&1 | sed -n '/rows/,/]/p'
echo ""

echo "========================================"
echo "  判讀："
echo "  · 第 1 段有列出的表 = anon 可直接讀寫全部資料"
echo "  · 第 2 段有列出的政策 = 該表該動作對 anon 全開"
echo "  · 第 3 段是預期內的（走 SECURITY DEFINER RPC），確認即可"
echo "========================================"
