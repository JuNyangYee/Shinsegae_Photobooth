// 실행: npm test
// face-detector.js의 사전 확인과 생성 실패 정리를 가짜 bundle·fetch·캔버스·document로 확인한다.
// 가짜 bundle은 MediaPipe 1.1.1처럼 생성할 때마다 로더 <script>를 붙이고, 모델 설정 전에 60초 통계 타이머를 만든다.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { beforeEach, describe, it } from 'node:test';
import { setImmediate as flushImmediate } from 'node:timers/promises';

import { config } from '../../src/web/config/config.js';
import {
  DetectorFault, checkModel, createFaceDetector, probeWebGL, resetFaceDetectorCacheForTest,
} from '../../src/web/vision/face-detector.js';

const MODEL = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
const MODEL_SHA = createHash('sha256').update(MODEL).digest('hex');
const OPTIONS = Object.freeze({
  bundlePath: '/lib/bundle.mjs', wasmPath: '/lib/wasm', modelPath: '/lib/model.tflite',
  modelBytes: MODEL.byteLength, modelSha256: MODEL_SHA, delegates: ['GPU', 'CPU'], minDetectionConfidence: 0.3,
});

function fakeGl({ renderer = 'ANGLE (NVIDIA)' } = {}) {
  const gl = {
    lost: false,
    RENDERER: 0x1f01,
    getExtension(name) {
      if (name === 'WEBGL_lose_context') return { loseContext: () => { gl.lost = true; } };
      if (name === 'WEBGL_debug_renderer_info') return { UNMASKED_RENDERER_WEBGL: 0x9246 };
      return null;
    },
    getParameter: () => renderer,
  };
  return gl;
}

function fakeCanvas(env) {
  const listeners = new Map();
  const canvas = {
    getContext(type) {
      if (!/webgl/.test(type)) return null;
      if (type === 'webgl2' && !env.webgl2) return null;
      if (type === 'webgl' && !env.webgl1) return null;
      if (!canvas.gl) {
        canvas.gl = fakeGl({ renderer: env.renderer });
        env.contexts.push(canvas.gl);
      }
      return canvas.gl;
    },
    addEventListener: (type, fn) => listeners.set(type, fn),
    removeEventListener: (type) => listeners.delete(type),
    dispatch: (type) => listeners.get(type)?.({ type }),
  };
  env.canvases.push(canvas);
  return canvas;
}

// MediaPipe 흉내는 test/fixtures/fake-vision-bundle.mjs (라이브러리 코드를 파일 이름으로 알아보므로 별도 파일)
const FAKE_BUNDLE = '../fixtures/fake-vision-bundle.mjs';

function setupEnv({ webgl2 = true, webgl1 = true, renderer, fetchResult, failWith = () => null } = {}) {
  const env = {
    webgl2, webgl1, renderer, contexts: [], canvases: [], scripts: [], createCalls: [], fetches: 0, imports: 0, closed: 0,
    failWith, libraryTimers: [],
  };
  const active = new Map();
  let nextTimer = 1;
  env.scope = {
    setInterval(fn, ms) { const id = nextTimer++; active.set(id, ms); return id; },
    clearInterval(id) { active.delete(id); },
  };
  env.activeTimers = () => [...active.values()];
  env.doc = {
    baseURI: 'http://localhost:8765/',
    querySelectorAll: (selector) => (selector === 'script[src]' ? [...env.scripts] : []),
  };
  env.environment = {
    importBundle: async () => {
      env.imports += 1;
      const bundle = await import(FAKE_BUNDLE);
      bundle.configure(env);
      return bundle;
    },
    libraryMarker: 'fake-vision-bundle.mjs',
    fetch: async () => {
      env.fetches += 1;
      if (fetchResult instanceof Error) throw fetchResult;
      const { ok = true, status = 200, data = MODEL } = fetchResult ?? {};
      return { ok, status, arrayBuffer: async () => data.slice().buffer };
    },
    subtle: globalThis.crypto.subtle,
    createCanvas: () => fakeCanvas(env),
    doc: env.doc,
    scope: env.scope,
  };
  return env;
}

const codeOf = (code) => (error) => error.code === code;

beforeEach(() => resetFaceDetectorCacheForTest());

describe('checkModel: 모델 사전 확인', () => {
  it('받지 못하면(HTTP 404·네트워크 오류) model-unavailable', async () => {
    let env = setupEnv({ fetchResult: { ok: false, status: 404 } });
    await assert.rejects(checkModel({ path: '/m', bytes: 8, sha256: MODEL_SHA }, env.environment),
      (error) => error.code === DetectorFault.MODEL_UNAVAILABLE && /HTTP 404/.test(error.message));
    env = setupEnv({ fetchResult: new TypeError('Failed to fetch') });
    await assert.rejects(checkModel({ path: '/m', bytes: 8, sha256: MODEL_SHA }, env.environment),
      codeOf(DetectorFault.MODEL_UNAVAILABLE));
  });

  it('크기나 SHA-256이 다르면 model-invalid', async () => {
    const env = setupEnv({ fetchResult: { data: new Uint8Array(7) } });
    await assert.rejects(checkModel({ path: '/m', bytes: 8, sha256: MODEL_SHA }, env.environment),
      (error) => error.code === DetectorFault.MODEL_INVALID && /size mismatch: 7 bytes, expected 8/.test(error.message));
    const corrupt = setupEnv({ fetchResult: { data: new Uint8Array(8) } });
    await assert.rejects(checkModel({ path: '/m', bytes: 8, sha256: MODEL_SHA }, corrupt.environment),
      (error) => error.code === DetectorFault.MODEL_INVALID && /SHA-256 mismatch/.test(error.message));
  });

  it('통과하면 바이트를 돌려준다. crypto.subtle이 없으면 크기만 확인한다', async () => {
    const env = setupEnv();
    const ok = await checkModel({ path: '/m', bytes: 8, sha256: MODEL_SHA }, env.environment);
    assert.deepEqual([...ok.data], [...MODEL]);
    assert.equal(ok.hashChecked, true);
    const sizeOnly = await checkModel({ path: '/m', bytes: 8, sha256: MODEL_SHA }, { ...env.environment, subtle: undefined });
    assert.equal(sizeOnly.hashChecked, false);
  });

  it('config의 모델 크기·SHA-256은 저장소 파일과 tools/vendor-mediapipe.mjs 기록과 같다', async () => {
    const file = await readFile(new URL('../../lib/mediapipe/models/blaze_face_short_range.tflite', import.meta.url));
    assert.equal(file.byteLength, config.faceDetection.modelBytes);
    assert.equal(createHash('sha256').update(file).digest('hex'), config.faceDetection.modelSha256);
    const vendor = await readFile(new URL('../../tools/vendor-mediapipe.mjs', import.meta.url), 'utf8');
    assert.ok(vendor.includes(`sha256: '${config.faceDetection.modelSha256}'`));
  });
});

describe('probeWebGL: WebGL 확인', () => {
  it('webgl2·webgl 모두 없으면 webgl-unavailable (하드웨어 가속 꺼짐 또는 WebGL 없음)', () => {
    const env = setupEnv({ webgl2: false, webgl1: false });
    assert.throws(() => probeWebGL(env.environment),
      (error) => error.code === DetectorFault.WEBGL_UNAVAILABLE && /hardware acceleration off or no WebGL/.test(error.message));
  });

  it('있으면 버전·렌더러를 돌려주고 확인용 컨텍스트는 바로 놓는다. 소프트웨어 렌더러를 구분한다', () => {
    const env = setupEnv({ renderer: 'ANGLE (Microsoft, Microsoft Basic Render Driver)' });
    const result = probeWebGL(env.environment);
    assert.deepEqual(result, { version: 2, renderer: 'ANGLE (Microsoft, Microsoft Basic Render Driver)', software: true });
    assert.equal(env.contexts.length, 1);
    assert.equal(env.contexts[0].lost, true);
    const v1 = setupEnv({ webgl2: false });
    assert.equal(probeWebGL(v1.environment).version, 1);
  });
});

describe('createFaceDetector: 사전 확인과 실패 정리', () => {
  it('WebGL이 없으면 bundle·모델·MediaPipe 생성을 시작하지 않는다', async () => {
    const env = setupEnv({ webgl2: false, webgl1: false });
    await assert.rejects(createFaceDetector(OPTIONS, env.environment), codeOf(DetectorFault.WEBGL_UNAVAILABLE));
    assert.equal(env.fetches, 0);
    assert.equal(env.imports, 0);
    assert.equal(env.createCalls.length, 0);
  });

  it('모델 사전 확인이 실패하면 MediaPipe 생성을 시작하지 않는다 (타이머·스크립트 0)', async () => {
    for (const fetchResult of [{ ok: false, status: 404 }, { data: new Uint8Array(8) }]) {
      const env = setupEnv({ fetchResult });
      for (let i = 0; i < 5; i += 1) {
        await assert.rejects(createFaceDetector(OPTIONS, env.environment));
      }
      assert.equal(env.createCalls.length, 0);
      assert.deepEqual(env.activeTimers(), []);
      assert.equal(env.scripts.length, 0);
      assert.equal(env.fetches, 5); // 실패한 확인은 기억하지 않고 다음 시도에 다시 받는다
    }
  });

  it('MediaPipe 생성이 N번 실패해도 통계 타이머·로더 스크립트·GL 컨텍스트가 남지 않는다', async () => {
    const env = setupEnv({ failWith: (delegate) => new Error(`${delegate}: The model is not a valid Flatbuffer buffer`) });
    const keep = env.scope.setInterval(() => {}, 500); // 다른 코드의 타이머는 건드리지 않는다
    const originalSetInterval = env.scope.setInterval;
    for (let i = 0; i < 5; i += 1) {
      await assert.rejects(createFaceDetector(OPTIONS, env.environment),
        (error) => error.code === DetectorFault.CREATE && /GPU: GPU: The model/.test(error.message) && /CPU: CPU:/.test(error.message));
    }
    assert.equal(env.createCalls.length, 10); // 5번 × GPU·CPU
    assert.deepEqual(env.activeTimers(), [500]);
    assert.equal(env.scripts.length, 0);
    assert.ok(env.contexts.length >= 10);
    assert.ok(env.contexts.every((gl) => gl.lost));
    assert.equal(env.scope.setInterval, originalSetInterval); // 감싼 setInterval은 되돌린다
    env.scope.clearInterval(keep);
  });

  it('GPU 실패 → CPU 성공: 실패한 시도만 정리하고, 확인한 모델 바이트(복사본)와 직접 만든 캔버스를 넘긴다', async () => {
    const env = setupEnv({ failWith: (delegate) => (delegate === 'GPU' ? new Error('gpu init failed') : null) });
    const detector = await createFaceDetector(OPTIONS, env.environment);
    assert.equal(detector.delegate, 'CPU');
    assert.deepEqual(detector.failures, ['GPU: gpu init failed']);
    assert.deepEqual(detector.model, { bytes: 8, hashChecked: true });
    assert.equal(detector.webgl.version, 2);
    assert.deepEqual(env.activeTimers(), [60000]); // 살아 있는 감지기의 통계 타이머 하나 (close 때 라이브러리가 지운다)
    assert.equal(env.scripts.length, 0);
    const [gpuOptions, cpuOptions] = env.createCalls;
    assert.equal(gpuOptions.baseOptions.modelAssetPath, undefined);
    assert.deepEqual([...cpuOptions.baseOptions.modelAssetBuffer], [...MODEL]);
    assert.notEqual(gpuOptions.baseOptions.modelAssetBuffer, cpuOptions.baseOptions.modelAssetBuffer);
    assert.ok(cpuOptions.canvas);
    detector.close();
    assert.deepEqual(env.activeTimers(), []);
  });

  it('확인을 통과한 모델은 다시 받지 않는다', async () => {
    const env = setupEnv();
    (await createFaceDetector(OPTIONS, env.environment)).close();
    (await createFaceDetector(OPTIONS, env.environment)).close();
    assert.equal(env.fetches, 1);
    assert.equal(env.imports, 1);
  });

  it('실행 중 WebGL 컨텍스트를 잃으면 onContextLost를 부르고, 닫은 뒤에는 부르지 않으며 닫을 때 컨텍스트를 놓는다', async () => {
    const env = setupEnv();
    let lost = 0;
    const detector = await createFaceDetector({ ...OPTIONS, onContextLost: () => { lost += 1; } }, env.environment);
    const canvas = env.createCalls[0].canvas;
    canvas.dispatch('webglcontextlost');
    assert.equal(lost, 1);
    detector.close();
    canvas.dispatch('webglcontextlost');
    assert.equal(lost, 1);
    assert.equal(canvas.gl.lost, true);
    assert.equal(env.closed, 1);
  });

  it('bundle을 불러오지 못하면 bundle-load-failed, 다음 시도는 새 URL로 받는다', async () => {
    const env = setupEnv();
    const urls = [];
    const bundle = await env.environment.importBundle();
    let fail = true;
    const environment = {
      ...env.environment,
      importBundle: async (url) => {
        urls.push(url);
        if (fail) throw new TypeError('Failed to fetch dynamically imported module');
        return bundle;
      },
    };
    await assert.rejects(createFaceDetector(OPTIONS, environment), codeOf(DetectorFault.BUNDLE));
    fail = false;
    (await createFaceDetector(OPTIONS, environment)).close();
    assert.deepEqual(urls, ['/lib/bundle.mjs', '/lib/bundle.mjs?retry=1']);
  });
});

describe('createFaceDetector: 정리할 자원의 소유자 구분 (4단계 검수 6)', () => {
  const failAll = (delegate) => new Error(`${delegate}: model is not valid`);
  const OPTS = { ...OPTIONS };

  it('생성 중에 다른 코드가 만든 60초 타이머는 지우지 않고, 라이브러리가 만든 것만 지운다', async () => {
    const env = setupEnv({ failWith: failAll });
    const others = [];
    env.duringCreate = () => { others.push(env.scope.setInterval(() => {}, 60000)); }; // 같은 간격, 다른 코드
    await assert.rejects(createFaceDetector(OPTS, env.environment), codeOf(DetectorFault.CREATE));
    assert.equal(env.libraryTimers.length, 2); // GPU·CPU
    assert.equal(others.length, 2);
    assert.deepEqual(env.activeTimers(), [60000, 60000]); // 남은 것은 다른 코드의 타이머 둘
    others.forEach((id) => env.scope.clearInterval(id));
    assert.deepEqual(env.activeTimers(), []);
  });

  it('시도 전에 이미 있던 같은 URL의 로더 요소는 지우지 않는다', async () => {
    const env = setupEnv({ failWith: failAll });
    const existing = { src: 'http://localhost:8765/lib/wasm/vision_wasm_internal.js', remove() { throw new Error('must not remove'); } };
    env.scripts.push(existing);
    await assert.rejects(createFaceDetector(OPTS, env.environment));
    assert.deepEqual(env.scripts, [existing]);
  });

  it('시도가 겹치면: 진행 중인 시도의 로더는 지우지 않고, 성공한 감지기의 타이머를 지우지 않으며, setInterval은 마지막에 되돌린다', async () => {
    const env = setupEnv({ failWith: (delegate) => (delegate === 'CPU' ? new Error('cpu failed') : null) });
    const original = env.scope.setInterval;
    const holds = new Map();
    env.hold = (options) => new Promise((resolve) => holds.set(options.baseOptions.delegate, resolve));
    const a = createFaceDetector({ ...OPTS, delegates: ['GPU'] }, env.environment); // 성공할 시도
    const b = createFaceDetector({ ...OPTS, delegates: ['CPU'] }, env.environment); // 실패할 시도
    for (let i = 0; i < 20 && holds.size < 2; i += 1) await flushImmediate();
    assert.equal(holds.size, 2);
    assert.equal(env.scripts.length, 2);
    holds.get('GPU')();
    const detector = await a;
    assert.equal(env.scripts.length, 2); // B가 아직 진행 중: 로더 요소를 지우지 않는다
    assert.notEqual(env.scope.setInterval, original); // 아직 감싼 상태
    holds.get('CPU')();
    await assert.rejects(b);
    assert.equal(env.scripts.length, 0); // 모두 끝난 뒤 지운다
    assert.equal(env.scope.setInterval, original);
    // 겹친 동안 만들어진 타이머는 누구 것인지 몰라 지우지 않는다: 성공한 A의 통계 타이머가 살아 있어야 한다
    assert.ok(env.activeTimers().length >= 1);
    detector.close();
  });
});
