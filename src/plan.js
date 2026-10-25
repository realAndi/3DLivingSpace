// Geometry for the 2 bed / 2 bath unit (821 sq ft).
//
// Everything on the floor plane is traced from the leasing plan in
// assets/floorplan.png and written in that image's pixel coordinates, so any
// number here can be checked against the drawing. X() and Z() convert to feet.
// The scale (25.86 px per foot) reproduces the three labeled room sizes:
//   Bedroom 2     10'10" x 10'1"   -> traced 10'10" x 10'1"
//   Primary       10'11" x 12'     -> traced 11'1"  x 12'1"
//   Living/Dining 12'7"  x 19'9"   -> traced 12'6"  x 20'1"
//
// World axes: x = east (plan right), z = south (plan down), y = up. Units: feet.
// Heights come from the photos (see notes on each value).

export const PLAN_IMAGE = { src: 'assets/floorplan.png', w: 1200, h: 730, pxPerFt: 25.86, ox: 91, oz: 60 };

export const X = (px) => (px - PLAN_IMAGE.ox) / PLAN_IMAGE.pxPerFt;
export const Z = (px) => (px - PLAN_IMAGE.oz) / PLAN_IMAGE.pxPerFt;
export const IN = (inches) => inches / 12;

// Heights come from solving the camera pose of the living room and primary
// bedroom photos against the traced walls (wall corners and floor/ceiling
// lines, 6.5 px rms). That fit puts the ceiling at 9'0"; window corners
// back-projected from the same fit give the sill and head below.
export const HEIGHT = {
  ceiling: 9.0,
  // The primary bath door head sits about a foot under the ceiling: 8' doors.
  doorHead: 8.0,
  // Window head lines up with the door heads; sill about 23" off the floor.
  windowSill: 1.9,
  windowHead: 8.0,
  transom: 3.8,
  eye: 5.2,
};

// ---------------------------------------------------------------------------
// Walls: rectangles in plan pixels. `inside` marks exterior walls and points
// toward the unit (N/S/E/W).
const wall = (id, x0, z0, x1, z1, inside = null) => ({
  id, inside, px: [x0, z0, x1, z1],
  x0: X(x0), z0: Z(z0), x1: X(x1), z1: Z(z1),
  axis: x1 - x0 >= z1 - z0 ? 'x' : 'z',
});

export const WALLS = [
  wall('north', 91, 60, 1004, 79, 'S'),
  wall('west-bed2', 91, 79, 109, 377, 'E'),
  wall('south-bed2', 109, 359, 258, 377, 'N'),
  wall('west-entry', 239, 377, 258, 718, 'E'),
  wall('south', 258, 699, 1056, 718, 'N'),
  wall('east-living', 1037, 376, 1056, 699, 'W'),
  wall('jog', 984, 356, 1056, 376, 'S'),
  wall('east-primary', 984, 79, 1004, 356, 'W'),

  wall('bed2-hall', 246, 349, 370, 359),
  wall('closet2-west', 370, 79, 380, 359),
  wall('closet2-east', 435, 79, 446, 247),
  wall('bath1-south', 370, 247, 605, 257),
  wall('bath1-east', 595, 79, 605, 247),
  wall('nook-south', 605, 175, 672, 190),
  wall('wic-east', 661, 190, 672, 366),
  wall('wic-west', 517, 257, 528, 366),
  wall('primary-south', 517, 366, 984, 376),
  wall('coat-west', 440, 484, 450, 570),
  wall('coat-north', 450, 484, 504, 494),
  wall('coat-east', 504, 484, 517, 699),
  wall('coat-south', 450, 556, 504, 570),
  wall('bath2-north', 258, 503, 440, 513),
  wall('kitchen-pier', 804, 638, 814, 699),
];

export const wallById = Object.fromEntries(WALLS.map((w) => [w.id, w]));

// ---------------------------------------------------------------------------
// Openings, located along their wall in plan pixels (`from` < `to`).
// Doors: `hinge` is the end the hinges sit on ('from' or 'to'), `swing` is the
// side the leaf opens toward, `open` is the starting angle in degrees.
export const OPENINGS = [
  // Windows. The living window is measured from the hall photo: a 6'11" opening
  // centered on the wall, split 58/42 by the mullion (the plan symbol draws ~9').
  // The primary window's north edge lands on the plan's line in the bedroom
  // photo; it is taken to be the same 6'11" unit. The others follow the plan.
  { id: 'win-bed2', wall: 'north', type: 'window', from: 177, to: 307, mullions: [0.5] },
  { id: 'win-bath1', wall: 'north', type: 'window', from: 535, to: 589 },
  { id: 'win-nook', wall: 'north', type: 'window', from: 609, to: 667 },
  { id: 'win-primary', wall: 'east-primary', type: 'window', from: 129, to: 307, mullions: [0.577] },
  { id: 'win-living', wall: 'east-living', type: 'window', from: 449, to: 627, mullions: [0.577] },

  { id: 'entry', name: 'Entry door', wall: 'west-entry', type: 'door', from: 405, to: 494, hinge: 'to', swing: 'E', open: 0 },
  { id: 'bed2', name: 'Bedroom 2 door', wall: 'bed2-hall', type: 'door', from: 280, to: 362, hinge: 'to', swing: 'N', open: 90 },
  { id: 'closet2', name: 'Closet doors', wall: 'closet2-west', type: 'bifold', from: 92, to: 224 },
  { id: 'bath2', name: 'Bath 2 door', wall: 'bath2-north', type: 'door', from: 347, to: 422, hinge: 'to', swing: 'S', open: 90 },
  { id: 'coat', name: 'Coat closet door', wall: 'coat-north', type: 'door', from: 450, to: 504, hinge: 'to', swing: 'N', open: 0 },
  { id: 'primary', name: 'Primary bedroom door', wall: 'primary-south', type: 'door', from: 676, to: 763, hinge: 'from', swing: 'N', open: 88 },
  { id: 'wic', name: 'Walk-in closet door', wall: 'wic-east', type: 'door', from: 243, to: 320, hinge: 'to', swing: 'E', open: 0 },
  { id: 'bath1', name: 'Primary bath door', wall: 'bath1-east', type: 'door', from: 84, to: 157, hinge: 'from', swing: 'W', open: 92 },
];

// ---------------------------------------------------------------------------
// Rooms: floor polygons in plan pixels. `dims` is the size printed on the plan
// where there is one; other rooms show their traced size.
const room = (r) => ({ ...r, poly: r.px.map(([x, z]) => [X(x), Z(z)]), at: [X(r.labelAt[0]), Z(r.labelAt[1])] });

export const ROOMS = [
  room({ id: 'living', name: 'Living / Dining', dims: `12'7" × 19'9"`, floor: 'wood',
    px: [[517, 376], [1037, 376], [1037, 699], [517, 699]], labelAt: [905, 470] }),
  room({ id: 'primary', name: 'Primary Bedroom', dims: `10'11" × 12'`, floor: 'wood',
    px: [[605, 79], [984, 79], [984, 366], [672, 366], [672, 175], [605, 175]], labelAt: [835, 300] }),
  room({ id: 'bed2', name: 'Bedroom 2', dims: `10'10" × 10'1"`, floor: 'wood',
    px: [[109, 79], [370, 79], [370, 349], [246, 349], [246, 359], [109, 359]], labelAt: [240, 215] }),
  room({ id: 'bath1', name: 'Primary Bath', floor: 'tile',
    px: [[446, 79], [595, 79], [595, 247], [446, 247]], labelAt: [520, 165] }),
  room({ id: 'bath2', name: 'Bath 2', floor: 'tile',
    px: [[258, 513], [440, 513], [440, 570], [504, 570], [504, 699], [258, 699]], labelAt: [350, 610] }),
  room({ id: 'hall', name: 'Entry Hall', floor: 'wood',
    px: [[258, 359], [517, 359], [517, 484], [440, 484], [440, 503], [258, 503]], labelAt: [345, 430] }),
  room({ id: 'laundry', name: 'Laundry', floor: 'wood',
    px: [[380, 257], [517, 257], [517, 359], [380, 359]], labelAt: [448, 342] }),
  room({ id: 'wic', name: 'Walk-in Closet', floor: 'wood',
    px: [[528, 257], [605, 257], [605, 190], [661, 190], [661, 366], [528, 366]], labelAt: [594, 312] }),
  room({ id: 'closet2', name: 'Closet', floor: 'wood',
    px: [[380, 79], [435, 79], [435, 247], [380, 247]], labelAt: [407, 163] }),
  room({ id: 'coat', name: 'Coat', floor: 'wood',
    px: [[450, 494], [504, 494], [504, 556], [450, 556]], labelAt: [477, 525] }),
];

// Zones inside a room that get their own label.
export const ZONES = [
  { id: 'kitchen', name: 'Kitchen', at: [X(660), Z(600)], room: 'living' },
  { id: 'dining', name: 'Dining', at: [X(736), Z(455)], room: 'living' },
];

// Where to stand when jumping into a room in walk mode: [x, z] in plan px and a compass yaw.
export const ROOM_VIEWS = {
  living: { at: [560, 440], yaw: 100 },
  primary: { at: [705, 345], yaw: 40 },
  bed2: { at: [330, 330], yaw: 315 },
  bath1: { at: [585, 120], yaw: 255 },
  bath2: { at: [395, 530], yaw: 200 },
  hall: { at: [290, 450], yaw: 90 },
  laundry: { at: [450, 420], yaw: 0 },
  wic: { at: [700, 285], yaw: 270 },
  closet2: { at: [300, 160], yaw: 90 },
  coat: { at: [478, 440], yaw: 180 },
};

// ---------------------------------------------------------------------------
// The photos, with the camera pose that reproduces each one in the model.
// yaw is a compass bearing (0 = plan north/up, 90 = east); pitch and roll in
// degrees. Poses were solved against the traced walls (corners and floor and
// ceiling lines), then refined by aligning the model's edges to the photo's.
// vfov is each photo's vertical field of view: the living room and kitchen
// shots solve to 49.2° (about 28 mm equivalent), the bedroom to 58.5° (24 mm),
// and the 0.5x bath shots are 90° landscape and 106° portrait.
export const PHOTOS = [
  { id: 'living', title: 'Living room', caption: 'From the entry hall, looking at the east window',
    src: 'assets/photos/living-from-hall.jpg', thumb: 'assets/photos/living-from-hall-thumb.jpg', aspect: 4 / 3, vfov: 49.2,
    cam: { x: 13.79, y: 5.53, z: 13.73, yaw: 102.6, pitch: -11.7, roll: -1.1 } },
  { id: 'kitchen', title: 'Kitchen', caption: 'From the living area, looking into the kitchen corner',
    src: 'assets/photos/kitchen.jpg', thumb: 'assets/photos/kitchen-thumb.jpg', aspect: 4 / 3, vfov: 49.2,
    cam: { x: 33.08, y: 5.71, z: 14.24, yaw: 235.6, pitch: -8.9, roll: 0.2 } },
  { id: 'primary', title: 'Primary bedroom', caption: 'From the doorway, looking at the east window',
    src: 'assets/photos/primary-bedroom.jpg', thumb: 'assets/photos/primary-bedroom-thumb.jpg', aspect: 4 / 3, vfov: 58.5,
    cam: { x: 22.78, y: 6.35, z: 11.72, yaw: 42.4, pitch: -13.3, roll: 1.3 } },
  { id: 'bath-door', title: 'Primary bath', caption: 'From the shower, looking out the door',
    src: 'assets/photos/primary-bath-door.jpg', thumb: 'assets/photos/primary-bath-door-thumb.jpg', aspect: 3 / 4, vfov: 106.1,
    cam: { x: 14.59, y: 4.82, z: 3.56, yaw: 106.5, pitch: -9.4, roll: 1.2 } },
  { id: 'bath-shower', title: 'Primary bath shower', caption: 'From the door, looking at the vanity and shower',
    src: 'assets/photos/primary-bath-shower.jpg', thumb: 'assets/photos/primary-bath-shower-thumb.jpg', aspect: 4 / 3, vfov: 89.9,
    cam: { x: 19.87, y: 5.32, z: 2.99, yaw: 243.2, pitch: -10.5, roll: 0.4 } },
];

export const UNIT = {
  title: 'Two Bedrooms · Two Baths',
  area: 821,
  footprint: { x0: X(91), z0: Z(60), x1: X(1056), z1: Z(718) },
};
