// 화면 필터 조절값 (17단계, config/screen.local.json, API /local-api/screen-settings, E "화면" 섹션).
// 카메라·결과 사진·인쇄의 조절값(effect.local.json)과 파일이 다르다. 형식:
//   { "version": 1, "enabled": true, "filter": { strength, size, boil, fps, grade, refineThreshold, previewScale, gallery } }
// 필터 정의·수치의 기준은 카메라 필터와 같은 검증된 번들(기본 제공판 filter-builtin.json 또는 적용한 판)이다.
// 값이 없으면 그 번들의 받은 기본값을 쓴다. 출력은 늘 컬러·유화 켬(화면 전체용). Node 테스트: test/config/screen-settings.test.mjs

import { config } from './config.js';
import { effectLimits, effectTunables, normalizeEffectSettings } from './effect-settings.js';
import { filterLimits, importedDefaults } from './filter-values.js';
import { SettingsSource } from './settings-file.js';

export const SCREEN_SETTINGS_VERSION = 1;
const FILE_KEYS = Object.freeze(['strength', 'size', 'boil', 'fps', 'grade', 'refineThreshold', 'previewScale', 'gallery']);

/** bundle의 받은 기본값으로 만든 화면 필터 설정 (출력 끔·유화 켬) */
export function defaultScreenFilter(bundle) {
  const limits = filterLimits(bundle, effectLimits);
  const base = normalizeEffectSettings(config.effect, config.effect, limits).settings;
  const imported = importedDefaults(bundle, base);
  return normalizeEffectSettings({ ...imported, outputMode: 'off', oil: true, previewScale: config.screen.previewScale }, config.effect, limits).settings;
}

export function defaultScreenSettings(bundle) {
  return Object.freeze({ enabled: config.screen.enabled, filter: defaultScreenFilter(bundle) });
}

/** 조절값을 기준값에 덮어 정규화한다 (출력·유화는 고정) */
export function normalizeScreenFilter(input, bundle) {
  const base = defaultScreenFilter(bundle);
  const limits = filterLimits(bundle, effectLimits);
  const merged = { ...base };
  for (const key of FILE_KEYS) {
    if (key === 'refineThreshold' || input?.[key] === undefined) continue;
    merged[key] = input[key];
  }
  if (Array.isArray(input?.refine)) merged.refine = input.refine;
  else if (Number.isFinite(input?.refineThreshold) && base.refine) merged.refine = [...base.refine.slice(0, 4), input.refineThreshold];
  return normalizeEffectSettings({ ...merged, outputMode: 'off', oil: true }, base, limits);
}

export function normalizeScreenSettings(input, bundle) {
  const { settings: filter, issues } = normalizeScreenFilter(input?.filter, bundle);
  const enabled = typeof input?.enabled === 'boolean' ? input.enabled : config.screen.enabled;
  return { settings: Object.freeze({ enabled, filter }), issues };
}

export function serializeScreenSettings(settings) {
  const tunables = effectTunables(settings.filter);
  const filter = Object.fromEntries(FILE_KEYS.filter((key) => key in tunables).map((key) => [key, tunables[key]]));
  return JSON.stringify({ version: SCREEN_SETTINGS_VERSION, enabled: settings.enabled, filter }, null, 2);
}

export const sameScreenSettings = (a, b) => serializeScreenSettings(a) === serializeScreenSettings(b);

/**
 * 시작할 때: 파일 → 기본값. 파일을 못 읽거나 형식이 틀려도 기본값으로 시작한다(화면 필터 때문에 촬영이 멈추지 않게).
 * @returns {Promise<{ settings: object, issues: string[], source: string, note: string }>}
 */
export async function loadInitialScreenSettings({ file, bundle }) {
  const defaults = () => defaultScreenSettings(bundle);
  let found;
  try {
    found = await file.read();
  } catch (error) {
    return { settings: defaults(), issues: [], source: SettingsSource.DEFAULTS, note: String(error?.message ?? error) };
  }
  if (!found.found) return { settings: defaults(), issues: [], source: SettingsSource.DEFAULTS, note: 'no file' };
  try {
    const parsed = JSON.parse(found.text);
    if (parsed?.version !== SCREEN_SETTINGS_VERSION) throw new Error(`version ${parsed?.version}`);
    const { settings, issues } = normalizeScreenSettings(parsed, bundle);
    return { settings, issues, source: SettingsSource.FILE, note: '' };
  } catch (error) {
    return { settings: defaults(), issues: [], source: SettingsSource.DEFAULTS, note: `invalid file: ${error?.message ?? error}` };
  }
}
