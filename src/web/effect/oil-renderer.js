// 사진 효과 "유화 · 획 (세부 보존)" WebGL2 렌더러. 소스(영상·이미지) 한 장 → 효과 그림 한 장.
// 출처: 같은 팀 동료가 만든 재료 필터 갤러리 https://nau-filter-gallery.vercel.app/ 프리셋 `oil2f`.
//   배포 페이지에서 이식했다(원본 소스 저장소는 받지 못함). 원본이 바뀌면 다시 분석·비교한다 (docs/SYSTEM.md 6절)
//   (원본 tex·pass·allocate·upload·renderDrawing·paintStrokes 중 oil2f 경로를 옮겼다. 셰이더는 oil-shaders.js)
// 기법: Hertzmann 1998 (층 칠하기·보완 층). 패스 구조는 docs/SYSTEM.md 6절 "사진 효과(유화 · 획)".
//
// 패스: 색 보정 → 구조 텐서 → 가로·세로 흐림 → 흐름장 → 밑칠 → 붓 층 3개 → 보완 층 → 합성 → 출력 단계(그대로 통과) → 캔버스
// 이미지·프레임을 밖으로 내보내거나 저장하지 않는다. 캔버스에 그리기만 한다.
//
// GPU 자원은 만드는 즉시 owned에 넣는다. 만들다 실패하면(텍스처·프레임버퍼·셰이더) 그때까지 만든 것을 지우고,
// dispose()는 owned 전체를 지운다 (5단계 검수 2·3). 그림마다 GL 오류·컨텍스트 손실을 확인해 실패를 성공으로 넘기지 않는다 (검수 1).

import { createStrokeBuilder, resolveOilDrawing } from '../core/oil-paint.js';
import {
  FS_BLUR, FS_COMPOSE, FS_GRADE, FS_OUTPUT, FS_SST, FS_STROKE, FS_TFM, FS_UNDER, VS, VS_STROKE,
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

/**
 * @param {{ canvas: HTMLCanvasElement | OffscreenCanvas, contextAttributes?: WebGLContextAttributes }} options
 *   canvas의 크기는 render()가 그리는 해상도로 맞춘다.
 */
export function createOilRenderer({ canvas, contextAttributes = CONTEXT_ATTRIBUTES }) {
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
  let disposed = false;
  const queries = []; // GPU 시간 측정 중인 질의 (결과가 나오면 꺼낸다)
  const stats = { draws: 0, cpuMs: 0, gpuMs: null, strokes: 0, width: 0, height: 0, pxScale: 0, timer: Boolean(timer) };

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

  const TARGET_KEYS = ['grade', 'sst', 'sst2', 'tfm', 'paint', 'hgt', 'paintC', 'composed', 'out'];

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
    const set = { mrt: null, out: null }; // out: 결과 사진(화면 밖) 출력. 처음 쓸 때 만든다
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
      if (Array.isArray(v)) gl.uniform2fv(loc, v);
      else gl.uniform1f(loc, v);
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
  function paintStrokes(D, seed) {
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
   *   output: 'canvas'(화면 캔버스, 크기를 맞춘다) 또는 'pixels'(화면 밖에 그려 RGBA 화소를 위 줄부터 돌려준다.
   *   화면 캔버스는 건드리지 않는다. 결과 사진용)
   * @returns {{ strokes: number, cpuMs: number, pixels?: Uint8ClampedArray }}
   */
  function render(source, {
    settings, width, height, seed, sourceOffset = [0, 0], sourceScale = [1, 1], referenceShortSide, output = 'canvas',
  }) {
    if (disposed) throw new Error('renderer disposed');
    if (gl.isContextLost()) throw new EffectError(EffectFault.CONTEXT_LOST, 'context is lost');
    const t0 = performance.now();
    useTargets(width, height);
    if (output === 'canvas' && (canvas.width !== width || canvas.height !== height)) {
      canvas.width = width;
      canvas.height = height;
    }
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
    try {
      clearGlErrors();
      if (source !== null) upload(source);
      pass(PR.grade, T.grade, { uSrc: srcTex }, { uAmt: D.grade, uSrcOffset: sourceOffset, uSrcScale: sourceScale });
      pass(PR.sst, T.sst, { uTex: T.grade });
      pass(PR.blur, T.sst2, { uTex: T.sst }, { uDir: [1 / T.sst.w, 0], uSigma: D.flowSigma });
      pass(PR.blur, T.sst, { uTex: T.sst2 }, { uDir: [0, 1 / T.sst.h], uSigma: D.flowSigma });
      pass(PR.tfm, T.tfm, { uTex: T.sst });
      count = paintStrokes(D, seed);
      pass(PR.compose, T.composed, { uPaint: T.paint, uHgt: T.hgt }, { uStr: D.strength, uRelief: D.relief, uPxScale: D.pxScale });
      if (output === 'pixels') {
        if (!T.out) T.out = tex(width, height, { nearest: true });
        pass(PR.output, T.out, { uImage: T.composed }, { uFlipY: 1 });
        pixels = new Uint8ClampedArray(width * height * 4);
        gl.bindFramebuffer(gl.FRAMEBUFFER, T.out.fb);
        gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
        checkGl('photo render'); // 화소 읽기까지 끝난 뒤. 잃었거나 오류면 빈 화소일 수 있다
      } else {
        pass(PR.output, null, { uImage: T.composed }, { uFlipY: 0 });
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
    if (output === 'canvas') Object.assign(stats, { draws: stats.draws + 1, cpuMs, strokes: count, width, height, pxScale: D.pxScale });
    return { strokes: count, cpuMs, pixels };
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    if (!gl.isContextLost()) for (const q of queries) gl.deleteQuery(q);
    deleteAll(); // 대상 묶음·프로그램·버퍼·VAO·소스 텍스처 모두 (검수 2: 예전에는 프로그램을 지우지 못했다)
    queries.length = 0;
    targets.clear();
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
