// What the agent's tools do (src/tools.js says what they are): read, build and
// check one unit, and furnish it. Pure functions of the unit's stored document,
// so the MCP server (server/mcp.js) and the skill's scripts (skill/3d-living-space)
// run exactly the same code; each brings its own storage through `ctx`:
//   current()     → { row, U }: the stored row ({ id, title, author, version,
//                   doc: { unit, unitRev, items, assets } }) and the unit as built
//   write(change) → { row, result }: change(doc) edits a copy of { title, author,
//                   unit, items, assets }, maybe more than once; it's saved checked
//   built(row)    → the unit as built
//   viewUrl       → where to look at it in 3D, or null
//   png(svg)      → the plan or a texture's preview as a PNG; beforeRender()
//                   runs first, if given
// Inches at this edge, feet inside (src/unit.js fromInches / toInches). A tool
// that can't do what it was asked throws ToolError, whose message says why and
// what to do instead.
import { CATALOG, catalogByType, SWATCHES, MATERIALS, isFlat, placeOf } from './catalog.js';
import { cleanAsset, cleanItem, randomId, LIMITS } from './design.js';
import { holdsItems } from './parts.js';
import { placeByType, restOn, hangOnWall, ceilingY, carry, descendants } from './stacking.js';
import {
  ROOM_KINDS, FLOORS, OPENING_TYPES, FIXTURES, fixtureByType, SEGMENTS, FIXTURE_OPTIONS, FINISH_OPTIONS,
  cleanUnit, buildUnit, fromInches, toInches, snapToWall,
} from './unit.js';
import { problems, clearances, findSpots, settleOffWalls, onFloor } from './fit.js';
import { detailSvg, textureSvg } from './drawing.js';
import { cleanTexture, patch, imageStats, compareStats, repeatOf, PRESETS, PATTERNS, LAYERS, TEXTURE_LIMITS } from './recipes.js';
import { encodePng } from './png.js';

export class ToolError extends Error {}

export const inch = (ft) => Math.round(ft * 12 * 100) / 100;  // as src/unit.js toInches
const ft = (inches) => inches / 12;
const box = ([x0, z0, x1, z1]) => ({ x0: inch(x0), z0: inch(z0), x1: inch(x1), z1: inch(z1) });
const sqft = (a) => Math.round(a * 10) / 10;
export const COMPASS = { north: [0, -1], south: [0, 1], east: [1, 0], west: [-1, 0] };
const compassOf = ([dx, dz]) => Object.entries(COMPASS).reduce((best, [name, [cx, cz]]) => (dx * cx + dz * cz > best[1] ? [name, dx * cx + dz * cz] : best), ['', -Infinity])[0];
const HINGED = new Set(['door', 'entry', 'bifold']);
const SIDED = new Set(['door', 'entry', 'double', 'bifold', 'barn']);

// JSON, with short lists ([x, z], joins), lists of them (outlines) and small
// flat objects (bounds, a piece) kept on one line: much less for the agent to read.
const ATOM = String.raw`(?:"(?:[^"\\\n]|\\.)*"|-?\d[\d.]*(?:e[+-]?\d+)?|true|false|null)`;
const FLAT = new RegExp(String.raw`\[\n\s*${ATOM}(?:,\n\s*${ATOM})*\n\s*\]`, 'g');
const NESTED = /\[\n(?:\s*\[[^\n]*\],?\n)+\s*\]/g;
const OBJECT = new RegExp(String.raw`\{\n(?:\s*"(?:[^"\\\n]|\\.)*": (?:${ATOM}|\[[^\n]*\]),?\n)+\s*\}`, 'g');
const oneLine = (m) => m.replace(/\s*\n\s*/g, ' ').replace(/^([[{]) /, '$1').replace(/ ([\]}])$/, '$1');
export function pretty(data) {
  return JSON.stringify(data, null, 1)
    .replace(FLAT, (m) => (oneLine(m).length <= 120 ? oneLine(m) : m))
    .replace(NESTED, oneLine)
    .replace(OBJECT, (m) => (oneLine(m).length <= 200 ? oneLine(m) : m));
}

const LISTS = { rooms: 'room', walls: 'wall', openings: 'opening', fixtures: 'fixture' };

// What E or a tap does to a piece in the app (catalog act).
const USE = { light: 'switches on and off', screen: 'turns on and off', curtain: 'opens and closes', fan: 'spins', door: 'its door opens' };
const PLACEMENT_ABOUT = {
  floor: 'Stands on the floor.',
  surface: 'Rests on a placed piece that holds items (holds_items) or a counter, island, vanity or washer; on the floor if nothing is under it.',
  wall: 'Hangs with its back against a wall, facing into the room; elevation is the height of its underside.',
  ceiling: 'Hangs from the ceiling; its height runs from the ceiling down to its bottom.',
};

export function createTools({ current, write, built, viewUrl = null, png, beforeRender = () => {} }) {
  const itemOut = (U, assets = []) => (it) => ({
    id: it.uid, type: it.type === 'asset' ? `asset:${it.asset}` : it.type, name: it.name,
    at: [inch(it.x), inch(it.z)], width: inch(it.w), depth: inch(it.d), height: inch(it.h), rotation: it.rot,
    color: it.color ?? undefined, material: it.material ?? undefined, room: U.roomAt(it.x, it.z)?.id ?? null,
    on: it.on ? it.on.replace(/^[pf]:/, '') : 'floor', ...(it.y ? { elevation: inch(it.y) } : {}),
    ...(placeOf(it, assets) !== 'floor' ? { placement: placeOf(it, assets) } : {}),
  });
  const pieceProblems = (U, { items, assets }, only = null) => items
    .filter((it) => !only || only.includes(it.uid))
    .map((it) => [it, problems(it, items, U, assets)]).filter(([, list]) => list.length)
    .map(([it, list]) => `${it.name} (${it.uid}) ${list.join(', ')}.`);
  function toItem(spec, base = {}) {
    const out = { ...base };
    if (spec.type !== undefined) {
      const m = /^asset:(.+)$/.exec(spec.type);
      if (m) { out.type = 'asset'; out.asset = m[1]; } else { out.type = spec.type; delete out.asset; }
    }
    if (spec.at) { out.x = ft(spec.at[0]); out.z = ft(spec.at[1]); }
    for (const [from, to] of [['width', 'w'], ['depth', 'd'], ['height', 'h']]) if (spec[from] !== undefined) out[to] = ft(spec[from]);
    if (spec.rotation !== undefined) out.rot = spec.rotation;
    if (spec.color !== undefined) out.color = spec.color;
    if (spec.material !== undefined) out.material = spec.material;
    if (spec.name !== undefined) out.name = spec.name;
    return out;
  }

  // A piece set a little into a wall or its trim is eased out (src/fit.js),
  // at its full size: the catalog's or the asset's where the agent gave none.
  function settle(U, doc, item, eased) {
    const full = cleanItem(item, Object.fromEntries(doc.assets.map((a) => [a.id, a])));
    const p = full && settleOffWalls(full, U, doc.assets);
    if (!p) return;
    eased.push({ id: item.uid, name: item.name ?? item.type, from: [inch(item.x), inch(item.z)], to: [inch(p.x), inch(p.z)] });
    item.x = Math.round(p.x * 1e4) / 1e4; item.z = Math.round(p.z * 1e4) / 1e4;
  }

  // Where a piece goes (src/stacking.js): on the floor, a wall, the ceiling,
  // or a piece or fixture, from on and elevation, else from its type's
  // placement. `item` is whole (cleanItem); changed in place.
  function resolvePlacement(item, spec, doc, U) {
    const assets = doc.assets, items = doc.items;
    const place = placeOf(item, assets);
    const y = spec.elevation !== undefined ? ft(spec.elevation) : undefined;
    const on = spec.on ?? { surface: 'auto', wall: 'wall', ceiling: 'ceiling' }[place] ?? 'floor';
    const where = `${item.name} (${item.uid})`;
    if (on === 'floor') { delete item.on; delete item.y; return; }
    if (on === 'wall') {
      const at = { ...item, y: y ?? item.y ?? (catalogByType[item.type]?.y ?? 48) / 12 };
      const hung = hangOnWall(at, item.x, item.z, U, { y: at.y });
      if (!hung) throw new ToolError(`${where}: no wall within 3 ft of [${inch(item.x)}, ${inch(item.z)}] stands behind all of its ${inch(item.w)} in width at ${inch(at.y)} to ${inch(at.y + item.h)} in up (windows and doorways are gaps). Give at a point on a wall, or change elevation or width.`);
      Object.assign(item, { x: hung.x, z: hung.z, rot: hung.rot, y: at.y, on: 'wall' });
      return;
    }
    if (on === 'ceiling') { Object.assign(item, { on: 'ceiling', y: ceilingY(item, U) }); return; }
    // Something set down new on a table or counter faces the way it does.
    const face = (p) => { const { face: rot, ...rest } = p; return spec.rotation === undefined && rot !== undefined && !spec.keepRotation ? { ...rest, rot } : rest; };
    if (on === 'auto') {
      const p = face(placeByType(item, { items, U, assets }));
      Object.assign(item, p);
      if (!p.on) { delete item.on; delete item.y; }
      return;
    }
    const piece = items.find((i) => i.uid === on);
    const fixture = !piece && U.fixtures.find((f) => f.id === on);
    if (!piece && !fixture) throw new ToolError(`${where}: on "${on}" isn't a piece or a fixture in this unit. Use "floor", "wall", "ceiling", a piece's id (get_unit furniture) or a fixture's id.`);
    if (piece && (piece.uid === item.uid || descendants(item.uid, items).includes(piece))) throw new ToolError(`${where} can't rest on itself or on something resting on it.`);
    const r = restOn(item, piece ? { kind: 'piece', piece } : { kind: 'fixture', fixture }, { x: spec.at ? item.x : NaN, z: spec.at ? item.z : NaN, y: y ?? null, U, assets });
    if (typeof r === 'string') throw new ToolError(`${where}: ${r} get_catalog says which pieces hold items (holds_items).`);
    Object.assign(item, face(r));
  }

  // A piece moved, turned, resized or raised: what rests on it follows.
  function carryChildren(before, item, doc, carried) {
    if (!descendants(item.uid, doc.items).length) return;
    if (['x', 'z', 'rot', 'w', 'd', 'h', 'y'].every((k) => (before[k] ?? 0) === (item[k] ?? 0))) return;
    for (const m of carry(before, item, doc.items, doc.assets)) {
      const child = doc.items.find((i) => i.uid === m.uid);
      Object.assign(child, m);
      carried.add(child.uid);
    }
  }

  function unitOut(row, U) {
    const spec = row.doc.unit, items = row.doc.items;
    const builtOpening = Object.fromEntries(U.openings.map((o) => [o.id, o]));
    return {
      unit_id: row.id, title: row.title, author: row.author, version: row.version, view_url: viewUrl,
      status: U.empty ? 'empty' : 'built',
      ...(U.empty ? { next_steps: 'Nothing is built yet. Ask the person for their floor plan (with the room sizes) and a few photos of each room, then call get_catalog and build the unit with build_unit as the instructions describe.' } : {}),
      settings: toInches.settings(spec),
      area_sqft: sqft(U.area),
      bounds: U.empty ? null : { x0: inch(U.bounds.x0), z0: inch(U.bounds.z0), x1: inch(U.bounds.x1), z1: inch(U.bounds.z1) },
      rooms: U.rooms.map((r) => ({
        ...toInches.room(spec.rooms[r.index]), floor: r.floor, area_sqft: sqft(r.area), size: [inch(r.w), inch(r.d)], bounds: box(r.bbox),
      })),
      walls: spec.walls.map(toInches.wall),
      openings: spec.openings.map((o) => openingOut(o, builtOpening[o.id])),
      fixtures: U.fixtures.map((f) => ({
        ...toInches.fixture(f), room: f.room, against_wall: Object.keys(f.against).filter((k) => f.against[k]),
      })),
      labels: spec.labels.map(toInches.label),
      furniture: items.map(itemOut(U, row.doc.assets)),
      assets: row.doc.assets.map(assetOut),
      textures: (spec.textures ?? []).map(textureOut(spec, items)),
      problems: [...U.problems, ...pieceProblems(U, row.doc)],
    };
  }
  function openingOut(o, b) {
    const out = toInches.opening(o);
    if (!b) return { ...out, in_wall: false };
    out.joins = [b.rooms[0], b.rooms[1] ?? 'outside'];
    out.wall_thickness = inch(b.t1);
    if (HINGED.has(o.type)) out.hinge = compassOf(b.hinge === 'b' ? b.u : [-b.u[0], -b.u[1]]);
    if (SIDED.has(o.type)) {
      out.opens = compassOf([b.n[0] * b.swing, b.n[1] * b.swing]);
      out.opens_into = b.swing > 0 ? b.rooms[1] ?? 'outside' : b.rooms[0];
    }
    return out;
  }
  // A texture, its recipe as given, and what uses it.
  const textureOut = (spec, items) => ({ id, ...recipe }) => ({
    texture_id: id, use_as: `tex:${id}`, ...recipe, repeat_inches: repeatOf({ id, ...recipe }),
    used_by: usersOf(`tex:${id}`, spec, items),
  });
  function usersOf(ref, spec, items) {
    return [
      ...Object.entries(spec.finishes).filter(([, v]) => v === ref).map(([k]) => `finishes.${k}`),
      ...spec.rooms.filter((r) => r.floor === ref).map((r) => `room ${r.id}`),
      ...spec.fixtures.filter((f) => f.color === ref || f.opts?.backsplash === ref).map((f) => `fixture ${f.id}`),
      ...items.filter((i) => i.material === ref).map((i) => `piece ${i.uid}`),
    ];
  }
  const assetOut = (a) => ({ asset_id: a.id, name: a.name, description: a.description, placement: a.place ?? 'floor', kind: a.kind ?? 'furniture', width: a.w, depth: a.d, height: a.h, parts: a.parts.length, ...(a.light ? { light_at: a.light } : {}), place_as: `asset:${a.id}` });

  // build_unit and edit_unit: settings, list changes, wall fixtures slid
  // flush, then one save. Returns what to tell the agent.
  function changeUnit(args, mode) {
    let report;
    const { row } = write((doc) => {
      report = { dropped: [], moved: [], removed: [], not_found: [] };
      const spec = structuredClone(doc.unit);
      Object.assign(spec, fromInches.settings(args));
      spec.finishes = { ...doc.unit.finishes, ...(args.finishes ?? {}) };
      const snap = new Set();
      const wantsSnap = (f, isNew) => f.snap !== false && (mode === 'build' || isNew || ['at', 'rotation', 'width', 'depth', 'type'].some((k) => f[k] !== undefined));
      if (mode === 'build') {
        for (const list of Object.keys(LISTS)) {
          if (!args[list]) continue;
          // Ids stay as given; a repeated one gets a suffix, and fixtures
          // without one get one here so snapping can follow them.
          const given = new Set(args[list].map((x) => x.id).filter(Boolean)), used = new Set();
          const free = (stem) => { let n = 2, out = stem; while (given.has(out) || used.has(out)) out = `${stem.slice(0, 20)}-${n++}`; return out; };
          spec[list] = args[list].map((x) => {
            let fid = x.id;
            if (fid && used.has(fid)) { const next = free(fid); report.dropped.push(`Two ${list} have the id "${fid}"; the second is now "${next}".`); fid = next; }
            if (!fid && list === 'fixtures') fid = free(x.type);
            if (fid) used.add(fid);
            if (list === 'fixtures' && wantsSnap(x, true)) snap.add(fid);
            return fromInches[LISTS[list]]({ ...x, id: fid });
          });
        }
      } else {
        for (const rid of args.remove ?? []) {
          let hit = false;
          if (spec.textures?.some((t) => t.id === rid)) {
            spec.textures = spec.textures.filter((t) => t.id !== rid);
            hit = true; report.removed.push(`texture ${rid}`);
            // Pieces made of it go back to their own material.
            for (const it of doc.items) if (it.material === `tex:${rid}`) delete it.material;
          }
          for (const [list, one] of Object.entries(LISTS)) {
            const before = spec[list].length;
            spec[list] = spec[list].filter((x) => x.id !== rid);
            if (spec[list].length < before) { hit = true; report.removed.push(`${one} ${rid}`); }
          }
          if (!hit) report.not_found.push(rid);
        }
        for (const [list, one] of Object.entries(LISTS)) {
          for (const raw of args[list] ?? []) {
            const patch = Object.fromEntries(Object.entries(raw).filter(([, v]) => v !== undefined));
            const i = spec[list].findIndex((x) => x.id === patch.id);
            if (i < 0) spec[list].push(fromInches[one](patch));
            else {
              // Merge in inches; keep what the inch form doesn't carry (a
              // room's walk-mode view, a window's mullions).
              const old = spec[list][i], back = fromInches[one](toInches[one](old));
              const kept = Object.fromEntries(Object.entries(old).filter(([k]) => !(k in back)));
              spec[list][i] = { ...kept, ...fromInches[one]({ ...toInches[one](old), ...patch }) };
            }
            if (list === 'fixtures' && wantsSnap(patch, i < 0)) snap.add(patch.id);
          }
        }
      }
      if (args.labels) spec.labels = args.labels.map(fromInches.label);

      const { unit, dropped } = cleanUnit(spec);
      report.dropped.push(...dropped);
      // Slide wall fixtures back against the wall behind them. Fixtures never
      // change the walls, so one build without them serves every fixture.
      const toSnap = unit.fixtures.filter((f) => snap.has(f.id) && fixtureByType[f.type]?.wall);
      if (toSnap.length) {
        const bare = buildUnit({ ...unit, fixtures: [] }, { checks: false });
        for (const f of toSnap) {
          const p = snapToWall(bare, f);
          if (!p || Math.hypot(p[0] - f.x, p[1] - f.z) < 1 / 96) continue;
          report.moved.push({ id: f.id, from: [inch(f.x), inch(f.z)], to: [inch(p[0]), inch(p[1])], why: 'slid flush against the wall behind it' });
          [f.x, f.z] = p;
        }
      }
      doc.unit = unit;
    });
    const U = built(row);
    const spec = row.doc.unit;
    return {
      version: row.version,
      counts: {
        rooms: spec.rooms.length, walls: spec.walls.length,
        doors: U.openings.filter((o) => o.kind === 'door').length, windows: U.openings.filter((o) => o.kind === 'window').length,
        doorways: U.openings.filter((o) => o.kind === 'opening').length, fixtures: spec.fixtures.length, labels: spec.labels.length,
      },
      area_sqft: sqft(U.area),
      rooms: U.rooms.map((r) => ({ id: r.id, name: r.name, size: [inch(r.w), inch(r.d)], area_sqft: sqft(r.area) })),
      ...(report.removed.length ? { removed: report.removed } : {}),
      ...(report.not_found.length ? { not_found: report.not_found.map((x) => `Nothing has the id "${x}".`) } : {}),
      dropped: report.dropped,
      moved: report.moved,
      problems: [...U.problems, ...pieceProblems(U, row.doc)],
      next: 'Call render_plan and compare it with the floor plan side by side. Fix positions and sizes with edit_unit, and fix every problem listed here.',
      view_url: viewUrl,
    };
  }

  // ---- the tools, by name; each returns what to tell the agent

  const get_unit = () => { const { row, U } = current(); return unitOut(row, U); };

  const build_unit = (args) => changeUnit(args, 'build');

  const edit_unit = (args) => changeUnit(args, 'edit');

  const get_catalog = () => ({
    fixtures: FIXTURES.map((f) => ({
      type: f.type, name: f.name, group: f.group, width: f.w, depth: f.d, height: f.h, wall: !!f.wall, blocks_walking: f.blocks !== false,
      ...(f.about ? { about: f.about } : {}),
      ...(FIXTURE_OPTIONS[f.type] ? { options: Object.keys(FIXTURE_OPTIONS[f.type]) } : {}),
    })),
    fixture_options: Object.fromEntries(Object.entries(FIXTURE_OPTIONS).map(([type, spec]) => [type, Object.fromEntries(Object.entries(spec).map(([k, kind]) => [k, kind === 'len' ? 'inches' : kind === 'bool' ? 'true or false' : kind === 'segments' ? 'list of segments' : kind]))])),
    kitchen_segments: Object.entries(SEGMENTS).map(([kind, s]) => ({ kind, width: s.w, upper: s.upper, ...(s.about ? { about: s.about } : {}) })),
    opening_types: OPENING_TYPES,
    room_kinds: ROOM_KINDS,
    floors: FLOORS,
    finishes: FINISH_OPTIONS,
    furniture: CATALOG.map((c) => ({
      type: c.type, name: c.name, kind: c.kind, placement: c.place, group: c.group, width: c.w, depth: c.d, height: c.h,
      ...(c.place === 'wall' ? { elevation: c.y } : {}), ...(holdsItems(c.type) ? { holds_items: true } : {}),
      ...(c.act ? { use: USE[c.act] } : {}), ...(c.build === 'rug' ? { flat: true } : {}),
    })),
    placements: PLACEMENT_ABOUT,
    furniture_colors: SWATCHES.filter((s) => s.key).map((s) => s.key),
    furniture_materials: MATERIALS.map((m) => ({ material: m.key, name: m.name, ...(m.tint ? { takes_color: true } : {}) })),
    custom_furniture: 'For anything else, build it with create_asset and place it as type "asset:<asset_id>".',
    textures: `To match a real floor, counter, backsplash, cabinet, tile or fabric in the photos, make a texture with create_texture (patterns: ${PATTERNS.join(', ')}; layers: ${LAYERS.join(', ')}) and use it as "tex:<id>". Up to ${TEXTURE_LIMITS.textures} per unit.`,
    texture_examples: Object.values(PRESETS),
  });

  function set_info({ title, author }) {
    const { row } = write((doc) => {
      if (title !== undefined) doc.title = title;
      if (author !== undefined) doc.author = author;
    });
    return { title: row.title, author: row.author, view_url: viewUrl };
  }

  function place_items({ items }) {
    for (const spec of items) {
      if (!/^asset:/.test(spec.type) && !catalogByType[spec.type]) throw new ToolError(`"${spec.type}" is not in the catalog. Call get_catalog, or build it with create_asset.`);
      if (!spec.at && (!spec.on || ['floor', 'wall', 'ceiling'].includes(spec.on))) throw new ToolError(`A ${spec.type} needs at, unless on names the piece or fixture it rests on.`);
    }
    const { U: U0 } = current();
    const eased = [];
    const { row, result } = write((doc) => items.map((spec) => {
      const raw = toItem(spec, { uid: spec.id ?? randomId(8) });
      if (doc.items.some((i) => i.uid === raw.uid)) throw new ToolError(`There is already a piece with the id "${raw.uid}". Choose another id, or leave it out.`);
      if (raw.type === 'asset' && !doc.assets.some((a) => a.id === raw.asset)) throw new ToolError(`There is no asset "${raw.asset}" in this unit. create_asset returns the id to use.`);
      const item = cleanItem(raw, Object.fromEntries(doc.assets.map((a) => [a.id, a])));
      resolvePlacement(item, spec, doc, U0);
      if (onFloor(item)) settle(U0, doc, item, eased);
      doc.items.push(item);
      return item.uid;
    }));
    const U = built(row);
    return { placed: row.doc.items.filter((i) => result.includes(i.uid)).map(itemOut(U, row.doc.assets)), ...(eased.length ? { eased_off_walls: eased } : {}), problems: pieceProblems(U, row.doc, result), view_url: viewUrl };
  }

  function update_items({ items }) {
    const { U: U0 } = current();
    const eased = [];
    const carried = new Set();
    const { row } = write((doc) => {
      const assets = Object.fromEntries(doc.assets.map((a) => [a.id, a]));
      for (const spec of items) {
        const i = doc.items.findIndex((it) => it.uid === spec.id);
        if (i < 0) throw new ToolError(`There is no piece "${spec.id}" in this unit. get_unit lists them.`);
        const before = cleanItem(doc.items[i], assets);
        const item = cleanItem(toItem(spec, doc.items[i]), assets);
        if (!item) throw new ToolError(`"${spec.type}" is not in the catalog or its asset is missing.`);
        // Off the floor, anything that changes where or how big it is
        // puts it back on (or against) what holds it.
        const moved = ['at', 'width', 'depth', 'height', 'rotation', 'type'].some((k) => spec[k] !== undefined);
        if (spec.on !== undefined || spec.elevation !== undefined || (moved && !onFloor(before))) {
          // Unless told otherwise it stays on what holds it, at its height
          // (the same shelf); a surface piece moved elsewhere lands on what's there.
          const current = before.on ? before.on.replace(/^[pf]:/, '') : 'floor';
          const on = spec.on ?? (spec.at && placeOf(item, doc.assets) === 'surface' ? undefined : current);
          const keep = spec.on === undefined && before.y ? inch(before.y) : undefined;
          resolvePlacement(item, { ...spec, on, at: spec.at ?? [inch(item.x), inch(item.z)], elevation: spec.elevation ?? keep, keepRotation: true }, doc, U0);
        }
        if (onFloor(item)) settle(U0, doc, item, eased);
        doc.items[i] = item;
        carryChildren(before, item, doc, carried);
      }
    });
    const U = built(row);
    const ids = items.map((s) => s.id);
    return {
      updated: row.doc.items.filter((i) => ids.includes(i.uid)).map(itemOut(U, row.doc.assets)),
      ...(carried.size ? { carried: row.doc.items.filter((i) => carried.has(i.uid) && !ids.includes(i.uid)).map(itemOut(U, row.doc.assets)) } : {}),
      ...(eased.length ? { eased_off_walls: eased } : {}), problems: pieceProblems(U, row.doc, [...ids, ...carried]),
    };
  }

  function remove_items({ ids = [], all = false }) {
    const { row, result } = write((doc) => {
      const gone = new Set(all ? doc.items.map((it) => it.uid) : ids);
      const also = all ? [] : ids.flatMap((id) => descendants(id, doc.items)).filter((it) => !gone.has(it.uid));
      for (const it of also) gone.add(it.uid);
      const before = doc.items.length;
      doc.items = doc.items.filter((it) => !gone.has(it.uid));
      return { removed: before - doc.items.length, also: [...new Map(also.map((it) => [it.uid, { id: it.uid, name: it.name }])).values()] };
    });
    return { removed: result.removed, ...(result.also.length ? { also_removed: result.also } : {}), remaining: row.doc.items.length };
  }

  function create_asset({ name, description, asset_id, placement, kind, light_at, parts }) {
    const asset = cleanAsset({ id: asset_id, name, description, place: placement, kind, light: light_at, parts });
    if (!asset) throw new ToolError('None of those parts could be used.');
    write((doc) => {
      const others = doc.assets.filter((a) => a.id !== asset.id);
      if (others.length >= LIMITS.assets) throw new ToolError(`A unit holds at most ${LIMITS.assets} custom pieces.`);
      doc.assets = [...others, asset];
      // Placed copies keep their spot and take the new size.
      for (const it of doc.items) if (it.type === 'asset' && it.asset === asset.id) Object.assign(it, { w: asset.w / 12, d: asset.d / 12, h: asset.h / 12 });
    });
    return assetOut(asset);
  }

  function find_spots({ width, depth, room, against_wall = true, count = 5 }) {
    const { row, U } = current();
    if (room && !U.rooms.some((r) => r.id === room || r.name.toLowerCase() === room.toLowerCase())) throw new ToolError(`There is no room "${room}". Rooms: ${U.rooms.map((r) => r.id).join(', ') || 'none yet'}.`);
    const spots = findSpots({ w: ft(width), d: ft(depth), room, againstWall: against_wall, items: row.doc.items, assets: row.doc.assets, count, U });
    return {
      spots: spots.map((s) => ({ at: [inch(s.x), inch(s.z)], rotation: s.rot, room: s.roomId })),
      ...(spots.length ? {} : { note: 'Nothing fits there. Try another room, a smaller size, against_wall: false, or move other pieces.' }),
    };
  }

  function check_unit() {
    const { row, U } = current();
    const items = row.doc.items;
    const pieces = items.map((it) => ({
      id: it.uid, name: it.name, room: U.roomAt(it.x, it.z)?.id ?? null,
      on: it.on ? it.on.replace(/^[pf]:/, '') : 'floor', ...(it.y ? { elevation: inch(it.y) } : {}),
      clear_floor: isFlat(it, row.doc.assets) || !onFloor(it) ? null : Object.fromEntries(clearances(it, items, U.obstacles, row.doc.assets).map((c) => [c.side, inch(c.dist)])),
      problems: problems(it, items, U, row.doc.assets),
    }));
    return { unit_problems: U.problems, pieces, pieces_with_problems: pieces.filter((p) => p.problems.length).length };
  }

  // { image: PNG bytes, text }. overlay (the skill's): a floor plan picture to
  // lay over the drawing, as src/drawing.js takes it.
  function render_plan(args, { overlay } = {}) {
    beforeRender();
    const { row, U } = current();
    const image = png(detailSvg({ title: row.title, author: row.author, unit: row.doc.unit, items: row.doc.items, assets: row.doc.assets, overlay }, U));
    const text = `${U.rooms.length} rooms, ${U.openings.length} doors and windows, ${U.fixtures.length} fixtures, ${row.doc.items.length} pieces of furniture.${viewUrl ? ` Open it in 3D: ${viewUrl}` : ''}`;
    return { image, text };
  }

  // A texture made or changed, used where apply_to says, and its preview:
  // { image: PNG bytes, text }. sample (the skill's): the person's photo as
  // { rgba, w, h, href }, compared with it and shown beside it.
  function create_texture(args, { sample } = {}) {
    beforeRender();
    const { texture_id, apply_to, ...recipe } = args;
    let made, report;
    write((doc) => {
      report = { dropped: [], applied: [], not_found: [] };
      const spec = structuredClone(doc.unit);
      const list = spec.textures ?? [];
      if (texture_id && !list.some((t) => t.id === texture_id)) throw new ToolError(`This unit has no texture "${texture_id}" (get_unit lists them). Leave texture_id out to make a new one.`);
      if (!texture_id && list.length >= TEXTURE_LIMITS.textures) throw new ToolError(`A unit holds at most ${TEXTURE_LIMITS.textures} textures. Change one with texture_id, or remove one with edit_unit.`);
      const others = list.filter((t) => t.id !== texture_id);
      const t = cleanTexture({ ...recipe, id: texture_id }, new Set(others.map((x) => x.id)), report.dropped);
      spec.textures = texture_id ? list.map((x) => (x.id === texture_id ? t : x)) : [...list, t];
      const ref = `tex:${t.id}`;
      for (const k of apply_to?.finishes ?? []) { spec.finishes[k] = ref; report.applied.push(`finishes.${k}`); }
      for (const id of apply_to?.rooms ?? []) {
        const r = spec.rooms.find((x) => x.id === id);
        if (r) { r.floor = ref; report.applied.push(`room ${id}`); } else report.not_found.push(`No room has the id "${id}".`);
      }
      for (const id of apply_to?.fixtures ?? []) {
        const f = spec.fixtures.find((x) => x.id === id);
        if (f) { f.color = ref; report.applied.push(`fixture ${id}`); } else report.not_found.push(`No fixture has the id "${id}".`);
      }
      for (const id of apply_to?.pieces ?? []) {
        const it = doc.items.find((x) => x.uid === id);
        if (it) { it.material = ref; report.applied.push(`piece ${id}`); } else report.not_found.push(`No piece has the id "${id}".`);
      }
      const { unit, dropped } = cleanUnit(spec);
      report.dropped.push(...dropped);
      doc.unit = unit;
      made = unit.textures.find((x) => x.id === t.id);
    });
    // Wide enough to see the pattern repeat, close enough to see its detail.
    const across = { floor: 60, counter: 36, tile: 36, cabinet: 30, wall: 60, wood: 30, stone: 36, fabric: 12, leather: 12, rug: 36, metal: 12, other: 30 }[made.for] ?? 30;
    const wide = patch(made, { inches: across, px: 420 }), close = patch(made, { inches: across / 4, px: 220 });
    const url = (p) => `data:image/png;base64,${encodePng(p.rgba, p.w, p.h).toString('base64')}`;
    const stats = imageStats(wide.rgba, wide.w, wide.h);
    const look = { mean: stats.mean, contrast: stats.contrast, palette: stats.palette.map(({ color, share }) => ({ color, share: Math.round(share * 100) / 100 })) };
    const image = png(textureSvg({ name: made.name, wide: { href: url(wide), inches: across }, close: { href: url(close), inches: across / 4 }, photo: sample ? { href: sample.href } : null }));
    const comparison = sample ? compareStats(imageStats(sample.rgba, sample.w, sample.h), stats) : null;
    const text = pretty({
      texture_id: made.id, use_as: `tex:${made.id}`, repeat_inches: repeatOf(made),
      ...(report.applied.length ? { applied_to: report.applied } : {}),
      ...(report.not_found.length ? { not_found: report.not_found } : {}),
      ...(report.dropped.length ? { dropped: report.dropped } : {}),
      ...(comparison ? { against_the_photo: comparison } : { as_drawn: look }),
      next: comparison
        ? 'Look at the picture beside the photo. Follow the hints, check the pattern\'s scale and shapes by eye, and call create_texture again with texture_id until it matches.'
        : 'Compare the picture with the person\'s photo: colors, contrast, the size of planks or tiles, grain and veins. Call create_texture again with texture_id to adjust it. Use it as use_as in finishes, a room\'s floor, a fixture\'s color or a piece\'s material.',
      ...(viewUrl ? { view_url: viewUrl } : {}),
    });
    return { image, text };
  }

  return { get_unit, build_unit, edit_unit, get_catalog, set_info, place_items, update_items, remove_items, create_asset, create_texture, find_spots, check_unit, render_plan };
}
