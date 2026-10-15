// MediaPipe Face Detector 생성·감지·종료만 맡는다.
// MediaPipe 자료형은 이 파일 밖으로 내보내지 않고, 영상 기준 정규화 박스와 점수만 돌려준다.
// Node 테스트: tests/face-detector.test.mjs (가짜 bundle·fetch·캔버스·document)

/**
 * @typedef {{ x: number, y: number, width: number, height: number, score: number }} DetectedFace
 *   영상(감지 입력) 기준 0~1 정규화, 왼쪽 위 원점, 반전 전
 */

// 생성 실패 원인 (오류의 code). 감지기 상태 알림과 D 화면에 쓴다.
export const DetectorFault = Object.freeze({
  BUNDLE: 'bundle-load-failed', // vision_bundle.mjs를 불러오지 못함
  MODEL_UNAVAILABLE: 'model-unavailable', // 모델 파일을 받지 못함 (없음·서버 오류)
  MODEL_INVALID: 'model-invalid', // 모델 파일 크기·SHA-256이 저장소 기록과 다름 (손상·다른 파일)
  WEBGL_UNAVAILABLE: 'webgl-unavailable', // 하드웨어 가속 꺼짐 또는 WebGL 없음
  WEBGL_LOST: 'webgl-context-lost', // 실행 중 WebGL 컨텍스트를 잃음
  CREATE: 'create-failed', // 사전 확인은 통과했지만 MediaPipe 생성이 실패함
  DETECT: 'detect-failing', // 만든 감지기가 계속 감지에 실패함
});

// MediaPipe 1.1.1의 사용 통계 로거는 60초 setInterval을 모델 설정 전에 만들고, 생성이 실패하면 닫지 않는다.
// 생성 중 만들어진 이 간격의 타이머만 기록했다가 실패하면 지운다. 버전을 올리면 다시 확인한다 (docs/SYSTEM.md 5절).
const STATS_INTERVAL_MS = 60000;

function fault(code, message, cause) {
  const error = new Error(message, cause === undefined ? undefined : { cause });
  error.code = code;
  return error;
}

function defaultEnvironment() {
  return {
    importBundle: (url) => import(url),
    fetch: (...args) => globalThis.fetch(...args),
    subtle: globalThis.crypto?.subtle,
    createCanvas: () => (typeof OffscreenCanvas === 'function'
      ? new OffscreenCanvas(1, 1) : globalThis.document.createElement('canvas')),
    doc: globalThis.document,
    scope: globalThis,
  };
}

let bundle = null; // 불러오기에 성공한 bundle 모듈. 감지기를 다시 만들 때도 그대로 쓴다
let bundleFailures = 0;
const verifiedModels = new Map(); // 모델 경로 → 확인을 통과한 바이트. 한 번 확인하면 다시 받지 않는다

// Chrome은 실패한 동적 import 결과를 기억해 같은 URL로는 다시 받지 않는다(검증에서 확인).
// 실패한 적이 있으면 쿼리를 붙여 새로 받는다. 서버는 쿼리를 무시하고 같은 파일을 준다.
async function loadBundle(bundlePath, env) {
  if (bundle !== null) return bundle;
  const url = bundleFailures === 0 ? bundlePath : `${bundlePath}?retry=${bundleFailures}`;
  try {
    bundle = await env.importBundle(url);
    return bundle;
  } catch (error) {
    bundleFailures += 1;
    throw fault(DetectorFault.BUNDLE, `bundle load failed: ${error?.message ?? error}`, error);
  }
}

function toHex(buffer) {
  return [...new Uint8Array(buffer)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * 모델 파일 사전 확인: 받을 수 있는지, 크기와 SHA-256이 저장소 기록(config)과 같은지.
 * 통과하면 바이트를 돌려준다. 이 바이트를 MediaPipe에 직접 넘기므로 생성 중 모델 받기는 실패할 수 없다.
 * @param {{ path: string, bytes?: number, sha256?: string }} model
 * @returns {Promise<{ data: Uint8Array, hashChecked: boolean }>}
 */
export async function checkModel({ path, bytes, sha256 }, env = defaultEnvironment()) {
  let response;
  try {
    response = await env.fetch(path, { cache: 'no-store' });
  } catch (error) {
    throw fault(DetectorFault.MODEL_UNAVAILABLE, `model fetch failed: ${path} (${error?.message ?? error})`, error);
  }
  if (!response.ok) throw fault(DetectorFault.MODEL_UNAVAILABLE, `model not available: ${path} (HTTP ${response.status})`);
  let data;
  try {
    data = new Uint8Array(await response.arrayBuffer());
  } catch (error) {
    throw fault(DetectorFault.MODEL_UNAVAILABLE, `model read failed: ${path} (${error?.message ?? error})`, error);
  }
  if (bytes !== undefined && data.byteLength !== bytes) {
    throw fault(DetectorFault.MODEL_INVALID, `model size mismatch: ${data.byteLength} bytes, expected ${bytes}`);
  }
  // localhost는 보안 컨텍스트라 crypto.subtle이 있다. 없으면 크기만 확인한다.
  if (sha256 === undefined || !env.subtle) return { data, hashChecked: false };
  const actual = toHex(await env.subtle.digest('SHA-256', data));
  if (actual !== sha256) {
    throw fault(DetectorFault.MODEL_INVALID, `model SHA-256 mismatch: ${actual.slice(0, 12)}…, expected ${sha256.slice(0, 12)}…`);
  }
  return { data, hashChecked: true };
}

/**
 * WebGL 확인. MediaPipe는 CPU delegate도 입력을 WebGL 텍스처로 올리므로 WebGL이 없으면 감지할 수 없다.
 * 확인용 컨텍스트는 바로 놓는다(WEBGL_lose_context). 페이지당 WebGL 컨텍스트 수에 상한이 있기 때문이다.
 * @returns {{ version: 1 | 2, renderer: string, software: boolean }}
 */
export function probeWebGL(env = defaultEnvironment()) {
  let gl = null;
  let version = 2;
  try {
    const canvas = env.createCanvas();
    gl = canvas.getContext('webgl2');
    if (!gl) {
      version = 1;
      gl = canvas.getContext('webgl');
    }
  } catch {
    gl = null;
  }
  if (!gl) throw fault(DetectorFault.WEBGL_UNAVAILABLE, 'WebGL is not available (hardware acceleration off or no WebGL)');
  let renderer = '';
  try {
    const info = gl.getExtension('WEBGL_debug_renderer_info');
    renderer = String(gl.getParameter(info ? info.UNMASKED_RENDERER_WEBGL : gl.RENDERER) ?? '');
  } catch {
    renderer = '';
  }
  gl.getExtension('WEBGL_lose_context')?.loseContext();
  return { version, renderer, software: /swiftshader|llvmpipe|software|basic render/i.test(renderer) };
}

// MediaPipe가 쓸 WebGL 캔버스를 직접 만들어 넘긴다 (옵션 canvas. 넘기지 않으면 라이브러리가 같은 1x1 OffscreenCanvas를 만든다).
// 그래야 실패한 시도의 컨텍스트를 바로 놓고, 실행 중 컨텍스트 손실(webglcontextlost)을 알 수 있다.
// 이 캔버스 인스턴스의 getContext만 감싸 만들어진 WebGL 컨텍스트를 기억한다 (전역 프로토타입은 건드리지 않는다).
function createGlCanvas(env) {
  const canvas = env.createCanvas();
  const getContext = canvas.getContext.bind(canvas);
  let gl = null;
  canvas.getContext = (type, ...rest) => {
    const context = getContext(type, ...rest);
    if (context && /webgl/.test(type)) gl = context;
    return context;
  };
  return {
    canvas,
    release() {
      try {
        gl?.getExtension('WEBGL_lose_context')?.loseContext();
      } catch {
        // 이미 잃은 컨텍스트
      }
      gl = null;
    },
  };
}

// 생성 시도 추적 (4단계 검수 6: 정리할 자원의 소유자를 가린다).
// - 타이머: 진행 중인 시도가 하나뿐일 때, 라이브러리 번들이 직접 부른(호출 스택 바로 위가 번들 파일) 60초 간격만 그 시도의 것으로 기록한다.
//   다른 코드가 같은 시간에 만든 타이머는 기록하지 않는다. 시도가 겹치면(앱은 detector-keeper가 하나씩만 만든다) 누구 것인지 몰라 기록하지 않는다.
// - 로더 <script>: 첫 시도가 시작될 때 이미 있던 요소는 기억해 두고 건드리지 않는다. 겹친 시도가 모두 끝난 뒤에만 그 사이 생긴 요소를 지운다
//   (아직 불러오는 중인 로더 요소를 지우면 그 시도의 불러오기가 멈춘다).
// - 감싼 setInterval은 시도가 겹쳐도 하나만 두고, 마지막 시도가 끝나면 되돌린다.
const tracker = { active: new Set(), scope: null, doc: null, loaderUrl: '', marker: '', original: null, wrapper: null, scriptsBefore: null };

function loaderScripts(doc, loaderUrl) {
  if (!doc?.querySelectorAll || !loaderUrl) return [];
  return [...doc.querySelectorAll('script[src]')].filter((script) => script.src === loaderUrl);
}

function beginAttempt(env, loaderPath, marker) {
  const attempt = { timers: [] };
  if (tracker.active.size === 0) {
    const { scope, doc } = env;
    tracker.scope = scope;
    tracker.doc = doc;
    tracker.loaderUrl = doc?.baseURI && loaderPath ? new URL(String(loaderPath), doc.baseURI).href : '';
    tracker.marker = marker;
    tracker.scriptsBefore = new Set(loaderScripts(doc, tracker.loaderUrl));
    const original = scope.setInterval;
    const wrapper = function setInterval(handler, ms, ...rest) {
      const id = original.call(scope, handler, ms, ...rest);
      if (ms === STATS_INTERVAL_MS && tracker.active.size === 1) {
        // [0] 'Error', [1] 이 함수, [2] setInterval을 부른 코드
        const caller = String(new Error().stack ?? '').split('\n')[2] ?? '';
        if (tracker.marker && caller.includes(tracker.marker)) [...tracker.active][0].timers.push(id);
      }
      return id;
    };
    tracker.original = original;
    tracker.wrapper = wrapper;
    scope.setInterval = wrapper;
  }
  tracker.active.add(attempt);
  return attempt;
}

function endAttempt(attempt, failed) {
  if (failed) attempt.timers.forEach((id) => tracker.scope.clearInterval(id));
  tracker.active.delete(attempt);
  if (tracker.active.size > 0) return;
  if (tracker.scope.setInterval === tracker.wrapper) tracker.scope.setInterval = tracker.original;
  for (const script of loaderScripts(tracker.doc, tracker.loaderUrl)) {
    if (!tracker.scriptsBefore.has(script)) script.remove();
  }
  Object.assign(tracker, { scope: null, doc: null, loaderUrl: '', marker: '', original: null, wrapper: null, scriptsBefore: null });
}

// 생성 한 번(delegate 하나)을 감싼다. MediaPipe는 생성할 때마다 wasm 로더 <script>를 body에 붙이고 지우지 않는다
// (로더가 전역 ModuleFactory를 만들고 라이브러리가 바로 지우므로 재사용할 수 없다). 실행이 끝난 로더 요소는 지워도 된다.
// 실패하면 이 시도가 만든 통계 타이머를 지우고 WebGL 컨텍스트를 놓는다.
async function createOnce(FaceDetector, fileset, options, env, marker) {
  const glCanvas = createGlCanvas(env);
  const attempt = beginAttempt(env, fileset.wasmLoaderPath, marker);
  let failed = true;
  try {
    const detector = await FaceDetector.createFromOptions(fileset, { ...options, canvas: glCanvas.canvas });
    failed = false;
    return { detector, glCanvas };
  } catch (error) {
    glCanvas.release();
    throw error;
  } finally {
    endAttempt(attempt, failed);
  }
}

/**
 * 사전 확인(WebGL, 모델) 뒤 delegate 목록을 차례로 시도해 처음 성공한 감지기를 돌려준다.
 * 모두 실패하면 code(DetectorFault)가 붙은 오류를 던진다.
 * bundle은 동적 import로 불러온다. 불러오기에 실패해도 카메라 미리보기 모듈에는 영향이 없다.
 * @param {{ bundlePath: string, wasmPath: string, modelPath: string, modelBytes?: number, modelSha256?: string,
 *   delegates: string[], minDetectionConfidence: number, onContextLost?: () => void }} options
 *   onContextLost: 만든 감지기가 실행 중 WebGL 컨텍스트를 잃으면 한 번 부른다 (닫은 뒤에는 부르지 않는다)
 */
export async function createFaceDetector({
  bundlePath, wasmPath, modelPath, modelBytes, modelSha256, delegates, minDetectionConfidence, onContextLost = () => {},
}, env = defaultEnvironment()) {
  // 싼 확인부터 한다. 실패하면 MediaPipe 생성(로더·wasm·통계 타이머)을 아예 시작하지 않는다.
  const webgl = probeWebGL(env);
  let model = verifiedModels.get(modelPath);
  if (model === undefined) {
    model = await checkModel({ path: modelPath, bytes: modelBytes, sha256: modelSha256 }, env);
    verifiedModels.set(modelPath, model);
  }
  const { FilesetResolver, FaceDetector } = await loadBundle(bundlePath, env);
  const fileset = await FilesetResolver.forVisionTasks(wasmPath);
  // 라이브러리 코드를 알아보는 표식: 번들 파일 이름 (호출 스택의 URL에 들어 있다. ?retry=N이 붙어도 포함된다)
  const marker = env.libraryMarker ?? String(bundlePath).split('?')[0].split('/').pop();
  const failures = [];
  for (const delegate of delegates) {
    try {
      const { detector, glCanvas } = await createOnce(FaceDetector, fileset, {
        // 라이브러리가 버퍼를 넘겨받아도 다음 생성에 영향이 없게 복사해서 넘긴다
        baseOptions: { modelAssetBuffer: model.data.slice(), delegate },
        runningMode: 'VIDEO',
        minDetectionConfidence,
      }, env, marker);
      return wrap({ detector, glCanvas, delegate, failures, webgl, model, onContextLost });
    } catch (error) {
      failures.push(`${delegate}: ${error?.message ?? error}`);
    }
  }
  throw fault(DetectorFault.CREATE, `no delegate could be created (${failures.join('; ')})`);
}

function wrap({ detector, glCanvas, delegate, failures, webgl, model, onContextLost }) {
  let closed = false;
  // 컨텍스트를 되살리지 않고 감지기를 버린 뒤 새로 만든다 (detector-keeper)
  const handleLost = () => {
    if (!closed) onContextLost();
  };
  glCanvas.canvas.addEventListener?.('webglcontextlost', handleLost);
  return Object.freeze({
    delegate,
    /** 앞서 실패한 delegate와 이유 (예: GPU 실패 후 CPU 사용) */
    failures: Object.freeze([...failures]),
    /** 사전 확인 결과 (D 화면) */
    webgl: Object.freeze({ ...webgl }),
    model: Object.freeze({ bytes: model.data.byteLength, hashChecked: model.hashChecked }),
    /**
     * @param {HTMLCanvasElement | OffscreenCanvas} image 감지 입력
     * @param {number} timestampMs 호출마다 증가해야 한다
     * @returns {DetectedFace[]}
     */
    detect(image, timestampMs) {
      const { width, height } = image;
      const result = detector.detectForVideo(image, timestampMs);
      return result.detections.flatMap(({ boundingBox, categories }) => (boundingBox ? [{
        x: boundingBox.originX / width,
        y: boundingBox.originY / height,
        width: boundingBox.width / width,
        height: boundingBox.height / height,
        score: categories[0]?.score ?? 0,
      }] : []));
    },
    close() {
      if (closed) return;
      closed = true;
      glCanvas.canvas.removeEventListener?.('webglcontextlost', handleLost);
      try {
        detector.close();
      } finally {
        glCanvas.release();
      }
    },
  });
}

/** Node 테스트 전용: 모듈 안에 기억한 bundle·모델을 지운다. */
export function resetFaceDetectorCacheForTest() {
  bundle = null;
  bundleFailures = 0;
  verifiedModels.clear();
}
