# 3D Living Space

Claude turns your floor plan and a few photos into a to-scale 3D model of your
apartment: rooms, walls, doors, windows, kitchen and baths, checked against the
plan. Then furnish it yourself or ask Claude to, walk through it, measure
anything, and share it.

## Install

From the [latest release](https://github.com/realAndi/3DLivingSpace/releases/latest):

- **claude.ai, the Claude desktop app and Cowork:** download
  `3d-living-space-plugin.zip`, then Customize, Plugins, Add, Upload plugin. It
  then also appears in Claude Code signed in to the same account.
- **Claude Code** (the terminal, or the desktop app's Code tab): the release
  notes give the one `/plugin install 3d-living-space --marketplace …` line that
  adds this repository's marketplace and installs the plugin from it.
- **The skill alone:** `3d-living-space.zip` goes in Customize, Skills on
  claude.ai, or unzipped into `~/.claude/skills/` for Claude Code.

Its scripts need Node.js 18 or later where Claude runs them, and on claude.ai,
code execution turned on.

## Use it

Attach your floor plan (ideally with the room sizes printed on it) and a few
photos, and ask Claude to build your apartment in 3D. In Claude Code, Claude
publishes the model as a live page on claude.ai: you and the people you share
it with open it on a phone or computer, and changes from Claude and from the
page show up everywhere within seconds. In claude.ai chat, Claude builds and
checks the same model and hands it over as one HTML file to download and open.

Setup, sharing and troubleshooting:
https://github.com/realAndi/3DLivingSpace#as-a-claude-skill

## Data

The skill's scripts run where Claude runs and send nothing anywhere. The page
it publishes lives on claude.ai and keeps the unit and its furniture in that
page's own database; it loads three.js from jsDelivr and its fonts from Google
Fonts. Your photos and floor plan stay in your conversation: only the
measurements and finishes Claude reads off them go into the model.

The skill is MIT licensed. It bundles zod (MIT), resvg (MPL 2.0) and the IBM
Plex fonts (OFL), each with its license text.
