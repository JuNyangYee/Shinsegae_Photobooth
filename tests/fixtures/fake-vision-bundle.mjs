// tests/face-detector.test.mjs 전용 MediaPipe 흉내 (테스트 파일이 아니므로 npm test가 직접 실행하지 않는다).
// 실제 1.1.1처럼 생성할 때마다 로더 <script>를 붙이고, 모델 설정 전에 60초 통계 타이머를 만든다.
// 별도 파일인 이유: face-detector.js는 setInterval을 부른 코드의 파일 이름(호출 스택)으로 라이브러리 코드를 알아본다.

let env = null;

/** 테스트가 흉내 환경(scope·doc·scripts·failWith 등)을 넘긴다. */
export function configure(next) {
  env = next;
}

export const FilesetResolver = {
  forVisionTasks: async (path) => ({ wasmLoaderPath: `${path}/vision_wasm_internal.js`, wasmBinaryPath: `${path}/x.wasm` }),
};

export const FaceDetector = {
  async createFromOptions(fileset, options) {
    const own = env;
    own.createCalls.push(options);
    own.scripts.push({ src: new URL(fileset.wasmLoaderPath, own.doc.baseURI).href, remove() { own.scripts.splice(own.scripts.indexOf(this), 1); } });
    await Promise.resolve();
    const statsTimer = own.scope.setInterval(() => {}, 60000); // 통계 로거 (모델 설정 전에 만든다)
    own.libraryTimers.push(statsTimer);
    options.canvas.getContext('webgl2', {}); // wasm 로더가 GL 컨텍스트를 만든다
    if (own.duringCreate) queueMicrotask(own.duringCreate); // 생성 중에 다른 코드가 도는 경우
    await (own.hold ? own.hold(options) : Promise.resolve());
    const error = own.failWith(options.baseOptions.delegate);
    if (error) throw error;
    return {
      detectForVideo: () => ({ detections: [] }),
      close() { own.closed += 1; own.scope.clearInterval(statsTimer); },
    };
  },
};
