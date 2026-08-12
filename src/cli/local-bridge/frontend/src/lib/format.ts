export function formatDate(value?:string):string{if(!value)return '—';const d=new Date(value);if(Number.isNaN(d.getTime()))return value;return new Intl.DateTimeFormat('zh-CN',{month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false}).format(d);}
export function compact(value?:string,max=86):string{const s=(value??'').trim();return s.length>max?`${s.slice(0,max-1)}…`:s;}
export function asText(value:unknown,fallback='—'):string{return typeof value==='string'&&value.trim()?value:String(value??fallback);}
export function pretty(value:unknown):string{return JSON.stringify(value??{},null,2);}
