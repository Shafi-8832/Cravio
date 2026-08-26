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

    const addItem = async(menuItem,id)=>{


        await addCartItem(
            id,
            menuItem.id,
            1
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



    const cartTotal =
    items.reduce(
        (sum,item)=>
        sum + Number(item.price)*item.quantity,
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