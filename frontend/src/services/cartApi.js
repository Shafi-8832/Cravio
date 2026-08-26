import api from '../utils/api'


export const getCart = (restaurantId) => {
    return api.get(`/api/cart/${restaurantId}`)
}


export const addCartItem = (restaurantId, menu_item_id, quantity = 1) => {
    return api.post(
        `/api/cart/${restaurantId}/items`,
        {
            menu_item_id,
            quantity
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