// 렌더러 테스트용 가짜 WebGL2 (그리지 않는다). 만든·지운 객체를 종류별로 세고, 장애를 주입한다.
// - lose(): 컨텍스트 손실 (isContextLost true, getError는 CONTEXT_LOST_WEBGL 한 번)
// - pushError(code): 다음 getError가 돌려줄 오류
// - failFramebufferAt(n): n번째 checkFramebufferStatus(1부터)를 미완성으로. 함수를 주면 (호출 번호) => boolean
// - failShaderAt(n): n번째 compileShader(1부터)를 실패로
// - onReadPixels(fn): readPixels를 부를 때 fn(fake, args)
// - failNextCall(name, code): 다음 name 호출이 GL 오류(기본 INVALID_OPERATION)를 남긴다
// 모르는 메서드를 부르면 예외(렌더러가 쓰는 API를 빠짐없이 흉내 냈는지 드러나게). 대문자 이름은 상수로 답한다.

const CONSTANTS = {
  NO_ERROR: 0, INVALID_OPERATION: 0x502, CONTEXT_LOST_WEBGL: 0x9242,
  FRAMEBUFFER_COMPLETE: 0x8cd5, FRAMEBUFFER_INCOMPLETE_ATTACHMENT: 0x8cd6,
  COMPILE_STATUS: 0x8b81, LINK_STATUS: 0x8b82, RENDERER: 0x1f01,
};

export function createFakeWebGL2() {
  const live = { program: new Set(), shader: new Set(), texture: new Set(), framebuffer: new Set(), buffer: new Set(), vertexArray: new Set() };
  const created = { program: [], shader: [], texture: [], framebuffer: [], buffer: [], vertexArray: [] };
  const deletedWith = []; // deleteProgram 등에 실제로 넘어온 값 (kind, value)
  let lost = false;
  let lostReported = false;
  const errors = [];
  let fbChecks = 0;
  let shaderCompiles = 0;
  let failFb = () => false;
  let failShader = () => false;
  let readHook = null;
  let nextId = 1;
  const make = (kind) => {
    const object = { kind, id: nextId++ };
    live[kind].add(object);
    created[kind].push(object);
    return object;
  };
  const remove = (kind) => (object) => {
    deletedWith.push([kind, object]);
    if (object && object.kind === kind) live[kind].delete(object);
  };
  const noop = () => {};
  const impl = {
    getExtension: (name) => (name === 'EXT_color_buffer_float' || name === 'OES_texture_float_linear' ? {} : null),
    getParameter: () => 'fake renderer',
    isContextLost: () => lost,
    getError() {
      if (lost && !lostReported) { lostReported = true; return CONSTANTS.CONTEXT_LOST_WEBGL; }
      return errors.length ? errors.shift() : CONSTANTS.NO_ERROR;
    },
    createProgram: () => make('program'),
    createShader: () => make('shader'),
    createTexture: () => make('texture'),
    createFramebuffer: () => make('framebuffer'),
    createBuffer: () => make('buffer'),
    createVertexArray: () => make('vertexArray'),
    deleteProgram: remove('program'),
    deleteShader: remove('shader'),
    deleteTexture: remove('texture'),
    deleteFramebuffer: remove('framebuffer'),
    deleteBuffer: remove('buffer'),
    deleteVertexArray: remove('vertexArray'),
    compileShader() { shaderCompiles += 1; this.__lastCompileOk = !failShader(shaderCompiles); },
    getShaderParameter() { return this.__lastCompileOk; },
    getShaderInfoLog: () => 'fake compile error',
    getProgramParameter: () => true,
    getProgramInfoLog: () => '',
    checkFramebufferStatus() {
      fbChecks += 1;
      return failFb(fbChecks) ? CONSTANTS.FRAMEBUFFER_INCOMPLETE_ATTACHMENT : CONSTANTS.FRAMEBUFFER_COMPLETE;
    },
    getUniformLocation: (program, name) => ({ program, name }),
    readPixels(...args) { readHook?.(api, args); },
  };
  for (const name of ['shaderSource', 'attachShader', 'linkProgram', 'bindVertexArray', 'bindBuffer', 'enableVertexAttribArray',
    'vertexAttribPointer', 'vertexAttribDivisor', 'texParameteri', 'bindTexture', 'texStorage2D', 'bindFramebuffer',
    'framebufferTexture2D', 'drawBuffers', 'useProgram', 'viewport', 'activeTexture', 'uniform1i', 'uniform2f', 'uniform2fv',
    'uniform1f', 'drawArrays', 'generateMipmap', 'pixelStorei', 'texImage2D', 'bufferData', 'drawArraysInstanced', 'enable',
    'disable', 'blendFunc', 'blitFramebuffer']) impl[name] = noop;
  const failing = new Map();
  for (const name of Object.keys(impl)) {
    const original = impl[name];
    impl[name] = function (...args) {
      if (failing.has(name)) { errors.push(failing.get(name)); failing.delete(name); }
      return original.apply(this, args);
    };
  }

  const gl = new Proxy(impl, {
    get(target, prop) {
      if (prop in target) return target[prop];
      if (typeof prop === 'string' && prop in CONSTANTS) return CONSTANTS[prop];
      if (typeof prop === 'string' && /^[A-Z0-9_]+$/.test(prop)) return 0x1000 + prop.length; // 쓰는 쪽은 값을 넘기기만 한다
      throw new Error(`fake WebGL2: ${String(prop)} not implemented`);
    },
    set(target, prop, value) { target[prop] = value; return true; },
  });

  const api = {
    gl,
    canvas: { width: 0, height: 0, getContext: (type) => (type === 'webgl2' ? gl : null) },
    lose() { lost = true; },
    pushError(code = CONSTANTS.INVALID_OPERATION) { errors.push(code); },
    failFramebufferAt(n) { failFb = typeof n === 'function' ? n : (i) => i === n; },
    failShaderAt(n) { failShader = (i) => i === n; },
    onReadPixels(fn) { readHook = fn; },
    failNextCall(name, code = CONSTANTS.INVALID_OPERATION) { failing.set(name, code); },
    framebufferChecks: () => fbChecks,
    liveCount: () => Object.fromEntries(Object.entries(live).map(([kind, set]) => [kind, set.size])),
    created,
    deletedWith,
    CONSTANTS,
  };
  return api;
}
