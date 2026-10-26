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

Everything runs through one script, `scripts/space.mjs` in this skill's folder.
It keeps the unit in a work folder (`./living-space` unless you pass `--dir`), so
each call picks up where the last one left off:

```sh
S=<this skill's folder>/scripts
node $S/space.mjs doctor                  # Node, the plan renderer, the fonts
node $S/space.mjs new                     # an empty unit (new --example: the demo apartment)
node $S/space.mjs help                    # the tools and commands
node $S/space.mjs help build_unit         # one tool: what it does, every field of its input
```

The tools take one JSON object, inline, from a file, or `-` for stdin, and print
JSON back. Write long arguments to a file:

```sh
node $S/space.mjs get_catalog
node $S/space.mjs build_unit living-space/build.json
node $S/space.mjs render_plan             # writes living-space/plan.png: open it and look
```

The tools are `get_unit`, `get_catalog`, `build_unit`, `edit_unit`, `set_info`,
`place_items`, `update_items`, `remove_items`, `create_asset`, `find_spots`,
`check_unit` and `render_plan`. Read `help <tool>` (or `references/tools.md`, where
it exists) before a tool's first call: every field says its unit and default. Most
outputs end with a `next` that says what to do after.

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
2. **Get the scale, then measure.** Plans print sizes for a few rooms only. Work out
   the plan's pixels per inch from those (a printed size is wall to wall, in either
   order), check it against a second room, then measure everything else (closets,
   halls, baths, door and window positions) off the picture with that scale.
3. **Rooms are the clear floor inside the walls.** Where two rooms share a wall,
   leave the wall's thickness between their outlines (interior walls are about
   4.5 in); where rooms are open to each other (a kitchen open to the living room),
   let the outlines touch. Outside walls are added around everything
   (`exterior_wall` thick). Lay rooms out by adding up sizes and wall thicknesses
   along each row of rooms, using the plan's proportions to place them. Give a
   rectangular room its `plan_size` as printed and the check compares its outline
   with it; for an L-shaped room, compare by eye.
4. **Call `build_unit`** with the rooms; the doors and windows, each placed by its
   center point in its wall plus its width (doors take `hinge` and `opens` as compass
   directions: which end the hinges are on, which way it swings); and the fixtures:
   the kitchen as `kitchen-run` fixtures listing cabinets and appliances left to right
   as you face them (list the parts that matter: the width left over becomes base
   cabinet by itself, while a `base` with no width is a 24 in one), bath fixtures
   (toilet, vanity, tub or shower), laundry, closet rods. Set the ceiling height, door
   height, window sill and head; the photos often show them (doors are usually 80 in
   tall). `floor_level` (default 3) sets the view out of the windows.
5. **Look at the plan** next to the floor plan, every time. Lay the floor plan over
   the drawing to see where they disagree:
   `render_plan --overlay <the plan picture> --overlay-scale <its pixels per inch> --overlay-origin <x,y: the pixel at your [0, 0] corner>`.
   Fix positions and sizes with `edit_unit` (only what you pass changes), and fix
   every problem that `build_unit`, `edit_unit` and `check_unit` report. Repeat until
   the plan matches and nothing is reported.
6. Set the finishes from the photos: floors per room, wall paint, cabinets, counters,
   backsplash, appliances, hardware. Where what they describe isn't on offer (a floor's
   exact tone, a door style), pick the closest and tell them. Set `north` from the
   plan's north arrow so the sun comes in the right windows. Give it a title with
   `set_info`: the page and its link show it, next to the bed and bath count, so
   don't repeat those.
7. Tell them what you read off the plan and what you assumed (which bedroom is the
   primary, what a symbol is, things the plan doesn't show), so they can correct you.

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

When the plan matches and nothing is reported:

1. `node $S/space.mjs bundle` writes the page's files and prints a `publish` object.
   Call the **Artifact** tool with it as it is (`file_path`, `root`, `files`,
   `capabilities`, `icon`, `description`). The page is the whole 3D app; `unit.json`
   beside it is a snapshot that everyone sees first, and all that visitors who
   aren't signed in ever see.
2. `node $S/space.mjs push --url <the Artifact's URL>` prints the **ArtifactData**
   `batch` call(s) that fill the Artifact's database; make them. That makes the page
   live: from then on what you push shows up in their open page within seconds, and
   what they change there comes back to you.
3. Give them the link and say what they can do: Dollhouse, Plan and Walk views, tap
   a door, a drawer or a lamp, the tape measure, the time of day, furnishing. And how
   sharing works: the Share menu at the top of the Artifact. People they share it with
   as Editors can furnish it; Contributors can make their own version and suggest it
   back; Viewers, and anyone with a public link, can look around. Everyone with the
   page open sees the others walking through it, and a selected piece's *Ask Claude*
   button hands that piece to you in this conversation.

## Changing a published unit

They may have moved furniture in the page since you last looked, so:

1. **Pull.** `node $S/space.mjs pull` prints two ArtifactData reads; make them, then
   run the `pull --from …` it shows with both results pasted in as they are (they
   carry each document's version).
2. Change the unit with the tools, and look at the plan.
3. **Push.** `node $S/space.mjs push`, then make the `batch` call(s) it prints. If a
   write is refused because a document changed, they saved in the page meanwhile:
   pull again and redo your change on top. Pull before every push.
4. When a round of changes is done, refresh the snapshot that signed-out visitors see:
   `node $S/space.mjs bundle --snapshot-only` and publish what it prints (it replaces
   only `unit.json`; open pages reload).

If they send you a piece or a room from the page (an attachment naming a `piece_id`
or a `room`), that's what they mean: pull, then act on it.

If they say the page won't load, read what it recorded when they opened it: ArtifactData
`get`, collection `data/users/me`, doc `boot` (how far it got, any errors, their
browser). The page also shows the error on screen.

## Suggestions

People who make their own version in the page can send it back as a suggestion. The
person sees and applies them in the page (Furnish tab). If they ask you about them,
read the `suggestions` collection with ArtifactData: each document is one person's
layout (`items`), the layout it started from (`base`) and a note. Describe what each
would change; apply one only when asked, by placing, moving or removing those pieces
with the tools and pushing.

## Without the Artifact tools

Where there's no Artifact tool (claude.ai chat, the API), build, check and draw the
unit the same way and show them the plan. Then `node $S/space.mjs bundle --single
--out <file>` writes the whole page with their unit inside as one HTML file (about
4 MB): save it where they can download it (on claude.ai, the outputs folder) and
tell them to open it in a browser. It works offline except for the 3D
library and fonts, keeps their furniture changes in that browser, and has no sharing;
the live, shareable page needs Claude Code.

## Privacy

The link can be shared publicly. Never put a street address, building name, unit
number or anyone's full name in any name, title or label. The photos and the floor
plan stay in the conversation: nothing from them goes into the Artifact except the
measurements and finishes you read off them.

## Demo

`new --example` starts from the example unit, a 2 bed, 2 bath apartment traced from
its leasing plan, without furniture: a quick way to show what the page does, to
practice furnishing, or to show what a finished build looks like (`render_plan`).
