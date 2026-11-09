// 데모 합성 장면 (IMPRINT 시안 검토용, 관람객 화면 아님): 카메라·사진 없이 도형으로만 그린 세로 장면.
// 벽·바닥·흐린 불빛 위에 사람 모양 도형 셋(어른 둘, 아이 하나)이 들어오고 나간다. 데모가 이 캔버스를 captureStream()으로
// <video>에 넣어 실제 카메라 처리 경로·회색조 유화 효과·촬영·인쇄 데이터 경로를 그대로 돌린다. 저장하는 것은 없다.
// 사람 도형에는 얼굴 특징이 없다(감지기를 돌리지 않는다: 데모의 "인식됨"은 검토 조작으로 정한다).

const W = 1080;
const H = 1920;
const FPS = 30;

// 사진 틀(1080x1920 화면의 250~1530줄) 안에 얼굴이 오도록 놓은 사람 도형: 가운데 x, 머리 가운데 y, 머리 높이, 어깨 폭, 옷 밝기, 흔들림 위상
const PEOPLE = Object.freeze([
  Object.freeze({ x: 360, headY: 640, head: 250, shoulders: 430, tone: 58, from: -1, phase: 0 }),
  Object.freeze({ x: 724, headY: 600, head: 262, shoulders: 452, tone: 34, from: 1, phase: 1.7 }),
  Object.freeze({ x: 548, headY: 1010, head: 196, shoulders: 300, tone: 92, from: -1, phase: 3.1 }),
]);

// 흐린 불빛 (배경, 크기·밝기 고정. 장면에 결이 생겨 유화 붓질이 보인다)
const LIGHTS = Object.freeze(Array.from({ length: 14 }, (_, i) => Object.freeze({
  x: (i * 389 + 140) % W, y: 160 + ((i * 557) % 760), r: 40 + ((i * 37) % 70), a: 0.18 + ((i * 13) % 10) / 40,
})));

const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);

export function createScene({ createCanvas = () => document.createElement('canvas'), now = () => performance.now() } = {}) {
  const canvas = createCanvas();
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d', { alpha: false });
  let target = 0; // 사람이 있는지 (0·1)
  let amount = 0; // 들어온 정도 (0~1, 1.2초에 걸쳐 따라간다)
  let last = now();
  let timer = null;

  function background(t) {
    const wall = ctx.createLinearGradient(0, 0, 0, H);
    wall.addColorStop(0, '#8f8a83');
    wall.addColorStop(0.62, '#6c6862');
    wall.addColorStop(0.78, '#4a4743');
    wall.addColorStop(1, '#2f2d2b');
    ctx.fillStyle = wall;
    ctx.fillRect(0, 0, W, H);
    // 벽 판: 세로 결
    for (let i = 0; i < 6; i += 1) {
      ctx.fillStyle = `rgba(255, 255, 255, ${i % 2 ? 0.035 : 0.06})`;
      ctx.fillRect(i * 190 - 20, 0, 92, H * 0.74);
    }
    // 위 왼쪽에서 드는 빛
    const light = ctx.createRadialGradient(260, 260, 40, 260, 260, 900);
    light.addColorStop(0, 'rgba(255, 246, 232, 0.55)');
    light.addColorStop(1, 'rgba(255, 246, 232, 0)');
    ctx.fillStyle = light;
    ctx.fillRect(0, 0, W, H);
    for (const l of LIGHTS) {
      const g = ctx.createRadialGradient(l.x, l.y, 0, l.x, l.y, l.r);
      const flicker = 0.85 + 0.15 * Math.sin(t / 900 + l.x);
      g.addColorStop(0, `rgba(255, 250, 240, ${l.a * flicker})`);
      g.addColorStop(1, 'rgba(255, 250, 240, 0)');
      ctx.fillStyle = g;
      ctx.fillRect(l.x - l.r, l.y - l.r, l.r * 2, l.r * 2);
    }
    // 바닥과 발자국 매트 자리
    ctx.fillStyle = 'rgba(20, 20, 20, 0.35)';
    ctx.beginPath();
    ctx.ellipse(W / 2, H * 0.9, 380, 70, 0, 0, Math.PI * 2);
    ctx.fill();
  }

  function person(p, t, k) {
    const sway = Math.sin(t / 1100 + p.phase) * 7;
    const x = p.x + sway + p.from * (1 - ease(k)) * 620;
    const { head } = p;
    ctx.globalAlpha = Math.min(1, k * 1.6);
    // 몸: 어깨에서 아래로 넓어지는 둥근 사다리꼴
    const top = p.headY + head * 0.62;
    const body = ctx.createLinearGradient(x - p.shoulders / 2, 0, x + p.shoulders / 2, 0);
    body.addColorStop(0, `rgb(${p.tone - 18}, ${p.tone - 20}, ${p.tone - 22})`);
    body.addColorStop(0.35, `rgb(${p.tone + 26}, ${p.tone + 24}, ${p.tone + 20})`);
    body.addColorStop(1, `rgb(${p.tone - 26}, ${p.tone - 28}, ${p.tone - 30})`);
    ctx.fillStyle = body;
    ctx.beginPath();
    ctx.moveTo(x - p.shoulders * 0.32, top);
    ctx.quadraticCurveTo(x - p.shoulders * 0.55, top + head * 0.12, x - p.shoulders * 0.58, top + head * 1.1);
    ctx.lineTo(x - p.shoulders * 0.66, H);
    ctx.lineTo(x + p.shoulders * 0.66, H);
    ctx.lineTo(x + p.shoulders * 0.58, top + head * 1.1);
    ctx.quadraticCurveTo(x + p.shoulders * 0.55, top + head * 0.12, x + p.shoulders * 0.32, top);
    ctx.closePath();
    ctx.fill();
    // 목
    ctx.fillStyle = 'rgb(176, 160, 146)';
    ctx.fillRect(x - head * 0.15, p.headY + head * 0.3, head * 0.3, head * 0.42);
    // 머리: 뒤에 어두운 머리카락 타원, 그 위에 조금 아래로 내린 밝은 얼굴 타원(빛 받는 쪽 밝게)
    ctx.fillStyle = 'rgb(38, 32, 30)';
    ctx.beginPath();
    ctx.ellipse(x, p.headY - head * 0.06, head * 0.42, head * 0.52, 0, 0, Math.PI * 2);
    ctx.fill();
    const face = ctx.createRadialGradient(x - head * 0.14, p.headY - head * 0.02, head * 0.05, x, p.headY + head * 0.06, head * 0.6);
    face.addColorStop(0, 'rgb(232, 214, 198)');
    face.addColorStop(1, 'rgb(150, 128, 112)');
    ctx.fillStyle = face;
    ctx.beginPath();
    ctx.ellipse(x, p.headY + head * 0.08, head * 0.34, head * 0.43, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalAlpha = 1;
  }

  function draw() {
    const t = now();
    const dt = Math.min(100, t - last);
    last = t;
    amount += Math.sign(target - amount) * Math.min(Math.abs(target - amount), dt / 1200);
    background(t);
    if (amount > 0) PEOPLE.forEach((p, i) => person(p, t, Math.max(0, Math.min(1, amount * 1.25 - i * 0.12))));
  }

  return {
    canvas,
    /** 사람 도형을 들여보내거나(true) 내보낸다(false). 1.2초에 걸쳐 걸어 들어온다 */
    setPeople(present) { target = present ? 1 : 0; },
    /** 다 들어왔는지 (데모가 "인식됨"으로 바꾸는 때) */
    isSettled: () => amount === target,
    start() {
      if (timer !== null) return;
      draw();
      timer = setInterval(draw, 1000 / FPS);
    },
    stop() {
      clearInterval(timer);
      timer = null;
    },
  };
}
