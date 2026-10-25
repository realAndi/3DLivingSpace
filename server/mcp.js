// MCP over Streamable HTTP, stateless: every POST gets a fresh server and
// transport, so there is no session to keep or lose on a restart.
//
// There is no login. Reading is open, like the designs themselves; changing a
// design needs its edit link, which its owner pastes into the chat. Rate limits
// per address keep any one client from flooding the box.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import { CATALOG, catalogByType, SWATCHES, isFlat } from '../src/catalog.js';
import { cleanAsset, randomId, SHAPES, FINISHES, LIMITS } from '../src/design.js';
import { ROOMS, HEIGHT, UNIT, wallPieces, openings, doorSwings, BUILTINS, roomAt, polygonArea } from '../src/space.js';
import { problems, clearances, findSpots } from '../src/fit.js';
import { AppError, json, readBody, limit } from './http.js';
import { detailSvg, png } from './render.js';

const INSTRUCTIONS = `3D Living Space is a to-scale 3D model of one apartment (2 bed, 2 bath, 821 sq ft) that people furnish in their browser and share. Each design is one person's furnished version, with a public view link and a private edit link.

Units are inches. x runs east (left to right on the plan), z runs south (top to bottom), and the origin is the plan's north-west outside corner; height is up from the floor. Call get_apartment first: it gives every room's outline and size, the walls, the doors with the floor each one needs to swing open, the windows, and the built-in fixtures (kitchen, bath, laundry).

A placed piece has a center (x, z), a size (width side to side as you face its front, depth front to back, height) and a rotation in degrees clockwise on the plan: 0 means its front faces south (down the plan), 90 west, 180 north, 270 east. A bed against a north wall is rotation 0, headboard on the wall.

Changing a design needs its edit link (…/d/<id>#edit=<key>). If the person has none, create_design makes one: give them both links it returns. Pick pieces from get_catalog; when nothing fits, build one with create_asset out of boxes, cylinders, cones and spheres, then place it. place_items and update_items report pieces that run into walls, fixtures or each other, or block a door; fix those before you finish. find_spots suggests places a footprint fits. render_plan returns a labeled top-down picture so you can check your work. Leave about 30–36 inches for walkways. Anyone with the design open in a browser sees your changes within a few seconds.`;

const inch = (ft) => Math.round(ft * 12 * 2) / 2;
const ft = (inches) => inches / 12;
const box = ([x0, z0, x1, z1]) => ({ x0: inch(x0), z0: inch(z0), x1: inch(x1), z1: inch(z1) });

function ok(data) {
  return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
}
async function run(fn) {
  try {
    return await fn();
  } catch (error) {
    if (error instanceof AppError) return { isError: true, content: [{ type: 'text', text: error.message }] };
    throw error;
  }
}

// "…/d/<id>#edit=<key>", "<id>:<key>" or a bare id / view link.
function parseRef(ref) {
  const s = String(ref ?? '').trim();
  let m = /\/d\/([A-Za-z0-9]{8,16})(?:[^#\s]*#edit=([A-Za-z0-9]{20,48}))?/.exec(s);
  if (!m) m = /^([A-Za-z0-9]{8,16})(?::([A-Za-z0-9]{20,48}))?$/.exec(s);
  if (!m) throw new AppError(400, 'Pass the design as its edit link (…/d/<id>#edit=<key>), its view link, or its id.');
  return { id: m[1], key: m[2] ?? null };
}

const apartment = (() => {
  const windowRoom = (o) => {
    const n = { N: [0, -1], S: [0, 1], E: [1, 0], W: [-1, 0] }[o.w.inside] ?? [0, 0];
    const mid = (o.a + o.b) / 2;
    const [x, z] = o.w.axis === 'x' ? [mid, (n[1] > 0 ? o.w.z1 : o.w.z0) + n[1]] : [(n[0] > 0 ? o.w.x1 : o.w.x0) + n[0], mid];
    return roomAt(x, z)?.id ?? null;
  };
  const edges = (o) => (o.w.axis === 'x' ? [o.a, o.w.z0, o.b, o.w.z1] : [o.w.x0, o.a, o.w.x1, o.b]);
  return {
    units: 'inches',
    axes: 'x east (plan left to right), z south (plan top to bottom), origin at the plan north-west outside corner; heights up from the floor',
    ceiling_height: inch(HEIGHT.ceiling), door_height: inch(HEIGHT.doorHead),
    unit_bounds: box([UNIT.footprint.x0, UNIT.footprint.z0, UNIT.footprint.x1, UNIT.footprint.z1]),
    rooms: ROOMS.map((r) => {
      const xs = r.poly.map((p) => p[0]), zs = r.poly.map((p) => p[1]);
      return {
        id: r.id, name: r.name, size_on_plan: r.dims ?? null, area_sqft: Math.round(Math.abs(polygonArea(r.poly))),
        floor: r.floor, outline: r.poly.map(([x, z]) => [inch(x), inch(z)]),
        bounds: box([Math.min(...xs), Math.min(...zs), Math.max(...xs), Math.max(...zs)]),
      };
    }),
    walls: wallPieces.map(box),
    doors: openings.filter((o) => o.type !== 'window').map((o) => ({
      id: o.id, name: o.name, kind: o.type === 'bifold' ? 'bifold closet doors' : 'swing door', opening: box(edges(o)),
      keep_clear: doorSwings.find((d) => d.id === o.id) ? box(doorSwings.find((d) => d.id === o.id).rect) : null,
    })),
    windows: openings.filter((o) => o.type === 'window').map((o) => ({
      id: o.id, room: windowRoom(o), opening: box(edges(o)), sill_height: inch(o.sill), head_height: inch(o.head),
    })),
    fixtures: BUILTINS.map((b) => ({ name: b.name, ...box(b.rect), height: inch(b.height) })),
  };
})();

const itemShape = {
  x: z.number().describe('Center, east-west, in inches.'),
  z: z.number().describe('Center, north-south, in inches.'),
  rotation: z.number().optional().describe('Degrees clockwise on the plan; 0 = front faces south. Default 0.'),
  width: z.number().positive().optional().describe('Side to side as you face the front, inches. Default: the catalog or asset size.'),
  depth: z.number().positive().optional().describe('Front to back, inches.'),
  height: z.number().positive().optional().describe('Inches.'),
  color: z.string().optional().describe(`A swatch (${SWATCHES.filter((s) => s.key).map((s) => s.key).join(', ')}), or #rrggbb. Omit for the piece's own finish.`),
  name: z.string().optional().describe('Label shown in the app, e.g. "Grandma\'s armchair".'),
};
const designRef = z.string().describe('The design: its edit link (…/d/<id>#edit=<key>) to change it, or its view link or id to read it.');

export function createMcp(config, designs, limiters) {
  // One server per request, so tools can see the caller's address for the rate limits.
  function buildServer(origin, ip) {
    const server = new McpServer({ name: '3d-living-space', version: '1.0.0' }, { instructions: INSTRUCTIONS });

    const read = (ref) => designs.get(parseRef(ref).id);
    const edit = (ref) => {
      const { id, key } = parseRef(ref);
      if (!key) throw new AppError(403, 'Changing a design needs its edit link (…/d/<id>#edit=<key>), not just its view link. Ask its owner for it, or call create_design for a new one.');
      return { id, key };
    };
    const links = (row, key) => ({ view_url: designs.viewUrl(row.id, origin), ...(key ? { edit_url: designs.editUrl(row.id, key, origin) } : {}) });
    const itemOut = (it) => ({
      id: it.uid, type: it.type === 'asset' ? `asset:${it.asset}` : it.type, name: it.name,
      x: inch(it.x), z: inch(it.z), width: inch(it.w), depth: inch(it.d), height: inch(it.h), rotation: it.rot,
      color: it.color, room: roomAt(it.x, it.z)?.name ?? null,
    });
    const issues = (items) => items.map((it) => ({ id: it.uid, name: it.name, problems: problems(it, items) })).filter((p) => p.problems.length);
    function toItem(spec, base = {}) {
      const out = { ...base };
      if (spec.type !== undefined) {
        const m = /^asset:(.+)$/.exec(spec.type);
        if (m) { out.type = 'asset'; out.asset = m[1]; } else out.type = spec.type;
      }
      for (const [from, to, conv] of [['x', 'x', ft], ['z', 'z', ft], ['width', 'w', ft], ['depth', 'd', ft], ['height', 'h', ft], ['rotation', 'rot', (v) => v]]) {
        if (spec[from] !== undefined) out[to] = conv(spec[from]);
      }
      if (spec.color !== undefined) out.color = spec.color;
      if (spec.name !== undefined) out.name = spec.name;
      return out;
    }

    server.registerTool('get_apartment', {
      title: 'Get the apartment',
      description: 'The unit\'s geometry in inches: rooms (id, name, size, outline), walls, doors with the floor each needs to swing open (keep_clear), windows (which room, sill and head heights) and built-in fixtures. Start here.',
      inputSchema: {},
    }, () => run(() => ok(apartment)));

    server.registerTool('get_catalog', {
      title: 'Get the furniture catalog',
      description: 'Furniture types you can place, with default sizes in inches (width × depth × height). Any size can be changed when placing. Beds\' depth is their length. Rugs lie flat and may go under other pieces.',
      inputSchema: {},
    }, () => run(() => ok({
      types: CATALOG.map((c) => ({ type: c.type, name: c.name, group: c.group, width: c.w, depth: c.d, height: c.h, flat: c.build === 'rug' })),
      colors: SWATCHES.filter((s) => s.key).map((s) => s.key),
      custom: 'For anything else, build it with create_asset and place it as type "asset:<asset_id>".',
    })));

    server.registerTool('create_design', {
      title: 'Create a design',
      description: 'Start a new, empty design of the apartment. Returns its edit link (keep it private: it lets anyone change the design) and its view link (share freely). Always give both to the person.',
      inputSchema: {
        title: z.string().max(LIMITS.title).optional().describe('e.g. "Japandi calm" or "Movie night setup".'),
        author: z.string().max(LIMITS.author).optional().describe('Shown as "by …" on the design.'),
      },
    }, ({ title, author }) => run(() => {
      limit(limiters.create, ip, 'new designs');
      const { row, key } = designs.create({ title, author });
      return ok({ design_id: row.id, ...links(row, key), edit_key: key });
    }));

    server.registerTool('get_design', {
      title: 'Get a design',
      description: 'A design\'s title, pieces (id, type, center, size, rotation, color, room), custom assets, and any placement problems.',
      inputSchema: { design: designRef },
    }, ({ design }) => run(() => {
      const row = read(design);
      return ok({
        design_id: row.id, title: row.title, author: row.author, version: row.version, ...links(row),
        items: row.doc.items.map(itemOut),
        assets: row.doc.assets.map((a) => ({ asset_id: a.id, name: a.name, description: a.description, width: a.w, depth: a.d, height: a.h, parts: a.parts.length })),
        problems: issues(row.doc.items),
      });
    }));

    server.registerTool('set_design_info', {
      title: 'Rename a design',
      description: 'Set the design\'s title and/or author.',
      inputSchema: { design: designRef, title: z.string().max(LIMITS.title).optional(), author: z.string().max(LIMITS.author).optional() },
    }, ({ design, title, author }) => run(() => {
      limit(limiters.write, ip, 'changes');
      const { id, key } = edit(design);
      const row = designs.mutate(id, key, (doc) => {
        if (title !== undefined) doc.title = title;
        if (author !== undefined) doc.author = author;
      }).row;
      return ok({ title: row.title, author: row.author, ...links(row) });
    }));

    server.registerTool('place_items', {
      title: 'Place furniture',
      description: 'Add pieces to a design. Each needs a type (from get_catalog, or "asset:<asset_id>" for a piece made with create_asset) and a center (x, z) in inches; size defaults to the catalog or asset size. Returns the new pieces\' ids and any problems: running into walls or fixtures, overlapping other pieces, blocking a door.',
      inputSchema: {
        design: designRef,
        items: z.array(z.object({ type: z.string().describe('Catalog type, or "asset:<asset_id>".'), ...itemShape })).min(1).max(60),
      },
    }, ({ design, items }) => run(() => {
      limit(limiters.write, ip, 'changes');
      const { id, key } = edit(design);
      for (const spec of items) {
        if (!/^asset:/.test(spec.type) && !catalogByType[spec.type]) throw new AppError(400, `"${spec.type}" is not in the catalog. Call get_catalog, or build it with create_asset.`);
      }
      const { row, result } = designs.mutate(id, key, (doc) => {
        const added = [];
        for (const spec of items) {
          const item = toItem(spec, { uid: undefined });
          const assetDef = item.type === 'asset' ? doc.assets.find((a) => a.id === item.asset) : null;
          if (item.type === 'asset' && !assetDef) throw new AppError(400, `There is no asset "${item.asset}" in this design. create_asset returns the id to use.`);
          item.uid = randomId(8);
          doc.items.push(item);
          added.push(item.uid);
        }
        return added;
      });
      const placed = row.doc.items.filter((i) => result.includes(i.uid));
      return ok({ placed: placed.map(itemOut), problems: issues(row.doc.items).filter((p) => result.includes(p.id)), ...links(row) });
    }));

    server.registerTool('update_items', {
      title: 'Move or change furniture',
      description: 'Change placed pieces by id: move (x, z), turn (rotation), resize, recolor or rename. Only the fields you pass change. Returns the pieces and any problems.',
      inputSchema: {
        design: designRef,
        items: z.array(z.object({ id: z.string(), ...Object.fromEntries(Object.entries(itemShape).map(([k, v]) => [k, v.optional()])) })).min(1).max(100),
      },
    }, ({ design, items }) => run(() => {
      limit(limiters.write, ip, 'changes');
      const { id, key } = edit(design);
      const { row } = designs.mutate(id, key, (doc) => {
        for (const spec of items) {
          const i = doc.items.findIndex((it) => it.uid === spec.id);
          if (i < 0) throw new AppError(400, `There is no piece "${spec.id}" in this design. get_design lists them.`);
          doc.items[i] = toItem(spec, doc.items[i]);
        }
      });
      const ids = items.map((s) => s.id);
      return ok({ updated: row.doc.items.filter((i) => ids.includes(i.uid)).map(itemOut), problems: issues(row.doc.items).filter((p) => ids.includes(p.id)) });
    }));

    server.registerTool('remove_items', {
      title: 'Remove furniture',
      description: 'Remove pieces by id, or everything with all: true.',
      inputSchema: { design: designRef, ids: z.array(z.string()).optional(), all: z.boolean().optional() },
    }, ({ design, ids = [], all = false }) => run(() => {
      limit(limiters.write, ip, 'changes');
      const { id, key } = edit(design);
      const { row, result } = designs.mutate(id, key, (doc) => {
        const before = doc.items.length;
        doc.items = all ? [] : doc.items.filter((it) => !ids.includes(it.uid));
        return before - doc.items.length;
      });
      return ok({ removed: result, remaining: row.doc.items.length });
    }));

    server.registerTool('create_asset', {
      title: 'Build a custom piece',
      description: `Make a 3D piece out of primitives when the catalog has nothing like it (a specific chair, a piano, a cat tree…), then place it with place_items as type "asset:<asset_id>".

Parts are in inches in the piece's own frame: +x to the piece's right as you face its front, +y up, +z toward its front. The piece is re-centered so its footprint is centered and its lowest point is on the floor, so only the parts' positions relative to each other matter. Each part: shape (${SHAPES.join(', ')}); size [x, y, z] — a box's width, height and depth; a cylinder's or cone's diameter, height and depth-diameter (the cone's tip points up); a sphere's three diameters; at [x, y, z], its center; rot [x, y, z] degrees, applied in x, y, z order (rot [90, 0, 0] lays a cylinder along z); color "#rrggbb"; finish (${FINISHES.join(', ')}). Up to ${LIMITS.parts} parts. Real proportions matter more than detail: a dining chair is about 18 wide, 20 deep, 34 tall with its seat at 18. Pass asset_id to replace a piece you made earlier; placed copies update too.`,
      inputSchema: {
        design: designRef,
        name: z.string().max(LIMITS.name),
        description: z.string().max(LIMITS.description).optional(),
        asset_id: z.string().optional().describe('Replace this existing asset.'),
        parts: z.array(z.object({
          shape: z.enum(SHAPES),
          size: z.array(z.number()).length(3),
          at: z.array(z.number()).length(3),
          rot: z.array(z.number()).length(3).optional(),
          color: z.string().optional(),
          finish: z.enum(FINISHES).optional(),
        })).min(1).max(LIMITS.parts),
      },
    }, ({ design, name, description, asset_id, parts }) => run(() => {
      limit(limiters.write, ip, 'changes');
      const { id, key } = edit(design);
      const asset = cleanAsset({ id: asset_id, name, description, parts });
      if (!asset) throw new AppError(400, 'None of those parts could be used.');
      designs.mutate(id, key, (doc) => {
        const others = doc.assets.filter((a) => a.id !== asset.id);
        if (others.length >= LIMITS.assets) throw new AppError(400, `A design holds at most ${LIMITS.assets} custom pieces.`);
        doc.assets = [...others, asset];
        // Placed copies keep their spot and take the new size.
        for (const it of doc.items) if (it.type === 'asset' && it.asset === asset.id) Object.assign(it, { w: asset.w / 12, d: asset.d / 12, h: asset.h / 12 });
      });
      return ok({ asset_id: asset.id, name: asset.name, width: asset.w, depth: asset.d, height: asset.h, parts: asset.parts.length, place_as: `asset:${asset.id}` });
    }));

    server.registerTool('find_spots', {
      title: 'Find where something fits',
      description: 'Places a width × depth footprint fits without hitting walls, fixtures, other pieces or door swings, best first (farther from doors). With against_wall (default), the piece\'s back is set against a wall or fixture, the usual spot for beds, sofas, dressers and desks. Returns center and rotation, ready for place_items.',
      inputSchema: {
        design: designRef,
        width: z.number().positive(), depth: z.number().positive(),
        room: z.string().optional().describe('A room id or name from get_apartment. Omit to search the main rooms.'),
        against_wall: z.boolean().optional(),
        count: z.number().int().min(1).max(12).optional(),
      },
    }, ({ design, width, depth, room, against_wall = true, count = 5 }) => run(() => {
      const row = read(design);
      if (room && !ROOMS.some((r) => r.id === room || r.name.toLowerCase() === room.toLowerCase())) throw new AppError(400, `There is no room "${room}". Rooms: ${ROOMS.map((r) => r.id).join(', ')}.`);
      const spots = findSpots({ w: ft(width), d: ft(depth), room, againstWall: against_wall, items: row.doc.items, count });
      return ok({ spots: spots.map((s) => ({ x: inch(s.x), z: inch(s.z), rotation: s.rot, room: s.room })), note: spots.length ? undefined : 'Nothing fits there. Try another room, a smaller size, against_wall: false, or move other pieces.' });
    }));

    server.registerTool('check_design', {
      title: 'Check a design',
      description: 'For every piece: its room, the clear floor on each side up to the nearest wall, fixture or other piece (inches), and any problems. Use it to judge walkways (aim for 30–36 in) and to confirm nothing blocks a door.',
      inputSchema: { design: designRef },
    }, ({ design }) => run(() => {
      const row = read(design);
      const items = row.doc.items;
      return ok({
        pieces: items.map((it) => ({
          id: it.uid, name: it.name, room: roomAt(it.x, it.z)?.name ?? null,
          clear_floor: isFlat(it) ? null : Object.fromEntries(clearances(it, items).map((c) => [c.side, inch(c.dist)])),
          problems: problems(it, items),
        })),
      });
    }));

    server.registerTool('render_plan', {
      title: 'Draw the plan',
      description: 'A top-down picture of the design: walls, doors, windows, fixtures and every piece labeled with its name and id, on a 1-foot grid with inch coordinates. Look at it to check your work.',
      inputSchema: { design: designRef },
    }, ({ design }) => run(() => {
      limit(limiters.read, ip);
      const row = read(design);
      const image = png(detailSvg({ title: row.title, author: row.author, items: row.doc.items, assets: row.doc.assets })).toString('base64');
      return {
        content: [
          { type: 'image', data: image, mimeType: 'image/png' },
          { type: 'text', text: `${row.doc.items.length} pieces. Open it in 3D: ${designs.viewUrl(row.id, origin)}` },
        ],
      };
    }));

    return server;
  }

  return async function handleMcp(ctx) {
    if (!/^mcp\/?$/.test(ctx.path)) return false;
    if (ctx.method !== 'POST') {
      json(ctx.res, 405, { jsonrpc: '2.0', error: { code: -32000, message: 'This MCP server is stateless; use POST.' }, id: null }, { Allow: 'POST' });
      return true;
    }
    limit(limiters.mcp, ctx.ip, 'MCP calls');
    let message;
    try {
      message = JSON.parse((await readBody(ctx.req, config.bodyBytes)).toString('utf8'));
    } catch (error) {
      if (error instanceof AppError) throw error;
      json(ctx.res, 400, { jsonrpc: '2.0', error: { code: -32700, message: 'Parse error' }, id: null });
      return true;
    }
    const server = buildServer(ctx.origin, ctx.ip);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    ctx.res.on('close', () => { void transport.close(); void server.close(); });
    await server.connect(transport);
    await transport.handleRequest(ctx.req, ctx.res, message);
    return true;
  };
}
