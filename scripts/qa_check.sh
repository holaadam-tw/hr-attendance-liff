#!/bin/bash
# RunPiston QA 自動檢查腳本
# 每次修改程式後必須執行：bash scripts/qa_check.sh
# 有 FAIL 項目必須修正才能 commit

cd "$(dirname "$0")/.." || exit 1

FAIL=0
WARN=0

echo "========================================"
echo "  RunPiston QA Check"
echo "========================================"
echo ""

# === 1. 全域變數衝突 ===
echo "--- 1. 全域變數衝突檢查 ---"
# 排除獨立頁面（不載入 common.js）
CONFLICTS=$(grep -rn "^let \|^const \|^var " *.html 2>/dev/null | grep -E "currentEmployee|currentCompanyId|liffProfile|sb |officeLocations" | grep -v "booking_service\.html\|kds\.html\|register\.html\|booking\.html\|order\.html\|attendance_public\.html\|employee_register\.html" || true)
if [ -n "$CONFLICTS" ]; then
    echo "FAIL: HTML 檔案中有與 common.js 重複的全域變數宣告："
    echo "$CONFLICTS"
    FAIL=$((FAIL+1))
else
    echo "PASS"
fi
echo ""

# === 2. maybeSingle().catch 陷阱 ===
echo "--- 2. maybeSingle().catch() 陷阱 ---"
TRAPS=$(grep -rn "\.maybeSingle()\.catch\|\.single()\.catch" *.html *.js modules/*.js 2>/dev/null || true)
if [ -n "$TRAPS" ]; then
    echo "FAIL: maybeSingle()/single() 不能直接 .catch()，需用 try/catch："
    echo "$TRAPS"
    FAIL=$((FAIL+1))
else
    echo "PASS"
fi
echo ""

# === 3. 時區問題（DB 時間顯示） ===
echo "--- 3. 時區問題檢查 ---"
# 檢查 toLocaleTimeString/toLocaleString/toLocaleDateString 缺少 timeZone
# 排除數字格式化（金額用 .toLocaleString()）— 只檢查 new Date(...).toLocale*
TZ_ISSUES=$(grep -rn "new Date(.*\.toLocaleTimeString\|new Date(.*\.toLocaleString\|new Date(.*\.toLocaleDateString\|\.toLocaleDateString()" *.html modules/*.js 2>/dev/null | grep -v "timeZone" | grep -v "node_modules" | grep -v "qa_check" || true)
if [ -n "$TZ_ISSUES" ]; then
    echo "WARN: 以下 toLocale*() 呼叫缺少 timeZone: 'Asia/Taipei'："
    echo "$TZ_ISSUES"
    WARN=$((WARN+1))
else
    echo "PASS"
fi
echo ""

# === 4. DB 時間用 getHours/getMinutes（排除即時時鐘） ===
echo "--- 4. getHours/getMinutes 用於 DB 時間 ---"
GH_ISSUES=$(grep -rn "\.getHours()\|\.getMinutes()" *.html modules/*.js 2>/dev/null | grep -iE "created_at|check_in|check_out|arrive_time|leave_time|updated_at" || true)
if [ -n "$GH_ISSUES" ]; then
    echo "FAIL: DB 回傳時間不應用 getHours()/getMinutes()，改用 toLocaleTimeString + timeZone："
    echo "$GH_ISSUES"
    FAIL=$((FAIL+1))
else
    echo "PASS"
fi
echo ""

# === 5. 多租戶隔離（主表查詢缺 company_id） ===
echo "--- 5. 多租戶隔離檢查 ---"
# 檢查常用表的 select 查詢有無 company_id 或 employee_id 篩選
ISOLATION=$(grep -rn "from('attendance')\|from('leave_requests')\|from('system_settings')" modules/*.js *.html 2>/dev/null | grep "select(" | grep -v "company_id\|employee_id\|currentCompanyId\|currentEmployee" || true)
if [ -n "$ISOLATION" ]; then
    echo "WARN: 以下查詢可能缺少 company_id 篩選："
    echo "$ISOLATION"
    WARN=$((WARN+1))
else
    echo "PASS"
fi
echo ""

# === 6. 返回按鍵檢查 ===
echo "--- 6. 子頁面返回按鍵 ---"
SUBPAGES="checkin.html records.html salary.html requests.html schedule.html services.html fieldwork.html booking_service_admin.html loyalty_admin.html"
MISSING_BACK=""
for f in $SUBPAGES; do
    if [ -f "$f" ]; then
        if ! grep -q "返回\|history.back\|goBack" "$f" 2>/dev/null; then
            MISSING_BACK="$MISSING_BACK  $f\n"
        fi
    fi
done
if [ -n "$MISSING_BACK" ]; then
    echo "WARN: 以下頁面缺少返回按鍵："
    echo -e "$MISSING_BACK"
    WARN=$((WARN+1))
else
    echo "PASS"
fi
echo ""

# === 7. LIFF 頁面分類確認 ===
echo "--- 7. 消費者頁面不應有 LIFF ---"
CONSUMER_PAGES="booking.html booking_service.html order.html"
CONSUMER_LIFF=""
for f in $CONSUMER_PAGES; do
    if [ -f "$f" ]; then
        if grep -q "initializeLiff\|checkUserStatus" "$f" 2>/dev/null; then
            CONSUMER_LIFF="$CONSUMER_LIFF  $f\n"
        fi
    fi
done
if [ -n "$CONSUMER_LIFF" ]; then
    echo "FAIL: 消費者頁面不應使用 LIFF："
    echo -e "$CONSUMER_LIFF"
    FAIL=$((FAIL+1))
else
    echo "PASS"
fi
echo ""

# === 結果 ===
echo "========================================"
if [ $FAIL -gt 0 ]; then
    echo "  RESULT: ${FAIL} FAIL, ${WARN} WARN"
    echo "  必須修正 FAIL 項目才能 commit"
    echo "========================================"
    exit 1
elif [ $WARN -gt 0 ]; then
    echo "  RESULT: 0 FAIL, ${WARN} WARN"
    echo "  WARN 項目請確認是否為預期行為"
    echo "========================================"
    exit 0
else
    echo "  RESULT: ALL PASS"
    echo "========================================"
    exit 0
fi
