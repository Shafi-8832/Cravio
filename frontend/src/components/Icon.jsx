const paths = {
  search: <><circle cx="10.8" cy="10.8" r="6.8" /><path d="m16 16 4.5 4.5" /></>,
  pin: <><path d="M20 10c0 6-8 12-8 12S4 16 4 10a8 8 0 1 1 16 0Z" /><circle cx="12" cy="10" r="2.5" /></>,
  bag: <><path d="M5 7h14l1 14H4L5 7Z" /><path d="M8 8V6a4 4 0 0 1 8 0v2" /></>,
  heart: <path d="M20.5 4.7a5.5 5.5 0 0 0-7.8 0l-.7.7-.7-.7a5.5 5.5 0 0 0-7.8 7.8L12 21l8.5-8.5a5.5 5.5 0 0 0 0-7.8Z" />,
  clock: <><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></>,
  arrow: <path d="M4 12h16m-6-6 6 6-6 6" />,
  chevron: <path d="m8 4 8 8-8 8" />,
  down: <path d="m6 9 6 6 6-6" />,
  star: <path d="m12 3 2.8 5.7 6.3.9-4.6 4.5 1.1 6.3-5.6-3-5.6 3 1.1-6.3L2.9 9.6l6.3-.9L12 3Z" />,
  user: <><circle cx="12" cy="7" r="4" /><path d="M4 22v-2a8 8 0 0 1 16 0v2" /></>,
  close: <path d="m6 6 12 12M18 6 6 18" />,
  check: <path d="m5 12 4 4L19 6" />,
  bike: <><circle cx="5" cy="17" r="4" /><circle cx="19" cy="17" r="4" /><path d="m5 17 5-10 5 10H5m6-14h4m0 0 4 14M7 7h5" /></>,
  grid: <><rect x="3" y="3" width="7" height="7" rx="1" /><rect x="14" y="3" width="7" height="7" rx="1" /><rect x="3" y="14" width="7" height="7" rx="1" /><rect x="14" y="14" width="7" height="7" rx="1" /></>,
  refresh: <><path d="M21 7v5h-5M3 17v-5h5" /><path d="M5 7a8 8 0 0 1 13-2l3 7M3 12l3 7a8 8 0 0 0 13-2" /></>,
  logout: <path d="M9 4H4v16h5m5-13 5 5-5 5m-6-5h11" />,
}
export default function Icon({ name, size = 20, className = '', filled = false }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill={filled ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">{paths[name] || paths.bag}</svg>
}
