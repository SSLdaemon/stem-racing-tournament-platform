/**
 * Stylized F1 car SVG generator — renders a side-view F1 car in the team's
 * primary colour with secondary highlights. Pure vector, scales infinitely.
 *
 * Usage:  container.innerHTML = F1Car.render({ color: '#00e6d2', flip: false });
 *
 * The car is drawn in a 600x200 viewBox facing left.
 * `flip: true` mirrors it horizontally so it faces right.
 */

window.F1Car = (function () {
  function render({ color = '#00e6d2', secondary = '#ffffff', number = null, flip = false, accent = '#0b0d10' } = {}) {
    const tx = flip ? 'transform="scale(-1,1) translate(-600,0)"' : '';
    const numLabel = number != null
      ? `<g transform="translate(285, 105)"><circle r="22" fill="#fff"/><text y="8" text-anchor="middle" font-family="Arial Narrow, Arial, sans-serif" font-weight="900" font-size="28" fill="${accent}">${number}</text></g>`
      : '';
    return `
    <svg viewBox="0 0 600 200" xmlns="http://www.w3.org/2000/svg" style="width:100%;height:100%;max-width:100%;">
      <defs>
        <linearGradient id="body-grad" x1="0" x2="0" y1="0" y2="1">
          <stop offset="0" stop-color="${color}"/>
          <stop offset="1" stop-color="${shade(color, -35)}"/>
        </linearGradient>
        <linearGradient id="body-accent" x1="0" x2="1">
          <stop offset="0" stop-color="${secondary}" stop-opacity="0.9"/>
          <stop offset="1" stop-color="${secondary}" stop-opacity="0"/>
        </linearGradient>
      </defs>
      <g ${tx}>
        <!-- shadow -->
        <ellipse cx="300" cy="180" rx="240" ry="10" fill="#000" opacity="0.35"/>

        <!-- rear wing -->
        <rect x="480" y="70" width="80" height="10" fill="${shade(color, -20)}"/>
        <rect x="500" y="40" width="10" height="50" fill="${shade(color, -20)}"/>
        <rect x="540" y="40" width="10" height="50" fill="${shade(color, -20)}"/>
        <rect x="480" y="38" width="80" height="10" fill="${color}"/>

        <!-- sidepod + body -->
        <path d="M80,140 C120,95 220,85 380,85 L470,85 C490,85 510,100 518,140 L520,150 L80,150 Z"
              fill="url(#body-grad)" stroke="${accent}" stroke-width="1.5"/>

        <!-- accent stripe -->
        <path d="M150,112 L420,98 L470,110 L420,118 L150,125 Z" fill="url(#body-accent)"/>

        <!-- cockpit halo -->
        <path d="M250,85 Q280,55 320,55 L360,55 Q390,55 400,85"
              fill="none" stroke="${accent}" stroke-width="6" stroke-linecap="round"/>
        <ellipse cx="325" cy="80" rx="55" ry="12" fill="${accent}" opacity="0.85"/>
        <rect x="278" y="78" width="94" height="8" fill="${shade(secondary, -30)}" opacity="0.8"/>

        <!-- nose -->
        <path d="M40,140 L90,120 L80,140 Z" fill="${color}"/>
        <path d="M20,152 L90,140 L85,148 L20,158 Z" fill="${shade(color, -30)}"/>

        <!-- front wing -->
        <rect x="5" y="148" width="90" height="6" fill="${accent}"/>
        <rect x="5" y="154" width="90" height="4" fill="${shade(color, -20)}"/>
        <rect x="10" y="140" width="6" height="12" fill="${accent}"/>
        <rect x="85" y="138" width="6" height="14" fill="${accent}"/>

        <!-- floor -->
        <rect x="80" y="148" width="430" height="6" fill="${accent}"/>

        <!-- wheels -->
        <g>
          <circle cx="130" cy="155" r="32" fill="${accent}"/>
          <circle cx="130" cy="155" r="22" fill="${shade(accent, 40)}"/>
          <circle cx="130" cy="155" r="8" fill="${color}"/>
        </g>
        <g>
          <circle cx="470" cy="155" r="32" fill="${accent}"/>
          <circle cx="470" cy="155" r="22" fill="${shade(accent, 40)}"/>
          <circle cx="470" cy="155" r="8" fill="${color}"/>
        </g>

        ${numLabel}
      </g>
    </svg>`;
  }

  function shade(hex, percent) {
    // Lighten (positive) or darken (negative) a hex colour by percent.
    const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex.trim());
    if (!m) return hex;
    let [r, g, b] = [parseInt(m[1], 16), parseInt(m[2], 16), parseInt(m[3], 16)];
    const adjust = x => Math.max(0, Math.min(255, Math.round(x + 255 * (percent / 100))));
    return '#' + [adjust(r), adjust(g), adjust(b)].map(x => x.toString(16).padStart(2, '0')).join('');
  }

  return { render, shade };
})();
