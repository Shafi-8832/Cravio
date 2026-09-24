import { useState } from 'react'

// Words shown next to the stars. A number on its own ("3") tells the
// customer nothing; "Okay" tells them what they are about to say.
const RATING_LABELS = {
  1: 'Terrible',
  2: 'Poor',
  3: 'Okay',
  4: 'Good',
  5: 'Excellent'
}

// An interactive star picker — the counterpart of StarRating, which only
// displays a score.
//
// Why real <button> elements instead of a <select>: a dropdown makes the
// customer open a menu and read five lines of text to say something they
// could say with one tap. Buttons also keep the control usable from the
// keyboard, which a div full of spans would not be.
//
// role="radiogroup" + role="radio" tells a screen reader this is one choice
// out of five, not five unrelated buttons.
const StarInput = ({ value, onChange, label = 'Rating', disabled = false }) => {
  // What the pointer/focus is currently over. While that is set we preview
  // it, so the stars fill as the cursor moves across them; otherwise we show
  // the rating actually chosen.
  const [preview, setPreview] = useState(0)

  const shown = preview || value

  return (
    <div>
      <p className="field-label mb-1">{label}</p>

      <div
        className="flex items-center gap-1"
        role="radiogroup"
        aria-label={label}
        onMouseLeave={() => setPreview(0)}
      >
        {[1, 2, 3, 4, 5].map((star) => (
          <button
            key={star}
            type="button"
            role="radio"
            aria-checked={value === star}
            aria-label={`${star} ${star === 1 ? 'star' : 'stars'}`}
            disabled={disabled}
            onClick={() => onChange(star)}
            onMouseEnter={() => setPreview(star)}
            onFocus={() => setPreview(star)}
            onBlur={() => setPreview(0)}
            className={
              'text-3xl leading-none transition-transform hover:scale-125 focus-visible:outline focus-visible:outline-2 focus-visible:outline-orange-600 rounded ' +
              (star <= shown ? 'text-yellow-400' : 'text-stone-300')
            }
          >
            ★
          </button>
        ))}

        <span className="text-sm muted ml-2">
          {value ? RATING_LABELS[value] : 'Tap a star'}
        </span>
      </div>
    </div>
  )
}

export default StarInput
