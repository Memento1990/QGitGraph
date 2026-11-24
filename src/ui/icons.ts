const paths = {
  folder: '<path d="M2.5 4.5h5l1.5 2h12v12h-18.5z"/>',
  open: '<path d="M3 9V5h6l2 2h9v3M3 19h16l3-9H6z"/>',
  refresh: '<path d="M20 7v5h-5M4 17v-5h5M19 11a7 7 0 0 0-12-6L4 8M5 13a7 7 0 0 0 12 6l3-3"/>',
  branch: '<circle cx="6" cy="5" r="2"/><circle cx="18" cy="5" r="2"/><circle cx="6" cy="19" r="2"/><path d="M6 7v10M18 7v1a6 6 0 0 1-6 6H6"/>',
  merge: '<circle cx="6" cy="5" r="2"/><circle cx="18" cy="5" r="2"/><circle cx="6" cy="19" r="2"/><path d="M6 7v10M18 7v1c0 6-12 0-12 9"/>',
  tag: '<path d="M3 4h9l9 9-8 8-10-10z"/><circle cx="7.5" cy="8" r="1"/>',
  stash: '<path d="M3 8h18v12H3zM6 8V4h12v4M9 12h6"/>',
  remote: '<path d="M6 17H5a4 4 0 0 1-1-8 6 6 0 0 1 11-3 5 5 0 0 1 4 11h-1M12 10v11m-4-4 4 4 4-4"/>',
  settings: '<path d="m9 3-1 3-3 1-2 3 2 2-1 3 3 2 3-1 2 3 3-1 1-3 3-1 2-3-2-2 1-3-3-2-3 1-2-3z"/><circle cx="12" cy="11" r="3"/>',
  search: '<circle cx="10" cy="10" r="6"/><path d="m15 15 6 6"/>',
  filter: '<path d="M3 5h18l-7 8v6l-4 2v-8z"/>',
  chevron: '<path d="m9 5 7 7-7 7"/>',
  down: '<path d="m5 9 7 7 7-7"/>',
  close: '<path d="m6 6 12 12M6 18 18 6"/>',
  check: '<path d="m4 12 5 5L20 6"/>',
  copy: '<rect x="8" y="8" width="12" height="13" rx="1"/><path d="M16 8V3H3v13h5"/>',
  terminal: '<path d="m4 6 6 6-6 6M13 18h7"/>',
  editor: '<path d="m3 21 2-7L16 3l5 5L10 19zM14 5l5 5M5 14l5 5"/>',
  external: '<path d="M14 3h7v7M21 3 10 14M10 3H3v18h18v-7"/>',
  file: '<path d="M5 2h9l5 5v15H5zM14 2v6h5"/>',
  tree: '<path d="M4 3v15h5M4 8h5M13 5h8v6h-8zM13 15h8v6h-8z"/>',
  sidebar: '<rect x="3" y="3" width="18" height="18" rx="1"/><path d="M9 3v18M5.5 7h1M5.5 11h1M5.5 15h1"/>',
  list: '<path d="M8 5h13M8 12h13M8 19h13M3 5h1M3 12h1M3 19h1"/>',
  split: '<rect x="3" y="3" width="18" height="18"/><path d="M12 3v18"/>',
  unified: '<path d="M4 4h16v16H4zM7 8h10M7 12h10M7 16h10"/>',
  more: '<circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/>',
  arrowUp: '<path d="M12 21V3m-7 7 7-7 7 7"/>',
  arrowDown: '<path d="M12 3v18m-7-7 7 7 7-7"/>',
  warning: '<path d="m12 3 10 18H2zM12 9v5M12 17v1"/>',
  shield: '<path d="m12 2 9 4v6c0 5-9 10-9 10S3 17 3 12V6zM8 12l3 3 5-6"/>',
  compare: '<path d="M6 3v18M18 3v18M3 7l3-4 3 4m6 10 3 4 3-4M2 12h20"/>',
  commit: '<circle cx="12" cy="12" r="5"/><path d="M2 12h5m10 0h5"/>',
  play: '<path d="m7 4 13 8-13 8z"/>',
  stop: '<rect x="5" y="5" width="14" height="14"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 6v6l4 2"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 10v7M12 6v1"/>',
  plus: '<path d="M12 4v16M4 12h16"/>',
  minus: '<path d="M4 12h16"/>',
  eye: '<path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7-10-7-10-7z"/><circle cx="12" cy="12" r="3"/>',
  identity: '<circle cx="12" cy="7" r="4"/><path d="M4 22v-3a8 8 0 0 1 16 0v3"/>',
  export: '<path d="M13 3v12m-5-5 5 5 5-5M4 14v7h17v-7"/>',
  undo: '<path d="M3 4v7h7M3 11l4-4a8 8 0 1 1-1 12"/>',
} as const;
export type IconName = keyof typeof paths;
export function icon(name: IconName): SVGSVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', '16'); svg.setAttribute('height', '16');
  svg.setAttribute('fill', 'none'); svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '1.6'); svg.setAttribute('stroke-linecap', 'round'); svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true'); svg.classList.add('icon');
  svg.innerHTML = paths[name];
  return svg;
}
