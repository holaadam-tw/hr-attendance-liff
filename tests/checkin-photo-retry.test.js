// ============================================================
// 打卡相機／照片逾時與重試回歸測試
//
// 直接抽取 checkin.html 內的真實 helper 執行，防止以下問題復發：
// 1. iPhone / LINE WebView 的 canvas.toBlob callback 沒有回來，畫面永遠處理中。
// 2. 逾時關閉相機後直接重試，拿到 0x0 空畫面而照片處理失敗。
// 3. 未記錄卡住階段，事後只知道「操作逾時」而不知道卡在哪裡。
// ============================================================

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const SRC = process.env.CHECKIN_FILE || path.join(ROOT, 'checkin.html');
const src = fs.readFileSync(SRC, 'utf8');

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  ✅ ' + name + (extra ? '  → ' + extra : '')); }
  else { fail++; console.log('  ❌ ' + name + (extra ? '  → ' + extra : '')); }
}

function grab(name) {
  const marker = 'function ' + name + '(';
  const i = src.indexOf(marker);
  if (i < 0) throw new Error('找不到函式：' + name);
  let depth = 0, started = false;
  for (let j = i; j < src.length; j++) {
    if (src[j] === '{') { depth++; started = true; }
    else if (src[j] === '}') {
      depth--;
      if (started && depth === 0) return src.slice(i, j + 1);
    }
  }
  throw new Error('括號不對稱：' + name);
}

function buildRealHelpers() {
  const body = [
    'const PHOTO_ENCODE_TIMEOUT_MS = 3000;',
    'const CAMERA_FRAME_TIMEOUT_MS = 5000;',
    grab('hasUsableCameraFrame'),
    grab('waitForUsableCameraFrame'),
    grab('dataUrlToJpegBlob'),
    grab('canvasToJpegBlob'),
    'return { hasUsableCameraFrame, waitForUsableCameraFrame, dataUrlToJpegBlob, canvasToJpegBlob };'
  ].join('\n');
  return new Function('Blob', 'Uint8Array', 'atob', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', body)(
    Blob,
    Uint8Array,
    globalThis.atob || (s => Buffer.from(s, 'base64').toString('binary')),
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval
  );
}

function liveVideo(overrides = {}) {
  return Object.assign({
    readyState: 2,
    videoWidth: 640,
    videoHeight: 480,
    srcObject: {
      getVideoTracks: () => [{ readyState: 'live', enabled: true }]
    }
  }, overrides);
}

async function main() {
  console.log('\n═══════════════════════════════════════');
  console.log('  打卡相機／照片重試回歸測試');
  console.log('═══════════════════════════════════════');

  let helpers;
  try {
    helpers = buildRealHelpers();
    check('成功抽出 checkin.html 的真實照片與相機 helper', true);
  } catch (error) {
    check('成功抽出 checkin.html 的真實照片與相機 helper', false, error.message);
    process.exit(1);
  }
  let inlineSyntaxOk = true;
  try {
    const inlineScripts = [...src.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)];
    inlineScripts.forEach(match => new Function(match[1]));
  } catch (error) {
    inlineSyntaxOk = false;
  }
  check('checkin.html 全部 inline JavaScript 語法正確', inlineSyntaxOk);

  console.log('\n=== 1. 照片轉換正常與備援 ===');
  const jpegData = 'data:image/jpeg;base64,AQIDBA==';
  let blob = await helpers.canvasToJpegBlob({
    toBlob: cb => cb(new Blob([new Uint8Array([1, 2, 3])], { type: 'image/jpeg' })),
    toDataURL: () => jpegData
  }, 0.6, 20);
  check('toBlob 正常回傳時直接取得照片', blob.size === 3 && blob.type === 'image/jpeg');

  blob = await helpers.canvasToJpegBlob({
    toBlob: cb => cb(null),
    toDataURL: () => jpegData
  }, 0.6, 20);
  check('toBlob 回傳空值時改走 dataURL 備援', blob.size === 4, blob.size + ' bytes');

  const startedAt = Date.now();
  blob = await helpers.canvasToJpegBlob({
    toBlob: () => {},
    toDataURL: () => jpegData
  }, 0.6, 10);
  check('toBlob 永遠不回應時，逾時後仍能產生照片', blob.size === 4 && Date.now() - startedAt < 500, (Date.now() - startedAt) + 'ms');

  blob = await helpers.canvasToJpegBlob({
    toBlob: () => { throw new Error('Safari encoder failed'); },
    toDataURL: () => jpegData
  }, 0.6, 20);
  check('toBlob 丟出錯誤時仍走備援', blob.size === 4);

  let invalidRejected = false;
  try {
    await helpers.canvasToJpegBlob({ toBlob: cb => cb(null), toDataURL: () => 'data:,' }, 0.6, 20);
  } catch (error) {
    invalidRejected = error.message === 'photo_encode_failed';
  }
  check('主要與備援都無照片時明確回報 photo_encode_failed', invalidRejected);

  console.log('\n=== 2. 相機畫面可用性 ===');
  check('正常 live 串流＋有效尺寸可拍照', helpers.hasUsableCameraFrame(liveVideo()));
  check('相機來源已清空時不可拍照', !helpers.hasUsableCameraFrame(liveVideo({ srcObject: null })));
  check('videoWidth/videoHeight 為 0 時不可拍照', !helpers.hasUsableCameraFrame(liveVideo({ videoWidth: 0 })));
  check('相機 track 已 ended 時不可拍照', !helpers.hasUsableCameraFrame(liveVideo({
    srcObject: { getVideoTracks: () => [{ readyState: 'ended', enabled: true }] }
  })));
  check('相機 track 被停用時不可拍照', !helpers.hasUsableCameraFrame(liveVideo({
    srcObject: { getVideoTracks: () => [{ readyState: 'live', enabled: false }] }
  })));

  const delayedVideo = liveVideo({ readyState: 0, videoWidth: 0, videoHeight: 0 });
  setTimeout(() => Object.assign(delayedVideo, { readyState: 2, videoWidth: 640, videoHeight: 480 }), 20);
  const readyResult = await helpers.waitForUsableCameraFrame(delayedVideo, 200);
  check('重新開啟相機後會等待第一個有效畫面', readyResult === delayedVideo);

  let frameTimeout = false;
  try {
    await helpers.waitForUsableCameraFrame(liveVideo({ readyState: 0, videoWidth: 0 }), 20);
  } catch (error) {
    frameTimeout = error.message === 'camera_frame_unavailable';
  }
  check('相機一直沒有有效畫面時會逾時，不拿空照片', frameTimeout);

  console.log('\n=== 3. 真實流程防退化檢查 ===');
  const ensurePos = src.indexOf('await ensureCameraReadyForCapture(statusBox)');
  const dimensionPos = src.indexOf('const vw = video.videoWidth, vh = video.videoHeight;');
  check('拍照前先確認／重開相機', ensurePos >= 0 && ensurePos < dimensionPos);
  check('逾時先讓舊操作失效再關相機', /activeCaptureAttemptId = 0;[\s\S]{0,500}stopCamera\(\);/.test(src));
  check('舊操作每次 await 後都會檢查是否已取消', (src.match(/ensureCaptureAttemptActive\(attemptId\)/g) || []).length >= 10);
  check('兩種拍照模式都使用有備援的照片轉換', (src.match(/await canvasToJpegBlob\(canvas\)/g) || []).length === 2);
  check('不再直接等待沒有逾時的 canvas.toBlob Promise', !src.includes("new Promise(r => canvas.toBlob(r, 'image/jpeg', 0.6))"));
  check('逾時記錄包含實際處理階段', src.includes("code: 'operation_timeout'") && src.includes('attempt_stage: attemptStage'));
  check('系統相機拍完會清空 input，允許同一張照片再次觸發 onchange', src.includes("input.value = '';"));
  check('下班仍不受 500m 精度門檻阻擋', src.includes("if (currentCheckInType === 'in' && loc.accuracy > GPS_MAX_ACCURACY_M"));

  console.log('\n═══════════════════════════════════════');
  console.log('  結果：✅ ' + pass + ' 通過  ❌ ' + fail + ' 失敗');
  console.log('═══════════════════════════════════════\n');
  process.exit(fail > 0 ? 1 : 0);
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
