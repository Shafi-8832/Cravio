// The drawn cloche for the intro: plate, golden light, steam and the lid.
// Purely decorative (aria-hidden). Every moving part has its own class so
// intro.css can animate it; this file only describes the shapes.
//
// The viewBox starts at y = -60 so the lid still fits when it lifts and
// tilts back — the scene is scaled to the screen, never cropped.
export default function ClocheArt() {
  return <svg className="intro-cloche-svg" viewBox="0 -60 400 360" aria-hidden="true" focusable="false">
    <defs>
      {/* Lid: burnt orange at the rim up to amber at the top. */}
      <linearGradient id="intro-dome" x1="0" y1="1" x2="0.35" y2="0">
        <stop offset="0" stopColor="#C2410C" />
        <stop offset="0.6" stopColor="#EA7A12" />
        <stop offset="1" stopColor="#F59E0B" />
      </linearGradient>
      <linearGradient id="intro-plate" x1="0" y1="0" x2="1" y2="0">
        <stop offset="0" stopColor="#9A3412" />
        <stop offset="0.5" stopColor="#F59E0B" />
        <stop offset="1" stopColor="#9A3412" />
      </linearGradient>
      {/* The light that spills out from under the lid. */}
      <radialGradient id="intro-burst" cx="0.5" cy="0.9" r="0.75">
        <stop offset="0" stopColor="#FFF4E0" />
        <stop offset="0.35" stopColor="#F59E0B" stopOpacity="0.85" />
        <stop offset="1" stopColor="#C2410C" stopOpacity="0" />
      </radialGradient>
    </defs>

    {/* Golden light: hidden until the lid lifts. */}
    <g className="intro-burst">
      <path d="M180 250 L40 60 L96 44 Z" fill="#F59E0B" opacity="0.35" />
      <path d="M180 250 L150 10 L210 10 Z" fill="#FFF4E0" opacity="0.4" />
      <path d="M180 250 L262 40 L316 56 Z" fill="#F59E0B" opacity="0.35" />
      <ellipse cx="180" cy="215" rx="160" ry="70" fill="url(#intro-burst)" />
    </g>

    {/* Plate the cloche rests on. */}
    <ellipse cx="200" cy="262" rx="176" ry="15" fill="url(#intro-plate)" />
    <ellipse cx="200" cy="258" rx="150" ry="5" fill="#FFF4E0" opacity="0.35" />

    {/* The lid — dome, rim band, highlight and knob move together. */}
    <g className="intro-lid">
      <path d="M48 252 C48 150 120 92 200 92 C280 92 352 150 352 252 Z" fill="url(#intro-dome)" />
      <path d="M86 210 C92 160 128 124 176 112" fill="none" stroke="#FFF4E0" strokeWidth="9" strokeLinecap="round" opacity="0.45" />
      <rect x="40" y="244" width="320" height="16" rx="8" fill="#C2410C" />
      <rect x="191" y="70" width="18" height="24" rx="4" fill="#C2410C" />
      <ellipse cx="200" cy="68" rx="20" ry="13" fill="#F59E0B" />
      <ellipse cx="194" cy="64" rx="7" ry="4" fill="#FFF4E0" opacity="0.6" />
    </g>

    {/* Three steam curls, rising through the gap the lid leaves on the left.
        pathLength="1" lets the CSS "draw" each curl by
        moving stroke-dashoffset from 1 to 0, whatever its real length. */}
    <g className="intro-steam" fill="none" stroke="#FFF4E0" strokeWidth="7" strokeLinecap="round">
      <path pathLength="1" d="M120 236 C104 212 136 196 120 172 S106 136 124 116" />
      <path pathLength="1" d="M170 232 C154 204 188 188 170 160 S154 120 174 98" />
      <path pathLength="1" d="M220 236 C204 212 236 196 220 172 S206 136 224 116" />
    </g>
  </svg>
}
