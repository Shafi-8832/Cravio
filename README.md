# Cravio 🇧🇩

Food delivery coursework project for CSE 216, using Express, PostgreSQL, React and Vite. Customer, restaurant owner, rider and administrator workflows share a real database and role/ownership checks.

**Start here: [numbered setup instructions](docs/SETUP.md).** The implementation is already in the project folder. You do not need to paste files back into this same checkout.

- [Review, completed features and remaining launch work](docs/REVIEW.md)
- [Restaurant coverage, photo credits and Google Places setup](docs/DATA_SOURCES.md)
- [Database and application walkthroughs](docs/FLOW.md)
- Generate complete copy/paste files and a source ZIP: `npm run package:handoff`

The catalogue contains **nine restaurants — Kacchi Bhai, KFC, BFC, Chillox, Sultan's Dine, Khana's, Domino's Pizza, Takeout and Fry Bucket — with 95 branches across all eight divisions and 237 menu items**, drawn from **304 local official photo/logo assets**. Each of the four sourced brands keeps three real Dhaka branches so the branch picker stays a real choice rather than a wall of 47 buttons, plus one outlet per remaining division; the full published outlet lists remain in `backend/data/official-*.json`. The five added restaurants are marked as sample data — real names, menus written by us. Menus, prices and photographs are snapshots of each brand's published sources, linked from the restaurant page. These brands are orderable so the checkout, delivery and review lifecycle can be demonstrated: that is a coursework decision, not a merchant relationship — no order reaches a real restaurant and no money moves. The optional eight-division demo catalog adds clearly labeled fictional restaurants.

The application supports a working local ordering lifecycle. Real payment gateways, refunds/payouts, merchant onboarding verification, notifications, and live rider tracking remain launch integrations; see the review before deployment.
