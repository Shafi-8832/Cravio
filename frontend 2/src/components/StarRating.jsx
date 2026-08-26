const StarRating = ({ rating }) => {
  return (
    <div className="flex items-center gap-1">
      {/* Array of 5 elements, each becomes a star */}
      {[1, 2, 3, 4, 5].map((star) => (
        <span
          key={star}
          className={
            star <= Math.round(rating)
              ? 'text-yellow-400'   // filled star
              : 'text-gray-300'     // empty star
          }
        >
          ★
        </span>
      ))}
      <span className="text-sm text-gray-500 ml-1">
        {rating > 0 ? Number(rating).toFixed(1) : 'New'}
      </span>
    </div>
  )
}

export default StarRating