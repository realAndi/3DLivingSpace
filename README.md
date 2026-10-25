# 3D Living Space

A to-scale 3D model of a two-bedroom, two-bath apartment (821 sq ft), built from
the leasing floor plan and a handful of walkthrough photos. Orbit it as a
dollhouse, read it as a plan, or walk through it.

**Live:** https://reallyitsandi.com/3DLivingSpace/

## What it does

- **Dollhouse, Plan and Walk views.** Walk mode has drag-to-look, WASD or arrow
  keys, tap-the-floor-to-walk, a touch joystick on phones, and a minimap.
- **Photo match.** Each photo opens the model from the spot it was taken, with a
  slider that fades between the photo and the model.
- **Measure.** Tap two points on the floor; points snap to walls.
- **Furniture planner.** Add pieces from a catalog of typical sizes (sofas,
  beds, tables, rugs and more) or a custom piece, then drag, turn, resize and
  recolor them. Pieces snap flush to walls, and while one is selected, lines show
  its clearance to the nearest wall, counter or other piece on each side. The
  layout saves in your browser; **Share layout** makes a link that opens the
  same layout anywhere. Keys: R / Shift+R turn 90°, [ and ] turn 15°, arrows
  nudge 1" (Shift for 1'), Delete removes, Esc deselects.
- **Doors** swing open and shut when tapped, and the original leasing plan can be
  laid over the model to check the tracing.

Links open a view directly: `#dollhouse`, `#plan`, `#walk`, or a photo such as
`#photo-kitchen`.

## How it was measured

- Walls, doors and windows are traced from the leasing plan in pixel
  coordinates (`src/plan.js`). At 25.86 px per foot, the tracing reproduces all
  three room sizes printed on the plan to within 2".
- The camera position of each photo was solved against wall corners and floor
  and ceiling lines that the plan locates, then refined by aligning the model's
  edges with the photo's. That fit puts the ceiling at 9'0" and gives the window
  sizes and heights.
- Where the photos and the plan disagree, the photos win: the living room
  window is 6'11" (the plan draws about 9'), the kitchen cabinet order follows
  the kitchen photo, and the primary bath has a walk-in shower with a glass
  panel rather than the plan's corner shower.
- Bedroom 2 and Bath 2 were not photographed, so they follow the plan with the
  same finishes.

## Running it locally

It is a static site with no build step. Three.js loads from jsDelivr.

```sh
python3 -m http.server 5173
# open http://localhost:5173
```

## Layout

| File | What it holds |
| --- | --- |
| `src/plan.js` | Traced walls, openings, rooms, photo poses |
| `src/architecture.js` | Walls with openings, floors, ceilings, trim, windows, doors |
| `src/kitchen.js`, `src/baths.js` | Cabinets, appliances, fixtures, closets, laundry |
| `src/furniture.js` | Furniture catalog and piece models |
| `src/layout.js` | Furniture planner: placing, dragging, clearances, saving, sharing |
| `src/materials.js` | Procedural textures: plank floor, tile, oak, quartz |
| `src/surroundings.js` | Sky and the neighborhood seen through the windows |
| `src/walk.js` | First-person controls |
| `src/main.js` | Scene, views, photo matching, measuring, UI |

## Deploying

Pushes to `main` publish to the droplet through `.github/workflows/deploy.yml`.
The deploy key and Portfolio-Site's protect rule are set up by
`deploy/3dlivingspace-key.sh` in the Portfolio-Site repository.
