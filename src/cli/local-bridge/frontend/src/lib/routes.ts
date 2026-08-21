import type { RouteId } from '../types';
export const routes:{id:RouteId;label:string;group:'daily'|'manage'|'system'}[]=[
  {id:'overview',label:'Overview',group:'daily'}, {id:'automations',label:'Automations',group:'daily'}, {id:'work',label:'Work',group:'daily'},
  {id:'capabilities',label:'Capabilities',group:'manage'}, {id:'repositories',label:'Repositories',group:'manage'},
  {id:'system',label:'System',group:'system'},
];
export function routeFromHash():RouteId{const id=location.hash.replace(/^#\/?/,'').split('/')[0] as RouteId;return routes.some(r=>r.id===id)?id:'overview';}
