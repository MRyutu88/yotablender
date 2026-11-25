// Small stroke icon set (24×24), drawn inline so the app needs no icon font or network.
import type { JSX } from 'preact';

type P = { size?: number };

const I = (children: JSX.Element | JSX.Element[], { size = 24 }: P = {}) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="2"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
  >
    {children}
  </svg>
);

export const Icon = {
  menu: (p?: P) => I([<path d="M4 7h16M4 12h16M4 17h16" />], p),
  undo: (p?: P) => I([<path d="M9 14 4 9l5-5" />, <path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11" />], p),
  redo: (p?: P) => I([<path d="m15 14 5-5-5-5" />, <path d="M20 9H9.5a5.5 5.5 0 0 0 0 11H13" />], p),
  select: (p?: P) => I([<path d="M5 3l14 8-6 1.5L10 19z" />], p),
  box: (p?: P) => I([<rect x="4" y="4" width="16" height="16" rx="1" stroke-dasharray="3 3" />], p),
  lasso: (p?: P) => I([<path d="M7 18c-3-1.5-4-4-3-7 1.5-5 9-7.5 13.5-5S21 13 16 15.5c-3 1.5-7 1.3-9 .2" stroke-dasharray="3 2.5" />, <path d="M7 18c-.5 1.5.5 3 2 3" />], p),
  move: (p?: P) => I([<path d="M12 3v18M3 12h18" />, <path d="m9 6 3-3 3 3M9 18l3 3 3-3M6 9l-3 3 3 3M18 9l3 3-3 3" />], p),
  rotate: (p?: P) => I([<path d="M20 12a8 8 0 1 1-2.6-5.9" />, <path d="M20 4v5h-5" />], p),
  scale: (p?: P) => I([<rect x="3" y="11" width="10" height="10" rx="1" />, <path d="M13 11l8-8M15 3h6v6" />], p),
  plus: (p?: P) => I([<path d="M12 5v14M5 12h14" />], p),
  minus: (p?: P) => I([<path d="M5 12h14" />], p),
  equals: (p?: P) => I([<path d="M6 9h12M6 15h12" />], p),
  duplicate: (p?: P) => I([<rect x="8" y="8" width="12" height="12" rx="2" />, <path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2" />], p),
  trash: (p?: P) => I([<path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3" />], p),
  list: (p?: P) => I([<path d="M9 6h11M9 12h11M9 18h11" />, <circle cx="4.5" cy="6" r="1" />, <circle cx="4.5" cy="12" r="1" />, <circle cx="4.5" cy="18" r="1" />], p),
  wrench: (p?: P) => I([<path d="M14.7 6.3a4 4 0 0 0 5 5L13 18a2.1 2.1 0 0 1-3-3z" />, <path d="M14.7 6.3 17 4a4 4 0 0 1 3 3l-2.3 2.3" />, <path d="m10 15-5 5" />], p),
  sliders: (p?: P) => I([<path d="M4 6h10M18 6h2M4 12h4M12 12h8M4 18h12M20 18h0" />, <circle cx="16" cy="6" r="2" />, <circle cx="10" cy="12" r="2" />, <circle cx="18" cy="18" r="2" />], p),
  extrude: (p?: P) => I([<path d="M4 15l8 4 8-4-8-4z" />, <path d="M12 11V3M9 6l3-3 3 3" />], p),
  merge: (p?: P) => I([<path d="M5 5l6 6M19 5l-6 6M12 12v8" />, <circle cx="12" cy="12" r="1.5" />], p),
  mergeDist: (p?: P) => I([<circle cx="8" cy="12" r="2" />, <circle cx="16" cy="12" r="2" />, <path d="M3 5v14M21 5v14" />], p),
  all: (p?: P) => I([<rect x="4" y="4" width="16" height="16" rx="2" />, <path d="m8 12 3 3 5-6" />], p),
  none: (p?: P) => I([<rect x="4" y="4" width="16" height="16" rx="2" />, <path d="M9 9l6 6M15 9l-6 6" />], p),
  invert: (p?: P) => I([<rect x="4" y="4" width="16" height="16" rx="2" />, <path d="M4 20 20 4" />], p),
  eye: (p?: P) => I([<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z" />, <circle cx="12" cy="12" r="3" />], p),
  eyeOff: (p?: P) => I([<path d="M3 3l18 18" />, <path d="M10.6 5.1A10 10 0 0 1 12 5c6.5 0 10 7 10 7a17 17 0 0 1-3 3.8M6.6 6.6A17 17 0 0 0 2 12s3.5 7 10 7a9.6 9.6 0 0 0 5.4-1.6" />], p),
  frame: (p?: P) => I([<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5" />, <circle cx="12" cy="12" r="2.5" />], p),
  magnet: (p?: P) => I([<path d="M6 3v8a6 6 0 0 0 12 0V3" />, <path d="M6 7h4M14 7h4" />], p),
  xray: (p?: P) => I([<circle cx="12" cy="12" r="8" />, <path d="M12 4a8 8 0 0 1 0 16z" fill="currentColor" stroke="none" />], p),
  close: (p?: P) => I([<path d="M6 6l12 12M18 6 6 18" />], p),
  chevronUp: (p?: P) => I([<path d="m6 15 6-6 6 6" />], p),
  chevronDown: (p?: P) => I([<path d="m6 9 6 6 6-6" />], p),
  share: (p?: P) => I([<path d="M12 3v12M8 7l4-4 4 4" />, <path d="M5 12v7a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-7" />], p),
  folder: (p?: P) => I([<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />], p),
  help: (p?: P) => I([<circle cx="12" cy="12" r="9" />, <path d="M9.5 9a2.5 2.5 0 1 1 3.5 2.3c-.7.3-1 .9-1 1.7M12 17h.01" />], p),
  edit: (p?: P) => I([<path d="M4 20h4L19 9l-4-4L4 16z" />], p),
  vert: (p?: P) => I([<path d="M4 18 12 6l8 12z" stroke-opacity=".45" />, <circle cx="12" cy="6" r="2.6" fill="currentColor" />, <circle cx="4" cy="18" r="1.4" fill="currentColor" />, <circle cx="20" cy="18" r="1.4" fill="currentColor" />], p),
  edge: (p?: P) => I([<path d="M4 18 12 6l8 12z" stroke-opacity=".45" />, <path d="M4 18 12 6" stroke-width="3.2" />], p),
  face: (p?: P) => I([<path d="M4 18 12 6l8 12z" fill="currentColor" fill-opacity=".45" />], p),
  cube: (p?: P) => I([<path d="M12 3 4 7.5v9L12 21l8-4.5v-9z" />, <path d="M4 7.5 12 12l8-4.5M12 12v9" />], p),
  sphere: (p?: P) => I([<circle cx="12" cy="12" r="8.5" />, <ellipse cx="12" cy="12" rx="8.5" ry="3" />, <ellipse cx="12" cy="12" rx="3.5" ry="8.5" />], p),
  quadSphere: (p?: P) => I([<circle cx="12" cy="12" r="8.5" />, <path d="M6 6.5c3 2 9 2 12 0M6 17.5c3-2 9-2 12 0M6.5 6c2 3 2 9 0 12M17.5 6c-2 3-2 9 0 12" />], p),
  cylinder: (p?: P) => I([<ellipse cx="12" cy="5.5" rx="7" ry="2.5" />, <path d="M5 5.5v13c0 1.4 3.1 2.5 7 2.5s7-1.1 7-2.5v-13" />], p),
  cone: (p?: P) => I([<path d="M12 3 5 18.5" />, <path d="M12 3l7 15.5" />, <ellipse cx="12" cy="18.5" rx="7" ry="2.5" />], p),
  torus: (p?: P) => I([<ellipse cx="12" cy="12" rx="9" ry="5.5" />, <ellipse cx="12" cy="11.5" rx="3.5" ry="1.6" />], p),
  plane: (p?: P) => I([<path d="M3 15l6-6h12l-6 6z" />], p),
  person: (p?: P) => I([<circle cx="12" cy="5" r="2.5" />, <path d="M12 8v7M7 10.5l5-1.5 5 1.5M9 21l3-6 3 6" />], p),
  smooth: (p?: P) => I([<path d="M3 17c4-10 14-10 18 0" />], p),
  flat: (p?: P) => I([<path d="M3 17l5-7h8l5 7" />], p),
  download: (p?: P) => I([<path d="M12 4v11M8 11l4 4 4-4M5 20h14" />], p),
  check: (p?: P) => I([<path d="m5 12 5 5 9-10" />], p),
  falloff: (p?: P) => I([<circle cx="12" cy="12" r="9" stroke-dasharray="2.5 2.5" />, <circle cx="12" cy="12" r="4.5" />, <circle cx="12" cy="12" r="1" fill="currentColor" />], p),
  loopcut: (p?: P) => I([<rect x="4" y="4" width="16" height="16" rx="2" />, <path d="M12 4v16" stroke-dasharray="2.5 2" />], p),
  subdivide: (p?: P) => I([<rect x="4" y="4" width="16" height="16" rx="2" />, <path d="M12 4v16M4 12h16" stroke-dasharray="2.5 2" />], p),
  inset: (p?: P) => I([<rect x="3" y="3" width="18" height="18" rx="1.5" />, <rect x="8" y="8" width="8" height="8" rx="1" />, <path d="M3 3l5 5M21 3l-5 5M3 21l5-5M21 21l-5-5" />], p),
  linked: (p?: P) => I([<circle cx="7" cy="7" r="3" />, <circle cx="17" cy="17" r="3" />, <path d="M9.5 9.5l5 5" />], p),
  loop: (p?: P) => I([<ellipse cx="12" cy="12" rx="9" ry="5" />, <path d="M3 12h2M19 12h2" />], p),
  ring: (p?: P) => I([<ellipse cx="12" cy="12" rx="9" ry="5" stroke-opacity=".4" />, <path d="M6 8.5v7M10 7.2v9.6M14 7.2v9.6M18 8.5v7" />], p),
  palette: (p?: P) => I([<path d="M12 3a9 9 0 0 0 0 18c1.4 0 2-1 2-2 0-1.5-1.5-1.6-1.5-3 0-1 .8-1.8 1.8-1.8H17a4 4 0 0 0 4-4C21 6.4 17 3 12 3z" />, <circle cx="7.5" cy="11" r="1.2" fill="currentColor" />, <circle cx="10" cy="7" r="1.2" fill="currentColor" />, <circle cx="15" cy="7.5" r="1.2" fill="currentColor" />], p),
  brush: (p?: P) => I([<path d="M14.5 4.5l5 5-8 8-5-5z" />, <path d="M6.5 12.5C4 13 3 15 3 21c4.5 0 7-1.5 8-4" />], p),
  blur: (p?: P) => I([<circle cx="12" cy="12" r="8" stroke-dasharray="2 2.4" />, <circle cx="12" cy="12" r="3.5" fill="currentColor" fill-opacity=".35" />], p),
  dropper: (p?: P) => I([<path d="M14 6l4 4M17 3.5a2.1 2.1 0 0 1 3 3L9 17.5 5 19l1.5-4z" />], p),
  fill: (p?: P) => I([<path d="M4 12 11 5l7 7-7 7z" />, <path d="M19.5 16.5c0 1.1-.7 2-1.5 2s-1.5-.9-1.5-2 1.5-3 1.5-3 1.5 1.9 1.5 3z" fill="currentColor" />], p),
  shade: (p?: P) => I([<circle cx="12" cy="12" r="8.5" />, <path d="M12 3.5a8.5 8.5 0 0 1 0 17" fill="currentColor" fill-opacity=".35" stroke="none" />, <circle cx="9" cy="9" r="1.6" fill="currentColor" />], p),
  eraser: (p?: P) => I([<path d="M8.5 19 3.5 14a1.5 1.5 0 0 1 0-2.1L12 3.4a1.5 1.5 0 0 1 2.1 0l5.5 5.5a1.5 1.5 0 0 1 0 2.1L11.5 19z" />, <path d="M7 9.5l7.5 7.5M8.5 19H20" />], p),
  dots: (p?: P) => I([<circle cx="5" cy="12" r="1" />, <circle cx="12" cy="12" r="1" />, <circle cx="19" cy="12" r="1" />], p),
};
