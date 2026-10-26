# 3D Living Space

Build a to-scale 3D model of your apartment with Claude, furnish it, and share
it. Every unit gets its own link and its own MCP address: add the address to
Claude, share your floor plan and photos, and Claude builds the rooms, walls,
doors, windows, kitchen and baths while you watch. Then furnish it yourself or
ask Claude to, walk through it, measure anything, and send the link to anyone,
who can look around and make their own version.

**Live:** https://reallyitsandi.com/3DLivingSpace/

## Using it

- **Start.** The home page shows the example unit (a 2 bed, 2 bath apartment).
  *Create new unit* gives you an empty unit; *Work off the example unit* gives
  you your own copy of the example to furnish.
- **Build it with Claude.** Each unit's Share tab has its MCP address,
  `https://reallyitsandi.com/3DLivingSpace/mcp/<unit id>/<key>`. In Claude:
  Settings → Connectors → Add custom connector, paste it, then share the floor
  plan (with its printed room sizes) and a few photos of each room and ask
  Claude to build the unit. The page updates within a few seconds of each change.
  The address can change that unit and no other; keep it to yourself.
- **Dollhouse, Plan and Walk views.** Walk is first person: on a computer, click
  to look around with the mouse (Esc frees the cursor), WASD or the arrow keys
  to move, Shift to run, E to use what you're facing; on a phone, drag to look,
  use the pad to move, tap the floor to walk there. Tools sets the look speed.
- **Things you can use.** Doors, cabinet doors and drawers, the fridge, oven,
  dishwasher, microwave and washer open; lamps, TVs and the room light switches
  by each door switch; curtains and blinds open and close; ceiling fans spin.
  E (or a click) uses what's under the crosshair, a tap uses what you tap, and a
  small prompt says what something does when it's under the crosshair or, on a
  phone, near the middle of the view (tap the prompt too). Open all / Close all
  (Tools) still work the doors.
- **Furnish.** Add pieces from a catalog of typical sizes, drag, turn, resize and
  recolor them. With *Pieces can't overlap* on (the default), a piece slides
  along and stops flush against walls, their trim (baseboards, door casings,
  window stools, at their real heights, so a coffee table slides under a sill
  that stops a sofa), built-ins and other pieces. Pieces collide by their real
  parts at their real heights (`src/parts.js`): chairs tuck under tables and
  desks up to their backs, stools under an island's overhang, a lamp's shade
  over a sofa arm, a side table into a sectional's corner. Fine-tune with the arrow keys
  (1", Alt ¼", Shift 1'), `[` `]` to turn 15° (Alt 1°), or the nudge pad on the
  piece's bar on a phone. A selected piece on the floor shows its clearance on each side.
- **Where things go.** Every piece has a placement. Floor pieces stand on the
  floor. Surface pieces (lamps, books, a vase, plates, a laptop, a coffee maker)
  snap onto the table, dresser, shelf or counter under them. Wall pieces (art,
  mirrors, a TV, sconces, shelves, curtains, blinds) hang on a wall at a height
  you set, slide along it and stop at windows, doorways and corners. Ceiling
  pieces (pendants, fans) hang from the ceiling. Moving a table carries what's
  on it; deleting it takes them too.
- **Time of day and lights.** The sun follows your clock (or the time slider in
  the lights panel, the sun/moon button), coming in the windows the unit's
  `north` says it should, with the sky and exposure to match. Each room's
  ceiling lights switch together, from the light switch drawn by its door or
  from the panel; they and the lamps are on "auto" (on while it's dark out)
  until you flip them. A few real lights go to the room you're in and the
  nearest lit ones; the rest glow. Plan stays evenly lit. Lights, like open
  doors, are yours alone: nothing you switch is saved.
- **Tape measure** in every view: along the floor in Plan, between any two
  surfaces (heights too) in Dollhouse and Walk.
- **Units:** Feet & inches, Inches, or Centimeters (Tools tab), per browser.
- **Textures:** Auto picks a lighter set on phones; Tools can set Low or High, per browser.
- **Share.** The unit's link (`/u/<id>`) is view-only for everyone else, with a
  *Make your own version* button that copies it. Your browser keeps the edit key
  of the units it made; the edit link (`/u/<id>#edit=<key>`) works on any device.
  Or set an **edit code** in Share (your own, or a suggested one like
  `k7qm-4x2p`): on another device, open the unit's link, tap **Edit** and enter
  it, and that browser can edit it too. Case, spaces and dashes don't matter.
  The server keeps the edit key encrypted with the code and never the code
  itself; guesses are limited per address and per unit.
- **Suggestions.** Rearranged your own version of someone's unit? *Send
  suggestion* (Furnish) offers your layout back to them, with a note; sending
  again updates it. Its owner sees it under Suggestions, previews one suggestion
  at a time in any view (before and after, changes outlined, removed pieces as
  ghosts), ticks the changes to take (a table and what's on it count as one,
  and changes that clash with their own since are marked) and applies them,
  with Undo. `src/changes.js` works out the changes against the layout the copy
  started from, so the owner sees only what was changed.

## The MCP tools

Inches throughout. x runs east (left to right on the plan), z south (top to
bottom); rotations are degrees clockwise on the plan, 0 meaning a fixture or
piece faces south.

| Tool | What it does |
| --- | --- |
| `get_unit` | Everything about the unit: settings, rooms, walls, doors and windows (which rooms each joins, which way it opens), fixtures, furniture, problems |
| `get_catalog` | Fixture types and their options, kitchen segments, opening types, room kinds, floors, finishes, furniture |
| `build_unit` | Lay the unit out from the plan in one call: settings plus whole lists of rooms, walls, openings, fixtures, labels |
| `edit_unit` | Change rooms, walls, openings or fixtures by id, or remove them |
| `set_info` | Title and author |
| `place_items` / `update_items` / `remove_items` | Furniture: on the floor, on a piece or counter (`on`), on a wall at a height (`elevation`), or from the ceiling; what rests on a piece moves and goes with it |
| `create_asset` | A custom 3D piece from boxes, cylinders, cones and spheres, with where it goes, what it is, and a bulb for lamps |
| `find_spots` | Where a footprint fits, optionally against a wall |
| `check_unit` | The unit's problems, and each piece's clear floor and problems |
| `render_plan` | A labeled top-down picture with inch coordinates, to compare with the floor plan |

## How a unit is described

A unit (`src/unit.js`) is plain data, so the browser and the server build the
same thing from it:

- **Rooms** are the clear floor inside the walls. Where two rooms are a wall's
  thickness apart, the gap becomes that wall; where they touch, they are open to
  each other; every indoor room gets an outside wall around whatever doesn't
  touch another room. Extra walls (a pier, a half wall) are listed separately.
  This is what an agent can get right from a floor plan's printed room sizes,
  and the walls can't come out misaligned.
- **Doors and windows** are placed by a point in their wall and a width; they
  find the wall they're in and are cut out of it. Ten types, from hinged doors
  to sliding glass doors and cased openings.
- **Fixtures** are built-ins with a center, size and rotation: kitchen runs
  listed as segments (base, sink, dishwasher, range, fridge…), islands, baths,
  laundry, closets, fireplaces and more.
- **Finishes:** wall paint, floors per room, cabinets, counters, backsplash,
  appliances, hardware, tile.
- **North:** which way true north points on the plan, for the sun.

Placed pieces are `{uid, type, w, d, h, x, z, rot, color, asset?}` in feet, plus,
off the floor, `y` (the height of the underside) and `on` (`wall`, `ceiling`,
`p:<uid>` for a piece, `f:<id>` for a fixture). `src/stacking.js` puts them
there and moves what rests on a piece with it; collisions and checks
(`src/parts.js`, `src/fit.js`) work at every piece's real height.

Building a unit also checks it: overlapping rooms, walls far too thick (a room
missing) or slivers (rooms meant to touch), doors not in a wall, fixtures in a
wall, doors that hit a fixture as they swing, sizes that disagree with the plan.
Agents get these as sentences to fix.

## How the example was measured

- Walls, doors and windows are traced from the leasing plan in pixel coordinates
  (`src/example.js`). At 25.86 px per foot the tracing reproduces both
  bedrooms' printed sizes within 2".
- Two tape measurements from the living room's window wall (112" to the side of
  the fridge, about 129½" to the primary bedroom door) both came out about 4"
  longer than the drawing, so that wall sits 3.9" further east than drawn.
- Ceiling height (9'0"), window sizes and heights, the kitchen's cabinet order
  and the primary bath's layout come from walkthrough photos: each photo's camera
  position was solved against wall corners and floor and ceiling lines the plan
  locates. The photos themselves are not published.
- The rooms add up to 727 sq ft of clear floor; to the middle of the outside
  walls the unit is about 811 sq ft, and to their outside face about 857, which
  brackets the listed 821.

## Running it

Node 24 or later.

```sh
npm install
npm start          # http://localhost:8790/
npm test           # starts the server on a scratch database and drives the API and MCP tools
```

`BASE_PATH` serves it under a path (production uses `/3DLivingSpace`),
`LISTEN` takes a port or a Unix socket path, `DATA_DIR` holds the SQLite
database (`units.db`, with a daily backup kept for a week), and `PUBLIC_URL`
fixes the origin used in links.

### HTTP API

| Route | |
| --- | --- |
| `POST api/units` | `{}` for an empty unit, `{from: 'example'}` for a copy of the example, `{from: '<id>'}` for a copy of a unit; returns its key, edit link and MCP address |
| `GET api/units/:id` | Anyone; `?since=<version>` answers 204 when unchanged; `example` is the example |
| `PATCH api/units/:id` | `X-Edit-Key`: furniture, title and author (the unit itself changes over MCP) |
| `POST api/units/:id/fork` | A copy you own |
| `GET`, `PUT`, `DELETE api/units/:id/code` | `X-Edit-Key`: whether an edit code is set; set one (`{code}`); remove it |
| `POST api/units/:copy/suggest`, `GET`/`DELETE api/units/:copy/suggestion` | `X-Edit-Key` of a copy: offer its layout to the unit it was copied from (`{note}`; one open per copy); its status; withdraw it |
| `GET api/units/:id/suggestions`, `POST api/units/:id/suggestions/:sid/apply` (`{groups}`), `…/dismiss`, `…/undo` | `X-Edit-Key`: the suggestions waiting, with their layouts; take some or all of one; dismiss it; undo an apply |
| `POST api/units/:id/unlock` | `{code}`: the unit with its key, as if you'd made it (8 tries per address per 15 minutes, 40 per unit per hour) |
| `GET api/units/:id/card.png`, `plan.png`, `api/card.png` | Link preview, labeled plan |

## Layout

| Path | What it holds |
| --- | --- |
| `index.html`, `src/main.js` | The page, scene, views, labels, minimap, panels, home and empty states |
| `src/unit.js` | The unit model: vocabulary, cleaning, inch conversion, and building walls, openings and fixtures from it |
| `src/example.js` | The example unit, traced from the leasing plan |
| `src/geometry.js`, `src/fit.js` | Plane geometry; overlap, clearance and free-spot checks |
| `src/changes.js` | Suggestions: what a copy changed, what clashes with the original since, applying a choice |
| `src/stacking.js` | What holds each piece up: tops and shelves, walls, the ceiling; carrying what rests on a piece |
| `src/catalog.js`, `src/design.js` | Furniture catalog; the stored document and its checks |
| `src/architecture.js`, `src/fixtures.js` | 3D walls, floors, ceilings, doors, windows, railings; kitchens, baths and other built-ins |
| `src/furniture.js`, `src/layout.js` | 3D furniture and custom pieces; placing, dragging, clearances |
| `src/interact.js` | Things you can use: doors, fixtures' doors and drawers, lamps, screens, curtains, fans, light switches; the prompts |
| `src/sync.js` | Opening, creating, copying and saving units; live updates |
| `src/measure.js`, `src/walk.js`, `src/units.js` | Tape measure, first-person controls, display units |
| `src/materials.js`, `src/textures.js`, `assets/tex/` | Materials with color, normal and roughness maps: finishes drawn in code, and CC0 scans of fabric, leather, carpet, walnut, marble and concrete (sources in `assets/tex/SOURCES.md`), loaded when first used at a quality that suits the device |
| `src/surroundings.js` | The view out the windows, by day and by night |
| `src/lighting.js`, `src/lightpanel.js` | The sun, sky and exposure by time of day; room lights, switches and lamps on a fixed pool of real lights; the lights panel |
| `server/` | HTTP server, units API, per-unit MCP servers, plan pictures (`render.js`, IBM Plex fonts under the OFL) |

## Deploying

The droplet pulls `main` every five minutes, builds the image and swaps it in
once healthy; see "3D Living Space at /3DLivingSpace/" in Portfolio-Site's
`deploy/README.md`. CI here runs the tests and builds the image.
