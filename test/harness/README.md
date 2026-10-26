# Local Artifact harness

The app runs on claude.ai as an Artifact: its data lives in the Artifact's `db`
capability and it knows its viewer through `user`. Headless Chrome can't sign in
to claude.ai, so this folder is a stand-in for the viewer: a small server that
serves the page the way the platform does, with a `window.claude` whose `db` and
`user` follow the capability contracts (artifact-capabilities 0.2.91:
`claude.d.ts`, `db.d.ts`, `user.d.ts`).

```sh
node test/harness/server.mjs                    # http://127.0.0.1:8791/?as=owner
node test/harness/server.mjs --host 0.0.0.0     # also prints the Tailscale URL, for a phone
node test/harness/selftest.mjs                  # checks the mock in headless Chrome, then loads the app
```

Server flags: `--root <repo dir>` (default: this checkout), `--port 8791`,
`--host 127.0.0.1|0.0.0.0`, `--snapshot <unit.json>|none`,
`--rules <file or inline JSON>|none` (default: the app's rules, below; `none` is
the platform's defaults), `--quiet`.

## What it serves

- `/`: the platform's page skeleton around `artifactPage(index.html)` from
  `skill/3d-living-space/scripts/app.mjs`, with index.html read fresh from
  `--root` on every load. The mock script sits at the end of the skeleton's
  `<head>`, so `window.claude` exists before any page script, as in the viewer.
- `/src/*`, `/assets/*`: straight from `--root`, so edits are live. A file the
  Artifact wouldn't ship (not in the module graph of `src/main.js` and
  `src/claude-store.js`, not a 512/1024 texture) is still served but printed,
  and listed at `GET /__harness/unpublished`: it would 404 on claude.ai.
- `/unit.json`: the bundle's snapshot. By default the example unit with no
  furniture (`{title, author, unit, unitRev: 1, items: [], assets: [], savedAt}`);
  `--snapshot file` serves that file, `--snapshot none` a 404.
- `/__harness/blank`: a near-empty page with the same mock, for testing the
  mock itself.

## Who is viewing

From the page's query string:

| `?as=` | db level | `isOwner` | `canEdit` | `can("data.write")` | uid | name |
| --- | --- | --- | --- | --- | --- | --- |
| `owner` (default) | owner | true | true | true | `u_owner` | Sam |
| `editor` | admin | false | true | true | `u_editor` | Riley |
| `contributor` | interact | false | false | per root rule (false with the app's) | `u_contrib` | Jo |
| `viewer` | view | false | false | false | `u_viewer` | Alex |
| `outside` | view | false | false | null | `u_outside` | Casey |
| `signedout` | none: `use("db")` is null | false | false | null | null | "" |

- `&uid=u_...` makes you another person in that role (two tabs with the same
  role and no uid are the same person).
- `&delay=<ms>`: how long `use()` takes to resolve (default 300). It never
  resolves synchronously.
- `&nocap=1`: no `window.claude` at all (a saved copy of the page).

`user.profiles()` names anyone the harness has seen (the roles above plus any
uid a page has used); other ids come back unresolved (`name: ""`). `search()`
is `[]` for viewers, outside visitors and signed-out visitors.

## The app's rules

```json
[{"path":"","read":"view","write":"admin"},
 {"path":"data/users/{self}","write":"interact"},
 {"path":"suggestions","read":"admin","write":"admin"},
 {"path":"suggestions/{self}","read":"interact","write":"interact"}]
```

View reads shared docs and writes nothing; interact writes only its own
`data/users/<id>/…` and `suggestions/<id>`; admin and owner write shared docs
and read and write every suggestion, but never see anyone's `data/users`.

## Test hooks

| | |
| --- | --- |
| `POST /__db/write` | `{op: "set"\|"update"\|"delete", path, data}` as the owner, the way Claude writes through ArtifactData. Optional `as`/`uid` to write as someone else, `ifVersion` to check the version first (409 if it moved). An array does several in order. |
| `GET /__db/dump` | `{seq, rules, docs: {path: {version, data}}}` |
| `POST /__db/reset` | empty the store; open pages see every document go |
| `POST /__db/drop` | end every page's live stream (they reconnect within a second): a connectivity gap |
| `GET`/`POST /__db/rules` | read or replace the rules |

In pages: `window.__mock = {role, level, uid, log, state()}`. `log` lists every
db call (`{op, path, at, result}`); `state()` gives
`{live, subscriptions, pending}` once `db` has resolved.

## How faithful it is

The store (`store.mjs`) is shared by the server and the page side, and is
covered by `test/harness-store.test.js` in `npm test`: path grammar (TypeError),
set/update/delete, 256 KiB and 32 levels, queries, rules with inheritance,
`{self}` privacy and prefix rules, versions, leases.

The page side (`client.mjs`) behaves as the contract says: refs are pure and
frozen; verbs reject with plain `{code, message}`; your own write shows at once
with `hasPendingWrites: true`, then confirmed (a refused one shows, then rolls
back and rejects, as with Firestore's latency compensation); a subscription's
first delivery comes from what the page already knows (`fromCache: true`)
when it knows anything, then from the server; while the live stream is down
deliveries say `fromCache: true`, and it re-reads on reconnect; unchanged
documents are the same frozen objects across deliveries; at most 64
subscriptions (the 65th gets `resource_exhausted`).

Not modelled: rate limits, `quota_exceeded` beyond the 25,000-document cap,
`revoked`, the ~30 s polling fallback, comments, scopes other than `profile`.

## Driving Chrome

`cdp.mjs` is a small CDP driver over Node's own WebSocket:

```js
import { launch, DESKTOP, PHONE } from './test/harness/cdp.mjs';
const browser = await launch();
const page = await browser.newPage(PHONE); // 390×844 @3x, mobile, touch; DESKTOP is 1440×900
await page.go('http://127.0.0.1:8791/?as=viewer');
await page.until('window.app?.ready', 30000);
await page.click('#some-button'); // touch events on a touch page
await page.shot('/tmp/viewer.png');
console.log(page.errors, page.requests);
await browser.close();
```

Pages also have `ev(expr | fn, ...args)`, `tap(x, y)`, `reload()`, `once(event)`,
`send(method, params)`, `console`, `responses` and `failed`.

Chrome opens at most 6 connections per host, and every tab holds one for its
live stream; with more than four or so tabs on one host, open the rest on
another name (`localhost` vs `127.0.0.1`).
