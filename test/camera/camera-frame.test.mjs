// 실행: npm test
// 카메라 처리 경로의 2D 쪽 (camera-frame.js): 감지 입력·원본 미리보기·캡처가 쓰는 draw(), 색 보정 SVG 필터, 설정 바꾸기
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createCameraFrame } from '../../src/web/camera/camera-frame.js';
import { config } from '../../src/web/config/config.js';
import { canvasTransform, cameraColorMatrix, computeCameraView, svgColorMatrixValues } from '../../src/web/core/camera-view.js';

const STAGE = 9 / 16;

// SVG 요소 흉내: 속성·자식만
function fakeDocument() {
  const make = (ns, tag) => {
    const el = {
      ns, tag, attrs: {}, children: [],
      setAttribute(name, value) { el.attrs[name] = value; },
      append(...nodes) { el.children.push(...nodes); },
      replaceChildren() { el.children.length = 0; },
    };
    return el;
  };
  const body = make('', 'body');
  return { body, createElementNS: make };
}

function fakeContext() {
  const calls = [];
  const ctx = {
    calls, filter: 'none', fillStyle: '',
    save: () => calls.push(['save']),
    restore: () => calls.push(['restore']),
    setTransform: (...args) => calls.push(['setTransform', ...args]),
    fillRect: (...args) => calls.push(['fillRect', ctx.fillStyle, ...args]),
    drawImage: (source, ...args) => calls.push(['drawImage', source.name, ...args, ctx.filter]),
  };
  return ctx;
}

const settingsOf = (patch = {}) => ({ ...config.camera, ...patch });
const video = { name: 'video', videoWidth: 1920, videoHeight: 1080 };

describe('createCameraFrame.draw (감지 입력·원본 미리보기·캡처 공용)', () => {
  it('검게 칠한 뒤 core/camera-view.js canvasTransform으로 drawImage(video, 0, 0), 필터는 중립이면 none', () => {
    const frame = createCameraFrame({ doc: fakeDocument(), stageAspect: STAGE, settings: settingsOf({ rotation: 90, zoom: 1.2 }) });
    const ctx = fakeContext();
    const view = frame.draw(ctx, video, 360, 640);
    const expected = computeCameraView({ videoWidth: 1920, videoHeight: 1080, stageAspect: STAGE, camera: settingsOf({ rotation: 90, zoom: 1.2 }) });
    assert.deepEqual(view, expected);
    assert.deepEqual(ctx.calls, [
      ['save'], ['setTransform', 1, 0, 0, 1, 0, 0], ['fillRect', '#000', 0, 0, 360, 640],
      ['setTransform', ...canvasTransform(expected, 360, 640)], ['drawImage', 'video', 0, 0, 'none'], ['restore'],
    ]);
  });

  it('영상이 없으면 그리지 않고 null', () => {
    const frame = createCameraFrame({ doc: fakeDocument(), stageAspect: STAGE, settings: settingsOf() });
    const ctx = fakeContext();
    assert.equal(frame.draw(ctx, { videoWidth: 0, videoHeight: 0 }, 360, 640), null);
    assert.deepEqual(ctx.calls, []);
  });

  it('getView는 같은 크기·같은 기하 설정이면 같은 객체, 색 보정만 바뀌면 그대로', () => {
    const frame = createCameraFrame({ doc: fakeDocument(), stageAspect: STAGE, settings: settingsOf() });
    const a = frame.getView(1920, 1080);
    assert.equal(frame.getView(1920, 1080), a);
    frame.setSettings(settingsOf({ brightness: 0.2 }));
    assert.equal(frame.getView(1920, 1080), a);
    frame.setSettings(settingsOf({ brightness: 0.2, panX: 0.1 }));
    assert.notEqual(frame.getView(1920, 1080), a);
    assert.notEqual(frame.getView(1080, 1920), frame.getView(1920, 1080));
  });
});

describe('색 보정 SVG 필터 (2D 캔버스 ctx.filter)', () => {
  it('중립이면 필터를 만들지 않는다 (none)', () => {
    const doc = fakeDocument();
    const frame = createCameraFrame({ doc, stageAspect: STAGE, settings: settingsOf() });
    assert.equal(frame.getFilter(), 'none');
    assert.equal(doc.body.children.length, 0);
  });

  it('보정이 있으면 sRGB feColorMatrix(core 계수 그대로) → 감마가 1이 아니면 feComponentTransfer gamma, draw가 그 url로 그린다', () => {
    const doc = fakeDocument();
    const settings = settingsOf({ brightness: 0.1, contrast: 1.3, saturation: 0.5, gamma: 2, temperature: 0.4 });
    const frame = createCameraFrame({ doc, stageAspect: STAGE, settings });
    assert.equal(frame.getFilter(), 'url(#camera-color-1)');
    const [svg] = doc.body.children;
    const [filter] = svg.children;
    assert.deepEqual([svg.attrs.width, svg.attrs.height, filter.attrs.id, filter.attrs['color-interpolation-filters']], ['0', '0', 'camera-color-1', 'sRGB']);
    const [matrix, transfer] = filter.children;
    const color = cameraColorMatrix(settings);
    assert.deepEqual([matrix.tag, matrix.attrs.type, matrix.attrs.values], ['feColorMatrix', 'matrix', svgColorMatrixValues(color)]);
    assert.equal(transfer.tag, 'feComponentTransfer');
    assert.deepEqual(transfer.children.map((f) => [f.tag, f.attrs.type, f.attrs.amplitude, f.attrs.exponent, f.attrs.offset]),
      ['feFuncR', 'feFuncG', 'feFuncB'].map((tag) => [tag, 'gamma', '1', '0.5', '0']));
    const ctx = fakeContext();
    frame.draw(ctx, video, 100, 178);
    assert.equal(ctx.calls.find((c) => c[0] === 'drawImage').at(-1), 'url(#camera-color-1)');
    assert.deepEqual(frame.getColor(), color);
  });

  it('값이 바뀌면 새 id의 필터로 바꾸고 이전 것은 지운다. 감마 1이면 감마 단계가 없다. 중립으로 돌리면 none', () => {
    const doc = fakeDocument();
    const frame = createCameraFrame({ doc, stageAspect: STAGE, settings: settingsOf({ brightness: 0.1 }) });
    assert.deepEqual(frame.setSettings(settingsOf({ brightness: 0.2 })), { geometry: false, color: true });
    const [svg] = doc.body.children;
    assert.equal(svg.children.length, 1);
    assert.equal(svg.children[0].attrs.id, 'camera-color-2');
    assert.equal(svg.children[0].children.length, 1, '감마 1: 색 행렬만');
    assert.equal(frame.getFilter(), 'url(#camera-color-2)');
    assert.deepEqual(frame.setSettings(settingsOf({ brightness: 0.2, mirror: false })), { geometry: true, color: false });
    assert.equal(frame.getFilter(), 'url(#camera-color-2)', '기하만 바뀌면 필터 그대로');
    frame.setSettings(settingsOf());
    assert.equal(frame.getFilter(), 'none');
    assert.equal(svg.children.length, 0);
  });

  it('문서에 createElementNS가 없으면(테스트·특수 환경) 필터 없이 그린다', () => {
    const frame = createCameraFrame({ doc: {}, stageAspect: STAGE, settings: settingsOf({ brightness: 0.3 }) });
    assert.equal(frame.getFilter(), 'none');
  });
});
