import { useState } from 'react'
import { API_URL } from '../utils/api'

// Missing photos get an honest placeholder, never a different restaurant's photo.
export default function FoodImage({ src, alt, className = '', eager = false }) {
  const [failedSource, setFailedSource] = useState(null)
  if (!src || failedSource === src) return <div role="img" aria-label={alt + ' — photo unavailable'} className={'photo-fallback ' + className}>🍽️</div>
  const url = src.startsWith('/media/') ? API_URL + src : src
  return <img src={url} alt={alt} loading={eager ? 'eager' : 'lazy'} referrerPolicy="no-referrer" onError={() => setFailedSource(src)} className={className} />
}
