// The local Artifact harness's document store (test/harness/store.mjs): the
// db contract's path grammar, writes, queries and access rules, checked
// against the rules the app publishes with. No browser; the harness's own
// Chrome check is test/harness/selftest.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store, DbError, splitPath, checkRules, LIMITS } from './harness/store.mjs';
import { startHarness, APP_RULES } from './harness/server.mjs';

const owner = { level: 'owner', uid: 'u_owner' };
const editor = { level: 'admin', uid: 'u_editor' };
const contrib = { level: 'interact', uid: 'u_contrib' };
const viewer = { level: 'view', uid: 'u_viewer' };
const signedOut = { level: 'none', uid: null };

const refused = (fn) => assert.throws(fn, (e) => e instanceof DbError && e.code === 'invalid_argument');
const missing = (store, path, who) => assert.equal(store.get(path, who).exists, false, `${path} should look missing`);
const visible = (store, path, who) => assert.equal(store.get(path, who).exists, true, `${path} should be visible`);

test('paths: even segments name documents, odd ones collections', () => {
  assert.deepEqual(splitPath('tasks/t1', 'doc'), ['tasks', 't1']);
  assert.deepEqual(splitPath('boards/b1/columns', 'collection'), ['boards', 'b1', 'columns']);
  assert.deepEqual(splitPath('a-b_c.d~e:f@g+h/X9', 'doc'), ['a-b_c.d~e:f@g+h', 'X9']);
  assert.throws(() => splitPath('data/users/u1', 'doc'), (e) => e instanceof TypeError && /3 segments/.test(e.message));
  assert.throws(() => splitPath('tasks/t1', 'collection'), /2 segments/);
  for (const bad of ['', '/tasks/t1', 'tasks/t1/', 'tasks//t1', 'tasks/./t1', 'tasks/..', 'tasks/a b', 'tasks/ü', 'tasks/a#b', 'tasks/a?b']) {
    assert.throws(() => splitPath(bad), TypeError, JSON.stringify(bad));
  }
  assert.throws(() => splitPath(undefined, 'doc'), TypeError);
  assert.throws(() => splitPath(Promise.resolve('u1'), 'doc'), TypeError);
  assert.throws(() => splitPath(`c/${'x'.repeat(201)}`, 'doc'), /200 bytes/);
  assert.doesNotThrow(() => splitPath(`c/${'x'.repeat(200)}`, 'doc'));
  assert.throws(() => splitPath(Array(17).fill('a').join('/')), /17 segments/);
  assert.throws(() => splitPath(Array(6).fill('x'.repeat(199)).join('/')), /1000 bytes/);
  // Verbs throw the same TypeError for a bad path.
  const store = new Store();
  assert.throws(() => store.get('tasks', owner), TypeError);
  assert.throws(() => store.query('tasks/t1', {}, owner), TypeError);
});

test('set replaces, update deep-merges (arrays replace), delete is idempotent, versions count', () => {
  const store = new Store();
  const a = store.set('things/a', { n: 1, nested: { x: 1, y: { deep: true } }, list: [1, 2] }, owner);
  assert.equal(a.version, 1);
  store.update('things/a', { nested: { y: { more: 2 }, z: 3 }, list: [9], extra: null }, owner);
  const got = store.get('things/a', owner);
  assert.deepEqual(got.data, { n: 1, nested: { x: 1, y: { deep: true, more: 2 }, z: 3 }, list: [9], extra: null });
  assert.equal(got.version, 2);
  assert.ok(Object.isFrozen(got.data) && Object.isFrozen(got.data.nested.y));
  store.set('things/a', { only: 'this' }, owner);
  assert.deepEqual(store.get('things/a', owner).data, { only: 'this' });
  assert.equal(store.get('things/a', owner).version, 3);
  // update needs the document; set creates it.
  refused(() => store.update('things/none', { a: 1 }, owner));
  // Deleting leaves nested documents alone, and deleting twice is fine.
  store.set('things/a/sub/s1', { k: 1 }, owner);
  store.delete('things/a', owner);
  store.delete('things/a', owner);
  missing(store, 'things/a', owner);
  visible(store, 'things/a/sub/s1', owner);
  // A re-created document starts over.
  assert.equal(store.set('things/a', {}, owner).version, 1);
  // The caller's object is copied, not kept.
  const body = { v: 1 };
  store.set('things/b', body, owner);
  body.v = 2;
  assert.equal(store.get('things/b', owner).data.v, 1);
});

test('bodies are JSON objects of at most 256 KiB and 32 levels', () => {
  const store = new Store();
  for (const bad of [null, [], 'text', 3, true, undefined]) refused(() => store.set('c/d', bad, owner));
  refused(() => store.update('c/d', [1], owner));
  const nest = (n) => { let o = { leaf: 1 }; for (let i = 1; i < n; i++) o = { o }; return o; };
  assert.doesNotThrow(() => store.set('c/deep', nest(LIMITS.depth), owner));
  refused(() => store.set('c/deep', nest(LIMITS.depth + 1), owner));
  const cyclic = {}; cyclic.self = cyclic;
  refused(() => store.set('c/cycle', cyclic, owner));
  assert.doesNotThrow(() => store.set('c/big', { s: 'x'.repeat(LIMITS.bodyBytes - 20) }, owner));
  refused(() => store.set('c/big', { s: 'x'.repeat(LIMITS.bodyBytes) }, owner));
  // An update that would make the document too big is refused too.
  store.set('c/grow', { a: 'x'.repeat(200000) }, owner);
  refused(() => store.update('c/grow', { b: 'x'.repeat(100000) }, owner));
  assert.equal(store.get('c/grow', owner).version, 1);
});

test('queries: operators, ordering, limit, and their limits', () => {
  const store = new Store();
  const rows = {
    a: { n: 3, s: 'pear', tags: ['x', 'y'], ok: true },
    b: { n: 1, s: 'apple', tags: ['y'], ok: false },
    c: { n: 2, s: 'fig', ok: true },
    d: { s: 'kiwi', n: '2' },
    e: { n: null },
  };
  for (const [id, data] of Object.entries(rows)) store.set(`fruit/${id}`, data, owner);
  store.set('fruit/a/seeds/s1', { n: 1 }, owner); // a subcollection is not part of fruit
  store.set('fruits/x', { n: 1 }, owner); // nor is a collection sharing the prefix
  const ids = (q) => store.query('fruit', q, owner).map((d) => d.id);

  assert.deepEqual(ids({}), ['a', 'b', 'c', 'd', 'e']);
  assert.deepEqual(ids({ where: [['n', '==', 2]] }), ['c']);
  assert.deepEqual(ids({ where: [['n', '!=', 2]] }), ['a', 'b', 'd', 'e']);
  assert.deepEqual(ids({ where: [['n', '>', 1]] }), ['a', 'c']); // numbers only: '2' and null don't compare
  assert.deepEqual(ids({ where: [['n', '>=', 1], ['n', '<', 3]] }), ['b', 'c']);
  assert.deepEqual(ids({ where: [['n', '<=', 1]] }), ['b']);
  assert.deepEqual(ids({ where: [['s', 'in', ['fig', 'kiwi']]] }), ['c', 'd']);
  assert.deepEqual(ids({ where: [['s', 'not-in', ['fig', 'kiwi']]] }), ['a', 'b']); // e has no s
  assert.deepEqual(ids({ where: [['tags', 'array-contains', 'y']] }), ['a', 'b']);
  assert.deepEqual(ids({ where: [['tags', '==', ['y']]] }), ['b']);
  assert.deepEqual(ids({ where: [['n', '==', null]] }), ['e']);
  assert.deepEqual(ids({ orderBy: [['s']] }), ['b', 'c', 'd', 'a', 'e']); // e has no s: last
  assert.deepEqual(ids({ orderBy: [['s', 'desc']] }), ['a', 'd', 'c', 'b', 'e']); // still last
  assert.deepEqual(ids({ where: [['ok', '==', true]], orderBy: [['n', 'desc']], limit: 1 }), ['a']);
  assert.deepEqual(ids({ limit: 2 }), ['a', 'b']);

  const bad = (q) => refused(() => store.query('fruit', q, owner));
  bad({ where: Array(11).fill(['n', '==', 1]) });
  assert.doesNotThrow(() => store.query('fruit', { where: Array(10).fill(['n', '==', 1]) }, owner));
  bad({ where: [['n', '~=', 1]] });
  bad({ where: [['n', 'in', 1]] });
  bad({ where: [['n', 'in', Array(31).fill(1)]] });
  bad({ where: [['', '==', 1]] });
  bad({ orderBy: [['n'], ['s']] });
  bad({ orderBy: [['n', 'up']] });
  for (const limit of [0, 1001, 1.5, '3']) bad({ limit });
});

test('the app\'s rules: who reads and writes what', () => {
  const store = new Store({ rules: APP_RULES });
  const everyone = [owner, editor, contrib, viewer];

  // Shared documents: everyone reads, editors and the owner write.
  store.set('unit/spec', { unit: {} }, owner);
  for (const who of everyone) visible(store, 'unit/spec', who);
  for (const who of [owner, editor]) assert.doesNotThrow(() => store.update('unit/spec', { by: who.uid }, who));
  for (const who of [contrib, viewer]) refused(() => store.set('unit/layout', { items: [] }, who));
  for (const who of [contrib, viewer]) refused(() => store.delete('unit/spec', who));
  assert.equal(store.canWriteShared(editor), true);
  assert.equal(store.canWriteShared(contrib), false);

  // Each viewer's own version: a contributor writes theirs; a viewer can't;
  // nobody else sees it, the owner and editors included.
  store.set('data/users/u_contrib/version', { items: [1] }, contrib);
  visible(store, 'data/users/u_contrib/version', contrib);
  for (const who of [owner, editor, viewer]) missing(store, 'data/users/u_contrib/version', who);
  for (const who of [owner, editor]) refused(() => store.set('data/users/u_contrib/version', { items: [] }, who));
  refused(() => store.set('data/users/u_viewer/version', { items: [] }, viewer));
  refused(() => store.set('data/users/u_viewer/version', { items: [] }, contrib));
  assert.doesNotThrow(() => store.set('data/users/u_editor/version', { items: [] }, editor));
  assert.doesNotThrow(() => store.set('data/users/u_owner/version', { items: [] }, owner));

  // Suggestions: each contributor writes and reads their own; editors and
  // the owner read and write them all; a viewer neither.
  store.set('suggestions/u_contrib', { note: 'a sofa?' }, contrib);
  visible(store, 'suggestions/u_contrib', contrib);
  for (const who of [owner, editor]) visible(store, 'suggestions/u_contrib', who);
  missing(store, 'suggestions/u_contrib', viewer);
  missing(store, 'suggestions/u_contrib', { level: 'interact', uid: 'u_other' });
  refused(() => store.set('suggestions/u_contrib', { note: 'hijack' }, { level: 'interact', uid: 'u_other' }));
  refused(() => store.set('suggestions/u_viewer', { note: 'x' }, viewer));
  refused(() => store.set('suggestions/u_other', { note: 'x' }, contrib));
  assert.doesNotThrow(() => store.update('suggestions/u_contrib', { status: 'applied' }, editor));
  assert.doesNotThrow(() => store.update('suggestions/u_contrib', { status: 'dismissed' }, owner));
  assert.deepEqual(store.query('suggestions', {}, editor).map((d) => d.id), ['u_contrib']);
  assert.deepEqual(store.query('suggestions', {}, viewer), []);
  store.set('suggestions/u_other', { note: 'mine' }, { level: 'interact', uid: 'u_other' });
  assert.deepEqual(store.query('suggestions', {}, contrib).map((d) => d.id), ['u_contrib']);
  assert.deepEqual(store.query('suggestions', {}, owner).map((d) => d.id), ['u_contrib', 'u_other']);

  // Signed out: nothing at all.
  missing(store, 'unit/spec', signedOut);
  refused(() => store.set('unit/spec', {}, signedOut));
});

test('platform defaults: everyone reads, interact writes, data/users private', () => {
  const store = new Store();
  store.set('notes/n1', { t: 1 }, contrib);
  visible(store, 'notes/n1', viewer);
  refused(() => store.set('notes/n2', {}, viewer));
  store.set('data/users/u_contrib/p', { mine: true }, contrib);
  missing(store, 'data/users/u_contrib/p', owner);
  refused(() => store.update('data/users/u_contrib/p', { mine: false }, owner));
  assert.deepEqual(store.query('data/users/u_contrib', {}, owner), []);
  // A viewer with no id has no subtree.
  refused(() => store.set('data/users/null/p', {}, { level: 'interact', uid: null }));
  // Locking the root also locks each viewer's own subtree, unless a {self} rule reopens it.
  const locked = new Store({ rules: [{ path: '', write: 'admin' }] });
  refused(() => locked.set('data/users/u_contrib/p', {}, contrib));
  // The owner meets every level.
  const strict = new Store({ rules: [{ path: '', read: 'owner', write: 'owner' }] });
  strict.set('x/y', { a: 1 }, owner);
  visible(strict, 'x/y', owner);
  missing(strict, 'x/y', editor);
});

test('rules: inheritance, deeper overrides, {self} anywhere, prefix rules open siblings', () => {
  const store = new Store({ rules: [
    { path: '', read: 'interact', write: 'admin' },
    { path: 'data/editors-only', read: 'admin' }, // write inherits admin
    { path: 'open', write: 'interact' }, // looser below a stricter root
    { path: 'votes', read: 'view', write: 'owner' },
    { path: 'votes/{self}', write: 'interact' },
    { path: 'drafts/{self}', read: 'interact', write: 'interact' }, // no prefix rule: private
    { path: 'data/users', read: 'admin', write: 'owner' }, // opens data/users to admin
    { path: 'data/users/{self}', read: 'interact', write: 'interact' },
  ] });
  // read: interact at the root hides shared data from view.
  store.set('unit/info', { t: 1 }, owner);
  missing(store, 'unit/info', viewer);
  visible(store, 'unit/info', contrib);
  // A raised read hides it below admin, writes included.
  store.set('data/editors-only/notes/n1', { t: 1 }, editor);
  missing(store, 'data/editors-only/notes/n1', contrib);
  refused(() => store.set('data/editors-only/notes/n2', {}, contrib));
  // A deeper rule can be looser.
  assert.doesNotThrow(() => store.set('open/thing', {}, contrib));
  // Votes: everyone reads them all; each writes only their own; the owner any.
  store.set('votes/u_contrib', { pick: 3 }, contrib);
  visible(store, 'votes/u_contrib', viewer);
  refused(() => store.set('votes/u_contrib', { pick: 1 }, editor));
  assert.doesNotThrow(() => store.set('votes/u_contrib', { pick: 1 }, owner));
  refused(() => store.set('votes/u_viewer', { pick: 1 }, viewer)); // view never writes
  // {self} with no prefix rule: private like data/users, the owner included.
  store.set('drafts/u_contrib', { t: 1 }, contrib);
  store.set('drafts/u_contrib/parts/p1', { t: 1 }, contrib);
  for (const path of ['drafts/u_contrib', 'drafts/u_contrib/parts/p1']) {
    missing(store, path, owner);
    missing(store, path, editor);
  }
  refused(() => store.set('drafts/u_contrib', {}, owner));
  // A rule at data/users opens everyone's subtree at its levels.
  store.set('data/users/u_contrib/p', { t: 1 }, contrib);
  visible(store, 'data/users/u_contrib/p', editor);
  refused(() => store.set('data/users/u_contrib/p', {}, editor));
  assert.doesNotThrow(() => store.set('data/users/u_contrib/p', { by: 'owner' }, owner));
  // Without the {self} rule, your own subtree inherits the prefix rule's levels.
  const inherits = new Store({ rules: [{ path: 'data/users', read: 'admin', write: 'owner' }] });
  refused(() => inherits.set('data/users/u_contrib/p', {}, contrib));
  refused(() => inherits.set('data/users/u_editor/p', {}, editor));
});

test('rules are checked the way publish checks them', () => {
  assert.doesNotThrow(() => checkRules(APP_RULES));
  assert.throws(() => checkRules([{ path: 'votes', read: 'view' }, { path: 'votes/{self}', write: 'interact' }]), /both read and write/);
  assert.throws(() => checkRules([{ path: 'a/{self}/b', write: 'interact' }]), /last segment/);
  assert.throws(() => checkRules([{ path: 'a', read: 'admin', write: 'interact' }]), /never below read/);
  assert.throws(() => checkRules([{ path: 'a', read: 'everyone' }]), /view, interact, admin or owner/);
  assert.throws(() => checkRules([{ path: 'a' }, { path: 'a' }]), /Two rules/);
  assert.throws(() => checkRules([{ path: 'a b', read: 'view' }]), TypeError);
  assert.throws(() => checkRules(Array.from({ length: 65 }, (_, i) => ({ path: `p${i}`, read: 'view' }))), /64/);
});

test('change notifications, in order, for every committed write', () => {
  const store = new Store();
  const heard = [];
  const off = store.subscribe((c) => heard.push([c.path, c.seq, c.exists, c.version]));
  store.set('a/1', { x: 1 }, owner);
  store.update('a/1', { y: 1 }, owner);
  store.delete('a/1', owner);
  store.delete('a/1', owner); // nothing changed: no notification
  refused(() => store.set('a/2', {}, viewer)); // refused: none either
  store.set('a/3', {}, owner);
  store.reset();
  off();
  store.set('a/4', {}, owner);
  assert.deepEqual(heard, [['a/1', 1, true, 1], ['a/1', 2, true, 2], ['a/1', 3, false, 0], ['a/3', 4, true, 1], ['a/3', 5, false, 0]]);
  assert.equal(store.size, 1);
});

test('acquire: a lease is set-if-not-busy and expires', () => {
  let now = 1_000_000;
  const store = new Store({ now: () => now });
  const a = store.acquire('locks/l1', { holder: 'tab-a', ttlMs: 5000 }, contrib);
  assert.equal(a.acquired, true);
  assert.equal(a.holder, 'tab-a');
  const b = store.acquire('locks/l1', { holder: 'tab-b' }, contrib);
  assert.deepEqual(b, { acquired: false, expiresAt: new Date(now + 5000).toISOString() });
  assert.equal(store.acquire('locks/l1', { holder: 'tab-a', data: { by: 'a' } }, contrib).version, 1); // renew, merging data
  now += 31000;
  assert.equal(store.acquire('locks/l1', { holder: 'tab-b', ttlMs: 1 }, contrib).acquired, true); // expired; ttl clamps to 1 s
  refused(() => store.acquire('locks/l2', { holder: '' }, contrib));
  refused(() => store.acquire('locks/l2', { holder: 'x' }, viewer));
});

test('the harness server: the page, the snapshot and the hooks', async () => {
  const h = await startHarness({ port: 0, quiet: true });
  try {
    const page = await (await fetch(`${h.url}/?as=contributor&uid=u_jo2&delay=0`)).text();
    assert.match(page, /^<!doctype html><html><head><meta charset=utf8>/);
    assert.ok(page.indexOf('window.claude = Object.freeze') < page.indexOf('</head><body>'), 'the mock is in <head>');
    assert.match(page, /"role":"contributor","level":"interact","uid":"u_jo2"/);
    assert.doesNotMatch(page, /<script type="importmap">/); // three.js by absolute URL instead (app.mjs absoluteThree)
    assert.ok(page.endsWith('</body></html>'));
    assert.equal((await fetch(`${h.url}/?as=nobody`)).status, 400);

    const snap = await (await fetch(`${h.url}/unit.json`)).json();
    assert.deepEqual(Object.keys(snap).sort(), ['assets', 'author', 'items', 'savedAt', 'title', 'unit', 'unitRev']);
    assert.ok(snap.unit.rooms.length > 0);
    assert.deepEqual(snap.items, []);
    assert.equal((await fetch(`${h.url}/src/main.js`)).headers.get('content-type'), 'text/javascript; charset=utf-8');

    const write = (body) => fetch(`${h.url}/__db/write`, { method: 'POST', body: JSON.stringify(body) });
    assert.equal((await write({ op: 'set', path: 'unit/info', data: { title: 'T' } })).status, 200);
    assert.equal((await write({ op: 'update', path: 'unit/info', data: { author: 'A' }, ifVersion: 1 })).status, 200);
    assert.equal((await write({ op: 'update', path: 'unit/info', data: { author: 'B' }, ifVersion: 1 })).status, 409);
    assert.equal((await write({ op: 'set', path: 'unit/info', data: {}, as: 'viewer' })).status, 400);
    const call = (as, body) => fetch(`${h.url}/__db/call`, { method: 'POST', headers: { 'X-Harness-As': as }, body: JSON.stringify(body) }).then((r) => r.json());
    assert.deepEqual((await call('viewer', { op: 'get', path: 'unit/info' })).result.data, { title: 'T', author: 'A' });
    assert.equal((await call('viewer', { op: 'set', path: 'unit/info', data: {} })).error.code, 'invalid_argument');
    assert.equal((await call('signedout', { op: 'get', path: 'unit/info' })).error.code, 'not_granted');
    const dump = await (await fetch(`${h.url}/__db/dump`)).json();
    assert.deepEqual(dump.docs['unit/info'], { version: 2, data: { title: 'T', author: 'A' } });
    await fetch(`${h.url}/__db/reset`, { method: 'POST' });
    assert.deepEqual((await (await fetch(`${h.url}/__db/dump`)).json()).docs, {});
  } finally {
    await h.close();
  }
});
