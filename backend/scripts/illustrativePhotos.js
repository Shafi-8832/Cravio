// ============================================================
// ILLUSTRATIVE FALLBACK PHOTOGRAPHY
//
// Some dishes reach us with no photograph: a published source that never
// printed one, or an older seed written before menu photos existed. They
// would render as an empty-plate placeholder.
//
// This picks one of the eight generic Unsplash food photos already in
// data/images by matching the dish name, and carries that photo's real
// credit and licence link from data/photo-sources.json.
//
// Every photo returned here is flagged image_is_illustrative. That flag
// is not decoration: the menu renders "Illustrative photo" beneath any
// image carrying it, so a stock burger is never passed off as a
// particular restaurant's own photograph.
//
// A dish matching no keyword deliberately gets nothing back. "Extra
// Bun", "BBQ DIP" and "Delivery charge" are better shown as an honest
// placeholder than as a stock picture of something they are not.
// ============================================================

const path = require('node:path')

const PHOTOS = new Map(
  require('../data/photo-sources.json').photos.map(photo => [
    path.basename(photo.image_url),
    {
      image_url: photo.image_url,
      image_credit: photo.image_credit,
      image_source_url: photo.image_source_url,
      image_is_illustrative: true
    }
  ])
)

// Order matters. "Rice Bowl" and "Garlic Burger" both mention a chicken
// dish's worth of chicken, so the more specific shape is matched first
// and the catch-all fried-chicken rule is tried last.
//
// Every alternative starts with \b — a word boundary — so a keyword has
// to begin a word rather than merely appear inside one. Without it
// "Yard Classic" matches `lassi` (c-LASSI-c) and a burger is served with
// a photo of a drink. The boundary is only at the front, so plurals and
// suffixes still match: `\bdrink` catches "200ml Drinks", `\bwing`
// catches "Naga Wings".
const KEYWORDS = [
  [/\brice|\bbiryani|\bkacchi|\btehari|\bpolao|\bpulao|\bplatter|\bmeal|\bfirni|\bkhichuri/i, 'biryani.jpg'],
  [/\bburger|\bwrap|\bsandwich|\bbun/i, 'burger.jpg'],
  [/\bpizza|\bbread|\bgarlic/i, 'pizza.jpg'],
  [/\bnoodle|\bmomo|\bpasta|\bchow|\bramen/i, 'noodles.jpg'],
  [/\bsalad|\bveg|\bbowl|\btofu/i, 'salad.jpg'],
  [/\bjuice|\bdrink|\bcola|\bpepsi|\bcoffee|\btea|\blatte|\bshake|\bsmoothie|\bwater|\bbeverage|\bborhani|\blassi|\bsoda|\bdetox|\bboost/i, 'tea.jpg'],
  [/\bcurry|\bmasala|\broast|\bgravy|\bdal|\bbhuna|\bsoup|\bprawn|\bshrimp|\bfish|\bilish|\bkabab|\bkebab|\bchaap|\btikka/i, 'curry.jpg'],
  [/\bwing|\bpops|\blollipop|\bstrip|\bfry|\bfries|\bchicken|\bcombo|\bfeast|\bnugget|\bkebab/i, 'fries.jpg']
]

// The dish name is checked before its category, so "Mango Juice" filed
// under "SIDE MENU" still gets a drink photo rather than the category's.
function illustrativePhotoFor(itemName, categoryName = '') {
  for (const [pattern, file] of KEYWORDS) {
    if (pattern.test(itemName)) return PHOTOS.get(file)
  }
  for (const [pattern, file] of KEYWORDS) {
    if (categoryName && pattern.test(categoryName)) return PHOTOS.get(file)
  }
  return null
}

module.exports = { PHOTOS, illustrativePhotoFor }
