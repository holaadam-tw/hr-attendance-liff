# Tasks — missing-checkout-audit

- [x] migration 092：attendance_anomalies 表 + RLS + 索引
- [x] migration 092：自動結案 trigger（attendance checkout / leave approved）
- [x] migration 092：scan_missing_checkouts()（排除跨日班窗口/no_checkin/kiosk/離職/已核准請假）
- [x] migration 092：run_daily_attendance_audit()（pg_net 推 LINE：員工 DM zh/vi + 群組彙總）+ REVOKE anon
- [x] migration 092：get_attendance_anomalies() / resolve_attendance_anomaly()（admin/manager 驗證）
- [x] migration 092：pg_cron 排程（01:10 UTC）+ 大正科技啟用旗標
- [x] attendance_public.html：缺卡追蹤卡片（大正科技 + 管理員模式限定）、zh/vi i18n
- [x] attendance_public.html：素食提醒文案改為情境化完整句子（zh/vi）
- [x] qa_check.sh 0 FAIL、npm test 52/52 通過
- [ ] 正式庫套用 migration 092（需 user 授權）
- [ ] 套用後驗證：手動 `SELECT run_daily_attendance_audit();`、anon 呼叫 get_attendance_anomalies 應被擋、pg_cron job 存在
- [ ] 隔天觀察：cron 實際發送 DM + 群組彙總；補卡/請假核准自動結案
