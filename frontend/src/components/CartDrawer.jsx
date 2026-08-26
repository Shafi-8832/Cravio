import { useCart } from '../context/CartContext'

// isOpen: whether the drawer is visible; onClose: fn to call to hide it
const CartDrawer = ({ isOpen, onClose }) => {
  // pull everything we need straight from the cart context
  const {
    restaurant,
    items,
    increaseItem,
    decreaseItem,
    removeItem,
    cartTotal
  } = useCart()

  if (!isOpen) return null // render nothing at all when closed — keeps things simple

  return (
    <>
      {/* dark backdrop behind the drawer — clicking it closes the drawer */}
      <div
        onClick={onClose}
        className="fixed inset-0 bg-black/40 z-40"
      />

      {/* the actual sliding panel, pinned to the right edge of the screen */}
      <div className="fixed top-0 right-0 h-full w-full sm:w-96 bg-white z-50
                       shadow-xl flex flex-col">

        {/* header row: title + close button */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-gray-100">
          <h2 className="text-lg font-bold text-gray-800">{restaurant?.name || "Your Cart"}</h2>
          <button
            onClick={onClose}
            className="text-gray-400 hover:text-gray-600 text-2xl leading-none"
          >
            &times; {/* an "x" close icon */}
          </button>
        </div>

        {/* scrollable list of cart items */}
        <div className="flex-1 overflow-y-auto px-5 py-4">
          {items.length === 0 ? (
            // empty cart state
            <div className="text-center py-16">
              <p className="text-4xl mb-3">🛒</p>
              <p className="text-gray-400">Your cart is empty.</p>
            </div>
          ) : (
            <>
              {/* which restaurant this cart belongs to (all items share one) */}
              {/* deleted */}

              {/* one row per cart line item */}
              {items.map(item => (
                <div
                  key={item.id} // React needs a unique key per list item
                  className="flex items-center justify-between py-3 border-b border-gray-50"
                >
                  <div className="flex-1 pr-3">
                    <p className="font-medium text-gray-800 text-sm">{item.name}</p>
                    <p className="text-gray-400 text-xs">
                      ৳{Number(item.price).toFixed(2)} each {/* unit price */}
                    </p>
                  </div>

                  {/* quantity stepper: minus / count / plus */}
                  <div className="flex items-center gap-2">
                    <button
                      onClick={() => decreaseItem(item.cart_item_id)} // -1, removes item at 0
                      className="w-7 h-7 rounded-full border border-gray-200
                                 text-gray-600 hover:bg-gray-50"
                    >
                      -
                    </button>
                    <span className="w-5 text-center text-sm">{item.quantity}</span>
                    <button
                      // re-use addItem to bump quantity by 1;
                      // needs the same restaurantId/name it was added with
                      onClick={() =>
                      increaseItem(item.cart_item_id)
                      }
                      className="w-7 h-7 rounded-full border border-gray-200
                                 text-gray-600 hover:bg-gray-50"
                    >
                      +
                    </button>
                  </div>

                  {/* remove this line entirely, regardless of quantity */}
                  <button
                    onClick={() => removeItem(item.cart_item_id)}
                    className="ml-3 text-gray-300 hover:text-red-500 text-sm"
                  >
                    ✕
                  </button>
                </div>
              ))}

              {/* clear-cart link, only useful once there's something to clear */}

            </>
          )}
        </div>

        {/* footer: total + checkout button, only shown when cart has items */}
        {items.length > 0 && (
          <div className="border-t border-gray-100 px-5 py-4">
            <div className="flex items-center justify-between mb-3">
              <span className="text-gray-500">Subtotal</span>
              <span className="font-bold text-gray-800">
                ৳{cartTotal.toFixed(2)} {/* running total from context */}
              </span>
            </div>
            <button
              // checkout page / place_order() call comes in Day 8-9 —
              // for now this is a placeholder so the UI isn't a dead end
              onClick={() => alert('Checkout will be wired up in the next milestone (Day 8-9).')}
              className="w-full bg-green-700 text-white py-3 rounded-lg
                         font-semibold hover:bg-green-800 transition-colors"
            >
              Checkout
            </button>
          </div>
        )}
      </div>
    </>
  )
}

export default CartDrawer // export so Navbar.jsx can import and render it