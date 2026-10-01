// One place that turns an order row into words, so the customer, the owner
// and the rider are never describing the same order differently.
//
// Nothing here decides anything: every rule that matters (who may move an
// order, and when) is enforced in the backend and in the database. This file
// only renders what the server already said.

// The stages an order walks through, in order. 'cancelled' is not in the
// list because it is not a stage — it is an order leaving the list.
export const ORDER_STEPS = [
  'pending',
  'confirmed',
  'preparing',
  'food_ready',
  'out_for_delivery',
  'delivered'
]

// Short labels for the progress bar. 'food_ready' would otherwise render as
// "food ready", which reads like a question rather than a stage.
export const STEP_LABELS = {
  pending: 'Placed',
  confirmed: 'Accepted',
  preparing: 'Cooking',
  food_ready: 'Ready',
  out_for_delivery: 'On the way',
  delivered: 'Delivered'
}

// The three fixed reasons a restaurant can give, in plain language. The keys
// are the values stored in orders.rejected_reason.
export const REJECTION_TEXT = {
  item_unavailable: 'The restaurant had run out of something on your order.',
  kitchen_overloaded: 'The kitchen was too busy to take this order on time.',
  closing_soon: 'The restaurant was closing and could not cook this order.'
}

export const rejectionText = reason =>
  REJECTION_TEXT[reason] || 'The restaurant could not take this order.'

// The same three reasons as the owner picks them, phrased from the
// restaurant's side.
export const REJECTION_CHOICES = [
  { value: 'item_unavailable', label: 'Out of an item' },
  { value: 'kitchen_overloaded', label: 'Kitchen overloaded' },
  { value: 'closing_soon', label: 'Closing soon' }
]

// "8:21 PM" — the time the restaurant promised the food would be ready.
export const readyAtLabel = readyAt => readyAt
  ? new Date(readyAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
  : null

// Minutes and seconds left until readyAt, as "4:05", or null once the moment
// has passed. Seconds are shown because a prep window is minutes long, so a
// minutes-only countdown would sit on "1m" for a whole minute and look stuck.
//
// now is passed in rather than read here so a component can tick it from one
// interval and every countdown on the page stays in step.
export function readyCountdown(readyAt, now) {
  if (!readyAt) return null
  const msLeft = new Date(readyAt).getTime() - now
  if (msLeft <= 0) return null
  const totalSeconds = Math.floor(msLeft / 1000)
  return `${Math.floor(totalSeconds / 60)}:${String(totalSeconds % 60).padStart(2, '0')}`
}

// What the order is actually doing right now, for the customer's receipt.
// food_ready is split in two: whether a rider is already on it changes what
// the customer is waiting for, and the order row knows because the delivery
// appears once a rider has claimed it.
export function customerStage(order, now = Date.now()) {
  if (order.status === 'cancelled') {
    return {
      heading: 'Order cancelled',
      detail: order.rejected_reason
        ? rejectionText(order.rejected_reason)
        : 'This order was cancelled.'
    }
  }

  if (order.status === 'pending') {
    return {
      heading: 'Waiting for the restaurant to accept',
      detail: 'They will confirm shortly and tell us how long the food needs.'
    }
  }

  if (order.status === 'confirmed') {
    return {
      heading: 'Accepted — about to start cooking',
      detail: order.ready_at
        ? `Food should be ready around ${readyAtLabel(order.ready_at)}.`
        : null
    }
  }

  if (order.status === 'preparing') {
    const left = readyCountdown(order.ready_at, now)
    return {
      heading: 'Preparing your food',
      detail: left
        ? `Ready in ${left} — about ${readyAtLabel(order.ready_at)}.`
        : order.ready_at
          ? 'Taking a little longer than promised.'
          : null
    }
  }

  if (order.status === 'food_ready') {
    return {
      heading: 'Food is ready',
      detail: order.delivery
        ? 'Your rider is collecting it now.'
        : 'Waiting for a rider to collect it.'
    }
  }

  if (order.status === 'out_for_delivery') {
    return { heading: 'On the way to you', detail: 'Follow the rider on the map below.' }
  }

  return { heading: 'Delivered', detail: 'Enjoy your meal 😋' }
}
