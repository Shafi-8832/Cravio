const express = require('express')
const pool = require('../db/pool')
const authenticateToken = require('../middleware/auth')
const requireRole = require('../middleware/roleCheck')

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

    const restaurantId = Number(req.params.restaurantId)
    const userId = req.user.id

    /*  INNER JOIN ব্যবহার করলে
    এখন বোঝা যাবে না:
    Cart আছে, কিন্তু empty?
    নাকি cart-ই নেই?
    দুই ক্ষেত্রেই result [] হবে।
    তবে প্রথম join LEFT JOIN রেখে দ্বিতীয়টি INNER JOIN করলে empty cart-এর NULL row আবার বাদ পড়ে যাবে। 
    তাই empty cart information preserve করতে দ্বিতীয়টিও LEFT JOIN করা হয়েছে।
    carts <--- cart_items -----> menu_items [relationships] */
    

    try {

      const result = await pool.query(`
        SELECT

          c.id AS cart_id,

          ci.id AS cart_item_id,

          mi.id AS menu_item_id,
          mi.name,
          mi.description,
          mi.price,
          mi.image_url,

          ci.quantity


        FROM carts c


        LEFT JOIN cart_items ci
          ON c.id = ci.cart_id


        LEFT JOIN menu_items mi
          ON ci.menu_item_id = mi.id


        WHERE c.user_id = $1
        AND c.restaurant_id = $2


        ORDER BY ci.id

      `, [
        userId,
        restaurantId
      ])


      res.json({
        cart: result.rows
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
      await client.query(`

        INSERT INTO cart_items
        (
          cart_id,
          menu_item_id,
          quantity
        )

        VALUES
        ($1,$2,$3)


        ON CONFLICT(cart_id,menu_item_id)

        DO UPDATE

        SET quantity =
        cart_items.quantity + EXCLUDED.quantity


      `,[
        cartId,
        menuItemId,
        quantity
      ])


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


    const {itemId}=req.params


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