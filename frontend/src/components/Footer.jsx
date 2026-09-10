import { Link } from 'react-router-dom'
export default function Footer() {
  return <footer className="border-t border-stone-200 mt-8"><div className="page-shell py-8 flex flex-wrap items-center justify-between gap-4"><div><Link to="/" className="brand text-2xl">cravio<span className="text-orange-600">.</span></Link><p className="text-xs text-stone-500 mt-1">A little joy, delivered. Made for Bangladesh 🇧🇩</p></div><div className="text-xs text-stone-500 flex gap-5"><Link to="/explore">Explore food</Link><Link to="/directory">City directory</Link><Link to="/account">Account & support</Link><span>© {new Date().getFullYear()} Cravio</span></div></div></footer>
}
