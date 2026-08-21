import type { AutomationsResponse, CommandCenterView, Dict, WorkPortfolioResponse, WorkResponse } from '../types';
export class ApiError extends Error { constructor(message:string, readonly status:number, readonly payload:unknown){super(message);} }
const CONSOLE_REQUEST_TIMEOUT_MS=15_000;
export async function requestJson<T>(path:string,init:RequestInit={}):Promise<T>{
  const headers=new Headers(init.headers);if(init.body&&!headers.has('content-type'))headers.set('content-type','application/json');
  const controller=new AbortController();let timedOut=false;const callerSignal=init.signal;const abortFromCaller=()=>controller.abort();
  if(callerSignal){if(callerSignal.aborted)abortFromCaller();else callerSignal.addEventListener('abort',abortFromCaller,{once:true});}
  const timer=setTimeout(()=>{timedOut=true;controller.abort();},CONSOLE_REQUEST_TIMEOUT_MS);
  try{
    const response=await fetch(path,{...init,headers,signal:controller.signal,credentials:'same-origin'});let payload:unknown={};try{payload=await response.json();}catch{}
    if(!response.ok){const r=payload&&typeof payload==='object'?payload as Dict:{};const message=typeof r.error==='string'?r.error:typeof r.message==='string'?r.message:`Request failed (${response.status})`;throw new ApiError(message,response.status,payload);}
    return payload as T;
  }catch(error){
    if(timedOut)throw new Error('Forge Runtime 暂时没有响应。请在连接恢复后重试。');
    throw error;
  }finally{
    clearTimeout(timer);callerSignal?.removeEventListener('abort',abortFromCaller);
  }
}
export const api={
  commandCenter:()=>requestJson<CommandCenterView>('/api/console/command-center'),
  work:()=>requestJson<WorkResponse>('/api/console/requirements'),
  workPortfolio:()=>requestJson<WorkPortfolioResponse>('/api/console/work-portfolio'),
  automations:()=>requestJson<AutomationsResponse>('/api/console/automations'),
  connector:()=>requestJson<Dict>('/api/console/connector/status'),
  advanced:()=>requestJson<Dict>('/api/console/advanced'),
  automationAction:(source:string,repoId:string,id:string,action:string)=>requestJson<Dict>(`/api/console/automations/${encodeURIComponent(source)}/${encodeURIComponent(repoId)}/${encodeURIComponent(id)}/${encodeURIComponent(action)}`,{method:'POST',body:'{}'}),
  registerRepository:(path:string,displayName?:string)=>requestJson<Dict>('/api/repositories/register',{method:'POST',body:JSON.stringify({path,displayName})}),
  removeRepository:(id:string)=>requestJson<Dict>(`/api/repositories/${encodeURIComponent(id)}/remove`,{method:'POST',body:'{}'}),
};
