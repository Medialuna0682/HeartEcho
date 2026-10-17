/**
 * 圆润线性图标集。
 * 统一约定：24x24 视窗、stroke-width 1.8、linecap/linejoin 全部 round —— 所以每个图标看起来都是圆头的。
 * 全部内联，没有外部依赖，也不会有图标加载失败的问题（规划书：图标不应该是唯一的状态表达，旁边都配文字）。
 */
const P = {
  heart: '<path d="M12 20.5s-7.5-4.6-7.5-9.7A4.3 4.3 0 0 1 12 8.2a4.3 4.3 0 0 1 7.5 2.6c0 5.1-7.5 9.7-7.5 9.7Z"/>',
  moon: '<path d="M20 14.5A8.5 8.5 0 0 1 9.5 4a8.5 8.5 0 1 0 10.5 10.5Z"/>',
  chat: '<path d="M20.5 11.5c0 4.1-3.8 7.4-8.5 7.4a9.9 9.9 0 0 1-2.6-.3L5 20.5l1.4-3.4A7 7 0 0 1 3.5 11.5C3.5 7.4 7.3 4 12 4s8.5 3.4 8.5 7.5Z"/>',
  users: '<circle cx="9" cy="8.5" r="3.2"/><path d="M3.5 19.5c0-3 2.5-5.2 5.5-5.2s5.5 2.2 5.5 5.2"/><path d="M16 6.2a3 3 0 0 1 0 5.6"/><path d="M17.5 14.6c2 .6 3.4 2.4 3.4 4.9"/>',
  brain: '<path d="M9.5 4.5A3 3 0 0 0 6.6 8a3 3 0 0 0-1.3 5.4A3 3 0 0 0 7 19a3 3 0 0 0 5-1.6V6.9A2.4 2.4 0 0 0 9.5 4.5Z"/><path d="M14.5 4.5A3 3 0 0 1 17.4 8a3 3 0 0 1 1.3 5.4A3 3 0 0 1 17 19a3 3 0 0 1-5-1.6"/>',
  sparkle: '<path d="M12 3.5l1.7 4.6 4.6 1.7-4.6 1.7L12 16.1l-1.7-4.6L5.7 9.8l4.6-1.7Z"/><path d="M18 16.5l.8 2 2 .8-2 .8-.8 2-.8-2-2-.8 2-.8Z"/>',
  calendar: '<rect x="3.5" y="5.5" width="17" height="15" rx="4"/><path d="M3.5 10h17M8.5 3.5v4M15.5 3.5v4"/>',
  cloud: '<path d="M7 18.5a4 4 0 0 1-.3-8 5.5 5.5 0 0 1 10.6 1.4 3.4 3.4 0 0 1-.8 6.6Z"/>',
  cpu: '<rect x="7" y="7" width="10" height="10" rx="3"/><path d="M10 3.5v3M14 3.5v3M10 17.5v3M14 17.5v3M3.5 10h3M3.5 14h3M17.5 10h3M17.5 14h3"/>',
  gauge: '<path d="M4.5 17a8.5 8.5 0 1 1 15 0"/><path d="M12 12.5l3.5-3"/><circle cx="12" cy="14" r="1.6"/>',
  scroll: '<path d="M6 4.5h9.5a2.5 2.5 0 0 1 2.5 2.5v11a2 2 0 0 0 2 2H7.5a2.5 2.5 0 0 1-2.5-2.5v-11A2 2 0 0 0 6 4.5Z"/><path d="M8.5 9h6M8.5 12.5h6M8.5 16h3.5"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="M12 3.5v2M12 18.5v2M4.9 7.5l1.7 1M17.4 15.5l1.7 1M4.9 16.5l1.7-1M17.4 8.5l1.7-1"/>',
  plug: '<path d="M9 3.5v4M15 3.5v4"/><path d="M7 7.5h10v4a5 5 0 0 1-10 0Z"/><path d="M12 16.5v4"/>',
  power: '<path d="M12 4v7"/><path d="M7.4 6.8a7 7 0 1 0 9.2 0"/>',
  play: '<path d="M8 5.5l10 6.5-10 6.5Z"/>',
  pause: '<path d="M9.5 5.5v13M14.5 5.5v13"/>',
  refresh: '<path d="M20 12a8 8 0 1 1-2.6-5.9"/><path d="M20 4.5V11h-6"/>',
  send: '<path d="M4.5 12 20 5l-6.5 15-2.4-6.1Z"/><path d="M11.1 13.9 20 5"/>',
  save: '<path d="M5.5 4.5h9L19 9v9.5a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1v-13a1 1 0 0 1 1-1Z"/><path d="M8.5 4.5v5h6v-5M8.5 19v-5h7v5"/>',
  trash: '<path d="M4.5 7.5h15M9.5 7.5V5.2a1 1 0 0 1 1-1h3a1 1 0 0 1 1 1v2.3"/><path d="M6.5 7.5l.8 11a1.6 1.6 0 0 0 1.6 1.5h6.2a1.6 1.6 0 0 0 1.6-1.5l.8-11"/>',
  plus: '<path d="M12 5.5v13M5.5 12h13"/>',
  check: '<path d="M5 12.8l4.6 4.4L19 7.5"/>',
  x: '<path d="M6.5 6.5l11 11M17.5 6.5l-11 11"/>',
  alert: '<path d="M12 4.5 21 19H3Z"/><path d="M12 10v4.2M12 16.6v.1"/>',
  info: '<circle cx="12" cy="12" r="8.5"/><path d="M12 11v5.5M12 8.2v.1"/>',
  shield: '<path d="M12 3.5l6.5 2.6v5.4c0 4-2.7 7.4-6.5 8.9-3.8-1.5-6.5-4.9-6.5-8.9V6.1Z"/><path d="M9.2 12.2l2 2 3.6-3.7"/>',
  lock: '<rect x="5" y="10.5" width="14" height="9.5" rx="3"/><path d="M8.5 10.5V8a3.5 3.5 0 0 1 7 0v2.5"/>',
  eye: '<path d="M2.8 12S6.5 6.5 12 6.5 21.2 12 21.2 12 17.5 17.5 12 17.5 2.8 12 2.8 12Z"/><circle cx="12" cy="12" r="2.8"/>',
  search: '<circle cx="11" cy="11" r="6.5"/><path d="M16 16l4.5 4.5"/>',
  link: '<path d="M10 14a4 4 0 0 1 0-5.7l2.8-2.8a4 4 0 0 1 5.7 5.7l-1.4 1.4"/><path d="M14 10a4 4 0 0 1 0 5.7l-2.8 2.8a4 4 0 0 1-5.7-5.7l1.4-1.4"/>',
  folder: '<path d="M3.5 7.5a2 2 0 0 1 2-2h3l2 2.4h8a2 2 0 0 1 2 2v8.6a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2Z"/>',
  copy: '<rect x="8.5" y="8.5" width="11" height="11" rx="3"/><path d="M15.5 5.5H7a2 2 0 0 0-2 2v9"/>',
  download: '<path d="M12 4v10.5"/><path d="M8 11l4 4 4-4"/><path d="M5 19.5h14"/>',
  upload: '<path d="M12 20V9.5"/><path d="M8 13l4-4 4 4"/><path d="M5 4.5h14"/>',
  clock: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>',
  bell: '<path d="M6.5 16.5V11a5.5 5.5 0 0 1 11 0v5.5l1.5 2h-14Z"/><path d="M10 20.5h4"/>',
  cake: '<path d="M5 20.5h14v-6a3 3 0 0 0-3-3H8a3 3 0 0 0-3 3Z"/><path d="M5 16.5c1.8 0 1.8-1.6 3.5-1.6s1.7 1.6 3.5 1.6 1.8-1.6 3.5-1.6 1.7 1.6 3.5 1.6"/><path d="M12 8V5.5M9.5 8V6M14.5 8V6"/>',
  gift: '<rect x="3.5" y="8.5" width="17" height="11" rx="3"/><path d="M3.5 12.5h17M12 8.5v11"/><path d="M12 8.5S10.5 3.5 8.2 3.5A2 2 0 0 0 8 8.5M12 8.5s1.5-5 3.8-5A2 2 0 0 1 16 8.5"/>',
  image: '<rect x="3.5" y="4.5" width="17" height="15" rx="4"/><circle cx="9" cy="10" r="1.8"/><path d="M4.5 16.5l4.6-4a1.6 1.6 0 0 1 2.2.1l3 3a1.6 1.6 0 0 0 2.3 0l3.4-3.3"/>',
  user: '<circle cx="12" cy="8.5" r="3.8"/><path d="M4.8 20c0-3.6 3.2-6 7.2-6s7.2 2.4 7.2 6"/>',
  filter: '<path d="M4 6.5h16M7 12h10M10 17.5h4"/>',
  list: '<path d="M8 6.5h12M8 12h12M8 17.5h12"/><path d="M4.5 6.5h.01M4.5 12h.01M4.5 17.5h.01"/>',
  layers: '<path d="M12 3.5 20 8l-8 4.5L4 8Z"/><path d="M4 12.5 12 17l8-4.5M4 16.5 12 21l8-4.5"/>',
  activity: '<path d="M3.5 12h3.2l2.3-6 3.5 12 2.4-7 1.8 3h4.8"/>',
  wallet: '<rect x="3.5" y="6.5" width="17" height="12" rx="3.5"/><path d="M3.5 10.5h17"/><circle cx="16.5" cy="14" r="1.1"/>',
  book: '<path d="M4.5 5.5A2 2 0 0 1 6.5 3.5H19v14H6.5a2 2 0 0 0-2 2Z"/><path d="M4.5 19.5A2 2 0 0 1 6.5 17.5H19v3H6.5a2 2 0 0 1-2-2Z"/>',
  feather: '<path d="M20 4.5c-6 0-11 3-11 9v3.5"/><path d="M9 16.5 4.5 21"/><path d="M15 8.5 8.5 15h6"/>',
  target: '<circle cx="12" cy="12" r="8.5"/><circle cx="12" cy="12" r="4.5"/><circle cx="12" cy="12" r="1"/>',
  route: '<circle cx="6" cy="18.5" r="2.5"/><circle cx="18" cy="5.5" r="2.5"/><path d="M15.5 5.5H10A4 4 0 0 0 6 9.5v6.5"/>',
  external: '<path d="M14 4.5h5.5V10"/><path d="M19.5 4.5 12 12"/><path d="M18 14v4.5a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1v-11a1 1 0 0 1 1-1h4.5"/>',
  terminal: '<rect x="3.5" y="4.5" width="17" height="15" rx="4"/><path d="M7.5 10l2.5 2-2.5 2M12.5 14.5h4"/>',
  menu: '<path d="M4 7h16M4 12h16M4 17h16"/>',
  chevronRight: '<path d="M9.5 6.5l5.5 5.5-5.5 5.5"/>',
  chevronDown: '<path d="M6.5 9.5 12 15l5.5-5.5"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 3v2M12 19v2M3 12h2M19 12h2M5.6 5.6l1.4 1.4M17 17l1.4 1.4M5.6 18.4 7 17M17 7l1.4-1.4"/>',
  sunrise: '<path d="M12 4v4M5.6 9.6 7 11M18.4 9.6 17 11M3 16h3M18 16h3"/><path d="M8 16a4 4 0 0 1 8 0"/><path d="M3.5 19.5h17"/>',
  bed: '<path d="M3.5 8.5v10M3.5 13.5h17v5M20.5 13.5V11a3 3 0 0 0-3-3h-7v5.5"/><circle cx="7" cy="11" r="1.8"/>',
  inbox: '<path d="M3.5 12.5 6 5.5h12l2.5 7v6a1 1 0 0 1-1 1h-15a1 1 0 0 1-1-1Z"/><path d="M3.5 12.5H9l1 2.5h4l1-2.5h5.5"/>',
  key: '<circle cx="8" cy="12" r="3.5"/><path d="M11.5 12H21M17 12v3M20 12v2.5"/>',
  wifi: '<path d="M4.5 9.5a11 11 0 0 1 15 0M7.5 13a7 7 0 0 1 9 0M10.5 16.4a3 3 0 0 1 3 0"/><circle cx="12" cy="19.2" r=".6"/>',
  code: '<path d="M9 7.5 4.5 12 9 16.5M15 7.5 19.5 12 15 16.5"/>',
  star: '<path d="M12 4l2.5 5.2 5.5.8-4 3.9 1 5.6-5-2.7-5 2.7 1-5.6-4-3.9 5.5-.8Z"/>',
  wand: '<path d="M15 4.5 19.5 9 9 19.5H4.5V15Z"/><path d="M12.5 7 17 11.5"/>',
  recycle: '<path d="M7.5 5.5h9l1.5 3"/><path d="M4.5 12.5 7 8.5h10l2.5 4"/><path d="M8.5 18.5h7M6 15.5l-1.5-3M18 15.5l1.5-3"/>',
  globe: '<circle cx="12" cy="12" r="8.5"/><path d="M3.5 12h17M12 3.5c2.4 2.4 3.6 5.3 3.6 8.5S14.4 18.1 12 20.5c-2.4-2.4-3.6-5.3-3.6-8.5S9.6 5.9 12 3.5Z"/>',
  cloudRain: '<path d="M7 15.5a3.6 3.6 0 0 1-.3-7.2 5.2 5.2 0 0 1 10 1.3 3.2 3.2 0 0 1-.7 5.9"/><path d="M8.5 18v1.5M12 17.5v2.5M15.5 18v1.5"/>',
  pin: '<path d="M12 21s6-5.2 6-10a6 6 0 1 0-12 0c0 4.8 6 10 6 10Z"/><circle cx="12" cy="11" r="2.4"/>',
  thermometer: '<path d="M14 13.5V5.5a2 2 0 1 0-4 0v8a4 4 0 1 0 4 0Z"/><path d="M12 9.5V17"/>',
  sliders: '<path d="M4.5 8h9M17.5 8h2M4.5 16h3M11.5 16h8"/><circle cx="15.5" cy="8" r="2"/><circle cx="9.5" cy="16" r="2"/>',
  dot: '<circle cx="12" cy="12" r="3.5"/>',
};

export const ICONS = P;
export const ICON_NAMES = Object.keys(P);

/**
 * 生成一个内联 SVG 图标。
 * @param {string} name ICONS 里的名字
 * @param {number} size 像素尺寸
 */
export function icon(name, size = 20) {
  const path = P[name] ?? P.dot;
  return `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${path}</svg>`;
}

export function brandMark(size = 24) {
  return `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <path d="M12 20.2S4.8 15.8 4.8 10.9A4.1 4.1 0 0 1 12 8.1a4.1 4.1 0 0 1 7.2 2.8c0 4.9-7.2 9.3-7.2 9.3Z"/>
    <path d="M16.4 3.6l.7 1.9 1.9.7-1.9.7-.7 1.9-.7-1.9-1.9-.7 1.9-.7Z"/>
  </svg>`;
}
