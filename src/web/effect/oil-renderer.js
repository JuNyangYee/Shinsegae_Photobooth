// 사진 효과 "유화 · 획 (세부 보존)" WebGL2 렌더러. 소스(영상·이미지) 한 장 → 효과 그림 한 장.
// 출처: 같은 팀 동료가 만든 재료 필터 갤러리 https://nau-filter-gallery.vercel.app/ 프리셋 `oil2f`.
//   배포 페이지에서 이식했다(원본 소스 저장소는 받지 못함). 원본이 바뀌면 다시 분석·비교한다 (docs/SYSTEM.md 6절)
//   (원본 tex·pass·allocate·upload·renderDrawing·paintStrokes 중 oil2f 경로를 옮겼다. 셰이더는 oil-shaders.js)
// 기법: Hertzmann 1998 (층 칠하기·보완 층). 패스 구조는 docs/SYSTEM.md 6절 "사진 효과(유화 · 획)".
//
// 패스: (회색조 유화면 입력 회색조) → 색 보정 → 구조 텐서 → 가로·세로 흐림 → 흐름장 → 밑칠 → 붓 층 3개 → 보완 층 → 합성 → 출력 단계 → 캔버스
// 출력 단계 (6-1, settings.outputMode): 'off' 그대로, 'gray' 회색조·레벨, 'thermal' 회색조·레벨 → 인쇄 해상도로 면적 평균
//   → 1비트 디더(문턱값은 GPU, 오차 확산은 화소를 읽어 CPU) → 캔버스(결과 크기, 종이색·잉크색). 화면 확대는 정수배 최근접 +
//   경계 1화소만 넓이 비율로 섞는다(FS_THERMAL_SHOW, 화면 표시 전용).
// 흑백 스타일 (7-1, settings.bwStyle): 'tone'은 6-1 그대로. 'texture'는 붓 높이 조명(FS_BW_PREP)·국소 대비를 더한 회색에 점 방식,
//   'flow'·'stroke'는 회색은 'texture'와 같고 문턱을 인쇄 해상도 전체로 만든다(FS_THERMAL_SCREEN: 흐름장 LIC 또는 획 가로 삼각파).
// 회색조 유화 (8단계, outputMode 'gray-oil'): 입력 회색조(FS_INPUT_GRAY, Rec.709) → 유화 패스 그대로 → 출력 단계 회색조·레벨(FS_OUTPUT).
//   결과 사진(output 'pixels')이면 같은 합성 그림에서 인쇄용 1비트(6-1 톤 점 경로: 회색조·레벨 → 면적 평균 → 점 방식)도 만들어 돌려준다.
// 이미지·프레임을 밖으로 내보내거나 저장하지 않는다. 캔버스에 그리거나 결과 사진용 화소를 돌려주기만 한다.
//
// GPU 자원은 만드는 즉시 owned에 넣는다. 만들다 실패하면(텍스처·프레임버퍼·셰이더) 그때까지 만든 것을 지우고,
// dispose()는 owned 전체를 지운다 (5단계 검수 2·3). 그림마다 GL 오류·컨텍스트 손실을 확인해 실패를 성공으로 넘기지 않는다 (검수 1).

import { createStrokeBuilder, resolveOilDrawing } from '../core/oil-paint.js';
import { INPUT_LUMA, bwStyleOf, ditherErrorDiffusion, isGpuDither, printSizeFor, screenOf, thresholdMap } from '../core/thermal.js';
import {
  FS_BLUR, FS_BW_PREP, FS_COMPOSE, FS_GRADE, FS_INPUT_GRAY, FS_OUTPUT, FS_SST, FS_STROKE, FS_TFM, FS_THERMAL_DITHER, FS_THERMAL_REDUCE,
  FS_THERMAL_SCREEN, FS_THERMAL_SHOW, FS_UNDER, VS, VS_STROKE,
} from './oil-shaders.js';

/** 만들기·그리기 실패 원인 (D 화면에 그대로 보인다) */
export const EffectFault = Object.freeze({
  WEBGL_UNAVAILABLE: 'webgl2-unavailable', // getContext('webgl2') 실패 (하드웨어 가속 꺼짐 등)
  FLOAT_UNAVAILABLE: 'float-target-unavailable', // EXT_color_buffer_float 없음 (흐름장이 음수 값을 담지 못한다)
  SHADER_FAILED: 'shader-failed', // 셰이더 컴파일·링크 실패
  FRAMEBUFFER_INCOMPLETE: 'framebuffer-incomplete',
  CONTEXT_LOST: 'context-lost',
  RENDER_FAILED: 'render-failed',
  NOT_RUNNING: 'not-running', // 결과 사진을 그리려 했지만 미리보기 효과가 돌고 있지 않음 (장애·컨텍스트 손실 중)
});

export class EffectError extends Error {
  constructor(fault, message) {
    super(`${fault}: ${message}`);
    this.name = 'EffectError';
    this.fault = fault;
  }
}

// 이미지 보존 없이 매 그림을 새로 그린다. 그림 사이에는 브라우저가 앞 그림을 계속 보인다.
const CONTEXT_ATTRIBUTES = Object.freeze({
  alpha: false, depth: false, stencil: false, antialias: false, premultipliedAlpha: true, preserveDrawingBuffer: false,
});

// 흑백 스타일 상수 (7-1, 합성 시험 이미지로 정한 값. 로그 2026-10-19-04)
const BW_RELIEF = 2; // 질감 세기 1일 때 획 볼록 조명 세기 (높이 차 → 법선 기울기 배율)
const BW_RELIEF_STEP = 2; // 획 볼록 기울기를 재는 거리 (기준 해상도 px, × px 비례 s)
const BW_LOCAL = 0.6; // 질감 세기 1일 때 국소 대비 (v + k·(v − 흐린 v))
const BW_LOCAL_LOD = 2.5; // 국소 대비의 흐린 쪽 밉 단계 (기준 해상도, 약 6px 평균)
const BW_LINE_MIX = 0.25; // 선 값에 섞는 블루 노이즈 비율 (가는 선의 계단을 깬다)
const BW_LIC_STEPS = 10; // 흐름 선: 앞뒤로 따라가는 점 수
// 흐름 선: LIC 평균의 표준편차 (정규 분포 누적함수로 고르게 펴는 데 쓴다). 선 간격이 넓을수록 잡음을 늘려 읽어 이웃 표본이 닮아
// 커진다. 합성 시험 이미지 두 장에서 선 간격 2~8로 잰 값에 맞춘 식이다
const licSigma = (lineSpacing) => 0.028 * lineSpacing ** 0.4;

// 감열지 화면 표시 색 기본값 (보통 config.thermalDisplay를 넘겨받는다)
const DEFAULT_DISPLAY = Object.freeze({ paper: [255, 255, 255], ink: [0, 0, 0] });

/**
 * @param {{ canvas: HTMLCanvasElement | OffscreenCanvas, contextAttributes?: WebGLContextAttributes,
 *   display?: { paper: number[], ink: number[] } }} options
 *   canvas의 크기는 render()가 그리는 해상도(감열지면 인쇄 해상도)로 맞춘다. display: 감열지 화면의 종이색·잉크색 (화면 전용)
 */
export function createOilRenderer({ canvas, contextAttributes = CONTEXT_ATTRIBUTES, display = DEFAULT_DISPLAY }) {
  const paperColor = [...display.paper]; // 0~255 (셰이더가 정수로 섞는다)
  const inkColor = [...display.ink];
  const gl = canvas.getContext('webgl2', contextAttributes);
  if (!gl) throw new EffectError(EffectFault.WEBGL_UNAVAILABLE, 'getContext("webgl2") returned null');
  if (!gl.getExtension('EXT_color_buffer_float')) {
    throw new EffectError(EffectFault.FLOAT_UNAVAILABLE, 'EXT_color_buffer_float is not supported');
  }
  gl.getExtension('OES_texture_float_linear'); // 원본과 같게 켠다 (RGBA16F는 WebGL2에서 원래 걸러 읽을 수 있다)
  const timer = gl.getExtension('EXT_disjoint_timer_query_webgl2'); // 있으면 GPU 시간 (없어도 된다)
  const debugInfo = gl.getExtension('WEBGL_debug_renderer_info');
  const rendererName = String(gl.getParameter(debugInfo ? debugInfo.UNMASKED_RENDERER_WEBGL : gl.RENDERER) ?? '');

  // 만든 GPU 자원 (종류별 Set). 지울 때 여기서 빼고 지운다
  const owned = { programs: new Set(), textures: new Set(), framebuffers: new Set(), buffers: new Set(), arrays: new Set() };
  // 초기화 실패 경로(아래 catch)에서도 쓰므로 먼저 둔다
  const deleters = {
    programs: (o) => gl.deleteProgram(o),
    textures: (o) => gl.deleteTexture(o),
    framebuffers: (o) => gl.deleteFramebuffer(o),
    buffers: (o) => gl.deleteBuffer(o),
    arrays: (o) => gl.deleteVertexArray(o),
  };

  const strokes = createStrokeBuilder();
  let vao;
  let strokeVAO;
  let strokeBuf;
  let PR;
  let srcTex;
  try {
    vao = track(owned.arrays, gl.createVertexArray());
    strokeVAO = track(owned.arrays, gl.createVertexArray());
    strokeBuf = track(owned.buffers, gl.createBuffer());
    gl.bindVertexArray(strokeVAO);
    gl.bindBuffer(gl.ARRAY_BUFFER, strokeBuf);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 4, gl.FLOAT, false, 16, 0);
    gl.vertexAttribDivisor(0, 1);
    gl.bindVertexArray(null);

    PR = {
      grade: compile(FS_GRADE), sst: compile(FS_SST), blur: compile(FS_BLUR), tfm: compile(FS_TFM),
      stroke: compile(FS_STROKE, VS_STROKE), under: compile(FS_UNDER), compose: compile(FS_COMPOSE), output: compile(FS_OUTPUT),
      reduce: compile(FS_THERMAL_REDUCE), dither: compile(FS_THERMAL_DITHER), show: compile(FS_THERMAL_SHOW),
      prep: compile(FS_BW_PREP), screen: compile(FS_THERMAL_SCREEN), inputGray: compile(FS_INPUT_GRAY),
    };

    // 소스 텍스처: 영상 프레임을 그림마다 올린다 (크기는 texImage2D가 정한다)
    srcTex = track(owned.textures, gl.createTexture());
    gl.bindTexture(gl.TEXTURE_2D, srcTex);
    setFilter(gl.LINEAR, gl.LINEAR);
    checkGl('init');
  } catch (error) {
    // 셰이더 컴파일 실패 등: 그때까지 만든 프로그램·버퍼·VAO·텍스처를 모두 지운다 (검수 3)
    deleteAll();
    throw error;
  }

  // 그리는 해상도마다 텍스처 묶음 (미리보기 크기와 결과 사진 크기가 다르면 두 묶음). 최근 것 2개만 둔다
  const targets = new Map();
  const MAX_TARGET_SETS = 2;
  let T = null; // 지금 그리는 해상도의 묶음
  // 감열지 인쇄 해상도마다 묶음 (용지 폭을 바꾸면 새 묶음). 최근 것 2개만 둔다
  const printTargets = new Map();
  const thresholdTextures = new Map(); // 점 방식 → 문턱 지도 텍스처 (R8, 처음 쓸 때 만든다)
  let errorWork = null; // 오차 확산 작업 버퍼 (그림마다 새로 만들지 않게)
  let warmedPrint = ''; // 회색조 유화: 결과 사진의 인쇄 경로를 미리 한 번 쓴 조건 (용지·점 방식, 8단계)
  let disposed = false;
  const queries = []; // GPU 시간 측정 중인 질의 (결과가 나오면 꺼낸다)
  const stats = {
    draws: 0, cpuMs: 0, gpuMs: null, strokes: 0, width: 0, height: 0, pxScale: 0, timer: Boolean(timer),
    outputMode: 'off', dither: '', bwStyle: '', screen: '', printWidth: 0, printHeight: 0, readMs: null, ditherMs: null,
  };

  function track(set, object) {
    set.add(object);
    return object;
  }

  function release(kind, object) {
    if (!object || !owned[kind].delete(object)) return;
    if (!gl.isContextLost()) deleters[kind](object);
  }

  function deleteAll() {
    for (const kind of Object.keys(owned)) {
      for (const object of [...owned[kind]]) release(kind, object);
    }
  }

  // 쌓여 있는 GL 오류를 비운다 (이전 그림·다른 코드의 오류를 이번 그림 탓으로 보지 않게). 컨텍스트를 잃으면 멈춘다
  function clearGlErrors() {
    for (let i = 0; i < 16; i += 1) {
      if (gl.getError() === gl.NO_ERROR || gl.isContextLost()) return;
    }
  }

  // 컨텍스트 손실·GL 오류면 예외. 실패한 그림(빈 화소 등)을 성공으로 넘기지 않는다 (검수 1)
  function checkGl(stage) {
    const error = gl.getError();
    if (gl.isContextLost()) throw new EffectError(EffectFault.CONTEXT_LOST, `context lost during ${stage}`);
    if (error !== gl.NO_ERROR) throw new EffectError(EffectFault.RENDER_FAILED, `GL error 0x${error.toString(16)} during ${stage}`);
  }

  function compile(fs, vs = VS) {
    const p = track(owned.programs, gl.createProgram());
    for (const [type, src] of [[gl.VERTEX_SHADER, vs], [gl.FRAGMENT_SHADER, fs]]) {
      const s = gl.createShader(type);
      gl.shaderSource(s, src);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS) && !gl.isContextLost()) {
        const info = gl.getShaderInfoLog(s);
        gl.deleteShader(s);
        throw new EffectError(EffectFault.SHADER_FAILED, info || 'compile failed');
      }
      gl.attachShader(p, s);
      gl.deleteShader(s); // 프로그램에 붙은 동안은 남고, 프로그램을 지우면 함께 지워진다
    }
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS) && !gl.isContextLost()) {
      throw new EffectError(EffectFault.SHADER_FAILED, gl.getProgramInfoLog(p) || 'link failed');
    }
    return { p, u: {} };
  }

  function U(prog, name) {
    if (!(name in prog.u)) prog.u[name] = gl.getUniformLocation(prog.p, name);
    return prog.u[name];
  }

  function setFilter(min, mag) {
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, min);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, mag);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  }

  // 원본 tex(): 텍스처 + 그 텍스처에 그리는 프레임버퍼
  // 실패하면 이 텍스처·프레임버퍼를 지우고 예외 (검수 3)
  function tex(w, h, { float = false, mip = false, nearest = false } = {}) {
    const t = track(owned.textures, gl.createTexture());
    let fb = null;
    try {
      gl.bindTexture(gl.TEXTURE_2D, t);
      const levels = mip ? Math.floor(Math.log2(Math.max(w, h))) + 1 : 1;
      gl.texStorage2D(gl.TEXTURE_2D, levels, float ? gl.RGBA16F : gl.RGBA8, w, h);
      const filter = nearest ? gl.NEAREST : gl.LINEAR;
      setFilter(mip ? gl.LINEAR_MIPMAP_LINEAR : filter, filter);
      fb = track(owned.framebuffers, gl.createFramebuffer());
      gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, t, 0);
      checkFramebuffer();
      return { t, fb, w, h, mip };
    } catch (error) {
      release('framebuffers', fb);
      release('textures', t);
      throw error;
    } finally {
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    }
  }

  function checkFramebuffer() {
    const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
    if (status !== gl.FRAMEBUFFER_COMPLETE && !gl.isContextLost()) {
      throw new EffectError(EffectFault.FRAMEBUFFER_INCOMPLETE, `status 0x${status.toString(16)}`);
    }
  }

  const TARGET_KEYS = ['inputGray', 'grade', 'sst', 'sst2', 'tfm', 'paint', 'hgt', 'paintC', 'composed', 'out', 'bw'];

  function freeTargets(set) {
    for (const key of TARGET_KEYS) {
      if (!set[key]) continue;
      release('textures', set[key].t);
      release('framebuffers', set[key].fb);
      set[key] = null;
    }
    release('framebuffers', set.mrt);
    set.mrt = null;
  }

  function useTargets(W, H) {
    const key = `${W}x${H}`;
    let set = targets.get(key);
    if (set) {
      targets.delete(key); // 최근 사용 순서로
    } else {
      set = allocate(W, H);
      while (targets.size >= MAX_TARGET_SETS) {
        const [oldKey, oldSet] = targets.entries().next().value;
        freeTargets(oldSet);
        targets.delete(oldKey);
      }
    }
    targets.set(key, set);
    T = set;
  }

  // 원본 allocate()의 oil2f 부분. 흐름장(sst·tfm)은 절반 해상도, 나머지는 그리는 해상도
  // 일부만 만들고 실패하면 만든 것을 모두 지우고 예외 (검수 3)
  function allocate(W, H) {
    const fw = Math.round(W / 2);
    const fh = Math.round(H / 2);
    // out: 결과 사진(화면 밖) 출력, bw: 흑백 스타일 밝기(7-1), inputGray: 회색조 유화의 입력 회색조(8단계). 처음 쓸 때 만든다
    const set = { mrt: null, out: null, bw: null, inputGray: null };
    try {
      set.grade = tex(W, H, { mip: true });
      set.sst = tex(fw, fh, { float: true });
      set.sst2 = tex(fw, fh, { float: true });
      set.tfm = tex(fw, fh, { float: true });
      set.paint = tex(W, H, { mip: true });
      set.hgt = tex(W, H);
      set.paintC = tex(W, H); // 보완 층이 비교할 '지금까지 칠한 결과' 사본
      set.composed = tex(W, H, { nearest: true }); // 출력 단계의 입력 (합성 결과)
      set.mrt = track(owned.framebuffers, gl.createFramebuffer());
      gl.bindFramebuffer(gl.FRAMEBUFFER, set.mrt);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, set.paint.t, 0);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT1, gl.TEXTURE_2D, set.hgt.t, 0);
      gl.drawBuffers([gl.COLOR_ATTACHMENT0, gl.COLOR_ATTACHMENT1]);
      checkFramebuffer();
      return set;
    } catch (error) {
      freeTargets(set);
      throw error;
    } finally {
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    }
  }

  // 화소를 올려 읽기만 하는 텍스처 (프레임버퍼 없음). 문턱 지도(R8), CPU 디더 마스크(RGBA8에 4점씩)
  function dataTexture(w, h, { rgba = false, data = null } = {}) {
    const t = track(owned.textures, gl.createTexture());
    try {
      gl.bindTexture(gl.TEXTURE_2D, t);
      gl.texStorage2D(gl.TEXTURE_2D, 1, rgba ? gl.RGBA8 : gl.R8, w, h);
      setFilter(gl.NEAREST, gl.NEAREST);
      const entry = { t, w, h, rgba };
      if (data) uploadBytes(entry, data);
      return entry;
    } catch (error) {
      release('textures', t);
      throw error;
    }
  }

  function uploadBytes(entry, data) {
    gl.bindTexture(gl.TEXTURE_2D, entry.t);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, entry.w, entry.h, entry.rgba ? gl.RGBA : gl.RED, gl.UNSIGNED_BYTE, data);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
  }

  function thresholdTexture(method) {
    let entry = thresholdTextures.get(method);
    if (!entry) {
      const { size, thresholds } = thresholdMap(method);
      entry = dataTexture(size, size, { data: thresholds });
      thresholdTextures.set(method, entry);
    }
    return entry;
  }

  const PRINT_KEYS = ['gray', 'bits', 'mask', 'thr'];

  function freePrintTargets(set) {
    for (const key of PRINT_KEYS) {
      if (!set[key]) continue;
      release('textures', set[key].t);
      release('framebuffers', set[key].fb);
      set[key] = null;
    }
  }

  // 인쇄 해상도 묶음: 모두 (Pw/4)×Ph에 가로 4점씩, GL 방향. gray 회색, bits GPU 디더 0/1, mask CPU 디더 마스크를 올린 것,
  // thr 흐름 선·붓 결 선의 점별 문턱(7-1). bits·mask·thr는 처음 쓸 때 만든다. 만들다 실패하면 그 텍스처만 지운다(tex·dataTexture)
  function usePrintTargets(Pw, Ph) {
    const key = `${Pw}x${Ph}`;
    let set = printTargets.get(key);
    if (set) {
      printTargets.delete(key); // 최근 사용 순서로
    } else {
      set = { w: Pw, h: Ph, gray: tex(Pw / 4, Ph, { nearest: true }), bits: null, mask: null, thr: null };
      while (printTargets.size >= MAX_TARGET_SETS) {
        const [oldKey, oldSet] = printTargets.entries().next().value;
        freePrintTargets(oldSet);
        printTargets.delete(oldKey);
      }
    }
    printTargets.set(key, set);
    return set;
  }

  // 4점씩 묶은 대상(Pw/4 × Ph)을 읽어 위 줄부터로 뒤집는다. 한 줄 = Pw바이트이고 바이트 순서가 곧 점 순서다
  function readRows(target, Pw, Ph) {
    const raw = new Uint8Array(Pw * Ph);
    gl.bindFramebuffer(gl.FRAMEBUFFER, target.fb);
    gl.readPixels(0, 0, target.w, target.h, gl.RGBA, gl.UNSIGNED_BYTE, raw);
    const out = new Uint8Array(Pw * Ph);
    for (let y = 0; y < Ph; y += 1) out.set(raw.subarray((Ph - 1 - y) * Pw, (Ph - y) * Pw), y * Pw);
    return out;
  }

  function levelUniforms(settings) {
    return { uBrightness: settings.brightness ?? 0, uContrast: settings.contrast ?? 1, uGamma: settings.gamma ?? 1 };
  }

  function resizeCanvas(w, h) {
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }
  }

  /**
   * 감열지 출력 단계. composed(그리는 해상도) → 인쇄 해상도 Pw×Ph → (canvas면) 화면 크기 Dw×Dh로 확대.
   * canvas: 문턱값 디더는 GPU 마스크(bits)를, 오차 확산은 회색을 읽어 CPU로 디더한 마스크를 올려 FS_THERMAL_SHOW로 그린다.
   * print: 화면은 건드리지 않고 gray·mask(위 줄부터, 1바이트/점)를 돌려준다. 문턱값 디더면 mask는 화면과 같은 bits를 읽는다.
   *   흐름 선·붓 결 선이면 점별 문턱 thr도 읽어 돌려준다(CPU가 gray ≥ thr로 다시 확인한다, 7-1).
   * 흑백 스타일(7-1)이 톤 점이 아니면 먼저 붓 높이 조명을 더한 밝기(bw, 밉)를 만들고 축소에서 국소 대비를 더한다.
   * warm: 화면도 결과도 아닌 준비만(회색조 유화 미리보기, 8단계). 인쇄 대상·문턱 지도를 만들고 축소·디더 패스를 한 번 그린다. 화소는 읽지 않는다.
   */
  function thermalStage(settings, D, output, Dw, Dh) {
    const { width, height } = D;
    const style = bwStyleOf(settings);
    const screen = screenOf(settings);
    const { width: Pw, height: Ph } = printSizeFor(settings.paperDots, width, height);
    const P = usePrintTargets(Pw, Ph);
    const texture = style === 'tone' ? 0 : settings.bwTexture ?? 0;
    let prep = T.composed;
    if (style !== 'tone') {
      if (!T.bw) T.bw = tex(width, height, { mip: true });
      pass(PR.prep, T.bw, { uImage: T.composed, uHgt: T.hgt }, { uRelief: texture * BW_RELIEF, uStep: Math.max(1, BW_RELIEF_STEP * D.pxScale) });
      prep = T.bw;
    }
    pass(PR.reduce, P.gray, { uImage: T.composed, uPrep: prep }, {
      uScale: [width / Pw, height / Ph], uUsePrep: style === 'tone' ? 0 : 1, uLocal: texture * BW_LOCAL,
      uLocalLod: Math.max(0, BW_LOCAL_LOD + Math.log2(D.pxScale)), ...levelUniforms(settings),
    });
    const result = { printWidth: Pw, printHeight: Ph, readMs: null, ditherMs: null, gray: null, mask: null, thr: null };
    const lines = screen === 'flow-lines' || screen === 'stroke-lines';
    const gpu = lines || isGpuDither(screen);
    let shown = null; // 화면에 확대할 마스크 묶음
    if (gpu) {
      if (!P.bits) P.bits = tex(Pw / 4, Ph, { nearest: true });
      let thr = null;
      if (lines) {
        if (!P.thr) P.thr = tex(Pw / 4, Ph, { nearest: true });
        pass(PR.screen, P.thr, { uHgt: T.hgt, uTFM: T.tfm, uBlue: thresholdTexture('blue-noise') }, {
          uPrint: [Pw, Ph], uStyle: screen === 'stroke-lines' ? 1 : 0, uLine: settings.lineSpacing ?? 3, uMix: BW_LINE_MIX,
          uLicSigma: licSigma(settings.lineSpacing ?? 3), uSteps: BW_LIC_STEPS,
        });
        thr = P.thr;
      }
      pass(PR.dither, P.bits, { uGray: P.gray, uThr: thr ?? thresholdTexture(screen) }, { uFull: thr ? 1 : 0 });
      shown = P.bits;
    }
    if (output === 'warm') return result;
    if (output === 'print' || !gpu) { // 결과 사진 또는 오차 확산: 회색을 읽는다 (동기)
      const r0 = performance.now();
      result.gray = readRows(P.gray, Pw, Ph);
      if (output === 'print' && lines) result.thr = readRows(P.thr, Pw, Ph);
      result.readMs = performance.now() - r0;
    }
    if (gpu && output === 'print') {
      result.mask = readRows(P.bits, Pw, Ph).map((v) => (v > 127 ? 1 : 0));
    } else if (!gpu) {
      const d0 = performance.now();
      if (!errorWork || errorWork.length < Pw * Ph) errorWork = new Float32Array(Pw * Ph);
      result.mask = ditherErrorDiffusion(result.gray, Pw, Ph, screen, errorWork);
      result.ditherMs = performance.now() - d0;
      if (output === 'canvas') {
        if (!P.mask) P.mask = dataTexture(Pw / 4, Ph, { rgba: true });
        const bytes = new Uint8Array(Pw * Ph); // GL 방향(아래 줄부터)으로 4점씩
        for (let g = 0; g < Ph; g += 1) {
          const src = (Ph - 1 - g) * Pw;
          for (let x = 0; x < Pw; x += 1) bytes[g * Pw + x] = result.mask[src + x] ? 255 : 0;
        }
        uploadBytes(P.mask, bytes);
        shown = P.mask;
      }
    }
    if (output === 'canvas') {
      resizeCanvas(Dw, Dh);
      pass(PR.show, null, { uMask: shown }, { uPaper: paperColor, uInk: inkColor });
    }
    return result;
  }

  /**
   * 회색조 유화 미리보기 (8단계): 결과 사진에서만 쓰는 인쇄 경로(인쇄 대상, 블루 노이즈 문턱 지도 약 25ms, 축소·디더 셰이더)를
   * 용지·점 방식이 바뀔 때 한 번 미리 쓴다. 안 하면 첫 셔터 순간에 몰려 동기 구간이 길어졌다(실제 OBS 첫 촬영 54.6ms, 긴 작업 1개)
   */
  function warmGrayOilPrint(settings, D) {
    const key = `${settings.paperDots} ${settings.dither}`;
    if (warmedPrint === key) return;
    thermalStage({ ...settings, bwStyle: 'tone' }, D, 'warm', 0, 0);
    warmedPrint = key;
  }

  // 원본 pass(): 전체 화면 삼각형 하나. target이 null이면 캔버스
  function pass(prog, target, texs, uni) {
    gl.useProgram(prog.p);
    gl.bindFramebuffer(gl.FRAMEBUFFER, target ? target.fb : null);
    const w = target ? target.w : canvas.width;
    const h = target ? target.h : canvas.height;
    gl.viewport(0, 0, w, h);
    let unit = 0;
    for (const [name, t] of Object.entries(texs)) {
      gl.activeTexture(gl.TEXTURE0 + unit);
      gl.bindTexture(gl.TEXTURE_2D, t.t || t);
      gl.uniform1i(U(prog, name), unit);
      unit += 1;
    }
    gl.uniform2f(U(prog, 'uRes'), w, h);
    gl.uniform2f(U(prog, 'uTexel'), 1 / w, 1 / h);
    for (const [name, v] of Object.entries(uni || {})) {
      const loc = U(prog, name);
      if (Array.isArray(v)) {
        if (v.length === 3) gl.uniform3fv(loc, v);
        else gl.uniform2fv(loc, v);
      } else gl.uniform1f(loc, v);
    }
    gl.bindVertexArray(vao);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    if (target && target.mip) {
      gl.bindTexture(gl.TEXTURE_2D, target.t);
      gl.generateMipmap(gl.TEXTURE_2D);
    }
  }

  function upload(source) {
    gl.bindTexture(gl.TEXTURE_2D, srcTex);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
  }

  function drawStrokes(pr, layer, D, seed) {
    const { data, n } = strokes.build({ layer: layer.layer, spacing: layer.spacing, width: D.width, height: D.height, boil: D.boil, seed });
    gl.bindBuffer(gl.ARRAY_BUFFER, strokeBuf);
    gl.bufferData(gl.ARRAY_BUFFER, data, gl.DYNAMIC_DRAW);
    gl.uniform1f(U(pr, 'uLen'), layer.length);
    gl.uniform1f(U(pr, 'uWid'), layer.width);
    gl.uniform1f(U(pr, 'uBrisLen'), layer.brisLength);
    gl.uniform1f(U(pr, 'uBrisWid'), layer.brisWidth);
    gl.uniform1f(U(pr, 'uLod'), layer.lod);
    gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 14, n);
    return n;
  }

  // 원본 paintStrokes()의 oil2f 경로 (sbr 1 = 유화)
  function paintStrokes(D, seed, linePx) {
    const { width: W, height: H } = D;
    gl.bindFramebuffer(gl.FRAMEBUFFER, T.mrt);
    gl.viewport(0, 0, W, H);
    gl.useProgram(PR.under.p);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, T.grade.t);
    gl.uniform1i(U(PR.under, 'uGrade'), 0);
    gl.uniform1f(U(PR.under, 'uUnderLod'), D.underLod);
    gl.bindVertexArray(vao);
    gl.drawArrays(gl.TRIANGLES, 0, 3);

    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    const pr = PR.stroke;
    gl.useProgram(pr.p);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, T.grade.t);
    gl.uniform1i(U(pr, 'uGrade'), 0);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, T.tfm.t);
    gl.uniform1i(U(pr, 'uTFM'), 1);
    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, T.paintC.t); // 붓 층에서는 읽지 않는다 (uErrT 0)
    gl.uniform1i(U(pr, 'uCanvas'), 2);
    gl.uniform2f(U(pr, 'uRes'), W, H);
    gl.uniform1f(U(pr, 'uJit'), D.jitter);
    gl.uniform1f(U(pr, 'uLinePx'), linePx); // 붓 결 선 주기 (그리는 해상도 px, 7-1). 색 그림에는 영향이 없다
    gl.bindVertexArray(strokeVAO);
    let count = 0;
    for (const layer of D.layers) {
      gl.uniform1f(U(pr, 'uDetMin'), layer.detailMin);
      gl.uniform1f(U(pr, 'uErrT'), 0);
      count += drawStrokes(pr, layer, D, seed);
    }
    if (D.refine) { // 보완 층: 지금까지의 칠을 사본으로 떠서 원본과 비교한다
      gl.bindFramebuffer(gl.READ_FRAMEBUFFER, T.paint.fb);
      gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, T.paintC.fb);
      gl.blitFramebuffer(0, 0, W, H, 0, 0, W, H, gl.COLOR_BUFFER_BIT, gl.NEAREST);
      gl.bindFramebuffer(gl.FRAMEBUFFER, T.mrt);
      gl.viewport(0, 0, W, H);
      gl.useProgram(pr.p);
      gl.uniform1f(U(pr, 'uDetMin'), 0);
      gl.uniform1f(U(pr, 'uErrT'), D.refine.errorThreshold);
      gl.uniform1f(U(pr, 'uCell'), D.refine.cell);
      count += drawStrokes(pr, D.refine, D, seed);
    }
    gl.disable(gl.BLEND);
    gl.bindVertexArray(null);
    gl.bindTexture(gl.TEXTURE_2D, T.paint.t);
    gl.generateMipmap(gl.TEXTURE_2D);
    return count;
  }

  function pollTimer() {
    while (queries.length) {
      const q = queries[0];
      if (!gl.getQueryParameter(q, gl.QUERY_RESULT_AVAILABLE)) break;
      const disjoint = gl.getParameter(timer.GPU_DISJOINT_EXT);
      if (!disjoint) stats.gpuMs = gl.getQueryParameter(q, gl.QUERY_RESULT) / 1e6;
      gl.deleteQuery(q);
      queries.shift();
    }
  }

  /**
   * 소스 한 장을 효과 그림으로 그려 캔버스에 보인다.
   * @param {TexImageSource | null} source 영상·이미지·캔버스. null이면 앞 그림의 소스를 다시 쓴다
   *   (정지 이미지를 여러 번 그릴 때. 이미지 요소를 매번 올리면 1080x1920에서 수십 ms가 든다)
   * @param {{ settings: object, width: number, height: number, seed: number,
   *   sourceOffset?: [number, number], sourceScale?: [number, number], referenceShortSide?: number }} options
   *   width·height: 그리는 해상도. sourceOffset·sourceScale: 출력 uv(왼쪽 아래 원점, 0~1) → 소스 텍스처 uv
   *   (위아래를 뒤집어 올리므로 텍스처 uv도 왼쪽 아래 원점). 기본값은 소스 전체 그대로.
   *   output: 'canvas'(화면 캔버스, 크기를 맞춘다), 'pixels'(화면 밖에 그려 RGBA 화소를 위 줄부터 돌려준다.
   *   화면 캔버스는 건드리지 않는다. 결과 사진용, 출력 모드 off·gray·gray-oil. gray-oil이면 인쇄용 gray·mask도. 인쇄 단계만 실패하면
   *   gray·mask 대신 printError), 'print'(감열지 결과 사진용: 인쇄 해상도의
   *   gray·mask를 위 줄부터 돌려준다. 화면 캔버스는 건드리지 않는다), 'warm'(결과 사진 준비: 'pixels'·'print'와 같은 대상·패스를
   *   결과 크기로 한 번 쓰고 화소는 읽지 않는다. 미리보기 대기 중에 부른다. 화면 캔버스·D 화면 통계는 건드리지 않는다)
   *   출력 단계는 settings의 outputMode·dither·brightness·contrast·gamma·paperDots를 따른다 (outputMode가 없으면 'off')
   *   displayWidth·displayHeight: 감열지 화면 캔버스 크기 (기본값은 그리는 해상도. 미리보기는 결과 크기를 넘긴다)
   * @returns {{ strokes: number, cpuMs: number, pixels?: Uint8ClampedArray,
   *   gray?: Uint8Array, mask?: Uint8Array, printWidth?: number, printHeight?: number }}
   */
  function render(source, {
    settings, width, height, seed, sourceOffset = [0, 0], sourceScale = [1, 1], referenceShortSide, output = 'canvas',
    displayWidth = width, displayHeight = height,
  }) {
    if (disposed) throw new Error('renderer disposed');
    if (gl.isContextLost()) throw new EffectError(EffectFault.CONTEXT_LOST, 'context is lost');
    const t0 = performance.now();
    const mode = settings.outputMode ?? 'off';
    if ((output === 'print') !== (mode === 'thermal') && output !== 'canvas' && output !== 'warm') {
      throw new Error(`output ${output} does not fit outputMode ${mode} (thermal -> print, off/gray/gray-oil -> pixels)`);
    }
    useTargets(width, height);
    if (output === 'canvas' && mode !== 'thermal') resizeCanvas(width, height);
    const D = resolveOilDrawing(settings, { width, height, referenceShortSide });
    let query = null;
    if (timer && output === 'canvas') { // GPU 시간은 미리보기 그림만 잰다
      pollTimer();
      if (queries.length < 4) {
        query = gl.createQuery();
        gl.beginQuery(timer.TIME_ELAPSED_EXT, query);
      }
    }
    let count = 0;
    let pixels;
    let thermal = null;
    let printError = ''; // 회색조 유화 결과에서 인쇄 단계만 실패한 원인 (사진은 확정)
    try {
      clearGlErrors();
      if (source !== null) upload(source);
      if (mode === 'gray-oil') {
        // 회색조 유화 (8단계): 입력을 먼저 회색 한 장으로. 색 보정 이후는 원본 그대로이고, 회색 그림을 크롭·반전 없이 읽는다
        if (!T.inputGray) T.inputGray = tex(width, height);
        pass(PR.inputGray, T.inputGray, { uSrc: srcTex }, { uLuma: INPUT_LUMA, uSrcOffset: sourceOffset, uSrcScale: sourceScale });
        pass(PR.grade, T.grade, { uSrc: T.inputGray }, { uAmt: D.grade, uSrcOffset: [0, 0], uSrcScale: [1, 1] });
      } else {
        pass(PR.grade, T.grade, { uSrc: srcTex }, { uAmt: D.grade, uSrcOffset: sourceOffset, uSrcScale: sourceScale });
      }
      pass(PR.sst, T.sst, { uTex: T.grade });
      pass(PR.blur, T.sst2, { uTex: T.sst }, { uDir: [1 / T.sst.w, 0], uSigma: D.flowSigma });
      pass(PR.blur, T.sst, { uTex: T.sst2 }, { uDir: [0, 1 / T.sst.h], uSigma: D.flowSigma });
      pass(PR.tfm, T.tfm, { uTex: T.sst });
      // 붓 결 선 주기: 선 간격(인쇄 점) × 인쇄 점 하나의 그리는 해상도 px (감열지가 아니어도 같은 식, 색에는 영향 없음)
      count = paintStrokes(D, seed, (settings.lineSpacing ?? 3) * (width / (settings.paperDots ?? 576)));
      pass(PR.compose, T.composed, { uPaint: T.paint, uHgt: T.hgt }, { uStr: D.strength, uRelief: D.relief, uPxScale: D.pxScale });
      if (mode === 'gray-oil' && output === 'canvas') warmGrayOilPrint(settings, D);
      // 회색조·회색조 유화는 회색조·레벨. 회색조 유화는 이것으로 색 보정·획 색 흔들림의 색을 없앤다(무채색, 8단계)
      const outputUniforms = { uGray: mode === 'gray' || mode === 'gray-oil' ? 1 : 0, ...levelUniforms(settings) };
      if (mode === 'thermal') {
        thermal = thermalStage(settings, D, output, displayWidth, displayHeight);
        checkGl({ canvas: 'preview render', warm: 'result prepare' }[output] ?? 'photo render'); // 화소 읽기까지 끝난 뒤
      } else if (output === 'warm') {
        // 결과 사진 준비 (첫 촬영 멈춤 수정): 결과 크기 대상 묶음·out·획 목록·셰이더를 셔터 전에 한 번 쓴다. 화소는 읽지 않는다
        if (!T.out) T.out = tex(width, height, { nearest: true });
        pass(PR.output, T.out, { uImage: T.composed }, { uFlipY: 1, ...outputUniforms });
        if (mode === 'gray-oil') thermalStage({ ...settings, bwStyle: 'tone' }, D, 'warm', width, height);
        checkGl('result prepare');
      } else if (output === 'pixels') {
        if (!T.out) T.out = tex(width, height, { nearest: true });
        pass(PR.output, T.out, { uImage: T.composed }, { uFlipY: 1, ...outputUniforms });
        pixels = new Uint8ClampedArray(width * height * 4);
        gl.bindFramebuffer(gl.FRAMEBUFFER, T.out.fb);
        gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
        checkGl('photo render'); // 화소 읽기까지 끝난 뒤. 잃었거나 오류면 빈 화소일 수 있다. 여기를 지나면 사진은 확정이다
        if (mode === 'gray-oil') {
          // 인쇄용 1비트 (8단계): 같은 합성 그림을 6-1 톤 점 경로로(회색조·레벨 → 인쇄 해상도 면적 평균 → 점 방식). 화면에는 보이지 않는다.
          // 사진과 따로 실패한다: 여기서 예외·GL 오류·컨텍스트 손실이 나도 확정된 사진은 돌려주고 printError만 알린다 (8단계 검수 1)
          try {
            thermal = thermalStage({ ...settings, bwStyle: 'tone' }, D, 'print', width, height);
            checkGl('print data');
          } catch (error) {
            thermal = null;
            printError = error instanceof EffectError ? error.message : `${EffectFault.RENDER_FAILED}: ${error?.message ?? error}`;
          }
        }
      } else {
        pass(PR.output, null, { uImage: T.composed }, { uFlipY: 0, ...outputUniforms });
        checkGl('preview render');
      }
    } finally {
      // 중간에 실패해도 다음 그림이 섞기·질의가 켜진 상태에서 시작하지 않게 한다
      gl.disable(gl.BLEND);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.bindVertexArray(null);
      if (query) {
        gl.endQuery(timer.TIME_ELAPSED_EXT);
        queries.push(query);
      }
    }
    const cpuMs = performance.now() - t0;
    if (output === 'canvas') {
      Object.assign(stats, {
        draws: stats.draws + 1, cpuMs, strokes: count, width, height, pxScale: D.pxScale, outputMode: mode,
        dither: mode === 'thermal' ? settings.dither : '', bwStyle: mode === 'thermal' ? bwStyleOf(settings) : '',
        screen: mode === 'thermal' ? screenOf(settings) : '', printWidth: thermal?.printWidth ?? 0, printHeight: thermal?.printHeight ?? 0,
        readMs: thermal?.readMs ?? null, ditherMs: thermal?.ditherMs ?? null,
      });
    }
    if (output === 'warm') return { strokes: count, cpuMs };
    if (thermal && output !== 'canvas') {
      const { gray, mask, thr, printWidth, printHeight } = thermal;
      return { strokes: count, cpuMs, pixels, gray, mask, thr, printWidth, printHeight };
    }
    return printError ? { strokes: count, cpuMs, pixels, printError } : { strokes: count, cpuMs, pixels };
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    if (!gl.isContextLost()) for (const q of queries) gl.deleteQuery(q);
    deleteAll(); // 대상 묶음·프로그램·버퍼·VAO·소스 텍스처 모두 (검수 2: 예전에는 프로그램을 지우지 못했다)
    queries.length = 0;
    targets.clear();
    printTargets.clear();
    thresholdTextures.clear();
    errorWork = null;
    T = null;
  }

  return {
    gl,
    render,
    dispose,
    getStats: () => ({ ...stats }),
    /** 살아 있는 GPU 자원 수 (종류별). 테스트·조사용 */
    liveResources: () => Object.fromEntries(Object.entries(owned).map(([kind, set]) => [kind, set.size])),
    renderer: () => rendererName,
  };
}
