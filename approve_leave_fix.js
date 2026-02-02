// 審核請假
async function approveLeave(requestId, newStatus) {
    try {
        const { error } = await sb.from('leave_requests')
            .update({ 
                status: newStatus,
                approver_id: currentAdminEmployee.id,
                approved_at: new Date().toISOString()
            })
            .eq('id', requestId);

        if (error) throw error;

        let statusText = '通過';
        if (newStatus !== 'approved') statusText = '拒絕';
        
        showToast(`✅ 請假申請已${statusText}`);
        loadLeaveApprovals('pending');

    } catch (err) {
        console.error(err);
        showToast('❌ 審核失敗: ' + err.message);
    }
}
