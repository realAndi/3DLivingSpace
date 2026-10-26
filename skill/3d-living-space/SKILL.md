---
name: 3d-living-space
description: Build a to-scale 3D model of someone's apartment or house from their floor plan and photos, furnish it, and publish it as a claude.ai Artifact they can walk through, rearrange and share. Use it whenever someone shares a floor plan, a listing, or photos of rooms and wants to see the place in 3D, plan or try out furniture, check whether something fits ("will a king bed fit?", "where should the desk go?"), get ready for a move, or show their place to someone, even if they never say "3D" or "model".
compatibility: Needs Node.js 18 or later. Publishing the Artifact needs the Artifact and ArtifactData tools (Claude Code, CLI or desktop app). Without them the skill still builds, checks and draws the unit, and hands over the page as a file.
---

# 3D Living Space

You build a **unit**: a to-scale model of one apartment, as plain data. Rooms are
the clear floor inside the walls; the walls come from the gaps between rooms;
doors and windows are placed by a point in their wall; kitchens, baths, closets and
laundry are fixtures; furniture and decor are placed pieces. The scripts check
everything as you go, draw a labeled plan for you to compare with the floor plan,
and turn the unit into an Artifact page: a 3D model the person opens on their phone
or computer, walks through, furnishes and shares.

Everything runs through one script. Set `S` to this skill's `scripts` folder and
keep the work in one folder per unit:

```sh
S=<this skill's folder>/scripts
node $S/space.mjs doctor              # Node version, the renderer, the fonts
node $S/space.mjs new --dir home      # a fresh unit in ./home (add --example for the demo unit)
node $S/space.mjs help                # the tools; `help build_unit` for one tool's full input
```

Every tool takes its arguments as JSON (a file, `-` for stdin, or inline) and
prints JSON back. Write the arguments to a file when they're long:

```sh
node $S/space.mjs build_unit home/build.json --dir home
node $S/space.mjs render_plan --dir home      # writes home/plan.png: open it and look
```

The tools are: `get_unit`, `get_catalog`, `build_unit`, `edit_unit`, `set_info`,
`place_items`, `update_items`, `remove_items`, `create_asset`, `find_spots`,
`check_unit`, `render_plan`. `references/tools.md` documents every field; read the
part for a tool before its first call.

## Coordinates

Inches. x runs east (left to right on the floor plan), z runs south (top to
bottom), y is up. Put the origin at the plan's top-left (north-west) outside corner
so everything has positive coordinates. Rotations are degrees clockwise on the plan:
0 means a fixture's or a piece's front faces south (down the plan), 90 west, 180
north, 270 east.

## Build it from the floor plan and photos

1. Look at everything the person shared. Note the room sizes printed on the plan,
   the north arrow, where doors swing, what the photos show of heights, the kitchen's
   cabinet order and the finishes. Run `get_catalog` once.
2. **Rooms are the clear floor inside the walls.** Use the printed sizes (width ×
   length, wall to wall). Where two rooms share a wall, leave the wall's thickness
   between their outlines (interior walls are about 4.5 in); where rooms are open to
   each other (a kitchen open to the living room), let the outlines touch. Outside
   walls are added around everything (`exterior_wall` thick). Lay rooms out by adding
   up sizes and wall thicknesses along each row of rooms, using the plan's
   proportions to place them; don't rely on reading pixel positions alone. Give each
   room its `plan_size` as printed, so the check catches a wrong outline.
3. **Call `build_unit`** with the rooms; the doors and windows, each placed by its
   center point in its wall plus its width (doors take `hinge` and `opens` as compass
   directions: which end the hinges are on, which way it swings); and the fixtures:
   the kitchen as `kitchen-run` fixtures listing cabinets and appliances left to right
   as you face them, bath fixtures (toilet, vanity, tub or shower), laundry, closet
   rods. Set the ceiling height, door height, window sill and head; the photos often
   show them (doors are usually 80 in tall).
4. **Look at `render_plan`** next to the floor plan, every time. Fix positions and
   sizes with `edit_unit` (only what you pass changes), and fix every problem that
   `build_unit`, `edit_unit` and `check_unit` report. Repeat until the plan matches
   and nothing is reported.
5. Set the finishes from the photos: floors per room, wall paint, cabinets, counters,
   backsplash, appliances, hardware. Set `north` from the plan's north arrow so the sun
   comes in the right windows. Name it with `set_info` or the `name` setting.

## Furnish and decorate

Pick pieces from `get_catalog` and place them with `place_items`; for anything the
catalog lacks, build it with `create_asset` and place it as `asset:<id>`. Leave 30
to 36 in to walk, keep door swings clear, and check with `check_unit` and
`render_plan`. `find_spots` suggests where a footprint fits. Pieces overlap only where
their parts do, at the same height, so tuck them in the way real furniture goes: a
dining chair's seat under the table up to its back (about 19 in for the catalog
chair), a desk chair under the desk, stools under an island's overhang, a lamp's
shade over a sofa's arm, a table in a sectional's open corner.

Every catalog piece has a placement. Floor pieces stand on the floor. Surface pieces
(table lamps, books, a vase, plates, a laptop, a coffee maker) rest on a placed piece
or a counter: pass `on` with the piece's or fixture's id (`at` says where on it;
`elevation` picks a bookshelf's shelf), or just an `at` over it. Wall pieces (art,
mirrors, a wall TV, sconces, wall shelves, curtains, blinds) hang with their back
against the wall nearest `at`, facing into the room; `elevation` is the height of
their underside: center art about 57 to 60 in up, a TV about 42 to 50 in, sconces
about 66 in; hang curtains wider than the window, from just under the ceiling to the
floor. Ceiling pieces (pendants, fans) hang from the ceiling; a pendant's height is
its drop, so its shade hangs about 30 to 36 in above a dining table. Moving a piece
carries what rests on it, and removing it removes them. Give a piece an `id` when you
place it to put other things on it in the same call.

Ask how they live before furnishing a whole place: who lives there, what they own
already, what they want to do in each room.

## Publish it as an Artifact

```sh
node $S/space.mjs bundle --dir home     # writes home/artifact/ and prints the publish call
```

1. Call the **Artifact** tool with exactly what `bundle` printed (`file_path`,
   `root`, `files`, `capabilities`, `icon`, `description`). The page is the full 3D
   app; `unit.json` beside it is a snapshot that every visitor sees first, and the
   only thing visitors who aren't signed in ever see.
2. Run `node $S/space.mjs push --dir home --url <the artifact's URL>` and make the
   **ArtifactData** `batch` call(s) it prints. That seeds the Artifact's database,
   which is what makes it live: from then on, what you write shows up in their open
   page within seconds, and what they change in the page comes back to you.
3. Give them the link, and say what they can do there: Dollhouse, Plan and Walk
   views, tap a door or a drawer, the tape measure, furnishing, the time of day. Say
   how sharing works: the Share menu at the top of the Artifact; people they share it
   with as Editors can furnish it; Contributors can make their own version and suggest
   it back; Viewers, and anyone with a public link, can look around.

## Changing a published unit

The person may have moved furniture in the page since. Before changing anything:

1. **Pull.** With ArtifactData, read `unit` (`list`, collection `unit`) and `assets`
   (`list`) with `out_dir` set to `home/db`. Then pass the text the tool printed (the
   lines with each document's version) to `pull`:
   `node $S/space.mjs pull --from home/db --dir home <<'EOF'` … the listing … `EOF`
2. Change the unit with the tools as before, and look at the plan.
3. **Push.** `node $S/space.mjs push --dir home` prints the ArtifactData `batch` call(s)
   with each document's version. If a write is refused because a document changed,
   the person changed it meanwhile: pull again and redo your change on top.
4. When a round of changes is done, refresh the snapshot that signed-out visitors
   see: `node $S/space.mjs bundle --dir home --snapshot-only` and publish what it
   prints (same Artifact URL; only `unit.json` changes, and open pages reload).

## Suggestions

People who make their own version in the page can send it back as a suggestion. The
person sees and applies them in the page (Furnish tab). If they ask you about them,
read the `suggestions` collection with ArtifactData: each document is one person's
layout (`items`), the layout it started from (`base`) and a note. Describe what each
would change; apply one only when asked, by placing, moving or removing those pieces
with the tools and pushing.

## Without the Artifact tools

Where there's no Artifact tool (claude.ai chat, the API), build and check the unit
the same way and show the plan pictures. `bundle` still writes the page's files; tell
the person the live, shareable page needs Claude Code.

## Privacy

The link can be shared publicly. Never put a street address, building name, unit
number or anyone's full name in any name, title or label. The photos and the floor
plan stay in the conversation: nothing from them goes into the Artifact except the
measurements and finishes you read off them.

## Demo

`new --example` starts from the example unit, a 2 bed, 2 bath apartment traced from
its leasing plan, without furniture: a quick way to show what the page does, or to
practice furnishing.
