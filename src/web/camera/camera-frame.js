// 카메라 처리 경로 (9-1)의 2D 캔버스 쪽: 카메라 원본을 색 보정·반전·회전·확대·이동해 9:16 화면 영역 캔버스에 그린다.
// 감지 입력(vision/presence-monitor.js), 캡처(capture.js), 원본 미리보기(raw-preview.js)가 모두 이 draw()를 쓴다.
// 효과 셰이더는 같은 설정·같은 계산(core/camera-view.js)의 셰이더용 값을 쓴다 (effect/effect-preview.js).
// 설정은 여기 한 곳에 있다: 소비자는 그리는 순간 getSettings()·getView()로 읽는다 (캡처는 셔터 순간).
//
// 색 보정은 문서 안 SVG 필터(feColorMatrix → feComponentTransfer gamma, color-interpolation-filters sRGB)를 ctx.filter = url(#…)로
// 건다. 값이 바뀌면 새 id의 필터를 만들고 이전 것을 지운다 — 같은 url 문자열로는 캔버스가 바뀐 필터를 다시 읽는다는 보장이 없다.
// 중립이면 필터를 걸지 않는다('none'). Node 테스트: test/camera/camera-frame.test.mjs

import {
  cameraColorKey, cameraColorMatrix, cameraGeometryKey, canvasTransform, computeCameraView, svgColorMatrixValues,
} from '../core/camera-view.js';

const SVG_NS = 'http://www.w3.org/2000/svg';

/**
 * @param {{ doc?: Document, stageAspect: number, settings: object }} options settings: 정규화된 카메라 설정 (config/camera-settings.js)
 *   doc: SVG 필터를 붙일 문서. createElementNS가 없으면(테스트) 색 보정 필터를 만들지 않는다
 */
export function createCameraFrame({ doc = globalThis.document, stageAspect, settings: initialSettings }) {
  let settings = initialSettings;
  let color = cameraColorMatrix(settings);
  let filterCss = 'none';
  let filterVersion = 0;
  let svg = null;
  let viewCache = null; // { key, view }

  function updateFilter() {
    svg?.replaceChildren();
    if (color.identity || typeof doc?.createElementNS !== 'function') {
      filterCss = 'none';
      return;
    }
    if (!svg) {
      svg = doc.createElementNS(SVG_NS, 'svg');
      svg.setAttribute('width', '0');
      svg.setAttribute('height', '0');
      svg.setAttribute('aria-hidden', 'true');
      svg.setAttribute('class', 'camera-filter');
      doc.body.append(svg);
    }
    filterVersion += 1;
    const id = `camera-color-${filterVersion}`;
    const filter = doc.createElementNS(SVG_NS, 'filter');
    filter.setAttribute('id', id);
    filter.setAttribute('color-interpolation-filters', 'sRGB');
    const matrix = doc.createElementNS(SVG_NS, 'feColorMatrix');
    matrix.setAttribute('type', 'matrix');
    matrix.setAttribute('values', svgColorMatrixValues(color));
    filter.append(matrix);
    if (color.exponent !== 1) {
      const transfer = doc.createElementNS(SVG_NS, 'feComponentTransfer');
      for (const channel of ['feFuncR', 'feFuncG', 'feFuncB']) {
        const fn = doc.createElementNS(SVG_NS, channel);
        fn.setAttribute('type', 'gamma');
        fn.setAttribute('amplitude', '1');
        fn.setAttribute('exponent', String(color.exponent));
        fn.setAttribute('offset', '0');
        transfer.append(fn);
      }
      filter.append(transfer);
    }
    svg.append(filter);
    filterCss = `url(#${id})`;
  }

  updateFilter();

  /** 영상 크기에 맞는 변환 (같은 크기·같은 설정이면 같은 객체) */
  function getView(videoWidth, videoHeight) {
    const key = `${videoWidth}x${videoHeight} ${cameraGeometryKey(settings)}`;
    if (viewCache?.key !== key) viewCache = { key, view: computeCameraView({ videoWidth, videoHeight, stageAspect, camera: settings }) };
    return viewCache.view;
  }

  return {
    getSettings: () => settings,
    /**
     * 설정을 바꾼다. 다음 그림부터 쓴다.
     * @returns {{ geometry: boolean, color: boolean }} 바뀐 부분 (인식은 geometry가 바뀌면 처음부터 다시 잰다)
     */
    setSettings(next) {
      const geometry = cameraGeometryKey(next) !== cameraGeometryKey(settings);
      const colorChanged = cameraColorKey(next) !== cameraColorKey(settings);
      settings = next;
      if (colorChanged) {
        color = cameraColorMatrix(settings);
        updateFilter();
      }
      return { geometry, color: colorChanged };
    },
    getView,
    /** 지금 색 보정의 계수 (core/camera-view.js cameraColorMatrix) */
    getColor: () => color,
    /** 2D 캔버스 ctx.filter 값 ('none' 또는 url(#camera-color-N)) */
    getFilter: () => filterCss,
    /**
     * source(영상)를 ctx의 (0, 0, width, height)에 9:16 화면 영역으로 그린다. 먼저 검게 칠한 뒤 그린다(회전 가장자리의 반투명 화소가
     * 이전 그림과 섞이지 않게). 영상이 없으면 그리지 않고 null.
     * @returns {object | null} 쓴 변환 (core/camera-view.js computeCameraView)
     */
    draw(ctx, source, width, height) {
      const view = getView(source.videoWidth, source.videoHeight);
      if (view === null) return null;
      ctx.save();
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.fillStyle = '#000';
      ctx.fillRect(0, 0, width, height);
      ctx.setTransform(...canvasTransform(view, width, height));
      ctx.filter = filterCss;
      ctx.drawImage(source, 0, 0);
      ctx.restore();
      return view;
    },
  };
}
