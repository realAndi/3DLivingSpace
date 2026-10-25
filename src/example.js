// The example unit: the 2 bed / 2 bath (821 sq ft) this project started from,
// as a unit spec (see src/unit.js).
//
// Everything on the floor plane is traced from the leasing plan in
// assets/floorplan.png and written in that image's pixel coordinates, so any
// number here can be checked against the drawing. X() and Z() convert to feet.
// The scale (25.86 px per foot) reproduces the three labeled room sizes:
//   Bedroom 2     10'10" x 10'1"   -> traced 10'10" x 10'1"
//   Primary       10'11" x 12'     -> traced 11'1"  x 12'1"
//   Living/Dining 12'7"  x 19'9"   -> traced 12'6"  x 20'1"
//
// Two tape measurements, both taken from the living room's window wall:
//   to the side of the fridge (flush with the short wall it stands against): 112"
//   to the primary bedroom door's trim, along the other wall: 129-130"
// The drawing comes out about 4" short on both. Moving the window wall out
// 3.9" (EAST_PX) makes the first exact and puts the second between the door's
// trim (127.5") and its opening (131"); nothing else had to move. The living
// room is then 20'5" long, so its printed 19'9" is left off.
//
// Heights come from solving the camera pose of the living room and primary
// bedroom photos against the traced walls (wall corners and floor/ceiling
// lines, 6.5 px rms): a 9'0" ceiling, 8' doors, windows from about 23" up to
// the door heads. The kitchen's cabinet order and the primary bath's layout
// follow the photos; Bedroom 2 and Bath 2 follow the plan.

const PX = 25.86, OX = 91, OZ = 60;
// The living room's window wall (inside face), in plan px: 112" east of the
// kitchen pier's west face (px 804) by tape. The drawing has it at px 1037.
const EAST_PX = 804 + (112 / 12) * PX;
const X = (px) => (px - OX) / PX;
const Z = (px) => (px - OZ) / PX;
const P = ([x, z]) => [X(x), Z(z)];
const r4 = (v) => Math.round(v * 10000) / 10000;
const pt = (p) => p.map(r4);

const room = (id, name, kind, px, extra = {}) => ({ id, name, kind, poly: px.map((p) => pt(P(p))), ...extra });

const rooms = [
  room('living', 'Living / Dining', 'living', [[517, 376], [EAST_PX, 376], [EAST_PX, 699], [517, 699]]),
  room('primary', 'Primary Bedroom', 'bedroom', [[605, 79], [984, 79], [984, 366], [672, 366], [672, 175], [605, 175]], { planSize: `10'11" × 12'` }),
  room('bed2', 'Bedroom 2', 'bedroom', [[109, 79], [370, 79], [370, 349], [246, 349], [246, 359], [109, 359]], { planSize: `10'10" × 10'1"` }),
  room('bath1', 'Primary Bath', 'bath', [[446, 79], [595, 79], [595, 247], [446, 247]]),
  room('bath2', 'Bath 2', 'bath', [[258, 513], [440, 513], [440, 570], [504, 570], [504, 699], [258, 699]]),
  room('hall', 'Entry Hall', 'hall', [[258, 359], [517, 359], [517, 484], [440, 484], [440, 503], [258, 503]]),
  room('wic', 'Walk-in Closet', 'closet', [[528, 257], [605, 257], [605, 190], [661, 190], [661, 366], [528, 366]]),
  room('laundry', 'Laundry', 'laundry', [[380, 257], [517, 257], [517, 359], [380, 359]]),
  room('closet2', 'Closet', 'closet', [[380, 79], [435, 79], [435, 247], [380, 247]]),
  room('coat', 'Coat', 'closet', [[450, 494], [504, 494], [504, 556], [450, 556]]),
];

// Where to stand when jumping into a room in walk mode: [x, z] in plan px and a compass yaw.
const VIEWS = {
  living: [[560, 440], 100], primary: [[705, 345], 40], bed2: [[330, 330], 315], bath1: [[585, 120], 255], bath2: [[395, 530], 200],
  hall: [[290, 450], 90], laundry: [[450, 420], 0], wic: [[700, 285], 270], closet2: [[300, 160], 90], coat: [[478, 440], 180],
};
for (const r of rooms) r.view = { at: pt(P(VIEWS[r.id][0])), yaw: VIEWS[r.id][1] };

// Doors and windows, centered in their wall: the wall's middle across its
// thickness, and the opening's middle along it.
const across = (a, b) => (a + b) / 2;
const ew = (z0, z1, from, to) => [across(from, to), across(z0, z1)];  // in a wall running east-west
const ns = (x0, x1, from, to) => [across(x0, x1), across(from, to)];  // in a wall running north-south
const opening = (id, type, [px, pz], widthPx, extra = {}) => ({ id, type, at: pt(P([px, pz])), width: r4(widthPx / PX), ...extra });

const openings = [
  // Windows. The living window is measured from the hall photo: a 6'11" opening
  // centered on the wall, split 58/42 by the mullion (the plan symbol draws ~9').
  // The primary window's north edge lands on the plan's line in the bedroom
  // photo; it is taken to be the same 6'11" unit. The others follow the plan.
  // Mullions are fractions from the west (or north) end.
  opening('win-bed2', 'window', ew(60, 79, 177, 307), 130, { mullions: [0.5], transom: 3.8 }),
  opening('win-bath1', 'window', ew(60, 79, 535, 589), 54, { panes: 1, transom: 3.8 }),
  opening('win-nook', 'window', ew(60, 79, 609, 667), 58, { panes: 1, transom: 3.8 }),
  opening('win-primary', 'window', ns(984, 1004, 129, 307), 178, { mullions: [0.577], transom: 3.8 }),
  opening('win-living', 'window', ns(EAST_PX, EAST_PX + 19, 449, 627), 178, { mullions: [0.577], transom: 3.8 }),

  opening('entry', 'entry', ns(239, 258, 405, 494), 89, { name: 'Entry door', hinge: 'south', opens: 'east', open: 0 }),
  opening('bed2', 'door', ew(349, 359, 280, 362), 82, { name: 'Bedroom 2 door', hinge: 'east', opens: 'north', open: 90 }),
  opening('closet2', 'bifold', ns(370, 380, 92, 224), 132, { name: 'Closet doors' }),
  opening('bath2', 'door', ew(503, 513, 347, 422), 75, { name: 'Bath 2 door', hinge: 'east', opens: 'south', open: 90 }),
  opening('coat', 'door', ew(484, 494, 450, 504), 54, { name: 'Coat closet door', hinge: 'east', opens: 'north', open: 0 }),
  opening('primary', 'door', ew(366, 376, 676, 763), 87, { name: 'Primary bedroom door', hinge: 'west', opens: 'north', open: 88 }),
  opening('wic', 'door', ns(661, 672, 243, 320), 77, { name: 'Walk-in closet door', hinge: 'south', opens: 'east', open: 0 }),
  opening('bath1', 'door', ns(595, 605, 84, 157), 73, { name: 'Primary bath door', hinge: 'north', opens: 'west', open: 92 }),
];

// The short wall the kitchen's back run ends against.
const walls = [{ id: 'kitchen-pier', a: pt(P([809, 638])), b: pt(P([809, 699])), t: r4(10 / PX) }];

// ---------------------------------------------------------------------------
// Fixtures. Centers in feet; width × depth as you face the front; rotation
// clockwise on the plan with 0 = front facing south.
const WEST = X(517), SOUTH = Z(699), PIER = X(804), NORTH_END = Z(497), COUNTER = 2.125;
const fx = (id, type, x, z, w, d, h, rot, extra = {}) => ({ id, type, x: r4(x), z: r4(z), w: r4(w), d: r4(d), h: r4(h), rot, ...extra });

// Primary bath: the plan draws a corner shower and a toilet on the west wall,
// but the photos show a full-width walk-in shower with a fixed glass panel on
// the west, the vanity on the south wall and the toilet beside it against the
// east (door) wall.
const B1 = { x0: X(446), x1: X(595), z0: Z(79), z1: Z(247) }, SHOWER_X = 16.6;
// Hall bath: not photographed, so it follows the plan with the same finishes.
const B2 = { x0: X(258), z1: Z(699), tubX0: X(440), tubX1: X(504), tubZ0: Z(570) };

const fixtures = [
  // L-shaped kitchen in the south-west corner of the great room, from the kitchen photo:
  //   south run (east -> west): end panel, fridge, base with drawer, range, filler, blind corner
  //   west run (south -> north): corner, 12" base, sink base, dishwasher, end panel
  // The west run stops about 6" short of the hall wall's end: both photos show a
  // strip of bare wall between the end panel and the hall.
  fx('kitchen-south', 'kitchen-run', (WEST + PIER) / 2, SOUTH - COUNTER / 2, PIER - WEST, COUNTER, 3, 180, {
    name: 'Kitchen: fridge and range',
    opts: {
      segments: [
        { kind: 'end', w: 0.1 }, { kind: 'fridge', w: 3.25 }, { kind: 'base', w: 3, drawers: true },
        { kind: 'range', w: 2.5 }, { kind: 'filler', w: 0.25 }, { kind: 'corner', w: PIER - WEST - 9.1 },
      ],
      upper_bottom: 4.5, upper_top: 8, soffit: true, hood: 'microwave',
    },
  }),
  fx('kitchen-west', 'kitchen-run', WEST + COUNTER / 2, (NORTH_END + SOUTH) / 2, SOUTH - NORTH_END, COUNTER, 3, 270, {
    name: 'Kitchen: sink and dishwasher',
    opts: {
      segments: [
        { kind: 'corner', w: 2 }, { kind: 'base', w: 1 }, { kind: 'sink', w: 2.75 },
        { kind: 'dishwasher', w: 2 }, { kind: 'end', w: SOUTH - NORTH_END - 7.75 },
      ],
      upper_bottom: 4.5, upper_top: 8, soffit: true,
    },
  }),

  fx('shower1', 'shower', (B1.x0 + SHOWER_X) / 2, (B1.z0 + B1.z1) / 2, B1.z1 - B1.z0, SHOWER_X - B1.x0, 9, 270, { name: 'Walk-in shower', opts: { glass: 'panel', entry: 'right', curb: true } }),
  fx('wainscot1', 'wall-tile', (SHOWER_X + B1.x1) / 2, B1.z1 - 0.015, B1.x1 - SHOWER_X, 0.03, 4, 180, { name: 'Tile wainscot' }),
  fx('vanity1', 'vanity', 17.68, B1.z1 - 1.67 / 2, 2, 1.67, 2.84, 180, { name: 'Primary vanity' }),
  fx('toilet1', 'toilet', B1.x1 - 2.35 / 2, 4.7, 1.72, 2.35, 2.52, 90, { name: 'Primary toilet' }),

  fx('vanity2', 'vanity', B2.x0 + 1.75 / 2, (Z(515) + Z(592)) / 2, 3, 1.75, 2.84, 270, { name: 'Bath 2 vanity' }),
  fx('toilet2', 'toilet', B2.x0 + 2.35 / 2, Z(664), 1.72, 2.35, 2.52, 270, { name: 'Bath 2 toilet' }),
  fx('tub2', 'tub', (B2.tubX0 + B2.tubX1) / 2, (B2.tubZ0 + B2.z1) / 2, B2.z1 - B2.tubZ0, B2.tubX1 - B2.tubX0, 1.45, 90, { name: 'Tub', opts: { shower: true, enclosure: 'curtain', tile_height: 7.6 } }),

  fx('closet2-rod', 'closet', X(435) - 0.6, (Z(79) + Z(247)) / 2, Z(247) - Z(79), 1.2, 5.2, 90, { name: 'Closet rod' }),
  fx('coat-rod', 'closet', (X(450) + X(504)) / 2, Z(556) - 0.6, X(504) - X(450), 1.2, 5.2, 180, { name: 'Coat rod' }),
  fx('wic-west', 'closet', X(528) + 0.6, (Z(257) + Z(366)) / 2, Z(366) - Z(257), 1.2, 5.2, 270, { name: 'Walk-in rod, west' }),
  fx('wic-south', 'closet', (X(528) + 1.2 + X(661)) / 2, Z(366) - 0.6, X(661) - X(528) - 1.2, 1.2, 5.2, 180, { name: 'Walk-in rod, south' }),
  fx('wic-north', 'closet', (X(605) + X(661)) / 2, Z(190) + 0.6, X(661) - X(605), 1.2, 5.2, 0, { name: 'Walk-in rod, nook' }),

  // Stacked washer/dryer facing the hall, and the water heater drawn as a circle on the plan.
  fx('laundry', 'washer-dryer', (X(395) + X(447)) / 2, Z(270) + (Z(325) - Z(270)) / 2, 2, Z(325) - Z(270), 6.55, 0, { name: 'Stacked washer and dryer' }),
  fx('water-heater', 'water-heater', X(492), Z(295), 1.72, 1.72, 5, 0, { name: 'Water heater' }),
];

// Recessed cans, positioned from the photos (plan px).
const lights = [
  [960, 455], [960, 610], [736, 520], [640, 560], [740, 610],
  [320, 430], [470, 425], [840, 230], [640, 125], [240, 220],
  [520, 160], [350, 600], [595, 312], [448, 305],
].map((p) => pt(P(p)));

export const EXAMPLE_UNIT = {
  name: '2 bed / 2 bath',
  beds: 2, baths: 2, sqft: 821,
  ceiling: 9, doorHeight: 8, windowSill: 1.9, windowHead: 8,
  exteriorWall: r4(19 / PX),
  level: 4,
  finishes: { walls: '#f2f1ee', floor: 'wood', cabinets: 'oak', counters: 'quartz', backsplash: 'subway', appliances: 'steel', hardware: 'black', tile: 'warm-gray' },
  rooms, walls, openings, fixtures,
  labels: [{ text: 'Kitchen', at: pt(P([660, 600])) }, { text: 'Dining', at: pt(P([736, 455])) }],
  lights,
  start: { at: pt(P([285, 450])), yaw: 90 },
  planImage: { src: 'assets/floorplan.png', x: r4(X(0)), z: r4(Z(0)), w: r4(1200 / PX), h: r4(730 / PX) },
};

export const EXAMPLE_TITLE = 'Example: 2 bed, 2 bath';
