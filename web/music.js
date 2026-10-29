// The score. The key, mode and tempo come from the repository's history or from the chosen
// theme (deriveMood); individual notes come from the animation itself (app.js asks for one
// whenever light lands on a node, and that node's colour, height and position decide what is
// heard). The ensemble holds each chord; each cluster of code is voiced by one of the enabled
// soloists. All timing is in performance.now() seconds so visuals and sound share one clock;
// Music converts to AudioContext time when it schedules.

'use strict';

const MODES = {
  lydian:     { steps: [0, 2, 4, 6, 7, 9, 11], penta: [0, 2, 4, 7, 9],  feel: 'bright and open',
                progressions: [[0, 1, 0, 4], [0, 4, 1, 5], [0, 5, 1, 4]] },
  ionian:     { steps: [0, 2, 4, 5, 7, 9, 11], penta: [0, 2, 4, 7, 9],  feel: 'warm and settled',
                progressions: [[0, 5, 3, 4], [0, 3, 5, 4], [0, 4, 5, 3], [3, 4, 0, 5]] },
  mixolydian: { steps: [0, 2, 4, 5, 7, 9, 10], penta: [0, 2, 4, 7, 9],  feel: 'easygoing',
                progressions: [[0, 6, 3, 0], [0, 3, 6, 3], [0, 4, 6, 3]] },
  dorian:     { steps: [0, 2, 3, 5, 7, 9, 10], penta: [0, 3, 5, 7, 10], feel: 'thoughtful',
                progressions: [[0, 3, 0, 6], [0, 2, 3, 0], [0, 6, 3, 4]] },
  aeolian:    { steps: [0, 2, 3, 5, 7, 8, 10], penta: [0, 3, 5, 7, 10], feel: 'quiet and nocturnal',
                progressions: [[0, 5, 2, 6], [0, 3, 5, 6], [0, 5, 3, 4]] },
};

// level: the default volume. trim: loudness calibration (measured offline) so every
// instrument at the same level sits at a similar loudness, with the ensemble a little under
// the soloists. reverb/echo: how much goes to the room and the delay. range: the MIDI notes a
// soloist plays comfortably; notes outside it move by octaves.
const INSTRUMENTS = [
  { id: 'strings', name: 'Strings', role: 'ensemble', about: 'hold each chord', level: 0.8, trim: 1.15, reverb: 1 },
  { id: 'low', name: 'Cellos & basses', role: 'ensemble', about: 'sing the roots', level: 0.7, trim: 0.45, reverb: 0.8 },
  { id: 'choir', name: 'Choir', role: 'ensemble', about: 'breathe the chords', level: 0.5, trim: 0.38, reverb: 1.2 },
  { id: 'drone', name: 'Drone', role: 'ensemble', about: 'the home note, always there', level: 0.5, trim: 0.45, reverb: 1 },
  { id: 'harp', name: 'Harp', role: 'solo', range: [43, 91], level: 0.8, trim: 2, reverb: 0.9, echo: 0.6 },
  { id: 'flute', name: 'Flute', role: 'solo', range: [62, 93], level: 0.7, trim: 0.63, reverb: 1, echo: 0.6 },
  { id: 'piano', name: 'Felt piano', role: 'solo', range: [45, 91], level: 0.8, trim: 1, reverb: 0.9, echo: 0.8 },
  { id: 'glass', name: 'Glass bells', role: 'solo', range: [64, 98], level: 0.8, trim: 0.9, reverb: 1, echo: 1 },
  { id: 'kalimba', name: 'Kalimba', role: 'solo', range: [55, 88], level: 0.8, trim: 1.1, reverb: 0.9, echo: 1 },
  { id: 'vibes', name: 'Vibraphone', role: 'solo', range: [53, 89], level: 0.8, trim: 1, reverb: 0.9, echo: 0.8 },
  { id: 'pizz', name: 'Pizzicato strings', role: 'solo', range: [43, 84], level: 0.7, trim: 1.7, reverb: 0.9, echo: 0.4 },
];
const INSTRUMENT = Object.fromEntries(INSTRUMENTS.map((i) => [i.id, i]));

// What the code is written in picks the lead soloist.
const LANGUAGE_LEADS = {
  glass:   ['py', 'pyi', 'ipynb', 'rb', 'r', 'jl', 'lua', 'pl', 'php', 'ex', 'exs', 'erl', 'hs', 'clj', 'ml', 'elm'],
  kalimba: ['js', 'jsx', 'ts', 'tsx', 'mjs', 'cjs', 'vue', 'svelte', 'astro', 'html', 'css', 'scss', 'sass', 'less', 'dart'],
  vibes:   ['c', 'h', 'cpp', 'cc', 'cxx', 'hpp', 'hh', 'rs', 'go', 'java', 'kt', 'kts', 'cs', 'swift', 'scala', 'zig', 'm', 'mm', 'sol'],
  piano:   [],
};

const NOTE_NAMES = ['C', 'D♭', 'D', 'E♭', 'E', 'F', 'F♯', 'G', 'A♭', 'A', 'B♭', 'B'];
const ROOTS = [45, 46, 48, 50, 51, 53]; // A2–F3: low enough for the ensemble, leaves room above for soloists
const MAX_VOICES = 40;

const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));
const mtof = (m) => 440 * Math.pow(2, (m - 69) / 12);
const sum = (xs) => xs.reduce((a, b) => a + b, 0);

function hashString(text) {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function deriveMood(scene, theme = THEMES.work) {
  if (scene.kind === 'meeting') return deriveStudyMood(scene, theme);
  const { stats, repo } = scene;
  const seed = hashString(`${repo.owner}/${repo.name}`.toLowerCase());
  const reasons = [];

  // When the work happened sets the mode: daylight commits read brighter than late nights.
  const total = sum(stats.hours);
  const daylight = total ? sum(stats.hours.slice(7, 19)) / total : 0.6;
  const workMode = daylight >= 0.78 ? 'lydian' : daylight >= 0.62 ? 'ionian' : daylight >= 0.48 ? 'mixolydian'
    : daylight >= 0.33 ? 'dorian' : 'aeolian';

  // How often the work happened sets the pace, always unhurried.
  const spanDays = stats.first && stats.last
    ? Math.max(1, (Date.parse(stats.last) - Date.parse(stats.first)) / 864e5) : 1;
  const perWeek = stats.commits ? (stats.commits / spanDays) * 7 : 0;
  const workBpm = Math.round(54 + 18 * clamp(Math.log10(1 + perWeek) / 2, 0, 1));

  const mode = theme.mode || workMode;
  const bpm = theme.bpm || workBpm;
  const modeName = mode === 'ionian' ? 'major' : mode === 'aeolian' ? 'minor' : mode;
  if (theme.mode) {
    reasons.push(`The ${theme.name} theme sets a ${modeName} mood (${MODES[mode].feel}) at ${bpm} beats a minute, `
      + `one breath every ${Math.round(480 / bpm)} seconds.`);
  } else {
    reasons.push(total
      ? `${Math.round(daylight * 100)}% of the commits were made between 7am and 7pm, so the mode is ${modeName}: ${MODES[mode].feel}.`
      : `There were no commit times to read, so the mode is ${modeName}: ${MODES[mode].feel}.`);
    reasons.push(stats.commits
      ? `About ${perWeek < 10 ? perWeek.toFixed(1) : Math.round(perWeek)} commits a week sets the pace at ${bpm} beats a minute, one breath every ${Math.round(480 / bpm)} seconds.`
      : `A resting pace of ${bpm} beats a minute.`);
  }

  const root = ROOTS[seed % ROOTS.length];

  // What the work is written in picks the lead soloist.
  const tally = { glass: 0, kalimba: 0, vibes: 0, piano: 0 };
  for (const [ext, count] of Object.entries(stats.languages || {})) {
    const lead = Object.keys(LANGUAGE_LEADS).find((k) => LANGUAGE_LEADS[k].includes(ext)) || 'piano';
    tally[lead] += count;
  }
  const lead = Object.keys(tally).reduce((a, b) => (tally[b] > tally[a] ? b : a), 'piano');
  const topExt = Object.keys(stats.languages || {})[0];

  // How big it is sets the size of the room.
  const reverb = (3 + 3 * clamp(Math.log10(Math.max(10, stats.nodes_total)) / 4, 0, 1)) * (theme.room || 1);
  reasons.push(`${stats.nodes_total.toLocaleString()} pieces of code, so the room rings for ${reverb.toFixed(1)} seconds.`);

  // How tangled it is sets how often light travels between ideas.
  const avgDegree = stats.nodes_total ? (2 * stats.links_total) / stats.nodes_total : 2;
  const density = clamp(0.25 + avgDegree / 12, 0.25, 0.7);

  const options = MODES[mode].progressions;
  const progression = options[(seed >>> 4) % options.length];
  reasons.push(`Each of the ${scene.communities.length} clusters of related code has its own colour, and each colour is a note. `
    + 'Height on screen picks the octave and left–right is where you hear it.');

  return {
    root, mode, bpm, lead, topExt, progression, reverb, density, reasons, study: false, eventEvery: 1,
    label: `${NOTE_NAMES[root % 12]} ${modeName} · ${bpm} bpm · ${theme.name}`,
  };
}

// A meeting is for learning: slower, quieter, steadier, with time to read each point.
function deriveStudyMood(scene, theme) {
  const { stats, notes, meeting } = scene;
  const seed = hashString(meeting.id || meeting.title || 'meeting');
  const reasons = [];

  const open = notes.questions.length;
  const settled = notes.decisions.length + notes.actions.length;
  const meetingMode = open > settled ? 'dorian' : settled > 0 ? 'ionian' : 'lydian';
  const meetingBpm = Math.round(52 + 10 * clamp((stats.wpm - 110) / 80, 0, 1));
  const mode = theme.mode || meetingMode;
  const bpm = theme.bpm || meetingBpm;
  const modeName = mode === 'ionian' ? 'major' : mode === 'aeolian' ? 'minor' : mode;
  const eventEvery = 2;

  reasons.push(`Study mode: one key point every two breaths (about ${Math.round((eventEvery * 480) / bpm)} seconds), `
    + 'so there is time to read each one and let it settle. ← and → step through them, and space holds one.');
  if (theme.mode) {
    reasons.push(`The ${theme.name} theme sets a ${modeName} mood (${MODES[mode].feel}) at ${bpm} beats a minute.`);
  } else {
    reasons.push(open > settled
      ? `More questions were left open (${open}) than settled (${settled}), so the mode is ${modeName}: ${MODES[mode].feel}.`
      : settled > 0
        ? `The meeting settled ${settled} decision${settled === 1 ? '' : 's'} and action item${settled === 1 ? '' : 's'}, so the mode is ${modeName}: ${MODES[mode].feel}.`
        : `An exploratory conversation, so the mode is ${modeName}: ${MODES[mode].feel}.`);
    reasons.push(`People spoke at about ${stats.wpm} words a minute, so the pace is a gentle ${bpm} beats a minute.`);
  }
  reasons.push('A felt piano leads, softly, and the choir rests by default: voices compete with reading.');
  const reverb = 3.6 * (theme.room || 1);
  reasons.push(`A small, quiet room: the sound rings for ${reverb.toFixed(1)} seconds.`);
  reasons.push(`Each of the ${scene.communities.length} topics has its own colour, and each colour is a note. `
    + 'Height on screen picks the octave and left–right is where you hear it.');

  const options = MODES[mode].progressions;
  return {
    root: ROOTS[seed % ROOTS.length], mode, bpm, lead: 'piano', topExt: null,
    progression: options[(seed >>> 4) % options.length], reverb, density: 0.22, reasons, study: true, eventEvery,
    label: `${NOTE_NAMES[ROOTS[seed % ROOTS.length] % 12]} ${modeName} · ${bpm} bpm · ${theme.mode ? theme.name : 'From the meeting'}`,
  };
}

// The orchestra the source suggests. For code: the full ensemble, harp, flute and the language's
// lead. For study: no choir, a piano lead, and soft mallets.
function defaultOrchestra(mood) {
  const on = new Set(mood.study
    ? ['strings', 'low', 'drone', 'piano', 'harp', 'vibes']
    : ['strings', 'low', 'choir', 'drone', 'harp', 'flute', mood.lead]);
  return Object.fromEntries(INSTRUMENTS.map((i) => [i.id, { on: on.has(i.id), level: i.level }]));
}

class Music {
  constructor() {
    this.ctx = null;
    this.mood = null;
    this.timer = null;
    this.drone = null;
    this.offset = null;   // AudioContext time minus performance time
    this.volume = 0.7;
    this.muted = false;
    this.voices = 0;
    this.orchestra = {};
    this.buses = {};
    this.live = new Set();      // output gains of everything currently sounding or scheduled
    this.plucks = new Map();    // cached plucked-string recordings, by instrument and note
    this.soloOrder = null;
    this.onChord = null;  // (index, time, chord) => void, called a little ahead of each chord
  }

  // Must run inside a user gesture: browsers only allow sound after one.
  unlock() {
    if (!this.ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      this.ctx = new AC();
      this.buildBuses();
    }
    if (this.ctx.state === 'suspended') this.ctx.resume().catch(() => {});
  }

  now() {
    return performance.now() / 1000;
  }

  configure(mood, orchestra = defaultOrchestra(mood)) {
    this.stop();
    this.mood = mood;
    this.beat = 60 / mood.bpm;
    this.chordLen = this.beat * 8;  // two bars: one slow breath per chord
    this.start = this.now() + 0.5;
    this.nextChord = 0;
    this.setOrchestra(orchestra);
    if (this.ctx) {
      this.reverb.buffer = this.impulse(mood.reverb);
      this.delay.delayTime.value = this.beat * 0.75;
      this.startDrone();
    }
    this.timer = setInterval(() => this.tick(), 50);
    this.tick();
  }

  // Stop the score and fade out whatever is still ringing, so a new key never clashes with the old.
  stop() {
    clearInterval(this.timer);
    this.timer = null;
    this.stopDrone();
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    for (const g of this.live) {
      const value = g.gain.value;
      g.gain.cancelScheduledValues(t);
      g.gain.setValueAtTime(value, t);
      g.gain.setTargetAtTime(0, t, 0.4);
    }
    this.live.clear();
  }

  setOrchestra(orchestra) {
    for (const inst of INSTRUMENTS) this.setInstrument(inst.id, orchestra[inst.id] || { on: false, level: inst.level });
  }

  setInstrument(id, state) {
    this.orchestra[id] = { on: Boolean(state.on), level: clamp(Number(state.level) || 0, 0, 1) };
    this.soloOrder = null;
    const bus = this.buses[id];
    if (bus) {
      const t = this.ctx.currentTime;
      bus.gain.cancelScheduledValues(t);
      bus.gain.setTargetAtTime(this.orchestra[id].on ? this.orchestra[id].level : 0, t, 0.15);
    }
  }

  // Enabled soloists, the work's lead first: the biggest cluster gets the lead.
  soloists() {
    if (!this.soloOrder) {
      const on = INSTRUMENTS.filter((i) => i.role === 'solo' && this.orchestra[i.id]?.on).map((i) => i.id);
      const lead = this.mood && on.indexOf(this.mood.lead);
      if (lead > 0) on.unshift(...on.splice(lead, 1));
      this.soloOrder = on;
    }
    return this.soloOrder;
  }

  voiceFor(community) {
    const solo = this.soloists();
    return solo.length ? solo[community % solo.length] : null;
  }

  setVolume(v) {
    this.volume = v;
    this.applyLevel();
  }

  setMuted(m) {
    this.muted = m;
    this.applyLevel();
  }

  applyLevel() {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    this.master.gain.cancelScheduledValues(t);
    this.master.gain.setTargetAtTime(this.muted ? 0 : this.volume, t, 0.25);
  }

  // ---- time & harmony ----

  tick() {
    this.syncClock();
    const horizon = this.now() + 1.5;
    while (this.chordTime(this.nextChord) < horizon) {
      const i = this.nextChord++;
      const t = this.chordTime(i);
      const chord = this.chord(i);
      if (this.ctx) this.ensemble(chord, t, this.chordLen);
      if (this.onChord) this.onChord(i, t, chord);
    }
  }

  chordTime(i) {
    return this.start + i * this.chordLen;
  }

  chordIndexAt(t) {
    return Math.floor((t - this.start) / this.chordLen);
  }

  // 0 at each chord change, 1 halfway through: the in-breath and out-breath.
  breath(t) {
    if (!this.mood) return 0;
    const phase = (((t - this.start) / this.chordLen) % 1 + 1) % 1;
    return 0.5 - 0.5 * Math.cos(phase * Math.PI * 2);
  }

  // The next grid line at or after t, in beats (0.5 = eighth notes).
  quantize(t, division = 0.5) {
    const grid = this.beat * division;
    return this.start + Math.ceil((t - this.start) / grid - 1e-6) * grid;
  }

  chord(i) {
    const { mode, progression } = this.mood;
    const steps = MODES[mode].steps;
    const len = progression.length;
    const degree = progression[((i % len) + len) % len];
    const tone = (k) => steps[(degree + k) % 7] + 12 * Math.floor((degree + k) / 7);
    const second = tone(1) - tone(0) === 2 ? tone(1) + 12 : tone(0) + 12; // add9 only when it's a whole step
    const tones = [tone(0), tone(2), tone(4), second];
    // Melody notes: the triad, plus its colour note and the pentatonic notes that don't rub a
    // semitone against it. (A minor chord's 9th sits fine in a wide voicing, not in a melody.)
    const triad = tones.slice(0, 3).map((x) => x % 12);
    const rubs = (p) => !triad.includes(p) && triad.some((c) => [1, 11].includes((p - c + 12) % 12));
    const palette = [...new Set([...triad, second % 12, ...MODES[mode].penta])].filter((p) => !rubs(p)).sort((a, b) => a - b);
    return { degree, tones, palette };
  }

  // tone 0–1 chooses the note, height 0 (bottom) – 1 (top) the octave, weight 0–1 how much of a hub it is.
  pitch(tone, height, weight, t) {
    const { palette } = this.chord(this.chordIndexAt(t));
    const pc = palette[Math.min(palette.length - 1, Math.floor(clamp(tone, 0, 0.999) * palette.length))];
    let octave = height < 0.33 ? -1 : height < 0.7 ? 0 : 1;
    if (weight > 0.6) octave -= 1;  // hubs speak lower
    let midi = this.mood.root + 24 + pc + 12 * Math.max(-1, octave);
    while (midi > 96) midi -= 12;
    return midi;
  }

  // ---- mixing ----

  syncClock() {
    if (!this.ctx || this.ctx.state !== 'running') return;
    let offset = null;
    if (this.ctx.getOutputTimestamp) {
      const ts = this.ctx.getOutputTimestamp();
      if (ts.performanceTime > 0) offset = ts.contextTime - ts.performanceTime / 1000;
    }
    if (offset === null) offset = this.ctx.currentTime - performance.now() / 1000;
    if (this.offset === null || Math.abs(offset - this.offset) > 0.05) this.offset = offset;
  }

  toAudio(t) {
    return t + (this.offset ?? 0);
  }

  buildBuses() {
    const ctx = this.ctx;
    this.master = ctx.createGain();
    this.master.gain.value = this.muted ? 0 : this.volume;
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -18;
    comp.ratio.value = 3;
    comp.attack.value = 0.02;
    comp.release.value = 0.4;
    this.master.connect(comp).connect(ctx.destination);

    this.dry = ctx.createGain();
    this.dry.gain.value = 0.55;
    this.dry.connect(this.master);

    this.reverb = ctx.createConvolver();
    this.reverb.buffer = this.impulse(4);
    this.revSend = ctx.createGain();
    this.revSend.gain.value = 0.8;
    const revOut = ctx.createGain();
    revOut.gain.value = 0.7;
    this.revSend.connect(this.reverb).connect(revOut).connect(this.master);

    this.delay = ctx.createDelay(2);
    this.delay.delayTime.value = 0.75;
    this.delaySend = ctx.createGain();
    this.delaySend.gain.value = 0.22;
    const feedback = ctx.createGain();
    feedback.gain.value = 0.38;
    const tone = ctx.createBiquadFilter();
    tone.type = 'lowpass';
    tone.frequency.value = 2200;
    this.delaySend.connect(this.delay);
    this.delay.connect(tone).connect(feedback).connect(this.delay);
    tone.connect(this.revSend);
    tone.connect(this.master);

    // One channel per instrument, so each can be switched and balanced on its own.
    for (const inst of INSTRUMENTS) {
      const bus = ctx.createGain();
      const state = this.orchestra[inst.id];
      bus.gain.value = state && state.on ? state.level : 0;
      bus.connect(this.dry);
      const rev = ctx.createGain();
      rev.gain.value = inst.reverb;
      bus.connect(rev).connect(this.revSend);
      if (inst.echo) {
        const echo = ctx.createGain();
        echo.gain.value = inst.echo;
        bus.connect(echo).connect(this.delaySend);
      }
      this.buses[inst.id] = bus;
    }
  }

  impulse(seconds) {
    const ctx = this.ctx;
    const length = Math.floor(ctx.sampleRate * seconds);
    const buffer = ctx.createBuffer(2, length, ctx.sampleRate);
    for (let ch = 0; ch < 2; ch++) {
      const data = buffer.getChannelData(ch);
      let smooth = 0;
      for (let i = 0; i < length; i++) {
        smooth += 0.35 * ((Math.random() * 2 - 1) - smooth);  // a little darker than white noise
        data[i] = smooth * Math.pow(1 - i / length, 2.6);
      }
    }
    return buffer;
  }

  // Remember a voice's output so stop() can fade it, and tidy it away once it has rung out.
  track(out, until, onDone) {
    this.live.add(out);
    setTimeout(() => {
      this.live.delete(out);
      out.disconnect();
      if (onDone) onDone();
    }, (until - this.ctx.currentTime + 0.5) * 1000);
  }

  // ---- the ensemble: one breath per chord ----

  // Every section is scheduled whether or not it's switched on (its channel is simply silent),
  // so switching one on is heard straight away rather than at the next chord.
  ensemble(chord, t, len) {
    const at = this.toAudio(t);
    if (at < this.ctx.currentTime - 0.05) return;
    this.strings(chord, at, len);
    this.low(chord, at, len);
    this.choir(chord, at, len);
    if (this.orchestra.harp?.on) this.harpRoll(chord, t);
  }

  // Swell in, open up through the middle, ease off as the next chord arrives.
  swell(id, at, len, peakAt = 0.45) {
    const peak = INSTRUMENT[id].trim;
    const out = this.ctx.createGain();
    out.gain.setValueAtTime(0.0001, at);
    out.gain.exponentialRampToValueAtTime(peak, at + len * peakAt);
    out.gain.exponentialRampToValueAtTime(0.35 * peak, at + len);
    out.gain.setTargetAtTime(0.0001, at + len, 1.2);
    out.connect(this.buses[id]);
    this.track(out, at + len + 6);
    return out;
  }

  breathingFilter(out, at, len, low, high) {
    const filter = this.ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.Q.value = 0.6;
    filter.frequency.setValueAtTime(low, at);
    filter.frequency.exponentialRampToValueAtTime(high, at + len * 0.5);
    filter.frequency.exponentialRampToValueAtTime(low * 1.15, at + len + 2);
    filter.connect(out);
    return filter;
  }

  // A slow vibrato, eased in, as a signal (in cents) to connect to oscillators' detune.
  vibrato(at, stopAt, rate, cents) {
    const lfo = this.ctx.createOscillator();
    lfo.frequency.value = rate;
    const depth = this.ctx.createGain();
    depth.gain.setValueAtTime(0, at);
    depth.gain.linearRampToValueAtTime(cents, at + 1.5);
    lfo.connect(depth);
    lfo.start(at);
    lfo.stop(stopAt);
    return depth;
  }

  osc(type, midi, cents, gain, dest, at, stopAt, vibrato) {
    const o = this.ctx.createOscillator();
    o.type = type;
    o.frequency.value = mtof(midi);
    o.detune.value = cents;
    if (vibrato) vibrato.connect(o.detune);
    const g = this.ctx.createGain();
    g.gain.value = gain;
    o.connect(g).connect(dest);
    o.start(at);
    o.stop(stopAt);
    return o;
  }

  strings(chord, at, len) {
    const out = this.swell('strings', at, len);
    const body = this.breathingFilter(out, at, len, 800, 2600);
    const stopAt = at + len + 6;
    const vib = this.vibrato(at, stopAt, 5.1, 7);
    const root = this.mood.root;
    const [r, third, fifth, color] = chord.tones;
    for (const midi of [root + r + 12, root + fifth + 12, root + third + 24, root + color + 12]) {
      for (const cents of [-9, 0, 8]) this.osc('sawtooth', midi, cents, 0.016, body, at, stopAt, vib);
    }
  }

  low(chord, at, len) {
    const out = this.swell('low', at, len, 0.3);
    const body = this.breathingFilter(out, at, len, 420, 900);
    const stopAt = at + len + 6;
    const vib = this.vibrato(at, stopAt, 4.6, 5);
    const bass = this.mood.root + chord.tones[0] - 12;
    this.osc('sine', bass, 0, 0.13, body, at, stopAt);
    this.osc('sawtooth', bass, -4, 0.03, body, at, stopAt, vib);
    this.osc('sawtooth', bass + 12, -6, 0.022, body, at, stopAt, vib);
    this.osc('sawtooth', bass + 12, 6, 0.022, body, at, stopAt, vib);
  }

  // "Aah": bright sources shaped by three vowel formants.
  choir(chord, at, len) {
    const out = this.swell('choir', at, len, 0.5);
    const stopAt = at + len + 6;
    const voice = this.ctx.createGain();
    for (const [freq, q, gain] of [[800, 6, 1], [1150, 8, 0.5], [2900, 12, 0.2]]) {
      const formant = this.ctx.createBiquadFilter();
      formant.type = 'bandpass';
      formant.frequency.value = freq;
      formant.Q.value = q;
      const g = this.ctx.createGain();
      g.gain.value = gain;
      voice.connect(formant).connect(g).connect(out);
    }
    const vib = this.vibrato(at, stopAt, 4.4, 10);
    const root = this.mood.root;
    const [r, third, fifth] = chord.tones;
    for (const midi of [root + r + 12, root + third + 12, root + fifth + 12]) {
      this.osc('sawtooth', midi, -6, 0.2, voice, at, stopAt, vib);
      this.osc('sawtooth', midi, 7, 0.2, voice, at, stopAt, vib);
    }
  }

  harpRoll(chord, t) {
    const root = this.mood.root;
    const [r, third, fifth, color] = chord.tones;
    [root + r, root + fifth, root + third + 12, root + color + 12].forEach((midi, k) => {
      this.note('harp', midi, t + k * 0.11, 0.32 - k * 0.03, -0.4 + k * 0.25);
    });
  }

  startDrone() {
    const ctx = this.ctx;
    const at = ctx.currentTime;
    const out = ctx.createGain();
    const level = 0.1 * INSTRUMENT.drone.trim;
    out.gain.setValueAtTime(0, at);
    out.gain.linearRampToValueAtTime(level, at + 6);
    out.connect(this.buses.drone);

    const base = mtof(this.mood.root - 12);
    const nodes = [];
    for (const [ratio, level] of [[1, 1], [1.5, 0.35], [2, 0.2]]) {
      const osc = ctx.createOscillator();
      osc.frequency.value = base * ratio;
      const g = ctx.createGain();
      g.gain.value = level;
      osc.connect(g).connect(out);
      osc.start(at);
      nodes.push(osc);
    }
    // The drone breathes with the chords.
    const lfo = ctx.createOscillator();
    lfo.frequency.value = 1 / this.chordLen;
    const depth = ctx.createGain();
    depth.gain.value = level * 0.4;
    lfo.connect(depth).connect(out.gain);
    lfo.start(at);
    nodes.push(lfo);
    this.drone = { out, nodes };
  }

  stopDrone() {
    if (!this.drone || !this.ctx) return;
    const { out, nodes } = this.drone;
    const t = this.ctx.currentTime;
    out.gain.cancelScheduledValues(t);
    out.gain.setTargetAtTime(0, t, 0.8);
    for (const n of nodes) n.stop(t + 4);
    setTimeout(() => out.disconnect(), 4500);
    this.drone = null;
  }

  // ---- soloists ----

  // One note from soloist `id`: velocity 0–1, pan −1 (left) – 1 (right).
  note(id, midi, t, velocity = 0.5, pan = 0) {
    if (!this.ctx || this.muted || this.ctx.state !== 'running' || !this.orchestra[id]?.on) return;
    const ctx = this.ctx;
    const at = Math.max(this.toAudio(t), ctx.currentTime);
    if (this.toAudio(t) < ctx.currentTime - 0.05 || this.voices >= MAX_VOICES) return;

    const [lo, hi] = INSTRUMENT[id].range;
    while (midi < lo) midi += 12;
    while (midi > hi) midi -= 12;

    const out = ctx.createGain();
    out.gain.value = 0.16 * velocity * INSTRUMENT[id].trim;
    const panner = ctx.createStereoPanner ? ctx.createStereoPanner() : null;
    if (panner) {
      panner.pan.value = clamp(pan, -1, 1);
      out.connect(panner).connect(this.buses[id]);
    } else {
      out.connect(this.buses[id]);
    }

    const length = this.voice(id, out, mtof(midi), midi, at);
    this.voices++;
    this.track(out, at + length, () => {
      this.voices--;
      if (panner) panner.disconnect();
    });
  }

  // Builds the sound into `out` and returns how long it rings.
  voice(id, out, f, midi, at) {
    const ctx = this.ctx;
    let length = 0;
    const partial = (freq, gain, decay, type = 'sine', attack = 0.004, dest = out) => {
      if (freq > 16000) return null;
      const osc = ctx.createOscillator();
      osc.type = type;
      osc.frequency.value = freq;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0, at);
      g.gain.linearRampToValueAtTime(gain, at + attack);
      g.gain.exponentialRampToValueAtTime(0.0001, at + attack + decay);
      osc.connect(g).connect(dest);
      osc.start(at);
      osc.stop(at + attack + decay + 0.05);
      length = Math.max(length, attack + decay);
      return osc;
    };

    switch (id) {
      case 'harp':
        return this.pluck(out, midi, at, 'harp', 1.1);
      case 'pizz':
        return this.pluck(out, midi, at, 'pizz', 1.3);
      case 'flute':
        return this.flute(out, f, at);
      case 'glass':
        partial(f, 1, 3.2);
        partial(f * 2.76, 0.3, 1.4);
        partial(f * 5.4, 0.12, 0.6);
        partial(f * 8.93, 0.04, 0.3);
        return length;
      case 'kalimba':
        partial(f, 1, 1.7, 'sine', 0.002);
        partial(f, 0.22, 0.5, 'triangle', 0.002);
        partial(f * 6.1, 0.06, 0.12, 'sine', 0.001);
        return length;
      case 'vibes': {
        // Motor tremolo on a soft mallet tone.
        const trem = ctx.createGain();
        trem.gain.value = 0.82;
        const lfo = ctx.createOscillator();
        lfo.frequency.value = 4.6;
        const depth = ctx.createGain();
        depth.gain.value = 0.18;
        lfo.connect(depth).connect(trem.gain);
        trem.connect(out);
        partial(f, 1, 3.6, 'sine', 0.003, trem);
        partial(f * 4, 0.2, 0.7, 'sine', 0.002, trem);
        partial(f * 10, 0.04, 0.15, 'sine', 0.001, trem);
        lfo.start(at);
        lfo.stop(at + length + 0.1);
        return length;
      }
      default: // felt piano
        partial(f, 1, 2.6, 'sine', 0.01);
        partial(f * 2, 0.22, 1.3, 'sine', 0.01);
        partial(f * 3, 0.07, 0.6, 'sine', 0.01);
        return length;
    }
  }

  flute(out, f, at) {
    const ctx = this.ctx;
    const hold = 1.1;
    const release = 0.9;
    const end = at + hold + release;
    const env = ctx.createGain();
    env.gain.setValueAtTime(0, at);
    env.gain.linearRampToValueAtTime(1, at + 0.14);
    env.gain.setValueAtTime(1, at + hold);
    env.gain.exponentialRampToValueAtTime(0.0001, end);
    env.connect(out);

    const vib = this.vibrato(at + 0.25, end, 5.2, 9);
    for (const [type, ratio, gain] of [['sine', 1, 0.8], ['triangle', 1, 0.14], ['sine', 2, 0.08]]) {
      const o = ctx.createOscillator();
      o.type = type;
      o.frequency.value = f * ratio;
      vib.connect(o.detune);
      const g = ctx.createGain();
      g.gain.value = gain;
      o.connect(g).connect(env);
      o.start(at);
      o.stop(end + 0.05);
    }
    // A little breath at the start of the note.
    const noise = ctx.createBufferSource();
    noise.buffer = this.noise();
    const band = ctx.createBiquadFilter();
    band.type = 'bandpass';
    band.frequency.value = Math.min(f * 2, 8000);
    band.Q.value = 1.2;
    const breath = ctx.createGain();
    breath.gain.setValueAtTime(0, at);
    breath.gain.linearRampToValueAtTime(0.12, at + 0.05);
    breath.gain.exponentialRampToValueAtTime(0.02, at + 0.4);
    breath.gain.exponentialRampToValueAtTime(0.0001, end);
    noise.connect(band).connect(breath).connect(out);
    noise.start(at);
    noise.stop(end);
    return hold + release;
  }

  noise() {
    if (!this.noiseBuffer) {
      const length = this.ctx.sampleRate * 2;
      this.noiseBuffer = this.ctx.createBuffer(1, length, this.ctx.sampleRate);
      const data = this.noiseBuffer.getChannelData(0);
      for (let i = 0; i < length; i++) data[i] = Math.random() * 2 - 1;
    }
    return this.noiseBuffer;
  }

  // A plucked string (Karplus–Strong), recorded once per note and replayed.
  pluck(out, midi, at, kind, gain) {
    const { buffer, rate, length } = this.pluckRecording(midi, kind);
    const src = this.ctx.createBufferSource();
    src.buffer = buffer;
    src.playbackRate.value = rate;
    const tone = this.ctx.createBiquadFilter();
    tone.type = 'lowpass';
    tone.frequency.value = kind === 'pizz' ? 1800 : 4200;
    const g = this.ctx.createGain();
    g.gain.value = gain;
    src.connect(tone).connect(g).connect(out);
    src.start(at);
    return length / rate;
  }

  pluckRecording(midi, kind) {
    const key = `${kind}:${midi}`;
    if (this.plucks.has(key)) return this.plucks.get(key);
    const sr = this.ctx.sampleRate;
    const f = mtof(midi);
    const period = Math.max(2, Math.round(sr / f - 0.5));
    const ringFor = kind === 'pizz'
      ? clamp(0.9 - (midi - 43) * 0.012, 0.35, 0.9)
      : clamp(3.4 - (midi - 43) * 0.045, 1.3, 3.4);
    // 60 dB down after ringFor seconds. The averaging below already loses cos(πf/sr) of the
    // fundamental each period, so ask only for the rest.
    const loss = Math.min(0.99999, Math.exp(Math.log(0.001) / (f * ringFor)) / Math.cos((Math.PI * f) / sr));
    const length = Math.ceil(sr * (ringFor + 0.1));

    const ring = new Float32Array(period);
    for (let i = 0; i < period; i++) ring[i] = Math.random() * 2 - 1;
    for (let pass = 0; pass < (kind === 'pizz' ? 4 : 2); pass++) {  // a softer finger, a softer pluck
      for (let i = 1; i < period; i++) ring[i] = 0.5 * (ring[i] + ring[i - 1]);
    }
    const mean = ring.reduce((a, b) => a + b, 0) / period;
    let peak = 0;
    for (let i = 0; i < period; i++) peak = Math.max(peak, Math.abs((ring[i] -= mean)));
    for (let i = 0; i < period; i++) ring[i] /= peak || 1;

    const buffer = this.ctx.createBuffer(1, length, sr);
    const data = buffer.getChannelData(0);
    let i0 = 0;
    for (let i = 0; i < length; i++) {
      const i1 = i0 + 1 === period ? 0 : i0 + 1;
      const v = ring[i0];
      data[i] = v;
      ring[i0] = loss * 0.5 * (v + ring[i1]);
      i0 = i1;
    }
    // The averaging filter makes the loop half a sample longer; correct the tuning on playback.
    const recording = { buffer, rate: (f * (period + 0.5)) / sr, length: length / sr };
    this.plucks.set(key, recording);
    return recording;
  }
}
