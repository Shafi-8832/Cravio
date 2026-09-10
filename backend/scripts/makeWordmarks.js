// ============================================================
// GENERATE PLACEHOLDER WORDMARK LOGOS
//   node scripts/makeWordmarks.js
//
// Domino's logo is on Wikimedia Commons under a free licence, so it is
// downloaded by fetchCommonsPhotos.js. The Bangladeshi chains' logos are
// not: they are ordinary copyrighted brand art with no licence that lets
// us redistribute them in a handed-in project.
//
// Rather than scrape them anyway, this draws a plain wordmark from the
// restaurant's own name. It is obviously not the real logo, which is the
// honest outcome — a fake that looked authentic would be worse than one
// that plainly is not.
//
// Rendering uses macOS Quick Look (`qlmanage`), so this script only runs
// on a Mac. The generated PNGs are committed, so nobody else needs to run
// it; it exists to document how they were produced.
// ============================================================

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { execFileSync } = require('node:child_process')

const IMAGE_DIRECTORY = path.join(__dirname, '../data/images')

const WORDMARKS = [
  { file: 'logo-sultans-dine.png', lines: ['SULTAN’S', 'DINE'], background: '#7b1113', ink: '#f6d67b', rule: '#f6d67b' },
  { file: 'logo-khanas.png', lines: ['KHANA’S'], background: '#b5451b', ink: '#fdf1e0', rule: '#f2b880' },
  { file: 'logo-takeout.png', lines: ['TAKEOUT'], background: '#0f766e', ink: '#ecfdf5', rule: '#5eead4' },
  { file: 'logo-fry-bucket.png', lines: ['FRY', 'BUCKET'], background: '#c2410c', ink: '#fff7ed', rule: '#fdba74' },
]

// One square badge: a coloured field, the name in the middle, and a thin
// rule underneath so a one-word mark does not look unfinished.
function svgFor({ lines, background, ink, rule }) {
  const size = 512
  const fontSize = lines.length > 1 ? 96 : 84
  const startY = size / 2 - ((lines.length - 1) * fontSize) / 2 + fontSize / 3

  const text = lines
    .map((line, index) =>
      `<text x="${size / 2}" y="${startY + index * fontSize}" font-family="Helvetica,Arial,sans-serif" ` +
      `font-size="${fontSize}" font-weight="bold" fill="${ink}" text-anchor="middle" ` +
      `letter-spacing="2">${line}</text>`)
    .join('')

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
  <rect width="${size}" height="${size}" rx="72" fill="${background}"/>
  <rect x="56" y="56" width="${size - 112}" height="${size - 112}" rx="40" fill="none" stroke="${rule}" stroke-width="4" opacity="0.55"/>
  ${text}
  <rect x="${size / 2 - 70}" y="${startY + (lines.length - 1) * fontSize + 34}" width="140" height="6" rx="3" fill="${rule}"/>
</svg>`
}

function main() {
  if (os.platform() !== 'darwin') throw new Error('Needs macOS Quick Look. The generated PNGs are already committed.')

  for (const mark of WORDMARKS) {
    const svgPath = path.join(os.tmpdir(), mark.file.replace(/\.png$/, '.svg'))
    fs.writeFileSync(svgPath, svgFor(mark))

    // qlmanage always writes <input name>.png into the output directory.
    execFileSync('qlmanage', ['-t', '-s', '512', '-o', os.tmpdir(), svgPath], { stdio: 'ignore' })
    const rendered = svgPath + '.png'
    if (!fs.existsSync(rendered)) throw new Error('Quick Look produced nothing for ' + mark.file)

    fs.copyFileSync(rendered, path.join(IMAGE_DIRECTORY, mark.file))
    fs.rmSync(rendered, { force: true })
    fs.rmSync(svgPath, { force: true })
    console.log('  wrote', mark.file)
  }
}

main()
