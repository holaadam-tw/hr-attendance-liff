// ============================================================
// modules/index.js — 管理後台入口，匯入所有模組並綁定 window
// ============================================================

// ===== 匯入模組 =====
import {
    showPage, checkAdminPermission, updateAdminInfo,
    applyRoleVisibility, applyAdminFeatureVisibility,
    switchFieldSalesAdmin,
    renderAdminCompanySwitcher, switchCompanyAdmin
} from './auth.js';

import {
    loadAuditLogs, exportReport
} from './audit.js';

import {
    showAddEmployeeModal, closeAddEmployeeModal, initEmployeeFormHandler,
    showJoinQRCode, closeQRModal, loadEmployeeList, updateEmployeeRoleAdmin,
    searchEmployees, openSalarySettingModal, closeSalarySettingModal,
    onSalaryTypeChange, saveSalarySetting, openEditEmployeeModal,
    closeEditEmployeeModal, saveEditEmployee
} from './employees.js';

import {
    switchApprovalType, switchLeaveTab, loadLeaveApprovals, approveLeave,
    switchStaffTab, adjustMaxLeave, loadMaxLeaveSetting, saveMaxLeave,
    loadSchedulingMode, selectSchedulingMode, setFixedPreset,
    applySchedulingModeUI, applyShiftTabMode, saveSchedulingMode,
    loadLunchManagers, addLunchManager, removeLunchManager,
    loadAdminLunchStats, loadStaffOverview, changeLeaveCal,
    resetLeaveCal, loadLeaveCal
} from './leave.js';

import {
    changeShiftWeek, resetShiftWeek, loadShiftMgr, cycleShift,
    saveSchedule, copyLastWeek, switchMakeupTab, loadMakeupApprovals,
    approveMakeupPunch, rejectMakeupPunchPrompt, rejectMakeupPunch,
    switchOtTab, loadOtApprovals, approveOt, rejectOtPrompt, rejectOt,
    loadSwapApprovals, approveSwap, rejectSwap
} from './schedules.js';

import {
    BONUS_MATRIX, loadHybridBonusData, renderSelectedBonusCard,
    updatePerformance, updateAdjustment, toggleMatrixRef,
    saveAllBonuses, exportBonusCSV,
    initPayrollPage, toggleSalarySettingPanel, loadSalarySettingList,
    loadPayrollData, renderPayrollView, updatePayrollAdjustment,
    saveAllPayroll, publishPayroll, exportPayrollCSV,
    loadInsuranceBrackets, showInsModal, closeInsModal,
    editInsBracket, saveInsBracket, deleteInsBracket, updateAllInsRates
} from './payroll.js';

import {
    loadRestaurantList, openRestaurantDetail, previewStoreOrder, openKDS,
    toggleAcceptOrders, switchRestaurantTab, loadStoreOrders,
    showOrderDetail, closeOrderDetail, updateOrderStatus, toggleOrderSound,
    showStoreModal, editStore, closeStoreModal, saveStore, uploadStoreImage, clearStoreImage,
    showStoreQR, closeStoreQR, getStoreOrderUrl, copyStoreUrl,
    openStorePreview, loadMenuCategories, addMenuCategory,
    renameMenuCategory, deleteMenuCategory, editCategoryTime, loadMenuItems, showMenuItemForm,
    editMenuItem, cancelMenuItemForm, toggleMiSection, toggleMiPreview,
    updateOptBadge, toggleComboSwitch, saveMenuItem, deleteMenuItem,
    toggleItemAvail, handleMenuImageUpload,
    OPTION_TEMPLATES, applyOptionTemplate, addOptionGroup,
    removeOptionGroup, addOptionChoice, removeOptionChoice,
    toggleOptionType, toggleOptionReq, addComboGroup, removeComboGroup,
    saveBusinessHours, saveLineGroupId, saveLoyaltyConfig,
    generateTableQRCodes, printTableQRCodes,
    handleMenuPhotoUpload, analyzeMenuPhoto, confirmAIMenu, cancelAIMenu,
    showCopyMenuModal, closeCopyMenuModal, executeCopyMenu,
    loadSalesReport, exportSalesCSV
} from './store.js';

import {
    ADMIN_FEATURE_LIST, featureState,
    loadNotifyToken, saveNotifyToken, testNotify,
    loadFeatureSettings, updateToggleCard, toggleFeature,
    toggleAnnCheck, publishAnnouncement, loadAnnouncementList,
    deleteAnnouncement, loadClientList, filterClients,
    showClientModal, closeClientModal, editClient, getClientGPS,
    saveClient, toggleClientActive, loadServiceItemList,
    addServiceItem, deleteServiceItem, initFieldWorkApproval,
    loadFieldWorkApprovals, showFwaDetail, closeFwaDetailModal,
    approveFieldWork, rejectFieldWork, exportFieldWorkCSV,
    loadCompanyList, filterCompanies, showCompanyModal,
    closeCompanyModal, editCompany, saveCompany,
    initSalesTargetPage, stChangeWeek, saveDefaultTarget
} from './settings.js';

// ===== 綁定 window（供 HTML onclick 使用）=====

// auth
window.showPage = showPage;
window.checkAdminPermission = checkAdminPermission;
window.updateAdminInfo = updateAdminInfo;
window.applyRoleVisibility = applyRoleVisibility;
window.applyAdminFeatureVisibility = applyAdminFeatureVisibility;
window.switchFieldSalesAdmin = switchFieldSalesAdmin;
window.renderAdminCompanySwitcher = renderAdminCompanySwitcher;
window.switchCompanyAdmin = switchCompanyAdmin;

// audit
window.loadAuditLogs = loadAuditLogs;
window.exportReport = exportReport;

// employees
window.showAddEmployeeModal = showAddEmployeeModal;
window.closeAddEmployeeModal = closeAddEmployeeModal;
window.showJoinQRCode = showJoinQRCode;
window.closeQRModal = closeQRModal;
window.loadEmployeeList = loadEmployeeList;
window.updateEmployeeRoleAdmin = updateEmployeeRoleAdmin;
window.searchEmployees = searchEmployees;
window.openSalarySettingModal = openSalarySettingModal;
window.closeSalarySettingModal = closeSalarySettingModal;
window.onSalaryTypeChange = onSalaryTypeChange;
window.saveSalarySetting = saveSalarySetting;
window.openEditEmployeeModal = openEditEmployeeModal;
window.closeEditEmployeeModal = closeEditEmployeeModal;
window.saveEditEmployee = saveEditEmployee;

// leave
window.switchApprovalType = switchApprovalType;
window.switchLeaveTab = switchLeaveTab;
window.loadLeaveApprovals = loadLeaveApprovals;
window.approveLeave = approveLeave;
window.switchStaffTab = switchStaffTab;
window.adjustMaxLeave = adjustMaxLeave;
window.loadMaxLeaveSetting = loadMaxLeaveSetting;
window.saveMaxLeave = saveMaxLeave;
window.loadSchedulingMode = loadSchedulingMode;
window.selectSchedulingMode = selectSchedulingMode;
window.setFixedPreset = setFixedPreset;
window.applySchedulingModeUI = applySchedulingModeUI;
window.applyShiftTabMode = applyShiftTabMode;
window.saveSchedulingMode = saveSchedulingMode;
window.loadLunchManagers = loadLunchManagers;
window.addLunchManager = addLunchManager;
window.removeLunchManager = removeLunchManager;
window.loadAdminLunchStats = loadAdminLunchStats;
window.loadStaffOverview = loadStaffOverview;
window.changeLeaveCal = changeLeaveCal;
window.resetLeaveCal = resetLeaveCal;
window.loadLeaveCal = loadLeaveCal;

// schedules
window.changeShiftWeek = changeShiftWeek;
window.resetShiftWeek = resetShiftWeek;
window.loadShiftMgr = loadShiftMgr;
window.cycleShift = cycleShift;
window.saveSchedule = saveSchedule;
window.copyLastWeek = copyLastWeek;
window.switchMakeupTab = switchMakeupTab;
window.loadMakeupApprovals = loadMakeupApprovals;
window.approveMakeupPunch = approveMakeupPunch;
window.rejectMakeupPunchPrompt = rejectMakeupPunchPrompt;
window.rejectMakeupPunch = rejectMakeupPunch;
window.switchOtTab = switchOtTab;
window.loadOtApprovals = loadOtApprovals;
window.approveOt = approveOt;
window.rejectOtPrompt = rejectOtPrompt;
window.rejectOt = rejectOt;
window.loadSwapApprovals = loadSwapApprovals;
window.approveSwap = approveSwap;
window.rejectSwap = rejectSwap;

// payroll
window.BONUS_MATRIX = BONUS_MATRIX;
window.loadHybridBonusData = loadHybridBonusData;
window.renderSelectedBonusCard = renderSelectedBonusCard;
window.updatePerformance = updatePerformance;
window.updateAdjustment = updateAdjustment;
window.toggleMatrixRef = toggleMatrixRef;
window.saveAllBonuses = saveAllBonuses;
window.exportBonusCSV = exportBonusCSV;
window.initPayrollPage = initPayrollPage;
window.toggleSalarySettingPanel = toggleSalarySettingPanel;
window.loadSalarySettingList = loadSalarySettingList;
window.loadPayrollData = loadPayrollData;
window.renderPayrollView = renderPayrollView;
window.updatePayrollAdjustment = updatePayrollAdjustment;
window.saveAllPayroll = saveAllPayroll;
window.publishPayroll = publishPayroll;
window.exportPayrollCSV = exportPayrollCSV;
window.loadInsuranceBrackets = loadInsuranceBrackets;
window.showInsModal = showInsModal;
window.closeInsModal = closeInsModal;
window.editInsBracket = editInsBracket;
window.saveInsBracket = saveInsBracket;
window.deleteInsBracket = deleteInsBracket;
window.updateAllInsRates = updateAllInsRates;

// store
window.loadRestaurantList = loadRestaurantList;
window.openRestaurantDetail = openRestaurantDetail;
window.previewStoreOrder = previewStoreOrder;
window.openKDS = openKDS;
window.toggleAcceptOrders = toggleAcceptOrders;
window.switchRestaurantTab = switchRestaurantTab;
window.loadStoreOrders = loadStoreOrders;
window.showOrderDetail = showOrderDetail;
window.closeOrderDetail = closeOrderDetail;
window.updateOrderStatus = updateOrderStatus;
window.toggleOrderSound = toggleOrderSound;
window.showStoreModal = showStoreModal;
window.editStore = editStore;
window.closeStoreModal = closeStoreModal;
window.saveStore = saveStore;
window.uploadStoreImage = uploadStoreImage;
window.clearStoreImage = clearStoreImage;
window.showStoreQR = showStoreQR;
window.closeStoreQR = closeStoreQR;
window.getStoreOrderUrl = getStoreOrderUrl;
window.copyStoreUrl = copyStoreUrl;
window.openStorePreview = openStorePreview;
window.loadMenuCategories = loadMenuCategories;
window.addMenuCategory = addMenuCategory;
window.renameMenuCategory = renameMenuCategory;
window.deleteMenuCategory = deleteMenuCategory;
window.editCategoryTime = editCategoryTime;
window.loadMenuItems = loadMenuItems;
window.showMenuItemForm = showMenuItemForm;
window.editMenuItem = editMenuItem;
window.cancelMenuItemForm = cancelMenuItemForm;
window.toggleMiSection = toggleMiSection;
window.toggleMiPreview = toggleMiPreview;
window.updateOptBadge = updateOptBadge;
window.toggleComboSwitch = toggleComboSwitch;
window.saveMenuItem = saveMenuItem;
window.deleteMenuItem = deleteMenuItem;
window.toggleItemAvail = toggleItemAvail;
window.handleMenuImageUpload = handleMenuImageUpload;
window.OPTION_TEMPLATES = OPTION_TEMPLATES;
window.applyOptionTemplate = applyOptionTemplate;
window.addOptionGroup = addOptionGroup;
window.removeOptionGroup = removeOptionGroup;
window.addOptionChoice = addOptionChoice;
window.removeOptionChoice = removeOptionChoice;
window.toggleOptionType = toggleOptionType;
window.toggleOptionReq = toggleOptionReq;
window.addComboGroup = addComboGroup;
window.removeComboGroup = removeComboGroup;
window.saveBusinessHours = saveBusinessHours;
window.saveLineGroupId = saveLineGroupId;
window.saveLoyaltyConfig = saveLoyaltyConfig;
window.generateTableQRCodes = generateTableQRCodes;
window.printTableQRCodes = printTableQRCodes;
window.handleMenuPhotoUpload = handleMenuPhotoUpload;
window.analyzeMenuPhoto = analyzeMenuPhoto;
window.confirmAIMenu = confirmAIMenu;
window.cancelAIMenu = cancelAIMenu;
window.showCopyMenuModal = showCopyMenuModal;
window.closeCopyMenuModal = closeCopyMenuModal;
window.executeCopyMenu = executeCopyMenu;
window.loadSalesReport = loadSalesReport;
window.exportSalesCSV = exportSalesCSV;

// settings
window.ADMIN_FEATURE_LIST = ADMIN_FEATURE_LIST;
window.loadNotifyToken = loadNotifyToken;
window.saveNotifyToken = saveNotifyToken;
window.testNotify = testNotify;
window.loadFeatureSettings = loadFeatureSettings;
window.updateToggleCard = updateToggleCard;
window.toggleFeature = toggleFeature;
window.toggleAnnCheck = toggleAnnCheck;
window.publishAnnouncement = publishAnnouncement;
window.loadAnnouncementList = loadAnnouncementList;
window.deleteAnnouncement = deleteAnnouncement;
window.loadClientList = loadClientList;
window.filterClients = filterClients;
window.showClientModal = showClientModal;
window.closeClientModal = closeClientModal;
window.editClient = editClient;
window.getClientGPS = getClientGPS;
window.saveClient = saveClient;
window.toggleClientActive = toggleClientActive;
window.loadServiceItemList = loadServiceItemList;
window.addServiceItem = addServiceItem;
window.deleteServiceItem = deleteServiceItem;
window.initFieldWorkApproval = initFieldWorkApproval;
window.loadFieldWorkApprovals = loadFieldWorkApprovals;
window.showFwaDetail = showFwaDetail;
window.closeFwaDetailModal = closeFwaDetailModal;
window.approveFieldWork = approveFieldWork;
window.rejectFieldWork = rejectFieldWork;
window.exportFieldWorkCSV = exportFieldWorkCSV;
window.loadCompanyList = loadCompanyList;
window.filterCompanies = filterCompanies;
window.showCompanyModal = showCompanyModal;
window.closeCompanyModal = closeCompanyModal;
window.editCompany = editCompany;
window.saveCompany = saveCompany;
window.initSalesTargetPage = initSalesTargetPage;
window.stChangeWeek = stChangeWeek;
window.saveDefaultTarget = saveDefaultTarget;

// ===== 全域事件 =====

// 點擊背景關閉 Modal
document.addEventListener('click', function(event) {
    if (event.target.classList.contains('modal')) {
        event.target.style.display = 'none';
    }
});

// 初始化員工表單提交
initEmployeeFormHandler();

// ===== 頁面載入 =====
window.addEventListener('load', async () => {
    if (typeof initializeLiff === 'undefined') {
        console.error('common.js 未正確載入');
        return;
    }
    checkAdminPermission();
});
