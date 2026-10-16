// 실행: npm test
import assert from 'node:assert/strict';
import { config } from '../../src/web/config/config.js';
import { loadInitialEffectSettings } from '../../src/web/config/settings-file.js';
import { describe, it } from 'node:test';

import { PRESENCE_STORAGE_KEY, serializePresenceSettings } from '../../src/web/config/presence-settings.js';
import { SettingsSource, createSettingsFileClient, loadInitialPresenceSettings } from '../../src/web/config/settings-file.js';
import { fakeClock, flush } from '../helpers.mjs';

const defaults = Object.freeze({
  region: Object.freeze({ x: 0.1, y: 0.1, width: 0.8, height: 0.8 }),
  minFaceHeight: 0.05, maxFaceHeight: 0.6, minScore: 0.7, presentHoldMs: 500, absentGraceMs: 1000,
});
const fileValue = { region: { x: 0.2, y: 0.2, width: 0.6, height: 0.6 }, minFaceHeight: 0.1, maxFaceHeight: 0.5,
  minScore: 0.8, presentHoldMs: 700, absentGraceMs: 1200 };
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
    const text = JSON.stringify({ version: 1, settings: { strength: 0.3, size: 1, boil: 0.2, fps: 12, grade: 0.5, refineThreshold: 0.3, previewScale: 0.5 } });
    const r = await loadInitialEffectSettings({ file: file(async () => ({ found: true, text })), defaults: config.effect });
    assert.equal(r.source, SettingsSource.FILE);
    assert.equal(r.settings.fps, 12);
    assert.deepEqual(r.settings.refine, [3.5, 3, 10, 0.6, 0.3]);
    assert.deepEqual(r.issues, []);
  });

  it('파일이 없으면 기본값 (no file), 읽기 실패·형식 오류도 기본값', async () => {
    const none = await loadInitialEffectSettings({ file: file(async () => ({ found: false })), defaults: config.effect });
    assert.equal(none.source, SettingsSource.DEFAULTS);
    assert.equal(none.note, 'no file');
    assert.equal(none.settings.fps, 24);
    const failed = await loadInitialEffectSettings({ file: file(async () => { throw new Error('timeout 3000ms'); }), defaults: config.effect });
    assert.equal(failed.note, 'file read failed: timeout 3000ms');
    const invalid = await loadInitialEffectSettings({ file: file(async () => ({ found: true, text: '{' })), defaults: config.effect });
    assert.equal(invalid.note, 'file is invalid');
    assert.match(invalid.issues[0], /not valid JSON/);
  });
});
