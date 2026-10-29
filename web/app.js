// The constellation: lays out graphify's graph with d3-force, keeps it drifting like a
// screensaver, replays the source one step per breath (a repository's commits, or a meeting's
// key points), and asks music.js for a note every time light reaches a node. Shares the page's
// global scope with themes.js (THEMES, themeColour, themeSwatch) and music.js (Music,
// INSTRUMENTS, INSTRUMENT, deriveMood, defaultOrchestra, clamp, hashString, ...), so top-level
// names here must not repeat those.

'use strict';

const $ = (sel) => document.querySelector(sel);
const TAU = Math.PI * 2;
const GOLDEN = 137.50776;
const REDUCED = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const RECENT_KEY = 'mindfulness.recent';
const SETTINGS_KEY = 'mindfulness.settings';
const RTF = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
const POINT_KINDS = {
  idea: 'Key idea', example: 'Example', decision: 'Decision', question: 'Open question',
  action: 'Action item', definition: 'Definition',
};

const music = new Music();
const sky = $('#sky');
const g2 = sky.getContext('2d');
const view = { w: 0, h: 0, dpr: 1 };
const dust = makeDust(110);
const settings = loadSettings();
const meetingInput = { source: null, docs: [] };  // source: { kind: 'file', file } | { kind: 'zoom', uuid, topic }
let health = null;
let world = null;
let backdropHue = 232;
let lastFrame = performance.now() / 1000;
let idleTimer = null;

// ---------------------------------------------------------------------------
// The constellation

class Constellation {
  constructor(scene, mood, theme) {
    this.scene = scene;
    this.kind = scene.kind === 'meeting' ? 'meeting' : 'repo';
    this.mood = mood;
    this.hueBase = hashString(sceneKey(scene)) % 360;
    this.applyPalette(theme);

    const maxDegree = scene.nodes.reduce((m, n) => Math.max(m, n.d), 1);
    this.nodes = scene.nodes.map((n, i) => ({
      ...n,
      i,
      l: n.l.length > 36 ? `${n.l.slice(0, 35)}…` : n.l,
      r: 1.6 + Math.min(7, Math.sqrt(n.d) * 0.9),
      weight: Math.log1p(n.d) / Math.log1p(maxDegree),
      twinkle: Math.random() * TAU,
      sx: 0, sy: 0, glow: 0,
    }));
    this.adj = this.nodes.map(() => []);
    for (const [s, t] of scene.links) {
      this.adj[s].push(t);
      this.adj[t].push(s);
    }
    let total = 0;
    this.cumulative = this.nodes.map((n) => (total += Math.sqrt(n.d + 1)));

    this.layoutAnchors();
    const sizes = scene.communities.map((c) => c.size);
    for (const n of this.nodes) {
      const a = this.anchors[n.c];
      const spread = 5 * Math.sqrt(sizes[n.c] || 1);
      n.x = a.x + gaussian() * spread;
      n.y = a.y + gaussian() * spread;
    }

    this.links = scene.links.map(([source, target]) => ({ source, target }));
    this.sim = d3.forceSimulation(this.nodes)
      .force('link', d3.forceLink(this.links).distance((l) => 10 + l.source.r + l.target.r))
      .force('charge', d3.forceManyBody().strength((n) => -8 - n.r * 3).distanceMax(240).theta(0.95))
      .force('home', () => this.pullHome())
      .velocityDecay(0.5)
      .alphaDecay(0.025)
      .alphaTarget(0.035)  // never fully settles, so it keeps gently moving
      .stop();
    const warmup = this.nodes.length > 1000 ? 90 : 160;
    for (let i = 0; i < warmup; i++) this.sim.tick();

    this.linksBy = this.palette.map(() => []);
    for (const l of this.links) this.linksBy[l.source.c].push(l);

    this.flashes = [];
    this.rings = [];
    this.pulses = [];
    this.labels = [];
    this.slots = new Set();
    this.commitIndex = 0;
    this.nextBeat = 0;
    this.sequence = this.kind === 'meeting' ? studySequence(scene) : [];
    this.cursor = -1;
    this.held = false;
    this.shownAt = -Infinity;
    this.cam = { x: 0, y: 0, scale: 1, zoom: 1, angle: 0, fit: null };
    this.frames = 0;
    // The first event is scheduled before the first frame, and it needs screen positions.
    this.updateCamera(music.now(), 0);
    this.project();
  }

  applyPalette(theme) {
    this.theme = theme;
    this.palette = paletteFor(this.scene, theme, this.hueBase);
    this.sprites = this.palette.map(glowSprite);
    this.hue = this.backdropFor(this.lastDegree || 0);
  }

  // Recolour in place, crossfading from the old colours.
  setTheme(theme, mood) {
    this.mood = mood;
    this.oldSprites = this.sprites;
    this.fadeFrom = music.now();
    this.applyPalette(theme);
  }

  backdropFor(degree) {
    if (this.theme.stops) return (this.theme.bg + (degree - 3) * 7 + 360) % 360;
    return (this.hueBase + 200 + degree * (360 / 7)) % 360;
  }

  // Each cluster orbits its own slowly wandering point.
  layoutAnchors() {
    const n = this.nodes.length;
    const k = Math.max(1, this.palette.length);
    const spacing = 9 * Math.sqrt(n / k) + 24;
    this.anchors = this.palette.map((_, i) => {
      const angle = (i * GOLDEN * Math.PI) / 180;
      const radius = spacing * Math.sqrt(i + 0.35);
      return {
        bx: Math.cos(angle) * radius,
        by: Math.sin(angle) * radius,
        amp: spacing * 0.35,
        w1: 0.025 + Math.random() * 0.03,
        w2: 0.025 + Math.random() * 0.03,
        p1: Math.random() * TAU,
        p2: Math.random() * TAU,
        x: 0,
        y: 0,
      };
    });
    this.moveAnchors(music.now());
  }

  moveAnchors(t) {
    const pace = REDUCED ? 0.4 : 1;
    for (const a of this.anchors) {
      a.x = a.bx + Math.sin(t * a.w1 * pace + a.p1) * a.amp;
      a.y = a.by + Math.cos(t * a.w2 * pace + a.p2) * a.amp;
    }
  }

  pullHome() {
    for (const n of this.nodes) {
      const a = this.anchors[n.c];
      n.vx += (a.x - n.x) * 0.01;
      n.vy += (a.y - n.y) * 0.01;
    }
  }

  frame(t, dt) {
    this.frames++;
    this.moveAnchors(t);
    if (this.nodes.length < 1200 || this.frames % 2 === 0) this.sim.tick();
    this.updateCamera(t, dt);
    this.project();
    this.ambient(t);
    this.updatePulses(t);
    this.updateGlow(t);
    this.draw(t);
  }

  updateCamera(t, dt) {
    const cam = this.cam;
    if (!cam.fit || this.frames % 12 === 0) {
      let cx = 0;
      let cy = 0;
      for (const n of this.nodes) {
        cx += n.x;
        cy += n.y;
      }
      cx /= this.nodes.length;
      cy /= this.nodes.length;
      const dist = this.nodes.map((n) => Math.hypot(n.x - cx, n.y - cy)).sort((a, b) => a - b);
      const r = Math.max(40, dist[Math.floor(dist.length * 0.94)] || 0);
      const first = !cam.fit;
      cam.fit = { x: cx, y: cy, scale: (Math.min(view.w, view.h) * 0.44) / r };
      if (first) Object.assign(cam, cam.fit);
    }
    const k = 1 - Math.exp(-dt * 0.6);
    cam.x += (cam.fit.x - cam.x) * k;
    cam.y += (cam.fit.y - cam.y) * k;
    cam.scale += (cam.fit.scale - cam.scale) * k;
    cam.angle = REDUCED ? 0 : (t * TAU) / 600;  // one slow turn every ten minutes
    cam.zoom = cam.scale * (1 + (REDUCED ? 0.012 : 0.045) * music.breath(t));
  }

  project() {
    const { x: cx, y: cy, angle, zoom } = this.cam;
    const cos = Math.cos(angle) * zoom;
    const sin = Math.sin(angle) * zoom;
    const ox = view.w / 2;
    const oy = view.h / 2;
    for (const n of this.nodes) {
      const dx = n.x - cx;
      const dy = n.y - cy;
      n.sx = ox + dx * cos - dy * sin;
      n.sy = oy + dx * sin + dy * cos;
    }
  }

  // ---- events ----

  onChord(index, t, chord) {
    this.lastDegree = chord.degree;
    this.hue = this.backdropFor(chord.degree);
    if (this.kind === 'meeting') {
      if (index % this.mood.eventEvery !== 0 || !this.sequence.length) return;
      // A point stepped to by hand gets its full time before the replay moves on.
      if (t - this.shownAt < this.eventPeriod() * 0.75) return;
      if (this.held) this.relight(t);
      else this.show(this.cursor + 1, t);
      return;
    }
    const commits = this.scene.commits;
    if (!commits.length) {
      this.playHubs(t);
      return;
    }
    const number = (this.commitIndex % commits.length) + 1;
    this.commitIndex++;
    this.playCommit(commits[number - 1], t, number);
  }

  eventPeriod() {
    return music.chordLen * this.mood.eventEvery;
  }

  // A commit lands: the code it touched lights up left to right as a little phrase,
  // then ripples outward to whatever that code is connected to.
  playCommit(commit, t, number) {
    const step = music.beat / 2;
    const quiet = !commit.n.length;  // eg docs-only changes graphify doesn't map
    const touched = quiet ? [this.randomNode(), this.randomNode()] : commit.n.map((i) => this.nodes[i]);
    const phrase = [...new Set(touched)].sort((a, b) => a.sx - b.sx).slice(0, 8);
    const intensity = Math.min(1, commit.f / 12);
    phrase.forEach((n, k) => {
      const at = t + music.beat * 0.5 + k * step;
      this.claimSlot(at);
      this.sound(n, at, quiet ? 0.3 : 0.5 + 0.3 * intensity);
      this.flash(n, at, quiet ? 0.6 : 1, 3);
      if (!quiet) {
        this.rings.push({ node: n, at });
        if (k < 4) this.labels.push({ node: n, at, until: at + 5.5 });
      }
      this.emit(n, at + step, quiet ? 1 : 2, true, 0);
    });
    this.later(t, () => showCommitCaption(commit, number, this.scene.commits.length));
  }

  // A key point of the meeting: the concepts it's about light up, softly, and stay named
  // for as long as the point is on screen.
  show(index, t) {
    const count = this.sequence.length;
    this.cursor = ((index % count) + count) % count;
    this.shownAt = t;
    const item = this.sequence[this.cursor];
    const step = music.beat / 2;
    const touched = item.n.map((i) => this.nodes[i]).filter(Boolean);
    const quiet = !touched.length;
    const phrase = (quiet ? [this.randomNode()] : [...new Set(touched)]).sort((a, b) => a.sx - b.sx).slice(0, 6);
    const until = t + this.eventPeriod() - 0.6;
    phrase.forEach((n, k) => {
      const at = t + music.beat * 0.5 + k * step;
      this.claimSlot(at);
      this.sound(n, at, quiet ? 0.25 : item.intro ? 0.5 : 0.42);
      this.flash(n, at, quiet ? 0.5 : 0.9, 4);
      if (!quiet) {
        this.rings.push({ node: n, at });
        this.labels.push({ node: n, at, until });
      }
      this.emit(n, at + step, 1, true, 0);
    });
    this.later(t, () => showStudyCaption(this, item));
  }

  // While a point is held, its concepts glow again with each breath.
  relight(t) {
    const item = this.sequence[this.cursor];
    if (!item) return;
    const until = t + this.eventPeriod() - 0.6;
    item.n.slice(0, 6).forEach((i, k) => {
      const n = this.nodes[i];
      if (!n) return;
      this.flash(n, t + k * 0.2, 0.55, 4);
      this.labels.push({ node: n, at: t, until });
    });
  }

  step(delta) {
    if (!this.sequence.length) return;
    this.show(this.cursor + delta, music.quantize(music.now() + 0.05, 0.5));
  }

  jumpTo(index) {
    if (index < 0 || index >= this.sequence.length) return;
    this.show(index, music.quantize(music.now() + 0.05, 0.5));
  }

  toggleHold() {
    this.held = !this.held;
    showStudyCaption(this, this.sequence[this.cursor], true);
  }

  later(t, fn) {
    setTimeout(() => {
      if (world === this) fn();
    }, Math.max(0, (t - music.now()) * 1000));
  }

  playHubs(t) {
    const step = music.beat;
    const hubs = this.nodes.slice(0, 3).sort((a, b) => a.sx - b.sx);
    hubs.forEach((n, k) => {
      const at = t + step * (0.5 + k);
      this.claimSlot(at);
      this.sound(n, at, 0.4);
      this.flash(n, at, 0.8, 3);
      this.emit(n, at + step / 2, 2, true, 0);
    });
  }

  // On some beats, a little light wanders from one idea to a neighbour.
  ambient(t) {
    if (t < this.nextBeat) return;
    const first = this.nextBeat === 0;
    this.nextBeat = music.quantize(t + 0.01, 1);
    if (first || Math.random() > this.mood.density) return;
    const n = this.randomNode();
    this.flash(n, t, 0.35, 1.6);
    this.emit(n, t, 1, Math.random() < 0.6, 0);
  }

  // Send light along `count` edges from a node. Arrivals land on the eighth-note grid,
  // so a sounding pulse rings exactly as it reaches its node.
  emit(from, at, count, sounding, hops) {
    const neighbours = this.adj[from.i];
    if (!neighbours.length || this.pulses.length > 90) return;
    for (let k = 0; k < count; k++) {
      const to = this.nodes[neighbours[(Math.random() * neighbours.length) | 0]];
      const end = music.quantize(at + music.beat * (1.25 + Math.random() * 1.5), 0.5);
      const pulse = { from, to, start: at, end, hops, sounding: false, arrived: false };
      if (sounding && this.claimSlot(end)) {
        pulse.sounding = true;
        this.sound(to, end, 0.22 + 0.2 * Math.random());
        this.flash(to, end, 0.7, 2.2);
      } else {
        this.flash(to, end, 0.3, 1.4);
      }
      this.pulses.push(pulse);
    }
  }

  updatePulses(t) {
    this.pulses = this.pulses.filter((p) => {
      if (!p.arrived && t >= p.end) {
        p.arrived = true;
        if (p.hops < 2 && Math.random() < 0.3) this.emit(p.to, p.end, 1, Math.random() < 0.45, p.hops + 1);
      }
      return t < p.end + 0.6;
    });
  }

  // At most one wandering note per eighth note keeps it spacious.
  claimSlot(t) {
    const eighth = music.beat / 2;
    const key = Math.round((t - music.start) / eighth);
    if (this.slots.has(key)) return false;
    this.slots.add(key);
    if (this.slots.size > 256) {
      const past = Math.round((music.now() - music.start) / eighth);
      for (const s of this.slots) if (s < past) this.slots.delete(s);
    }
    return true;
  }

  // What the node looks like right now decides what it sounds like, and its cluster decides who plays it.
  sound(node, at, velocity) {
    const voice = music.voiceFor(node.c);
    if (!voice) return;
    const height = 1 - clamp(node.sy / view.h, 0, 1);
    const pan = clamp((node.sx / view.w) * 2 - 1, -1, 1) * 0.75;
    const midi = music.pitch(this.palette[node.c].tone, height, node.weight, at);
    music.note(voice, midi, at, velocity, pan);
  }

  flash(node, at, strength, duration) {
    this.flashes.push({ node, at, strength, duration });
  }

  updateGlow(t) {
    for (const n of this.nodes) n.glow = 0;
    this.flashes = this.flashes.filter((f) => {
      const age = t - f.at;
      if (age > f.duration) return false;
      if (age >= 0) {
        const env = age < 0.08 ? age / 0.08 : Math.exp((-(age - 0.08) * 3.2) / f.duration);
        f.node.glow = Math.max(f.node.glow, f.strength * env);
      }
      return true;
    });
  }

  randomNode() {
    const total = this.cumulative[this.cumulative.length - 1];
    const x = Math.random() * total;
    let lo = 0;
    let hi = this.cumulative.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this.cumulative[mid] < x) lo = mid + 1;
      else hi = mid;
    }
    return this.nodes[lo];
  }

  // ---- drawing ----

  draw(t) {
    g2.globalCompositeOperation = 'lighter';

    g2.lineWidth = 0.7;
    this.linksBy.forEach((list, c) => {
      if (!list.length) return;
      g2.strokeStyle = this.palette[c].edge;
      g2.beginPath();
      for (const l of list) {
        g2.moveTo(l.source.sx, l.source.sy);
        g2.lineTo(l.target.sx, l.target.sy);
      }
      g2.stroke();
    });

    for (const p of this.pulses) {
      if (t < p.start) continue;
      const u = clamp((t - p.start) / (p.end - p.start), 0, 1);
      const e = u * u * (3 - 2 * u);
      const fade = t > p.end ? 1 - (t - p.end) / 0.6 : 1;
      const sprite = this.sprites[p.from.c];
      for (let k = 0; k < 4; k++) {  // a short comet tail
        const v = Math.max(0, e - k * 0.035);
        const x = p.from.sx + (p.to.sx - p.from.sx) * v;
        const y = p.from.sy + (p.to.sy - p.from.sy) * v;
        const size = (p.sounding ? 9 : 6) * (1 - k * 0.2);
        g2.globalAlpha = fade * (1 - k * 0.24) * (p.sounding ? 0.95 : 0.55);
        g2.drawImage(sprite, x - size, y - size, size * 2, size * 2);
      }
    }

    // While a theme changes, each star is drawn in both its old and new colour.
    const mix = this.oldSprites ? clamp((t - this.fadeFrom) / 2.5, 0, 1) : 1;
    if (mix >= 1) this.oldSprites = null;
    const zoom = this.cam.zoom;
    for (const n of this.nodes) {
      const core = Math.max(1.1, n.r * zoom * 0.9);
      const size = core * (4 + n.glow * 7);
      const alpha = Math.min(1, 0.5 + 0.12 * Math.sin(t * 0.9 + n.twinkle) + n.glow * 0.6);
      if (this.oldSprites) {
        g2.globalAlpha = alpha * (1 - mix);
        g2.drawImage(this.oldSprites[n.c], n.sx - size, n.sy - size, size * 2, size * 2);
      }
      g2.globalAlpha = alpha * mix;
      g2.drawImage(this.sprites[n.c], n.sx - size, n.sy - size, size * 2, size * 2);
    }

    g2.lineWidth = 1.2;
    this.rings = this.rings.filter((ring) => {
      const age = t - ring.at;
      if (age > 3) return false;
      if (age < 0) return true;
      const u = age / 3;
      g2.globalAlpha = (1 - u) * 0.5;
      g2.strokeStyle = this.palette[ring.node.c].ring;
      g2.beginPath();
      g2.arc(ring.node.sx, ring.node.sy, 6 + u * 70, 0, TAU);
      g2.stroke();
      return true;
    });

    g2.globalCompositeOperation = 'source-over';
    g2.font = this.kind === 'meeting' ? '500 13px Inter, system-ui, sans-serif' : '500 12px Inter, system-ui, sans-serif';
    g2.textAlign = 'left';
    g2.textBaseline = 'middle';
    const placed = [];
    this.labels = this.labels.filter((label) => {
      if (t > label.until) return false;
      if (t < label.at) return true;
      const x = label.node.sx + 10;
      const y = label.node.sy - 10;
      if (placed.some((p) => Math.abs(p.x - x) < 110 && Math.abs(p.y - y) < 16)) return true;
      placed.push({ x, y });
      g2.globalAlpha = 0.85 * Math.min(1, (t - label.at) / 0.6, (label.until - t) / 1.5);
      g2.fillStyle = this.palette[label.node.c].label;
      g2.fillText(label.node.l, x, y);
      return true;
    });
    if (this.kind === 'meeting') this.drawTopics(placed);
    g2.globalAlpha = 1;
  }

  // A meeting's clusters are its topics: name each one faintly over its stars, stepping
  // aside for the names of whatever the current point is about.
  drawTopics(busy) {
    const sums = this.palette.map(() => ({ x: 0, y: 0, n: 0 }));
    for (const n of this.nodes) {
      const s = sums[n.c];
      s.x += n.sx;
      s.y += n.sy;
      s.n++;
    }
    g2.font = 'italic 400 17px "Cormorant Garamond", Georgia, serif';
    g2.textAlign = 'center';
    g2.textBaseline = 'middle';
    const placed = [];
    this.scene.communities.slice(0, 12).forEach((community, c) => {
      const s = sums[c];
      if (!s || s.n < 4 || !community.name || community.name === 'Smaller clusters') return;
      const x = s.x / s.n;
      const y = s.y / s.n;
      if (placed.some((p) => Math.abs(p.x - x) < 150 && Math.abs(p.y - y) < 26)) return;
      if (busy.some((p) => x > p.x - 90 && x < p.x + 220 && Math.abs(p.y - y) < 24)) return;
      placed.push({ x, y });
      g2.globalAlpha = 0.42;
      g2.fillStyle = this.palette[c].label;
      g2.fillText(community.name.length > 30 ? `${community.name.slice(0, 29)}…` : community.name, x, y);
    });
    g2.globalAlpha = 1;
  }
}

// A meeting's replay: each chapter opens with its own card, then its key points in order.
function studySequence(scene) {
  const sequence = [];
  let chapter = -1;
  scene.moments.forEach((m, index) => {
    if (m.chapter !== chapter && scene.chapters[m.chapter]) {
      chapter = m.chapter;
      const inside = scene.moments.filter((x) => x.chapter === chapter);
      sequence.push({ intro: true, chapter, t: scene.chapters[chapter].t, n: [...new Set(inside.flatMap((x) => x.n))].slice(0, 6) });
    }
    sequence.push({ ...m, point: index + 1 });
  });
  return sequence;
}

// ---------------------------------------------------------------------------
// Drawing helpers

// One colour per cluster. `tone` (0–1) is the colour's place in the palette, which is also
// the note it plays, so similar colours sound alike.
function paletteFor(scene, theme, hueBase) {
  return scene.communities.map((_, i) => {
    if (!theme.stops) {
      const h = (hueBase + i * GOLDEN) % 360;
      return colour(h, 80, 64, h / 360);
    }
    const tone = ((hueBase / 360) + i * 0.381966) % 1;
    const { h, s, l } = themeColour(theme.stops, tone);
    return colour(h, s, l, tone);
  });
}

function colour(h, s, l, tone) {
  const light = (dl) => Math.min(95, l + dl);
  return {
    h, s, l, tone,
    edge: `hsla(${h}, ${s - 15}%, ${light(2)}%, 0.10)`,
    ring: `hsl(${h}, ${s}%, ${light(14)}%)`,
    label: `hsl(${h}, ${s - 10}%, ${light(22)}%)`,
    css: `hsl(${h}, ${s}%, ${l}%)`,
  };
}

function glowSprite(c) {
  const size = 64;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const g = canvas.getContext('2d');
  const grad = g.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  grad.addColorStop(0, `hsla(${c.h}, ${Math.min(100, c.s + 10)}%, ${Math.min(95, c.l + 28)}%, 1)`);
  grad.addColorStop(0.14, `hsla(${c.h}, ${Math.min(100, c.s + 5)}%, ${Math.min(95, c.l + 10)}%, 0.9)`);
  grad.addColorStop(0.32, `hsla(${c.h}, ${c.s}%, ${c.l - 2}%, 0.28)`);
  grad.addColorStop(1, `hsla(${c.h}, ${c.s}%, ${c.l - 9}%, 0)`);
  g.fillStyle = grad;
  g.fillRect(0, 0, size, size);
  return canvas;
}

function makeDust(count) {
  return Array.from({ length: count }, () => ({
    x: Math.random(),
    y: Math.random(),
    z: 0.3 + Math.random() * 0.7,  // nearer dust is brighter and drifts faster
    phase: Math.random() * TAU,
  }));
}

function drawBackdrop(t, dt, hue) {
  const { w, h } = view;
  const grad = g2.createRadialGradient(w * 0.5, h * 0.42, 0, w * 0.5, h * 0.5, Math.hypot(w, h) * 0.65);
  grad.addColorStop(0, `hsl(${hue}, 42%, 10%)`);
  grad.addColorStop(1, `hsl(${(hue + 28) % 360}, 50%, 3%)`);
  g2.globalCompositeOperation = 'source-over';
  g2.globalAlpha = 1;
  g2.fillStyle = grad;
  g2.fillRect(0, 0, w, h);

  const pace = REDUCED ? 0.3 : 1;
  g2.fillStyle = '#fff';
  for (const p of dust) {
    p.y -= dt * 0.004 * p.z * pace;
    p.x += dt * 0.0015 * p.z * pace;
    if (p.y < -0.01) p.y += 1.02;
    if (p.x > 1.01) p.x -= 1.02;
    g2.globalAlpha = (0.08 + 0.22 * p.z) * (0.6 + 0.4 * Math.sin(t * 0.7 + p.phase));
    const s = 0.6 + p.z * 1.1;
    g2.fillRect(p.x * w, p.y * h, s, s);
  }
  g2.globalAlpha = 1;
}

function resize() {
  view.dpr = Math.min(window.devicePixelRatio || 1, 2);
  view.w = window.innerWidth;
  view.h = window.innerHeight;
  sky.width = Math.round(view.w * view.dpr);
  sky.height = Math.round(view.h * view.dpr);
  g2.setTransform(view.dpr, 0, 0, view.dpr, 0, 0);
  if (world) world.cam.fit = null;
}

function frame(ms) {
  const t = ms / 1000;  // same clock as performance.now(), which music.js schedules against
  const dt = Math.min(0.1, Math.max(0, t - lastFrame));
  lastFrame = t;
  backdropHue = approachHue(backdropHue, world ? world.hue : 232, dt * 0.25);
  drawBackdrop(t, dt, backdropHue);
  if (world) world.frame(t, dt);
  requestAnimationFrame(frame);
}

function approachHue(from, to, k) {
  const diff = ((to - from + 540) % 360) - 180;
  return (from + diff * Math.min(1, k) + 360) % 360;
}

function gaussian() {
  return Math.sqrt(-2 * Math.log(1 - Math.random())) * Math.cos(TAU * Math.random());
}

function sceneKey(scene) {
  return scene.kind === 'meeting' ? scene.meeting.id : `${scene.repo.owner}/${scene.repo.name}`;
}

function sceneTitle(scene) {
  return scene.kind === 'meeting' ? scene.meeting.title : `${scene.repo.owner}/${scene.repo.name}`;
}

function clock(seconds) {
  const s = Math.max(0, Math.floor(seconds));
  const mm = String(Math.floor((s % 3600) / 60)).padStart(2, '0');
  const ss = String(s % 60).padStart(2, '0');
  return s >= 3600 ? `${Math.floor(s / 3600)}:${mm}:${ss}` : `${mm}:${ss}`;
}

// ---------------------------------------------------------------------------
// Settings: the chosen theme and each kind's orchestra, remembered in this browser

function loadSettings() {
  try {
    const saved = JSON.parse(localStorage.getItem(SETTINGS_KEY)) || {};
    const orchestras = saved.orchestras && typeof saved.orchestras === 'object' ? saved.orchestras : {};
    if (saved.orchestra && !orchestras.repo) orchestras.repo = saved.orchestra;  // saved before meetings existed
    return { theme: THEMES[saved.theme] ? saved.theme : 'work', orchestras };
  } catch {
    return { theme: 'work', orchestras: {} };
  }
}

function saveSettings() {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify({ theme: settings.theme, orchestras: settings.orchestras }));
  } catch {
    // storage can be unavailable (private windows); the choices still apply for this visit
  }
}

// The orchestra to play: the person's own choices for this kind of source, else what the source suggests.
function orchestraFor(mood, kind) {
  const suggested = defaultOrchestra(mood);
  const mine = settings.orchestras[kind];
  if (!mine) return suggested;
  return Object.fromEntries(INSTRUMENTS.map((i) => [i.id, { ...suggested[i.id], ...mine[i.id] }]));
}

// ---------------------------------------------------------------------------
// The orchestra panel

function buildOrchestraPanel() {
  const themes = $('#themes');
  for (const [id, theme] of Object.entries(THEMES)) {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'theme-chip';
    chip.dataset.theme = id;
    const swatch = document.createElement('span');
    swatch.className = 'swatch';
    swatch.style.background = themeSwatch(theme);
    const name = document.createElement('span');
    name.textContent = theme.name;
    chip.append(swatch, name);
    chip.addEventListener('click', () => applyTheme(id));
    themes.append(chip);
  }

  for (const inst of INSTRUMENTS) {
    const row = document.createElement('div');
    row.className = 'inst';
    row.dataset.inst = inst.id;

    const toggle = document.createElement('label');
    toggle.className = 'inst-toggle';
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.className = 'switch';
    box.addEventListener('change', () => changeInstrument(inst.id, { on: box.checked }));
    const name = document.createElement('span');
    name.className = 'inst-name';
    name.textContent = inst.name;
    toggle.append(box, name);

    const level = document.createElement('input');
    level.type = 'range';
    level.min = '0';
    level.max = '1';
    level.step = '0.01';
    level.setAttribute('aria-label', `${inst.name} volume`);
    level.addEventListener('input', () => changeInstrument(inst.id, { level: Number(level.value), on: true }));

    const sub = document.createElement('p');
    sub.className = 'inst-sub';

    row.append(toggle, level, sub);
    $(inst.role === 'solo' ? '#soloists' : '#ensemble').append(row);
  }

  $('#reset-orchestra').addEventListener('click', () => {
    if (!world) return;
    settings.orchestras[world.kind] = null;
    saveSettings();
    music.setOrchestra(orchestraFor(world.mood, world.kind));
    syncOrchestraPanel();
  });
}

function changeInstrument(id, patch) {
  music.setInstrument(id, { ...music.orchestra[id], ...patch });
  if (world) {
    settings.orchestras[world.kind] = structuredClone(music.orchestra);
    saveSettings();
  }
  syncOrchestraPanel();
}

function applyTheme(id) {
  if (settings.theme === id && world) return;
  settings.theme = id;
  saveSettings();
  if (world) {
    const theme = THEMES[id];
    const mood = deriveMood(world.scene, theme);
    world.setTheme(theme, mood);
    music.configure(mood, orchestraFor(mood, world.kind));
    showMood(mood);
  }
  syncOrchestraPanel();
}

// Reflect the current theme and orchestra, including which clusters each soloist voices.
function syncOrchestraPanel() {
  for (const chip of document.querySelectorAll('.theme-chip')) {
    chip.setAttribute('aria-pressed', String(chip.dataset.theme === settings.theme));
    if (chip.dataset.theme === 'work') {
      chip.lastChild.textContent = world && world.kind === 'meeting' ? 'From the meeting' : THEMES.work.name;
    }
  }
  $('#reset-orchestra').textContent = world && world.kind === 'meeting'
    ? 'Back to the study suggestion' : 'Back to what your work suggests';
  const clusters = {};
  if (world) {
    world.palette.forEach((c, i) => {
      const voice = music.voiceFor(i);
      if (voice) (clusters[voice] ||= []).push(c);
    });
  }
  const noun = world && world.kind === 'meeting' ? 'topic' : 'cluster';
  for (const inst of INSTRUMENTS) {
    const row = document.querySelector(`.inst[data-inst="${inst.id}"]`);
    const state = music.orchestra[inst.id] || { on: false, level: inst.level };
    row.classList.toggle('off', !state.on);
    row.querySelector('.switch').checked = state.on;
    const level = row.querySelector('input[type=range]');
    if (document.activeElement !== level) level.value = String(state.level);

    const sub = row.querySelector('.inst-sub');
    if (inst.role !== 'solo') {
      sub.textContent = inst.about;
      continue;
    }
    const mine = clusters[inst.id] || [];
    const dots = mine.slice(0, 6).map((c) => {
      const dot = document.createElement('span');
      dot.className = 'dot';
      dot.style.background = c.css;
      return dot;
    });
    const words = [];
    if (!state.on) words.push('resting');
    else if (mine.length) words.push(`${mine.length} ${noun}${mine.length === 1 ? '' : 's'}`);
    if (world && inst.id === world.mood.lead && world.mood.topExt) words.push(`suits your .${world.mood.topExt} files`);
    if (world && inst.id === world.mood.lead && world.mood.study) words.push('leads, for study');
    if (inst.id === 'harp' && state.on) words.push('also rolls each chord');
    sub.replaceChildren(...dots, words.join(' · '));
  }
  renderAbout();
}

function renderAbout() {
  if (!world) return;
  const { scene, mood } = world;
  const name = (id) => INSTRUMENT[id].name.toLowerCase();
  const noun = world.kind === 'meeting' ? 'topic' : 'cluster';
  const reasons = [...mood.reasons];
  const ensemble = INSTRUMENTS.filter((i) => i.role === 'ensemble' && music.orchestra[i.id]?.on).map((i) => i.name);
  if (ensemble.length) reasons.push(`${listOf(ensemble)} hold the harmony.`);
  const solo = music.soloists();
  if (solo.length) {
    reasons.push(`Each ${noun} has its own soloist: the biggest plays ${name(solo[0])}`
      + `${solo.length > 1 ? `, the next ${name(solo[1])}` : ''}${solo.length > 2 ? ', and so on' : ''}. `
      + (mood.topExt && solo[0] === mood.lead ? `${INSTRUMENT[mood.lead].name} leads because most of the code is .${mood.topExt}.` : ''));
  } else {
    reasons.push('No soloists are playing, so only the ensemble sounds. Switch some on under Orchestra.');
  }
  if (scene.trimmed) {
    reasons.push(`Showing the ${scene.nodes.length.toLocaleString()} most connected of ${scene.stats.nodes_total.toLocaleString()} ideas, to keep things calm.`);
  }
  if (world.kind === 'repo' && scene.commits.length) {
    reasons.push(`Replaying the last ${scene.commits.length} commits, one per breath, then starting again.`);
  }
  $('#reasons').replaceChildren(...reasons.map((r) => Object.assign(document.createElement('li'), { textContent: r.trim() })));
}

// "Strings, cellos & basses and drone": names after the first are lowercased unless asked not to.
function listOf(items, lower = true) {
  const words = items.map((s, i) => (i && lower ? s.toLowerCase() : s));
  return words.length < 2 ? words.join('') : `${words.slice(0, -1).join(', ')} and ${words[words.length - 1]}`;
}

// ---------------------------------------------------------------------------
// Captions and study notes

function showCommitCaption(commit, number, total) {
  setCaption('', commit.m || '(no message)', [
    commit.a,
    relativeTime(commit.t),
    `${commit.f} file${commit.f === 1 ? '' : 's'}`,
    `${number} of ${total}`,
  ]);
}

function showStudyCaption(w, item, instant = false) {
  if (!item) return;
  const { chapters, moments } = w.scene;
  const chapter = chapters[item.chapter];
  const held = w.held ? 'held · space to continue' : null;
  if (item.intro) {
    setCaption(
      `Chapter ${item.chapter + 1} of ${chapters.length} · ${clock(chapter.t)}`,
      chapter.title,
      [chapter.takeaway, held],
      { intro: true, instant },
    );
  } else {
    setCaption(
      chapters.length > 1 && chapter ? `${chapter.title}` : '',
      item.text,
      [clock(item.t), POINT_KINDS[item.kind] || 'Key idea', item.speaker, item.slide ? `slide ${item.slide}` : null,
        `${item.point} of ${moments.length}`, held],
      { instant },
    );
  }
  for (const li of document.querySelectorAll('#notes-chapters li')) {
    li.toggleAttribute('aria-current', Number(li.dataset.chapter) === item.chapter);
  }
}

function setCaption(chapterLine, message, meta, { intro = false, instant = false } = {}) {
  const caption = $('#caption');
  const fill = () => {
    $('#caption-chapter').textContent = chapterLine;
    $('#caption-msg').textContent = message;
    $('#caption-meta').textContent = meta.filter(Boolean).join('  ·  ');
    caption.classList.toggle('intro', intro);
    caption.classList.remove('fading');
  };
  if (instant) {
    fill();
    return;
  }
  caption.classList.add('fading');
  setTimeout(fill, 700);
}

function renderNotes(scene) {
  const { notes, chapters, moments, meeting, stats } = scene;
  $('#notes-meta').textContent = [meeting.date ? new Date(meeting.date).toLocaleDateString() : null,
    clock(stats.duration), stats.speakers.length ? `${stats.speakers.length} speakers` : null].filter(Boolean).join(' · ');
  $('#notes-summary').textContent = notes.summary || '';
  $('#notes-summary').hidden = !notes.summary;

  $('#notes-chapters').replaceChildren(...chapters.map((c, k) => {
    const li = document.createElement('li');
    li.dataset.chapter = String(k);
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'jump';
    const time = Object.assign(document.createElement('span'), { className: 'time', textContent: clock(c.t) });
    const title = Object.assign(document.createElement('span'), { className: 'title', textContent: c.title });
    button.append(time, title);
    button.addEventListener('click', () => world && world.jumpTo(world.sequence.findIndex((s) => s.intro && s.chapter === k)));
    li.append(button);
    if (c.takeaway) li.append(Object.assign(document.createElement('p'), { textContent: c.takeaway }));
    return li;
  }));

  const list = (selector, items, render) => {
    const box = $(selector);
    box.replaceChildren(...items.map(render));
    box.closest('section').hidden = !items.length;
  };
  list('#notes-terms', notes.terms, (t) => {
    const li = document.createElement('li');
    li.append(Object.assign(document.createElement('strong'), { textContent: t.term }), t.meaning ? ` — ${t.meaning}` : '');
    return li;
  });
  list('#notes-decisions', notes.decisions, (d) => Object.assign(document.createElement('li'), { textContent: d }));
  list('#notes-actions', notes.actions, (a) => Object.assign(document.createElement('li'), { textContent: a.owner ? `${a.task} (${a.owner})` : a.task }));
  list('#notes-questions', notes.questions, (q) => Object.assign(document.createElement('li'), { textContent: q }));
  list('#notes-points', moments, (m, i) => {
    const li = document.createElement('li');
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'jump';
    button.append(Object.assign(document.createElement('span'), { className: 'time', textContent: clock(m.t) }),
      Object.assign(document.createElement('span'), { className: 'title', textContent: m.text }));
    button.addEventListener('click', () => world && world.jumpTo(world.sequence.findIndex((s) => s.point === i + 1)));
    li.append(button);
    return li;
  });
  $('#notes-source').textContent = notes.ai
    ? 'Written by AI from the transcript and slides. Check anything important against the recording.'
    : 'These are simple notes taken from the transcript, because the AI step didn’t finish.';
}

function notesMarkdown(scene) {
  const { notes, chapters, moments, meeting, stats } = scene;
  const lines = [`# ${meeting.title}`, ''];
  const facts = [meeting.date ? new Date(meeting.date).toLocaleDateString() : null, clock(stats.duration),
    stats.speakers.length ? `Speakers: ${stats.speakers.join(', ')}` : null].filter(Boolean);
  if (facts.length) lines.push(facts.join(' · '), '');
  if (notes.summary) lines.push('## Summary', '', notes.summary, '');
  lines.push('## Chapters', '');
  chapters.forEach((c, k) => {
    lines.push(`### ${k + 1}. ${c.title} (${clock(c.t)})`, '');
    if (c.takeaway) lines.push(c.takeaway, '');
    for (const m of moments.filter((x) => x.chapter === k)) {
      const tags = [POINT_KINDS[m.kind], m.speaker, m.slide ? `slide ${m.slide}` : null].filter(Boolean).join(', ');
      lines.push(`- [${clock(m.t)}] ${m.text}${tags ? ` _(${tags})_` : ''}`);
    }
    lines.push('');
  });
  if (notes.terms.length) lines.push('## Key terms', '', ...notes.terms.map((t) => `- **${t.term}**${t.meaning ? `: ${t.meaning}` : ''}`), '');
  if (notes.decisions.length) lines.push('## Decisions', '', ...notes.decisions.map((d) => `- ${d}`), '');
  if (notes.actions.length) lines.push('## Action items', '', ...notes.actions.map((a) => `- [ ] ${a.task}${a.owner ? ` (${a.owner})` : ''}`), '');
  if (notes.questions.length) lines.push('## Open questions', '', ...notes.questions.map((q) => `- ${q}`), '');
  lines.push('---', notes.ai ? '_Study notes written by AI from the transcript and slides._' : '_Simple notes taken from the transcript._');
  return lines.join('\n');
}

function downloadNotes() {
  if (!world || world.kind !== 'meeting') return;
  const blob = new Blob([notesMarkdown(world.scene)], { type: 'text/markdown' });
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = `${world.scene.meeting.title.replace(/[^\w -]+/g, '').trim() || 'meeting'} - study notes.md`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(link.href), 1000);
}

// ---------------------------------------------------------------------------
// Screens

function showScreen(name) {
  $('#intro').hidden = name !== 'intro';
  $('#progress').hidden = name !== 'progress';
  $('#hud').hidden = name !== 'hud';
  document.body.classList.remove('idle');
}

function showError(message) {
  const box = $('#error');
  box.textContent = message;
  box.hidden = !message;
}

async function postJSON(url, body) {
  const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'The server turned that request down.');
  return data;
}

async function waitForJob(id) {
  for (;;) {
    await sleep(700);
    const poll = await fetch(`/api/job/${id}`);
    if (!poll.ok) throw new Error('Lost track of the work. Is server.py still running?');
    const job = await poll.json();
    $('#step').textContent = job.step;
    $('#log').textContent = job.log.join('\n');
    if (job.state === 'done') return job.result;
    if (job.state === 'error') throw new Error(job.error);
  }
}

// Stream one file to the server, showing progress.
function upload(file, label) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', '/api/upload');
    xhr.setRequestHeader('Content-Type', 'application/octet-stream');
    xhr.setRequestHeader('X-File-Name', encodeURIComponent(file.name));
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) $('#step').textContent = `${label} · ${Math.round((e.loaded / e.total) * 100)}%`;
    };
    xhr.onload = () => {
      let body = {};
      try {
        body = JSON.parse(xhr.responseText);
      } catch {
        // fall through to the error below
      }
      if (xhr.status === 200 && body.id) resolve(body);
      else reject(new Error(body.error || `Couldn't upload ${file.name}.`));
    };
    xhr.onerror = () => reject(new Error(`Couldn't upload ${file.name}. Is server.py still running?`));
    $('#step').textContent = label;
    $('#log').textContent = '';
    xhr.send(file);
  });
}

async function begin(scene) {
  if (typeof d3 === 'undefined') throw new Error("Couldn't load d3, which draws the graph. Check your internet connection.");
  $('#step').textContent = 'Arranging the stars';
  $('#log').textContent = '';
  await sleep(50);  // let that message paint before the layout warms up

  const theme = THEMES[settings.theme];
  const mood = deriveMood(scene, theme);
  world = new Constellation(scene, mood, theme);
  music.onChord = (i, t, chord) => world && world.onChord(i, t, chord);
  music.configure(mood, orchestraFor(mood, world.kind));

  const meeting = world.kind === 'meeting';
  const name = $('#repo-name');
  name.textContent = sceneTitle(scene);
  if (meeting) name.removeAttribute('href');
  else name.href = scene.repo.url;
  document.body.classList.toggle('study', meeting);
  $('#notes-toggle').hidden = !meeting;
  for (const el of document.querySelectorAll('.study-only')) el.hidden = !meeting;
  if (meeting) renderNotes(scene);
  showMood(mood);
  $('#caption').classList.add('fading');
  showScreen('hud');
  wake();
}

function showMood(mood) {
  $('#mood').textContent = mood.label;
  syncOrchestraPanel();
}

function leave() {
  music.stop();
  music.onChord = null;
  world = null;
  closePanels();
  document.body.classList.remove('study');
  showScreen('intro');
}

function relativeTime(iso) {
  const then = Date.parse(iso);
  if (!then) return '';
  const secs = (then - Date.now()) / 1000;
  const units = [['year', 31536000], ['month', 2592000], ['week', 604800], ['day', 86400], ['hour', 3600], ['minute', 60]];
  for (const [unit, size] of units) {
    if (Math.abs(secs) >= size) return RTF.format(Math.round(secs / size), unit);
  }
  return 'just now';
}

// ---------------------------------------------------------------------------
// The start screen: a repository, or a meeting

function selectTab(which) {
  for (const tab of ['repo', 'meeting']) {
    $(`#tab-${tab}`).setAttribute('aria-selected', String(tab === which));
    $(`#${tab}-pane`).hidden = tab !== which;
  }
  showError('');
  renderNotice();
}

function activeTab() {
  return $('#tab-meeting').getAttribute('aria-selected') === 'true' ? 'meeting' : 'repo';
}

async function checkHealth(refresh = false) {
  try {
    health = await (await fetch(`/api/health${refresh ? '?refresh=1' : ''}`)).json();
  } catch {
    health = { offline: true };
  }
  renderNotice();
  renderZoom();
}

function renderNotice() {
  const notice = $('#notice');
  const code = (text) => Object.assign(document.createElement('code'), { textContent: text });
  const lines = [];
  if (!health) {
    notice.hidden = true;
    return;
  }
  if (health.offline) {
    lines.push(["Can't reach the Mindfulness server. Start it with ", code('python server.py'), '.']);
  } else if (!health.graphify) {
    lines.push(["graphify isn't installed yet. In a terminal, run ", code(health.install), ', then restart this app.']);
  } else if (activeTab() === 'repo') {
    if (!health.git) lines.push(["git isn't installed (or isn't on PATH). It's needed to fetch repositories."]);
  } else {
    const m = health.meeting || {};
    if (!m.backend) {
      lines.push(['Meetings need an AI model so graphify can understand the conversation. Install Claude Code and sign in once '
        + '(graphify uses your subscription), or set ', code('ANTHROPIC_API_KEY'), ', then restart this app.']);
    }
    const missing = [!m.transcribe && 'transcribing recordings', !m.pdf && 'reading PDFs', !m.docx && 'reading Word files'].filter(Boolean);
    if (missing.length) {
      lines.push([`For ${listOf(missing, false)}, add graphify's extras (in the Python graphify uses): `, code(m.extras || ''),
        m.transcribe ? '' : ' A Zoom recording with its own transcript works without transcription.']);
    }
  }
  notice.replaceChildren(...lines.map((parts) => {
    const p = document.createElement('p');
    p.append(...parts);
    return p;
  }));
  notice.hidden = !lines.length;

  const ready = health.meeting;
  const status = $('#meeting-status');
  if (ready && !health.offline) {
    const item = (ok, text) => Object.assign(document.createElement('span'), { className: ok ? 'ok' : 'missing', textContent: text });
    status.replaceChildren(
      item(ready.backend, ready.backend ? `AI: ${ready.backend === 'claude-cli' ? 'Claude Code' : ready.backend}` : 'No AI model'),
      item(ready.transcribe, 'Transcription'),
      item(ready.pdf, 'PDF'),
      item(ready.docx, 'Word'),
    );
    status.hidden = false;
  }
}

function setMeetingSource(source) {
  meetingInput.source = source;
  const fileHint = $('#media-hint');
  $('#media-drop').classList.toggle('chosen', source?.kind === 'file');
  $('#zoom-pick').classList.toggle('chosen', source?.kind === 'zoom');
  fileHint.textContent = source?.kind === 'file'
    ? `${source.file.name} · ${formatSize(source.file.size)}` : 'Drop a video or audio file, or click to choose';
  $('#zoom-hint').textContent = source?.kind === 'zoom' ? source.topic : 'Choose a cloud recording';
  if (source?.kind === 'zoom' && !$('#meeting-title').value) $('#meeting-title').placeholder = source.topic;
}

function addDocs(files) {
  for (const file of files) {
    if (!meetingInput.docs.some((d) => d.name === file.name && d.size === file.size)) meetingInput.docs.push(file);
  }
  renderDocs();
}

function renderDocs() {
  $('#doc-list').replaceChildren(...meetingInput.docs.map((file, i) => {
    const li = document.createElement('li');
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'remove';
    remove.setAttribute('aria-label', `Remove ${file.name}`);
    remove.textContent = '×';
    remove.addEventListener('click', () => {
      meetingInput.docs.splice(i, 1);
      renderDocs();
    });
    li.append(`${file.name} · ${formatSize(file.size)}`, remove);
    return li;
  }));
}

function formatSize(bytes) {
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(1)} GB`;
  if (bytes >= 1e6) return `${Math.round(bytes / 1e6)} MB`;
  return `${Math.max(1, Math.round(bytes / 1e3))} KB`;
}

function dropTarget(label, onFiles) {
  label.addEventListener('dragover', (e) => {
    e.preventDefault();
    label.classList.add('over');
  });
  label.addEventListener('dragleave', () => label.classList.remove('over'));
  label.addEventListener('drop', (e) => {
    e.preventDefault();
    label.classList.remove('over');
    if (e.dataTransfer.files.length) onFiles([...e.dataTransfer.files]);
  });
}

// ---- Zoom ----

function renderZoom() {
  const zoomStatus = health && health.meeting && health.meeting.zoom;
  $('#zoom-setup').hidden = Boolean(zoomStatus && zoomStatus.configured);
  $('#zoom-connected').hidden = !(zoomStatus && zoomStatus.configured);
  if (zoomStatus) {
    $('#zoom-user').textContent = zoomStatus.user || '';
    $('#zoom-scope').textContent = zoomStatus.scope;
  }
}

async function openZoom() {
  const box = $('#zoom-box');
  box.hidden = !box.hidden;
  if (box.hidden) return;
  renderZoom();
  if (!$('#zoom-connected').hidden) await listZoom();
}

async function listZoom() {
  const list = $('#zoom-list');
  list.replaceChildren(Object.assign(document.createElement('li'), { className: 'muted', textContent: 'Looking for recordings…' }));
  try {
    const res = await fetch('/api/zoom/recordings');
    const body = await res.json();
    if (!res.ok) throw new Error(body.error || 'Zoom said no.');
    if (!body.recordings.length) {
      list.replaceChildren(Object.assign(document.createElement('li'), { className: 'muted', textContent: 'No cloud recordings in the last 90 days.' }));
      return;
    }
    list.replaceChildren(...body.recordings.map((r) => {
      const li = document.createElement('li');
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'zoom-rec';
      const when = r.start ? new Date(r.start).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : '';
      button.append(Object.assign(document.createElement('span'), { className: 'title', textContent: r.topic }),
        Object.assign(document.createElement('span'), {
          className: 'meta',
          textContent: [when, r.duration ? `${r.duration} min` : null, r.has_transcript ? 'Zoom transcript' : 'audio only'].filter(Boolean).join(' · '),
        }));
      button.addEventListener('click', () => {
        for (const b of list.querySelectorAll('.zoom-rec')) b.setAttribute('aria-pressed', String(b === button));
        setMeetingSource({ kind: 'zoom', uuid: r.uuid, topic: r.topic });
      });
      button.setAttribute('aria-pressed', String(meetingInput.source?.uuid === r.uuid));
      li.append(button);
      return li;
    }));
  } catch (err) {
    list.replaceChildren(Object.assign(document.createElement('li'), { className: 'problem', textContent: err.message }));
  }
}

// ---- recents ----

function loadRecent() {
  try {
    const list = JSON.parse(localStorage.getItem(RECENT_KEY));
    if (!Array.isArray(list)) return [];
    return list.map((item) => (typeof item === 'string' ? { kind: 'repo', url: item } : item))
      .filter((item) => item && (item.kind === 'repo' ? typeof item.url === 'string' : typeof item.id === 'string'));
  } catch {
    return [];
  }
}

function remember(entry) {
  const same = (a) => (a.kind === 'repo' ? a.url === entry.url : a.id === entry.id);
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify([entry, ...loadRecent().filter((e) => !same(e))].slice(0, 6)));
  } catch {
    // private windows can refuse storage; recents are only a convenience
  }
  renderRecent();
}

function renderRecent() {
  const list = loadRecent();
  const box = $('#recent');
  box.replaceChildren(...list.map((entry) => {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = `chip ${entry.kind}`;
    chip.textContent = entry.kind === 'repo' ? entry.url.replace(/^(https?:\/\/)?(www\.)?github\.com\//, '') : entry.title;
    chip.addEventListener('click', () => (entry.kind === 'repo' ? openRepo(entry.url) : openSavedMeeting(entry)));
    return chip;
  }));
  box.hidden = !list.length;
}

function openRepo(url) {
  selectTab('repo');
  $('#repo-url').value = url;
  $('#repo-form').requestSubmit();
}

async function openSavedMeeting(entry) {
  music.unlock();
  showError('');
  showScreen('progress');
  $('#step').textContent = `Opening ${entry.title}`;
  try {
    const res = await fetch(`/api/meeting/${encodeURIComponent(entry.id)}`);
    const scene = await res.json();
    if (!res.ok) throw new Error(scene.error || 'That meeting isn’t saved here any more.');
    await begin(scene);
  } catch (err) {
    fail(err);
  }
}

function fail(err) {
  world = null;
  music.stop();
  showScreen('intro');
  showError(err.message || String(err));
}

// ---------------------------------------------------------------------------
// Panels, idling and keys

const PANELS = { about: ['#about-panel', '#about'], orchestra: ['#orchestra', '#orchestra-toggle'], notes: ['#notes-panel', '#notes-toggle'] };

function togglePanel(which) {
  const [panel, button] = PANELS[which];
  const opening = $(panel).hidden;
  closePanels();
  if (opening) {
    $(panel).hidden = false;
    $(button).setAttribute('aria-expanded', 'true');
    if (which === 'orchestra') syncOrchestraPanel();
  }
  wake();
}

function closePanels() {
  for (const [panel, button] of Object.values(PANELS)) {
    $(panel).hidden = true;
    $(button).setAttribute('aria-expanded', 'false');
  }
}

function wake() {
  document.body.classList.remove('idle');
  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    const open = Object.values(PANELS).some(([panel]) => !$(panel).hidden);
    if (world && !open) document.body.classList.add('idle');
  }, 3500);
}

function toggleFullscreen() {
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
  else document.documentElement.requestFullscreen().catch(() => {});
}

function toggleSound() {
  music.setMuted(!music.muted);
  const button = $('#sound');
  button.setAttribute('aria-pressed', String(!music.muted));
  button.classList.toggle('muted', music.muted);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ---------------------------------------------------------------------------
// Wiring

$('#tab-repo').addEventListener('click', () => selectTab('repo'));
$('#tab-meeting').addEventListener('click', () => selectTab('meeting'));

$('#repo-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const url = $('#repo-url').value.trim();
  if (!url) return;
  music.unlock();  // this click is what allows the page to make sound
  showError('');
  $('#step').textContent = 'Getting ready';
  $('#log').textContent = '';
  showScreen('progress');
  try {
    const { job } = await postJSON('/api/build', { url, refresh: $('#refresh').checked });
    const scene = await waitForJob(job);
    remember({ kind: 'repo', url });
    await begin(scene);
  } catch (err) {
    fail(err);
  }
});

$('#meeting-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const source = meetingInput.source;
  if (!source) {
    showError('Add a recording, or choose one from Zoom, first.');
    return;
  }
  music.unlock();
  showError('');
  showScreen('progress');
  try {
    const media = source.kind === 'file' ? await upload(source.file, 'Uploading the recording') : null;
    const docs = [];
    for (const file of meetingInput.docs) docs.push((await upload(file, `Uploading ${file.name}`)).id);
    $('#step').textContent = 'Getting ready';
    const { job } = await postJSON('/api/meeting', {
      media: media && media.id,
      zoom: source.kind === 'zoom' ? source.uuid : null,
      docs,
      title: $('#meeting-title').value.trim(),
    });
    const scene = await waitForJob(job);
    remember({ kind: 'meeting', id: scene.meeting.id, title: scene.meeting.title });
    await begin(scene);
  } catch (err) {
    fail(err);
  }
});

$('#media-file').addEventListener('change', (e) => {
  if (e.target.files[0]) setMeetingSource({ kind: 'file', file: e.target.files[0] });
});
dropTarget($('#media-drop'), (files) => setMeetingSource({ kind: 'file', file: files[0] }));
$('#doc-files').addEventListener('change', (e) => {
  addDocs([...e.target.files]);
  e.target.value = '';
});
dropTarget($('#docs-drop'), addDocs);

$('#zoom-pick').addEventListener('click', openZoom);
$('#zoom-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const button = $('#zoom-form button[type=submit]');
  button.disabled = true;
  $('#zoom-problem').hidden = true;
  try {
    const values = Object.fromEntries(new FormData(event.target));
    const zoomStatus = await postJSON('/api/zoom/config', values);
    event.target.reset();
    if (health && health.meeting) health.meeting.zoom = zoomStatus;
    renderZoom();
    await listZoom();
  } catch (err) {
    $('#zoom-problem').textContent = err.message;
    $('#zoom-problem').hidden = false;
  } finally {
    button.disabled = false;
  }
});
$('#zoom-forget').addEventListener('click', async () => {
  const zoomStatus = await postJSON('/api/zoom/forget', {});
  if (health && health.meeting) health.meeting.zoom = zoomStatus;
  if (meetingInput.source?.kind === 'zoom') setMeetingSource(null);
  renderZoom();
});

$('#sound').addEventListener('click', toggleSound);
$('#volume').addEventListener('input', (e) => music.setVolume(Number(e.target.value)));
$('#fullscreen').addEventListener('click', toggleFullscreen);
$('#again').addEventListener('click', leave);
$('#about').addEventListener('click', () => togglePanel('about'));
$('#orchestra-toggle').addEventListener('click', () => togglePanel('orchestra'));
$('#notes-toggle').addEventListener('click', () => togglePanel('notes'));
$('#download-notes').addEventListener('click', downloadNotes);
$('#prev-point').addEventListener('click', () => world && world.step(-1));
$('#next-point').addEventListener('click', () => world && world.step(1));
$('#hold-point').addEventListener('click', () => {
  if (!world) return;
  world.toggleHold();
  $('#hold-point').setAttribute('aria-pressed', String(world.held));
});

for (const type of ['pointermove', 'pointerdown', 'keydown', 'touchstart']) {
  window.addEventListener(type, wake, { passive: true });
}
window.addEventListener('pointerdown', () => music.unlock());
window.addEventListener('keydown', (e) => {
  if (!world || e.metaKey || e.ctrlKey || e.altKey) return;
  if (e.key === 'Escape') closePanels();
  if (e.target instanceof HTMLInputElement) return;
  const key = e.key.toLowerCase();
  if (key === 'f') toggleFullscreen();
  if (key === 'm') toggleSound();
  if (key === 'o') togglePanel('orchestra');
  if (world.kind !== 'meeting') return;
  if (key === 'n') togglePanel('notes');
  if (e.key === 'ArrowRight') world.step(1);
  if (e.key === 'ArrowLeft') world.step(-1);
  if (e.key === ' ' && !(e.target instanceof HTMLButtonElement)) {  // a focused button keeps its own space
    e.preventDefault();
    world.toggleHold();
    $('#hold-point').setAttribute('aria-pressed', String(world.held));
  }
});
window.addEventListener('resize', resize);

resize();
buildOrchestraPanel();
requestAnimationFrame(frame);
renderRecent();
if (location.hash === '#meeting') selectTab('meeting');
checkHealth();
