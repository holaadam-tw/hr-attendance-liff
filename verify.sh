#!/bin/bash
BASE="https://holaadam-tw.github.io"
SB_URL="https://nssuisyvlrqnqfxupklb.supabase.co"
SB_KEY="eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im5zc3Vpc3l2bHJxbnFmeHVwa2xiIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjkyOTAwMzUsImV4cCI6MjA4NDg2NjAzNX0.q_B6v3gf1TOCuAq7z0xIw10wDueCSJn0p37VzdMfmbc"

echo "=== 🏥 最終系統驗證 ==="
PASS=0; FAIL=0

check() {
  if [ "$2" -ge "$3" ]; then
    echo "  ✅ $1 ($2)"
    PASS=$((PASS+1))
  else
    echo "  ❌ $1 ($2, 預期≥$3)"
    FAIL=$((FAIL+1))
  fi
}

# 下載頁面
curl -s "$BASE/admin.html" -o /tmp/a.html
curl -s "$BASE/order.html" -o /tmp/o.html
curl -s "$BASE/index.html" -o /tmp/i.html
curl -s "$BASE/common.js" -o /tmp/c.js

echo ""
echo "--- admin.html ---"
V=$(grep -c 'class="menu-item"' /tmp/a.html)
if [ "$V" -le 15 ]; then echo "  ✅ 選單項目 $V (≤15)"; PASS=$((PASS+1)); else echo "  ❌ 選單項目 $V (>15)"; FAIL=$((FAIL+1)); fi
check "switchPayTab" $(grep -c "switchPayTab" /tmp/a.html) 1
check "switchSysTab" $(grep -c "switchSysTab" /tmp/a.html) 1
check "bookingMgrPage" $(grep -c 'id="bookingMgrPage"' /tmp/a.html) 1
check "memberMgrPage" $(grep -c 'id="memberMgrPage"' /tmp/a.html) 1
check "data-feature=booking" $(grep -c 'data-feature="booking"' /tmp/a.html) 1
check "data-feature=member" $(grep -c 'data-feature="member"' /tmp/a.html) 1

echo ""
echo "--- order.html ---"
check "confirmPhone" $(grep -c "confirmPhone" /tmp/o.html) 1
check "onConfirmPhoneInput" $(grep -c "onConfirmPhoneInput" /tmp/o.html) 1
check "loadConfirmMemberInfo" $(grep -c "loadConfirmMemberInfo" /tmp/o.html) 1
check "showMyOrdersPanel" $(grep -c "showMyOrdersPanel" /tmp/o.html) 1
check "myOrdersOverlay" $(grep -c "myOrdersOverlay" /tmp/o.html) 1
check "headerOrderBtn" $(grep -c "headerOrderBtn" /tmp/o.html) 1
check "checkMyOrdersOnLoad" $(grep -c "checkMyOrdersOnLoad" /tmp/o.html) 1
check "loadMyOrdersForPanel" $(grep -c "loadMyOrdersForPanel" /tmp/o.html) 1
check "renderMyOrderCard" $(grep -c "renderMyOrderCard" /tmp/o.html) 1

echo ""
echo "--- index.html ---"
V=$(grep -oP 'data-feature="[^"]*"' /tmp/i.html | wc -l)
check "data-feature數量" $V 8
check "applyFeatureVisibility" $(grep -c "applyFeatureVisibility" /tmp/i.html) 1

echo ""
echo "--- common.js ---"
check "escapeHTML" $(grep -c "escapeHTML" /tmp/c.js) 1
check "getFeatureVisibility" $(grep -c "getFeatureVisibility" /tmp/c.js) 1
check "INDUSTRY_TEMPLATES" $(grep -c "INDUSTRY_TEMPLATES" /tmp/c.js) 1

echo ""
echo "--- Supabase ---"
for T in store_customers loyalty_config loyalty_points orders store_profiles menu_items; do
  S=$(curl -s -o /dev/null -w "%{http_code}" "$SB_URL/rest/v1/$T?limit=0" -H "apikey: $SB_KEY")
  if [ "$S" = "200" ] || [ "$S" = "204" ]; then echo "  ✅ $T (HTTP $S)"; PASS=$((PASS+1)); else echo "  ❌ $T (HTTP $S)"; FAIL=$((FAIL+1)); fi
done

echo ""
echo "━━━━━━━━━━━━━━━━━━━"
TOTAL=$((PASS+FAIL))
SCORE=$((PASS*100/TOTAL))
echo "  通過: $PASS / $TOTAL ($SCORE%)"
if [ $FAIL -eq 0 ]; then echo "  🎉 全部通過！"; else echo "  ⚠️ $FAIL 項待修復"; fi
