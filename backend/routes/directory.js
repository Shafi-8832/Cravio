const router = require('express').Router()
const places = require('../services/placesService')
const rateLimit = require('../middleware/rateLimit')
router.use((req,res,next)=>{res.set('Cache-Control','no-store');next()})
router.get('/config',(req,res)=>res.json({enabled:process.env.ENABLE_GOOGLE_PLACES==='true' && !!process.env.GOOGLE_PLACES_API_KEY,cities:Object.keys(places.CITIES)}))
router.get('/search',rateLimit({limit:20}),async(req,res)=>{
  try { res.json(await places.search(req.query)) } catch(error) {res.status(error.status||502).json({error:error.status ? error.message : 'Search timed out. Please retry.'})}
})
router.get('/photo',rateLimit({limit:400}),async(req,res)=>{
  try {res.redirect(302,await places.photo(req.query.token))} catch(error) {res.status(error.status||502).json({error:error.status ? error.message : 'Photo unavailable.'})}
})
module.exports = router
