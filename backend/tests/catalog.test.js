const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const {validateCatalog} = require('../scripts/importCatalog')
const places = require('../services/placesService')
process.env.JWT_SECRET='isolated-places-unit-test-secret'
process.env.ENABLE_GOOGLE_PLACES='true'
process.env.GOOGLE_PLACES_API_KEY='test-key-never-sent-to-google'
const catalogs=['kacchi-bhai','kfc','bfc','chillox'].map(brand=>require('../data/official-'+brand+'.json'))
test('139 sourced branches cover eight divisions without fake ordering or ratings',()=>{
  catalogs.forEach(validateCatalog)
  const restaurants=catalogs.flatMap(c=>c.restaurants)
  assert.equal(restaurants.length,139)
  assert.equal(new Set(restaurants.flatMap(r=>r.branches.map(b=>b.division))).size,8)
  assert.equal(new Set(restaurants.map(r=>r.catalog_slug)).size,139)
  for(const r of restaurants){assert.equal(r.ordering_enabled,false);assert.equal(r.is_demo,false);assert.ok(r.source_url.startsWith('https://'));assert.equal(r.avg_rating,undefined);assert.equal(r.review_count,undefined)}
})
test('every catalog logo, gallery and menu photo has a local file and original source',()=>{
  for(const {restaurants} of catalogs) for(const r of restaurants){
    assert.ok(fs.statSync(path.join(__dirname,'../data/images',r.logo_url.replace('/media/',''))).size>100)
    for(const record of [r,...r.gallery,...r.categories.flatMap(c=>c.items)]) if(record.image_url){
      assert.ok(record.image_source_url.startsWith('https://'))
      assert.ok(fs.statSync(path.join(__dirname,'../data/images',record.image_url.replace('/media/',''))).size>100)
    }
  }
})
test('live ordering cannot be imported without a photo, an owner or verification',()=>{
  // A flagged illustrative hero is permitted — the page discloses it — but
  // these three requirements still stand.
  const noPhoto=structuredClone(catalogs[0]);Object.assign(noPhoto.restaurants[0],{ordering_enabled:true,owner_email:'owner@example.com',owner_verified:true});delete noPhoto.restaurants[0].image_url
  assert.throws(()=>validateCatalog(noPhoto),/a restaurant photo/)

  const unverified=structuredClone(catalogs[0]);Object.assign(unverified.restaurants[0],{ordering_enabled:true,owner_email:'owner@example.com',owner_verified:false})
  assert.throws(()=>validateCatalog(unverified),/owner_verified/)

  const noOwner=structuredClone(catalogs[0]);Object.assign(noOwner.restaurants[0],{ordering_enabled:true})
  assert.throws(()=>validateCatalog(noOwner),/existing restaurant owner/)
})
test('search validates city and creates a bounded restaurant query',()=>{
  assert.throws(()=>places.requestBody({city:'London'}),/eight/)
  assert.throws(()=>places.requestBody({term:['bad']}),/text/)
  const {body}=places.requestBody({city:'Sylhet',area:'Zindabazar',term:'kacchi'})
  assert.equal(body.pageSize,20);assert.equal(body.strictTypeFiltering,true);assert.match(body.textQuery,/Sylhet, Bangladesh/);assert.ok(body.locationRestriction.rectangle)
})
test('search keeps credentials on the server and preserves photo/provider attribution',async()=>{
  let observed
  const result=await places.search({city:'Dhaka'},async(url,options)=>{
    observed={url,options}
    return {ok:true,json:async()=>({places:[{id:'fixture',displayName:{text:'Fixture Restaurant'},formattedAddress:'Dhaka',googleMapsUri:'https://maps.google.com/?cid=1',photos:[{name:'places/fixture/photos/photo123',authorAttributions:[{displayName:'Photo author',uri:'//maps.google.com/contrib/123'}]}],attributions:[{provider:'Provider',providerUri:'https://example.org/'}]}],nextPageToken:'opaque'})}
  })
  assert.equal(observed.options.headers['X-Goog-Api-Key'],process.env.GOOGLE_PLACES_API_KEY)
  assert.ok(!JSON.stringify(result).includes(process.env.GOOGLE_PLACES_API_KEY))
  assert.equal(result.places[0].photo.authors[0].name,'Photo author')
  assert.equal(result.places[0].attributions[0].name,'Provider')
  assert.equal(places.requestBody({city:'Dhaka',cursor:result.cursor}).body.pageToken,'opaque')
  assert.throws(()=>places.requestBody({city:'Sylhet',cursor:result.cursor}),/does not match/)
  const token=new URL(result.places[0].photo.url,'https://local.test').searchParams.get('token')
  const photo=await places.photo(token,async()=>({ok:true,json:async()=>({photoUri:'https://lh3.googleusercontent.com/example'})}))
  assert.equal(photo,'https://lh3.googleusercontent.com/example')
  await assert.rejects(()=>places.photo(token,async()=>({ok:true,json:async()=>({photoUri:'https://evil.example/image'})})),/unavailable/)
})
test('tampered photo tokens and unconfigured live requests fail clearly',async()=>{
  await assert.rejects(()=>places.photo('tampered'),/expired/)
  process.env.ENABLE_GOOGLE_PLACES='false'
  await assert.rejects(()=>places.search({city:'Dhaka'}),/not configured/)
  process.env.ENABLE_GOOGLE_PLACES='true'
})
