// 실행: npm test
// tools/browser-check-lib.mjs: 조절값 파일 백업·복원, CDP 요청 제한 시간과 연결 끊김 (4단계 검수 1·2)
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

import { backupFile, createCdpSession, restoreFile } from '../tools/browser-check-lib.mjs';
import { fakeClock, flush } from './helpers.mjs';

const root = mkdtempSync(join(tmpdir(), 'photobooth-lib-test-'));
after(() => rmSync(root, { recursive: true, force: true }));

describe('backupFile / restoreFile: 원본을 파일 시스템으로 직접 되돌린다', () => {
  it('원본이 잘못된 JSON이고 16KB를 넘어도 바이트 그대로 되돌린다 (서버 API는 이 원본을 거절한다)', () => {
    const dir = join(root, 'a', 'config');
    mkdirSync(dir, { recursive: true });
    const path = join(dir, 'presence.local.json');
    const original = Buffer.concat([Buffer.from('{"version": 1, "broken": '), Buffer.alloc(20000, 0x78), Buffer.from([0xff, 0xfe])]);
    writeFileSync(path, original);
    const backup = backupFile(path);
    writeFileSync(path, '{"version":1,"settings":{"minScore":0.71}}'); // 시험 값
    const result = restoreFile(backup);
    assert.equal(result.ok, true, result.detail);
    assert.ok(readFileSync(path).equals(original));
    assert.deepEqual(readdirSync(dir), ['presence.local.json']); // 임시 파일이 남지 않음
    assert.deepEqual(restoreFile(backup), { ok: true, detail: 'unchanged' }); // 다시 불러도 된다
  });

  it('원본이 없었으면 파일과, 도구가 만든 빈 폴더를 지운다', () => {
    const dir = join(root, 'b', 'config');
    const path = join(dir, 'presence.local.json');
    const backup = backupFile(path);
    mkdirSync(dir, { recursive: true });
    writeFileSync(path, '{}');
    assert.equal(restoreFile(backup).ok, true);
    assert.equal(existsSync(path), false);
    assert.equal(existsSync(dir), false);
  });

  it('원본이 없었어도 원래 있던 폴더와 다른 파일은 그대로 둔다', () => {
    const dir = join(root, 'c', 'config');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'other.txt'), 'keep');
    const path = join(dir, 'presence.local.json');
    const backup = backupFile(path);
    writeFileSync(path, '{}');
    assert.equal(restoreFile(backup).ok, true);
    assert.deepEqual(readdirSync(dir), ['other.txt']);
  });

  it('시험 중에 파일이 지워졌어도 원본을 다시 만든다', () => {
    const dir = join(root, 'd');
    mkdirSync(dir, { recursive: true });
    const path = join(dir, 'presence.local.json');
    writeFileSync(path, 'original');
    const backup = backupFile(path);
    rmSync(path);
    assert.equal(restoreFile(backup).ok, true);
    assert.equal(readFileSync(path, 'utf8'), 'original');
  });
});

describe('createCdpSession: 제한 시간과 연결 끊김', () => {
  function fakeSocket() {
    return { sent: [], send(text) { this.sent.push(JSON.parse(text)); }, close() { this.closedByTool = true; } };
  }

  it('응답이 오면 결과, 오류 응답이면 실패, 이벤트는 구독자에게', async () => {
    const ws = fakeSocket();
    const cdp = createCdpSession(ws, { timeoutMs: 1000, timers: fakeClock().timers });
    const events = [];
    cdp.on((data) => events.push(data.method));
    const ok = cdp.send('Runtime.evaluate', { expression: '1' });
    const bad = cdp.send('Page.navigate');
    ws.onmessage({ data: JSON.stringify({ id: ws.sent[0].id, result: { value: 1 } }) });
    ws.onmessage({ data: JSON.stringify({ id: ws.sent[1].id, error: { message: 'nope' } }) });
    ws.onmessage({ data: JSON.stringify({ method: 'Log.entryAdded', params: {} }) });
    assert.deepEqual(await ok, { value: 1 });
    await assert.rejects(bad, /Page.navigate: nope/);
    assert.deepEqual(events, ['Log.entryAdded']);
  });

  it('연결이 끊기면 기다리던 요청을 모두 바로 실패시키고, 이후 요청도 바로 실패한다', async () => {
    const ws = fakeSocket();
    const cdp = createCdpSession(ws, { timeoutMs: 15000, timers: fakeClock().timers });
    const pending = [cdp.send('Runtime.evaluate'), cdp.send('Input.dispatchKeyEvent')];
    let settled = 0;
    pending.forEach((p) => p.catch(() => { settled += 1; }));
    ws.onclose();
    await flush();
    assert.equal(settled, 2);
    await assert.rejects(pending[0], /CDP connection closed/);
    await assert.rejects(cdp.send('Page.reload'), /Page.reload: CDP connection closed/);
    assert.equal(cdp.closed(), 'CDP connection closed');
  });

  it('응답이 오지 않으면 제한 시간에 실패한다 (연결은 살아 있어도)', async () => {
    const clock = fakeClock();
    const ws = fakeSocket();
    const cdp = createCdpSession(ws, { timeoutMs: 15000, timers: clock.timers });
    let result = null;
    cdp.send('Runtime.evaluate').catch((error) => { result = error.message; });
    cdp.send('Runtime.evaluate', {}, { timeout: 60000 }).catch(() => {});
    clock.advance(14999);
    await flush();
    assert.equal(result, null);
    clock.advance(1);
    await flush();
    assert.equal(result, 'Runtime.evaluate: no answer within 15000ms');
    assert.equal(clock.pending.size, 1); // 긴 제한 시간을 준 요청만 남는다
  });

  it('오류 이벤트도 끊김으로 본다. close()는 기다리던 요청을 실패시키고 소켓을 닫는다', async () => {
    const ws = fakeSocket();
    const cdp = createCdpSession(ws, { timeoutMs: 1000, timers: fakeClock().timers });
    const pending = cdp.send('Runtime.evaluate');
    ws.onerror();
    await assert.rejects(pending, /CDP connection error/);
    const ws2 = fakeSocket();
    const cdp2 = createCdpSession(ws2, { timeoutMs: 1000, timers: fakeClock().timers });
    const pending2 = cdp2.send('Runtime.evaluate');
    cdp2.close();
    await assert.rejects(pending2, /closed by tool/);
    assert.equal(ws2.closedByTool, true);
  });
});
