import api from '../utils/api'


export const getCart = (restaurantId) => {
    return api.get(`/api/cart/${restaurantId}`)
}


// modifier_option_ids carries the customer's chosen options ("Large",
// "Extra cheese"). Items with no modifier groups just send an empty array,
// which the backend treats exactly like the old no-modifiers request.
export const addCartItem = (
    restaurantId,
    menu_item_id,
    quantity = 1,
    modifier_option_ids = []
) => {
    return api.post(
        `/api/cart/${restaurantId}/items`,
        {
            menu_item_id,
            quantity,
            modifier_option_ids
        }
    )
}


export const adjustCartItem = (itemId, change) => {
    return api.patch(
        `/api/cart/items/${itemId}/adjust`,
        {
            change
        }
    )
}


export const setCartItemQuantity = (itemId, quantity) => {
    return api.patch(
        `/api/cart/items/${itemId}`,
        {
            quantity
        }
    )
}


export const deleteCartItem = (itemId) => {
    return api.delete(
        `/api/cart/items/${itemId}`
    )
}