// 최종 화면 합성 (17단계)의 관람객 UI 층: 지금 DOM의 눈 글씨·3·2·1·눈송이·결과 빛을 합성 캔버스에 같은 위치·움직임으로 그린다.
// DOM 요소는 상태·위치의 기준으로 그대로 두고(글자 넣고 빼기·숫자 넘김 애니메이션도 DOM이 돌린다) 합성할 때 값만 읽는다.
// 눈에 파인 글자는 CSS와 같은 SVG 필터(#snow-carve, index.html)를 캔버스 filter로 걸고 CSS perspective rotateX를 줄 단위로 재현한다.
// 필터 길이 값은 1080 폭 기준을 main.js가 실제 화면 폭으로 곱해 두므로 글자를 화면 CSS 화소로 그린 뒤 합성 크기로 맞춘다.
// 순수 계산은 core/screen-layout.js (Node 테스트), 이 모듈은 합성 화면에서 눈으로 확인한다.

import { photoFrameRect } from '../core/photo-frame.js';
import { carveRowScale, carveRowSource, carveRowTarget } from '../core/screen-layout.js';

const CARVE_BANDS = '.band.guide, .band.notice, .band.result-note';
const TILT_DEGREES = 24; // style.css perspective(90cqw) rotateX(24deg)
const PAD = 24; // 필터가 글자 밖으로 만드는 테 여유 (CSS px)

const SNOW = Object.freeze([
  Object.freeze({
    tile: 0.19, fall: 15000, opacity: 0.55,
    dots: [[0.18, 0.22, 0.002], [0.64, 0.09, 0.0016], [0.83, 0.58, 0.0022], [0.38, 0.71, 0.0015], [0.06, 0.93, 0.0018]],
  }),
  Object.freeze({
    tile: 0.31, fall: 10000, opacity: 0.72,
    dots: [[0.27, 0.15, 0.0042], [0.76, 0.44, 0.0034], [0.51, 0.86, 0.005]],
  }),
]);

function offsetWithin(element, ancestor) {
  let x = 0;
  let y = 0;
  for (let node = element; node && node !== ancestor; node = node.offsetParent) {
    x += node.offsetLeft;
    y += node.offsetTop;
  }
  return { x, y };
}

const translateY = (transform) => (transform && transform !== 'none' ? new DOMMatrixReadOnly(transform).m42 : 0);

/**
 * @param {{ doc?: Document, stage: HTMLElement, frame: object, createCanvas?: () => HTMLCanvasElement }} options frame: config.photoFrame
 */
export function createScreenLayers({ doc = document, stage, frame, createCanvas = () => doc.createElement('canvas') }) {
  const style = (element) => doc.defaultView.getComputedStyle(element);
  const statusVeil = doc.getElementById('status-veil');
  const resultView = doc.getElementById('result-view');
  const resultCard = doc.getElementById('result-card');
  const resultPaper = doc.getElementById('result-paper');
  const textCanvas = createCanvas();
  const carved = createCanvas();
  const layer = createCanvas();
  const tiles = new Map();
  let layerKey = '';

  function lineRecord(group, element, clip) {
    const cs = style(element);
    return {
      // cs.font는 font-variant-numeric(숫자 글자)이 있으면 빈 문자열이라 낱개 속성으로 만든다
      text: element.textContent, font: `${cs.fontStyle} ${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`, letterSpacing: cs.letterSpacing, kerning: cs.fontKerning,
      top: offsetWithin(element, group).y, height: element.offsetHeight,
      clipTop: offsetWithin(clip, group).y, clipHeight: clip.offsetHeight,
      dy: translateY(cs.transform), opacity: Number(cs.opacity),
    };
  }

  function readGroups() {
    const groups = [];
    const add = (element, filter, lines) => {
      const position = offsetWithin(element, stage);
      groups.push({
        filter, x: position.x, y: position.y, width: element.offsetWidth, height: element.offsetHeight,
        opacity: Number(style(element).opacity), lines,
      });
    };
    for (const band of stage.querySelectorAll(CARVE_BANDS)) {
      if (band.hidden) continue;
      add(band, 'snow-carve', [...band.querySelectorAll(':scope > .line')].map((line) => lineRecord(band, line.firstElementChild, line)));
    }
    for (const band of stage.querySelectorAll('.band.countdown')) {
      if (band.hidden) continue;
      const digit = band.querySelector('.countdown-digit');
      if (!digit) continue;
      add(digit, 'snow-carve-lg', [...digit.querySelectorAll('.countdown-glyph')]
        .filter((glyph) => glyph.textContent !== '').map((glyph) => lineRecord(digit, glyph, digit)));
    }
    return groups;
  }

  function drawGroup(ctx, group, stageWidth, scale) {
    const width = Math.max(1, Math.ceil(group.width));
    const height = Math.max(1, Math.ceil(group.height + PAD * 2));
    for (const canvas of [textCanvas, carved]) {
      if (canvas.width !== width || canvas.height !== height) {
        canvas.width = width;
        canvas.height = height;
      }
    }
    const textCtx = textCanvas.getContext('2d');
    textCtx.clearRect(0, 0, width, height);
    textCtx.fillStyle = '#000';
    textCtx.textAlign = 'center';
    textCtx.textBaseline = 'alphabetic';
    for (const line of group.lines) {
      textCtx.save();
      textCtx.beginPath();
      textCtx.rect(0, line.clipTop + PAD, width, line.clipHeight);
      textCtx.clip();
      textCtx.globalAlpha = group.opacity * line.opacity;
      textCtx.font = line.font;
      textCtx.letterSpacing = line.letterSpacing === 'normal' ? '0px' : line.letterSpacing;
      textCtx.fontKerning = line.kerning;
      const metrics = textCtx.measureText(line.text);
      const ascent = metrics.fontBoundingBoxAscent;
      const baseline = line.top + (line.height - (ascent + metrics.fontBoundingBoxDescent)) / 2 + ascent + line.dy + PAD;
      textCtx.fillText(line.text, width / 2, baseline);
      textCtx.restore();
    }
    const carveCtx = carved.getContext('2d');
    carveCtx.clearRect(0, 0, width, height);
    carveCtx.filter = `url(#${group.filter})`;
    carveCtx.drawImage(textCanvas, 0, 0);
    carveCtx.filter = 'none';
    // CSS perspective(90cqw) rotateX(24deg), origin 윗변 중앙을 줄 단위로 재현한다
    const perspective = stageWidth * 0.9;
    const centerX = group.x + width / 2;
    const top = Math.round(group.y * scale);
    const firstRow = Math.floor(-PAD * scale);
    const lastRow = Math.ceil((carveRowTarget(group.height, perspective, TILT_DEGREES) + PAD) * scale);
    for (let row = firstRow; row <= lastRow; row += 1) {
      const y = carveRowSource(row / scale, perspective, TILT_DEGREES);
      const sourceRow = y + PAD;
      if (sourceRow < 0 || sourceRow >= height) continue;
      const w = width * carveRowScale(y, perspective, TILT_DEGREES) * scale;
      ctx.drawImage(carved, 0, sourceRow, width, Math.max(1 / scale, 1), centerX * scale - w / 2, top + row, w, 1);
    }
  }

  function drawCarved(ctx, width, height) {
    const stageWidth = stage.clientWidth;
    if (!(stageWidth > 0)) return;
    const groups = readGroups();
    const key = JSON.stringify([width, height, stageWidth, groups]);
    if (key !== layerKey) {
      layerKey = key;
      if (layer.width !== width || layer.height !== height) {
        layer.width = width;
        layer.height = height;
      }
      const layerCtx = layer.getContext('2d');
      layerCtx.clearRect(0, 0, width, height);
      const scale = width / stageWidth;
      for (const group of groups) drawGroup(layerCtx, group, stageWidth, scale);
    }
    ctx.drawImage(layer, 0, 0);
  }

  function snowTile(spec, width) {
    const size = Math.max(4, Math.round(spec.tile * width));
    const key = `${spec.tile}:${size}`;
    let tile = tiles.get(key);
    if (!tile) {
      tile = createCanvas();
      tile.width = size;
      tile.height = size;
      const c = tile.getContext('2d');
      for (const [fx, fy, r] of spec.dots) {
        const radius = Math.max(1, r * width);
        const g = c.createRadialGradient(fx * size, fy * size, radius * 0.6, fx * size, fy * size, radius);
        g.addColorStop(0, 'rgba(255,255,255,1)');
        g.addColorStop(1, 'rgba(255,255,255,0)');
        c.fillStyle = g;
        c.fillRect(0, 0, size, size);
      }
      tiles.set(key, tile);
    }
    return tile;
  }

  function drawSnow(ctx, width, height, time) {
    const rect = photoFrameRect(width, height, frame);
    const still = doc.documentElement.dataset.motion === 'reduce';
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, width, rect.top);
    ctx.rect(0, rect.top + rect.height, width, height - rect.top - rect.height);
    ctx.clip();
    for (const spec of SNOW) {
      const tile = snowTile(spec, width);
      const offset = still ? 0 : ((time % spec.fall) / spec.fall) * tile.height;
      ctx.save();
      ctx.globalAlpha = spec.opacity;
      ctx.translate(0, offset - tile.height);
      ctx.fillStyle = ctx.createPattern(tile, 'repeat');
      ctx.fillRect(0, 0, width, height + tile.height);
      ctx.restore();
    }
    ctx.restore();
  }

  function drawResultPaper(ctx, width, height) {
    if (resultView.hidden) return;
    const scale = width / stage.clientWidth;
    const top = offsetWithin(resultPaper, stage).y * scale;
    const boxHeight = height - top;
    ctx.save();
    ctx.globalAlpha = Number(style(resultPaper).opacity);
    ctx.translate(width / 2, top + boxHeight * 0.48);
    ctx.scale(width * 0.42, boxHeight * 0.6);
    const g = ctx.createRadialGradient(0, 0, 0, 0, 0, 1);
    g.addColorStop(0, 'rgba(255,236,200,0.5)');
    g.addColorStop(0.75, 'rgba(255,236,200,0)');
    ctx.fillStyle = g;
    ctx.fillRect(-width, -height, width * 2, height * 2);
    ctx.restore();
  }

  return {
    /** 장면 아래: 준비 중·직원 문의의 바탕 막 (DOM .status-veil과 같은 자리) */
    drawUnderScene(ctx, width, height) {
      if (statusVeil.hidden) return;
      const g = ctx.createRadialGradient(width / 2, height * 0.45, 0, width / 2, height * 0.45, height * 0.75);
      g.addColorStop(0, '#2c2f78');
      g.addColorStop(0.65, '#1c1d52');
      g.addColorStop(1, '#100f33');
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, width, height);
    },
    /** 장면 위: 결과 빛, 눈송이, 눈 글씨 */
    drawOverScene(ctx, width, height, time) {
      drawResultPaper(ctx, width, height);
      drawSnow(ctx, width, height, time);
      drawCarved(ctx, width, height);
    },
    /** 결과 사진 층이 걷히는 정도 (1 = 그대로). DOM의 결과 카드 애니메이션을 읽는다 */
    resultOpacity: () => (resultView.hidden ? 1 : Number(style(resultCard).opacity)),
  };
}
