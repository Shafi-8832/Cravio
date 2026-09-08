import { useState } from 'react'

/*
 * Modal for choosing a dish's modifiers before it goes in the cart.
 *
 * Only shown for items that actually have modifier groups — an item with
 * none is added straight from the menu as before.
 *
 * The rules enforced here (required groups, min/max per group) are the same
 * ones the backend enforces in routes/cart.js. This copy exists to keep the
 * button disabled and explain why, not to be trusted: the server re-checks
 * everything, because anything the browser decides can be bypassed.
 */
const ModifierPicker = ({ item, onCancel, onConfirm }) => {

  // { [groupId]: number[] } — which option ids are ticked in each group
  const [selections, setSelections] = useState({})
  const [submitting, setSubmitting] = useState(false)

  const groups = item.modifier_groups || []

  const chosenIn = (groupId) => selections[groupId] || []

  const toggleOption = (group, optionId) => {
    const current = chosenIn(group.id)
    const alreadyPicked = current.includes(optionId)

    let next

    if (alreadyPicked) {
      next = current.filter(id => id !== optionId)
    } else if (group.max_selection === 1) {
      // Single-choice group (a radio button, in effect): picking a new option
      // replaces the old one rather than being rejected as "too many".
      next = [optionId]
    } else if (current.length >= group.max_selection) {
      return // at the cap — ignore the click
    } else {
      next = [...current, optionId]
    }

    setSelections({ ...selections, [group.id]: next })
  }

  // A group is unsatisfied when it is required and under its minimum, or when
  // it has been partially answered but is still under it. Mirrors the
  // minimumApplies logic on the server.
  const unsatisfiedGroups = groups.filter(group => {
    const count = chosenIn(group.id).length
    const minimumApplies = group.is_required || count > 0
    return minimumApplies && count < group.min_selection
  })

  const allOptionIds = Object.values(selections).flat()

  const modifierTotal = groups
    .flatMap(group => group.options)
    .filter(option => allOptionIds.includes(option.id))
    .reduce((sum, option) => sum + Number(option.price_modifier), 0)

  const unitPrice = Number(item.price) + modifierTotal

  const handleConfirm = async () => {
    setSubmitting(true)
    try {
      await onConfirm(allOptionIds)
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div
      className="fixed inset-0 bg-black/40 flex items-center justify-center
                 z-50 p-4"
      onClick={onCancel} // click the backdrop to dismiss
    >
      <div
        className="bg-white rounded-2xl shadow-lg w-full max-w-md
                   max-h-[85vh] flex flex-col"
        onClick={e => e.stopPropagation()} // clicks inside must not dismiss
      >

        <div className="p-5 border-b border-gray-100">
          <h3 className="text-lg font-bold text-gray-800">{item.name}</h3>
          <p className="text-sm text-gray-500 mt-1">
            ৳{Number(item.price).toFixed(2)} base
          </p>
        </div>

        <div className="p-5 overflow-y-auto flex-1 space-y-6">
          {groups.map(group => {
            const chosen = chosenIn(group.id)

            return (
              <div key={group.id}>
                <div className="flex items-baseline justify-between mb-2">
                  <p className="font-semibold text-gray-800">
                    {group.name}
                    {group.is_required && (
                      <span className="text-red-500 ml-1">*</span>
                    )}
                  </p>
                  <p className="text-xs text-gray-400">
                    {group.max_selection === 1
                      ? 'Choose 1'
                      : `Choose up to ${group.max_selection}`}
                  </p>
                </div>

                <div className="space-y-2">
                  {group.options.map(option => {
                    const picked = chosen.includes(option.id)
                    const atCap =
                      !picked &&
                      group.max_selection > 1 &&
                      chosen.length >= group.max_selection

                    const disabled = !option.is_available || atCap

                    return (
                      <button
                        key={option.id}
                        type="button"
                        onClick={() => toggleOption(group, option.id)}
                        disabled={disabled}
                        className={`w-full flex items-center justify-between
                                    px-3 py-2 rounded-lg border text-sm
                                    transition-colors text-left
                          ${picked
                            ? 'border-green-600 bg-green-50'
                            : 'border-gray-200 hover:border-gray-300'}
                          ${disabled
                            ? 'opacity-40 cursor-not-allowed hover:border-gray-200'
                            : ''}`}
                      >
                        <span className="flex items-center gap-2">
                          {/* round for single-choice, square for multi */}
                          <span
                            className={`inline-block w-3.5 h-3.5 border
                              ${group.max_selection === 1
                                ? 'rounded-full'
                                : 'rounded-sm'}
                              ${picked
                                ? 'bg-green-600 border-green-600'
                                : 'border-gray-300'}`}
                          />
                          <span className="text-gray-700">
                            {option.name}
                            {!option.is_available && ' (unavailable)'}
                          </span>
                        </span>

                        {Number(option.price_modifier) !== 0 && (
                          <span className="text-gray-500">
                            {Number(option.price_modifier) > 0 ? '+' : '−'}৳
                            {Math.abs(Number(option.price_modifier)).toFixed(2)}
                          </span>
                        )}
                      </button>
                    )
                  })}
                </div>
              </div>
            )
          })}
        </div>

        <div className="p-5 border-t border-gray-100">
          {unsatisfiedGroups.length > 0 && (
            <p className="text-xs text-red-500 mb-3">
              Please complete: {unsatisfiedGroups.map(g => g.name).join(', ')}
            </p>
          )}

          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={onCancel}
              className="px-4 py-2 rounded-lg border border-gray-200
                         text-gray-600 text-sm hover:bg-gray-50"
            >
              Cancel
            </button>

            <button
              type="button"
              onClick={handleConfirm}
              disabled={unsatisfiedGroups.length > 0 || submitting}
              className="flex-1 bg-green-700 text-white px-4 py-2 rounded-lg
                         text-sm font-semibold hover:bg-green-800
                         transition-colors disabled:opacity-40
                         disabled:cursor-not-allowed disabled:hover:bg-green-700"
            >
              {submitting
                ? 'Adding...'
                : `Add — ৳${unitPrice.toFixed(2)}`}
            </button>
          </div>
        </div>

      </div>
    </div>
  )
}

export default ModifierPicker
