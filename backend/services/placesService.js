// Google Places content is returned live; it is never inserted in the catalog/database.
const jwt = require('jsonwebtoken')
const CITIES = {
  Dhaka: [23.8103,90.4125], Chattogram: [22.3569,91.7832], Rajshahi: [24.3745,88.6042],
  Khulna: [22.8456,89.5403], Barishal: [22.7010,90.3535], Sylhet: [24.8949,91.8687],
  Rangpur: [25.7439,89.2752], Mymensingh: [24.7471,90.4203],
}
const safeUrl = value => {
  try { const u = new URL(value?.startsWith('//') ? 'https:' + value : value); return u.protocol === 'https:' ? u.href : null } catch { return null }
}
const sign = payload => jwt.sign(payload, process.env.JWT_SECRET, { algorithm:'HS256', expiresIn:'10m', audience:'cravio-places' })
const read = token => jwt.verify(token, process.env.JWT_SECRET, { algorithms:['HS256'], audience:'cravio-places' })
const failure = (message, status = 400) => Object.assign(new Error(message), { status })
function requestBody(input) {
  const city = input.city || 'Dhaka'
  if (!Object.hasOwn(CITIES, city)) throw failure('Choose one of the eight division-capital cities.')
  const term = input.term || '', area = input.area || ''
  if ([term,area].some(v => typeof v !== 'string' || v.length > 80)) throw failure('Area and food searches must be text up to 80 characters.')
  const [lat,lng] = CITIES[city]
  // Search viewport, not an administrative boundary or a delivery radius.
  const body = { textQuery: `restaurants ${term} in ${area ? area + ', ' : ''}${city}, Bangladesh`,
    includedType:'restaurant', strictTypeFiltering:true, languageCode:'en', regionCode:'BD', pageSize:20,
    locationRestriction:{ rectangle:{ low:{ latitude:lat-0.16,longitude:lng-0.18 }, high:{ latitude:lat+0.16,longitude:lng+0.18 } } } }
  if (input.cursor) {
    let cursor
    try { cursor=read(input.cursor) } catch { throw failure('Search expired. Start a new search.') }
    if(cursor.kind !== 'page' || cursor.city !== city || cursor.term !== term || cursor.area !== area) throw failure('Search cursor does not match these filters.')
    body.pageToken=cursor.next
  }
  return { body, city, term, area }
}
async function googleRequest(path, init = {}, fetchImpl = fetch) {
  if (process.env.ENABLE_GOOGLE_PLACES !== 'true' || !process.env.GOOGLE_PLACES_API_KEY) throw failure('Live Google search is not configured. The official-source Cravio directory is still available.',503)
  const response = await fetchImpl('https://places.googleapis.com/v1/' + path, {
    ...init, headers:{'X-Goog-Api-Key':process.env.GOOGLE_PLACES_API_KEY, ...init.headers}, signal:AbortSignal.timeout(12000) })
  if (!response.ok) throw failure(response.status === 429 ? 'Google search quota reached. Please try later.' : 'Google search could not complete. Check the server API configuration.',502)
  return response.json()
}
async function search(input, fetchImpl) {
  const {body,city,term,area} = requestBody(input)
  const result = await googleRequest('places:searchText', {method:'POST',headers:{'Content-Type':'application/json',
    'X-Goog-FieldMask':'places.id,places.displayName,places.formattedAddress,places.location,places.photos,places.googleMapsUri,places.businessStatus,places.attributions,nextPageToken'},body:JSON.stringify(body)},fetchImpl)
  return { places:(result.places || []).map(p => {
    const photo = p.photos?.[0]
    return {place_id:p.id,name:p.displayName?.text,address:p.formattedAddress,location:p.location,
      google_maps_url:safeUrl(p.googleMapsUri), business_status:p.businessStatus,
      attributions:(p.attributions||[]).map(a=>({name:a.provider,url:safeUrl(a.providerUri)})),
      photo:photo ? {url:'/api/directory/photo?token='+encodeURIComponent(sign({kind:'photo',name:photo.name})),
        authors:(photo.authorAttributions||[]).map(a=>({name:a.displayName,url:safeUrl(a.uri)}))} : null }
  }), cursor:result.nextPageToken ? sign({kind:'page',city,term,area,next:result.nextPageToken}) : null }
}
async function photo(token, fetchImpl) {
  let record
  try { record=read(token) } catch { throw failure('Photo expired. Refresh the search.') }
  if (record.kind !== 'photo' || typeof record.name !== 'string' || !/^places\/[A-Za-z0-9_-]+\/photos\/[A-Za-z0-9_-]+$/.test(record.name)) throw failure('Invalid photo resource.')
  const result=await googleRequest(record.name+'/media?maxWidthPx=700&skipHttpRedirect=true',{},fetchImpl)
  const url=safeUrl(result.photoUri)
  if (!url || !new URL(url).hostname.endsWith('.googleusercontent.com')) throw failure('Photo is unavailable.',502)
  return url
}
module.exports = { search,photo,requestBody,CITIES }
