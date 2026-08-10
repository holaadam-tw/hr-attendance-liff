// 打卡環境自我檢查：真實 helper、隱私摘要與禁止副作用回歸測試
const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, '..', 'checkin.html'), 'utf8');
let pass = 0, fail = 0;
function check(name, cond) {
  if (cond) { pass++; console.log('  ✅ ' + name); }
  else { fail++; console.log('  ❌ ' + name); }
}
function grab(name) {
  const start = src.indexOf('function ' + name + '(');
  if (start < 0) throw new Error('找不到函式：' + name);
  let depth = 0, opened = false;
  for (let i = start; i < src.length; i++) {
    if (src[i] === '{') { depth++; opened = true; }
    if (src[i] === '}' && --depth === 0 && opened) return src.slice(start, i + 1);
  }
  throw new Error('函式括號不完整：' + name);
}
function grabCallable(name) {
  const code = grab(name);
  const start = src.indexOf('function ' + name + '(');
  return src.slice(Math.max(0, start - 6), start) === 'async ' ? 'async ' + code : code;
}
function helpers(userAgent) {
  return new Function('navigator', `
    const CHECKIN_HEALTH_VERSION = '20260810.2';
    ${grab('makeHealthResult')}
    ${grab('getHealthPlatform')}
    ${grab('getHealthGpsSettingsAction')}
    ${grab('makeHealthFailure')}
    ${grab('buildHealthSafeSummary')}
    return { makeHealthResult, makeHealthFailure, getHealthPlatform, getHealthGpsSettingsAction, buildHealthSafeSummary };
  `)({ userAgent });
}
function makeGpsProbe(navigatorStub) {
  return new Function('navigator', `
    let gpsPermissionState = 'unknown';
    const HEALTH_GPS_PERMISSION_TIMEOUT_MS = 5;
    const HEALTH_GPS_TIMEOUT_MS = 10;
    ${grabCallable('readHealthGpsPermission')}
    ${grabCallable('getHealthGpsLocation')}
    return getHealthGpsLocation;
  `)(navigatorStub);
}

console.log('\n═══════════════════════════════════════');
console.log('  打卡環境自我檢查回歸測試');
console.log('═══════════════════════════════════════');

let inlineOk = true;
try {
  [...src.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)].forEach(m => new Function(m[1]));
} catch (_) { inlineOk = false; }
check('checkin.html inline JavaScript 語法正確', inlineOk);
check('打卡頁有自我檢查按鈕與安全測試拍照 input', src.includes('id="healthCheckBtn"') && src.includes('id="healthCaptureInput"'));

const ios = helpers('Mozilla/5.0 (iPhone) Line/15');
const android = helpers('Mozilla/5.0 (Linux; Android 15) Line/15');
check('摘要只保留粗略 iOS 平台', ios.getHealthPlatform() === 'iOS / LINE');
check('摘要只保留粗略 Android 平台', android.getHealthPlatform() === 'Android / LINE');
check('Android 定位失敗提供 Android 設定路徑', android.getHealthGpsSettingsAction().includes('應用程式 → LINE → 權限 → 位置'));
check('iPhone 定位失敗提供 iPhone 設定路徑', ios.getHealthGpsSettingsAction().includes('隱私權與安全性 → 定位服務'));

const startedAt = Date.now() - 12;
const ok = ios.makeHealthResult('定位', 'ok', 'gps_ready', 'secret-message', 'secret-action', startedAt);
check('結構化結果包含狀態、代碼與耗時', ok.status === 'ok' && ok.code === 'gps_ready' && ok.elapsedMs >= 0);
check('網路逾時有切換網路建議', ios.makeHealthFailure('網路連線', { name: 'AbortError' }, startedAt).code === 'network_timeout');
check('定位拒絕有專用錯誤碼', ios.makeHealthFailure('定位', { code: 1 }, startedAt).code === 'gps_permission_denied');
check('手機定位不可用時明確提示定位服務可能未開', android.makeHealthFailure('定位', { code: 2 }, startedAt).code === 'gps_unavailable_or_disabled');
const gpsTimeoutFailure = android.makeHealthFailure('定位', { code: 3 }, startedAt);
check('定位逾時明確指出定位服務或 LINE 權限', gpsTimeoutFailure.code === 'gps_timeout_or_disabled' && gpsTimeoutFailure.message.includes('定位服務') && gpsTimeoutFailure.message.includes('LINE'));
check('相機拒絕有專用錯誤碼', ios.makeHealthFailure('相機與照片', { name: 'NotAllowedError' }, startedAt).code === 'camera_permission_denied');
check('照片編碼失敗有重新開啟 LINE 建議', ios.makeHealthFailure('相機與照片', { message: 'photo_encode_failed' }, startedAt).action.includes('重新開啟'));

const summary = ios.buildHealthSafeSummary([
  ios.makeHealthResult('相機與照片', 'error', 'photo_encode_failed', 'Adam E001 25.1,121.5', 'company-secret', startedAt)
]);
check('安全摘要包含版本與錯誤碼', summary.includes('20260810.2') && summary.includes('photo_encode_failed'));
check('安全摘要不包含訊息、姓名、員工與座標', !summary.includes('Adam') && !summary.includes('E001') && !summary.includes('25.1') && !summary.includes('company-secret'));

const healthCode = [
  grab('runCheckinHealthCheck'), grab('handleHealthCapturePhoto'),
  grab('startHealthCaptureTest'), grab('buildHealthSafeSummary'),
  grabCallable('readHealthGpsPermission'), grabCallable('getHealthGpsLocation')
].join('\n');
const forbidden = ['quick_check_in', '.upload(', 'logCheckinFailure(', 'submitGpsReviewRequest(', 'sb.from(', 'sb.rpc('];
check('自我檢查不含打卡、上傳、失敗記錄或資料庫呼叫', forbidden.every(token => !healthCode.includes(token)));
check('網路探測使用 no-store GET 且有逾時', healthCode.includes("cache: 'no-store'") && src.includes('HEALTH_NETWORK_TIMEOUT_MS'));
check('串流檢查重用正式相機與 JPEG helper', healthCode.includes('ensureCameraReadyForCapture(statusBox)') && healthCode.includes('canvasToJpegBlob(testCanvas)'));
check('定位檢查使用全新短時探測，不等待正式打卡多階段定位', healthCode.includes('getHealthGpsLocation()') && !grab('runCheckinHealthCheck').includes('resolveGpsLocation()') && src.includes('HEALTH_GPS_TIMEOUT_MS = 7000'));
check('定位自我檢查不讀寫定位快取或保存座標', !grabCallable('getHealthGpsLocation').match(/cachedLocation|localStorage|saveStoredGpsLocation|markGpsSuccess|applyGpsLocation/));
check('安全摘要未輸出緯經度或識別 ID', !grab('buildHealthSafeSummary').match(/latitude|longitude|userId|employee\.id|companyId|userAgent/));
check('自我檢查期間會隱藏既有精確座標診斷', grab('updateLocationDiagnostic').includes('if (healthCheckRunning)'));
check('系統相機測試完成會撤銷 URL 並清空 input', healthCode.includes('URL.revokeObjectURL(objectUrl)') && healthCode.includes("input.value = ''"));
check('檢查期間會鎖定正式打卡按鈕', grab('setHealthCheckBusy').includes('captureBtn.disabled = busy'));
check('檢查不會停止可用相機串流', !healthCode.includes('stopCamera()'));
const renderCode = grab('renderCheckinHealthResults');
check('失敗總結使用醒目紅底與明確無法打卡文案', renderCode.includes('#B91C1C') && renderCode.includes('目前可能無法打卡'));
check('失敗項目使用紅色卡片並標示需要立即處理', renderCode.includes('#FEF2F2') && renderCode.includes('需要立即處理'));

async function runAsyncGpsTests() {
  let deniedGpsCalls = 0;
  const deniedProbe = makeGpsProbe({
    permissions: { query: async () => ({ state: 'denied' }) },
    geolocation: { getCurrentPosition: () => { deniedGpsCalls++; } }
  });
  let deniedCode = null;
  try { await deniedProbe(10); } catch (error) { deniedCode = error.code; }
  check('定位權限已拒絕時立即失敗且不再啟動 GPS', deniedCode === 1 && deniedGpsCalls === 0);

  const successProbe = makeGpsProbe({
    permissions: { query: async () => ({ state: 'granted' }) },
    geolocation: { getCurrentPosition: success => success({ coords: { latitude: 25.1, longitude: 121.5, accuracy: 20 } }) }
  });
  const loc = await successProbe(10);
  check('短時定位探測可回傳當次座標與精度', loc.latitude === 25.1 && loc.longitude === 121.5 && loc.accuracy === 20);

  const timeoutProbe = makeGpsProbe({
    permissions: { query: async () => ({ state: 'granted' }) },
    geolocation: { getCurrentPosition: () => {} }
  });
  const timeoutStarted = Date.now();
  let timeoutCode = null;
  try { await timeoutProbe(10); } catch (error) { timeoutCode = error.code; }
  check('LINE WebView 不回 callback 時仍由安全計時結束', timeoutCode === 3 && Date.now() - timeoutStarted < 200);
}

runAsyncGpsTests()
  .then(() => {
    console.log(`\n  結果：✅ ${pass} 通過  ❌ ${fail} 失敗\n`);
    process.exit(fail ? 1 : 0);
  })
  .catch(error => {
    fail++;
    console.error('  ❌ 非同步定位測試例外', error);
    console.log(`\n  結果：✅ ${pass} 通過  ❌ ${fail} 失敗\n`);
    process.exit(1);
  });
