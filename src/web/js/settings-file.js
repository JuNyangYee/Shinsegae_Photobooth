// 운영자 조절값 파일 (서버 config/presence.local.json, API /local-api/presence-settings).
// 시작할 때 불러오는 순서: 파일 → (파일이 없으면) localStorage에서 옮김 → 기본값.
// 값의 검증·정규화는 presence-settings.js가 맡는다. Node 테스트: tests/settings-file.test.mjs

import {
  loadPresenceSettings,
  parseStoredPresenceSettings,
  removeStoredPresenceSettings,
  serializePresenceSettings,
} from './presence-settings.js';

// 조절값 출처 (D 화면·조절 화면)
export const SettingsSource = Object.freeze({
  FILE: 'file', // 시작할 때 파일에서 읽음
  MIGRATED: 'migrated', // 파일이 없어 localStorage 값을 파일로 옮김
  LOCAL_ONLY: 'localStorage', // localStorage 값을 쓰지만 파일로 옮기지 못함 (다음 시작에 다시 옮긴다)
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
  async function request(method, body) {
    const controller = new AbortController();
    const timer = timers.setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await fetch(url, {
        method,
        cache: 'no-store',
        signal: controller.signal,
        headers: body === undefined ? {} : { 'Content-Type': 'application/json', 'X-Photobooth': '1' },
        body,
      });
    } catch (error) {
      if (controller.signal.aborted) throw new Error(`timeout ${timeoutMs}ms`);
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
      return { found: true, text: await response.text() };
    },
    /** 실패하면 예외 (HTTP 상태와 서버가 준 이유) */
    async write(text) {
      const response = await request('PUT', text);
      if (!response.ok) {
        const reason = (await response.text().catch(() => '')).trim();
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
 * @returns {Promise<{ settings: object, issues: string[], source: string, note: string }>}
 *   issues: 불러올 때 고친 내용, note: 출처 설명 (실패 이유 등)
 */
export async function loadInitialPresenceSettings({ file, storage, defaults }) {
  const defaultsWith = (note, issues = []) => ({
    ...parseStoredPresenceSettings(null, defaults), issues, source: SettingsSource.DEFAULTS, note,
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
    return { settings: parsed.settings, issues: parsed.issues, source: SettingsSource.FILE, note: '' };
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
      note: `migration to file failed: ${error?.message ?? error}` };
  }
  // 옮긴 뒤 localStorage를 지운다. 남겨 두면 파일을 일부러 지웠을 때(초기화) 옛 값이 말없이 다시 옮겨지기 때문이다.
  const removeError = removeStoredPresenceSettings(storage);
  return { settings: local.settings, issues: local.issues, source: SettingsSource.MIGRATED,
    note: removeError === null ? 'from localStorage (removed)' : `from localStorage (remove failed: ${removeError})` };
}
