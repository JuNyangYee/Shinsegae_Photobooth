// tools/browser-check.mjs의 부품 중 Node 테스트로 확인하는 것 (개발 PC 전용). Node 테스트: test/tools/browser-check-lib.test.mjs

import { existsSync, readFileSync, readdirSync, renameSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

// ---------- 파일 백업·복원 ----------

/**
 * 파일의 지금 상태를 기억한다: 바이트 그대로, 또는 "없음". 폴더가 있었는지도 기억한다.
 * 내용은 해석하지 않는다(잘못된 JSON·큰 파일도 그대로 되돌리기 위해서다).
 */
export function backupFile(path) {
  const existed = existsSync(path);
  return Object.freeze({ path, existed, bytes: existed ? readFileSync(path) : null, dirExisted: existsSync(dirname(path)) });
}

/**
 * 기억한 상태로 되돌린다. 서버 API를 거치지 않고 파일 시스템으로 직접 한다(API는 16KB·JSON 검사로 원본을 거절할 수 있다).
 * 있던 파일: 같은 폴더 임시 파일에 쓰고 rename으로 바꾼다(원자적). 없던 파일: 지우고, 도구가 만든 빈 폴더도 지운다.
 * 여러 번 불러도 된다. 예외를 던지지 않는다.
 * @returns {{ ok: boolean, detail: string }}
 */
export function restoreFile(backup) {
  const { path, existed, bytes, dirExisted } = backup;
  try {
    if (existed) {
      if (existsSync(path) && readFileSync(path).equals(bytes)) return { ok: true, detail: 'unchanged' };
      const temp = join(dirname(path), `.${Date.now()}-${process.pid}.restore.tmp`);
      writeFileSync(temp, bytes);
      try {
        renameSync(temp, path);
      } finally {
        if (existsSync(temp)) unlinkSync(temp);
      }
      const ok = readFileSync(path).equals(bytes);
      return { ok, detail: ok ? `restored ${bytes.length} bytes` : 'restored bytes differ' };
    }
    if (existsSync(path)) unlinkSync(path);
    const dir = dirname(path);
    if (!dirExisted && existsSync(dir) && readdirSync(dir).length === 0) rmdirSync(dir);
    return { ok: !existsSync(path), detail: 'removed (did not exist before)' };
  } catch (error) {
    return { ok: false, detail: `restore failed: ${error.message}` };
  }
}

// ---------- CDP 연결 ----------

/**
 * WebSocket 위의 CDP 요청·응답. 요청마다 제한 시간이 있고, 연결이 닫히거나 오류가 나면
 * 기다리던 요청을 모두 실패시키고 이후 요청도 바로 실패시킨다(4단계 검수: 끊기면 끝나지 않았다).
 * @param {{ send: Function, close?: Function, onmessage: any, onclose: any, onerror: any }} ws 열린 WebSocket
 * @param {{ timeoutMs?: number, timers?: { setTimeout: Function, clearTimeout: Function } }} [options]
 */
export function createCdpSession(ws, { timeoutMs = 15000, timers = globalThis } = {}) {
  let nextId = 1;
  let closedReason = null;
  const waiting = new Map();
  const listeners = new Set();

  function failAll(reason) {
    if (closedReason) return;
    closedReason = reason;
    for (const { rejectCall, timer, method } of waiting.values()) {
      timers.clearTimeout(timer);
      rejectCall(new Error(`${method}: ${reason}`));
    }
    waiting.clear();
  }

  ws.onmessage = (message) => {
    let data;
    try {
      data = JSON.parse(message.data);
    } catch {
      return;
    }
    if (data.id && waiting.has(data.id)) {
      const { resolveCall, rejectCall, timer, method } = waiting.get(data.id);
      waiting.delete(data.id);
      timers.clearTimeout(timer);
      if (data.error) rejectCall(new Error(`${method}: ${data.error.message}`));
      else resolveCall(data.result);
      return;
    }
    listeners.forEach((listener) => listener(data));
  };
  ws.onclose = () => failAll('CDP connection closed');
  ws.onerror = () => failAll('CDP connection error');

  return {
    /** 응답을 기다린다. 제한 시간(기본 timeoutMs)을 넘기거나 연결이 끊기면 실패한다. */
    send(method, params = {}, { timeout = timeoutMs } = {}) {
      if (closedReason) return Promise.reject(new Error(`${method}: ${closedReason}`));
      const id = nextId;
      nextId += 1;
      return new Promise((resolveCall, rejectCall) => {
        const timer = timers.setTimeout(() => {
          waiting.delete(id);
          rejectCall(new Error(`${method}: no answer within ${timeout}ms`));
        }, timeout);
        waiting.set(id, { resolveCall, rejectCall, timer, method });
        try {
          ws.send(JSON.stringify({ id, method, params }));
        } catch (error) {
          waiting.delete(id);
          timers.clearTimeout(timer);
          rejectCall(new Error(`${method}: ${error.message}`));
        }
      });
    },
    on(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    /** 끊겼으면 이유, 아니면 null */
    closed: () => closedReason,
    close() {
      failAll('CDP connection closed by tool');
      try { ws.close?.(); } catch { /* 이미 닫힘 */ }
    },
  };
}
