// Themes set both the look and the feel: a colour gradient for the clusters, a backdrop hue,
// and the musical mode, tempo and room size. "From your work" leaves all of that to the
// repository itself (see deriveMood in music.js).

'use strict';

const THEMES = {
  work:   { name: 'From your work' },
  night:  { name: 'Night sky', mode: 'aeolian', bpm: 54, room: 1.3, bg: 236,
            stops: [[200, 70, 78], [222, 75, 72], [250, 70, 76], [282, 55, 78]] },
  ocean:  { name: 'Ocean', mode: 'mixolydian', bpm: 58, room: 1.2, bg: 205,
            stops: [[160, 65, 60], [180, 75, 62], [198, 80, 66], [220, 70, 72]] },
  forest: { name: 'Forest', mode: 'dorian', bpm: 60, room: 0.9, bg: 150,
            stops: [[40, 70, 66], [70, 60, 62], [105, 50, 60], [140, 45, 58]] },
  ember:  { name: 'Ember', mode: 'ionian', bpm: 62, room: 0.8, bg: 18,
            stops: [[340, 70, 72], [8, 80, 66], [26, 85, 64], [44, 85, 66]] },
  aurora: { name: 'Aurora', mode: 'lydian', bpm: 56, room: 1.4, bg: 222,
            stops: [[145, 75, 62], [172, 80, 64], [280, 65, 72], [318, 70, 72]] },
  dawn:   { name: 'Dawn', mode: 'lydian', bpm: 64, room: 1.0, bg: 300,
            stops: [[268, 55, 82], [330, 70, 80], [10, 80, 78], [42, 80, 76]] },
};

// A colour partway (0–1) along a theme's gradient, as { h, s, l }.
function themeColour(stops, x) {
  const pos = Math.min(0.9999, Math.max(0, x)) * (stops.length - 1);
  const i = Math.floor(pos);
  const f = pos - i;
  const [h1, s1, l1] = stops[i];
  const [h2, s2, l2] = stops[Math.min(i + 1, stops.length - 1)];
  const dh = ((h2 - h1 + 540) % 360) - 180;  // the short way round the colour wheel
  return { h: (h1 + dh * f + 360) % 360, s: s1 + (s2 - s1) * f, l: l1 + (l2 - l1) * f };
}

// For the theme picker: a CSS gradient that previews the theme.
function themeSwatch(theme) {
  if (!theme.stops) return 'conic-gradient(from 90deg, #ff9fb8, #ffd59a, #b8f0a0, #8fd8ff, #c9a8ff, #ff9fb8)';
  return `linear-gradient(135deg, ${theme.stops.map(([h, s, l]) => `hsl(${h} ${s}% ${l}%)`).join(', ')})`;
}
