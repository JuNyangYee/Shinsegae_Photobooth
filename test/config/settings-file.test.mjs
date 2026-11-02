// 실행: npm test
import assert from 'node:assert/strict';
import { config } from '../../src/web/config/config.js';
import { normalizeCameraSettings, serializeCameraSettings } from '../../src/web/config/camera-settings.js';
import { loadInitialCameraSettings, loadInitialEffectSettings } from '../../src/web/config/settings-file.js';
import { describe, it } from 'node:test';

import { PRESENCE_STORAGE_KEY, serializePresenceSettings } from '../../src/web/config/presence-settings.js';
import { SettingsSource, createSettingsFileClient, loadInitialPresenceSettings } from '../../src/web/config/settings-file.js';
import { fakeClock, flush } from '../helpers.mjs';

const defaults = Object.freeze({
  region: Object.freeze({ x: 0.1, y: 0.1, width: 0.8, height: 0.8 }),
  minFaceHeight: 0.05, maxFaceHeight: 0.6, minScore: 0.7, presentHoldMs: 500, absentGraceMs: 1000,
  // 카메라 회복 시간 (9-1부터 인식 조절값 파일에 함께 둔다)
  cameraRecovery: Object.freeze({ retryIntervalMs: 3000, firstFrameTimeoutMs: 5000, stallTimeoutMs: 3000, staffNoticeMs: 30000 }),
});
const fileValue = { region: { x: 0.2, y: 0.2, width: 0.6, height: 0.6 }, minFaceHeight: 0.1, maxFaceHeight: 0.5,
  minScore: 0.8, presentHoldMs: 700, absentGraceMs: 1200, cameraRecovery: { ...defaults.cameraRecovery } };
const localValue = { ...fileValue, minScore: 0.9 };

function memoryStorage(initial = {}) {
  const data = new Map(Object.entries(initial));
  return {
    getItem: (key) => (data.has(key) ? data.get(key) : null),
    setItem: (key, value) => { data.set(key, String(value)); },
    removeItem: (key) => { data.delete(key); },
    data,
  };
}

// 서버 흉내: 파일 하나를 들고 GET·PUT에 답한다
function fakeFile({ text = null, failRead = null, failWrite = null } = {}) {
  const file = {
    text,
    writes: [],
    reads: 0,
    async read() {
      file.reads += 1;
      if (failRead) throw new Error(failRead);
      return file.text === null ? { found: false } : { found: true, text: file.text };
    },
    async write(value) {
      if (failWrite) throw new Error(failWrite);
      file.writes.push(value);
      file.text = value;
    },
  };
  return file;
}

describe('loadInitialPresenceSettings: 시작할 때 불러오는 순서', () => {
  it('1. 파일이 있으면 파일 값 (localStorage는 보지 않고 그대로 둔다)', async () => {
    const storage = memoryStorage({ [PRESENCE_STORAGE_KEY]: serializePresenceSettings(localValue) });
    const file = fakeFile({ text: serializePresenceSettings(fileValue) });
    const result = await loadInitialPresenceSettings({ file, storage, defaults });
    assert.equal(result.source, SettingsSource.FILE);
    assert.deepEqual(result.settings, fileValue);
    assert.equal(file.writes.length, 0);
    assert.ok(storage.data.has(PRESENCE_STORAGE_KEY));
  });

  it('2. 파일이 없고(404) localStorage가 있으면 파일로 옮기고, 다시 읽어 확인한 뒤 localStorage를 지운다', async () => {
    const storage = memoryStorage({ [PRESENCE_STORAGE_KEY]: serializePresenceSettings(localValue) });
    const file = fakeFile();
    const result = await loadInitialPresenceSettings({ file, storage, defaults });
    assert.equal(result.source, SettingsSource.MIGRATED);
    assert.equal(result.note, 'from localStorage (removed)');
    assert.deepEqual(result.settings, localValue);
    assert.deepEqual(file.writes, [serializePresenceSettings(localValue)]);
    assert.equal(file.reads, 2); // 처음 확인 + 옮긴 뒤 다시 읽기
    assert.equal(storage.data.has(PRESENCE_STORAGE_KEY), false);
    // 다음 시작은 파일에서
    const next = await loadInitialPresenceSettings({ file, storage, defaults });
    assert.equal(next.source, SettingsSource.FILE);
    assert.deepEqual(next.settings, localValue);
  });

  it('2-1. 옮기기(쓰기)가 실패하면 이번에는 localStorage 값을 쓰고, localStorage는 지우지 않는다', async () => {
    const storage = memoryStorage({ [PRESENCE_STORAGE_KEY]: serializePresenceSettings(localValue) });
    const file = fakeFile({ failWrite: 'HTTP 500' });
    const result = await loadInitialPresenceSettings({ file, storage, defaults });
    assert.equal(result.source, SettingsSource.LOCAL_ONLY);
    assert.match(result.note, /migration to file failed: HTTP 500/);
    assert.deepEqual(result.settings, localValue);
    assert.ok(storage.data.has(PRESENCE_STORAGE_KEY));
  });

  it('3. 둘 다 없으면 기본값 (no file). localStorage 값이 깨져 있어도 기본값이고 옮기지 않는다', async () => {
    const none = await loadInitialPresenceSettings({ file: fakeFile(), storage: memoryStorage(), defaults });
    assert.equal(none.source, SettingsSource.DEFAULTS);
    assert.equal(none.note, 'no file');
    assert.deepEqual(none.settings, defaults);
    const file = fakeFile();
    const broken = await loadInitialPresenceSettings({ file, storage: memoryStorage({ [PRESENCE_STORAGE_KEY]: '{oops' }), defaults });
    assert.equal(broken.source, SettingsSource.DEFAULTS);
    assert.match(broken.note, /localStorage unusable/);
    assert.equal(file.writes.length, 0);
    // 저장소 자체가 없는 환경
    assert.equal((await loadInitialPresenceSettings({ file: fakeFile(), storage: undefined, defaults })).source, SettingsSource.DEFAULTS);
  });

  it('파일 읽기가 실패하면 기본값이고, localStorage를 옮기지 않는다 (파일이 있는데 못 읽었을 수 있다)', async () => {
    const storage = memoryStorage({ [PRESENCE_STORAGE_KEY]: serializePresenceSettings(localValue) });
    const file = fakeFile({ failRead: 'timeout 3000ms' });
    const result = await loadInitialPresenceSettings({ file, storage, defaults });
    assert.equal(result.source, SettingsSource.DEFAULTS);
    assert.equal(result.note, 'file read failed: timeout 3000ms');
    assert.deepEqual(result.settings, defaults);
    assert.equal(file.writes.length, 0);
    assert.ok(storage.data.has(PRESENCE_STORAGE_KEY));
  });

  it('파일 내용이 잘못됐으면 기본값 (file is invalid). 파일은 덮어쓰지 않는다', async () => {
    const file = fakeFile({ text: '{"version": 2}' });
    const result = await loadInitialPresenceSettings({ file, storage: memoryStorage(), defaults });
    assert.equal(result.source, SettingsSource.DEFAULTS);
    assert.equal(result.note, 'file is invalid');
    assert.match(result.issues[0], /version/);
    assert.equal(file.writes.length, 0);
  });

  it('파일 값의 일부가 범위 밖이면 고쳐 쓰고 고친 내용을 알린다', async () => {
    const file = fakeFile({ text: serializePresenceSettings({ ...fileValue, minScore: 5 }) });
    const result = await loadInitialPresenceSettings({ file, storage: memoryStorage(), defaults });
    assert.equal(result.source, SettingsSource.FILE);
    assert.equal(result.settings.minScore, 1);
    assert.deepEqual(result.issues, ['minScore: 5 -> 1']);
  });
});

describe('createSettingsFileClient: 서버 API 요청', () => {
  function setup(respond) {
    const clock = fakeClock(0);
    const calls = [];
    const client = createSettingsFileClient({
      url: '/local-api/presence-settings', timeoutMs: 3000, timers: clock.timers,
      fetch: (url, init) => { calls.push({ url, init }); return respond(init); },
    });
    return { clock, calls, client };
  }
  const response = (status, text = '') => ({ status, ok: status >= 200 && status < 300, text: async () => text });

  it('GET: 200이면 내용, 404면 없음, 그 밖은 예외', async () => {
    assert.deepEqual(await setup(async () => response(200, '{"a":1}')).client.read(), { found: true, text: '{"a":1}' });
    assert.deepEqual(await setup(async () => response(404)).client.read(), { found: false });
    await assert.rejects(setup(async () => response(500)).client.read(), /HTTP 500/);
  });

  it('PUT: 서버가 요구하는 헤더(X-Photobooth, JSON)를 붙이고, 거절되면 이유를 담아 예외', async () => {
    const ok = setup(async () => response(204));
    await ok.client.write('{"version":1}');
    const { url, init } = ok.calls[0];
    assert.equal(url, '/local-api/presence-settings');
    assert.equal(init.method, 'PUT');
    assert.deepEqual(init.headers, { 'Content-Type': 'application/json', 'X-Photobooth': '1' });
    assert.equal(init.body, '{"version":1}');
    assert.equal(init.cache, 'no-store');
    await assert.rejects(setup(async () => response(413, '413 body larger than 16384 bytes\n')).client.write('x'),
      /HTTP 413 \(413 body larger than 16384 bytes\)/);
  });

  it('시간 초과: timeoutMs 안에 답이 없으면 요청을 끊고 timeout 예외', async () => {
    const t = setup((init) => new Promise((resolve, reject) => {
      init.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
    }));
    const pending = t.client.read();
    let settled = null;
    pending.then(() => { settled = 'ok'; }, (error) => { settled = error.message; });
    t.clock.advance(2999);
    await flush();
    assert.equal(settled, null);
    t.clock.advance(1);
    await flush();
    assert.equal(settled, 'timeout 3000ms');
  });

  it('헤더는 왔지만 본문이 멈추면 본문까지 포함해 timeoutMs에서 끝난다 (4단계 검수 3)', async () => {
    for (const method of ['read', 'write']) {
      // 본문 읽기가 취소 신호를 무시하는 경우까지: 신호와 관계없이 시간이 되면 끝나야 한다
      const t = setup(async () => ({ status: method === 'read' ? 200 : 500, ok: method === 'read', text: () => new Promise(() => {}) }));
      const pending = method === 'read' ? t.client.read() : t.client.write('{}');
      let settled = null;
      pending.then(() => { settled = 'ok'; }, (error) => { settled = error.message; });
      t.clock.advance(2999);
      await flush();
      assert.equal(settled, null, method);
      t.clock.advance(1);
      await flush();
      assert.equal(settled, 'timeout 3000ms', method);
      assert.equal(t.calls[0].init.signal.aborted, true, `${method}: 요청과 본문 읽기를 취소한다`);
    }
  });

  it('본문이 제때 오면 타이머를 지운다', async () => {
    const t = setup(async () => response(200, '{"a":1}'));
    assert.deepEqual(await t.client.read(), { found: true, text: '{"a":1}' });
    assert.equal(t.clock.pending.size, 0);
  });

  it('시간 초과는 불러오기에서 기본값으로 이어진다', async () => {
    const t = setup((init) => new Promise((resolve, reject) => {
      init.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
    }));
    const pending = loadInitialPresenceSettings({ file: t.client, storage: memoryStorage(), defaults });
    t.clock.advance(3000);
    const result = await pending;
    assert.equal(result.source, SettingsSource.DEFAULTS);
    assert.equal(result.note, 'file read failed: timeout 3000ms');
  });
});

describe('loadInitialEffectSettings (효과 조절값, 5-2): 파일 → 기본값', () => {
  const file = (read) => ({ read, write: () => { throw new Error('must not write'); } });

  it('파일이 있으면 그 값', async () => {
    const text = JSON.stringify({ version: 1, settings: { strength: 0.2, size: 1, boil: 0.2, fps: 10, grade: 0.5, refineThreshold: 0.4, previewScale: 0.75,
      outputMode: 'gray', dither: 'bayer', brightness: -0.1, contrast: 1.2, gamma: 0.9, paperDots: 384, bwStyle: 'texture', bwTexture: 1.5, lineSpacing: 3 } });
    const r = await loadInitialEffectSettings({ file: file(async () => ({ found: true, text })), defaults: config.effect });
    assert.equal(r.source, SettingsSource.FILE);
    assert.equal(r.settings.fps, 10);
    assert.deepEqual(r.settings.refine, [3.5, 3, 10, 0.6, 0.4]);
    assert.deepEqual([r.settings.outputMode, r.settings.dither, r.settings.paperDots, r.settings.gamma], ['gray', 'bayer', 384, 0.9]);
    assert.deepEqual([r.settings.bwStyle, r.settings.bwTexture, r.settings.lineSpacing], ['texture', 1.5, 3]);
    assert.deepEqual(r.issues, []);
  });

  it('5-2 파일(출력 단계 값 없음)도 파일 값으로 읽고, 출력 단계는 기본값(8단계부터 회색조 유화)으로 채워 알린다 (6-1)', async () => {
    const text = JSON.stringify({ version: 1, settings: { strength: 0.3, size: 1, boil: 0.2, fps: 10, grade: 0.5, refineThreshold: 0.3, previewScale: 0.75 } });
    const r = await loadInitialEffectSettings({ file: file(async () => ({ found: true, text })), defaults: config.effect });
    assert.equal(r.source, SettingsSource.FILE);
    assert.equal(r.settings.fps, 10);
    assert.equal(r.settings.outputMode, 'gray-oil');
    assert.equal(r.issues.length, 9); // 출력 단계 6개(6-1) + 흑백 스타일 3개(7-1)
  });

  it('파일이 없으면 기본값 (no file), 읽기 실패·형식 오류도 기본값', async () => {
    const none = await loadInitialEffectSettings({ file: file(async () => ({ found: false })), defaults: config.effect });
    assert.equal(none.source, SettingsSource.DEFAULTS);
    assert.equal(none.note, 'no file');
    assert.equal(none.settings.fps, 12);
    const failed = await loadInitialEffectSettings({ file: file(async () => { throw new Error('timeout 3000ms'); }), defaults: config.effect });
    assert.equal(failed.note, 'file read failed: timeout 3000ms');
    const invalid = await loadInitialEffectSettings({ file: file(async () => ({ found: true, text: '{' })), defaults: config.effect });
    assert.equal(invalid.note, 'file is invalid');
    assert.match(invalid.issues[0], /not valid JSON/);
  });
});

describe('loadInitialCameraSettings (카메라 설정, 9-1): 카메라 파일 → 효과 파일의 좌우 반전 옮기기 → 기본값', () => {
  const effectWith = (mirror) => JSON.stringify({ version: 1, settings: { strength: 0.2, fps: 10, ...(mirror === undefined ? {} : { mirror }) } }, null, 2);

  it('카메라 파일이 있으면 그 값 (효과 파일은 읽지도 고치지도 않는다)', async () => {
    const settings = normalizeCameraSettings({ ...config.camera, rotation: 90, mirror: false }, config.camera).settings;
    const file = fakeFile({ text: serializeCameraSettings(settings) });
    const effectFile = fakeFile({ text: effectWith(true) });
    const r = await loadInitialCameraSettings({ file, effectFile, defaults: config.camera });
    assert.equal(r.source, SettingsSource.FILE);
    assert.deepEqual([r.settings.rotation, r.settings.mirror], [90, false]);
    assert.deepEqual([effectFile.reads, effectFile.writes.length, file.writes.length], [0, 0, 0]);
  });

  it('카메라 파일이 없고 효과 파일에 반전이 있으면: 카메라 파일로 옮기고(다시 읽어 확인) 효과 파일에서는 그 키만 뺀다', async () => {
    const file = fakeFile();
    const effectFile = fakeFile({ text: effectWith(false) });
    const r = await loadInitialCameraSettings({ file, effectFile, defaults: config.camera });
    assert.equal(r.source, SettingsSource.MIGRATED);
    assert.equal(r.note, 'mirror off from effect file (removed from effect file)');
    assert.equal(r.settings.mirror, false);
    assert.deepEqual(file.writes, [serializeCameraSettings(r.settings)]);
    assert.equal(file.reads, 2);
    assert.deepEqual(JSON.parse(effectFile.text), { version: 1, settings: { strength: 0.2, fps: 10 } });
    // 다음 시작은 카메라 파일에서, 효과 파일을 다시 보지 않는다
    const next = await loadInitialCameraSettings({ file, effectFile, defaults: config.camera });
    assert.deepEqual([next.source, next.settings.mirror, effectFile.writes.length], [SettingsSource.FILE, false, 1]);
  });

  it('카메라 파일을 지워도(초기화) 옛 반전이 다시 옮겨지지 않는다 (효과 파일에서 뺐으므로)', async () => {
    const file = fakeFile();
    const effectFile = fakeFile({ text: effectWith(false) });
    await loadInitialCameraSettings({ file, effectFile, defaults: config.camera });
    file.text = null; // 운영자가 camera.local.json을 지움
    const r = await loadInitialCameraSettings({ file, effectFile, defaults: config.camera });
    assert.deepEqual([r.source, r.note, r.settings.mirror], [SettingsSource.DEFAULTS, 'no file', true]);
  });

  it('카메라 파일 쓰기가 실패하면 이번엔 옮긴 값을 쓰고 효과 파일은 그대로 (다음 시작에 다시 옮긴다)', async () => {
    const effectFile = fakeFile({ text: effectWith(false) });
    const r = await loadInitialCameraSettings({ file: fakeFile({ failWrite: 'HTTP 500' }), effectFile, defaults: config.camera });
    assert.equal(r.source, SettingsSource.EFFECT_FILE_ONLY);
    assert.match(r.note, /migration to camera file failed: HTTP 500/);
    assert.equal(r.settings.mirror, false);
    assert.equal(effectFile.writes.length, 0);
  });

  it('원자성 (9단계 검수 2): 카메라 파일이 확인되지 않으면(쓰기 실패·다시 읽은 내용이 다름) 효과 파일은 바이트 그대로 mirror를 남긴다', async () => {
    for (const camera of [
      fakeFile({ failWrite: 'HTTP 500' }),
      // 쓰기는 됐다고 했지만 다시 읽으면 다른 내용 (다른 프로그램이 덮어씀 등)
      Object.assign(fakeFile(), { async write(value) { this.writes.push(value); this.text = '{"version":1,"settings":{}}'; } }),
    ]) {
      const original = effectWith(false);
      const effectFile = fakeFile({ text: original });
      const r = await loadInitialCameraSettings({ file: camera, effectFile, defaults: config.camera });
      assert.equal(r.source, SettingsSource.EFFECT_FILE_ONLY);
      assert.deepEqual([effectFile.writes.length, effectFile.text], [0, original]);
      assert.equal(JSON.parse(effectFile.text).settings.mirror, false);
    }
  });

  it('효과 파일에서 키를 빼지 못해도 옮긴 것으로 본다 (카메라 파일이 있으니 다시 옮기지 않는다)', async () => {
    const r = await loadInitialCameraSettings({ file: fakeFile(), effectFile: fakeFile({ text: effectWith(true), failWrite: 'HTTP 413' }), defaults: config.camera });
    assert.equal(r.source, SettingsSource.MIGRATED);
    assert.equal(r.note, 'mirror on from effect file (not removed from effect file: HTTP 413)');
  });

  it('둘 다 없거나 효과 파일에 반전이 없으면 기본값 (no file), 아무것도 쓰지 않는다', async () => {
    for (const effectFile of [fakeFile(), fakeFile({ text: effectWith(undefined) }), fakeFile({ text: '{broken' })]) {
      const file = fakeFile();
      const r = await loadInitialCameraSettings({ file, effectFile, defaults: config.camera });
      assert.deepEqual([r.source, r.note, r.settings.mirror], [SettingsSource.DEFAULTS, 'no file', true]);
      assert.deepEqual([file.writes.length, effectFile.writes.length], [0, 0]);
    }
  });

  it('카메라 파일 읽기 실패면 기본값이고 옮기지 않는다 (파일이 있는데 못 읽었을 수 있다). 효과 파일 읽기 실패도 기본값', async () => {
    const effectFile = fakeFile({ text: effectWith(false) });
    const r = await loadInitialCameraSettings({ file: fakeFile({ failRead: 'timeout 3000ms' }), effectFile, defaults: config.camera });
    assert.deepEqual([r.source, r.note, effectFile.reads], [SettingsSource.DEFAULTS, 'file read failed: timeout 3000ms', 0]);
    const e = await loadInitialCameraSettings({ file: fakeFile(), effectFile: fakeFile({ failRead: 'HTTP 500' }), defaults: config.camera });
    assert.deepEqual([e.source, e.note], [SettingsSource.DEFAULTS, 'no file; effect file read failed: HTTP 500']);
  });

  it('카메라 파일 형식이 틀리면 기본값 (file is invalid), 값 일부가 틀리면 고쳐 쓰고 알린다', async () => {
    const invalid = await loadInitialCameraSettings({ file: fakeFile({ text: '{' }), effectFile: fakeFile(), defaults: config.camera });
    assert.deepEqual([invalid.source, invalid.note], [SettingsSource.DEFAULTS, 'file is invalid']);
    const text = JSON.stringify({ version: 1, settings: { ...config.camera, zoom: 9 } });
    const adjusted = await loadInitialCameraSettings({ file: fakeFile({ text }), effectFile: fakeFile(), defaults: config.camera });
    assert.deepEqual([adjusted.source, adjusted.settings.zoom, adjusted.issues], [SettingsSource.FILE, 4, ['zoom: 9 -> 4']]);
  });
});
