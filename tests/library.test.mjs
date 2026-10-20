import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { transformSync } from 'esbuild';
import { chromium } from 'playwright-chromium';

// Exercise the actual functions without importing index.ts's browser startup,
// filesystem database, or download loop. No account/session data is used.
const source = await readFile(new URL('../index.ts', import.meta.url), 'utf8');
const start = source.indexOf('const login =');
const end = source.indexOf('const downloadFile =');
assert(start >= 0 && end > start, 'Cannot locate the upstream library functions');
const code = transformSync(source.slice(start, end), { loader: 'ts', target: 'es2022' }).code;
function functions(db = { data: { saved: [], finished: [] }, write: async () => {} }, cfg = { checkall: false }) {
  return new Function('db', 'cfg', 'console', `${code}; return { login, updateLibrary };`)(db, cfg, { log() {}, error() {} });
}

let browser;
before(async () => { browser = await chromium.launch({ headless: true }); });
after(async () => { await browser?.close(); });

async function withPage(body, callback) {
  const context = await browser.newContext();
  const page = await context.newPage();
  page.setDefaultTimeout(300);
  await context.route('**/*', route => new URL(route.request().url()).hostname === 'www.blinkist.com'
    ? route.fulfill({ contentType: 'text/html', body }) : route.abort());
  try { await callback(page); } finally { await context.close(); }
}

test('login accepts the current Saved h1 without a legacy h3', async () => {
  await withPage('<h1>Saved</h1>', async page => {
    await functions().login(page);
    assert.equal(new URL(page.url()).pathname, '/en/app/library/saved');
  });
});

function card(slug, { legacy = false, title = 'Example book', author = 'Example Author' } = {}) {
  const attribute = legacy ? 'data-test-id' : 'data-testid';
  return `<a href="/app/books/${slug}" aria-label="${title}" ${attribute}="${legacy ? 'book-card' : 'content-item-card'}">
    <img src="https://images.example.test/cover.png">
    <h5 ${attribute}="title">${title}</h5>
    <div ${attribute}="subtitle">${author}</div>
    <div ${attribute}="description">Example subtitle</div>
    <div ${attribute}="content-card-info" class="text-mid-grey text-caption mt-2"><div>20 min</div><div>4.1</div></div>
  </a>`;
}

test('library imports current data-testid cards without a paragraph counter', async () => {
  const db = { data: { saved: [], finished: [] }, writes: 0, async write() { this.writes++; } };
  await withPage(`<h1>Saved</h1><div>2 of 2 titles</div>${card('example-de')}
    <a href="/app/episodes/episode" data-testid="content-item-card">Not a book</a>`, async page => {
    await functions(db).updateLibrary(page);
  });
  assert.equal(db.data.saved.length, 1);
  assert.deepEqual(db.data.saved[0], {
    id: 'example-de', title: 'Example book', author: 'Example Author',
    description: 'Example subtitle', duration: 20, rating: 4.1,
    url: 'https://www.blinkist.com/app/books/example-de', img: 'https://images.example.test/cover.png',
  });
  assert.equal(db.writes, 1);
});

test('library waits for asynchronously rendered cards rather than saving an empty list', async () => {
  const db = { data: { saved: [], finished: [] }, write: async () => {} };
  const html = `<h1>Saved</h1><main></main><script>
    setTimeout(() => { document.querySelector('main').innerHTML = ${JSON.stringify(card('delayed-de'))}; }, 150);
  </script>`;
  await withPage(html, page => functions(db).updateLibrary(page));
  assert.equal(db.data.saved.length, 1);
  assert.equal(db.data.saved[0].id, 'delayed-de');
});

test('library accepts an explicit zero-of-zero title count', async () => {
  const db = { data: { saved: [], finished: [] }, writes: 0, async write() { this.writes++; } };
  await withPage('<h1>Saved</h1><div>0 of 0 titles</div>', page => functions(db).updateLibrary(page));
  assert.deepEqual(db.data.saved, []);
  assert.equal(db.writes, 1);
});

test('legacy Saved headings and data-test-id book cards remain supported', async () => {
  const db = { data: { saved: [], finished: [] }, write: async () => {} };
  await withPage(`<h3>Saved</h3>${card('legacy-en', { legacy: true })}`, async page => {
    await functions(db).login(page);
    await functions(db).updateLibrary(page);
  });
  assert.equal(db.data.saved[0].id, 'legacy-en');
});

test('pagination follows changed card identities even if the counter is unchanged', async () => {
  const db = { data: { saved: [], finished: [] }, write: async () => {} };
  const html = `<h1>Saved</h1><div>2 of 2 titles</div><main>${card('first-en')}</main>
    <button id="next">Next</button><script>
      document.querySelector('#next').onclick = () => {
        document.querySelector('main').innerHTML = ${JSON.stringify(card('second-de'))};
        document.querySelector('#next').disabled = true;
      };
    </script>`;
  await withPage(html, page => functions(db).updateLibrary(page));
  assert.deepEqual(db.data.saved.map(book => book.id), ['second-de', 'first-en']);
});

test('unchanged pagination times out instead of hanging or writing a partial list', async () => {
  const db = { data: { saved: [], finished: [] }, writes: 0, async write() { this.writes++; } };
  await withPage(`<h1>Saved</h1>${card('unchanged-en')}<button>Next</button>`, async page => {
    await assert.rejects(functions(db).updateLibrary(page), /Timeout/);
  });
  assert.deepEqual(db.data.saved, []);
  assert.equal(db.writes, 0);
});

test('finished imports still exclude books that are already in saved', async () => {
  const db = { data: { saved: [{ id: 'already-saved-de' }], finished: [] }, write: async () => {} };
  await withPage(`<h1>Finished</h1>${card('already-saved-de')}${card('new-finished-en')}`, async page => {
    await functions(db).updateLibrary(page, 'finished');
  });
  assert.deepEqual(db.data.finished.map(book => book.id), ['new-finished-en']);
});
