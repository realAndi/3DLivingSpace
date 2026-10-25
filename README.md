# 3D Living Space

A to-scale 3D model of a two-bedroom, two-bath apartment (821 sq ft) that anyone
can furnish, measure, walk through and share. Every design gets its own link, and
AI agents can design it too through a built-in MCP server.

**Live:** https://reallyitsandi.com/3DLivingSpace/

## What it does

- **Dollhouse, Plan and Walk views.** Walk mode has drag-to-look, WASD or arrow
  keys, tap-the-floor-to-walk, a touch joystick on phones, and a minimap.
- **Furnish.** Add pieces from a catalog of typical sizes (sofas, beds, tables,
  rugs and more), then drag, turn, resize and recolor them. Pieces snap flush to
  walls, and while one is selected, lines show its clearance to the nearest wall,
  counter or other piece on each side. Keys: R / Shift+R turn 90°, [ and ] turn
  15°, arrows nudge 1" (Shift for 1'), Delete removes, Esc deselects.
- **Tape measure, in every view.** Plan measures along the floor and snaps to
  walls. Dollhouse and Walk measure between any two surfaces, so heights work too.
- **Share.** The first piece you place saves the design and gives it a link.
  - The **view link** (`/d/<id>`) is public: anyone can look around and make
    their own version, but can't change yours. Shared links unfurl with a picture
    of the plan.
  - The **edit link** (`/d/<id>#edit=<key>`) changes the design. This browser
    keeps the keys of the designs it made; use the edit link to keep editing on
    another device or to hand the design to an AI.
- **Design with AI.** See below.

## Design with AI (MCP)

The server speaks MCP at `https://reallyitsandi.com/3DLivingSpace/mcp`
(Streamable HTTP, no sign-in). In Claude: Settings → Connectors → Add custom
connector, paste that address, then in a chat paste your edit link and ask for
what you want. Changes show up in any browser that has the design open within a
few seconds.

| Tool | What it does |
| --- | --- |
| `get_apartment` | Rooms (outline, size), walls, doors with the floor their swing needs, windows, built-in fixtures |
| `get_catalog` | Furniture types and default sizes |
| `create_design` | A new design; returns its edit and view links |
| `get_design` | Pieces, custom assets and placement problems |
| `set_design_info` | Title and author |
| `place_items` / `update_items` / `remove_items` | Place, move, turn, resize, recolor, remove |
| `create_asset` | A custom 3D piece built from boxes, cylinders, cones and spheres |
| `find_spots` | Where a footprint fits, optionally against a wall |
| `check_design` | Clear floor on each side of every piece, and problems |
| `render_plan` | A labeled top-down picture, for the agent to check its work |

Units are inches. x runs east (left to right on the plan), z runs south (top to
bottom), origin at the plan's north-west outside corner. A piece's rotation is
degrees clockwise on the plan; 0 means its front faces south.

Reading is open; changing a design needs its edit link. Requests are rate
limited per address.

## How the apartment was measured

- Walls, doors and windows are traced from the leasing plan in pixel
  coordinates (`src/plan.js`). At 25.86 px per foot, the tracing reproduces all
  three room sizes printed on the plan to within 2".
- Ceiling height (9'0"), window sizes and heights, the kitchen's cabinet order
  and the primary bath's layout come from walkthrough photos: each photo's camera
  position was solved against wall corners and floor and ceiling lines the plan
  locates, then refined by aligning the model's edges with the photo's. The
  photos themselves are not published.
- Bedroom 2 and Bath 2 follow the plan with the same finishes.

## Running it

Node 24 or later.

```sh
npm install
npm start          # http://localhost:8790/
npm test           # starts the server on a scratch database and drives the API and MCP tools
```

`BASE_PATH` serves it under a path (production uses `/3DLivingSpace`),
`LISTEN` takes a port or a Unix socket path, `DATA_DIR` holds the SQLite
database (`designs.db`, with a daily backup kept for a week), and `PUBLIC_URL`
fixes the origin used in links.

## Layout

| Path | What it holds |
| --- | --- |
| `index.html`, `src/main.js` | The page, scene, views, labels, minimap, panels |
| `src/plan.js` | Traced walls, openings, rooms |
| `src/space.js` | The unit as plain data: doorways, wall pieces, fixtures, door swings |
| `src/catalog.js`, `src/design.js`, `src/fit.js` | Catalog, design format and checks, overlap and clearance math (shared with the server) |
| `src/architecture.js`, `src/kitchen.js`, `src/baths.js` | The building, kitchen, baths, closets and laundry |
| `src/furniture.js` | 3D models for catalog pieces and custom assets |
| `src/layout.js` | Placing, dragging, clearances |
| `src/sync.js` | Saving, polling, view-only and copies |
| `src/measure.js` | The tape measure |
| `src/materials.js`, `src/surroundings.js`, `src/walk.js` | Textures, the view out the windows, first-person controls |
| `server/` | HTTP server, designs API, MCP tools, plan pictures (`render.js`, IBM Plex fonts under the OFL) |

## Deploying

The droplet pulls `main` every five minutes, builds the image and swaps it in
once healthy; see "3D Living Space at /3DLivingSpace/" in Portfolio-Site's
`deploy/README.md`. CI here runs the tests and builds the image.
