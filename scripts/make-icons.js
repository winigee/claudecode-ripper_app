// Generates every BonesAI icon variant from the source artwork at
// build/skull-source.png and build/wordmark-source.png (the original
// Gemini-generated assets with real alpha channels). Run once per source
// change with `node scripts/make-icons.js`.

const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

const SRC_SKULL = path.resolve(__dirname, '..', 'build', 'skull-source.png');
const SRC_WORDMARK = path.resolve(__dirname, '..', 'build', 'wordmark-source.png');
const OUT_ICONS = path.resolve(__dirname, '..', 'src', 'renderer', 'icons');
const OUT_BUILD = path.resolve(__dirname, '..', 'build');
fs.mkdirSync(OUT_ICONS, { recursive: true });

const NAVY = '#0a1426';

// Trim transparent margins off a buffer/file so the subject fills the canvas
// when we re-frame it. Returns a sharp pipeline already trimmed.
function trimmed(src) {
  return sharp(src).trim({ threshold: 1 });
}

// Compose skull + wordmark into a single square lockup at the given size,
// on either a transparent canvas (mask=false) or a rounded-square dark navy
// canvas (mask=true). The wordmark sits below the skull with breathing room
// proportional to the canvas size.
async function compose({ size, mask = false, transparent = false }) {
  // Subject area: 84% of canvas, centred. Wordmark consumes the bottom 22%,
  // skull the top 62%, with the rest as padding.
  const subjectW = Math.round(size * 0.84);
  const skullH = Math.round(size * 0.58);
  const wordmarkH = Math.round(size * 0.16);
  const gap = Math.round(size * 0.04);
  // Render skull at width that fits in skullH (skull source is roughly 1.83:1)
  const skullBuf = await trimmed(SRC_SKULL)
    .resize({ width: subjectW, height: skullH, fit: 'inside' })
    .png()
    .toBuffer();
  const skullMeta = await sharp(skullBuf).metadata();
  // Render wordmark to fit in width
  const wordmarkBuf = await trimmed(SRC_WORDMARK)
    .resize({ width: Math.round(size * 0.72), height: wordmarkH, fit: 'inside' })
    .png()
    .toBuffer();
  const wordmarkMeta = await sharp(wordmarkBuf).metadata();

  const totalH = skullMeta.height + gap + wordmarkMeta.height;
  const topPad = Math.round((size - totalH) / 2);
  const skullX = Math.round((size - skullMeta.width) / 2);
  const wordmarkX = Math.round((size - wordmarkMeta.width) / 2);

  // Canvas
  const bgChannels = transparent ? 4 : 3;
  const bg = transparent
    ? { create: { width: size, height: size, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } }
    : { create: { width: size, height: size, channels: 3, background: NAVY } };
  let pipeline = sharp(bg).composite([
    { input: skullBuf, top: topPad, left: skullX },
    { input: wordmarkBuf, top: topPad + skullMeta.height + gap, left: wordmarkX },
  ]);
  if (mask) {
    // Rounded-rect mask for the maskable variants. iOS / macOS already
    // round the app icon, so most outputs don't need this — we keep maskable
    // PNGs around for the PWA manifest's purpose:"maskable" entries.
    const r = Math.round(size * 0.22);
    const maskSvg = Buffer.from(
      `<svg width="${size}" height="${size}"><rect width="${size}" height="${size}" rx="${r}" ry="${r}" fill="white"/></svg>`
    );
    pipeline = pipeline.png().toBuffer().then((buf) =>
      sharp(buf).composite([{ input: maskSvg, blend: 'dest-in' }])
    );
    pipeline = await pipeline;
  }
  return pipeline.png();
}

// Skull-only — for chat bubbles, About card, chat empty state. Transparent
// background; the agent bubble already has its own dark colour.
async function skullOnly(size) {
  return trimmed(SRC_SKULL)
    .resize({ width: size, height: size, fit: 'inside', background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png();
}

async function writeIcon(pipeline, file, label) {
  await pipeline.toFile(file);
  const stat = fs.statSync(file);
  console.log(`  ${label.padEnd(38)} ${file}  ${Math.round(stat.size / 1024)} KB`);
}

(async () => {
  console.log('Generating BonesAI icons from source artwork:');
  // App icons (skull + wordmark lockup on navy)
  await writeIcon(await compose({ size: 1024 }),        path.join(OUT_BUILD, 'icon.png'),                                  'macOS .icns base (1024)');
  await writeIcon(await compose({ size: 512 }),         path.join(OUT_ICONS, 'icon-512.png'),                              'PWA large (512)');
  await writeIcon(await compose({ size: 192 }),         path.join(OUT_ICONS, 'icon-192.png'),                              'PWA standard (192)');
  await writeIcon(await compose({ size: 180 }),         path.join(OUT_ICONS, 'icon-180.png'),                              'Apple touch icon (180)');
  await writeIcon(await compose({ size: 32 }),          path.join(OUT_ICONS, 'favicon-32.png'),                            'Favicon (32)');
  // Maskable variants — square navy canvas with rounded corners pre-applied.
  await writeIcon(await compose({ size: 512, mask: true }), path.join(OUT_ICONS, 'icon-maskable-512.png'),                 'PWA maskable (512)');
  await writeIcon(await compose({ size: 192, mask: true }), path.join(OUT_ICONS, 'icon-maskable-192.png'),                 'PWA maskable (192)');
  // Skull-only PNG for in-app use (chat bubbles, About card, empty state).
  // Wide aspect so the original glow halo isn't clipped.
  await writeIcon(
    await trimmed(SRC_SKULL).resize({ width: 512, fit: 'inside' }).png(),
    path.join(OUT_ICONS, 'skull.png'),
    'In-app skull (512w)'
  );
  // Tiny svg favicon points to the PNG via data: would be heavy, keep separate
  console.log('done.');
})();
