#!/bin/bash
# RLS 殘留檢查 — 每次編輯 common.js / modules 後自動跑
# 不阻擋 commit，只警告

RLS_TABLES="leave_requests overtime_requests makeup_punch_requests"
FOUND=0

for table in $RLS_TABLES; do
    MATCHES=$(grep -rn "from('$table')\.\(insert\|update\|delete\)" common.js modules/*.js 2>/dev/null)
    if [ -n "$MATCHES" ]; then
        echo "" >&2
        echo "⚠️ RLS 警告: $table 表有直接 INSERT/UPDATE/DELETE" >&2
        echo "$MATCHES" >&2
        echo "→ 應改用 SECURITY DEFINER RPC 呼叫" >&2
        FOUND=1
    fi
done

if [ $FOUND -eq 1 ]; then
    echo "" >&2
    echo "💡 參考：migrations/047-050 的 RPC 模式" >&2
fi

exit 0
