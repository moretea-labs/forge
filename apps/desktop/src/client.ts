export type Mode = 'mcp' | 'local';
export type Scope = 'assistant' | 'projects';
export type WorkState = 'active' | 'blocked' | 'planned' | 'done';
export type Work = { id:string; title:string; summary:string; state:WorkState; repository:string; plan?:string; requirement?:string; parentId?:string; dependsOn?:string[]; updatedAt:string; evidence?:string[]; statusLabel?:string; phase?:string; nextAction?:string; latestAction?:string; acceptanceCriteria?:string[]; evidenceLabels?:string[]; changedFiles?:{count:number; examples:string[]}; error?:{title:string; explanation:string; nextActions:string[]}; };
export type Project = { id:string; name:string; path:string; branch:string; work:Work[] };
export type ProviderConnection = { id:string; label:string; configured:boolean; status:'ready'|'login_required'|'failed'|'not_configured'; nextAction:string };
export type Snapshot = { runtime:'ready'|'offline'|'attention'; runtimeLabel:string; projects:Project[]; assistant:Work[]; provider?:ProviderConnection; source:'live'|'preview'|'native' };
export type LocalMessage = { id:string; role:'user'|'assistant'|'system'; content:string; createdAt:string };
export type LocalThread = { id:string; title:string; projectId?:string; providerSessionId?:string; createdAt:string; updatedAt:string; archived:boolean; messages:LocalMessage[] };

const LOCAL_THREADS_KEY = 'forge.v3.local-conversations.v1';
const localId = () => globalThis.crypto?.randomUUID?.() ?? `local-${Date.now()}-${Math.random().toString(36).slice(2)}`;
const now = () => new Date().toISOString();
type NativeRecoveryResult = { ok:boolean; operation:string; payload:{runtime?:{ready?:boolean;running?:boolean;stale?:boolean;reasonCodes?:string[]}} };
type TauriWindow = Window & { __TAURI_INTERNALS__?: { invoke(command:string,args?:Record<string,unknown>):Promise<unknown> } };

export const isNativeDesktop = () => typeof window !== 'undefined' && Boolean((window as TauriWindow).__TAURI_INTERNALS__?.invoke);
async function nativeInvoke<T>(command:string,args?:Record<string,unknown>):Promise<T|undefined>{ const invoke=(window as TauriWindow).__TAURI_INTERNALS__?.invoke; return invoke ? await invoke(command,args) as T : undefined; }
export async function nativeRecoveryStatus():Promise<NativeRecoveryResult|undefined>{ return nativeInvoke<NativeRecoveryResult>('recovery_status'); }
export async function restartNativeRuntime():Promise<NativeRecoveryResult|undefined>{ return nativeInvoke<NativeRecoveryResult>('recovery_restart_runtime'); }
async function nativeBootstrap():Promise<any|undefined>{ return nativeInvoke<any>('local_bridge_bootstrap'); }
export async function startNativeWork(objective:string):Promise<any|undefined>{ return nativeInvoke<any>('local_bridge_start_work',{objective}); }
export async function connectNativeProvider():Promise<any|undefined>{ return nativeInvoke<any>('local_bridge_connect_provider'); }
export async function sendNativeLocalMessage(prompt:string,sessionId?:string):Promise<any|undefined>{ return nativeInvoke<any>('local_bridge_local_message',{prompt,...(sessionId?{sessionId}:{})}); }

export function loadLocalThreads():LocalThread[]{
  try {
    const raw = localStorage.getItem(LOCAL_THREADS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((thread):thread is LocalThread => Boolean(thread && typeof thread === 'object' && typeof (thread as LocalThread).id === 'string' && Array.isArray((thread as LocalThread).messages))).sort((a,b)=>b.updatedAt.localeCompare(a.updatedAt));
  } catch { return []; }
}

export function persistLocalThreads(threads:LocalThread[]):void{ localStorage.setItem(LOCAL_THREADS_KEY, JSON.stringify(threads.slice(0, 100))); }
export function createLocalThread(projectId?:string):LocalThread{ const timestamp=now(); return { id:localId(), title:'New conversation', ...(projectId?{projectId}:{}), createdAt:timestamp, updatedAt:timestamp, archived:false, messages:[] }; }

const preview:Snapshot = { runtime:'offline', runtimeLabel:'Forge Runtime not connected', source:'preview', projects:[
  { id:'forge', name:'Forge', path:'/Users/greyson/.codex/worktrees/d0a2/forge', branch:'codex/v3-desktop-client', work:[
    { id:'w-v3', title:'Develop V3 desktop client', summary:'MCP-first client with Assistant, Projects and canonical Work tree.', state:'active', repository:'Forge', plan:'PLAN-forge-v3-desktop-client-20260930-r1 · revision 8', updatedAt:'Just now', evidence:['Branch codex/v3-desktop-client','Plan revision 8'] },
    { id:'w-relations', title:'Add thin Work relations', summary:'Semantic parent and dependency edges for Work projections.', state:'planned', repository:'Forge', parentId:'w-v3', dependsOn:[], updatedAt:'Today' },
    { id:'w-shell', title:'Build independent desktop foundation', summary:'OS-neutral renderer with a macOS-first native shell boundary.', state:'active', repository:'Forge', parentId:'w-v3', dependsOn:['w-relations'], updatedAt:'Today' },
  ] },
], assistant:[{ id:'assistant-1', title:'Review pending decisions', summary:'Assistant-global Work can exist without a project, Requirement or Plan.', state:'planned', repository:'Assistant', updatedAt:'Today' }] };

async function json<T>(path:string):Promise<T>{ const token=import.meta.env.VITE_FORGE_LOCAL_BRIDGE_TOKEN; const response=await fetch(path,{credentials:'same-origin',headers:token?{'x-forge-local-token':token}:undefined}); if(!response.ok) throw new Error(`HTTP ${response.status}`); return response.json() as Promise<T>; }
export async function startLiveWork(objective:string):Promise<any>{ const token=import.meta.env.VITE_FORGE_LOCAL_BRIDGE_TOKEN; const response=await fetch('/api/console/work/start',{method:'POST',credentials:'same-origin',headers:{'content-type':'application/json',...(token?{'x-forge-local-token':token}: {})},body:JSON.stringify({objective,scopeClear:true})}); if(!response.ok) throw new Error(`HTTP ${response.status}`); return response.json(); }
export async function connectLiveProvider():Promise<any>{ const token=import.meta.env.VITE_FORGE_LOCAL_BRIDGE_TOKEN; const response=await fetch('/api/client/v3/provider/connect',{method:'POST',credentials:'same-origin',headers:{...(token?{'x-forge-local-token':token}: {})}}); const body=await response.json(); if(!response.ok) throw new Error(body.error ?? `HTTP ${response.status}`); return body; }
export async function sendLiveLocalMessage(prompt:string,sessionId?:string):Promise<any>{ const token=import.meta.env.VITE_FORGE_LOCAL_BRIDGE_TOKEN; const response=await fetch('/api/client/v3/local/message',{method:'POST',credentials:'same-origin',headers:{'content-type':'application/json',...(token?{'x-forge-local-token':token}: {})},body:JSON.stringify({prompt,...(sessionId?{sessionId}:{})})}); const body=await response.json(); if(!response.ok) throw new Error(body.error ?? `HTTP ${response.status}`); return body; }
function runtimeSnapshot(recovery:NativeRecoveryResult):Snapshot { const runtime=recovery.payload.runtime; const ready=runtime?.ready===true && runtime.running!==false && runtime.stale!==true; return {...preview,runtime:ready?'ready':runtime?.running?'attention':'offline',runtimeLabel:ready?'Forge Runtime ready':runtime?.running?'Forge Runtime starting':'Forge Runtime unavailable',source:'native'}; }
function bootstrapSnapshot(bootstrap:any, source:'live'|'native'):Snapshot {
  const repositories=bootstrap.repositories ?? [];
  const items=bootstrap.work ?? [];
  const mapWork=(item:any, repository:string):Work=>({ id:item.id, title:item.title, summary:item.latestSummary ?? item.objective, state:item.advanced?.status==='blocked'?'blocked':(item.advanced?.status==='completed'||item.advanced?.status==='cancelled')?'done':'active', repository, updatedAt:item.updatedAt ?? 'recent', plan:item.advanced?.planId ?? item.plan, requirement:item.advanced?.requirementId, parentId:item.advanced?.semanticParentWorkId, dependsOn:item.advanced?.dependsOnWorkIds ?? [], statusLabel:item.statusLabel, phase:item.phase, nextAction:item.nextAction, latestAction:item.latestAction, acceptanceCriteria:item.acceptanceCriteria, evidenceLabels:item.evidenceLabels, evidence:item.latestVerification ? ['Latest verification available'] : undefined, changedFiles:item.changedFiles ? { count:item.changedFiles.count ?? 0, examples:item.changedFiles.examples ?? [] } : undefined, error:item.error ? { title:item.error.title, explanation:item.error.explanation, nextActions:item.error.nextActions ?? [] } : undefined });
  const projects=repositories.map((repo:any):Project=>({ id:repo.id, name:repo.name, path:repo.path ?? '', branch:repo.branchLabel ?? 'working tree', work:items.filter((item:any)=>item.repoId===repo.id).map((item:any)=>mapWork(item,repo.name)) }));
  const runtimeStatus=String(bootstrap.runtime?.status ?? 'unavailable');
  const runtime=runtimeStatus==='ready'?'ready':runtimeStatus==='starting'?'attention':'offline';
  return { runtime, runtimeLabel:runtime==='ready'?'Forge Runtime ready':runtime==='attention'?'Forge Runtime starting':'Forge Runtime unavailable', projects, assistant:preview.assistant, provider:bootstrap.provider, source };
}

export async function loadSnapshot():Promise<Snapshot>{
  const nativeRecovery=isNativeDesktop()?await nativeRecoveryStatus().catch(()=>undefined):undefined;
  const nativeData=isNativeDesktop()?await nativeBootstrap().catch(()=>undefined):undefined;
  const liveRequested=import.meta.env.VITE_FORGE_LIVE==='1' || new URLSearchParams(location.search).get('live')==='1';
  if(nativeData) return bootstrapSnapshot(nativeData,'native');
  if(!liveRequested && nativeRecovery) return runtimeSnapshot(nativeRecovery);
  if(!liveRequested) return preview;
  try { return bootstrapSnapshot(await json<any>('/api/client/v3/bootstrap'),'live'); }
  catch { return nativeRecovery ? runtimeSnapshot(nativeRecovery) : preview; }
}
