import fullLogo from '../../assets/brand/cravio-logo.png'
import iconLogo from '../../assets/brand/cravio-icon.png'

// The one place Cravio's own logo is drawn. Every page uses this component,
// so swapping the brand artwork later means editing only these two imports.
// (Restaurant logos come from restaurants.logo_url and are not handled here.)
//
// variant "full": cloche + "Cravio" text. Use it at roughly 48px tall or more;
//                 below that the lettering becomes unreadable.
// variant "icon": the cloche on its own, for small spots.
// size: the height in pixels. The width is left on auto so the browser keeps
//       the image's own shape instead of stretching it.
export default function CravioLogo({ variant = 'full', size = 64, className = '' }) {
  const src = variant === 'icon' ? iconLogo : fullLogo
  return <img src={src} alt="Cravio" style={{ height: size, width: 'auto' }} className={'block shrink-0 ' + className} draggable="false" />
}
