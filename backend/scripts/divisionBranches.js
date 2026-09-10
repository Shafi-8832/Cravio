// ============================================================
// STANDARD BRANCH GEOGRAPHY
//
// Every restaurant on Cravio should be orderable from anywhere in the
// country, so each one gets an outlet in all eight divisions. Dhaka gets
// several, because that is where most of the testing happens and a single
// city-wide branch makes the branch picker pointless.
//
// These are ordinary city-centre areas, not surveyed addresses. They exist
// so checkout has a real branch row with a delivery fee to charge; they do
// not claim that a given brand actually trades at that spot.
// ============================================================

// One entry per division: the division, its capital, and the areas we
// place outlets in. Dhaka lists four; everywhere else lists one.
const DIVISION_AREAS = [
  { division: 'Dhaka', city: 'Dhaka', areas: ['Khilgaon', 'Dhanmondi', 'Uttara', 'Mirpur'] },
  { division: 'Chattogram', city: 'Chattogram', areas: ['Agrabad'] },
  { division: 'Rajshahi', city: 'Rajshahi', areas: ['Shaheb Bazar'] },
  { division: 'Khulna', city: 'Khulna', areas: ['Sonadanga'] },
  { division: 'Barishal', city: 'Barishal', areas: ['Sadar Road'] },
  { division: 'Sylhet', city: 'Sylhet', areas: ['Zindabazar'] },
  { division: 'Rangpur', city: 'Rangpur', areas: ['Jahaj Company More'] },
  { division: 'Mymensingh', city: 'Mymensingh', areas: ['Ganginar Par'] },
]

// The address is what importCatalog.js matches on to decide whether a
// branch already exists, so it has to be stable and unique per restaurant.
// Including the brand name keeps two restaurants in the same area from
// colliding, and keeps re-imports idempotent.
const addressFor = (brandName, area, city) => `${brandName}, ${area}, ${city}`

// `only` limits how many Dhaka areas are used, so a brand that already has
// real Dhaka outlets does not end up with eight of them.
function standardBranches(brandName, { dhakaAreas = 4 } = {}) {
  const branches = []

  for (const entry of DIVISION_AREAS) {
    const areas = entry.division === 'Dhaka' ? entry.areas.slice(0, dhakaAreas) : entry.areas
    for (const area of areas) {
      branches.push({
        address: addressFor(brandName, area, entry.city),
        area,
        city: entry.city,
        division: entry.division,
        is_open: true,
      })
    }
  }

  return branches
}

module.exports = { DIVISION_AREAS, addressFor, standardBranches }
