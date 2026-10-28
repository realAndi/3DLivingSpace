import * as THREE from 'three';

// Together, as an Artifact (the room capability): everyone with the page open
// shares where they stand and which way they face, and sees the others in Walk
// and Dollhouse as figures in their own color, with their name, and as dots on
// the minimap. Presence only: nothing is kept, a figure goes when its viewer
// does, and alone (or on the site) the page is exactly as it was.
//
// It also hands things to the viewer's own Claude, the conversation open beside
// the page: a piece or a room, as data Claude can act on (ask()).

const SEND_MS = 100;        // at most ten updates a second
const MOVE = 1 / 6;         // feet before a move is worth sending
const TURN = 4;             // degrees, likewise
const STALE_MS = 5 * 60e3;  // a figure still that long fades
const EYE = 5.2;
const ASKABLE = new Set(['available', 'available_if_summoned', 'available_if_opened']);

const make = (tag, cls, text) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
};

// A person, about 5'8": a body, a head, and a nose so you can tell which way
// they face. Built facing -z (yaw 0 = north, as src/walk.js).
function figure(color) {
  const g = new THREE.Group();
  const mat = new THREE.MeshStandardMaterial({ color, roughness: 0.6 });
  const body = new THREE.Mesh(new THREE.CapsuleGeometry(0.5, 3.3, 4, 16), mat);
  body.scale.z = 0.7;
  body.position.y = 2.6;
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.36, 20, 14), mat);
  head.position.y = EYE;
  const nose = new THREE.Mesh(new THREE.ConeGeometry(0.11, 0.32, 10).rotateX(-Math.PI / 2), mat);
  nose.position.set(0, EYE, -0.4);
  g.add(body, head, nose);
  g.traverse((o) => { o.castShadow = true; });
  return g;
}

export function createTogether({ scene, stage, invalidate }) {
  const root = new THREE.Group();
  root.name = 'together';
  scene.add(root);
  const tags = make('div', 'peer-tags');
  stage.append(tags);
  const others = new Map();   // peer → { group, tag, at, yaw, mode, color, by, seen }
  let room = null, user = null, canAsk = false;
  let sent = null, lastSend = 0, timer = 0, wanted = null;

  function colorOf(p, profile) {
    try { return new THREE.Color(profile?.color || p.presence.color || '#a87a43'); } catch { return new THREE.Color('#a87a43'); }
  }

  async function names(list) {
    const ids = list.map((p) => p.by).filter(Boolean);
    return user && ids.length ? user.profiles(ids) : {};
  }

  async function onPeers({ peers }) {
    const here = peers.filter((p) => !p.isMe && p.kind === 'viewer');
    const profiles = await names(here);
    const keep = new Set();
    for (const p of here) {
      keep.add(p.peer);
      const at = Array.isArray(p.presence.at) && p.presence.at.length === 2 && p.presence.at.every(Number.isFinite) ? p.presence.at : null;
      let o = others.get(p.peer);
      if (!o) {
        o = { group: null, tag: make('div', 'peer-tag') };
        tags.append(o.tag);
        others.set(p.peer, o);
      }
      const profile = p.by ? profiles[p.by] : null;
      const color = colorOf(p, profile);
      if (!o.group || !o.color.equals(color)) {
        if (o.group) { root.remove(o.group); o.group.traverse((m) => m.geometry?.dispose()); }
        o.group = figure(color);
        root.add(o.group);
      }
      Object.assign(o, {
        at, yaw: Number.isFinite(p.presence.yaw) ? p.presence.yaw : 0, mode: p.presence.mode, color, seen: p.updatedAt,
      });
      o.tag.textContent = profile?.name || 'Someone';
      o.tag.style.setProperty('--peer', `#${color.getHexString()}`);
    }
    for (const [peer, o] of others) {
      if (keep.has(peer)) continue;
      if (o.group) { root.remove(o.group); o.group.traverse((m) => m.geometry?.dispose()); }
      o.tag.remove();
      others.delete(peer);
    }
    invalidate();
  }

  function send() {
    timer = 0;
    if (!room || !wanted) return;
    lastSend = performance.now();
    sent = wanted;
    room.presence(wanted).catch(() => {});
  }

  return {
    get canAsk() { return canAsk; },
    get count() { return others.size; },

    // The capabilities, once the viewer answers (either may be null).
    async connect(roomNs, userNs) {
      room = roomNs; user = userNs;
      if (!room) return;
      room.onPeers((change) => { onPeers(change); }, () => {});
      try { canAsk = ASKABLE.has(await room.canSendToClaudeSession?.()); } catch { canAsk = false; }
      if (wanted) send();
    },

    // Where this viewer is: every frame is fine, it sends only what changed.
    share(mode, walk) {
      if (!room) return;
      const next = mode === 'walk'
        ? { mode, at: [Math.round(walk.x * 100) / 100, Math.round(walk.z * 100) / 100], yaw: Math.round(walk.yaw) }
        : { mode, at: null, yaw: null };
      const same = sent && sent.mode === next.mode && (next.mode !== 'walk'
        || (Math.hypot(next.at[0] - sent.at[0], next.at[1] - sent.at[1]) < MOVE && Math.abs(next.yaw - sent.yaw) < TURN));
      wanted = next;
      if (same || timer) return;
      timer = setTimeout(send, Math.max(0, SEND_MS - (performance.now() - lastSend)));
    },

    // Before a frame is drawn: the figures, only for people walking.
    place(mode) {
      for (const o of others.values()) {
        o.group.visible = !!o.at && o.mode === 'walk' && mode !== 'plan';
        if (!o.group.visible) continue;
        o.group.position.set(o.at[0], 0, o.at[1]);
        o.group.rotation.y = -o.yaw * Math.PI / 180;
      }
    },

    // After it: their name tags, over their heads. project(x, y, z) gives
    // screen coordinates in the frame just drawn.
    tags(project) {
      const now = Date.now();
      for (const o of others.values()) {
        o.tag.hidden = !o.group.visible;
        if (o.tag.hidden) continue;
        const p = project(o.at[0], EYE + 0.9, o.at[1]);
        o.tag.hidden = p.behind;
        o.tag.classList.toggle('idle', now - o.seen > STALE_MS);
        o.tag.style.transform = `translate(${p.x}px, ${p.y}px) translate(-50%, -100%)`;
      }
    },

    // People walking, for the minimap: [{ x, z, yaw, color }].
    walkers() {
      return [...others.values()].filter((o) => o.at && o.mode === 'walk')
        .map((o) => ({ x: o.at[0], z: o.at[1], yaw: o.yaw, color: `#${o.color.getHexString()}` }));
    },

    // Hand data to the viewer's own Claude: call it straight from their click.
    // Staged, so it waits in their message box until they send their own words.
    ask(data) {
      if (!room || !canAsk) return Promise.reject(new Error('unavailable'));
      return room.sendToClaudeSession(data, { deliver: 'stage' });
    },
  };
}
