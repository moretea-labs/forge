export type Mode = 'mcp' | 'local';
export type Scope = 'assistant' | 'projects';
export type WorkState = 'active' | 'blocked' | 'planned' | 'done';
export type Work = { id:string; title:string; summary:string; state:WorkState; repository:string; plan?:string; requirement?:string; parentId?:string; dependsOn?:string[]; updatedAt:string; evidence?:string[] };
export type Project = { id:string; name:string; path:string; branch:string; work:Work[] };
export type Snapshot = { runtime:'ready'|'offline'|'attention'; runtimeLabel:string; projects:Project[]; assistant:Work[]; source:'live'|'preview' };

const preview:Snapshot = { runtime:'offline', runtimeLabel:'Forge Runtime not connected', source:'preview', projects:[
  { id:'forge', name:'Forge', path:'/Users/greyson/.codex/worktrees/d0a2/forge', branch:'codex/v3-desktop-client', work:[
    { id:'w-v3', title:'Develop V3 desktop client', summary:'MCP-first client with Assistant, Projects and canonical Work tree.', state:'active', repository:'Forge', plan:'PLAN-forge-v3-desktop-client-20260930-r1 · revision 8', updatedAt:'Just now', evidence:['Branch codex/v3-desktop-client','Plan revision 8'] },
    { id:'w-relations', title:'Add thin Work relations', summary:'Semantic parent and dependency edges for Work projections.', state:'planned', repository:'Forge', parentId:'w-v3', dependsOn:[], updatedAt:'Today' },
    { id:'w-shell', title:'Build independent desktop foundation', summary:'OS-neutral renderer with a macOS-first native shell boundary.', state:'active', repository:'Forge', parentId:'w-v3', dependsOn:['w-relations'], updatedAt:'Today' },
  ] },
], assistant:[{ id:'assistant-1', title:'Review pending decisions', summary:'Assistant-global Work can exist without a project, Requirement or Plan.', state:'planned', repository:'Assistant', updatedAt:'Today' }] };

async function json<T>(path:string):Promise<T>{ const token=import.meta.env.VITE_FORGE_LOCAL_BRIDGE_TOKEN; const response=await fetch(path,{credentials:'same-origin',headers:token?{'x-forge-local-token':token}:undefined}); if(!response.ok) throw new Error(`HTTP ${response.status}`); return response.json() as Promise<T>; }
export async function loadSnapshot():Promise<Snapshot>{
  // The packaged client talks to the canonical Local Bridge. The standalone
  // dev shell intentionally stays useful before Runtime is installed; opt in
  // to live probing with VITE_FORGE_LIVE=1.
  const liveRequested = import.meta.env.VITE_FORGE_LIVE === '1' || new URLSearchParams(location.search).get('live') === '1';
  if (!liveRequested) return preview;
  try {
    const bootstrap = await json<any>('/api/client/v3/bootstrap');
    const center = { repositories: bootstrap.repositories ?? [] };
    const portfolio = { items: bootstrap.work ?? [] };
    const projects = (center.repositories ?? []).map((repo:any):Project => ({ id:repo.id, name:repo.name, path:repo.path ?? '', branch:repo.branchLabel ?? 'working tree', work:(portfolio.items ?? []).filter((item:any)=>item.repoId===repo.id).map((item:any):Work=>({ id:item.id, title:item.title, summary:item.latestSummary ?? item.objective, state:item.advanced?.status==='blocked'?'blocked':item.advanced?.status==='completed'?'done':'active', repository:repo.name, updatedAt:item.updatedAt ?? 'recent', plan:item.advanced?.planId ?? item.plan, requirement:item.advanced?.requirementId, parentId:item.advanced?.semanticParentWorkId, dependsOn:item.advanced?.dependsOnWorkIds ?? [], evidence:item.latestVerification ? ['Latest verification available'] : undefined })) }));
    const runtimeStatus = String(bootstrap.runtime?.status ?? 'unavailable');
    const runtime = runtimeStatus === 'ready' ? 'ready' : runtimeStatus === 'starting' ? 'attention' : 'offline';
    return { runtime, runtimeLabel:runtime === 'ready' ? 'Forge Runtime ready' : runtime === 'attention' ? 'Forge Runtime starting' : 'Forge Runtime unavailable', projects, assistant:preview.assistant, source:'live' };
  } catch { return preview; }
}
