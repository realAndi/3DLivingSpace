// The tools an agent builds, checks and furnishes a unit with: their names,
// what each says about itself and the shape of what it takes, checked with zod.
// The same twelve whether Claude reaches a unit through its MCP address
// (server/mcp.js) or through the skill's scripts (skill/3d-living-space); what
// they do is src/agent.js. Inches and snake_case here, as src/unit.js
// fromInches / toInches convert them. Server and skill only: the browser never
// loads this file.
import { z } from 'zod';
import { SWATCHES, KINDS, PLACES } from './catalog.js';
import { SHAPES, FINISHES, LIMITS } from './design.js';
import {
  ROOM_KINDS, FLOORS, OPENING_TYPES, FIXTURES, SEGMENTS, FIXTURE_OPTIONS, FINISH_OPTIONS, UNIT_LIMITS,
} from './unit.js';
import { COMPASS } from './agent.js';

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
  north: z.number().min(-360).max(360).optional().describe('Which way true north points, as degrees clockwise from the top of the plan: 0 when the plan\'s top is north (the default), 90 when north is to the right (east on the plan), 270 when it is to the left. Read it off the plan\'s north arrow; it moves the sun.'),
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
  at: XZ().describe('The center of the piece\'s footprint, [x, z] in inches. For a wall piece, a point at or near the wall it hangs on; for a piece resting on another (on), where on it (default: its middle).'),
  rotation: z.number().optional().describe('Degrees clockwise on the plan; 0 = its front faces south, 90 west, 180 north, 270 east. A bed against a north wall is 0, headboard on the wall. Default 0. Wall pieces face away from their wall, whatever you pass.'),
  width: z.number().positive().max(360).optional().describe('Side to side as you face its front, inches. Default: the catalog or asset size.'),
  depth: z.number().positive().max(360).optional().describe('Back to front, inches (a bed\'s length).'),
  height: z.number().positive().max(108).optional().describe('Inches.'),
  color: z.string().optional().describe(`A swatch (${SWATCHES.filter((s) => s.key).map((s) => s.key).join(', ')}) or "#rrggbb". Omit for the piece's own finish.`),
  name: z.string().max(LIMITS.name).optional().describe('Label shown in the app, like "Grandma\'s armchair".'),
  on: z.string().max(40).optional().describe('What it rests on or hangs from: "floor"; "wall" (hung against the wall nearest at, facing into the room); "ceiling"; or the id of a placed piece (a table, nightstand, dresser, desk, bookshelf, TV stand, wall shelf; holds_items in get_catalog) or of a fixture (a kitchen run\'s counter, an island, a bar counter, a vanity, a washer) to stand on. Default from its placement in get_catalog: surface pieces land on whatever is under at, else the floor; wall pieces on the nearest wall; ceiling pieces on the ceiling.'),
  elevation: z.number().min(0).max(228).optional().describe('Inches from the floor to its underside. For a wall piece, how high it hangs (default in get_catalog). For a piece on a bookshelf, picks the shelf nearest this height. Floor, ceiling and other resting pieces get theirs from what holds them.'),
};

// In the order they are listed to an agent.
export const TOOLS = [
  {
    name: 'get_unit',
    title: 'Get the unit',
    description: 'Everything about this unit, in inches: settings (heights, finishes), rooms (outline, size, area, bounds), extra walls, openings (doors, windows, doorways: the rooms each joins, its wall thickness, hinge end and the way it opens as compass directions), fixtures (and which sides touch a wall), labels, placed furniture, custom assets, and every problem found. Start here.',
    inputSchema: {},
    annotations: { readOnlyHint: true },
  },
  {
    name: 'build_unit',
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
  },
  {
    name: 'edit_unit',
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
  },
  {
    name: 'get_catalog',
    title: 'Get the catalog',
    description: 'What you can build and place, with default sizes in inches (width × depth × height): fixture types and their options, kitchen-run segments with their usual widths, opening types, room kinds, floors, finish options, and the furniture catalog with its colors. Every size can be changed.',
    inputSchema: {},
    annotations: { readOnlyHint: true },
  },
  {
    name: 'set_info',
    title: 'Name the unit',
    description: 'Set the title shown on the unit\'s page and link previews, and/or the author ("by …"). Never an address, building name or unit number.',
    inputSchema: {
      title: z.string().max(LIMITS.title).optional().describe('Like "My place, reimagined" or "Sunny one bedroom".'),
      author: z.string().max(LIMITS.author).optional().describe('The person\'s first name or handle, shown as "by …".'),
    },
  },
  {
    name: 'place_items',
    title: 'Place furniture',
    description: 'Add pieces. Each needs a type (from get_catalog furniture, or "asset:<asset_id>" for a piece made with create_asset) and a center at [x, z] in inches (or, for a piece resting on another, just on); size defaults to the catalog or asset size. Where it goes follows its placement in get_catalog unless you pass on: floor pieces stand on the floor, surface pieces rest on the piece or counter under at, wall pieces hang on the nearest wall at elevation, ceiling pieces hang from the ceiling. Pieces are placed in order, so a piece given an id can hold the ones after it. A floor piece set slightly into a wall or its trim (baseboards stand about ½ in proud of the wall, door casings ¾ in, window stools 1¼ in) is eased out up to 3 in; eased_off_walls lists those. Returns the new pieces with their ids, what they rest on and their elevation, and any problems: running into walls or fixtures, overlapping other pieces, blocking a door, hanging off a table\'s edge, not against a wall.',
    inputSchema: {
      items: z.array(z.object({
        type: z.string().describe('Catalog type, or "asset:<asset_id>".'),
        id: z.string().regex(/^[A-Za-z0-9_-]{2,24}$/, 'An id is 2 to 24 letters, digits, - or _.').optional().describe('An id you choose (2 to 24 letters, digits, - or _, like "sofa" or "bed-1"), so later pieces in this call can rest on it. Default: a random one.'),
        ...itemShape, at: itemShape.at.optional(),
      })).min(1).max(60).describe('Pieces to add, in order.'),
    },
  },
  {
    name: 'update_items',
    title: 'Move or change furniture',
    description: 'Change placed pieces by id: move (at), turn (rotation), resize, recolor, rename, change type, or put it on something else (on, elevation). Only the fields you pass change. A surface piece moved with at lands on whatever is under its new spot; a wall piece re-hangs on the wall nearest it. Whatever rests on a piece you move, turn, resize or raise moves with it (carried lists them). Returns the pieces and any problems.',
    inputSchema: {
      items: z.array(z.object({
        id: z.string().describe('The piece\'s id, from get_unit or place_items.'),
        type: z.string().optional().describe('Catalog type, or "asset:<asset_id>".'),
        ...Object.fromEntries(Object.entries(itemShape).map(([k, v]) => [k, v.optional()])),
      })).min(1).max(150).describe('Pieces to change.'),
    },
  },
  {
    name: 'remove_items',
    title: 'Remove furniture',
    description: 'Remove pieces by id, or every piece with all: true. What rests on a removed piece goes with it (also_removed lists those). Fixtures (kitchen, bath…) are part of the unit: remove those with edit_unit.',
    inputSchema: {
      ids: z.array(z.string()).optional().describe('Ids of pieces to remove.'),
      all: z.boolean().optional().describe('Remove every piece of furniture.'),
    },
    annotations: { destructiveHint: true },
  },
  {
    name: 'create_asset',
    title: 'Build a custom piece',
    description: `Make a 3D piece out of primitives when the catalog has nothing like it (a specific chair, a piano, a cat tree…), then place it with place_items as type "asset:<asset_id>".

Parts are in inches in the piece's own frame: +x to the piece's right as you face its front, +y up, +z toward its front (a wall piece's back, -z, goes against the wall). The piece is re-centered so its footprint is centered and its lowest point is on the floor, so only the parts' positions relative to each other matter. Real proportions matter more than detail: a dining chair is about 18 wide, 20 deep, 34 tall with its seat at 18. Say where it goes with placement (a lamp for a table is surface, a clock is wall) and what it is with kind. A lamp gets light_at (where its bulb is) and its shade or bulb parts finish "glow": then it switches on and off and lights the room. Pass asset_id to replace a piece you made earlier; placed copies update too.`,
    inputSchema: {
      name: z.string().max(LIMITS.name).describe('Like "Bar stool" or "Upright piano".'),
      description: z.string().max(LIMITS.description).optional().describe('What it is, in a sentence.'),
      asset_id: z.string().optional().describe('Replace this existing asset instead of making a new one.'),
      placement: z.enum(PLACES).optional().describe('Where it goes: floor (default), surface (on tables, counters, shelves), wall (hangs on a wall) or ceiling (hangs from the ceiling).'),
      kind: z.enum(KINDS.map((k) => k.key)).optional().describe('What it is, for the catalog (default furniture). A rug or mat is kind rug: it lies flat, so people walk over it and other pieces stand on it (so does any floor piece an inch tall or less).'),
      light_at: z.array(z.number()).length(3).optional().describe('A lamp: [x, y, z] inches of its bulb, in the same frame as the parts.'),
      parts: z.array(z.object({
        shape: z.enum(SHAPES).describe('box, cylinder, cone (its tip points up) or sphere.'),
        size: z.array(z.number()).length(3).describe('[x, y, z] inches: a box\'s width, height and depth; a cylinder\'s or cone\'s diameter, height and depth-diameter; a sphere\'s three diameters.'),
        at: z.array(z.number()).length(3).describe('[x, y, z] of its center, inches.'),
        rot: z.array(z.number()).length(3).optional().describe('[x, y, z] degrees, applied in x, y, z order; [90, 0, 0] lays a cylinder along z.'),
        color: z.string().optional().describe('"#rrggbb".'),
        finish: z.enum(FINISHES).optional().describe(`${FINISHES.join(', ')}. glow: a lamp's shade or bulb, lit while it's on.`),
      })).min(1).max(LIMITS.parts).describe(`Up to ${LIMITS.parts} parts.`),
    },
  },
  {
    name: 'find_spots',
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
  },
  {
    name: 'check_unit',
    title: 'Check the unit',
    description: 'The unit\'s problems (rooms, walls, doors, windows, fixtures), and for every piece of furniture: its room, what it rests on and how high, the clear floor on each side up to the nearest wall, fixture or other piece (inches; pieces on the floor only), and its problems. Use it to judge walkways (aim for 30 to 36 in) and to confirm nothing blocks a door.',
    inputSchema: {},
    annotations: { readOnlyHint: true },
  },
  {
    name: 'render_plan',
    title: 'Draw the plan',
    description: 'A top-down picture of the unit, north up, on a 1-foot grid with inch coordinates every 5 feet: rooms with their names, ids and sizes in inches, walls, windows (blue), door swings, fixtures and furniture, each labeled with its id. Compare it with the floor plan after every change.',
    inputSchema: {},
    annotations: { readOnlyHint: true },
  },
];
