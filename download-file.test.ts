import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { downloadFile } from './download-file.js';

async function fixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'blinkist-download-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return { directory, target: join(directory, 'audio.m4a') };
}

test('preserves complete response bytes and leaves no partial', async t => {
  const { directory, target } = await fixture(t);
  const bytes = Buffer.from([0, 255, 1, 128, 7]);
  const mocked = t.mock.method(globalThis, 'fetch', async () =>
    new Response(bytes, { headers: { 'content-length': String(bytes.length) } }));
  await downloadFile('https://example.invalid/audio', target);
  assert.deepEqual(await readFile(target), bytes);
  assert.deepEqual(await readdir(directory), ['audio.m4a']);
  assert.equal(new Headers(mocked.mock.calls[0].arguments[1]?.headers).get('Accept-Encoding'), 'identity');
});

test('HTTP failures preserve a prior complete destination', async t => {
  const { directory, target } = await fixture(t);
  await writeFile(target, 'original');
  t.mock.method(globalThis, 'fetch', async () => new Response('missing', { status: 404 }));
  await assert.rejects(downloadFile('https://example.invalid/audio', target), /HTTP 404/);
  assert.equal(await readFile(target, 'utf8'), 'original');
  assert.deepEqual(await readdir(directory), ['audio.m4a']);
});

test('incomplete transfers preserve a prior complete destination', async t => {
  const { directory, target } = await fixture(t);
  await writeFile(target, 'original');
  t.mock.method(globalThis, 'fetch', async () => new Response('short', { headers: { 'content-length': '999' } }));
  await assert.rejects(downloadFile('https://example.invalid/audio', target), /incomplete/);
  assert.equal(await readFile(target, 'utf8'), 'original');
  assert.deepEqual(await readdir(directory), ['audio.m4a']);
});

test('empty responses are not published', async t => {
  const { directory, target } = await fixture(t);
  t.mock.method(globalThis, 'fetch', async () => new Response(''));
  await assert.rejects(downloadFile('https://example.invalid/audio', target), /empty/);
  assert.deepEqual(await readdir(directory), []);
});

test('fetch errors do not disclose a signed source', async t => {
  const { directory, target } = await fixture(t);
  const source = 'https://example.invalid/audio?verify=synthetic-private';
  t.mock.method(globalThis, 'fetch', async () => { throw new Error(source); });
  await assert.rejects(downloadFile(source, target), error => {
    assert.equal((error as Error).message, 'File transfer failed');
    assert.equal((error as Error).cause, undefined);
    return true;
  });
  assert.deepEqual(await readdir(directory), []);
});

test('a stream interruption is not published', async t => {
  const { directory, target } = await fixture(t);
  const stream = new ReadableStream({ start(controller) { controller.error(new Error('interrupted')); } });
  t.mock.method(globalThis, 'fetch', async () => new Response(stream));
  await assert.rejects(downloadFile('https://example.invalid/audio', target), /File transfer failed/);
  assert.deepEqual(await readdir(directory), []);
});

test('decoded responses do not compare encoded length with decoded bytes', async t => {
  const { target } = await fixture(t);
  t.mock.method(globalThis, 'fetch', async () => new Response('decoded', {
    headers: { 'content-length': '30', 'content-encoding': 'gzip' },
  }));
  await downloadFile('https://example.invalid/audio', target);
  assert.equal(await readFile(target, 'utf8'), 'decoded');
});
