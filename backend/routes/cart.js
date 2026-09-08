const express = require('express')
const pool = require('../db/pool')
const authenticateToken = require('../middleware/auth')
const requireRole = require('../middleware/roleCheck')
const { parseId } = require('../utils/validation')

const router = express.Router()



// ============================================================
// GET /api/cart/:restaurantId
// customer only
// Returns logged-in user's cart for a specific restaurant
// ============================================================

router.get(
  '/:restaurantId',
  authenticateToken,
  requireRole('customer'),
  async (req, res) => {

    const restaurantId = parseId(req.params.restaurantId)
    const userId = req.user.id

    if (restaurantId === null) {
      return res.status(400).json({
        error: 'Invalid restaurant ID.'
      })
    }

    /*  INNER JOIN ব্যবহার করলে
    এখন বোঝা যাবে না:
    Cart আছে, কিন্তু empty?
    নাকি cart-ই নেই?
    দুই ক্ষেত্রেই result [] হবে।
    তবে প্রথম join LEFT JOIN রেখে দ্বিতীয়টি INNER JOIN করলে empty cart-এর NULL row আবার বাদ পড়ে যাবে। 
    তাই empty cart information preserve করতে দ্বিতীয়টিও LEFT JOIN করা হয়েছে।
    carts <--- cart_items -----> menu_items [relationships] */
    

    try {

      /* আগের single LEFT JOIN query-তে "cart আছে কিন্তু empty" অবস্থায় সব
       * column NULL সহ একটা row ফেরত যেত, যেটা frontend render করতে গিয়ে
       * ভেঙে যায়। এখন cart-টা আলাদা করে খোঁজা হয় এবং সেই তথ্য cart_exists
       * field-এ স্পষ্টভাবে পাঠানো হয় — information থাকছে, ভুয়া NULL row নেই।
       *
       * carts <--- cart_items <--- cart_item_modifiers [relationships] */

      const cartResult = await pool.query(`
        SELECT id
        FROM carts
        WHERE user_id = $1
          AND restaurant_id = $2
      `, [
        userId,
        restaurantId
      ])


      if (cartResult.rows.length === 0) {
        return res.json({
          cart_exists: false,
          cart: [],
          subtotal: '0.00'
        })
      }


      const cartId = cartResult.rows[0].id


      const linesResult = await pool.query(`
        SELECT
          ci.id AS cart_item_id,

          mi.id AS menu_item_id,
          mi.name,
          mi.description,
          mi.price,
          mi.image_url,
          mi.is_available,

          ci.quantity

        FROM cart_items ci

        JOIN menu_items mi
          ON mi.id = ci.menu_item_id

        WHERE ci.cart_id = $1

        ORDER BY ci.id
      `, [cartId])


      // Every line's modifiers in one query rather than one query per line.
      const cartItemIds = linesResult.rows.map(row => row.cart_item_id)

      const modifiersResult = cartItemIds.length === 0
        ? { rows: [] }
        : await pool.query(`
            SELECT
              cim.cart_item_id,
              mo.id AS modifier_option_id,
              mo.name,
              mo.price_modifier,
              mo.is_available,
              mg.name AS group_name

            FROM cart_item_modifiers cim

            JOIN modifier_options mo
              ON mo.id = cim.modifier_option_id

            JOIN modifier_groups mg
              ON mg.id = mo.modifier_group_id

            WHERE cim.cart_item_id = ANY($1::int[])

            ORDER BY cim.cart_item_id, mo.id
          `, [cartItemIds])


      const modifiersByCartItem = new Map()

      for (const row of modifiersResult.rows) {
        if (!modifiersByCartItem.has(row.cart_item_id)) {
          modifiersByCartItem.set(row.cart_item_id, [])
        }

        modifiersByCartItem.get(row.cart_item_id).push({
          modifier_option_id: row.modifier_option_id,
          name: row.name,
          group_name: row.group_name,
          price_modifier: row.price_modifier,
          is_available: row.is_available
        })
      }


      /* Money is computed in JS here, but place_order() recomputes all of it
       * in SQL at checkout. These numbers are for display only — nothing the
       * client sends is ever trusted as the price of anything. DECIMAL columns
       * arrive from pg as strings, hence the Number() conversions. */
      const cart = linesResult.rows.map(row => {
        const modifiers = modifiersByCartItem.get(row.cart_item_id) || []

        const modifierTotal = modifiers.reduce(
          (sum, modifier) => sum + Number(modifier.price_modifier),
          0
        )

        const unitPrice = Number(row.price) + modifierTotal

        return {
          ...row,
          modifiers,
          // Base price plus the chosen modifiers, for one unit.
          unit_price: unitPrice.toFixed(2),
          line_total: (unitPrice * row.quantity).toFixed(2)
        }
      })


      const subtotal = cart.reduce(
        (sum, line) => sum + Number(line.line_total),
        0
      )


      res.json({
        cart_exists: true,
        cart,
        subtotal: subtotal.toFixed(2)
      })


    } catch(error){

      console.error(
        'Get cart error:',
        error
      )


      res.status(500).json({
        error:'Server error fetching cart.'
      })

    }

  }
)


// ============================================================
// POST /api/cart/:restaurantId/items
// customer only
// Adds item to cart
// ============================================================

router.post(
  '/:restaurantId/items',
  authenticateToken,
  requireRole('customer'),
  async (req,res)=>{

    const restaurantId = Number(req.params.restaurantId)

    const userId = req.user.id


    const menuItemId = Number(req.body.menu_item_id)
    const quantity = Number(req.body.quantity)



    if (!Number.isInteger(restaurantId) || restaurantId <= 0) {

      return res.status(400).json({
        error: 'Invalid restaurant ID.'
      })

    }


    if (!Number.isInteger(menuItemId) || menuItemId <= 0) {

      return res.status(400).json({
        error: 'Invalid menu item ID.'
      })

    }


    if (!Number.isInteger(quantity) || quantity <= 0) {

      return res.status(400).json({
        error: 'Quantity must be a positive integer.'
      })

    }


    // ---------------------------------------------------------
    // Chosen modifiers ("extra cheese", "large"). Optional — an item with
    // no modifier groups is added exactly as before.
    //
    // Sorted and de-duplicated up front, because the set is later compared
    // against existing cart lines to decide "is this the same thing the
    // customer already added?", and [2,1] must match [1,2].
    // ---------------------------------------------------------
    const rawModifierIds = req.body.modifier_option_ids

    if (
      rawModifierIds !== undefined &&
      rawModifierIds !== null &&
      !Array.isArray(rawModifierIds)
    ) {
      return res.status(400).json({
        error: 'modifier_option_ids must be an array.'
      })
    }

    const modifierOptionIds = Array.from(
      new Set((rawModifierIds || []).map(Number))
    ).sort((a, b) => a - b)

    if (modifierOptionIds.some(id => !Number.isInteger(id) || id <= 0)) {
      return res.status(400).json({
        error: 'modifier_option_ids must contain positive integers.'
      })
    }


    const client = await pool.connect()


    try {


      await client.query('BEGIN')


      // =====================================================
      // Validate that the item belongs to this restaurant
      // and can currently be ordered
      // =====================================================

      const menuItemResult = await client.query(`
        SELECT
          id,
          restaurant_id,
          is_available
        FROM menu_items
        WHERE id = $1
      `, [menuItemId])


      if (menuItemResult.rows.length === 0) {
        await client.query('ROLLBACK')

        return res.status(404).json({
          error: 'Menu item not found.'
        })
      }


      const menuItem = menuItemResult.rows[0]


      if (menuItem.restaurant_id !== restaurantId) {
        await client.query('ROLLBACK')

        return res.status(400).json({
          error: 'Menu item does not belong to this restaurant.',
          code: 'ITEM_RESTAURANT_MISMATCH'
        })
      }


      if (!menuItem.is_available) {
        await client.query('ROLLBACK')

        return res.status(409).json({
          error: 'Menu item is currently unavailable.',
          code: 'MENU_ITEM_UNAVAILABLE'
        })
      }


      // =====================================================
      // Validate the chosen modifiers against this item's groups
      //
      // Every group belonging to this menu item is loaded, along with the
      // subset of the customer's chosen options that fall inside it. That
      // makes all four checks below answerable from one result set:
      //   - does every chosen option actually belong to this dish?
      //   - is every chosen option still available?
      //   - does each group get at least min_selection choices?
      //   - does each group get at most max_selection choices?
      // =====================================================

      const groupsResult = await client.query(`
        SELECT
          mg.id,
          mg.name,
          mg.is_required,
          mg.min_selection,
          mg.max_selection,

          -- The chosen options that live in this group.
          COALESCE(
            ARRAY_AGG(mo.id) FILTER (WHERE mo.id = ANY($2::int[])),
            ARRAY[]::int[]
          ) AS chosen_option_ids,

          -- Of those, the ones the kitchen has turned off.
          COALESCE(
            ARRAY_AGG(mo.name) FILTER (
              WHERE mo.id = ANY($2::int[]) AND mo.is_available = false
            ),
            ARRAY[]::varchar[]
          ) AS unavailable_option_names

        FROM modifier_groups mg

        LEFT JOIN modifier_options mo
          ON mo.modifier_group_id = mg.id

        WHERE mg.menu_item_id = $1

        GROUP BY mg.id
        ORDER BY mg.id
      `, [menuItemId, modifierOptionIds])


      // Anything the customer picked that did not land in one of this item's
      // groups is an option belonging to some other dish.
      const validOptionIds = new Set(
        groupsResult.rows.flatMap(group => group.chosen_option_ids)
      )

      const foreignOptionIds = modifierOptionIds.filter(
        id => !validOptionIds.has(id)
      )

      if (foreignOptionIds.length > 0) {
        await client.query('ROLLBACK')

        return res.status(400).json({
          error: 'One or more modifiers do not belong to this menu item.',
          code: 'MODIFIER_ITEM_MISMATCH',
          invalid_option_ids: foreignOptionIds
        })
      }


      for (const group of groupsResult.rows) {
        if (group.unavailable_option_names.length > 0) {
          await client.query('ROLLBACK')

          return res.status(409).json({
            error: `Currently unavailable: ${group.unavailable_option_names.join(', ')}.`,
            code: 'MODIFIER_OPTION_UNAVAILABLE'
          })
        }

        const chosenCount = group.chosen_option_ids.length

        // min_selection only binds when the group is required. An optional
        // group left entirely untouched is fine; partially answering one is
        // not, which is why the check is skipped at zero rather than always.
        const minimumApplies = group.is_required || chosenCount > 0

        if (minimumApplies && chosenCount < group.min_selection) {
          await client.query('ROLLBACK')

          return res.status(400).json({
            error: `"${group.name}" needs at least ${group.min_selection} selection(s).`,
            code: 'MODIFIER_MIN_NOT_MET',
            group: group.name
          })
        }

        if (chosenCount > group.max_selection) {
          await client.query('ROLLBACK')

          return res.status(400).json({
            error: `"${group.name}" allows at most ${group.max_selection} selection(s).`,
            code: 'MODIFIER_MAX_EXCEEDED',
            group: group.name
          })
        }
      }



      // =====================================================
      // Check whether user already has a cart
      // =====================================================
    
      /* (user_id, restaurant_id) functionally determines ---> carts(id) (PK) */

      const cartResult = await client.query(`
        SELECT id
        FROM carts

        WHERE user_id = $1
        AND restaurant_id = $2

      `,[
        userId,
        restaurantId
      ])



      let cartId



      // =====================================================
      // Create cart if it does not exist
      // =====================================================

      if(cartResult.rows.length === 0){


        const newCart = await client.query(`

          INSERT INTO carts
          (
            user_id,
            restaurant_id
          )

          VALUES
          ($1,$2)


          RETURNING id

        `,[
          userId,
          restaurantId
        ])

        cartId = newCart.rows[0].id // guaranteed to return 1 row by business rule

      }
      else{

        cartId = cartResult.rows[0].id // too

      }


      // =====================================================
      // Insert item
      // If item already exists:
      // increase quantity instead of duplicate row *** 
      // =====================================================

      // EXCLUDED সেই নতুন row-টিকে বোঝায় যেটি PostgreSQL insert করতে চেয়েছিল, কিন্তু conflict হওয়ার কারণে insert করতে পারেনি।
      // The ON CONFLICT(cart_id, menu_item_id) upsert that used to live here
      // stopped working once modifiers existed: a cart line is the dish PLUS
      // its chosen options, so "Margherita + extra cheese" and "Margherita,
      // plain" are two different things to cook and must be two rows. The
      // UNIQUE constraint that ON CONFLICT relied on was therefore dropped
      // (see db/migrations/001_modifiers.sql).
      //
      // Merging still happens — but only into a line whose modifier set is
      // *exactly* the same. The subquery rebuilds each candidate line's option
      // ids as a sorted array and compares it against the incoming sorted
      // array, so set equality is decided in SQL rather than by pulling every
      // line back and diffing it in JS.
      const matchingLine = await client.query(`

        SELECT ci.id

        FROM cart_items ci

        WHERE ci.cart_id = $1
          AND ci.menu_item_id = $2
          AND COALESCE(
                (
                  SELECT ARRAY_AGG(cim.modifier_option_id ORDER BY cim.modifier_option_id)
                  FROM cart_item_modifiers cim
                  WHERE cim.cart_item_id = ci.id
                ),
                ARRAY[]::int[]
              ) = $3::int[]

        -- Without the lock, two concurrent adds of the same configuration
        -- would both miss this lookup and insert duplicate lines.
        FOR UPDATE

      `,[
        cartId,
        menuItemId,
        modifierOptionIds
      ])


      if (matchingLine.rows.length > 0) {

        await client.query(`
          UPDATE cart_items
          SET quantity = quantity + $1
          WHERE id = $2
        `,[
          quantity,
          matchingLine.rows[0].id
        ])

      } else {

        const newLine = await client.query(`

          INSERT INTO cart_items
          (
            cart_id,
            menu_item_id,
            quantity
          )

          VALUES
          ($1,$2,$3)

          RETURNING id

        `,[
          cartId,
          menuItemId,
          quantity
        ])


        if (modifierOptionIds.length > 0) {
          // UNNEST turns the array into rows, so the whole selection goes in
          // as one INSERT instead of a loop of round trips.
          await client.query(`
            INSERT INTO cart_item_modifiers
              (cart_item_id, modifier_option_id)
            SELECT $1, option_id
            FROM UNNEST($2::int[]) AS option_id
          `,[
            newLine.rows[0].id,
            modifierOptionIds
          ])
        }

      }


      await client.query('COMMIT')



      res.status(201).json({

        message:'Item added to cart successfully.'

      })



    } catch(error){


      await client.query('ROLLBACK')


      console.error(
        'Add cart item error:',
        error
      )


      res.status(500).json({

        error:'Server error adding item to cart.'

      })


    } finally {


      client.release()

    }

  }
)






// ============================================================
// PATCH /api/cart/items/:itemId
// customer only
// Updates quantity
// ============================================================



router.patch(
  '/items/:itemId',
  authenticateToken,
  requireRole('customer'),
  async (req, res) => {
    const itemId = Number(req.params.itemId)
    const { quantity } = req.body

    if (!Number.isInteger(itemId) || itemId <= 0) {
      return res.status(400).json({
        error: 'Invalid cart item ID.'
      })
    }

    if (!Number.isInteger(quantity) || quantity <= 0) {
      return res.status(400).json({
        error: 'Quantity must be a positive integer.'
      })
    }

    try {
      const result = await pool.query(
        `
          UPDATE cart_items ci

          SET quantity = $1

          FROM carts c

          WHERE ci.id = $2
            AND ci.cart_id = c.id
            AND c.user_id = $3

          RETURNING ci.*
        `,
        [
          quantity, // $1: সরাসরি যে quantity set হবে
          itemId,
          req.user.id
        ]
      )
      /* itemId-এর কোনো cart item নেই।
        Item আছে, কিন্তু cart অন্য user-এর। */
      if (result.rows.length === 0) {
        return res.status(404).json({
          error: 'Cart item not found.'
        })
      }

      return res.json({
        item: result.rows[0],
        message: 'Quantity updated.'
      })
    } catch (error) {
      console.error(
        'Set cart item quantity error:',
        error
      )

      return res.status(500).json({
        error: 'Server error updating cart.'
      })
    }
  }
)

// ============================================================
// PATCH /api/cart/items/:itemId/adjust
// customer only
// atomic increase/decrease and confirmation of deletion if quantity hits 0
// ============================================================

router.patch(
  '/items/:itemId/adjust',
  authenticateToken,
  requireRole('customer'),
  async (req, res) => {
    const itemId = Number(req.params.itemId)
    const { change } = req.body

    if (!Number.isInteger(itemId) || itemId <= 0) {
      return res.status(400).json({
        error: 'Invalid cart item ID.'
      })
    }

    if (change !== 1 && change !== -1) {
      return res.status(400).json({
        error: 'Change must be either 1 or -1.'
      })
    }

    const client = await pool.connect()

    try {
      await client.query('BEGIN')

      /*
       * FOR UPDATE locks this cart-item row until the transaction ends.
       * Therefore, simultaneous +/- requests cannot overwrite each other.
       */
      const itemResult = await client.query(
        `
          SELECT
            ci.id,
            ci.quantity

          FROM cart_items ci

          JOIN carts c
            ON ci.cart_id = c.id

          WHERE ci.id = $1
            AND c.user_id = $2

          FOR UPDATE OF ci
        `,
        [
          itemId,
          req.user.id
        ]
      )

      if (itemResult.rows.length === 0) {
        await client.query('ROLLBACK')

        return res.status(404).json({ // returns here, so the codes down below is guaranteed to be authenticated
          error: 'Cart item not found.'
        })
      }

      const currentQuantity =
        itemResult.rows[0].quantity

      const newQuantity =
        currentQuantity + change

      /*
       * Do not allow quantity to become zero.
       * Tell the frontend to request confirmation.
       */
      if (newQuantity === 0) {
        await client.query('ROLLBACK')

        return res.status(409).json({
          code: 'REMOVE_CONFIRMATION_REQUIRED',
          currentQuantity,
          message:
            "Do you want to remove this item from your cart? Quantity can't be 0."
        })
      }

      const updateResult = await client.query(
        `
          UPDATE cart_items

          SET quantity = quantity + $1

          WHERE id = $2

          RETURNING *
        `,
        [
          change,
          itemId
        ]
      )

      await client.query('COMMIT')

      return res.json({
        item: updateResult.rows[0],
        message:
          change === 1
            ? 'Quantity increased.'
            : 'Quantity decreased.'
      })
    } catch (error) {
      await client.query('ROLLBACK')

      console.error(
        'Adjust cart item quantity error:',
        error
      )

      return res.status(500).json({
        error: 'Server error adjusting cart quantity.'
      })
    } finally {
      client.release()
    }
  }
)

// ============================================================
// DELETE /api/cart/items/:itemId
// customer only
// Removes item from user's cart
// ============================================================

// shift option A = comment
// cmd + crtl + shift + right arrow = function select

router.delete(
  '/items/:itemId',
  authenticateToken,
  requireRole('customer'),
  async(req,res)=>{


    const itemId = parseId(req.params.itemId)

    if (itemId === null) {
      return res.status(400).json({
        error: 'Invalid cart item ID.'
      })
    }


    /* the condition AND ci.cart_id = c.id is important
    * suppose the user with req.user.id doesn't even have that item in their cart
    * so we must check 2 things
    * 1. the user is authenticated
    * 2. the user actually has that cart!
    * an authenticated hacker might want to delete someone else's cart
     */
    try{
      const result = await pool.query(`

        DELETE FROM cart_items ci
        USING carts c
        WHERE ci.id=$1
        AND ci.cart_id=c.id

        AND c.user_id=$2


        RETURNING ci.id

      `,[
        itemId,
        req.user.id
      ])

      if(result.rows.length===0){

        return res.status(404).json({

          error:'Cart item not found.'

        })

      }

      res.json({

        message:'Item removed from cart.'

      })

    }catch(error){


      console.error(
        'Delete cart item error:',
        error
      )


      res.status(500).json({

        error:'Server error deleting item.'

      })

    }


  }
)



module.exports = router