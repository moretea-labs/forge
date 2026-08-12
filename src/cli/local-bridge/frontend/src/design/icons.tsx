import type { SVGProps } from 'react';
function Icon({children,...props}:SVGProps<SVGSVGElement>){return <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.55" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...props}>{children}</svg>}
export const OverviewIcon=(p:SVGProps<SVGSVGElement>)=><Icon {...p}><path d="M3 9.2 10 3l7 6.2v7.1a.7.7 0 0 1-.7.7h-4.2v-5H7.9v5H3.7a.7.7 0 0 1-.7-.7z"/></Icon>;
export const AutomationIcon=(p:SVGProps<SVGSVGElement>)=><Icon {...p}><path d="M4.2 6.3A6.5 6.5 0 0 1 16 7"/><path d="m16 3 .4 4.4-4.4.4"/><path d="M15.8 13.7A6.5 6.5 0 0 1 4 13"/><path d="m4 17-.4-4.4 4.4-.4"/></Icon>;
export const WorkIcon=(p:SVGProps<SVGSVGElement>)=><Icon {...p}><path d="M4 5.2h12v10.6H4z"/><path d="M7 5.2V3.6h6v1.6M7 9h6M7 12h4"/></Icon>;
export const CapabilityIcon=(p:SVGProps<SVGSVGElement>)=><Icon {...p}><path d="m10 2.8 2 4 4.4.7-3.2 3.1.8 4.4-4-2.1L6 15l.8-4.4-3.2-3.1L8 6.8z"/></Icon>;
export const RepoIcon=(p:SVGProps<SVGSVGElement>)=><Icon {...p}><path d="M4 3.5h5l1.4 2H16v11H4z"/><path d="M4 8h12"/></Icon>;
export const SettingsIcon=(p:SVGProps<SVGSVGElement>)=><Icon {...p}><circle cx="10" cy="10" r="2.5"/><path d="M10 2.8v2M10 15.2v2M2.8 10h2M15.2 10h2M4.9 4.9l1.4 1.4M13.7 13.7l1.4 1.4M15.1 4.9l-1.4 1.4M6.3 13.7l-1.4 1.4"/></Icon>;
export const SystemIcon=(p:SVGProps<SVGSVGElement>)=><Icon {...p}><path d="M3.2 4.5h13.6v9.2H3.2z"/><path d="M7 17h6M10 13.7V17"/></Icon>;
export const RefreshIcon=(p:SVGProps<SVGSVGElement>)=><Icon {...p}><path d="M15.5 6A6 6 0 1 0 16 12"/><path d="m15.5 2.8.3 3.7-3.7.2"/></Icon>;
export const SearchIcon=(p:SVGProps<SVGSVGElement>)=><Icon {...p}><circle cx="8.8" cy="8.8" r="5"/><path d="m12.5 12.5 4 4"/></Icon>;
