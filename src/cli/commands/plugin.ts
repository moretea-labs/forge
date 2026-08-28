import { spawnSync } from 'child_process';
import { randomUUID } from 'crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync } from 'fs';
import { dirname, isAbsolute, join, resolve, sep } from 'path';
import { fileURLToPath } from 'url';
import { Command } from 'commander';
import { resolveControllerHome, controllerSystemRoot } from '../repositories/controller-home';
import { installExternalPluginRegistration, listExternalPluginRegistrations, type ExternalPluginRegistration, type ExternalPluginRegistrationInput } from '../../runtime/plugins/external-registration';
import { createDesktopOperatorRegistrationInput } from '../../runtime/plugins/desktop-operator-registration';
import { controllerPluginRepository, getAssistantPluginManifest, syncAssistantPluginRegistry } from '../../runtime/plugins/store';

export interface RegistryEntry { id:string; name:string; version:string; description:string; repository:string; ref:string; installer:string; providerVersion?:string; protocolVersion?:string; platforms:NodeJS.Platform[]; }
interface Registry { schemaVersion:1; plugins:RegistryEntry[]; }
interface CliOptions { json?:boolean; controllerHome?:string; refresh?:boolean; }
const packageRoot=resolve(dirname(fileURLToPath(import.meta.url)),'../../..');
const registryPath=join(packageRoot,'assets','plugin-registry.v1.json');

function registry():Registry{
  const value=JSON.parse(readFileSync(registryPath,'utf8')) as Registry;
  if(value.schemaVersion!==1||!Array.isArray(value.plugins))throw new Error('PLUGIN_CATALOG_INVALID');
  const ids=new Set<string>();
  for(const plugin of value.plugins){
    if(!/^[a-z][a-z0-9_]{1,63}$/.test(plugin.id)||ids.has(plugin.id))throw new Error(`PLUGIN_CATALOG_INVALID_ID: ${plugin.id}`);
    if(!plugin.repository.startsWith('https://github.com/moretea-labs/')||!plugin.repository.endsWith('.git'))throw new Error(`PLUGIN_CATALOG_UNTRUSTED_REPOSITORY: ${plugin.id}`);
    if(!/^v\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$/.test(plugin.ref))throw new Error(`PLUGIN_CATALOG_UNPINNED_REF: ${plugin.id}`);
    if(plugin.installer!=='forge-plugin-install.mjs')throw new Error(`PLUGIN_CATALOG_INSTALLER_INVALID: ${plugin.id}`);
    if(plugin.providerVersion!==undefined&&!/^\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$/.test(plugin.providerVersion))throw new Error(`PLUGIN_CATALOG_PROVIDER_VERSION_INVALID: ${plugin.id}`);
    if(plugin.protocolVersion!==undefined&&!/^\d+\.\d+$/.test(plugin.protocolVersion))throw new Error(`PLUGIN_CATALOG_PROTOCOL_VERSION_INVALID: ${plugin.id}`);
    ids.add(plugin.id);
  }
  return value;
}
function within(root:string,relative:string):string{const target=resolve(root,relative);const base=`${resolve(root)}${sep}`;if(target!==resolve(root)&&!target.startsWith(base))throw new Error('PLUGIN_INSTALL_PATH_ESCAPE');return target;}
export function pluginCatalogCompatibility(entry:RegistryEntry,platform:NodeJS.Platform=process.platform):{compatible:boolean;reason?:string}{
  if(!entry.platforms.includes(platform))return{compatible:false,reason:`unsupported platform: ${platform}`};
  if(entry.providerVersion&&entry.providerVersion!==entry.version)return{compatible:false,reason:`catalog version ${entry.version} does not match pinned provider version ${entry.providerVersion}`};
  return{compatible:true};
}
export function officialPluginCatalogItems(platform:NodeJS.Platform=process.platform){return registry().plugins.map(entry=>({...entry,...pluginCatalogCompatibility(entry,platform)}));}
export function externalPluginListItem(controllerHome:string,registration:ExternalPluginRegistration){
  const base={pluginId:registration.pluginId,version:registration.pluginVersion,provider:registration.provider,enabled:registration.enabled,scope:registration.scope,transport:registration.transport.kind};
  if(registration.scope==='repository')return{...base,healthScope:'repository_context_required' as const};
  const repository=controllerPluginRepository(controllerHome);
  try{return{...base,health:getAssistantPluginManifest(controllerHome,repository,registration.pluginId).health};}
  catch(error){return{...base,health:{state:'error',message:error instanceof Error?error.message:String(error)}};}
}
function run(command:string,args:string[],cwd:string,timeoutMs=120000):string{
  const result=spawnSync(command,args,{cwd,encoding:'utf8',timeout:timeoutMs,maxBuffer:32*1024*1024,shell:false,windowsHide:true});
  if(result.error)throw new Error(`PLUGIN_INSTALL_COMMAND_FAILED: ${result.error.message}`);
  if(result.status!==0)throw new Error(`PLUGIN_INSTALL_COMMAND_FAILED: ${command} exited ${result.status}: ${String(result.stderr||result.stdout).slice(-4000)}`);
  return String(result.stdout??'');
}
function installerJson(stdout:string):Record<string,unknown>{
  const lines=stdout.split(/\r?\n/).map(x=>x.trim()).filter(Boolean);
  for(let i=lines.length-1;i>=0;i--){try{const x=JSON.parse(lines[i]);if(x&&typeof x==='object'&&!Array.isArray(x)&&x.schemaVersion===1)return x;}catch{}}
  throw new Error('PLUGIN_INSTALLER_OUTPUT_INVALID');
}
export function installerNextSteps(result:Record<string,unknown>):string[]{
  if(!Array.isArray(result.nextSteps))return[];
  return result.nextSteps
    .filter((value):value is string=>typeof value==='string')
    .map(value=>value.replace(/[\u0000-\u001F\u007F]/g,' ').trim().slice(0,1000))
    .filter(Boolean)
    .slice(0,10);
}
export function registrationFrom(
  result:Record<string,unknown>,
  entry:RegistryEntry,
  options: { packageIdentityVerified?: boolean } = {},
):ExternalPluginRegistrationInput{
  if(result.registration){const input=result.registration as ExternalPluginRegistrationInput;if(input.pluginId!==entry.id)throw new Error('PLUGIN_INSTALLER_ID_MISMATCH');if(input.pluginVersion!==entry.version)throw new Error('PLUGIN_INSTALLER_VERSION_MISMATCH');return input;}
  const facts=result.providerInstall as Record<string,unknown>|undefined;
  if(!facts||facts.kind!=='desktop_operator'||entry.id!=='desktop_operator')throw new Error('PLUGIN_INSTALLER_REGISTRATION_MISSING');
  const expectedProviderVersion=entry.providerVersion??entry.version;
  const expectedProtocolVersion=entry.protocolVersion??'1.0';
  if(facts.pluginVersion!==expectedProviderVersion&&!options.packageIdentityVerified)throw new Error(`PLUGIN_INSTALLER_PROVIDER_VERSION_MISMATCH: expected ${expectedProviderVersion} for ${entry.id}@${entry.version}, actual ${String(facts.pluginVersion??'missing')}`);
  if(facts.protocolVersion!==expectedProtocolVersion)throw new Error(`PLUGIN_INSTALLER_PROTOCOL_VERSION_MISMATCH: expected ${expectedProtocolVersion} for ${entry.id}@${entry.version}, actual ${String(facts.protocolVersion??'missing')}`);
  const socketPath=typeof facts.socketPath==='string'?facts.socketPath:'';const launchAgentLabel=typeof facts.launchAgentLabel==='string'?facts.launchAgentLabel:'';const expectedProgramContains=typeof facts.expectedProgramContains==='string'?facts.expectedProgramContains:'';
  if(!isAbsolute(socketPath)||!launchAgentLabel||!expectedProgramContains)throw new Error('PLUGIN_INSTALLER_PROVIDER_FACTS_INVALID');
  return createDesktopOperatorRegistrationInput({socketPath,launchAgentLabel,expectedProgramContains,pluginVersion:expectedProviderVersion,protocolVersion:expectedProtocolVersion});
}
function install(entry:RegistryEntry,controllerHome:string):Record<string,unknown>{
  const compatibility=pluginCatalogCompatibility(entry,process.platform);
  if(!compatibility.compatible)throw new Error(`PLUGIN_CATALOG_INCOMPATIBLE: ${entry.id}@${entry.version}: ${compatibility.reason}`);
  const packagesRoot=join(controllerSystemRoot(controllerHome),'plugins','packages');mkdirSync(packagesRoot,{recursive:true,mode:0o700});
  const finalRoot=join(packagesRoot,entry.id),stage=join(packagesRoot,`.${entry.id}.${randomUUID()}.staging`),backup=join(packagesRoot,`.${entry.id}.${randomUUID()}.backup`);let backed=false;
  try{
    run('git',['clone','--depth','1','--branch',entry.ref,'--single-branch',entry.repository,stage],packagesRoot);
    const manifestPath=within(stage,'forge-plugin.json'),installerBefore=within(stage,entry.installer);if(!existsSync(manifestPath)||!existsSync(installerBefore))throw new Error(`PLUGIN_PACKAGE_INCOMPLETE: ${entry.id}`);
    const manifest=JSON.parse(readFileSync(manifestPath,'utf8')) as Record<string,unknown>;if(manifest.id!==entry.id||manifest.version!==entry.version)throw new Error(`PLUGIN_PACKAGE_IDENTITY_MISMATCH: ${entry.id}`);
    if(existsSync(finalRoot)){renameSync(finalRoot,backup);backed=true;}renameSync(stage,finalRoot);
    const result=installerJson(run(process.execPath,[within(finalRoot,entry.installer)],finalRoot,180000));
    // The staged package manifest is checked against the catalog before the
    // installer runs. Provider identity is then probed through the installed
    // socket during registry sync. The installer's providerInstall version is
    // useful diagnostics, but must not strand a verified package when that
    // helper field is stale.
    const installed=installExternalPluginRegistration(controllerHome,registrationFrom(result,entry,{packageIdentityVerified:true}));
    const repository=controllerPluginRepository(controllerHome);syncAssistantPluginRegistry(controllerHome,repository);const plugin=getAssistantPluginManifest(controllerHome,repository,entry.id);
    if(backed)rmSync(backup,{recursive:true,force:true});
    return{pluginId:entry.id,version:entry.version,packageRoot:finalRoot,registrationRevision:installed.revision,enabled:plugin.enabled,health:plugin.health,nextSteps:installerNextSteps(result)};
  }catch(error){rmSync(stage,{recursive:true,force:true});if(backed&&existsSync(finalRoot))rmSync(finalRoot,{recursive:true,force:true});if(backed&&existsSync(backup))renameSync(backup,finalRoot);throw error;}
}
export function buildPluginCommand():Command{
  const root=new Command('plugin').description('Discover and install trusted Forge plugins');
  root.command('catalog').description('List official plugins').option('--json','Output JSON').action((o:CliOptions)=>{const items=officialPluginCatalogItems();if(o.json)console.log(JSON.stringify({schemaVersion:1,platform:process.platform,plugins:items},null,2));else items.forEach(x=>console.log(`${x.id}\t${x.version}\t${x.compatible?'compatible':`incompatible (${x.reason})`}\t${x.name}`));});
  root.command('list').description('List installed external plugins').option('--json','Output JSON').option('--controller-home <path>','Override Controller Home').option('--refresh','Probe controller-scoped providers').action((o:CliOptions)=>{const home=resolveControllerHome(o.controllerHome),repo=controllerPluginRepository(home);if(o.refresh)syncAssistantPluginRegistry(home,repo);const items=listExternalPluginRegistrations(home).map(r=>externalPluginListItem(home,r));if(o.json)console.log(JSON.stringify({schemaVersion:1,plugins:items},null,2));else if(!items.length)console.log('No external Forge plugins installed.');else items.forEach(x=>console.log(`${x.pluginId}\t${x.version}\t${x.enabled?'enabled':'disabled'}\t${'healthScope' in x?'repository-context-required':((x.health as {state?:string})?.state??'unknown')}`));});
  root.command('install <plugin-id>').description('Install/update an official plugin from a pinned public release').option('--json','Output JSON').option('--controller-home <path>','Override Controller Home').action((id:string,o:CliOptions)=>{const entry=registry().plugins.find(x=>x.id===id);if(!entry)throw new Error(`PLUGIN_NOT_IN_OFFICIAL_CATALOG: ${id}`);const result=install(entry,resolveControllerHome(o.controllerHome));if(o.json)console.log(JSON.stringify(result,null,2));else{console.log(`Installed ${entry.name} ${entry.version} (${(result.health as {state?:string})?.state??'unknown'}).`);for(const step of (result.nextSteps as string[]|undefined)??[])console.log(`- ${step}`);}});
  return root;
}
