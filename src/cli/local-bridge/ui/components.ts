import type { RouteId } from './types';
export const routeItems: Array<{id: RouteId; label: string; icon: string; secondary?: boolean}> = [
  { id:'overview', label:'Overview', icon:'⌂' }, { id:'work', label:'Work', icon:'◇' }, { id:'automations', label:'Automations', icon:'↻' },
  { id:'capabilities', label:'Capabilities', icon:'◈' }, { id:'repositories', label:'Repositories', icon:'▱' }, { id:'settings', label:'Settings', icon:'⚙' },
  { id:'system', label:'System', icon:'◎', secondary:true },
];
export function esc(v: unknown): string { return String(v ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c] ?? c)); }
export function tone(v?: unknown): 'success'|'warning'|'danger'|'neutral' { const s=String(v??'').toLowerCase(); if(/ready|healthy|success|succeeded|enabled|connected|detected|green|ok/.test(s))return 'success'; if(/fail|error|blocked|red|offline|unavailable/.test(s))return 'danger'; if(/pause|wait|attention|warning|amber|setup|degraded|restricted|missing/.test(s))return 'warning'; return 'neutral'; }
export function status(label: string, state?: unknown, detail?: string): string { return `<span class="status"><i class="dot ${tone(state??label)}"></i><span>${esc(label)}</span>${detail?`<small>${esc(detail)}</small>`:''}</span>`; }
export function header(title: string, description: string, action=''): string { return `<header class="page-head"><div><h1>${esc(title)}</h1><p>${esc(description)}</p></div>${action}</header>`; }
export function empty(title: string, body: string): string { return `<div class="empty"><strong>${esc(title)}</strong><span>${esc(body)}</span></div>`; }
export function advanced(value: unknown, label='Advanced'): string { return `<details class="advanced"><summary>${esc(label)}</summary><pre>${esc(JSON.stringify(value??{},null,2))}</pre></details>`; }
export function fmtDate(v?: string): string { if(!v)return '—'; const d=new Date(v); return Number.isNaN(d.valueOf())?v:new Intl.DateTimeFormat('zh-CN',{month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'}).format(d); }
