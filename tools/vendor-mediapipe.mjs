// Copies the MediaPipe tasks-vision runtime from node_modules into lib/ and
// downloads the pinned model and license. Development PC only: the site PC
// uses the committed lib/ files and needs neither Node nor network access.
//
// Usage: npm install && npm run vendor:mediapipe
//
// Re-running gives the same result: lib/mediapipe/tasks-vision/ is cleared
// and refilled, and downloads are verified against the SHA-256 values below
// (a file already in place with the right hash is kept, not downloaded again).

import { createHash } from 'node:crypto';
import { copyFile, mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const packageDir = join(repoRoot, 'node_modules', '@mediapipe', 'tasks-vision');
const libDir = join(repoRoot, 'lib', 'mediapipe');
const runtimeDir = join(libDir, 'tasks-vision');
const modelsDir = join(libDir, 'models');

// Runtime files only. FilesetResolver.forVisionTasks() picks
// vision_wasm_internal.* when WebAssembly SIMD is available and
// vision_wasm_nosimd_internal.* otherwise. The *_module_* variant is only
// used with forVisionTasks(path, true) and is not copied.
const RUNTIME_FILES = [
  'vision_bundle.mjs',
  'wasm/vision_wasm_internal.js',
  'wasm/vision_wasm_internal.wasm',
  'wasm/vision_wasm_nosimd_internal.js',
  'wasm/vision_wasm_nosimd_internal.wasm',
];

// The npm package ships no LICENSE file, so the license comes from the
// official repository at the commit tagged v1.1.1. Update the URL and hash
// together with the package version.
const DOWNLOADS = [
  {
    dest: join(runtimeDir, 'LICENSE'),
    url: 'https://raw.githubusercontent.com/google-ai-edge/mediapipe/50505c8312c7eacb1bd411cecdc4cc9fd08d53cb/LICENSE',
    sha256: '8707eef0533987efc5b155d64761eeb6e20793f50b9bd1a68dad1cf4719d0ed8',
  },
  {
    dest: join(modelsDir, 'blaze_face_short_range.tflite'),
    url: 'https://storage.googleapis.com/mediapipe-models/face_detector/blaze_face_short_range/float16/1/blaze_face_short_range.tflite',
    sha256: 'b4578f35940bf5a1a655214a1cce5cab13eba73c1297cd78e1a04c2380b0152f',
  },
];

function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

function show(file) {
  return relative(repoRoot, file).replaceAll('\\', '/');
}

async function readIfExists(file) {
  try {
    return await readFile(file);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

async function checkInstalledVersion() {
  const ownPackage = JSON.parse(await readFile(join(repoRoot, 'package.json'), 'utf8'));
  const wanted = ownPackage.devDependencies?.['@mediapipe/tasks-vision'];
  if (!/^\d+\.\d+\.\d+$/.test(wanted ?? '')) {
    throw new Error(`package.json must pin @mediapipe/tasks-vision to an exact version (found "${wanted}").`);
  }
  const installedJson = await readIfExists(join(packageDir, 'package.json'));
  if (installedJson === null) {
    throw new Error('node_modules/@mediapipe/tasks-vision is missing. Run "npm install" first.');
  }
  const installed = JSON.parse(installedJson.toString('utf8')).version;
  if (installed !== wanted) {
    throw new Error(`Installed @mediapipe/tasks-vision is ${installed}, package.json pins ${wanted}. Run "npm install".`);
  }
  return installed;
}

async function copyRuntime() {
  await rm(runtimeDir, { recursive: true, force: true });
  for (const name of RUNTIME_FILES) {
    const target = join(runtimeDir, name);
    await mkdir(dirname(target), { recursive: true });
    await copyFile(join(packageDir, name), target);
  }
}

async function download({ dest, url, sha256: expected }) {
  const existing = await readIfExists(dest);
  if (existing !== null && sha256(existing) === expected) {
    return 'kept';
  }
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Download failed (${response.status}): ${url}`);
  }
  const body = Buffer.from(await response.arrayBuffer());
  const actual = sha256(body);
  if (actual !== expected) {
    throw new Error(`SHA-256 mismatch for ${url}\n  expected ${expected}\n  actual   ${actual}`);
  }
  await mkdir(dirname(dest), { recursive: true });
  const temp = `${dest}.download`;
  await writeFile(temp, body);
  await rename(temp, dest);
  return 'downloaded';
}

// Remove anything in models/ that this script does not manage.
async function pruneModels() {
  const managed = new Set(DOWNLOADS.map((item) => item.dest));
  const entries = await readdir(modelsDir, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    const file = join(modelsDir, entry.name);
    if (!managed.has(file)) {
      await rm(file, { recursive: true, force: true });
    }
  }
}

async function listFiles(dir) {
  const result = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const file = join(dir, entry.name);
    if (entry.isDirectory()) {
      result.push(...(await listFiles(file)));
    } else {
      result.push(file);
    }
  }
  return result.sort();
}

const version = await checkInstalledVersion();
await copyRuntime();
await pruneModels();
for (const item of DOWNLOADS) {
  const result = await download(item);
  console.log(`${result.padEnd(10)} ${show(item.dest)}`);
}

let total = 0;
console.log(`\n@mediapipe/tasks-vision ${version} -> ${show(libDir)}`);
for (const file of await listFiles(libDir)) {
  const { size } = await stat(file);
  total += size;
  console.log(`${String(size).padStart(10)}  ${show(file)}`);
}
console.log(`${String(total).padStart(10)}  total bytes`);
