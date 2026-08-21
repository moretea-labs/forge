import{useMemo,useState}from'react';
import type{ConsoleData,PluginView}from'../../types';
import{CommandBar}from'../../shell/CommandBar';
import{Segmented}from'../../components/Segmented';
import{DetailPane,DefinitionList}from'../../components/DetailPane';
import{StatusText}from'../../components/StatusText';
import{compact,pretty}from'../../lib/format';

type Filter='all'|'extensions'|'services'|'execution';

function category(plugin:PluginView):Exclude<Filter,'all'>{
  const text=`${plugin.name} ${plugin.provider} ${(plugin.capabilityLabels??[]).join(' ')}`.toLowerCase();
  if(/gmail|calendar|github|google task|notion/.test(text))return'services';
  if(/browser|desktop|ios|repository|codegraph|local/.test(text))return'execution';
  return'extensions';
}

export function CapabilitiesView({data,busy,onRefresh}:{data:ConsoleData;busy:boolean;onRefresh:()=>void}){
  const plugins=data.commandCenter.plugins??[];
  const[filter,setFilter]=useState<Filter>('all');
  const[selectedId,setSelectedId]=useState<string>();
  const filtered=useMemo(()=>plugins.filter(plugin=>filter==='all'||category(plugin)===filter),[plugins,filter]);
  const selected=filtered.find(plugin=>plugin.id===selectedId)??filtered[0];
  return <>
    <CommandBar eyebrow="CAPABILITY CATALOG" title="Capabilities" description="从“Forge 能做什么”查看扩展、服务与执行能力，而不是浏览 MCP tool 清单。" refreshedAt={data.generatedAt} busy={busy} onRefresh={onRefresh}/>
    <div className="toolbar"><Segmented value={filter} onChange={setFilter} items={[
      {id:'all',label:'All',count:plugins.length},
      {id:'extensions',label:'Extensions',count:plugins.filter(plugin=>category(plugin)==='extensions').length},
      {id:'services',label:'Services',count:plugins.filter(plugin=>category(plugin)==='services').length},
      {id:'execution',label:'Execution',count:plugins.filter(plugin=>category(plugin)==='execution').length},
    ]}/></div>
    <div className="split-workspace">
      <div className="scan-list">{filtered.map(plugin=><button key={plugin.id} className={`scan-row ${selected?.id===plugin.id?'selected':''}`} onClick={()=>setSelectedId(plugin.id)}><div className="scan-main"><span className="row-eyebrow">{category(plugin).toUpperCase()}</span><strong>{plugin.name}</strong><p>{compact(plugin.description,100)}</p></div><StatusText label={plugin.statusLabel??plugin.status??'Unknown'} tone={plugin.status??plugin.tone}/></button>)}</div>
      <DetailPane title={selected?.name} subtitle={selected?.description}>{selected&&<><DefinitionList items={[["Status",<StatusText label={selected.statusLabel??selected.status??'Unknown'} tone={selected.status??selected.tone}/>],["Provider",selected.provider??'—'],["Health",selected.healthLabel??'—'],["Lifecycle",selected.lifecycleLabel??'—']]}/>{selected.nextStep&&<div className="detail-callout warning"><strong>Next step</strong><p>{selected.nextStep}</p></div>}{(selected.capabilityLabels??[]).length>0&&<div className="capability-lines">{selected.capabilityLabels!.map(label=><span key={label}>{label}</span>)}</div>}{(selected.warnings??[]).map(warning=><div className="detail-callout warning" key={warning}>{warning}</div>)}<details className="advanced"><summary>Advanced · actions & protocol</summary><pre>{pretty({actions:selected.actions,advanced:selected.advanced})}</pre></details></>}</DetailPane>
    </div>
  </>;
}
