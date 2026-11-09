import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { validateBundle } from '../../src/web/config/filter-source.js';
import {
  defaultScreenSettings, loadInitialScreenSettings, normalizeScreenSettings, sameScreenSettings, serializeScreenSettings,
} from '../../src/web/config/screen-settings.js';

const bundle = validateBundle(JSON.parse(readFileSync(new URL('../../src/web/config/filter-builtin.json', import.meta.url), 'utf8')));

describe('screen-settings (17단계)', () => {
  it('기본값: 켬, 번들의 받은 기본값, 출력 끔·유화 켬', () => {
    const s = defaultScreenSettings(bundle);
    assert.equal(s.enabled, true);
    assert.deepEqual([s.filter.outputMode, s.filter.oil, s.filter.previewScale], ['off', true, 0.75]);
    assert.equal(s.filter.fps, bundle.controls.find((c) => c.id === 'state.fps').default);
  });

  it('왕복: 저장 형식을 읽으면 같은 값이고 출력 모드는 파일에 없다', () => {
    const s = normalizeScreenSettings({ enabled: false, filter: { previewScale: 0.5, fps: 10 } }, bundle).settings;
    const text = serializeScreenSettings(s);
    assert.ok(!text.includes('outputMode'));
    const back = normalizeScreenSettings(JSON.parse(text), bundle).settings;
    assert.ok(sameScreenSettings(s, back));
    assert.deepEqual([back.enabled, back.filter.previewScale, back.filter.fps, back.filter.outputMode], [false, 0.5, 10, 'off']);
  });

  it('파일에 출력 모드·유화 끔을 넣어도 화면 필터는 컬러·유화 켬으로 고정', () => {
    const s = normalizeScreenSettings({ filter: { outputMode: 'thermal', oil: false } }, bundle).settings;
    assert.deepEqual([s.filter.outputMode, s.filter.oil], ['off', true]);
  });

  it('불러오기: 없음·손상·읽기 실패는 기본값, 파일은 파일 값', async () => {
    const read = (fn) => ({ read: fn });
    assert.equal((await loadInitialScreenSettings({ file: read(async () => ({ found: false })), bundle })).note, 'no file');
    const broken = await loadInitialScreenSettings({ file: read(async () => ({ found: true, text: '{' })), bundle });
    assert.match(broken.note, /invalid file/);
    assert.equal(broken.settings.enabled, true);
    const failed = await loadInitialScreenSettings({ file: read(async () => { throw new Error('timeout'); }), bundle });
    assert.equal(failed.note, 'timeout');
    const ok = await loadInitialScreenSettings({ file: read(async () => ({ found: true, text: JSON.stringify({ version: 1, enabled: false, filter: {} }) })), bundle });
    assert.deepEqual([ok.source, ok.settings.enabled], ['file', false]);
  });
});
