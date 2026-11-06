// 관람객 화면 장면 유화 (15단계, 가안): 정지 장면 그림 한 장을 기존 oil2f 렌더러로 한 번 칠해 RGBA 화소를 돌려준다.
// - 카메라 효과와 따로 논다: 별도 캔버스·WebGL 컨텍스트·렌더러를 만들어 한 번 그리고 바로 지운다(컨텍스트도 놓는다).
//   카메라 미리보기·결과·인쇄 데이터·감열지 1비트 경로, 운영자 필터 값·저장판·원격 업데이트와 설정을 나누지 않는다.
// - 필터: 저장소의 기본 제공판(config/filter-builtin.json, 읽기만)과 그 원본 기본값(importedDefaults)에 출력 끔(컬러)·유화 켬·
//   장면용 덮어쓰기(config.scene.paint.settings)를 얹는다. seed 고정이라 같은 장면이면 같은 그림이다.
// 매 프레임 그리지 않는다(장면을 읽을 때 한 번). ui/scene-plate.js의 paint로 main.js·demo.js가 넘긴다.

import { config } from '../config/config.js';
import { effectLimits, normalizeEffectSettings } from '../config/effect-settings.js';
import { validateBundle } from '../config/filter-source.js';
import { filterLimits, importedDefaults } from '../config/filter-values.js';
import { createOilRenderer } from './oil-renderer.js';

export const SCENE_FILTER_URL = '/config/filter-builtin.json';

/** 장면을 칠할 설정: 기본 제공판 원본 기본값 + 출력 끔·유화 켬·처리 해상도 1 + 장면용 덮어쓰기. 순수 함수 */
export function sceneOilSettings(bundle, overrides = {}) {
  const limits = filterLimits(bundle, effectLimits);
  const base = normalizeEffectSettings(config.effect, config.effect, limits).settings;
  const imported = importedDefaults(bundle, base);
  return normalizeEffectSettings({ ...imported, ...overrides, outputMode: 'off', oil: true, previewScale: 1 }, config.effect, limits).settings;
}

/**
 * @param {{ fetcher?: typeof fetch, createCanvas?: () => HTMLCanvasElement | OffscreenCanvas,
 *   paint?: { seed: number, settings: object } }} [options]
 * @returns {(source: TexImageSource, width: number, height: number) => Promise<Uint8ClampedArray>}
 */
export function createScenePainter({
  fetcher = fetch, createCanvas = () => new OffscreenCanvas(1, 1), paint = config.scene.paint,
} = {}) {
  return async (source, width, height) => {
    const bundle = validateBundle(await (await fetcher(SCENE_FILTER_URL, { cache: 'no-store' })).json());
    const settings = sceneOilSettings(bundle, paint.settings);
    const renderer = createOilRenderer({ canvas: createCanvas(), bundle });
    try {
      const { pixels } = renderer.render(source, { settings, width, height, seed: paint.seed, output: 'pixels' });
      return pixels;
    } finally {
      const { gl } = renderer;
      renderer.dispose();
      gl.getExtension('WEBGL_lose_context')?.loseContext();
    }
  };
}
