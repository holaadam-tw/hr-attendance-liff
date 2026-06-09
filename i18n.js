(function () {
    'use strict';

    var SUPPORTED_LANGS = ['zh-TW', 'vi-VN'];
    var DEFAULT_LANG = 'zh-TW';
    var STORAGE_KEY = 'employee_preferred_language';
    var EMP_STORAGE_PREFIX = 'employee_preferred_language_';

    var DICT = {
        'zh-TW': {
            languageChinese: '中文',
            languageVietnamese: 'Tiếng Việt',
            languageLabel: '語言',
            backHome: '← 返回首頁',
            close: '✕ 關閉',
            loading: '系統載入中...',
            employeeHome: '員工首頁',
            checkIn: '上班打卡',
            checkOut: '下班打卡',
            todayInfo: '今日資訊',
            todayShift: '今日班別',
            checkInTime: '上班打卡',
            checkOutTime: '下班打卡',
            notChecked: '尚未打卡',
            onTime: '✅ 準時',
            late: '⚠️ 遲到',
            checkedOut: '✅ 已下班',
            attendanceRecords: '考勤記錄',
            leave: '請假',
            leaveRequest: '請假申請',
            leaveType: '假別',
            startDate: '開始日期',
            endDate: '結束日期',
            leavePeriod: '請假時段',
            hourlyLeave: '小時請假',
            leaveHours: '請假時數',
            leaveHoursHint: '最低 1 小時；系統以每 8 小時折算 1 天扣薪。',
            leaveReason: '原因',
            submitRequest: '📤 提交申請',
            myLeaveHistory: '我的請假記錄',
            makeupPunch: '補卡',
            makeupPunchRequest: '補打卡申請',
            makeupDate: '補打卡日期',
            makeupType: '補打卡類型',
            makeupClockIn: '上班補打卡',
            makeupClockOut: '下班補打卡',
            actualPunchTime: '實際打卡時間',
            reasonCategory: '原因分類',
            reasonForgot: '忘記打卡',
            reasonPhone: '手機問題',
            reasonSystem: '系統問題',
            reasonBusy: '現場忙碌',
            reasonManager: '主管指示',
            reasonOther: '其他',
            detailRequired: '補充說明（必填）',
            submitMakeup: '📤 提交補打卡申請',
            makeupHistory: '補打卡記錄',
            lunchOrder: '便當訂購',
            lunchDeadlineDefault: '今日訂購截止時間',
            myOrder: '我的訂單',
            todayStats: '今日統計',
            total: '總數',
            vegetarian: '素食',
            regular: '葷食',
            regularLunch: '葷食便當',
            vegetarianLunch: '素食便當',
            noLunch: '不訂購',
            lunchNotes: '備註 (選填)',
            chooseLunchFirst: '請先選擇便當類型',
            confirmRegularLunch: '✅ 確認訂購葷食便當',
            confirmVegetarianLunch: '✅ 確認訂購素食便當',
            confirmNoLunch: '✅ 確認不訂購',
            lunchRegularDesc: '今日主菜由餐廳安排',
            lunchVegetarianDesc: '健康蔬食料理',
            lunchNoneDesc: '今日不需要便當',
            orderDate: '訂購日期',
            ordered: '已訂購',
            cancelled: '已取消',
            changeVegetarian: '🥗 改素食',
            changeRegular: '🍖 改葷食',
            cancelOrder: '❌ 取消',
            lunchLocked: '⏰ 已過截止時間，無法修改',
            chooseLunchStatusFirst: '請先選擇今日便當狀態：葷食、素食或不訂購',
            lunchNotSelected: '⚠️ 今日便當尚未選擇',
            confirmRegularLunchQuestion: '確定訂購「葷食便當」？',
            confirmVegetarianLunchQuestion: '確定訂購「素食便當」？',
            confirmNoLunchQuestion: '確定不訂購便當？',
            lunchSuccess: '✅ 訂購成功！',
            lunchNoneSaved: '🚫 已確認不訂購',
            lunchOrderSaved: '✅ 便當訂購成功',
            lunchTodayNone: '🚫 便當：今日不訂購',
            chooseDate: '請選擇日期',
            cameraReady: '準備開啟相機...',
            takePhotoAndPunch: '📸 拍照並打卡',
            photoFailedTitle: '照片處理失敗',
            photoFailedMessage: '這次拍照沒有成功存成照片，請重新拍一次；若持續發生，請改用系統相機模式重試。',
            gpsNeedEnableTitle: '請開啟定位服務',
            gpsNeedEnableBody: '打卡需要取得您的位置資訊，請依照手機設定開啟定位服務。',
            iKnow: '我知道了',
            retry: '🔄 重試',
            checkinFailed: '打卡失敗',
            accountNotBound: '帳號未綁定',
            accountNotBoundMessage: '這個 LINE 帳號沒有綁定啟用中的員工資料，請聯繫管理員確認員工綁定。',
            kioskAccount: '公務機帳號',
            noCheckinEmployee: '免打卡員工',
            outsideLocation: '不在範圍內',
            outsideLocationMessage: '請移至公司附近再打卡',
            duplicatePunch: '重複打卡',
            noOpenCheckIn: '尚未上班',
            checkoutExpired: '超過時限',
            checkoutExpiredMessage: '已超過下班打卡時間，請申請補卡',
            pendingReview: '待主管審核',
            pendingMakeupClockInShort: '待審補上班',
            pendingMakeupClockOutShort: '待審補下班',
            pendingMakeupClockInReview: '上班補打卡待主管審核',
            pendingMakeupClockOutReview: '下班補打卡待主管審核',
            cameraPermissionDenied: '相機權限未開啟',
            cameraUnavailable: '找不到相機設備',
            cameraBusy: '相機被佔用',
            networkFailed: '網路連線失敗',
            kioskTitle: '公務機打卡',
            kioskInputPlaceholder: '輸入工號、手機或驗證碼',
            kioskHint: '輸入工號、手機號碼或身分證後4碼',
            clear: '清除',
            confirm: '確認',
            photo: '📸 拍照',
            photoCaptured: '✅ 已拍照',
            photoDone: '✅ 已拍照，請再按「上班打卡」或「下班打卡」才會送出。',
            processing: '處理中...',
            submitting: '提交中...',
            cancel: '← 取消',
            retryInput: '← 重新輸入',
            kioskCheckInSuccess: '上班打卡成功',
            kioskCheckOutSuccess: '下班打卡成功',
            chooseLunchToday: '請選擇今日午餐',
            lunchPromptTitle: '今日便當訂購',
            kioskLunchPromptBody: '{name}，請選擇今日午餐',
            decideLater: '稍後再決定',
            lunchRecordedNone: '已記錄不訂購',
            lunchSubmitFailed: '訂購失敗，請重試',
            returnSeconds: '{sec} 秒後返回...',
            employeeNotLoaded: '員工資料未載入，請重新輸入工號。',
            photoProcessFailedRetry: '照片處理失敗，請重新拍照。',
            lookupFailed: '查詢失敗',
            networkRetry: '網路錯誤，請重試',
            registerTitle: '員工登記',
            registerSubtitle: '填寫資料後送出，等待管理員審核',
            registerCompany: '登記公司',
            name: '姓名',
            phone: '手機號碼',
            department: '部門',
            position: '職位',
            hireDate: '到職日期',
            emergencyContact: '緊急聯絡人',
            emergencyPhone: '緊急聯絡電話',
            systemLanguage: '系統語言',
            submitRegistration: '📤 提交登記',
            registrationSuccess: '登記成功',
            registrationSuccessBody: '您的登記資料已送出，管理員審核通過後即可使用。',
            employeeLanguageSetting: '系統語言',
            save: '💾 儲存',
            saved: '✅ 已儲存',
            saveFailed: '❌ 儲存失敗'
        },
        'vi-VN': {
            languageChinese: '中文',
            languageVietnamese: 'Tiếng Việt',
            languageLabel: 'Ngôn ngữ',
            backHome: '← Về trang chủ',
            close: '✕ Đóng',
            loading: 'Đang tải hệ thống...',
            employeeHome: 'Trang nhân viên',
            checkIn: 'Chấm công vào ca',
            checkOut: 'Chấm công tan ca',
            todayInfo: 'Thông tin hôm nay',
            todayShift: 'Ca hôm nay',
            checkInTime: 'Giờ vào',
            checkOutTime: 'Giờ ra',
            notChecked: 'Chưa chấm công',
            onTime: '✅ Đúng giờ',
            late: '⚠️ Đi trễ',
            checkedOut: '✅ Đã tan ca',
            attendanceRecords: 'Lịch sử chấm công',
            leave: 'Nghỉ phép',
            leaveRequest: 'Xin nghỉ phép',
            leaveType: 'Loại nghỉ',
            startDate: 'Ngày bắt đầu',
            endDate: 'Ngày kết thúc',
            leavePeriod: 'Thời gian nghỉ',
            hourlyLeave: 'Nghỉ theo giờ',
            leaveHours: 'Số giờ nghỉ',
            leaveHoursHint: 'Tối thiểu 1 giờ; hệ thống quy đổi 8 giờ = 1 ngày để tính lương.',
            leaveReason: 'Lý do',
            submitRequest: '📤 Gửi đơn',
            myLeaveHistory: 'Lịch sử nghỉ phép',
            makeupPunch: 'Bổ sung chấm công',
            makeupPunchRequest: 'Đơn bổ sung chấm công',
            makeupDate: 'Ngày bổ sung',
            makeupType: 'Loại bổ sung',
            makeupClockIn: 'Bổ sung giờ vào',
            makeupClockOut: 'Bổ sung giờ ra',
            actualPunchTime: 'Giờ thực tế',
            reasonCategory: 'Loại lý do',
            reasonForgot: 'Quên chấm công',
            reasonPhone: 'Lỗi điện thoại',
            reasonSystem: 'Lỗi hệ thống',
            reasonBusy: 'Cửa hàng bận',
            reasonManager: 'Quản lý yêu cầu',
            reasonOther: 'Khác',
            detailRequired: 'Ghi chú bổ sung (bắt buộc)',
            submitMakeup: '📤 Gửi đơn bổ sung',
            makeupHistory: 'Lịch sử bổ sung',
            lunchOrder: 'Đặt cơm',
            lunchDeadlineDefault: 'Hạn đặt cơm hôm nay',
            myOrder: 'Đơn của tôi',
            todayStats: 'Thống kê hôm nay',
            total: 'Tổng',
            vegetarian: 'Chay',
            regular: 'Mặn',
            regularLunch: 'Cơm mặn',
            vegetarianLunch: 'Cơm chay',
            noLunch: 'Không đặt',
            lunchNotes: 'Ghi chú (không bắt buộc)',
            chooseLunchFirst: 'Vui lòng chọn loại cơm',
            confirmRegularLunch: '✅ Xác nhận đặt cơm mặn',
            confirmVegetarianLunch: '✅ Xác nhận đặt cơm chay',
            confirmNoLunch: '✅ Xác nhận không đặt',
            lunchRegularDesc: 'Món chính do quán sắp xếp',
            lunchVegetarianDesc: 'Món chay lành mạnh',
            lunchNoneDesc: 'Hôm nay không cần đặt cơm',
            orderDate: 'Ngày đặt',
            ordered: 'Đã đặt',
            cancelled: 'Đã hủy',
            changeVegetarian: '🥗 Đổi sang cơm chay',
            changeRegular: '🍖 Đổi sang cơm mặn',
            cancelOrder: '❌ Hủy',
            lunchLocked: '⏰ Đã quá hạn, không thể sửa',
            chooseLunchStatusFirst: 'Vui lòng chọn trạng thái cơm hôm nay: mặn, chay hoặc không đặt',
            lunchNotSelected: '⚠️ Hôm nay chưa chọn cơm',
            confirmRegularLunchQuestion: 'Xác nhận đặt “cơm mặn”?',
            confirmVegetarianLunchQuestion: 'Xác nhận đặt “cơm chay”?',
            confirmNoLunchQuestion: 'Xác nhận không đặt cơm?',
            lunchSuccess: '✅ Đặt cơm thành công!',
            lunchNoneSaved: '🚫 Đã ghi nhận không đặt',
            lunchOrderSaved: '✅ Đã đặt cơm thành công',
            lunchTodayNone: '🚫 Cơm: hôm nay không đặt',
            chooseDate: 'Vui lòng chọn ngày',
            cameraReady: 'Đang chuẩn bị mở camera...',
            takePhotoAndPunch: '📸 Chụp ảnh và chấm công',
            photoFailedTitle: 'Xử lý ảnh thất bại',
            photoFailedMessage: 'Ảnh chưa được lưu thành công. Vui lòng chụp lại; nếu vẫn lỗi, hãy dùng camera hệ thống.',
            gpsNeedEnableTitle: 'Vui lòng bật định vị',
            gpsNeedEnableBody: 'Chấm công cần lấy vị trí của bạn. Vui lòng bật định vị trong cài đặt điện thoại.',
            iKnow: 'Tôi đã hiểu',
            retry: '🔄 Thử lại',
            checkinFailed: 'Chấm công thất bại',
            accountNotBound: 'Tài khoản chưa liên kết',
            accountNotBoundMessage: 'Tài khoản LINE này chưa liên kết với nhân viên đang hoạt động. Vui lòng liên hệ quản lý.',
            kioskAccount: 'Tài khoản máy chung',
            noCheckinEmployee: 'Nhân viên miễn chấm công',
            outsideLocation: 'Ngoài phạm vi',
            outsideLocationMessage: 'Vui lòng đến gần công ty rồi chấm công lại',
            duplicatePunch: 'Chấm công lặp lại',
            noOpenCheckIn: 'Chưa chấm công vào ca',
            checkoutExpired: 'Quá thời hạn',
            checkoutExpiredMessage: 'Đã quá thời gian chấm công tan ca. Vui lòng gửi đơn bổ sung.',
            pendingReview: 'Chờ quản lý duyệt',
            pendingMakeupClockInShort: 'Chờ duyệt giờ vào',
            pendingMakeupClockOutShort: 'Chờ duyệt giờ ra',
            pendingMakeupClockInReview: 'Bổ sung giờ vào đang chờ quản lý duyệt',
            pendingMakeupClockOutReview: 'Bổ sung giờ ra đang chờ quản lý duyệt',
            cameraPermissionDenied: 'Chưa bật quyền camera',
            cameraUnavailable: 'Không tìm thấy camera',
            cameraBusy: 'Camera đang được dùng',
            networkFailed: 'Lỗi kết nối mạng',
            kioskTitle: 'Máy chấm công chung',
            kioskInputPlaceholder: 'Nhập mã NV, điện thoại hoặc mã xác minh',
            kioskHint: 'Nhập mã nhân viên, số điện thoại hoặc 4 số cuối giấy tờ',
            clear: 'Xóa',
            confirm: 'Xác nhận',
            photo: '📸 Chụp ảnh',
            photoCaptured: '✅ Đã chụp ảnh',
            photoDone: '✅ Đã chụp ảnh. Vui lòng bấm “Vào ca” hoặc “Tan ca” để gửi.',
            processing: 'Đang xử lý...',
            submitting: 'Đang gửi...',
            cancel: '← Hủy',
            retryInput: '← Nhập lại',
            kioskCheckInSuccess: 'Chấm công vào ca thành công',
            kioskCheckOutSuccess: 'Chấm công tan ca thành công',
            chooseLunchToday: 'Vui lòng chọn cơm hôm nay',
            lunchPromptTitle: 'Đặt cơm hôm nay',
            kioskLunchPromptBody: '{name}, vui lòng chọn cơm hôm nay',
            decideLater: 'Quyết định sau',
            lunchRecordedNone: 'Đã ghi nhận không đặt',
            lunchSubmitFailed: 'Đặt cơm thất bại, vui lòng thử lại',
            returnSeconds: 'Tự quay lại sau {sec} giây...',
            employeeNotLoaded: 'Chưa tải dữ liệu nhân viên. Vui lòng nhập lại mã nhân viên.',
            photoProcessFailedRetry: 'Xử lý ảnh thất bại, vui lòng chụp lại.',
            lookupFailed: 'Tra cứu thất bại',
            networkRetry: 'Lỗi mạng, vui lòng thử lại',
            registerTitle: 'Đăng ký nhân viên',
            registerSubtitle: 'Điền thông tin và chờ quản lý duyệt',
            registerCompany: 'Công ty đăng ký',
            name: 'Họ tên',
            phone: 'Số điện thoại',
            department: 'Bộ phận',
            position: 'Chức vụ',
            hireDate: 'Ngày vào làm',
            emergencyContact: 'Người liên hệ khẩn cấp',
            emergencyPhone: 'SĐT khẩn cấp',
            systemLanguage: 'Ngôn ngữ hệ thống',
            submitRegistration: '📤 Gửi đăng ký',
            registrationSuccess: 'Đăng ký thành công',
            registrationSuccessBody: 'Thông tin đã được gửi. Sau khi quản lý duyệt, bạn có thể sử dụng hệ thống.',
            employeeLanguageSetting: 'Ngôn ngữ hệ thống',
            save: '💾 Lưu',
            saved: '✅ Đã lưu',
            saveFailed: '❌ Lưu thất bại'
        }
    };

    function normalizeLanguage(lang) {
        if (!lang) return DEFAULT_LANG;
        var raw = String(lang).trim();
        var lower = raw.toLowerCase();
        if (lower === 'vi' || lower === 'vi-vn') return 'vi-VN';
        if (lower === 'zh' || lower === 'zh-tw' || lower === 'zh-hant') return 'zh-TW';
        return DEFAULT_LANG;
    }

    function detectBrowserLanguage() {
        var lang = (navigator.language || navigator.userLanguage || '').toLowerCase();
        return lang.indexOf('vi') === 0 ? 'vi-VN' : DEFAULT_LANG;
    }

    function employeeStorageKey(employeeId) {
        return employeeId ? EMP_STORAGE_PREFIX + employeeId : STORAGE_KEY;
    }

    function getStoredLanguage(employeeId) {
        try {
            var raw = localStorage.getItem(employeeStorageKey(employeeId)) || localStorage.getItem(STORAGE_KEY);
            return raw ? normalizeLanguage(raw) : null;
        } catch (e) {
            return null;
        }
    }

    function setStoredLanguage(lang, employeeId) {
        var normalized = normalizeLanguage(lang);
        try {
            localStorage.setItem(STORAGE_KEY, normalized);
            if (employeeId) localStorage.setItem(employeeStorageKey(employeeId), normalized);
        } catch (e) {}
        return normalized;
    }

    function currentLanguage() {
        return normalizeLanguage(window.currentLanguage || getStoredLanguage(window.currentEmployee && window.currentEmployee.id) || detectBrowserLanguage());
    }

    function t(key, params) {
        var lang = currentLanguage();
        var text = (DICT[lang] && DICT[lang][key]) || (DICT[DEFAULT_LANG] && DICT[DEFAULT_LANG][key]) || key;
        if (params) {
            Object.keys(params).forEach(function (name) {
                text = text.replace(new RegExp('\\{' + name + '\\}', 'g'), params[name]);
            });
        }
        return text;
    }

    function setPageLanguage(lang, employee, options) {
        var normalized = normalizeLanguage(lang);
        window.currentLanguage = normalized;
        document.documentElement.lang = normalized === 'vi-VN' ? 'vi' : 'zh-TW';
        if (!options || options.store !== false) {
            setStoredLanguage(normalized, employee && employee.id);
        }
        applyI18n();

        if (options && options.persist && employee && employee.id && window.sb) {
            window.sb.from('employees')
                .update({ preferred_language: normalized })
                .eq('id', employee.id)
                .eq('company_id', employee.company_id)
                .then(function (res) {
                    if (res && res.error) console.warn('preferred_language update failed', res.error);
                });
        }
        window.dispatchEvent(new CustomEvent('employee-language-change', { detail: { language: normalized } }));
        return normalized;
    }

    function initEmployeeLanguage(employee) {
        var preferred = employee && employee.preferred_language;
        var stored = getStoredLanguage(employee && employee.id);
        var lang = preferred || stored || detectBrowserLanguage();
        return setPageLanguage(lang, employee, { persist: false });
    }

    function applyI18n(root) {
        var scope = root || document;
        scope.querySelectorAll('[data-i18n]').forEach(function (el) {
            el.textContent = t(el.getAttribute('data-i18n'));
        });
        scope.querySelectorAll('[data-i18n-placeholder]').forEach(function (el) {
            el.setAttribute('placeholder', t(el.getAttribute('data-i18n-placeholder')));
        });
        scope.querySelectorAll('[data-i18n-value]').forEach(function (el) {
            el.setAttribute('value', t(el.getAttribute('data-i18n-value')));
        });
        scope.querySelectorAll('[data-i18n-title]').forEach(function (el) {
            el.setAttribute('title', t(el.getAttribute('data-i18n-title')));
        });
        scope.querySelectorAll('[data-i18n-html]').forEach(function (el) {
            el.innerHTML = t(el.getAttribute('data-i18n-html'));
        });
        scope.querySelectorAll('[data-lang-select]').forEach(function (el) {
            el.value = currentLanguage();
        });
    }

    function createLanguageSwitch(options) {
        var opts = options || {};
        var wrap = document.createElement('div');
        wrap.className = opts.className || 'employee-lang-switch';
        wrap.style.cssText = opts.style || 'display:flex;align-items:center;gap:6px;justify-content:flex-end;margin:0 0 10px;';
        wrap.innerHTML =
            '<label style="font-size:12px;font-weight:800;color:#64748B;" data-i18n="languageLabel"></label>' +
            '<select data-lang-select style="border:1px solid #CBD5E1;border-radius:999px;padding:7px 10px;background:#fff;color:#334155;font-size:12px;font-weight:900;font-family:inherit;">' +
                '<option value="zh-TW">中文</option>' +
                '<option value="vi-VN">Tiếng Việt</option>' +
            '</select>';
        var select = wrap.querySelector('select');
        select.value = currentLanguage();
        select.addEventListener('change', function () {
            setPageLanguage(select.value, window.currentEmployee || opts.employee || null, {
                persist: !!opts.persist,
                store: opts.store !== false
            });
        });
        applyI18n(wrap);
        return wrap;
    }

    window.EmployeeI18N = {
        SUPPORTED_LANGS: SUPPORTED_LANGS,
        DEFAULT_LANG: DEFAULT_LANG,
        DICT: DICT,
        normalizeLanguage: normalizeLanguage,
        detectBrowserLanguage: detectBrowserLanguage,
        getStoredLanguage: getStoredLanguage,
        setStoredLanguage: setStoredLanguage,
        currentLanguage: currentLanguage,
        t: t,
        setPageLanguage: setPageLanguage,
        initEmployeeLanguage: initEmployeeLanguage,
        applyI18n: applyI18n,
        createLanguageSwitch: createLanguageSwitch
    };
    window.tEmployee = t;

    if (document.readyState !== 'loading') applyI18n();
    else document.addEventListener('DOMContentLoaded', function () { applyI18n(); });
})();
