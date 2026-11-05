// 선 아이콘 (16px, 1.75 선). 필요한 것만 직접 그린다.
import type { JSX } from 'preact';

const base = (d: JSX.Element, cls = 'icon') => (
  <svg class={cls} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">{d}</svg>
);

export const IconLogo = () => base(<><rect x="4" y="4" width="7" height="7" rx="1.5" /><rect x="13" y="4" width="7" height="7" rx="1.5" /><rect x="4" y="13" width="7" height="7" rx="1.5" /><path d="M16.5 13v7M13 16.5h7" /></>, 'icon');
export const IconLaunch = () => base(<><path d="M5 19c1.5-4 4.5-7.5 9-10l3-3 2 2-3 3c-2.5 4.5-6 7.5-10 9" /><path d="M9 15l-3 3" /><circle cx="14.5" cy="9.5" r="1" /></>);
export const IconCalendar = () => base(<><rect x="4" y="5" width="16" height="15" rx="2" /><path d="M8 3v4M16 3v4M4 10h16" /></>);
export const IconSliders = () => base(<><path d="M4 7h10M18 7h2M4 17h4M12 17h8" /><circle cx="16" cy="7" r="2" /><circle cx="10" cy="17" r="2" /></>);
export const IconCheck = () => base(<><circle cx="12" cy="12" r="8" /><path d="M8.5 12.5l2.5 2.5 4.5-5" /></>);
export const IconAlert = () => base(<><path d="M12 4l9 16H3z" /><path d="M12 10v4M12 17.5v.01" /></>);
export const IconFolder = () => base(<><path d="M4 7a2 2 0 0 1 2-2h4l2 2h6a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2z" /></>);
export const IconSave = () => base(<><path d="M5 5h11l3 3v11H5z" /><path d="M8 5v5h7V5M8 19v-5h8v5" /></>);
export const IconPlus = () => base(<><path d="M12 5v14M5 12h14" /></>);
export const IconX = () => base(<><path d="M6 6l12 12M18 6L6 18" /></>);
export const IconSpark = () => base(<><path d="M12 4v4M12 16v4M4 12h4M16 12h4M7 7l2 2M15 15l2 2M17 7l-2 2M9 15l-2 2" /></>);
export const IconUsers = () => base(<><circle cx="9" cy="9" r="3" /><path d="M3.5 19c.8-3 3-4.5 5.5-4.5s4.7 1.5 5.5 4.5" /><path d="M15.5 6.5a3 3 0 0 1 0 5.5M17 14.7c1.7.5 3 1.9 3.5 4.3" /></>);
export const IconProgress = () => base(<><path d="M4 19h16" /><path d="M7 15v-3M12 15V8M17 15v-6" /></>);
export const IconHistory = () => base(<><path d="M4 12a8 8 0 1 0 2.3-5.6L4 8.7" /><path d="M4 4v4.7h4.7" /><path d="M12 8v4l3 2" /></>);
export const IconDownload = () => base(<><path d="M12 4v11M7 10l5 5 5-5" /><path d="M5 19h14" /></>);
export const IconTune = () => base(<><path d="M4 6h9M17 6h3M4 12h3M11 12h9M4 18h11M19 18h1" /><circle cx="15" cy="6" r="2" /><circle cx="9" cy="12" r="2" /><circle cx="17" cy="18" r="2" /></>);
export const IconLayers = () => base(<><path d="M12 4l8 4-8 4-8-4z" /><path d="M4 12l8 4 8-4" /><path d="M4 16l8 4 8-4" /></>);
export const IconLock = () => base(<><rect x="5" y="11" width="14" height="9" rx="2" /><path d="M8 11V8a4 4 0 0 1 8 0v3" /></>);
