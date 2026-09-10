# Restaurant catalog and photographs

## What is actually included

The snapshot researched on **9 September 2026** contains **139 physical branch listings from four brands**, across all eight Bangladesh divisions. It does **not** contain all restaurants, and it does **not** reach 60 restaurants in every city/area. Counts refer to branches, not distinct chains.

| Division | Branches in snapshot | Branches in division-capital city |
|---|---:|---:|
| Dhaka | 107 | 91 |
| Chattogram | 11 | 6 |
| Rajshahi | 7 | 3 |
| Khulna | 5 | 3 |
| Barishal | 2 | 2 |
| Sylhet | 2 | 2 |
| Rangpur | 2 | 1 |
| Mymensingh | 3 | 3 |
| **Total** | **139** | **111** |

“Area” was treated as the eight division-capital cities for the optional live search; the static catalog also includes other cities where these brands publish branches. No branch was invented to fill a regional quota.

## Primary sources

| Catalog file | Branches | Source and treatment |
|---|---:|---|
| `backend/data/official-kacchi-bhai.json` | 47 | [Kacchi Bhai](https://www.kacchibhai.com/) and each linked `/branch/...` page. Exact address blocks; branch gallery images where supplied; four unambiguous single-person items from the published brand menu. The official homepage lists inconsistent tehari prices, so those were omitted. |
| `backend/data/official-kfc.json` | 47 | [KFC Bangladesh store locator](https://kfcbd.com/store-locator) and linked [official menu](https://kfcbd.com/menu/chicken). Coordinates and business telephone numbers come from the locator. Menu is explicitly a national brand preview, not a quote for every branch. |
| `backend/data/official-bfc.json` | 22 | [BFC's official website](https://bfcbd.com/) links to its [Engaze menu](https://bfc.engaze.ai/). Each published delivery branch's page provides its menu. |
| `backend/data/official-chillox.json` | 23 | [Chillox's branded ordering site](https://chillox.engaze.ai/) lists its delivery branches and their individual menus. |

Each entry retains its own `source_url`, `menu_source_url`, `verified_at`, photo credits and image-source links. The timestamp means the source was checked, not that the business was independently inspected, is currently open, or agreed to partner with Cravio.

BFC/Chillox publish area names and coordinates in these pages without a full street-address field. Their directory addresses explicitly say **area-level listing; street address not supplied by this source**. Missing addresses and phone numbers were not guessed. KFC/Kacchi source details can themselves become outdated: recheck with the business before onboarding.

The import produces **5,363 menu rows across branches**; many are repeated items at different branches, not 5,363 distinct dishes. BFC/Chillox entries use the lowest published variant price and describe that variant when supplied. Customizations, discounts and tax inclusions from external checkout are not replicated. All real restaurant Add buttons stay disabled until onboarding and current menu verification.

## Photos, logos and attribution

- **304 distinct official assets** are included locally: brand logos, published food photographs and branch gallery images. The original bytes are retained in `backend/data/images/` (about 104 MB).
- `backend/data/official-photo-sources.json` maps every local filename to its original URL, page, brand, asset type and rights note.
- The restaurant page shows brand logos, source links, official image credits and gallery captions. Where a branch has no verified storefront picture, its cover uses a published food picture or logo, not an unrelated restaurant interior.
- Published promotional photos are not a promise that the delivered plate will look identical. KFC itself identifies its menu imagery as illustrative of the product; these are genuine **brand-published images**, not photos of a particular delivered order.
- Public accessibility is not an open reuse license. Copyright and trademarks remain with their owners. Obtain appropriate merchant/media permission for commercial distribution; keep attribution. No claim of permission or affiliation is encoded by this seed.
- **Eight additional local Unsplash photos** illustrate only the fictional demo dishes and homepage. Their original sources/credits are in `backend/data/photo-sources.json`; demo cards and menus identify them as illustrative.
- Google Places contributor photos are shown only in live search, with their supplied attributions. They are not downloaded into the seeded assets or assigned to named menu dishes.

`restaurant-directory.examples.json` remains an older five-branch example for explaining the importer. Do not import it alongside the full official catalogs: it uses a different grouped catalog identity and would duplicate KFC branch presentation. `seed:real` imports only the four official catalogs.

## Expanding beyond this snapshot

There is no bundled complete, owner-approved Bangladesh restaurant feed. To reach 60+ **actual businesses in each specified area**, use a permitted live provider and/or collect verified owner submissions. Coverage depends on the area and provider; no search API guarantees a complete census.

The optional adapter uses [Google Places Text Search (New)](https://developers.google.com/maps/documentation/places/web-service/text-search). A search returns up to 20 results per page, with pagination when Google supplies a next-page token. Use narrower neighborhoods, brand names or food categories to explore further; duplicates are removed within the displayed search. This adapter intentionally does not bulk export Google results to PostgreSQL.

### Enable Google Places

1. In your Google Cloud project, enable **Places API (New)** and the required billing setup.
2. Create a restricted API key for the server: restrict API access to Places API (New) and use server egress restrictions appropriate to deployment. Configure Google Cloud quota limits and billing alerts before public exposure.
3. Put the key only in `backend/.env`:

   ```dotenv
   ENABLE_GOOGLE_PLACES=true
   GOOGLE_PLACES_API_KEY=YOUR_SERVER_SIDE_KEY
   ```

4. Restart the API and visit `/directory`. Pick a division-capital city, optionally enter a neighborhood and food/brand name, and search.
5. The backend makes the billable search requests; photos load lazily through signed, short-lived resource tokens. Per-process IP request limits are provided. These limits are **not** a global spending cap and reset when the server restarts; enforce quotas with Google and a shared gateway for production.

No API key was supplied for this implementation, so live calls to Google have **not** been tested. Request shaping, pagination signatures, malformed-token handling, key isolation, source attribution, photo URL validation and disabled-mode behavior were tested with deterministic fixtures.

Google's [Places policies](https://developers.google.com/maps/documentation/places/web-service/policies) restrict caching/storage and require Google Maps/provider attribution. The adapter sends `Cache-Control: no-store`, uses transient browser state, and does not persist results or photo names. The page displays Google Maps attribution and links to its terms and privacy policy. Add your actual operator's public terms/privacy notice before launching. Follow [Place Photos requirements](https://developers.google.com/maps/documentation/places/web-service/place-photos), including contributor attribution and expiring photo resources.

Google does not provide a reliably labeled restaurant menu, current item prices, or authentic restaurant logos through this search response. Obtain those from the merchant/official menu; do not label arbitrary contributor photos as particular dishes.

## Map work prepared for later

Restaurant branches and saved delivery addresses support nullable latitude/longitude pairs. Official-source coordinates are supplied where available, never invented for the demo. Google results expose their source coordinates. A future map/order integration still needs address geocoding, accurate service zones, distance/routing, rider location consent and updates, merchant branch selection and dispatch rules. Merely sorting by straight-line distance does not establish that a restaurant can deliver to an address.

## Rebuilding a reviewed source snapshot

`scripts/build-official-catalog.py` is the extraction script used for this snapshot. It expects the temporary downloaded HTML research files under `/tmp/cravio-*`; those files are not packaged because raw third-party pages can contain irrelevant session/runtime data. The four reviewed JSON files and whitelisted photo manifest are the shipped artifacts. To refresh later, re-download the official pages, inspect any schema/content changes, rebuild and validate the resulting catalogs. Imports deliberately preserve existing prices; plan explicit reviewed updates for existing records.
