import './styles.css';
import { api } from './api';
import { esc, routeItems } from './components';
import type { ConsoleData, RouteId } from './types';
import { renderOverview } from './views/overview'; import { renderWork } from './views/work'; import { renderAutomations } from './views/automations'; import { renderCapabilities } from './views/capabilities'; import { renderRepositories } from './views/repositories'; import { renderSettings } from './views/settings'; import { renderSystem } from './views/system';

const root=document.getElementById('app'); if(!root)throw new Error('Forge console root missing');
let data: ConsoleData | undefined; let busy=false; let selectedCapability='';
function route(): RouteId { const id=location.hash.replace(/^#\/?/,'').split('/')[0] as RouteId; return routeItems.some(r=>r.id===id)?id:'overview'; }
function shell(content: string): string { const current=route(); let separated=false; const nav=routeItems.map(item=>{ const sep=item.secondary&&!separated?(separated=true,'<div class="nav-separator"></div>'):''; return `${sep}<a href="#/${item.id}" class="${current===item.id?'active':''}"><span class="nav-icon">${item.icon}</span>${item.label}</a>`; }).join(''); return `<div class="shell"><aside class="sidebar"><div class="brand"><span class="brand-mark">F</span>Forge</div><nav class="nav">${nav}</nav></aside><main class="main"><div class="topbar"><button class="icon-btn" data-refresh ${busy?'disabled':''}>${busy?'Refreshing…':'Refresh'}</button><a class="btn" href="https://chatgpt.com" target="_blank" rel="noreferrer">ChatGPT ↗</a></div><div class="content">${content}</div></main></div>`; }
function view(): string { if(!data)return '<div class="boot-state">正在读取 Forge 配置…</div>'; switch(route()){case'work':return renderWork(data);case'automations':return renderAutomations(data);case'capabilities':return renderCapabilities(data,selectedCapability);case'repositories':return renderRepositories(data);case'settings':return renderSettings(data);case'system':return renderSystem(data);default:return renderOverview(data);} }
function render(){root!.innerHTML=data?shell(view()):view();bind();}
async function refresh(){ if(busy)return; busy=true; render(); try{ const [commandCenter,work,automations,automationSettings,connector]=await Promise.all([api.commandCenter(),api.work(),api.automations(),api.automationSettings().catch(()=>({})),api.connector().catch(()=>({}))]); data={commandCenter,work,automations,automationSettings,connector}; }catch(error){ root!.innerHTML=`<div class="boot-state"><strong>Forge console unavailable</strong><div>${esc(error instanceof Error?error.message:error)}</div><button class="btn" data-refresh>Retry</button></div>`; }finally{busy=false; render();} }
async function act(run:()=>Promise<unknown>){
  if(busy)return;
  busy=true;render();
  try{await run();busy=false;await refresh();}
  catch(error){busy=false;alert(error instanceof Error?error.message:String(error));render();}
}
function bind(){root!.querySelectorAll<HTMLElement>('[data-refresh]').forEach(el=>el.onclick=()=>void refresh()); root!.querySelectorAll<HTMLElement>('[data-select-capability]').forEach(el=>el.onclick=()=>{selectedCapability=el.dataset.selectCapability??'';render();});
 root!.querySelectorAll<HTMLButtonElement>('[data-automation-action]').forEach(el=>el.onclick=()=>void act(()=>api.automationAction(el.dataset.source??'',el.dataset.repo??'',el.dataset.id??'',el.dataset.automationAction??'')));
 root!.querySelectorAll<HTMLButtonElement>('[data-provider-action]').forEach(el=>el.onclick=()=>void act(()=>api.providerAction(el.dataset.providerId??'',el.dataset.providerAction as 'enable'|'disable')));
 root!.querySelectorAll<HTMLButtonElement>('[data-provider-health]').forEach(el=>el.onclick=()=>void act(()=>api.providerHealth(el.dataset.providerHealth??'')));
 root!.querySelectorAll<HTMLButtonElement>('[data-tool-action]').forEach(el=>el.onclick=()=>void act(()=>api.localToolAction(el.dataset.toolId??'',el.dataset.toolAction as 'enable'|'disable')));
 root!.querySelectorAll<HTMLButtonElement>('[data-tool-health]').forEach(el=>el.onclick=()=>void act(()=>api.localToolHealth(el.dataset.toolHealth??'')));
 const add=root!.querySelector<HTMLButtonElement>('[data-register-repo]'); if(add)add.onclick=()=>{const path=(root!.querySelector<HTMLInputElement>('#repo-path')?.value??'').trim();const name=(root!.querySelector<HTMLInputElement>('#repo-name')?.value??'').trim();if(path)void act(()=>api.registerRepository(path,name||undefined));};
 root!.querySelectorAll<HTMLButtonElement>('[data-remove-repo]').forEach(el=>el.onclick=()=>{const name=el.dataset.repoName??'repository';if(confirm(`Remove ${name} from Forge registry?`))void act(()=>api.removeRepository(el.dataset.removeRepo??''));});
 const adv=root!.querySelector<HTMLButtonElement>('[data-load-advanced]');
 if(adv)adv.onclick=()=>void (async()=>{
   if(busy)return;
   busy=true;adv.disabled=true;adv.textContent='Loading…';
   try{const payload=await api.advanced();const target=root!.querySelector('#advanced-system');if(target)target.innerHTML=`<div class="surface detail"><details class="advanced" open><summary>Raw diagnostics</summary><pre>${esc(JSON.stringify(payload,null,2))}</pre></details></div>`;}
   catch(error){alert(error instanceof Error?error.message:String(error));}
   finally{busy=false;adv.disabled=false;adv.textContent='Load diagnostics';}
 })(); }
window.addEventListener('hashchange',render); void refresh();
