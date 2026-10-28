// Checks the harness itself in headless Chrome (not part of npm test):
//
//   node test/harness/selftest.mjs [--root <repo dir>] [--shots <dir>] [--strict] [--headed]
//
// First the mock, on a tiny page of the harness's own (/__harness/blank):
// window.claude before any page script, use() timing, subscriptions, a write
// through /__db/write arriving live, a viewer refused, a contributor's own
// version, two tabs seeing each other, the subscription cap, and the user
// namespace for every role. Then it loads the real app (/?as=owner on a
// desktop, /?as=viewer on a phone) and reports whether it reaches
// window.app.ready, its errors, its db calls, and any request outside the
// harness, jsDelivr and Google Fonts. App findings fail the run only with --strict.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startHarness } from './server.mjs';
import { launch, DESKTOP, PHONE } from './cdp.mjs';

const argv = process.argv.slice(2);
const opt = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
const strict = argv.includes('--strict');
const shots = opt('--shots') ?? mkdtempSync(join(tmpdir(), 'harness-shots-'));
const ALLOWED = ['https://cdn.jsdelivr.net', 'https://fonts.googleapis.com', 'https://fonts.gstatic.com'];

let failures = 0;
async function check(name, fn) {
  try { await fn(); console.log(`ok    ${name}`); } catch (e) { failures++; console.log(`FAIL  ${name}\n      ${e.message.split('\n').join('\n      ')}`); }
}
function expect(cond, what, got) {
  if (!cond) throw new Error(`${what}${got === undefined ? '' : `; got ${JSON.stringify(got)}`}`);
}

// Run in each page: keep the namespaces, and record every delivery.
function setup() {
  return (async () => {
    window.db = await claude.use('db');
    window.user = await claude.use('user');
    window.got = {}; window.raw = {}; window.errs = {};
    window.watch = (key, ref) => ref.onSnapshot((s) => {
      (window.raw[key] ??= []).push(s);
      (window.got[key] ??= []).push('docs' in s
        ? { ids: s.docs.map((d) => d.id), changes: s.docChanges().map((c) => `${c.type}:${c.doc.id}`), pending: s.metadata.hasPendingWrites, cache: s.metadata.fromCache }
        : { exists: s.exists, data: s.data() ?? null, pending: s.metadata.hasPendingWrites, cache: s.metadata.fromCache });
    }, (e) => { window.errs[key] = e; });
    window.pause = (ms) => new Promise((r) => setTimeout(r, ms));
    return true;
  })();
}

const h = await startHarness({ root: opt('--root'), port: 0, quiet: true });
const B = h.url;
const hook = (body) => fetch(`${B}/__db/write`, { method: 'POST', body: JSON.stringify(body) }).then((r) => r.json());
const browser = await launch({ headless: !argv.includes('--headed') });
const open = async (query, device = DESKTOP) => {
  const page = await browser.newPage(device);
  await page.go(`${B}/__harness/blank?${query}`);
  return page;
};

try {
  console.log(`Harness at ${B}\n\nThe mock`);
  await fetch(`${B}/__db/reset`, { method: 'POST' });

  const owner = await open('as=owner&delay=200');
  await check('window.claude exists before any page script; use() is async, memoized, frozen', async () => {
    expect((await owner.ev('window.__early')).use === 'function', 'window.claude.use at parse time', await owner.ev('window.__early'));
    const r = await owner.ev(async () => {
      let settled = false;
      const p = claude.use('db');
      p.then(() => { settled = true; });
      const sync = settled;
      const t0 = performance.now();
      const db = await p;
      return { same: p === claude.use('db'), sync, frozen: Object.isFrozen(db), unknown: await claude.use('nope'), fresh: claude.use('nope') !== claude.use('nope'), waited: performance.now() - t0 };
    });
    expect(r.same && !r.sync && r.frozen && r.unknown === null && r.fresh, 'use() contract', r);
    expect(r.waited >= 150, `use() resolved after ${Math.round(r.waited)} ms with &delay=200`);
  });
  await owner.ev(setup);

  await check('a bad path throws TypeError at once; a bad body or query rejects invalid_argument', async () => {
    const r = await owner.ev(async () => {
      const kind = (fn) => { try { fn(); return 'none'; } catch (e) { return e instanceof TypeError ? 'TypeError' : e.name; } };
      const rejects = async (p) => { try { await p; return 'resolved'; } catch (e) { return e.code; } };
      return {
        paths: [kind(() => db.doc('unit')), kind(() => db.collection('unit/info')), kind(() => db.doc('a b/c')), kind(() => db.doc('unit/info').collection('x/y'))],
        body: await rejects(db.doc('t/x').set([1])),
        query: await rejects(db.collection('t').limit(0).get()),
      };
    });
    expect(r.paths.every((k) => k === 'TypeError'), 'TypeErrors', r.paths);
    expect(r.body === 'invalid_argument' && r.query === 'invalid_argument', 'rejections', r);
  });

  await check('subscriptions deliver: a document, and a query', async () => {
    await owner.ev(() => { watch('info', db.doc('unit/info')); watch('sugg', db.collection('suggestions').orderBy('sentAt')); });
    const r = await owner.until('(window.got.info?.length && window.got.sugg?.length || Object.keys(errs).length) && { info: got.info?.[0], sugg: got.sugg?.[0], errs }', 5000);
    expect(r.info && !r.info.exists && !r.info.cache && r.sugg?.ids.length === 0, 'first deliveries from an empty store', r);
  });

  await check('a write through /__db/write arrives live', async () => {
    const out = await hook({ op: 'set', path: 'unit/info', data: { title: 'From Claude', author: '' } });
    expect(out.ok && out.version === 1, 'hook write', out);
    const last = await owner.until('got.info.at(-1).data?.title === "From Claude" && got.info.at(-1)', 3000);
    expect(!last.pending && !last.cache, 'confirmed, from the server', last);
  });

  const editor = await open('as=editor&delay=0');
  await editor.ev(setup);
  await check('your own write shows at once (pending), then confirmed, with the same body object', async () => {
    await editor.ev(() => watch('layout', db.doc('unit/layout')));
    await editor.until('window.got.layout?.length', 3000);
    const r = await editor.ev(async () => {
      const before = got.layout.length;
      const p = db.doc('unit/layout').set({ items: [{ uid: 'a1', type: 'sofa' }] });
      await new Promise((ok) => setTimeout(ok, 0));
      const immediate = got.layout.slice(before);
      await p;
      await pause(100);
      const all = raw.layout.slice(before);
      return { immediate, after: got.layout.slice(before), same: all.length >= 2 && all[0].data() === all.at(-1).data(), frozen: Object.isFrozen(all.at(-1).data().items[0]) };
    });
    expect(r.immediate[0]?.exists && r.immediate[0].pending, 'shown at once with hasPendingWrites', r.immediate);
    expect(r.after.at(-1).pending === false, 'then confirmed', r.after);
    expect(r.same && r.frozen, 'the same frozen body across both deliveries', r);
  });

  await check('two tabs see each other', async () => {
    await owner.ev(() => watch('layout', db.doc('unit/layout')));
    await owner.until('got.layout?.at(-1)?.data?.items?.[0]?.uid === "a1"', 3000);
    await owner.ev(() => db.doc('unit/info').update({ title: 'Renamed by owner' }));
    await editor.ev(() => watch('info', db.doc('unit/info')));
    await editor.until('got.info?.at(-1)?.data?.title === "Renamed by owner"', 3000);
    await editor.ev(() => db.doc('unit/layout').update({ items: [{ uid: 'b2', type: 'bed-queen' }] }));
    await owner.until('got.layout.at(-1).data?.items?.[0]?.uid === "b2"', 3000);
  });

  const viewer = await open('as=viewer&delay=0');
  await viewer.ev(setup);
  await check("a viewer's write is refused and rolls back", async () => {
    await viewer.ev(() => watch('info', db.doc('unit/info')));
    await viewer.until('got.info?.at(-1)?.data?.title === "Renamed by owner"', 3000);
    const r = await viewer.ev(async () => {
      let err;
      try { await db.doc('unit/info').set({ title: 'viewer was here' }); } catch (e) { err = e; }
      await pause(50);
      return { err, plain: Object.getPrototypeOf(err) === Object.prototype, titles: got.info.map((x) => x.data?.title), last: got.info.at(-1), can: await user.can('data.write') };
    });
    expect(r.err?.code === 'invalid_argument' && typeof r.err.message === 'string' && r.plain, 'rejects { code, message }', r.err);
    expect(r.last.data.title === 'Renamed by owner' && !r.last.pending, 'back to the stored title', r.titles);
    expect(r.can === false, 'can("data.write") is false', r.can);
    const dump = await (await fetch(`${B}/__db/dump`)).json();
    expect(dump.docs['unit/info'].data.title === 'Renamed by owner', 'the store kept the owner\'s title');
  });

  const contrib = await open('as=contributor&delay=0');
  await contrib.ev(setup);
  await check("a contributor's own version saves; nobody else sees it", async () => {
    const r = await contrib.ev(async () => {
      const id = await user.id();
      await db.doc(`data/users/${id}/version`).set({ base: 1, items: [{ uid: 'c3' }], savedAt: 1 });
      const mine = await db.doc(`data/users/${id}/version`).get();
      let shared;
      try { await db.doc('unit/layout').set({ items: [] }); shared = 'resolved'; } catch (e) { shared = e.code; }
      return { id, exists: mine.exists, items: mine.data().items.length, shared };
    });
    expect(r.id === 'u_contrib' && r.exists && r.items === 1, 'saved and read back', r);
    expect(r.shared === 'invalid_argument', 'the shared layout stays editors\'', r.shared);
    const seen = await owner.ev(async () => (await db.doc('data/users/u_contrib/version').get()).exists);
    expect(seen === false, 'the owner reads it as missing');
  });

  await check('a suggestion reaches editors live, and stays hidden from a viewer', async () => {
    await viewer.ev(() => watch('sugg', db.collection('suggestions')));
    await viewer.until('got.sugg?.length', 3000);
    await contrib.ev(async () => db.doc(`suggestions/${await user.id()}`).set({ note: 'A rug?', items: [], status: 'open', sentAt: 5 }));
    const r = await owner.until('got.sugg.at(-1).ids.includes("u_contrib") && got.sugg.at(-1)', 3000);
    expect(r.changes.includes('added:u_contrib'), 'docChanges says added', r);
    await editor.ev(() => db.doc('suggestions/u_contrib').update({ status: 'applied' }));
    const mod = await owner.until('got.sugg.at(-1).changes.includes("modified:u_contrib") && got.sugg.at(-1)', 3000);
    expect(mod.ids.length === 1, 'one suggestion, modified', mod);
    await viewer.ev(() => pause(200));
    const v = await viewer.ev('got.sugg.map((s) => s.ids.length)');
    expect(v.every((n) => n === 0), 'the viewer never sees one', v);
  });

  await check('the 65th live subscription gets resource_exhausted', async () => {
    const r = await owner.ev(async () => {
      const offs = [];
      const errors = [];
      const start = __mock.state().subscriptions;
      for (let i = 0; i < 70; i++) offs.push(db.doc(`many/d${i}`).onSnapshot(() => {}, (e) => errors.push(e.code)));
      await pause(100);
      const at = __mock.state().subscriptions;
      offs.forEach((off) => off());
      return { start, at, errors, after: __mock.state().subscriptions };
    });
    expect(r.at === 64 && r.errors.length === 70 - (64 - r.start) && r.errors.every((c) => c === 'resource_exhausted') && r.after === r.start, 'capped at 64', r);
  });

  await check('a gap in the live stream: fromCache while it lasts, and a catch-up after', async () => {
    const before = await viewer.ev('got.info.length');
    await fetch(`${B}/__db/drop`, { method: 'POST' });
    await viewer.until('!__mock.state().live', 3000);
    // Written while this tab wasn't listening.
    await hook({ op: 'update', path: 'unit/info', data: { title: 'Written during the gap' } });
    const last = await viewer.until('got.info.at(-1).data?.title === "Written during the gap" && got.info.at(-1)', 8000);
    expect(!last.cache, 'definitive again after reconnecting', last);
    const during = await viewer.ev(`got.info.slice(${before}).map((x) => x.cache)`);
    expect(during[0] === true, 'a fromCache delivery during the gap', during);
  });
  for (const p of [editor, viewer, contrib]) await p.close();

  await check('user: each role, as the page sees it', async () => {
    const want = {
      owner: { db: true, isOwner: true, canEdit: true, write: true, id: 'u_owner', name: 'Sam' },
      editor: { db: true, isOwner: false, canEdit: true, write: true, id: 'u_editor', name: 'Riley' },
      contributor: { db: true, isOwner: false, canEdit: false, write: false, id: 'u_contrib', name: 'Jo' },
      viewer: { db: true, isOwner: false, canEdit: false, write: false, id: 'u_viewer', name: 'Alex' },
      outside: { db: true, isOwner: false, canEdit: false, write: null, id: 'u_outside', name: 'Casey' },
      signedout: { db: false, isOwner: false, canEdit: false, write: null, id: null, name: '' },
    };
    const page = await browser.newPage();
    for (const [role, w] of Object.entries(want)) {
      await page.go(`${B}/__harness/blank?as=${role}&delay=0`);
      const got = await page.ev(async () => {
        const user = await claude.use('user');
        const me = await user.me();
        return { db: !!(await claude.use('db')), isOwner: await user.isOwner(), canEdit: await user.canEdit(), write: await user.can('data.write'), id: await user.id(), name: await user.name(), meId: me.id, avatar: me.avatarUrl.slice(0, 5) };
      });
      const { meId, avatar, ...rest } = got;
      expect(JSON.stringify(rest) === JSON.stringify(w) && meId === w.id && avatar === 'data:', `as ${role}`, got);
    }
    await page.go(`${B}/__harness/blank?as=contributor&uid=u_jo2&delay=0`);
    const p = await page.ev(async () => {
      const user = await claude.use('user');
      const ps = await user.profiles(['u_owner', 'u_jo2', 'u_never_seen']);
      return { owner: ps.u_owner.name, me: ps.u_jo2.isMe, stray: ps.u_never_seen.name, search: (await user.search('ri')).map((x) => x.name) };
    });
    expect(p.owner === 'Sam' && p.me && p.stray === '' && p.search.includes('Riley'), 'profiles and search', p);
    await page.go(`${B}/__harness/blank?nocap=1`);
    expect(await page.ev('typeof window.claude') === 'undefined', '&nocap=1 has no window.claude');
    await page.close();
  });
  await owner.close();

  console.log('\nThe app');
  const appFindings = [];
  for (const [label, query, device] of [['desktop, owner', 'as=owner', DESKTOP], ['phone, viewer', 'as=viewer', PHONE]]) {
    const page = await browser.newPage(device);
    const t0 = Date.now();
    let ready = false;
    try {
      await page.go(`${B}/?${query}`, 60000);
      ready = await page.until('window.app?.ready === true', 60000, 100);
    } catch (e) { appFindings.push(`${label}: ${e.message}`); }
    const ms = Date.now() - t0;
    await page.ev(() => new Promise((r) => setTimeout(r, 1500))).catch(() => {});
    const shot = await page.shot(join(shots, `app-${label.replace(/\W+/g, '-')}.png`)).catch(() => null);
    const foreign = [...new Set(page.requests.filter((u) => !/^(data|blob):/.test(u)).map((u) => new URL(u).origin))].filter((o) => o !== B && !ALLOWED.includes(o));
    const log = await page.ev('window.__mock?.log ?? []').catch(() => []);
    const mode = await page.ev('({ body: document.body.dataset.role, inClaude: document.documentElement.classList.contains("in-claude"), mode: window.LIVING_SPACE })').catch(() => null);
    console.log(`${ready ? 'ok  ' : 'WARN'}  ${label}: ${ready ? `app.ready after ${ms} ms` : 'never reached app.ready'}`);
    console.log(`      page: ${JSON.stringify(mode)}; screenshot ${shot}`);
    console.log(`      db calls: ${log.length ? log.map((e) => `${e.op} ${e.path}${e.result && e.result !== 'ok' ? ` (${e.result})` : ''}`).join(', ') : 'none'}`);
    const apiCalls = page.requests.filter((u) => u.startsWith(`${B}/api/`));
    if (apiCalls.length) console.log(`      site API calls (404 here): ${[...new Set(apiCalls.map((u) => u.slice(B.length)))].join(', ')}`);
    if (page.errors.length) console.log(`      errors:\n        ${[...new Set(page.errors)].join('\n        ')}`);
    if (foreign.length) console.log(`      requests outside the harness, jsDelivr and Google Fonts: ${foreign.join(', ')}`);
    if (!ready || page.errors.length || foreign.length) appFindings.push(label);
    await page.close();
  }
  const unpublished = h.unpublished();
  if (unpublished.length) { console.log(`      not among the Artifact's files (would 404 there): ${unpublished.join(', ')}`); appFindings.push('unpublished files'); }
  if (strict) failures += appFindings.length;
} finally {
  await browser.close();
  await h.close();
}

console.log(failures ? `\n${failures} failed` : '\nAll good');
process.exit(failures ? 1 : 0);
