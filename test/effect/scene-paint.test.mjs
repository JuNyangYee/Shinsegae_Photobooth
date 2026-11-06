import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { config } from '../../src/web/config/config.js';
import { validateBundle } from '../../src/web/config/filter-source.js';
import { sceneOilSettings } from '../../src/web/effect/scene-paint.js';

const bundle = validateBundle(JSON.parse(readFileSync(new URL('../../src/web/config/filter-builtin.json', import.meta.url), 'utf8')));

describe('scene-paint: 장면 유화 설정 (15단계)', () => {
  it('기본 제공판 원본 기본값에 출력 끔·유화 켬·처리 해상도 1을 얹는다 (카메라 저장값·흑백 모드와 무관)', () => {
    const s = sceneOilSettings(bundle, config.scene.paint.settings);
    assert.deepEqual([s.outputMode, s.oil, s.previewScale], ['off', true, 1]);
    const strength = bundle.controls.find((c) => c.id === 'state.strength').default;
    assert.equal(s.strength, strength);
  });

  it('장면용 덮어쓰기는 범위 안에서 반영되고 출력 모드는 늘 끔', () => {
    const s = sceneOilSettings(bundle, { strength: 0.5, outputMode: 'thermal' });
    assert.deepEqual([s.strength, s.outputMode], [0.5, 'off']);
  });
});
