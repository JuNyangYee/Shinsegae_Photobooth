// 운영자 조절값 파일 (서버 config/presence.local.json, API /local-api/presence-settings).
// 시작할 때 불러오는 순서: 파일 → (파일이 없으면) localStorage에서 옮김 → 기본값.
// 값의 검증·정규화는 presence-settings.js가 맡는다.
// 효과 조절값 (5-2, config/effect.local.json, API /local-api/effect-settings)은 파일 → 기본값. localStorage는 쓰지 않는다.
// 카메라 설정 (9-1, config/camera.local.json, API /local-api/camera-settings)은 파일 → (없으면) 효과 파일의 좌우 반전을 옮김 → 기본값.
// 시간 설정 (10단계, config/timing.local.json, API /local-api/timing-settings)은 파일 → (없으면) 인식 파일의 시간 키를 옮김 → 기본값.
// Node 테스트: test/config/settings-file.test.mjs

import { migrateMirrorFromEffect, normalizeCameraSettings, parseStoredCameraSettings, serializeCameraSettings } from './camera-settings.js';
import { parseStoredEffectSettings } from './effect-settings.js';
import { extractLegacyTiming, parseStoredTimingSettings, serializeTimingSettings, timingFromLegacy } from './timing-settings.js';
import {
  loadPresenceSettings,
  parseStoredPresenceSettings,
  removeStoredPresenceSettings,
  serializePresenceSettings,
} from './presence-settings.js';

// 조절값 출처 (D 화면·조절 화면)
export const SettingsSource = Object.freeze({
  FILE: 'file', // 시작할 때 파일에서 읽음
  MIGRATED: 'migrated', // 파일이 없어 localStorage 값(인식)·효과 파일의 좌우 반전(카메라)을 파일로 옮김
  LOCAL_ONLY: 'localStorage', // localStorage 값을 쓰지만 파일로 옮기지 못함 (다음 시작에 다시 옮긴다)
  EFFECT_FILE_ONLY: 'effect file', // 카메라: 효과 파일의 좌우 반전을 쓰지만 카메라 파일로 옮기지 못함 (다음 시작에 다시 옮긴다)
  PRESENCE_FILE_ONLY: 'presence file', // 시간: 인식 파일의 옛 시간 키를 쓰지만 시간 파일로 옮기지 못함 (다음 시작에 다시 옮긴다)
  DEFAULTS: 'defaults', // 파일·localStorage 모두 없음, 또는 불러오기 실패·시간 초과
  SAVED: 'saved', // 이번 실행 중 파일에 저장함
});

/**
 * 서버 API 클라이언트. 쓰기에는 서버가 요구하는 헤더(X-Photobooth, JSON)를 붙인다.
 * @param {{ url: string, timeoutMs: number, fetch?: Function, timers?: { setTimeout: Function, clearTimeout: Function } }} options
 */
export function createSettingsFileClient({
  url, timeoutMs, fetch = (...args) => globalThis.fetch(...args), timers = globalThis,
}) {
  // 제한 시간은 응답 헤더가 아니라 본문을 다 읽을 때까지다(4단계 검수: 헤더만 오고 본문이 멈추면 끝나지 않았다).
  // 취소 신호는 fetch와 본문 읽기에 함께 걸리고, 본문 읽기가 신호를 무시해도 시간이 되면 기다림을 끝낸다.
  async function request(method, body) {
    const controller = new AbortController();
    let timedOut = false;
    let giveUp;
    const stopped = new Promise((resolve, reject) => { giveUp = reject; });
    stopped.catch(() => {}); // 시간이 되기 전에 끝나면 아무도 기다리지 않는다
    const timer = timers.setTimeout(() => {
      timedOut = true;
      controller.abort();
      giveUp(new Error('aborted'));
    }, timeoutMs);
    try {
      const response = await Promise.race([fetch(url, {
        method,
        cache: 'no-store',
        signal: controller.signal,
        headers: body === undefined ? {} : { 'Content-Type': 'application/json', 'X-Photobooth': '1' },
        body,
      }), stopped]);
      const text = await Promise.race([response.text(), stopped]);
      return { status: response.status, ok: response.ok, text };
    } catch (error) {
      if (timedOut) throw new Error(`timeout ${timeoutMs}ms`);
      throw new Error(error?.message ?? String(error));
    } finally {
      timers.clearTimeout(timer);
    }
  }

  return {
    /** @returns {Promise<{ found: boolean, text?: string }>} 파일이 없으면(404) found false. 그 밖의 실패는 예외 */
    async read() {
      const response = await request('GET');
      if (response.status === 404) return { found: false };
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return { found: true, text: response.text };
    },
    /** 실패하면 예외 (HTTP 상태와 서버가 준 이유) */
    async write(text) {
      const response = await request('PUT', text);
      if (!response.ok) {
        const reason = response.text.trim();
        throw new Error(`HTTP ${response.status}${reason ? ` (${reason})` : ''}`);
      }
    },
  };
}

/**
 * 시작할 때 조절값을 정한다. 예외를 던지지 않는다.
 * - 파일이 있으면 그 값 (형식이 잘못됐으면 기본값, 파일은 운영자가 다시 저장할 때까지 그대로).
 * - 파일이 없고(404) localStorage에 저장값이 있으면 파일로 옮기고, 옮긴 값을 다시 읽어 확인한 뒤 localStorage에서 지운다.
 * - 둘 다 없거나, 파일 읽기가 실패·시간 초과되면 기본값. 실패하면 옮기지 않는다(파일이 있는데 못 읽었을 수 있으므로).
 * @param {{ file: { read: Function, write: Function }, storage: Storage | undefined, defaults: object }} options
 * @returns {Promise<{ settings: object, issues: string[], source: string, note: string, legacyTiming: object | null }>}
 *   issues: 불러올 때 고친 내용, note: 출처 설명 (실패 이유 등),
 *   legacyTiming: 파일에 남은 9단계까지의 시간 키(검사 전 값, 10단계부터 시간 설정). 시간 파일에 아직 없으면 인식 섹션을 저장할 때 다시 붙인다
 */
export async function loadInitialPresenceSettings({ file, storage, defaults }) {
  const defaultsWith = (note, issues = []) => ({
    ...parseStoredPresenceSettings(null, defaults), issues, source: SettingsSource.DEFAULTS, note, legacyTiming: null,
  });

  let stored;
  try {
    stored = await file.read();
  } catch (error) {
    return defaultsWith(`file read failed: ${error?.message ?? error}`);
  }
  if (stored.found) {
    const parsed = parseStoredPresenceSettings(stored.text, defaults);
    if (parsed.source !== 'stored') return defaultsWith('file is invalid', parsed.issues);
    return { settings: parsed.settings, issues: parsed.issues, source: SettingsSource.FILE, note: '',
      legacyTiming: extractLegacyTiming(stored.text).legacy };
  }

  const local = loadPresenceSettings(storage, defaults);
  if (local.source !== 'stored') {
    return defaultsWith(local.issues.length > 0 ? `no file; localStorage unusable (${local.issues.join('; ')})` : 'no file');
  }
  const text = serializePresenceSettings(local.settings);
  try {
    await file.write(text);
    const check = await file.read();
    if (!check.found || check.text !== text) throw new Error('read-back mismatch');
  } catch (error) {
    return { settings: local.settings, issues: local.issues, source: SettingsSource.LOCAL_ONLY,
      note: `migration to file failed: ${error?.message ?? error}`, legacyTiming: null };
  }
  // 옮긴 뒤 localStorage를 지운다. 남겨 두면 파일을 일부러 지웠을 때(초기화) 옛 값이 말없이 다시 옮겨지기 때문이다.
  const removeError = removeStoredPresenceSettings(storage);
  return { settings: local.settings, issues: local.issues, source: SettingsSource.MIGRATED,
    note: removeError === null ? 'from localStorage (removed)' : `from localStorage (remove failed: ${removeError})`, legacyTiming: null };
}

/**
 * 시작할 때 효과 조절값을 정한다 (5-2). 파일 → 기본값. 예외를 던지지 않는다.
 * 파일이 없거나(404) 읽기가 실패·시간 초과되거나 형식이 잘못됐으면 기본값 (파일은 운영자가 다시 저장할 때까지 그대로).
 * @param {{ file: { read: Function }, defaults: object }} options defaults: config.effect
 * @returns {Promise<{ settings: object, issues: string[], source: string, note: string }>}
 */
export async function loadInitialEffectSettings({ file, defaults }) {
  const defaultsWith = (note, issues = []) => ({
    ...parseStoredEffectSettings(null, defaults), issues, source: SettingsSource.DEFAULTS, note,
  });
  let stored;
  try {
    stored = await file.read();
  } catch (error) {
    return defaultsWith(`file read failed: ${error?.message ?? error}`);
  }
  if (!stored.found) return defaultsWith('no file');
  const parsed = parseStoredEffectSettings(stored.text, defaults);
  if (parsed.source !== 'stored') return defaultsWith('file is invalid', parsed.issues);
  return { settings: parsed.settings, issues: parsed.issues, source: SettingsSource.FILE, note: '' };
}

/**
 * 시작할 때 카메라 설정을 정한다 (9-1). 예외를 던지지 않는다. 카메라를 열기 전에 부른다.
 * - 카메라 파일이 있으면 그 값 (형식이 잘못됐으면 기본값, 파일은 그대로).
 * - 없고(404) 효과 파일(effect.local.json)에 좌우 반전(mirror, 2026-10-26 ~ 9-1의 위치)이 있으면 그 값을 기본값에 얹어 카메라 파일로 옮기고
 *   (PUT → 다시 GET해 확인), 효과 파일에서는 그 키만 뺀다(다른 값은 바이트 그대로가 아니라 같은 내용으로 다시 쓴다).
 *   키를 빼는 이유: 남겨 두면 운영자가 카메라를 초기화하려고 카메라 파일을 지웠을 때 옛 반전 값이 말없이 다시 옮겨진다.
 *   카메라 파일 쓰기가 실패하면 이번엔 옮긴 값을 쓰고 효과 파일은 그대로 둔다(다음 시작에 다시 옮긴다).
 *   효과 파일에서 키를 빼지 못해도 카메라 파일은 이미 있으므로 다시 옮기지 않는다(그 키는 효과 쪽에서 쓰지 않는다).
 * - 둘 다 없거나 카메라 파일 읽기가 실패·시간 초과되면 기본값(옮기지 않는다: 파일이 있는데 못 읽었을 수 있다).
 * @param {{ file: { read: Function, write: Function }, effectFile: { read: Function, write: Function }, defaults: object }} options
 *   defaults: config.camera
 * @returns {Promise<{ settings: object, issues: string[], source: string, note: string }>}
 */
export async function loadInitialCameraSettings({ file, effectFile, defaults }) {
  const defaultsWith = (note, issues = []) => ({
    ...parseStoredCameraSettings(null, defaults), issues, source: SettingsSource.DEFAULTS, note,
  });
  let stored;
  try {
    stored = await file.read();
  } catch (error) {
    return defaultsWith(`file read failed: ${error?.message ?? error}`);
  }
  if (stored.found) {
    const parsed = parseStoredCameraSettings(stored.text, defaults);
    if (parsed.source !== 'stored') return defaultsWith('file is invalid', parsed.issues);
    return { settings: parsed.settings, issues: parsed.issues, source: SettingsSource.FILE, note: '' };
  }

  // 카메라 파일이 없다: 효과 파일의 좌우 반전을 옮긴다
  let effect;
  try {
    effect = await effectFile.read();
  } catch (error) {
    return defaultsWith(`no file; effect file read failed: ${error?.message ?? error}`);
  }
  const old = effect.found ? migrateMirrorFromEffect(effect.text) : { mirror: null };
  if (old.mirror === null) return defaultsWith('no file');
  const { settings } = normalizeCameraSettings({ ...defaults, mirror: old.mirror }, defaults);
  const text = serializeCameraSettings(settings);
  try {
    await file.write(text);
    const check = await file.read();
    if (!check.found || check.text !== text) throw new Error('read-back mismatch');
  } catch (error) {
    return { settings, issues: [], source: SettingsSource.EFFECT_FILE_ONLY,
      note: `mirror ${old.mirror ? 'on' : 'off'} from effect file; migration to camera file failed: ${error?.message ?? error}` };
  }
  let removed = 'removed from effect file';
  try {
    await effectFile.write(old.strippedText);
  } catch (error) {
    removed = `not removed from effect file: ${error?.message ?? error}`;
  }
  return { settings, issues: [], source: SettingsSource.MIGRATED, note: `mirror ${old.mirror ? 'on' : 'off'} from effect file (${removed})` };
}

/**
 * 시작할 때 시간 설정을 정한다 (10단계). 예외를 던지지 않는다.
 * - 시간 파일이 있으면 그 값 (형식이 잘못됐으면 기본값, 파일은 그대로). 인식 파일에 옛 시간 키가 남아 있으면 읽지 않고(무시),
 *   시간 파일이 올바를 때만 인식 파일에서 그 키를 뺀다(정리. 실패해도 해가 없고 다음 시작에 다시 한다).
 * - 없고(404) 인식 파일(presence.local.json)에 9단계까지의 시간 키(presentHoldMs·absentGraceMs·cameraRecovery)가 있으면 그 값을
 *   기본값에 얹어 시간 파일로 옮기고(PUT → 다시 GET해 확인), 확인된 뒤에만 인식 파일에서 그 키를 뺀다(다른 값은 그대로).
 *   키를 빼는 이유: 남겨 두면 운영자가 시간을 초기화하려고 시간 파일을 지웠을 때 옛 값이 말없이 다시 옮겨진다.
 *   시간 파일 쓰기·확인이 실패하면 이번엔 옮긴 값을 쓰고 인식 파일은 바이트 그대로 둔다(source 'presence file', 다음 시작에 다시 옮긴다).
 *   인식 파일에서 키를 빼지 못해도 시간 파일은 이미 있으므로 다시 옮기지 않는다(옛 키는 무시된다).
 * - 둘 다 없거나 시간 파일 읽기가 실패·시간 초과되면 기본값(옮기지 않는다: 파일이 있는데 못 읽었을 수 있다).
 * @param {{ file: { read: Function, write: Function }, presenceFile: { read: Function, write: Function }, defaults: object }} options
 *   defaults: config.timing
 * @returns {Promise<{ settings: object, issues: string[], source: string, note: string }>}
 */
export async function loadInitialTimingSettings({ file, presenceFile, defaults }) {
  const defaultsWith = (note, issues = []) => ({
    ...parseStoredTimingSettings(null, defaults), issues, source: SettingsSource.DEFAULTS, note,
  });
  let stored;
  try {
    stored = await file.read();
  } catch (error) {
    return defaultsWith(`file read failed: ${error?.message ?? error}`);
  }
  if (stored.found) {
    const parsed = parseStoredTimingSettings(stored.text, defaults);
    if (parsed.source !== 'stored') return defaultsWith('file is invalid', parsed.issues);
    const cleanup = await removeLegacyTiming(presenceFile);
    return { settings: parsed.settings, issues: parsed.issues, source: SettingsSource.FILE, note: cleanup };
  }

  // 시간 파일이 없다: 인식 파일의 옛 시간 키를 옮긴다
  let presence;
  try {
    presence = await presenceFile.read();
  } catch (error) {
    return defaultsWith(`no file; presence file read failed: ${error?.message ?? error}`);
  }
  const old = presence.found ? extractLegacyTiming(presence.text) : { legacy: null };
  if (old.legacy === null) return defaultsWith('no file');
  const { settings, issues } = timingFromLegacy(old.legacy, defaults);
  const keys = Object.keys(old.legacy).join(', ');
  const text = serializeTimingSettings(settings);
  try {
    await file.write(text);
    const check = await file.read();
    if (!check.found || check.text !== text) throw new Error('read-back mismatch');
  } catch (error) {
    return { settings, issues, source: SettingsSource.PRESENCE_FILE_ONLY,
      note: `${keys} from presence file; migration to timing file failed: ${error?.message ?? error}` };
  }
  let removed = 'removed from presence file';
  try {
    await presenceFile.write(old.strippedText);
  } catch (error) {
    removed = `not removed from presence file: ${error?.message ?? error}`;
  }
  return { settings, issues, source: SettingsSource.MIGRATED, note: `${keys} from presence file (${removed})` };
}

// 시간 파일이 있을 때 인식 파일에 남은 옛 시간 키를 뺀다 (옮긴 뒤 빼지 못했거나, 옮기기 실패 뒤 시간 섹션을 저장한 경우).
// 실패해도 옛 키는 읽지 않으므로 해가 없다. @returns {string} D 화면용 설명 (할 일이 없으면 '')
async function removeLegacyTiming(presenceFile) {
  try {
    const presence = await presenceFile.read();
    const old = presence.found ? extractLegacyTiming(presence.text) : { legacy: null };
    if (old.legacy === null) return '';
    await presenceFile.write(old.strippedText);
    return 'old timing keys removed from presence file';
  } catch (error) {
    return `old timing keys left in presence file (ignored): ${error?.message ?? error}`;
  }
}
