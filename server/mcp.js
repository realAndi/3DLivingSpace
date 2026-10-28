// MCP over Streamable HTTP, stateless: every POST gets a fresh server and
// transport, so there is no session to keep or lose on a restart.
//
// Each unit has its own MCP address, mcp/<id>/<key>, with the unit's edit key
// in it: a connector added with that address can change that unit and no
// other, so no tool takes a unit argument. The tools themselves (what they
// take: src/tools.js; what they do: src/agent.js) are shared with the skill's
// scripts; here they read and save the unit through server/service.js. Rate
// limits per address keep any one client from flooding the box.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { TOOLS } from '../src/tools.js';
import { createTools, pretty, ToolError } from '../src/agent.js';
import { AppError, json, readBody, limit } from './http.js';
import { png } from './render.js';
import { EXAMPLE_ID } from './service.js';

const INSTRUCTIONS = `3D Living Space is a to-scale 3D model of one person's apartment (a "unit") that they explore, furnish and share in their browser. This connection belongs to one unit and can change only that unit. Whatever you change shows up in their browser within a few seconds.

Units are inches. x runs east (left to right on the floor plan), z runs south (top to bottom), y is up. Put the origin at the plan's top-left (north-west) outside corner so everything has positive coordinates. Rotations are degrees clockwise on the plan: 0 means a fixture's or a piece's front faces south (down the plan), 90 west, 180 north, 270 east.

Building a unit from a floor plan and photos:
1. Call get_unit and get_catalog.
2. Rooms are the clear floor inside the walls. Use the room sizes printed on the plan (width x length, wall to wall). Where two rooms share a wall, leave the wall's thickness between their outlines (interior walls are about 4.5 in); where rooms are open to each other (a kitchen open to the living room), let the outlines touch. Outside walls are added automatically around everything (exterior_wall thick). Lay rooms out by adding up sizes and wall thicknesses along each row of rooms, using the plan's proportions to place them; don't rely on reading pixel positions alone.
3. Call build_unit with the rooms; the doors and windows, each placed by its center point in its wall plus its width (doors take hinge and opens as compass directions: which end the hinges are on, which way it swings); and the fixtures: the kitchen as kitchen-run fixtures listing cabinets and appliances left to right as you face them, bath fixtures (toilet, vanity, tub or shower), laundry, closet rods. Set the ceiling height, door height and window sill and head; the photos often show them (doors are usually 80 in tall).
4. Call render_plan and compare it with the floor plan side by side. Fix positions and sizes with edit_unit, and fix every problem that build_unit, edit_unit and check_unit report.
5. Set finishes from the photos: floors per room, wall paint, cabinets, counters, backsplash, appliances, hardware (get_catalog lists the built-in ones). Where none looks like the real thing, design one with create_texture: read the pattern, its sizes and colors off the photo, look at the preview it returns next to the photo, and call it again with texture_id until they match; then use it as "tex:<id>" in finishes, a room's floor, a fixture's color or a piece's material. Ask the person to look at it in 3D and tell you what is off.

Furnishing: pick pieces from get_catalog and place them with place_items; for anything the catalog lacks, build it with create_asset and place it. Leave 30 to 36 in to walk, keep door swings clear, and check with check_unit and render_plan. find_spots suggests where a footprint fits. Pieces overlap only where their parts do, at the same height, so tuck them in the way real furniture goes: a dining chair's seat under the table up to its back (about 19 in for the catalog chair), a desk chair under the desk, stools under an island's overhang, a lamp's shade over a sofa's arm, a table in a sectional's open corner.

Decorating: every catalog piece has a placement. Floor pieces stand on the floor. Surface pieces (table lamps, books, a vase, plates, a laptop, a coffee maker) rest on a placed piece or a counter: pass on with the piece's or fixture's id (at says where on it; elevation picks a bookshelf's shelf), or just an at over it. Wall pieces (art, mirrors, a wall TV, sconces, wall shelves, curtains, blinds) hang with their back against the wall nearest at, facing into the room; elevation is the height of their underside: center art about 57 to 60 in up, a TV about 42 to 50 in, sconces about 66 in; hang curtains wider than the window, from just under the ceiling to the floor. Ceiling pieces (pendants, fans) hang from the ceiling; a pendant's height is its drop, so its shade hangs about 30 to 36 in above a dining table. Moving a piece carries what rests on it, and removing it removes them. Give a piece an id when you place it to put other things on it in the same call. Set north from the plan's north arrow so the sun comes in the right windows.

Units are shared publicly by link: never put a street address, building name or unit number in any name.`;

const NO_UNIT = 'This MCP address doesn\'t match a unit: the unit doesn\'t exist or the key in the address is wrong. Each unit has its own MCP address (…/mcp/<unit id>/<key>); open the unit in 3D Living Space and copy it from the unit\'s Share tab.';
const NO_EXAMPLE = 'The example unit can\'t be changed, so it has no MCP address. In 3D Living Space, choose "Work off the example unit" to get your own copy, and copy its MCP address from the Share tab.';

const ok = (data) => ({ content: [{ type: 'text', text: pretty(data) }] });
// render_plan's picture, with what's in it.
const answer = (out) => (out?.image
  ? { content: [{ type: 'image', data: Buffer.from(out.image).toString('base64'), mimeType: 'image/png' }, { type: 'text', text: out.text }] }
  : ok(out));
async function run(fn) {
  try {
    return await fn();
  } catch (error) {
    if (error instanceof AppError || error instanceof ToolError) return { isError: true, content: [{ type: 'text', text: error.message }] };
    throw error;
  }
}

// ---------------------------------------------------------------------------

export function createMcp(config, units, limiters) {
  // One server per request, bound to the unit in its address, so tools can see
  // the caller's address for the rate limits.
  function buildServer(id, key, origin, ip) {
    const server = new McpServer({ name: '3d-living-space', version: '2.0.0' }, { instructions: INSTRUCTIONS });
    const tools = createTools({
      viewUrl: units.viewUrl(id, origin),
      current: () => { const row = units.get(id); return { row, U: units.built(row) }; },
      write: (change) => { limit(limiters.write, ip, 'changes'); return units.mutate(id, key, change); },
      built: (row) => units.built(row),
      png,
      beforeRender: () => limit(limiters.read, ip),
    });
    for (const { name, title, description, inputSchema, annotations } of TOOLS) {
      server.registerTool(name, { title, description, inputSchema, ...(annotations ? { annotations } : {}) }, (args) => run(() => answer(tools[name](args))));
    }
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
