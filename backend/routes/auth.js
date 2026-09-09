const express = require('express')
const bcrypt = require('bcryptjs')
const jwt = require('jsonwebtoken')
const crypto = require('crypto')

const pool = require('../db/pool')
const authenticateToken = require('../middleware/auth')

const router = express.Router()


// ============================================================
// SIGNUP
// POST /api/auth/signup
// ============================================================

router.post('/signup', async (req, res) => {

  const { name, email, password, role, phone } = req.body


  if (!name || !email || !password || !role || !phone) {
    return res.status(400).json({
      error: 'All fields are required.'
    })
  }


  const trimmedName = String(name).trim()
  const trimmedEmail = String(email).trim().toLowerCase()
  const trimmedPhone = String(phone).trim()


  if (!trimmedName || !trimmedEmail || !trimmedPhone) {
    return res.status(400).json({
      error: 'All fields are required.'
    })
  }


  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

  if (!emailRegex.test(trimmedEmail)) {
    return res.status(400).json({
      error: 'Please enter a valid email address.'
    })
  }


  if (typeof password !== 'string' || password.length < 8) {
    return res.status(400).json({
      error: 'Password must be at least 8 characters.'
    })
  }


  const allowedRoles = [
    'customer',
    'restaurant_owner',
    'rider'
  ]


  if (!allowedRoles.includes(role)) {
    return res.status(400).json({
      error: 'Invalid role.'
    })
  }


  const client = await pool.connect()


  try {

    await client.query('BEGIN')


    const existingUser = await client.query(
      'SELECT id FROM users WHERE email=$1',
      [trimmedEmail]
    )


    if (existingUser.rows.length > 0) {

      await client.query('ROLLBACK')

      return res.status(409).json({
        error:'Email already registered.'
      })

    }


    const hashedPassword = await bcrypt.hash(password,10)


    const result = await client.query(

      `
      INSERT INTO users
      (
        name,
        email,
        password,
        role,
        phone
      )

      VALUES
      ($1,$2,$3,$4,$5)

      RETURNING
      id,
      name,
      email,
      role
      `,

      [
        trimmedName,
        trimmedEmail,
        hashedPassword,
        role,
        trimmedPhone
      ]

    )


    const user = result.rows[0]


    if(role === 'rider'){

      await client.query(

        `
        INSERT INTO rider_profiles
        (
          user_id,
          vehicle_type,
          status
        )

        VALUES
        ($1,$2,$3)
        `,

        [
          user.id,
          null,
          'offline'
        ]

      )

    }


    await client.query('COMMIT')


    if(!process.env.JWT_SECRET){
      throw new Error("JWT_SECRET missing")
    }


    const jti = crypto.randomBytes(16).toString('hex')


    const token = jwt.sign(

      {
        id:user.id,
        email:user.email,
        role:user.role,
        jti
      },

      process.env.JWT_SECRET,

      {
        expiresIn:'7d'
      }

    )


    res.status(201).json({

      token,
      user

    })


  }

  catch(error){

    await client.query('ROLLBACK')

    console.error(
      "SIGNUP ERROR:",
      error
    )


    res.status(500).json({

      error:error.message

    })

  }

  finally{

    client.release()

  }


})





// ============================================================
// LOGIN
// POST /api/auth/login
// ============================================================


router.post('/login', async(req,res)=>{


  const {
    email,
    password
  } = req.body



  if(!email || !password){

    return res.status(400).json({

      error:"Email and password are required."

    })

  }



  const trimmedEmail =
    String(email)
    .trim()
    .toLowerCase()



  try{


    const result = await pool.query(

      'SELECT * FROM users WHERE email=$1',

      [
        trimmedEmail
      ]

    )



    if(result.rows.length===0){

      return res.status(401).json({

        error:"Invalid email or password."

      })

    }



    const user=result.rows[0]



    const validPassword =
      await bcrypt.compare(

        password,

        user.password

      )



    if(!validPassword){

      return res.status(401).json({

        error:"Invalid email or password."

      })

    }




    if(!user.is_active){

      return res.status(403).json({

        error:"Your account has been suspended."

      })

    }




    if(!process.env.JWT_SECRET){

      throw new Error(
        "JWT_SECRET missing in .env"
      )

    }



    const jti =
      crypto.randomBytes(16)
      .toString('hex')



    const token = jwt.sign(

      {

        id:user.id,
        email:user.email,
        role:user.role,
        jti

      },

      process.env.JWT_SECRET,

      {
        expiresIn:'7d'
      }

    )



    const {
      password:_,
      ...userWithoutPassword
    } = user



    res.json({

      token,

      user:userWithoutPassword

    })



  }

  catch(error){


    console.error(
      "LOGIN ERROR FULL:",
      error
    )



    res.status(500).json({

      error:error.message

    })


  }



})





// ============================================================
// LOGOUT
// POST /api/auth/logout
// ============================================================


router.post(
'/logout',
authenticateToken,
async(req,res)=>{


try{


await pool.query(

`

INSERT INTO revoked_tokens

(
jti,
user_id,
expires_at
)

VALUES

(
$1,
$2,
to_timestamp($3)
)

`,

[
// atik
req.user.jti,

req.user.id,

req.user.exp

]

)



await pool.query(

`

DELETE FROM revoked_tokens

WHERE expires_at < CURRENT_TIMESTAMP

`

)



res.json({

message:"Logged out successfully."

})



}

catch(error){


console.error(
"LOGOUT ERROR:",
error
)



res.status(500).json({

error:"Server error during logout."

})


}



})





module.exports = router
// const express = require('express')
// const bcrypt = require('bcryptjs') // pull out the downloaded password hashing rulebooks
// const jwt = require('jsonwebtoken') // pull out jwt rulebook
// const pool = require('../db/pool') // access the pool of db connections

// const crypto = require('crypto') // for generating unique token IDs (jti)
// const authenticateToken = require('../middleware/auth')

// const router = express.Router()

// // routes/auth.js is the only file that creates a JWT token


// // ============================================================
// // SIGNUP
// // POST /api/auth/signup
// // ============================================================
// router.post('/signup', async (req, res) => {
//   const { name, email, password, role, phone } = req.body

//   if (!name || !email || !password || !role || !phone) {
//     return res.status(400).json({
//       error: 'All fields are required.'
//     })
//   }

//   // Normalize before validating/storing so "Test@X.com" and "test@x.com"
//   // are treated as the same account, and so stray whitespace can't sneak in.
//   const trimmedName = String(name).trim()
//   const trimmedEmail = String(email).trim().toLowerCase()
//   const trimmedPhone = String(phone).trim()

//   if (!trimmedName || !trimmedEmail || !trimmedPhone) {
//     return res.status(400).json({
//       error: 'All fields are required.'
//     })
//   }

//   const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
//   if (!emailRegex.test(trimmedEmail)) {
//     return res.status(400).json({
//       error: 'Please enter a valid email address.'
//     })
//   }

//   if (typeof password !== 'string' || password.length < 8) {
//     return res.status(400).json({
//       error: 'Password must be at least 8 characters.'
//     })
//   }

//   const phoneRegex = /^[0-9+\-\s()]{7,20}$/
//   if (!phoneRegex.test(trimmedPhone)) {
//     return res.status(400).json({
//       error: 'Please enter a valid phone number.'
//     })
//   }

//   const allowedRoles = [
//     'customer',
//     'restaurant_owner',
//     'rider' // no admin cause admin's are created manually by the dev team, no auth/signup/admin route for security reasons
//   ]

//   if (!allowedRoles.includes(role)) {
//     return res.status(400).json({
//       error: 'Invalid role.'
//     })
//   }

//   const client = await pool.connect() // one dedicated connection to the db for this signup request
//   // We use a transaction to ensure that either both the user and rider profile are created, or neither is created.

//   // when we write BEGIN, the db creates a private workspace for this connection, 
//   // and all the queries we run after that are private to this connection until we either COMMIT or ROLLBACK.
//   // if another connection tries to write, then it will be blocked until we COMMIT or ROLLBACK.

//   // If we COMMIT, then all the changes we made in this private workspace are made public to all other connections.
//   // If we ROLLBACK, then all the changes we made in this private workspace are discarded, and the db goes back to the state it was in before we ran BEGIN.


//   try {
//     await client.query('BEGIN')

//     const existingUser = await client.query(
//       'SELECT id FROM users WHERE email = $1', // SQL injection prevention
//       [trimmedEmail]
//     )

//     if (existingUser.rows.length > 0) {
//       await client.query('ROLLBACK')

//       return res.status(409).json({
//         error: 'Email already registered.'
//       })
//     }

//     const hashedPassword = await bcrypt.hash(password, 10)

//     const result = await client.query( // parameterized query to prevent SQL injection
//       `
//         INSERT INTO users
//           (name, email, password, role, phone)
//         VALUES
//           ($1, $2, $3, $4, $5)
//         RETURNING
//           id,
//           name,
//           email,
//           role
//       `,
//       [
//         trimmedName,
//         trimmedEmail,
//         hashedPassword,
//         role,
//         trimmedPhone
//       ]
//     )

//     const user = result.rows[0]

//     if (role === 'rider') {
//       await client.query(
//         `
//           INSERT INTO rider_profiles
//             (user_id, vehicle_type, status)
//           VALUES
//             ($1, $2, $3)
//         `,
//         [
//           user.id,
//           null,
//           'offline'
//         ]
//       )
//     }

//     await client.query('COMMIT')

//     const jti = crypto.randomBytes(16).toString('hex') // generate a unique token ID for this session


//     const token = jwt.sign( // ***** F(header, payload, secret, options) = header.payload.signature
//       {
//         id: user.id,
//         email: user.email,
//         role: user.role,
//         jti // include the unique token ID in the payload
//       },
//       process.env.JWT_SECRET,
//       {expiresIn: '7d'}
//     )

//     res.status(201).json({ // **** is this accesible by other routes/files? or is this sent straight to frontend?
//       token,
//       user
//     })

//   } catch (error) {
//     await client.query('ROLLBACK')

//     console.error('Signup error:', error)

//     res.status(500).json({
//       error: 'Server error during signup.'
//     })

//   } finally {
//     client.release()
//   }
// })


// // ============================================================
// // LOGIN
// // POST /api/auth/login
// // ============================================================
// router.post('/login', async (req, res) => {
//   const { email, password } = req.body

//   if (!email || !password) {
//     return res.status(400).json({
//       error: 'Email and password are required.'
//     })
//   }

//   const trimmedEmail = String(email).trim().toLowerCase()

//   try {
//     const result = await pool.query(
//       'SELECT * FROM users WHERE email = $1',
//       [trimmedEmail]
//     )

//     if (result.rows.length === 0) {
//       return res.status(401).json({
//         error: 'Invalid email or password.' // never reveal whether the email or password is wrong, for security reasons
//       })
//     }

//     const user = result.rows[0]

//     const validPassword = await bcrypt.compare(
//       password,
//       user.password
//     )

//     if (!validPassword) {
//       return res.status(401).json({
//         error: 'Invalid email or password.' // never reveal whether the email or password is wrong, for security reasons
//       })
//     }

//     if (!user.is_active) {
//       return res.status(403).json({
//         error: 'Your account has been suspended. Contact support.'
//       })
//     }

//     const jti = crypto.randomBytes(16).toString('hex') // generate a unique token ID for this session

//     const token = jwt.sign(
//       {
//         id: user.id,
//         email: user.email,
//         role: user.role,
//         jti // include the unique token ID in the payload
//       },
//       process.env.JWT_SECRET,
//       {
//         expiresIn: '7d'
//       }
//     )

//     const { // never send the password back to the frontend, even if it's hashed
//       password: _,
//       ...userWithoutPassword
//     } = user

//     res.json({
//       token,
//       user: userWithoutPassword
//     })

//   } catch (error) {
//     console.error('Login error:', error)

//     res.status(500).json({
//       error: 'Server error during login.'
//     })
//   }
// })


// // ============================================================
// // LOGOUT
// // POST /api/auth/logout
// // ============================================================
// router.post('/logout', authenticateToken, async (req, res) => {
//   // Implementation for logout functionality
//   try {
//       await pool.query(
//         `
//         INSERT INTO revoked_tokens
//         (
//           jti,
//           user_id,
//           expires_at
//         )

//         VALUES
//         (
//           $1,
//           $2,
//           to_timestamp($3)
//         )
//         `,
//         [
//           req.user.jti,
//           req.user.id,
//           req.user.exp
//         ]
//       )

//     // Opportunistic cleanup. Every authenticated request joins against this
//     // table, so it must not grow without bound. A revoked token past its own
//     // expiry is already rejected by jwt.verify(), which makes the row
//     // redundant — dropping it here keeps the table roughly the size of the
//     // set of currently-valid revoked tokens, at the cost of one cheap DELETE
//     // on an action that happens far less often than reading.
//     await pool.query(
//       `DELETE FROM revoked_tokens WHERE expires_at < CURRENT_TIMESTAMP`
//     )

//     res.json({message : "Logged out successfully."})

//   } catch (error) {
//     console.error('Logout error:', error)

//     res.status(500).json({
//       error: 'Server error during logout.'
//     })
//   }

// })

// module.exports = router