// MCP over Streamable HTTP, stateless: every POST gets a fresh server and
// transport, so there is no session to keep or lose on a restart.
//
// Each unit has its own MCP address, mcp/<id>/<key>, with the unit's edit key
// in it: a connector added with that address can change that unit and no
// other, so no tool takes a unit argument. Everything is in inches and
// snake_case here; src/unit.js fromInches / toInches convert to the stored
// feet. Rate limits per address keep any one client from flooding the box.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import { CATALOG, catalogByType, SWATCHES, isFlat } from '../src/catalog.js';
import { cleanAsset, randomId, SHAPES, FINISHES, LIMITS } from '../src/design.js';
import {
  ROOM_KINDS, FLOORS, OPENING_TYPES, FIXTURES, fixtureByType, SEGMENTS, FIXTURE_OPTIONS, FINISH_OPTIONS, UNIT_LIMITS,
  cleanUnit, buildUnit, fromInches, toInches, snapToWall,
} from '../src/unit.js';
import { problems, clearances, findSpots, settleOffWalls } from '../src/fit.js';
import { AppError, json, readBody, limit } from './http.js';
import { detailSvg, png } from './render.js';
import { EXAMPLE_ID } from './service.js';

const INSTRUCTIONS = `3D Living Space is a to-scale 3D model of one person's apartment (a "unit") that they explore, furnish and share in their browser. This connection belongs to one unit and can change only that unit. Whatever you change shows up in their browser within a few seconds.

Units are inches. x runs east (left to right on the floor plan), z runs south (top to bottom), y is up. Put the origin at the plan's top-left (north-west) outside corner so everything has positive coordinates. Rotations are degrees clockwise on the plan: 0 means a fixture's or a piece's front faces south (down the plan), 90 west, 180 north, 270 east.

Building a unit from a floor plan and photos:
1. Call get_unit and get_catalog.
2. Rooms are the clear floor inside the walls. Use the room sizes printed on the plan (width x length, wall to wall). Where two rooms share a wall, leave the wall's thickness between their outlines (interior walls are about 4.5 in); where rooms are open to each other (a kitchen open to the living room), let the outlines touch. Outside walls are added automatically around everything (exterior_wall thick). Lay rooms out by adding up sizes and wall thicknesses along each row of rooms, using the plan's proportions to place them; don't rely on reading pixel positions alone.
3. Call build_unit with the rooms; the doors and windows, each placed by its center point in its wall plus its width (doors take hinge and opens as compass directions: which end the hinges are on, which way it swings); and the fixtures: the kitchen as kitchen-run fixtures listing cabinets and appliances left to right as you face them, bath fixtures (toilet, vanity, tub or shower), laundry, closet rods. Set the ceiling height, door height and window sill and head; the photos often show them (doors are usually 80 in tall).
4. Call render_plan and compare it with the floor plan side by side. Fix positions and sizes with edit_unit, and fix every problem that build_unit, edit_unit and check_unit report.
5. Set finishes from the photos: floors per room, wall paint, cabinets, counters, backsplash, appliances, hardware. Ask the person to look at it in 3D and tell you what is off.

Furnishing: pick pieces from get_catalog and place them with place_items; for anything the catalog lacks, build it with create_asset and place it. Leave 30 to 36 in to walk, keep door swings clear, and check with check_unit and render_plan. find_spots suggests where a footprint fits.

Units are shared publicly by link: never put a street address, building name or unit number in any name.`;

const NO_UNIT = 'This MCP address doesn\'t match a unit: the unit doesn\'t exist or the key in the address is wrong. Each unit has its own MCP address (…/mcp/<unit id>/<key>); open the unit in 3D Living Space and copy it from the unit\'s Share tab.';
const NO_EXAMPLE = 'The example unit can\'t be changed, so it has no MCP address. In 3D Living Space, choose "Work off the example unit" to get your own copy, and copy its MCP address from the Share tab.';

const inch = (ft) => Math.round(ft * 12 * 100) / 100;  // as src/unit.js toInches
const ft = (inches) => inches / 12;
const box = ([x0, z0, x1, z1]) => ({ x0: inch(x0), z0: inch(z0), x1: inch(x1), z1: inch(z1) });
const sqft = (a) => Math.round(a * 10) / 10;
const COMPASS = { north: [0, -1], south: [0, 1], east: [1, 0], west: [-1, 0] };
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
function pretty(data) {
  return JSON.stringify(data, null, 1)
    .replace(FLAT, (m) => (oneLine(m).length <= 120 ? oneLine(m) : m))
    .replace(NESTED, oneLine)
    .replace(OBJECT, (m) => (oneLine(m).length <= 200 ? oneLine(m) : m));
}
const ok = (data) => ({ content: [{ type: 'text', text: pretty(data) }] });
async function run(fn) {
  try {
    return await fn();
  } catch (error) {
    if (error instanceof AppError) return { isError: true, content: [{ type: 'text', text: error.message }] };
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Schemas. Claude reads every description, so each says what the field is,
// its unit and its default.

const XZ = () => z.array(z.number()).length(2);
const ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,23}$/;
const idOf = (about) => z.string().regex(ID, 'Ids are 1 to 24 letters, digits, - or _, starting with a letter or digit.').describe(about);
const hexColor = z.string().regex(/^#[0-9a-fA-F]{6}$/, 'A color is "#rrggbb".');

const finishesShape = z.object({
  walls: hexColor.optional().describe('Wall paint color, "#rrggbb" (default #f2f1ee, a warm white).'),
  floor: z.enum(FLOORS).optional().describe('Floor everywhere a room doesn\'t set its own. Baths default to tile and balconies to deck.'),
  cabinets: z.union([z.enum(FINISH_OPTIONS.cabinets), hexColor]).optional().describe(`Kitchen and bath cabinets: ${FINISH_OPTIONS.cabinets.join(', ')}, or a paint color "#rrggbb".`),
  counters: z.enum(FINISH_OPTIONS.counters).optional().describe('Countertops.'),
  backsplash: z.enum(FINISH_OPTIONS.backsplash).optional().describe('Kitchen backsplash: subway tile, a stone slab, or none.'),
  appliances: z.enum(FINISH_OPTIONS.appliances).optional().describe('Fridge, range, dishwasher and microwave.'),
  hardware: z.enum(FINISH_OPTIONS.hardware).optional().describe('Cabinet pulls, faucets and door handles.'),
  tile: z.enum(FINISH_OPTIONS.tile).optional().describe('Bathroom wall and shower tile.'),
});

const settingsShape = {
  name: z.string().max(UNIT_LIMITS.name).optional().describe('A short name for the unit, like "2 bed / 2 bath" or "Sunny one bedroom". Never an address, building name or unit number.'),
  beds: z.number().min(0).max(20).optional().describe('Bedrooms, as the listing states (0 for a studio).'),
  baths: z.number().min(0).max(20).optional().describe('Bathrooms, as the listing states; halves allowed (1.5).'),
  sqft: z.number().min(50).max(50000).optional().describe('The area the listing or plan states, sq ft. The rooms\' own area is computed separately.'),
  ceiling_height: z.number().min(78).max(240).optional().describe('Ceiling height, inches (default 108, 9 ft).'),
  door_height: z.number().min(66).max(240).optional().describe('Height of doors and open doorways, inches (default 80; 96 in many newer buildings).'),
  window_sill: z.number().min(0).max(228).optional().describe('Height of window sills above the floor, inches (default 24).'),
  window_head: z.number().min(6).max(240).optional().describe('Height of the tops of windows, inches (default 80, often level with the doors).'),
  exterior_wall: z.number().min(2).max(30).optional().describe('Thickness of the outside walls drawn around the unit, inches (default 8).'),
  floor_level: z.number().int().min(1).max(80).optional().describe('Which floor of the building the unit is on (1 = ground floor); sets the view out of the windows.'),
  finishes: finishesShape.optional().describe('Finishes; only the ones you pass change.'),
};

const roomFields = {
  id: idOf('Short id you choose, like "living", "bed1" or "bath2". Openings, problems and edit_unit refer to it.'),
  name: z.string().max(UNIT_LIMITS.roomName).describe('Shown on the plan and in 3D, like "Primary Bedroom". Never an address or unit number.'),
  kind: z.enum(ROOM_KINDS).describe('What the room is. It sets defaults: baths get tile floors; closets, storage, pantries, utility rooms and laundry get small labels and no furniture suggestions; a balcony is outdoors and gets no outside wall.'),
  outline: z.array(XZ()).min(3).max(UNIT_LIMITS.points).describe('Corners of the clear floor inside the walls, in order around the room, each [x, z] in inches. A rectangle is four corners, [[x0, z0], [x1, z0], [x1, z1], [x0, z1]]; an L-shaped room has six.'),
  floor: z.enum(FLOORS).optional().describe('This room\'s floor, when it differs from the unit\'s floor finish (baths default to tile, balconies to deck).'),
  ceiling_height: z.number().min(72).max(240).optional().describe('This room\'s ceiling height in inches, when it differs from the unit\'s.'),
  plan_size: z.string().max(30).optional().describe('The size printed on the floor plan, as written, like 12\'7" x 19\'9". The outline is checked against it.'),
  label_at: XZ().optional().describe('Where the room\'s name goes, [x, z] in inches, when the middle is a bad spot.'),
};

const wallFields = {
  id: idOf('Short id you choose, like "pier1" or "half-wall".'),
  from: XZ().describe('One end of the wall\'s center line, [x, z] in inches.'),
  to: XZ().describe('The other end of the wall\'s center line, [x, z] in inches.'),
  thickness: z.number().positive().max(48).optional().describe('Inches (default 4.5).'),
  height: z.number().positive().max(240).optional().describe('Inches. Lower than the ceiling makes a half wall or pony wall. Default: up to the ceiling.'),
};

const openingFields = {
  id: idOf('Short id you choose, like "entry", "bed1-door" or "living-win".'),
  type: z.enum(OPENING_TYPES.map((o) => o.type)).describe(OPENING_TYPES.map((o) => `${o.type}: ${o.about}`).join(' ')),
  at: XZ().describe('The center of the opening, [x, z] in inches: a point in the wall (anywhere across its thickness, or on the room\'s edge), at the middle of the opening along the wall.'),
  width: z.number().min(12).max(240).describe('Width of the opening along the wall, inches. Interior doors are usually 28 to 32, entry doors 36, closet doors 48 to 72; windows as the plan draws them.'),
  name: z.string().max(UNIT_LIMITS.text).optional().describe('Like "Bedroom 2 door". Default: made from the rooms it joins.'),
  head_height: z.number().min(12).max(240).optional().describe('Height of the top of the opening, inches. Default: door_height for doors and doorways, window_head for windows.'),
  sill_height: z.number().min(0).max(180).optional().describe('Windows only: height of the sill above the floor, inches. Default: window_sill.'),
  hinge: z.enum(Object.keys(COMPASS)).optional().describe('Hinged doors: the end of the opening the hinges are on, as a compass direction along the wall (a door in a wall that runs east-west hinges at its east or west end; in a north-south wall, at its north or south end). Default: the end nearer a corner.'),
  opens: z.string().max(24).optional().describe('Doors: which way the door swings (or folds, or which side a barn door hangs on), as a compass direction across the wall (north, south, east or west), or the id of the room it opens into. Default: into the more private or smaller room; doors to the outside open in.'),
  open_angle: z.number().min(0).max(120).optional().describe('Hinged doors: how far the door stands open in 3D, degrees (0 closed, 90 wide open). Default: open for rooms, closed for closets and the entry.'),
  panes: z.number().int().min(1).max(8).optional().describe('Windows: how many panes side by side, evenly split. Default by width: 1 up to 42 in, 2 up to 84 in, else 3.'),
  mullions: z.array(z.number().min(0.02).max(0.98)).max(7).optional().describe('Windows with uneven panes: where each vertical bar is, as a fraction of the width from the west end (or the north end, in a wall that runs north-south), like [0.58]. Overrides panes.'),
  transom_height: z.number().min(6).max(180).optional().describe('Windows: height of a horizontal bar across the window, inches, if it has one.'),
};

const OPTION_ABOUT = {
  segments: 'The run\'s parts left to right as you face it, cabinets and appliances alike: each a kind (like "sink") or {kind, width, upper, drawers}. Kinds and their usual widths are in get_catalog (kitchen_segments); whatever width is left over becomes base cabinet.',
  uppers: 'Wall cabinets above the run. Default: when its back is against a wall.',
  upper_bottom: 'Height of the wall cabinets\' undersides, inches (default 54).',
  upper_top: 'Height of the wall cabinets\' tops, inches (default 96, or the ceiling if lower).',
  soffit: 'Close the gap between the wall cabinets and the ceiling. Default: when that gap is 15 in or less.',
  backsplash: 'Backsplash behind the counter. Default: the unit\'s backsplash finish when against a wall.',
  hood: 'What is above the range: an over-the-range microwave, a hood, or nothing (default microwave).',
  drawers: 'A drawer at the top of the base cabinets.',
  overhang: 'How far the counter overhangs the seating side, inches.',
  sink: 'It has a sink.',
  cooktop: 'It has a cooktop.',
  bottom: 'Height of its underside above the floor, inches.',
  sinks: 'Number of sinks, 1 or 2.',
  mirror: 'A mirror on the wall above it.',
  light: 'A light bar above the mirror.',
  shower: 'A shower head over the tub, with tile around it.',
  enclosure: 'Shower curtain, glass screen, or nothing.',
  tile_height: 'Height of the tile around the tub, inches.',
  glass: 'Glass on the open sides: a fixed panel, a door, or none.',
  entry: 'Which side you step in from, as you face it.',
  curb: 'A curb at the entry.',
  double: 'Two rods, one above the other.',
  mantel: 'A mantel shelf.',
};
const SEGMENT_KINDS = Object.keys(SEGMENTS);
const segmentSchema = z.union([
  z.enum(SEGMENT_KINDS),
  z.object({
    kind: z.enum(SEGMENT_KINDS).describe('What this part is.'),
    width: z.number().positive().max(144).optional().describe('Inches. Default: the usual width for its kind (get_catalog).'),
    upper: z.boolean().optional().describe('A wall cabinet above this part. Default by kind (none over a range, fridge or tall cabinet).'),
    drawers: z.boolean().optional().describe('base: a drawer above the doors.'),
  }),
]);
const optionFields = (() => {
  const keys = {};
  for (const [type, spec] of Object.entries(FIXTURE_OPTIONS)) for (const [key, kind] of Object.entries(spec)) (keys[key] ??= { kind, types: [] }).types.push(type);
  return Object.fromEntries(Object.entries(keys).map(([key, { kind, types }]) => {
    const base = kind === 'bool' ? z.boolean() : kind === 'len' ? z.number().min(0).max(240)
      : kind === 'segments' ? z.array(segmentSchema).max(24)
      : kind.every((v) => typeof v === 'string') ? z.enum(kind) : z.union(kind.map((v) => z.literal(v)));
    return [key, base.optional().describe(`${types.join(', ')} only. ${OPTION_ABOUT[key] ?? ''}`.trim())];
  }));
})();

const fixtureFields = {
  id: idOf('Short id you choose, like "kitchen-north", "toilet1" or "closet-rod2".'),
  type: z.enum(FIXTURES.map((f) => f.type)).describe('Fixture type, from get_catalog (fixtures).'),
  at: XZ().describe('Center of the fixture\'s footprint, [x, z] in inches.'),
  width: z.number().positive().max(480).optional().describe('Side to side as you face its front, inches; for a kitchen-run, the length of the run. Default: the catalog size.'),
  depth: z.number().positive().max(240).optional().describe('Back to front, inches (counters are about 25.5). Default: the catalog size.'),
  height: z.number().min(0).max(240).optional().describe('Inches: counter height for cabinets, rod height for closets, how high the tile and glass go for showers and tiled walls. Default: the catalog size.'),
  rotation: z.number().optional().describe('Degrees clockwise on the plan (default 0). 0 = its front faces south, so its back is on a north wall; 90 = front faces west (back on an east wall); 180 = faces north (back on a south wall); 270 = faces east (back on a west wall).'),
  name: z.string().max(UNIT_LIMITS.text).optional().describe('Like "Kitchen: sink wall" or "Hall bath vanity".'),
  color: z.string().optional().describe(`This fixture's cabinet color: ${FINISH_OPTIONS.cabinets.join(', ')} or "#rrggbb". Default: the unit's cabinets finish.`),
  snap: z.boolean().optional().describe('Fixtures that stand against a wall (wall: true in get_catalog) are slid back until they touch the wall behind them, when one is within a foot. Pass false to keep exactly the position you give. Not stored.'),
  ...optionFields,
};

const labelFields = {
  text: z.string().min(1).max(UNIT_LIMITS.text).describe('Like "Kitchen" or "Dining": an extra name inside a room used for more than one thing.'),
  at: XZ().describe('Where it goes, [x, z] in inches.'),
};

// edit_unit: every field optional except the id that picks what to change.
const patchOf = (fields, what) => z.object(Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, k === 'id' ? idOf(`Which ${what} to change; a new id adds one.`) : v.optional()])));

const itemShape = {
  at: XZ().describe('The center of the piece\'s footprint, [x, z] in inches.'),
  rotation: z.number().optional().describe('Degrees clockwise on the plan; 0 = its front faces south, 90 west, 180 north, 270 east. A bed against a north wall is 0, headboard on the wall. Default 0.'),
  width: z.number().positive().max(360).optional().describe('Side to side as you face its front, inches. Default: the catalog or asset size.'),
  depth: z.number().positive().max(360).optional().describe('Back to front, inches (a bed\'s length).'),
  height: z.number().positive().max(108).optional().describe('Inches.'),
  color: z.string().optional().describe(`A swatch (${SWATCHES.filter((s) => s.key).map((s) => s.key).join(', ')}) or "#rrggbb". Omit for the piece's own finish.`),
  name: z.string().max(LIMITS.name).optional().describe('Label shown in the app, like "Grandma\'s armchair".'),
};

const LISTS = { rooms: 'room', walls: 'wall', openings: 'opening', fixtures: 'fixture' };

// ---------------------------------------------------------------------------

export function createMcp(config, units, limiters) {
  // One server per request, bound to the unit in its address, so tools can see
  // the caller's address for the rate limits.
  function buildServer(id, key, origin, ip) {
    const server = new McpServer({ name: '3d-living-space', version: '2.0.0' }, { instructions: INSTRUCTIONS });
    const viewUrl = units.viewUrl(id, origin);
    const current = () => { const row = units.get(id); return { row, U: units.built(row) }; };
    const write = (change) => { limit(limiters.write, ip, 'changes'); return units.mutate(id, key, change); };

    const itemOut = (U) => (it) => ({
      id: it.uid, type: it.type === 'asset' ? `asset:${it.asset}` : it.type, name: it.name,
      at: [inch(it.x), inch(it.z)], width: inch(it.w), depth: inch(it.d), height: inch(it.h), rotation: it.rot,
      color: it.color ?? undefined, room: U.roomAt(it.x, it.z)?.id ?? null,
    });
    const pieceProblems = (U, items, only = null) => items
      .filter((it) => !only || only.includes(it.uid))
      .map((it) => [it, problems(it, items, U)]).filter(([, list]) => list.length)
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
      if (spec.name !== undefined) out.name = spec.name;
      return out;
    }

    // A piece set a little into a wall or its trim is eased out (src/fit.js).
    function settle(U, doc, item, eased) {
      const p = settleOffWalls(item, U);
      if (!p) return;
      eased.push({ id: item.uid, name: item.name ?? item.type, from: [inch(item.x), inch(item.z)], to: [inch(p.x), inch(p.z)] });
      item.x = Math.round(p.x * 1e4) / 1e4; item.z = Math.round(p.z * 1e4) / 1e4;
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
        furniture: items.map(itemOut(U)),
        assets: row.doc.assets.map(assetOut),
        problems: [...U.problems, ...pieceProblems(U, items)],
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
    const assetOut = (a) => ({ asset_id: a.id, name: a.name, description: a.description, width: a.w, depth: a.d, height: a.h, parts: a.parts.length, place_as: `asset:${a.id}` });

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
      const U = units.built(row);
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
        problems: [...U.problems, ...pieceProblems(U, row.doc.items)],
        next: 'Call render_plan and compare it with the floor plan side by side. Fix positions and sizes with edit_unit, and fix every problem listed here.',
        view_url: viewUrl,
      };
    }

    // ---- the unit

    server.registerTool('get_unit', {
      title: 'Get the unit',
      description: 'Everything about this unit, in inches: settings (heights, finishes), rooms (outline, size, area, bounds), extra walls, openings (doors, windows, doorways: the rooms each joins, its wall thickness, hinge end and the way it opens as compass directions), fixtures (and which sides touch a wall), labels, placed furniture, custom assets, and every problem found. Start here.',
      inputSchema: {},
      annotations: { readOnlyHint: true },
    }, () => run(() => { const { row, U } = current(); return ok(unitOut(row, U)); }));

    server.registerTool('build_unit', {
      title: 'Build the unit',
      description: `Lay the unit out, usually in one call from the floor plan. Sets the unit-wide settings you pass (only those change) and REPLACES each list you pass (rooms, walls, openings, fixtures, labels) with the new one; lists you leave out stay as they are. For changes after that, edit_unit changes single rooms, doors or fixtures by id.

Fixtures that stand against a wall (wall: true in get_catalog) are slid back flush against the wall behind them unless you pass snap: false; "moved" says what moved.

Returns the counts, each room's size [width, depth] in inches and area, what was dropped and why, what moved, and the problems found (overlapping rooms, doors not in a wall, fixtures in walls, sizes that don't match plan_size…). Then call render_plan and compare it with the floor plan.`,
      inputSchema: {
        ...settingsShape,
        rooms: z.array(z.object(roomFields)).max(UNIT_LIMITS.rooms).optional().describe('Every room, as clear floor outlines. REPLACES all rooms.'),
        walls: z.array(z.object({ ...wallFields, id: wallFields.id.optional() })).max(UNIT_LIMITS.walls).optional().describe('Extra walls only, like a pier, a half wall or a wall standing inside a room. Walls between rooms and the outside walls come from the room outlines; don\'t list them. REPLACES all extra walls.'),
        openings: z.array(z.object({ ...openingFields, id: openingFields.id.optional() })).max(UNIT_LIMITS.openings).optional().describe('Every door, window and open doorway. REPLACES all of them.'),
        fixtures: z.array(z.object({ ...fixtureFields, id: fixtureFields.id.optional() })).max(UNIT_LIMITS.fixtures).optional().describe('Every built-in fixture: kitchen runs, island, bath fixtures, laundry, closet rods and shelves, fireplace, columns. REPLACES all of them.'),
        labels: z.array(z.object(labelFields)).max(UNIT_LIMITS.labels).optional().describe('Extra names shown on the plan, like "Kitchen" and "Dining" inside one big room. REPLACES all labels.'),
      },
      annotations: { destructiveHint: true, idempotentHint: true },
    }, (args) => run(() => ok(changeUnit(args, 'build'))));

    server.registerTool('edit_unit', {
      title: 'Edit the unit',
      description: `Change parts of the unit by id: settings you pass change; rooms, walls, openings and fixtures you pass are matched by id and only the fields you give change (an id that doesn't exist yet adds a new one, which then needs its required fields: a room's name, kind and outline; an opening's type, at and width; a fixture's type and at). labels, if passed, replace all labels. remove takes ids of rooms, walls, openings or fixtures.

Fixtures that stand against a wall are slid flush against the wall behind them when you add them or change their position, size, rotation or type, unless you pass snap: false.

Returns the same report as build_unit. Check the result with render_plan.`,
      inputSchema: {
        ...settingsShape,
        rooms: z.array(patchOf(roomFields, 'room')).max(UNIT_LIMITS.rooms).optional().describe('Rooms to change or add, by id.'),
        walls: z.array(patchOf(wallFields, 'wall')).max(UNIT_LIMITS.walls).optional().describe('Extra walls to change or add, by id.'),
        openings: z.array(patchOf(openingFields, 'opening')).max(UNIT_LIMITS.openings).optional().describe('Doors, windows and doorways to change or add, by id.'),
        fixtures: z.array(patchOf(fixtureFields, 'fixture')).max(UNIT_LIMITS.fixtures).optional().describe('Fixtures to change or add, by id. Options (segments, hood…) are fields of the fixture; passing segments replaces the whole list.'),
        labels: z.array(z.object(labelFields)).max(UNIT_LIMITS.labels).optional().describe('All extra labels; REPLACES the current ones.'),
        remove: z.array(z.string()).max(200).optional().describe('Ids of rooms, walls, openings or fixtures to remove.'),
      },
      annotations: { destructiveHint: true },
    }, (args) => run(() => ok(changeUnit(args, 'edit'))));

    server.registerTool('get_catalog', {
      title: 'Get the catalog',
      description: 'What you can build and place, with default sizes in inches (width × depth × height): fixture types and their options, kitchen-run segments with their usual widths, opening types, room kinds, floors, finish options, and the furniture catalog with its colors. Every size can be changed.',
      inputSchema: {},
      annotations: { readOnlyHint: true },
    }, () => run(() => ok({
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
      furniture: CATALOG.map((c) => ({ type: c.type, name: c.name, group: c.group, width: c.w, depth: c.d, height: c.h, flat: c.build === 'rug' })),
      furniture_colors: SWATCHES.filter((s) => s.key).map((s) => s.key),
      custom_furniture: 'For anything else, build it with create_asset and place it as type "asset:<asset_id>".',
    })));

    server.registerTool('set_info', {
      title: 'Name the unit',
      description: 'Set the title shown on the unit\'s page and link previews, and/or the author ("by …"). Never an address, building name or unit number.',
      inputSchema: {
        title: z.string().max(LIMITS.title).optional().describe('Like "My place, reimagined" or "Sunny one bedroom".'),
        author: z.string().max(LIMITS.author).optional().describe('The person\'s first name or handle, shown as "by …".'),
      },
    }, ({ title, author }) => run(() => {
      const { row } = write((doc) => {
        if (title !== undefined) doc.title = title;
        if (author !== undefined) doc.author = author;
      });
      return ok({ title: row.title, author: row.author, view_url: viewUrl });
    }));

    // ---- furniture

    server.registerTool('place_items', {
      title: 'Place furniture',
      description: 'Add pieces. Each needs a type (from get_catalog furniture, or "asset:<asset_id>" for a piece made with create_asset) and a center at [x, z] in inches; size defaults to the catalog or asset size. A piece set slightly into a wall or its trim (baseboards stand about ½ in proud of the wall, door casings ¾ in, window stools 1¼ in) is eased out up to 3 in; eased_off_walls lists those. Returns the new pieces with their ids and any problems: running into walls or fixtures, overlapping other pieces, blocking a door.',
      inputSchema: {
        items: z.array(z.object({ type: z.string().describe('Catalog type, or "asset:<asset_id>".'), ...itemShape })).min(1).max(60).describe('Pieces to add.'),
      },
    }, ({ items }) => run(() => {
      for (const spec of items) {
        if (!/^asset:/.test(spec.type) && !catalogByType[spec.type]) throw new AppError(400, `"${spec.type}" is not in the catalog. Call get_catalog, or build it with create_asset.`);
      }
      const { U: U0 } = current();
      const eased = [];
      const { row, result } = write((doc) => items.map((spec) => {
        const item = toItem(spec, { uid: randomId(8) });
        if (item.type === 'asset' && !doc.assets.some((a) => a.id === item.asset)) throw new AppError(400, `There is no asset "${item.asset}" in this unit. create_asset returns the id to use.`);
        settle(U0, doc, item, eased);
        doc.items.push(item);
        return item.uid;
      }));
      const U = units.built(row);
      return ok({ placed: row.doc.items.filter((i) => result.includes(i.uid)).map(itemOut(U)), ...(eased.length ? { eased_off_walls: eased } : {}), problems: pieceProblems(U, row.doc.items, result), view_url: viewUrl });
    }));

    server.registerTool('update_items', {
      title: 'Move or change furniture',
      description: 'Change placed pieces by id: move (at), turn (rotation), resize, recolor, rename or change type. Only the fields you pass change. Returns the pieces and any problems.',
      inputSchema: {
        items: z.array(z.object({
          id: z.string().describe('The piece\'s id, from get_unit or place_items.'),
          type: z.string().optional().describe('Catalog type, or "asset:<asset_id>".'),
          ...Object.fromEntries(Object.entries(itemShape).map(([k, v]) => [k, v.optional()])),
        })).min(1).max(150).describe('Pieces to change.'),
      },
    }, ({ items }) => run(() => {
      const { U: U0 } = current();
      const eased = [];
      const { row } = write((doc) => {
        for (const spec of items) {
          const i = doc.items.findIndex((it) => it.uid === spec.id);
          if (i < 0) throw new AppError(400, `There is no piece "${spec.id}" in this unit. get_unit lists them.`);
          doc.items[i] = toItem(spec, doc.items[i]);
          settle(U0, doc, doc.items[i], eased);
        }
      });
      const U = units.built(row);
      const ids = items.map((s) => s.id);
      return ok({ updated: row.doc.items.filter((i) => ids.includes(i.uid)).map(itemOut(U)), ...(eased.length ? { eased_off_walls: eased } : {}), problems: pieceProblems(U, row.doc.items, ids) });
    }));

    server.registerTool('remove_items', {
      title: 'Remove furniture',
      description: 'Remove pieces by id, or every piece with all: true. Fixtures (kitchen, bath…) are part of the unit: remove those with edit_unit.',
      inputSchema: {
        ids: z.array(z.string()).optional().describe('Ids of pieces to remove.'),
        all: z.boolean().optional().describe('Remove every piece of furniture.'),
      },
      annotations: { destructiveHint: true },
    }, ({ ids = [], all = false }) => run(() => {
      const { row, result } = write((doc) => {
        const before = doc.items.length;
        doc.items = all ? [] : doc.items.filter((it) => !ids.includes(it.uid));
        return before - doc.items.length;
      });
      return ok({ removed: result, remaining: row.doc.items.length });
    }));

    server.registerTool('create_asset', {
      title: 'Build a custom piece',
      description: `Make a 3D piece out of primitives when the catalog has nothing like it (a specific chair, a piano, a cat tree…), then place it with place_items as type "asset:<asset_id>".

Parts are in inches in the piece's own frame: +x to the piece's right as you face its front, +y up, +z toward its front. The piece is re-centered so its footprint is centered and its lowest point is on the floor, so only the parts' positions relative to each other matter. Real proportions matter more than detail: a dining chair is about 18 wide, 20 deep, 34 tall with its seat at 18. Pass asset_id to replace a piece you made earlier; placed copies update too.`,
      inputSchema: {
        name: z.string().max(LIMITS.name).describe('Like "Bar stool" or "Upright piano".'),
        description: z.string().max(LIMITS.description).optional().describe('What it is, in a sentence.'),
        asset_id: z.string().optional().describe('Replace this existing asset instead of making a new one.'),
        parts: z.array(z.object({
          shape: z.enum(SHAPES).describe('box, cylinder, cone (its tip points up) or sphere.'),
          size: z.array(z.number()).length(3).describe('[x, y, z] inches: a box\'s width, height and depth; a cylinder\'s or cone\'s diameter, height and depth-diameter; a sphere\'s three diameters.'),
          at: z.array(z.number()).length(3).describe('[x, y, z] of its center, inches.'),
          rot: z.array(z.number()).length(3).optional().describe('[x, y, z] degrees, applied in x, y, z order; [90, 0, 0] lays a cylinder along z.'),
          color: z.string().optional().describe('"#rrggbb".'),
          finish: z.enum(FINISHES).optional().describe(`${FINISHES.join(', ')}.`),
        })).min(1).max(LIMITS.parts).describe(`Up to ${LIMITS.parts} parts.`),
      },
    }, ({ name, description, asset_id, parts }) => run(() => {
      const asset = cleanAsset({ id: asset_id, name, description, parts });
      if (!asset) throw new AppError(400, 'None of those parts could be used.');
      write((doc) => {
        const others = doc.assets.filter((a) => a.id !== asset.id);
        if (others.length >= LIMITS.assets) throw new AppError(400, `A unit holds at most ${LIMITS.assets} custom pieces.`);
        doc.assets = [...others, asset];
        // Placed copies keep their spot and take the new size.
        for (const it of doc.items) if (it.type === 'asset' && it.asset === asset.id) Object.assign(it, { w: asset.w / 12, d: asset.d / 12, h: asset.h / 12 });
      });
      return ok(assetOut(asset));
    }));

    server.registerTool('find_spots', {
      title: 'Find where something fits',
      description: 'Places a width × depth footprint fits without hitting walls, fixtures, other pieces or door swings, best first (farther from doors). With against_wall (the default) the piece\'s back is set against a wall or fixture, the usual spot for beds, sofas, dressers and desks. Returns centers and rotations, ready for place_items.',
      inputSchema: {
        width: z.number().positive().max(360).describe('Side to side as you face its front, inches.'),
        depth: z.number().positive().max(360).describe('Back to front, inches.'),
        room: z.string().optional().describe('A room id or name from get_unit. Omit to search the main rooms.'),
        against_wall: z.boolean().optional().describe('Back against a wall or fixture (default true).'),
        count: z.number().int().min(1).max(12).optional().describe('How many spots (default 5).'),
      },
      annotations: { readOnlyHint: true },
    }, ({ width, depth, room, against_wall = true, count = 5 }) => run(() => {
      const { row, U } = current();
      if (room && !U.rooms.some((r) => r.id === room || r.name.toLowerCase() === room.toLowerCase())) throw new AppError(400, `There is no room "${room}". Rooms: ${U.rooms.map((r) => r.id).join(', ') || 'none yet'}.`);
      const spots = findSpots({ w: ft(width), d: ft(depth), room, againstWall: against_wall, items: row.doc.items, count, U });
      return ok({
        spots: spots.map((s) => ({ at: [inch(s.x), inch(s.z)], rotation: s.rot, room: s.roomId })),
        ...(spots.length ? {} : { note: 'Nothing fits there. Try another room, a smaller size, against_wall: false, or move other pieces.' }),
      });
    }));

    server.registerTool('check_unit', {
      title: 'Check the unit',
      description: 'The unit\'s problems (rooms, walls, doors, windows, fixtures), and for every piece of furniture: its room, the clear floor on each side up to the nearest wall, fixture or other piece (inches), and its problems. Use it to judge walkways (aim for 30 to 36 in) and to confirm nothing blocks a door.',
      inputSchema: {},
      annotations: { readOnlyHint: true },
    }, () => run(() => {
      const { row, U } = current();
      const items = row.doc.items;
      const pieces = items.map((it) => ({
        id: it.uid, name: it.name, room: U.roomAt(it.x, it.z)?.id ?? null,
        clear_floor: isFlat(it) ? null : Object.fromEntries(clearances(it, items, U.obstacles).map((c) => [c.side, inch(c.dist)])),
        problems: problems(it, items, U),
      }));
      return ok({ unit_problems: U.problems, pieces, pieces_with_problems: pieces.filter((p) => p.problems.length).length });
    }));

    server.registerTool('render_plan', {
      title: 'Draw the plan',
      description: 'A top-down picture of the unit, north up, on a 1-foot grid with inch coordinates every 5 feet: rooms with their names, ids and sizes in inches, walls, windows (blue), door swings, fixtures and furniture, each labeled with its id. Compare it with the floor plan after every change.',
      inputSchema: {},
      annotations: { readOnlyHint: true },
    }, () => run(() => {
      limit(limiters.read, ip);
      const { row, U } = current();
      const image = png(detailSvg({ title: row.title, author: row.author, unit: row.doc.unit, items: row.doc.items, assets: row.doc.assets }, U)).toString('base64');
      return {
        content: [
          { type: 'image', data: image, mimeType: 'image/png' },
          { type: 'text', text: `${U.rooms.length} rooms, ${U.openings.length} doors and windows, ${U.fixtures.length} fixtures, ${row.doc.items.length} pieces of furniture. Open it in 3D: ${viewUrl}` },
        ],
      };
    }));

    return server;
  }

  const rpcError = (ctx, status, message, headers = {}) => json(ctx.res, status, { jsonrpc: '2.0', error: { code: -32000, message }, id: null }, headers);

  return async function handleMcp(ctx) {
    if (!/^mcp(\/|$)/.test(ctx.path)) return false;
    const m = /^mcp\/([A-Za-z0-9]{1,32})\/([A-Za-z0-9]{1,64})\/?$/.exec(ctx.path);
    if (!m) { rpcError(ctx, 404, NO_UNIT); return true; }
    if (ctx.method !== 'POST') { rpcError(ctx, 405, 'This MCP server is stateless; use POST.', { Allow: 'POST' }); return true; }
    limit(limiters.mcp, ctx.ip, 'MCP calls');
    const [, id, key] = m;
    if (id === EXAMPLE_ID) { rpcError(ctx, 404, NO_EXAMPLE); return true; }
    let row = null;
    try { row = units.get(id); } catch { row = null; }
    if (!row || !units.canEdit(row, key)) { rpcError(ctx, 404, NO_UNIT); return true; }
    let message;
    try {
      message = JSON.parse((await readBody(ctx.req, config.mcpBytes)).toString('utf8'));
    } catch (error) {
      if (error instanceof AppError) throw error;
      json(ctx.res, 400, { jsonrpc: '2.0', error: { code: -32700, message: 'Parse error' }, id: null });
      return true;
    }
    const server = buildServer(id, key, ctx.origin, ctx.ip);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    ctx.res.on('close', () => { void transport.close(); void server.close(); });
    await server.connect(transport);
    await transport.handleRequest(ctx.req, ctx.res, message);
    return true;
  };
}
