#!/bin/bash
# 多租戶隔離檢查 — 每次編輯 common.js / modules 後自動跑
# 不阻擋 commit，只警告

MULTI_TENANT_TABLES="employees attendance leave_requests overtime_requests makeup_punch_requests schedules system_settings hr_audit_logs shift_swap_requests payroll lunch_orders annual_bonus announcements sales_targets sales_activities field_work_logs clients salary_settings"

FOUND=0

for table in $MULTI_TENANT_TABLES; do
    MATCHES=$(grep -rn "sb\.from('$table')" common.js modules/*.js 2>/dev/null || true)
    if [ -n "$MATCHES" ]; then
        while IFS= read -r line; do
            [ -z "$line" ] && continue
            FILE=$(echo "$line" | cut -d: -f1)
            LINE_NUM=$(echo "$line" | cut -d: -f2)
            END_NUM=$((LINE_NUM + 6))
            CONTEXT=$(sed -n "${LINE_NUM},${END_NUM}p" "$FILE" 2>/dev/null)

            # 接受以下隔離方式：
            # 1. .eq('company_id', ...) / .eq('employees.company_id', ...)
            # 2. employees!inner(company_id)
            # 3. line_user_id 查員工（登入流程）
            # 4. .insert / .update / .delete / .upsert — 寫入操作
            # 5. store_profiles!inner — 商店隔離
            if ! echo "$CONTEXT" | grep -qE "company_id|employees!inner|store_profiles!inner|line_user_id|is_overnight|\.insert\(|\.update\(|\.delete\(|\.upsert\("; then
                echo "" >&2
                echo "⚠️ 多租戶警告: $FILE:$LINE_NUM" >&2
                echo "   $table 表查詢缺少 company_id filter" >&2
                FOUND=1
            fi
        done <<< "$MATCHES"
    fi
done

if [ $FOUND -eq 1 ]; then
    echo "" >&2
    echo "💡 加 .eq('company_id', window.currentCompanyId) 或用 employees!inner(company_id)" >&2
fi

exit 0
