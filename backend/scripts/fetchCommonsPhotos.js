// ============================================================
// FETCH FREELY-LICENSED FOOD PHOTOGRAPHY FROM WIKIMEDIA COMMONS
//   node scripts/fetchCommonsPhotos.js            (download what is missing)
//   node scripts/fetchCommonsPhotos.js --force    (re-download everything)
//
// The four sourced brands ship with their own published photographs. The
// restaurants added on top of them do not, and a food app with no food in
// it is not worth demonstrating.
//
// Wikimedia Commons is used rather than a general image search because
// every file there carries a licence and a named author in its metadata,
// which this script records into data/commons-photo-sources.json. A photo
// whose licence we cannot state is a photo we should not ship.
//
// These are stock photographs of the DISH, not of the restaurant's own
// cooking, so everything downloaded here is flagged image_is_illustrative
// wherever it is used and the menu prints "Illustrative photo" beneath it.
// ============================================================

const fs = require('node:fs')
const path = require('node:path')

const IMAGE_DIRECTORY = path.join(__dirname, '../data/images')
const SOURCES_FILE = path.join(__dirname, '../data/commons-photo-sources.json')
const API = 'https://commons.wikimedia.org/w/api.php'

// Each entry is [local filename, Commons search term]. The search term is
// deliberately specific: "kacchi biryani" returns the dish, "biryani"
// returns book covers and restaurant signage.
const WANTED = [
  ['dish-kacchi-biryani.jpg', 'Basmati Kacchi Biryani'],
  ['dish-chicken-biryani.jpg', 'Chicken Hyderabadi Biryani'],
  ['dish-beef-tehari.jpg', 'Tehari Bangladeshi food'],
  ['dish-morog-polao.jpg', 'Morog Polao'],
  ['dish-borhani.jpg', 'Borhani drink'],
  ['dish-firni.jpg', 'Firni dessert'],
  ['dish-jali-kabab.jpg', 'Shami kebab'],
  ['dish-chicken-roast.jpg', 'Roast chicken plate'],
  ['dish-butter-chicken.jpg', 'Butter chicken'],
  ['dish-naan.jpg', 'Naan bread'],
  ['dish-seekh-kebab.jpg', 'Seekh kebab'],
  ['dish-lassi.jpg', 'Mango lassi'],
  ['dish-margherita.jpg', 'Pizza Margherita'],
  ['dish-pepperoni.jpg', 'Pepperoni pizza'],
  ['dish-garlic-bread.jpg', 'Garlic bread'],
  ['dish-chicken-wings.jpg', 'Buffalo wings'],
  ['dish-fried-chicken.jpg', 'Fried-Chicken-Set'],
  ['dish-chicken-bucket.jpg', 'Fried chicken bucket'],
  ['dish-burger.jpg', 'Cheeseburger'],
  ['dish-chicken-burger.jpg', 'Chicken sandwich burger'],
  ['dish-fries.jpg', 'French fries'],
  ['dish-nuggets.jpg', 'Chicken nuggets'],
  ['dish-wrap.jpg', 'Chicken wrap food'],
  ['dish-coleslaw.jpg', 'Coleslaw'],
  ['dish-milkshake.jpg', 'Milkshake'],
  ['dish-soft-drink.jpg', 'Cola glass'],
  ['dish-brownie.jpg', 'Chocolate brownie'],
  ['dish-salad.jpg', 'Garden salad'],
  ['logo-dominos.png', "Domino's pizza logo"]
]

const pause = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds))

// Commons answers 429 if you ask quickly. Back off and retry rather than
// abandoning a half-finished download set.
const request = async parameters => {
  const url = API + '?' + new URLSearchParams({ format: 'json', ...parameters })
  for (let attempt = 1; attempt <= 4; attempt++) {
    const response = await fetch(url, { headers: { 'User-Agent': 'Cravio-coursework/1.0' } })
    if (response.ok) return response.json()
    if (response.status !== 429) throw new Error(`Commons replied ${response.status}`)
    await pause(attempt * 4000)
  }
  throw new Error('Commons kept rate limiting; re-run to resume.')
}

// Commons returns HTML in the artist field ("<a href=...>Name</a>").
const stripMarkup = value => String(value || '').replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim()

async function findPhoto(term) {
  const data = await request({
    action: 'query',
    generator: 'search',
    gsrsearch: term,
    gsrnamespace: '6',
    gsrlimit: '5',
    prop: 'imageinfo',
    iiprop: 'url|extmetadata',
    iiurlwidth: '1000'
  })

  const pages = Object.values(data.query?.pages || {})
  // Sort by the search rank Commons gave back; the object key order is not it.
  pages.sort((a, b) => a.index - b.index)

  for (const page of pages) {
    const info = page.imageinfo?.[0]
    if (!info) continue
    const meta = info.extmetadata || {}
    return {
      title: page.title.replace(/^File:/, ''),
      download: info.thumburl || info.url,
      descriptionUrl: info.descriptionurl,
      credit: stripMarkup(meta.Artist?.value) || 'Wikimedia Commons contributor',
      licence: stripMarkup(meta.LicenseShortName?.value) || 'see source page'
    }
  }
  return null
}

async function main() {
  const force = process.argv.includes('--force')
  const sources = fs.existsSync(SOURCES_FILE) ? JSON.parse(fs.readFileSync(SOURCES_FILE, 'utf8')) : { photos: {} }
  let fetched = 0
  let skipped = 0

  for (const [filename, term] of WANTED) {
    const target = path.join(IMAGE_DIRECTORY, filename)
    if (!force && fs.existsSync(target) && sources.photos[filename]) { skipped++; continue }

    const photo = await findPhoto(term)
    if (!photo) { console.log(`  no Commons result for "${term}" (${filename})`); continue }

    const response = await fetch(photo.download, { headers: { 'User-Agent': 'Cravio-coursework/1.0' } })
    if (!response.ok) { console.log(`  download failed for ${filename}: ${response.status}`); continue }
    const bytes = Buffer.from(await response.arrayBuffer())
    if (bytes.length < 2000) { console.log(`  suspiciously small file for ${filename}, skipped`); continue }

    fs.writeFileSync(target, bytes)
    sources.photos[filename] = {
      image_url: '/media/' + filename,
      commons_file: photo.title,
      image_source_url: photo.descriptionUrl,
      image_credit: `${photo.credit} / Wikimedia Commons (${photo.licence}) · illustrative photo`,
      image_is_illustrative: true
    }
    fetched++
    await pause(1500)
    console.log(`  ${filename.padEnd(28)} ${(bytes.length / 1024).toFixed(0)}kB  ${photo.title.slice(0, 45)}`)
  }

  sources.notice = 'Stock photographs of each dish, not of any restaurant’s own cooking. Every entry is flagged illustrative and carries its Commons author and licence.'
  sources.downloaded_at = new Date().toISOString().slice(0, 10)
  fs.writeFileSync(SOURCES_FILE, JSON.stringify(sources, null, 2) + '\n')
  console.log(`\ndownloaded ${fetched}, already present ${skipped}`)
}

main().catch(error => { console.error(error.message); process.exitCode = 1 })
