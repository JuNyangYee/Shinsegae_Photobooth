// 실행: npm test
// 카메라 장치 선택·해상도 요청·다시 열기 (9-1): camera.js pickCamera, camera-monitor.js setRequest·listDevices·회복 시간 읽기.
// 브라우저 전역(window·navigator·document·HTMLVideoElement)은 이 파일 안에서만 흉내 낸다. 타이머는 node:test mock.timers.
import assert from 'node:assert/strict';
import { after, afterEach, beforeEach, describe, it, mock } from 'node:test';

import { CameraSelection, pickCamera, trackCapabilities } from '../../src/web/camera/camera.js';
import { CameraStatus, createCameraMonitor } from '../../src/web/camera/camera-monitor.js';

const flush = async (n = 5) => { for (let i = 0; i < n; i += 1) await new Promise((resolve) => setImmediate(resolve)); };
const device = (label, deviceId) => ({ kind: 'videoinput', label, deviceId });

describe('pickCamera: 장치 라벨(정확히 같음) → 우선 라벨(OBS, 포함) → 기본', () => {
  const devices = [device('Integrated Camera', 'a'), device('OBS Virtual Camera', 'b'), device('USB Cam (046d:082d)', 'c')];
  it('설정의 장치 라벨과 정확히 같은 장치가 먼저 (앞뒤 공백·대소문자 무시)', () => {
    assert.deepEqual(pickCamera(devices, { deviceLabel: ' usb cam (046D:082D) ', preferredLabel: 'OBS Virtual Camera' }),
      { device: devices[2], selection: CameraSelection.DEVICE });
  });
  it('라벨 일부만 같으면 장치 라벨로 보지 않는다 (OBS 규칙으로)', () => {
    assert.equal(pickCamera(devices, { deviceLabel: 'USB Cam', preferredLabel: 'OBS Virtual Camera' }).selection, CameraSelection.PREFERRED);
  });
  it('장치 라벨이 비었거나 없으면 OBS(포함), 그것도 없으면 기본(null)', () => {
    assert.deepEqual(pickCamera(devices, { deviceLabel: '', preferredLabel: 'obs virtual' }), { device: devices[1], selection: CameraSelection.PREFERRED });
    assert.deepEqual(pickCamera([devices[0]], { deviceLabel: 'Gone', preferredLabel: 'OBS' }), { device: null, selection: CameraSelection.DEFAULT });
  });
  it('trackCapabilities: 가로·세로·fps 범위만, 없으면 null', () => {
    assert.deepEqual(trackCapabilities({ getCapabilities: () => ({ width: { min: 1, max: 1920 }, height: { min: 1, max: 1080 }, frameRate: { max: 30 }, zoom: {} }) }),
      { width: { min: 1, max: 1920 }, height: { min: 1, max: 1080 }, frameRate: { min: 0, max: 30 } });
    assert.equal(trackCapabilities({}), null);
    assert.equal(trackCapabilities({ getCapabilities: () => { throw new Error('no'); } }), null);
  });
});

describe('createCameraMonitor: 장치·해상도 요청과 다시 열기 (9-1)', () => {
  let env;
  const saved = {};

  function install() {
    const devices = [device('Integrated Camera', 'a'), device('OBS Virtual Camera', 'b'), device('USB Cam', 'c')];
    const opened = []; // getUserMedia 요청 { deviceId, width, height } 와 그 트랙
    const listeners = new Map();
    let failNext = null;
    const mediaDevices = {
      enumerateDevices: async () => [...devices],
      addEventListener: (type, fn) => listeners.set(type, fn),
      async getUserMedia({ video }) {
        if (failNext) { const e = new Error('busy'); e.name = failNext; failNext = null; throw e; }
        const id = video.deviceId?.exact ?? 'a';
        const label = devices.find((d) => d.deviceId === id)?.label ?? '';
        const track = {
          label, stopped: false,
          getSettings: () => ({ deviceId: id, width: video.width?.ideal, height: video.height?.ideal }),
          getCapabilities: () => ({ width: { min: 1, max: 1920 }, height: { min: 1, max: 1080 }, frameRate: { min: 1, max: 30 } }),
          stop() { track.stopped = true; },
          addEventListener() {},
        };
        opened.push({ deviceId: id, width: video.width?.ideal, height: video.height?.ideal, track });
        return { getVideoTracks: () => [track], getTracks: () => [track] };
      },
    };
    const frameCallbacks = new Map();
    let nextId = 1;
    const video = {
      srcObject: null, videoWidth: 1920, videoHeight: 1080,
      play: () => Promise.resolve(),
      requestVideoFrameCallback(cb) { const id = nextId++; frameCallbacks.set(id, cb); return id; },
      cancelVideoFrameCallback(id) { frameCallbacks.delete(id); },
      /** 새 프레임 하나가 화면에 올라간다 */
      present() { const list = [...frameCallbacks.values()]; frameCallbacks.clear(); list.forEach((cb) => cb()); },
    };
    for (const key of ['window', 'navigator', 'document', 'HTMLVideoElement']) saved[key] = Object.getOwnPropertyDescriptor(globalThis, key);
    const define = (key, value) => Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
    define('window', { isSecureContext: true });
    define('navigator', { mediaDevices, permissions: { query: async () => { throw new Error('unsupported'); } } });
    define('document', { hidden: false });
    function HTMLVideoElement() {}
    HTMLVideoElement.prototype.requestVideoFrameCallback = () => {};
    HTMLVideoElement.prototype.cancelVideoFrameCallback = () => {};
    define('HTMLVideoElement', HTMLVideoElement);
    return {
      devices, opened, video, listeners,
      fail: (name) => { failNext = name; },
      async ready() { await flush(); video.present(); await flush(); },
    };
  }

  beforeEach(() => {
    mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
    env = install();
  });
  afterEach(() => {
    mock.timers.reset();
    for (const [key, desc] of Object.entries(saved)) {
      if (desc) Object.defineProperty(globalThis, key, desc);
      else delete globalThis[key];
    }
  });
  after(() => mock.timers.reset());

  const recovery = { retryIntervalMs: 3000, firstFrameTimeoutMs: 5000, stallTimeoutMs: 3000 };
  const quietLog = { warn() {}, clear() {} };
  const create = (request, rec = recovery) => createCameraMonitor({
    video: env.video, preferredLabel: 'OBS Virtual Camera', request, recovery: rec, log: quietLog,
  });

  it('설정의 장치 라벨로 열고, 해상도는 ideal로 요청한다. 실제 트랙 범위(getCapabilities)를 상태에 담는다', async () => {
    const camera = create({ deviceLabel: 'USB Cam', idealResolution: { width: 2160, height: 3840 } });
    camera.start();
    await env.ready();
    const s = camera.getState();
    assert.deepEqual([s.status, s.selection, s.label], [CameraStatus.READY, 'device', 'USB Cam']);
    assert.deepEqual(env.opened.map(({ deviceId, width, height }) => [deviceId, width, height]), [['c', 2160, 3840]]);
    assert.deepEqual(s.capabilities, { width: { min: 1, max: 1920 }, height: { min: 1, max: 1080 }, frameRate: { min: 1, max: 30 } });
  });

  it('setRequest: 같으면 아무것도 하지 않고, 장치·해상도가 바뀌면 스트림을 닫고 다시 연다 (그동안 ready 아님)', async () => {
    const camera = create({ deviceLabel: 'USB Cam', idealResolution: { width: 2160, height: 3840 } });
    camera.start();
    await env.ready();
    assert.equal(camera.setRequest({ deviceLabel: 'USB Cam', idealResolution: { width: 2160, height: 3840 } }), false);
    assert.equal(env.opened.length, 1);
    const states = [];
    camera.subscribe((s) => states.push(s.status));
    assert.equal(camera.setRequest({ deviceLabel: '', idealResolution: { width: 3840, height: 2160 } }), true);
    assert.equal(camera.getState().status, CameraStatus.STARTING);
    assert.equal(camera.getState().reason, 'camera-settings');
    assert.equal(env.opened[0].track.stopped, true, '이전 스트림을 닫았다');
    await env.ready();
    assert.deepEqual(env.opened.at(-1).deviceId, 'b', '장치 라벨이 비면 OBS 규칙');
    assert.deepEqual([env.opened.at(-1).width, env.opened.at(-1).height], [3840, 2160]);
    assert.equal(camera.getState().selection, 'preferred');
    assert.equal(camera.getState().status, CameraStatus.READY);
    assert.ok(states.includes(CameraStatus.STARTING));
    assert.deepEqual(camera.getRequest(), { deviceLabel: '', idealResolution: { width: 3840, height: 2160 } });
  });

  it('시작 전 setRequest는 저장만 하고 열지 않는다 (시작할 때 그 값으로)', async () => {
    const camera = create({ deviceLabel: '', idealResolution: { width: 2160, height: 3840 } });
    assert.equal(camera.setRequest({ deviceLabel: 'USB Cam', idealResolution: { width: 1280, height: 720 } }), false);
    assert.equal(env.opened.length, 0);
    camera.start();
    await env.ready();
    assert.deepEqual(env.opened.map(({ deviceId, width }) => [deviceId, width]), [['c', 1280]]);
  });

  it('설정의 장치가 없으면 OBS로 대신 열고, 그 장치가 나타나면(devicechange) 바꾼다', async () => {
    const usb = env.devices.splice(2, 1)[0];
    const camera = create({ deviceLabel: 'USB Cam', idealResolution: null });
    camera.start();
    await env.ready();
    assert.equal(camera.getState().selection, 'preferred');
    env.devices.push(usb);
    env.listeners.get('devicechange')();
    mock.timers.tick(500); // 0.5초 묶음
    await flush();
    assert.equal(camera.getState().reason, 'switch-to-preferred');
    await env.ready();
    assert.deepEqual([camera.getState().selection, env.opened.at(-1).deviceId], ['device', 'c']);
  });

  it('listDevices: 장치 목록과 지금 쓰는 장치 표시 (9-2 운영자 화면용)', async () => {
    const camera = create({ deviceLabel: 'USB Cam', idealResolution: null });
    camera.start();
    await env.ready();
    assert.deepEqual(await camera.listDevices(), [
      { label: 'Integrated Camera', deviceId: 'a', current: false },
      { label: 'OBS Virtual Camera', deviceId: 'b', current: false },
      { label: 'USB Cam', deviceId: 'c', current: true },
    ]);
  });

  it('회복 시간을 함수로 주면 쓸 때마다 지금 값을 읽는다 (시간 설정 cameraRecovery)', async () => {
    const live = { ...recovery, retryIntervalMs: 3000 };
    const camera = create({ deviceLabel: '', idealResolution: null }, () => live);
    env.fail('NotReadableError');
    camera.start();
    await flush();
    assert.equal(camera.getState().status, CameraStatus.UNAVAILABLE);
    const attempts = camera.getState().attempts;
    live.retryIntervalMs = 8000; // 이미 걸린 재시도는 3초 그대로
    mock.timers.tick(3000);
    await env.ready();
    assert.equal(camera.getState().attempts, attempts + 1);
    assert.equal(camera.getState().status, CameraStatus.READY);
  });
});
