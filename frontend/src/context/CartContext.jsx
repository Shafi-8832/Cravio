import { createContext, useContext, useState } from 'react'
import {
    getCart,
    addCartItem,
    adjustCartItem,
    deleteCartItem
} from '../services/cartApi'


const CartContext = createContext(null)



export const CartProvider = ({children}) => {


const [items,setItems] = useState([])

const [restaurant,setRestaurant] = useState(null)



    // load cart from database

    const fetchCart = async(id, restaurantInfo = null)=>{

        const response = await getCart(id)

        setItems(response.data.cart)

        if(restaurantInfo){
            setRestaurant(restaurantInfo)
        }

    }



    // add new item

    // modifierOptionIds defaults to [] so callers that don't deal with
    // modifiers (or items that have none) keep working unchanged.
    //
    // Errors are deliberately NOT swallowed here: the backend rejects an add
    // that misses a required modifier group, and the page needs to see that
    // so it can tell the customer instead of failing silently.
    const addItem = async(menuItem,id,modifierOptionIds = [])=>{


        await addCartItem(
            id,
            menuItem.id,
            1,
            modifierOptionIds
        )


        await fetchCart(id)

    }





    // + button

    const increaseItem = async(itemId)=>{


        await adjustCartItem(
            itemId,
            1
        )


        await fetchCart(restaurant.id)

    }





    // - button

    const decreaseItem = async(itemId)=>{


        try{

            await adjustCartItem(
                itemId,
                -1
            )


            await fetchCart(restaurant.id)


        }
        catch(error){


            if(
                error.response?.data?.code ===
                'REMOVE_CONFIRMATION_REQUIRED'
            ){

                const confirmDelete =
                window.confirm(
                    error.response.data.message
                )


                if(confirmDelete){

                    await removeItem(itemId)

                }

            }

        }

    }





    const removeItem = async(itemId)=>{


        await deleteCartItem(itemId)


        await fetchCart(restaurant.id)

    }





const itemCount =
    items.reduce(
        (sum,item)=>
            sum + item.quantity,
        0
    )



    // line_total comes from the backend and already includes the chosen
    // modifiers. Multiplying item.price by quantity here would ignore them and
    // under-report the total against what checkout actually charges.
    const cartTotal =
    items.reduce(
        (sum,item)=>
        sum + Number(item.line_total ?? Number(item.price)*item.quantity),
        0
    )



    return (

        <CartContext.Provider

        value={{
            restaurant,
            
            items,

            fetchCart,

            addItem,

            increaseItem,

            decreaseItem,

            removeItem,

            itemCount,

            cartTotal

        }}

        >

        {children}

        </CartContext.Provider>

    )

}



export const useCart = () =>
useContext(CartContext)