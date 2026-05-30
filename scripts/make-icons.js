// One-shot generator: renders BonesAI's skull icon to the PNG sizes iOS,
// Android, and the PWA manifest need. Run with `node scripts/make-icons.js`.
// Sharp is a devDependency.
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

const OUT = path.resolve(__dirname, '..', 'src', 'renderer', 'icons');
fs.mkdirSync(OUT, { recursive: true });

// Stand-alone SVG. Designed as an iOS-quality app icon: bold central skull
// reading clearly at small sizes, a subtle cyan halo for depth, properly
// bone-shaped crossbones (knobby epiphyses, slight curve), and a tiny
// cyan catchlight in each socket so the skull has a hint of life.
function iconSvg({ rounded = false } = {}) {
  const corner = rounded
    ? `<rect width="200" height="200" rx="44" ry="44" fill="url(#bg)"/>`
    : `<rect width="200" height="200" fill="url(#bg)"/>`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200">
  <defs>
    <radialGradient id="bg" cx="50%" cy="40%" r="75%">
      <stop offset="0%" stop-color="#142446"/>
      <stop offset="100%" stop-color="#06101f"/>
    </radialGradient>
    <radialGradient id="halo" cx="50%" cy="50%" r="50%">
      <stop offset="0%" stop-color="#4cc7ff" stop-opacity="0.55"/>
      <stop offset="55%" stop-color="#4cc7ff" stop-opacity="0.12"/>
      <stop offset="100%" stop-color="#4cc7ff" stop-opacity="0"/>
    </radialGradient>
    <linearGradient id="boneGrad" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#eaf3ff"/>
      <stop offset="100%" stop-color="#9cb6d6"/>
    </linearGradient>
    <linearGradient id="skullGrad" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#f3f8ff"/>
      <stop offset="55%" stop-color="#d3e1f4"/>
      <stop offset="100%" stop-color="#8aa7c9"/>
    </linearGradient>
    <filter id="glow" x="-25%" y="-25%" width="150%" height="150%">
      <feGaussianBlur stdDeviation="3.5"/>
    </filter>
  </defs>
  ${corner}

  <!-- Halo -->
  <circle cx="100" cy="98" r="74" fill="url(#halo)"/>

  <!-- Crossbones (behind the skull): two femur shapes crossed at the back,
       with proper rounded epiphyses at each end. -->
  <g fill="url(#boneGrad)" stroke="#0a1426" stroke-width="1.6" stroke-linejoin="round">
    <!-- bone 1: bottom-left to top-right -->
    <g transform="translate(100 100) rotate(-32)">
      <path d="M -64 -6 Q -68 -10 -71 -8 Q -74 -6 -73 -2 Q -76 -2 -77 2 Q -77 7 -72 8 Q -71 12 -67 12 Q -64 12 -62 8 L 62 8 Q 64 12 67 12 Q 71 12 72 8 Q 77 7 77 2 Q 76 -2 73 -2 Q 74 -6 71 -8 Q 68 -10 64 -6 Q 60 -8 58 -6 L -58 -6 Q -60 -8 -64 -6 Z"/>
    </g>
    <!-- bone 2: top-left to bottom-right -->
    <g transform="translate(100 100) rotate(32)">
      <path d="M -64 -6 Q -68 -10 -71 -8 Q -74 -6 -73 -2 Q -76 -2 -77 2 Q -77 7 -72 8 Q -71 12 -67 12 Q -64 12 -62 8 L 62 8 Q 64 12 67 12 Q 71 12 72 8 Q 77 7 77 2 Q 76 -2 73 -2 Q 74 -6 71 -8 Q 68 -10 64 -6 Q 60 -8 58 -6 L -58 -6 Q -60 -8 -64 -6 Z"/>
    </g>
  </g>

  <!-- Skull. Cranium tapering into a temple hollow, cheekbone (zygomatic arch),
       and a separate jaw block showing teeth. -->
  <g stroke="#0a1426" stroke-width="2" stroke-linejoin="round" stroke-linecap="round">
    <!-- Cranium + face mass -->
    <path fill="url(#skullGrad)"
          d="M 100 38
             C 76 38 60 54 60 80
             C 60 96 65 108 72 116
             C 74 122 76 128 76 134
             L 84 134
             L 86 142
             L 114 142
             L 116 134
             L 124 134
             C 124 128 126 122 128 116
             C 135 108 140 96 140 80
             C 140 54 124 38 100 38 Z"/>

    <!-- Brow ridge — a soft shadow across the top of the eyes -->
    <path fill="#0a1426" opacity="0.25"
          d="M 70 78 C 80 72 92 72 96 76 L 104 76 C 108 72 120 72 130 78 L 128 84 C 118 80 108 82 102 86 L 98 86 C 92 82 82 80 72 84 Z"/>

    <!-- Eye sockets -->
    <ellipse cx="83" cy="90" rx="11" ry="12" fill="#050e1f"/>
    <ellipse cx="117" cy="90" rx="11" ry="12" fill="#050e1f"/>
    <!-- Catchlights — give the skull a hint of life -->
    <circle cx="79" cy="86" r="2.4" fill="#62e0ff"/>
    <circle cx="113" cy="86" r="2.4" fill="#62e0ff"/>

    <!-- Nasal cavity: inverted heart -->
    <path fill="#050e1f"
          d="M 100 100
             C 96 106 93 112 95 118
             C 97 122 100 122 100 120
             C 100 122 103 122 105 118
             C 107 112 104 106 100 100 Z"/>

    <!-- Cheek hollows — subtle indication, not aggressive -->
    <path fill="#0a1426" opacity="0.15"
          d="M 72 108 Q 78 116 84 118 L 84 122 Q 76 120 70 114 Z"/>
    <path fill="#0a1426" opacity="0.15"
          d="M 128 108 Q 122 116 116 118 L 116 122 Q 124 120 130 114 Z"/>

    <!-- Jaw / teeth block -->
    <rect x="84" y="128" width="32" height="14" rx="2" fill="url(#skullGrad)"/>
    <!-- Tooth gaps -->
    <line x1="91" y1="130" x2="91" y2="140" stroke="#0a1426" stroke-width="1.5"/>
    <line x1="98" y1="130" x2="98" y2="140" stroke="#0a1426" stroke-width="1.5"/>
    <line x1="105" y1="130" x2="105" y2="140" stroke="#0a1426" stroke-width="1.5"/>
    <line x1="112" y1="130" x2="112" y2="140" stroke="#0a1426" stroke-width="1.5"/>
  </g>
</svg>`;
}

async function render(svg, size, file) {
  await sharp(Buffer.from(svg)).resize(size, size).png().toFile(path.join(OUT, file));
  console.log('  wrote', file, size + 'x' + size);
}

(async () => {
  const sq = iconSvg({ rounded: false });
  const rd = iconSvg({ rounded: true });

  // iOS clips home-screen icons to a rounded square itself — supply a square
  // canvas. Android / PWA mask icons want the full square too; the OS adds the
  // shape. We ship square; rounded variant is kept for the maskable fallback.
  await render(sq, 180, 'icon-180.png');     // Apple touch icon
  await render(sq, 192, 'icon-192.png');     // PWA standard
  await render(sq, 512, 'icon-512.png');     // PWA large
  await render(rd, 192, 'icon-maskable-192.png');
  await render(rd, 512, 'icon-maskable-512.png');
  await render(sq, 32,  'favicon-32.png');

  // Also drop the stand-alone SVG for modern browsers that prefer it.
  fs.writeFileSync(path.join(OUT, 'icon.svg'), sq);
  console.log('  wrote icon.svg');
})();
