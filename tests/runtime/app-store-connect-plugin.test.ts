import { afterEach, describe, expect, test } from 'bun:test';
import { createHash, generateKeyPairSync } from 'crypto';
import { gzipSync } from 'zlib';
import { existsSync, mkdirSync, mkdtempSync, promises as fsPromises, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { controllerSystemRoot } from '../../src/effects/controller-home';
import { controllerPluginConfigPath, migrateLegacyControllerPluginConfigs } from '../../src/runtime/plugins/config-store';
import {
  buildAppStoreConnectPluginManifest,
  executeAppStoreConnectPluginAction,
  resolveAppStoreConnectXcodeAuthenticationReference,
} from '../../src/runtime/plugins/app-store-connect-adapter';

const roots: string[] = [];
const CONTROLLER_PLUGIN_CONFIG_SCOPE = 'controller:global';
afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

function root(): string {
  const value = mkdtempSync(join(tmpdir(), 'forge-asc-xcode-cloud-'));
  roots.push(value);
  return value;
}

function input(repoRoot: string, actionId: string, args: Record<string, unknown>) {
  return {
    controllerHome: join(repoRoot, '.controller'),
    repoId: 'repo-test',
    repoRoot,
    pluginId: 'app_store_connect',
    actionId,
    requestId: `test-${actionId}`,
    args,
    origin: { surface: 'mcp' as const, actor: 'test' },
  };
}

describe('App Store Connect Xcode Cloud workflow actions', () => {
  test('manifest exposes typed read and strongly-confirmed workflow write actions', async () => {
    const repoRoot = root();
    await executeAppStoreConnectPluginAction(input(repoRoot, 'configure', { enabled: true, provider: 'mock' }));
    const manifest = buildAppStoreConnectPluginManifest(1, undefined, repoRoot);
    expect(manifest.pluginVersion).toBe('1.13.0');
    expect(manifest.actions.find((action) => action.actionId === 'list_xcode_cloud_workflows')).toMatchObject({ readOnly: true, risk: 'readonly' });
    for (const actionId of ['list_bundle_ids', 'list_bundle_id_capabilities', 'list_certificates', 'list_devices', 'list_profiles']) {
      expect(manifest.actions.find((action) => action.actionId === actionId)).toMatchObject({
        readOnly: true,
        risk: 'readonly',
        confirmation: 'none',
        scopes: ['appstoreconnect.developer_resources.read'],
      });
    }
    expect(manifest.capabilities.find((capability) => capability.capabilityId === 'developer-resources-read')?.actions).toEqual([
      'list_bundle_ids', 'list_bundle_id_capabilities', 'list_certificates', 'list_devices', 'list_profiles',
    ]);
    expect(manifest.actions.find((action) => action.actionId === 'update_xcode_cloud_workflow')).toMatchObject({
      readOnly: false,
      risk: 'remote_write',
      confirmation: 'strong_confirmation',
      requiredConfirmationText: 'update-xcode-cloud-workflow',
    });
  });


  test('exposes fixed-path analytics, release, review and commerce capabilities with explicit write confirmations', async () => {
    const repoRoot = root();
    await executeAppStoreConnectPluginAction(input(repoRoot, 'configure', { enabled: true, provider: 'mock' }));
    const manifest = buildAppStoreConnectPluginManifest(1, undefined, repoRoot);
    for (const id of ['get_app_store_version_build', 'list_review_submission_items',
      'list_search_keywords', 'list_analytics_report_requests', 'list_analytics_report_segments',
      'list_in_app_purchases', 'list_customer_reviews']) {
      expect(manifest.actions.find(action => action.actionId === id)).toMatchObject({
        readOnly: true, confirmation: 'none', risk: 'readonly',
      });
    }
    for (const id of ['set_app_store_version_build', 'add_review_submission_item', 'create_in_app_purchase']) {
      expect(manifest.actions.find(action => action.actionId === id)).toMatchObject({
        readOnly: false, confirmation: 'strong_confirmation', risk: 'remote_write',
      });
    }
    expect(manifest.capabilities.some(capability => capability.capabilityId === 'analytics-and-aso')).toBe(true);
    expect(manifest.capabilities.some(capability => capability.capabilityId === 'commerce')).toBe(true);
  });

  test('dry run builds official review/version, snapshot and IAP requests without remote writes', async () => {
    const repoRoot = root();
    await executeAppStoreConnectPluginAction(input(repoRoot, 'configure', { enabled: true, provider: 'mock' }));
    const build = await executeAppStoreConnectPluginAction(input(repoRoot, 'set_app_store_version_build',
      { version_id: 'version-1', build_id: 'build-9', dry_run: true }));
    expect(build).toMatchObject({ dryRun: true, request: { method: 'PATCH',
      path: '/v1/appStoreVersions/version-1/relationships/build',
      body: { data: { type: 'builds', id: 'build-9' } } } });
    const item = await executeAppStoreConnectPluginAction(input(repoRoot, 'add_review_submission_item',
      { review_submission_id: 'submission-1', item_type: 'appStoreVersions', item_id: 'version-1', dry_run: true }));
    expect(item).toMatchObject({ dryRun: true, request: { method: 'POST', path: '/v1/reviewSubmissionItems',
      body: { data: { relationships: { appStoreVersion: { data: { type: 'appStoreVersions', id: 'version-1' } } } } } } });
    const analytics = await executeAppStoreConnectPluginAction(input(repoRoot, 'request_analytics_report',
      { app_id: 'app-1', access_type: 'ONE_TIME_SNAPSHOT', dry_run: true }));
    expect(analytics).toMatchObject({ dryRun: true, request: { method: 'POST', path: '/v1/analyticsReportRequests',
      body: { data: { attributes: { accessType: 'ONE_TIME_SNAPSHOT' },
        relationships: { app: { data: { id: 'app-1' } } } } } } });
    const purchase = await executeAppStoreConnectPluginAction(input(repoRoot, 'create_in_app_purchase',
      { app_id: 'app-1', name: 'Pro', product_id: 'com.example.pro', purchase_type: 'NON_CONSUMABLE', dry_run: true }));
    expect(purchase).toMatchObject({ dryRun: true, request: { method: 'POST', path: '/v2/inAppPurchases',
      body: { data: { attributes: { productId: 'com.example.pro', inAppPurchaseType: 'NON_CONSUMABLE' } } } } });
    await expect(executeAppStoreConnectPluginAction(input(repoRoot, 'request_analytics_report',
      { access_type: 'UNSUPPORTED', dry_run: true }))).rejects.toThrow('access_type');
    await expect(executeAppStoreConnectPluginAction(input(repoRoot, 'add_review_submission_item',
      { review_submission_id: 's', item_type: 'userAccounts', item_id: 'u', dry_run: true }))).rejects.toThrow('Unsupported');
  });

  test('ASO version/localization reads preserve Apple platform version locale and keyword scope', async () => {
    const repoRoot = root();
    const keyPath = join(repoRoot, 'AuthKey_ASO_VERSIONS.p8');
    const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    writeFileSync(keyPath, privateKey.export({ type:'pkcs8', format:'pem' }));
    await executeAppStoreConnectPluginAction(input(repoRoot, 'configure', {
      enabled:true, provider:'app-store-connect-api', issuer_id:'issuer-aso-versions',
      key_id:'key-aso-versions', private_key_path:keyPath,
    }));
    const old = globalThis.fetch;
    const urls: URL[] = [];
    globalThis.fetch = (async (request:string | URL | Request) => {
      urls.push(new URL(String(request)));
      return Response.json({data:[]});
    }) as typeof fetch;
    try {
      await executeAppStoreConnectPluginAction(input(repoRoot, 'list_app_store_versions', {
        app_id:'app-1', platform:'IOS', version_string:'1.0.4', app_version_state:'READY_FOR_DISTRIBUTION',
      }));
      await executeAppStoreConnectPluginAction(input(repoRoot, 'list_app_store_version_localizations', {
        version_id:'version-1', locale:'en-US',
      }));
      await executeAppStoreConnectPluginAction(input(repoRoot, 'get_app_store_version_localization', {
        localization_id:'loc/1',
      }));
      await executeAppStoreConnectPluginAction(input(repoRoot, 'list_version_localization_search_keywords', {
        localization_id:'loc-1',locale:'en-US',platform:'IOS',limit:25,
      }));
      await executeAppStoreConnectPluginAction(input(repoRoot, 'get_app_info_localization', {
        localization_id:'info-loc-1',
      }));
      expect(urls.map(v=>v.pathname)).toEqual([
        '/v1/apps/app-1/appStoreVersions',
        '/v1/appStoreVersions/version-1/appStoreVersionLocalizations',
        '/v1/appStoreVersionLocalizations/loc%2F1',
        '/v1/appStoreVersionLocalizations/loc-1/searchKeywords',
        '/v1/appInfoLocalizations/info-loc-1',
      ]);
      expect(urls[0]?.searchParams.get('filter[platform]')).toBe('IOS');
      expect(urls[0]?.searchParams.get('filter[versionString]')).toBe('1.0.4');
      expect(urls[0]?.searchParams.get('filter[appVersionState]')).toBe('READY_FOR_DISTRIBUTION');
      expect(urls[1]?.searchParams.get('filter[locale]')).toBe('en-US');
      expect(urls[3]?.searchParams.get('filter[locale]')).toBe('en-US');
      expect(urls[3]?.searchParams.get('filter[platform]')).toBe('IOS');
      expect(urls[3]?.searchParams.get('limit')).toBe('25');
    } finally {globalThis.fetch=old;}
  });

  test('official read endpoints preserve exact version and Apple keyword query filters', async () => {
    const repoRoot = root();
    const privateKeyPath = join(repoRoot, 'AuthKey_EXTRA.p8');
    const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    writeFileSync(privateKeyPath, privateKey.export({ type: 'pkcs8', format: 'pem' }));
    await executeAppStoreConnectPluginAction(input(repoRoot, 'configure', {
      enabled: true, provider: 'app-store-connect-api', issuer_id: 'issuer-extra',
      key_id: 'key-extra', private_key_path: privateKeyPath,
    }));
    const original = globalThis.fetch;
    const requests: Array<{ url: URL; method: string }> = [];
    globalThis.fetch = (async (request: string | URL | Request, init?: RequestInit) => {
      requests.push({ url: new URL(String(request)), method: init?.method ?? 'GET' });
      return new Response(JSON.stringify({ data: [] }), { headers: { 'content-type': 'application/json' } });
    }) as typeof fetch;
    try {
      await executeAppStoreConnectPluginAction(input(repoRoot, 'get_app_store_version',
        { version_id: 'version/special' }));
      await executeAppStoreConnectPluginAction(input(repoRoot, 'list_search_keywords',
        { app_id: 'app-1', locale: 'en-US', platform: 'IOS', limit: 25 }));
      expect(requests[0].url.pathname).toBe('/v1/appStoreVersions/version%2Fspecial');
      expect(requests[0].url.searchParams.get('include')).toBe('build,app,appStoreReviewDetail');
      expect(requests[1].url.pathname).toBe('/v1/apps/app-1/searchKeywords');
      expect(requests[1].url.searchParams.get('filter[locale]')).toBe('en-US');
      expect(requests[1].url.searchParams.get('filter[platform]')).toBe('IOS');
      expect(requests[1].url.searchParams.get('limit')).toBe('25');
    } finally {
      globalThis.fetch = original;
    }
  });



  test('phased release mutations use official typed requests and require strong confirmation', async () => {
    const repoRoot = root();
    await executeAppStoreConnectPluginAction(input(repoRoot, 'configure', { enabled: true, provider: 'mock' }));
    const manifest = buildAppStoreConnectPluginManifest(1, undefined, repoRoot);
    for (const actionId of ['create_app_store_version_phased_release',
      'update_app_store_version_phased_release','delete_app_store_version_phased_release']) {
      expect(manifest.actions.find(action => action.actionId === actionId)).toMatchObject({
        readOnly: false, risk: 'remote_write', confirmation: 'strong_confirmation',
      });
    }
    const create = await executeAppStoreConnectPluginAction(input(repoRoot,
      'create_app_store_version_phased_release', { version_id: 'version-1', dry_run: true }));
    expect(create).toMatchObject({ dryRun: true, request: {
      method: 'POST', path: '/v1/appStoreVersionPhasedReleases',
      body: { data: { type: 'appStoreVersionPhasedReleases',
        attributes: { phasedReleaseState: 'INACTIVE' },
        relationships: { appStoreVersion: { data: {type:'appStoreVersions',id:'version-1'} } },
      } },
    } });
    const pause = await executeAppStoreConnectPluginAction(input(repoRoot,
      'update_app_store_version_phased_release', {
        phased_release_id: 'phased/1', state: 'PAUSED', dry_run: true,
      }));
    expect(pause).toMatchObject({ dryRun: true, request: {
      method: 'PATCH', path: '/v1/appStoreVersionPhasedReleases/phased%2F1',
      body: { data: { type: 'appStoreVersionPhasedReleases', id: 'phased/1',
        attributes: { phasedReleaseState: 'PAUSED' } } },
    } });
    const cancel = await executeAppStoreConnectPluginAction(input(repoRoot,
      'delete_app_store_version_phased_release', {
        phased_release_id: 'phased-1', dry_run: true,
      }));
    expect(cancel).toMatchObject({dryRun: true, request: {
      method: 'DELETE', path: '/v1/appStoreVersionPhasedReleases/phased-1',
    }});
    await expect(executeAppStoreConnectPluginAction(input(repoRoot,
      'update_app_store_version_phased_release', {
        phased_release_id: 'phased-1', state: 'INACTIVE', dry_run: true,
      }))).rejects.toThrow('ACTIVE, PAUSED or COMPLETE');
  });

  test('release rollout and review resource reads preserve Apple state and redact direct detail credentials', async () => {
    const repoRoot = root();
    const keyPath = join(repoRoot, 'AuthKey_RELEASE_READS.p8');
    const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    writeFileSync(keyPath, privateKey.export({ type: 'pkcs8', format: 'pem' }));
    await executeAppStoreConnectPluginAction(input(repoRoot, 'configure', {
      enabled: true, provider: 'app-store-connect-api', issuer_id: 'issuer-release-reads',
      key_id: 'key-release-reads', private_key_path: keyPath,
    }));
    const original = globalThis.fetch;
    const requested: string[] = [];
    globalThis.fetch = (async (request: string | URL | Request) => {
      const pathname = new URL(String(request)).pathname;
      requested.push(pathname);
      if (pathname === '/v1/appStoreReviewDetails/review-1') return Response.json({
        data: { type: 'appStoreReviewDetails', id: 'review-1',
          attributes: { contactEmail: 'review@example.com', demoAccountPassword: 'private-review-password' } },
      });
      return Response.json({ data: pathname.endsWith('/relationships/items') ? [] :
        { id: pathname.split('/').pop(), attributes: { phasedReleaseState: 'ACTIVE', currentDayNumber: 3 } } });
    }) as typeof fetch;
    try {
      const actions = [
        ['get_app_store_version_phased_release', { version_id: 'version/1' }],
        ['list_app_store_review_attachments', { detail_id: 'review-1' }],
        ['get_app_store_review_attachment', { attachment_id: 'attachment-1' }],
        ['list_app_store_review_attachment_ids', { detail_id: 'review-1' }],
        ['get_review_submission_item', { item_id: 'item-1' }],
        ['list_review_submission_item_ids', { review_submission_id: 'submission-1' }],
      ] as const;
      for (const [actionId, args] of actions)
        await executeAppStoreConnectPluginAction(input(repoRoot, actionId, args));
      const detail = await executeAppStoreConnectPluginAction(input(repoRoot,
        'get_app_store_review_detail_by_id', { detail_id: 'review-1' }));
      expect(JSON.stringify(detail)).not.toContain('private-review-password');
      expect(detail).toMatchObject({ data: { attributes: {
        contactEmail: 'review@example.com', demoAccountPassword: '[REDACTED]',
      } } });
      expect(requested).toEqual([
        '/v1/appStoreVersions/version%2F1/appStoreVersionPhasedRelease',
        '/v1/appStoreReviewDetails/review-1/appStoreReviewAttachments',
        '/v1/appStoreReviewAttachments/attachment-1',
        '/v1/appStoreReviewDetails/review-1/relationships/appStoreReviewAttachments',
        '/v1/reviewSubmissionItems/item-1',
        '/v1/reviewSubmissions/submission-1/relationships/items',
        '/v1/appStoreReviewDetails/review-1',
      ]);
    } finally { globalThis.fetch = original; }
  });

  test('never exposes App Review demo password from direct data or included version resources', async () => {
    const repoRoot = root();
    const keyPath = join(repoRoot, 'AuthKey_REVIEW_SECRET.p8');
    const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    writeFileSync(keyPath, privateKey.export({ type: 'pkcs8', format: 'pem' }));
    await executeAppStoreConnectPluginAction(input(repoRoot, 'configure', {
      enabled: true, provider: 'app-store-connect-api', issuer_id: 'issuer-review',
      key_id: 'key-review', private_key_path: keyPath,
    }));
    const original = globalThis.fetch;
    const password = 'this-is-a-sensitive-demo-password';
    globalThis.fetch = (async (request: string | URL | Request) => {
      if (String(request).includes('/appStoreReviewDetail')) {
        return Response.json({ data: { type: 'appStoreReviewDetails', id: 'detail-1',
          attributes: { contactEmail: 'review@example.com', demoAccountPassword: password } } });
      }
      return Response.json({
        data: { type: 'appStoreVersions', id: 'version-1',
          attributes: { versionString: '1.0.5' } },
        included: [{ type: 'appStoreReviewDetails', id: 'detail-1',
          attributes: { demoAccountPassword: password, contactEmail: 'review@example.com' } }],
      });
    }) as typeof fetch;
    try {
      const version = await executeAppStoreConnectPluginAction(input(repoRoot, 'get_app_store_version', {
        version_id: 'version-1',
      }));
      expect(JSON.stringify(version)).not.toContain(password);
      expect(version).toMatchObject({ included: [{
        attributes: { demoAccountPassword: '[REDACTED]', contactEmail: 'review@example.com' },
      }] });
      const detail = await executeAppStoreConnectPluginAction(input(repoRoot, 'get_app_store_review_detail', {
        version_id: 'version-1',
      }));
      expect(JSON.stringify(detail)).not.toContain(password);
      expect(detail).toMatchObject({ data: { attributes: {
        demoAccountPassword: '[REDACTED]', contactEmail: 'review@example.com',
      } } });
    } finally {
      globalThis.fetch = original;
    }
  });



  test('Asset Library video metadata and preview frames use official resources with strong confirmation', async () => {
    const repoRoot=root();
    await executeAppStoreConnectPluginAction(input(repoRoot,'configure',{enabled:true,provider:'mock'}));
    const manifest=buildAppStoreConnectPluginManifest(1,undefined,repoRoot);
    for (const actionId of ['update_asset_library_video','delete_asset_library_video']) {
      expect(manifest.actions.find(a=>a.actionId===actionId)).toMatchObject({
        readOnly:false,confirmation:'strong_confirmation',scopes:['appstoreconnect.assets.write'],
      });
    }
    const preview=await executeAppStoreConnectPluginAction(input(repoRoot,'update_asset_library_video',{
      asset_id:'video/1',preview_frame_time_code:'00:00:05:00',reference_name:'Preview',dry_run:true,
    }));
    expect(preview).toMatchObject({dryRun:true,request:{method:'PATCH',
      path:'/v1/appAssetLibraryVideos/video%2F1',body:{data:{type:'appAssetLibraryVideos',
        id:'video/1',attributes:{previewFrameTimeCode:'00:00:05:00',referenceName:'Preview'}}}}});
    const deletion=await executeAppStoreConnectPluginAction(input(repoRoot,'delete_asset_library_video',{
      asset_id:'video-1',dry_run:true,
    }));
    expect(deletion).toMatchObject({request:{method:'DELETE',path:'/v1/appAssetLibraryVideos/video-1'}});
    await expect(executeAppStoreConnectPluginAction(input(repoRoot,'update_asset_library_video',{
      asset_id:'video-1',preview_frame_time_code:'bad-time',dry_run:true,
    }))).rejects.toThrow('timecode');
    const keyPath=join(repoRoot,'AuthKey_VIDEO_READS.p8');
    const {privateKey}=generateKeyPairSync('ec',{namedCurve:'P-256'});
    writeFileSync(keyPath,privateKey.export({type:'pkcs8',format:'pem'}));
    await executeAppStoreConnectPluginAction(input(repoRoot,'configure',{
      enabled:true,provider:'app-store-connect-api',issuer_id:'issuer-video',key_id:'key-video',private_key_path:keyPath,
    }));
    const old=globalThis.fetch;
    const urls:URL[]=[];
    globalThis.fetch=(async(request:string|URL|Request)=>{
      urls.push(new URL(String(request)));
      return Response.json({data:[]});
    }) as typeof fetch;
    try {
      await executeAppStoreConnectPluginAction(input(repoRoot,'list_app_asset_library_videos',{
        library_id:'library-1',reference_name:'Preview',state:'PREPARE_FOR_SUBMISSION',
      }));
      await executeAppStoreConnectPluginAction(input(repoRoot,'list_app_asset_library_video_placements',{
        asset_id:'video-1',placement_type:'APP_PREVIEW',
      }));
      await executeAppStoreConnectPluginAction(input(repoRoot,'list_asset_library_video_placement_ids',{
        asset_id:'video-1',
      }));
      expect(urls.map(x=>x.pathname)).toEqual([
        '/v1/appAssetLibraries/library-1/videos',
        '/v1/appAssetLibraryVideos/video-1/placements',
        '/v1/appAssetLibraryVideos/video-1/relationships/placements',
      ]);
      expect(urls[0]?.searchParams.get('filter[referenceName]')).toBe('Preview');
      expect(urls[1]?.searchParams.get('filter[placementType]')).toBe('APP_PREVIEW');
    } finally {globalThis.fetch=old;}
  });

  test('Asset Library placements: typed request, ordering and confirmation', async () => {
    const repoRoot=root();
    await executeAppStoreConnectPluginAction(input(repoRoot,'configure',{enabled:true,provider:'mock'}));
    const manifest=buildAppStoreConnectPluginManifest(1,undefined,repoRoot);
    for(const actionId of ['upload_asset_library_image','create_asset_library_placement','order_asset_library_placements',
      'delete_asset_library_image','delete_asset_library_placement','update_asset_library_image']) {
      expect(manifest.actions.find(a=>a.actionId===actionId)).toMatchObject({
        confirmation:'strong_confirmation',risk:'remote_write',scopes:['appstoreconnect.assets.write'],
      });
    }
    expect(manifest.permissions.some(p=>p.scope==='appstoreconnect.assets.write'&&p.mode==='write')).toBe(true);
    const placed=await executeAppStoreConnectPluginAction(input(repoRoot,'create_asset_library_placement',{
      asset_id:'image-1',asset_kind:'image',target_type:'appStoreVersionLocalization',localization_id:'loc-1',
      placement_type:'APP_SCREENSHOT',placement_group:'IPHONE_DYNAMIC_ISLAND_LARGE_PROFILE',dry_run:true,
    }));
    expect(placed).toMatchObject({dryRun:true,request:{method:'POST',path:'/v1/appAssetLibraryPlacements',
      body:{data:{attributes:{placementType:'APP_SCREENSHOT'},
        relationships:{image:{data:{type:'appAssetLibraryImages',id:'image-1'}},
          appStoreVersionLocalization:{data:{type:'appStoreVersionLocalizations',id:'loc-1'}}}}}}});
    const order=await executeAppStoreConnectPluginAction(input(repoRoot,'order_asset_library_placements',{
      target_type:'appStoreVersionLocalization',localization_id:'loc-1',
      placement_group:'IPHONE_DYNAMIC_ISLAND_LARGE_PROFILE',placement_ids:['p-2','p-1'],dry_run:true,
    }));
    expect(order).toMatchObject({request:{method:'POST',path:'/v1/appAssetLibraryPlacementOrderingRequests',
      body:{data:{relationships:{orderedPlacements:{data:[
        {type:'appAssetLibraryPlacements',id:'p-2'},{type:'appAssetLibraryPlacements',id:'p-1'},
      ]}}}}}});
    await expect(executeAppStoreConnectPluginAction(input(repoRoot,'order_asset_library_placements',{
      target_type:'appStoreVersionLocalization',localization_id:'loc-1',
      placement_group:'IPHONE_DYNAMIC_ISLAND_LARGE_PROFILE',placement_ids:['p-1','p-1'],dry_run:true,
    }))).rejects.toThrow('distinct placement IDs');
  });


  test('Asset Library image upload is pinned, dry-run safe and commits uploaded without checksum field', async () => {
    const repoRoot=root();
    const keyPath=join(repoRoot,'AuthKey_ASSET_LIBRARY.p8');
    const {privateKey}=generateKeyPairSync('ec',{namedCurve:'P-256'});
    writeFileSync(keyPath,privateKey.export({type:'pkcs8',format:'pem'}));
    const bytes=Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),Buffer.alloc(20,0x41)]);
    writeFileSync(join(repoRoot,'asset.png'),bytes);
    const sha256=createHash('sha256').update(bytes).digest('hex');
    await executeAppStoreConnectPluginAction(input(repoRoot,'configure',{
      enabled:true,provider:'app-store-connect-api',issuer_id:'asset-issuer',key_id:'asset-key',
      private_key_path:keyPath,
    }));
    const old=globalThis.fetch;
    const requests:Array<{path:string;method:string;jwt:boolean}>=[];
    let existing=false;
    let hostileUploadHost=false;
    globalThis.fetch=(async(request:string|URL|Request,init?:RequestInit)=>{
      const url=new URL(String(request)), method=init?.method??'GET';
      requests.push({path:url.pathname,method,jwt:new Headers(init?.headers).has('authorization')});
      if (url.pathname==='/v1/apps/app-1/assetLibrary')
        return Response.json({data:{type:'appAssetLibraries',id:'library-1'}});
      if (url.pathname==='/v1/appAssetLibraries/library-1/images') {
        expect(url.searchParams.get('filter[referenceName]')).toBe('Screenshot one');
        return Response.json({data:existing?[{id:'other-1',attributes:{referenceName:'Screenshot one',state:'UPLOAD_COMPLETE'}}]:[]});
      }
      if (url.pathname==='/v1/appAssetLibraryImages' && method==='POST') {
        const body=JSON.parse(String(init?.body));
        expect(body.data).toMatchObject({type:'appAssetLibraryImages',
          attributes:{fileName:'asset.png',fileSize:bytes.length,referenceName:'Screenshot one',
            category:'APP_SCREENSHOTS_AND_PREVIEWS'},
          relationships:{assetLibrary:{data:{type:'appAssetLibraries',id:'library-1'}}}});
        return Response.json({data:{id:'asset-1',type:'appAssetLibraryImages',
          attributes:{uploadOperations:[{method:'PUT',url:hostileUploadHost?'https://attacker.example/assets/1':'https://store-030.blobstore.apple.com/assets/1',
            offset:0,length:bytes.length,requestHeaders:[{name:'Content-Type',value:'image/png'}]}]}}});
      }
      if (url.pathname==='/assets/1') {
        expect(method).toBe('PUT');
        expect(Buffer.from(init?.body as Uint8Array)).toEqual(bytes);
        expect(new Headers(init?.headers).has('authorization')).toBe(false);
        return new Response(null,{status:200});
      }
      if (url.pathname==='/v1/appAssetLibraryImages/asset-1' && method==='PATCH') {
        expect(JSON.parse(String(init?.body))).toEqual({data:{type:'appAssetLibraryImages',
          id:'asset-1',attributes:{uploaded:true}}});
        return Response.json({data:{id:'asset-1',type:'appAssetLibraryImages'}});
      }
      if (url.pathname==='/v1/appAssetLibraryImages/asset-1' && method==='GET')
        return Response.json({data:{id:'asset-1',type:'appAssetLibraryImages',
          attributes:{state:'PREPARE_FOR_SUBMISSION',specId:'spec-1'}}});
      throw new Error('unexpected path '+url.pathname);
    }) as typeof fetch;
    try {
      const args={app_id:'app-1',file_path:'asset.png',expected_sha256:sha256,
        category:'APP_SCREENSHOTS_AND_PREVIEWS',reference_name:'Screenshot one'};
      const preview=await executeAppStoreConnectPluginAction(input(repoRoot,'upload_asset_library_image',{
        ...args,dry_run:true,
      }));
      expect(preview).toMatchObject({dryRun:true,libraryId:'library-1',file:{sha256},
        request:{method:'POST',path:'/v1/appAssetLibraryImages'}});
      expect(requests.map(x=>x.method)).toEqual(['GET','GET']);
      requests.length=0;
      const result=await executeAppStoreConnectPluginAction(input(repoRoot,'upload_asset_library_image',args));
      expect(result).toMatchObject({applied:true,assetId:'asset-1',readyToPlace:true,
        state:'PREPARE_FOR_SUBMISSION',specId:'spec-1',sha256});
      expect(requests.map(x=>x.method)).toEqual(['GET','GET','POST','PUT','PATCH','GET']);
      expect(requests[3]?.jwt).toBe(false);
      requests.length=0;
      existing=true;
      await expect(executeAppStoreConnectPluginAction(input(repoRoot,'upload_asset_library_image',args)))
        .rejects.toThrow('Reference name already belongs');
      expect(requests.map(x=>x.method)).toEqual(['GET','GET']);
      requests.length=0;
      existing=false;
      hostileUploadHost=true;
      await expect(executeAppStoreConnectPluginAction(input(repoRoot,'upload_asset_library_image',args)))
        .rejects.toThrow('outcome is uncertain');
      expect(requests.map(x=>x.method)).toEqual(['GET','GET','POST']);
      expect(requests.every(x=>x.path!=='/assets/1')).toBe(true);
    } finally {globalThis.fetch=old;}
  });

  test('official versioned IAP and subscription writes use current version relationships and safe dry-run', async () => {
    const repoRoot = root();
    await executeAppStoreConnectPluginAction(input(repoRoot, 'configure', { enabled: true, provider: 'mock' }));
    const cases: Array<{ action: string; args: Record<string, unknown>; path: string; relation: string; type: string; id: string }> = [
      { action: 'create_in_app_purchase_version', args: { purchase_id: 'iap-1' }, path: '/v1/inAppPurchaseVersions', relation: 'inAppPurchase', type: 'inAppPurchases', id: 'iap-1' },
      { action: 'create_in_app_purchase_version_localization', args: { version_id: 'iapv-1', locale: 'en-US', name: 'Pro', description: 'Unlimited' }, path: '/v2/inAppPurchaseLocalizations', relation: 'version', type: 'inAppPurchaseVersions', id: 'iapv-1' },
      { action: 'create_subscription_version', args: { subscription_id: 'sub-1' }, path: '/v1/subscriptionVersions', relation: 'subscription', type: 'subscriptions', id: 'sub-1' },
      { action: 'create_subscription_version_localization', args: { version_id: 'subv-1', locale: 'en-US', name: 'Monthly Pro' }, path: '/v2/subscriptionLocalizations', relation: 'version', type: 'subscriptionVersions', id: 'subv-1' },
      { action: 'create_subscription_group_version', args: { group_id: 'group-1' }, path: '/v1/subscriptionGroupVersions', relation: 'subscriptionGroup', type: 'subscriptionGroups', id: 'group-1' },
      { action: 'create_subscription_group_version_localization', args: { version_id: 'groupv-1', locale: 'en-US', name: 'Pro Group' }, path: '/v2/subscriptionGroupLocalizations', relation: 'version', type: 'subscriptionGroupVersions', id: 'groupv-1' },
    ];
    const manifest = buildAppStoreConnectPluginManifest(1, undefined, repoRoot);
    for (const item of cases) {
      const descriptor = manifest.actions.find(action => action.actionId === item.action);
      expect(descriptor).toMatchObject({ readOnly: false, risk: 'remote_write' });
      const response = await executeAppStoreConnectPluginAction(input(repoRoot, item.action, { ...item.args, dry_run: true }));
      expect(response).toMatchObject({ dryRun: true, request: {
        method: 'POST', path: item.path, body: { data: {
          relationships: { [item.relation]: { data: { type: item.type, id: item.id } } },
        } },
      } });
    }
    const price = await executeAppStoreConnectPluginAction(input(repoRoot, 'create_subscription_price', {
      subscription_id: 'sub-1', price_point_id: 'point-USA', plan_type: 'MONTHLY', dry_run: true,
    }));
    expect(price).toMatchObject({ dryRun: true, request: { path: '/v1/subscriptionPrices', body: {data: {
      attributes: { startDate: null, planType: 'MONTHLY' },
      relationships: { subscriptionPricePoint: { data: { type: 'subscriptionPricePoints', id: 'point-USA' } } },
    }} } });
    expect(manifest.actions.find(action => action.actionId === 'create_subscription_price')).toMatchObject({
      confirmation: 'strong_confirmation',
    });
    await expect(executeAppStoreConnectPluginAction(input(repoRoot, 'create_subscription', {
      group_id: 'group-1', name: 'Pro', product_id: 'pro', subscription_period: 'DAILY', dry_run: true,
    }))).rejects.toThrow('Invalid subscription period');
  });

  test('IAP price schedule and subscription prices use Apple fixed endpoints and explicit filters/cursors', async () => {
    const repoRoot = root();
    const privateKeyPath = join(repoRoot, 'AuthKey_PRICES.p8');
    const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    writeFileSync(privateKeyPath, privateKey.export({ type: 'pkcs8', format: 'pem' }));
    await executeAppStoreConnectPluginAction(input(repoRoot, 'configure', {
      enabled: true, provider: 'app-store-connect-api', issuer_id: 'issuer-prices', key_id: 'key-prices', private_key_path: privateKeyPath,
    }));
    const original = globalThis.fetch;
    const urls: URL[] = [];
    globalThis.fetch = (async (request: string | URL | Request) => {
      urls.push(new URL(String(request)));
      return Response.json({data:[]});
    }) as typeof fetch;
    try {
      await executeAppStoreConnectPluginAction(input(repoRoot, 'get_in_app_purchase_price_schedule', { purchase_id: 'id/special' }));
      await executeAppStoreConnectPluginAction(input(repoRoot, 'list_subscription_prices', {
        subscription_id: 'sub1', territory: 'USA', plan_type: 'MONTHLY', cursor: 'opaqueCursor', limit: 25,
      }));
      await executeAppStoreConnectPluginAction(input(repoRoot, 'list_subscription_price_points', {
        subscription_id: 'sub1', territory: 'JPN',
      }));
      expect(urls[0]?.pathname).toBe('/v2/inAppPurchases/id%2Fspecial/iapPriceSchedule');
      expect(urls[1]?.pathname).toBe('/v1/subscriptions/sub1/prices');
      expect(urls[1]?.searchParams.get('filter[territory]')).toBe('USA');
      expect(urls[1]?.searchParams.get('filter[planType]')).toBe('MONTHLY');
      expect(urls[1]?.searchParams.get('cursor')).toBe('opaqueCursor');
      expect(urls[2]?.pathname).toBe('/v1/subscriptions/sub1/pricePoints');
      expect(urls[2]?.searchParams.get('filter[territory]')).toBe('JPN');
    } finally {
      globalThis.fetch = original;
    }
  });



  test('IAP schedule mutation pins base territory and inline price point with strong confirmation', async () => {
    const repoRoot = root();
    await executeAppStoreConnectPluginAction(input(repoRoot, 'configure', {enabled:true,provider:'mock'}));
    const manifest = buildAppStoreConnectPluginManifest(1, undefined, repoRoot);
    expect(manifest.actions.find(a=>a.actionId==='create_in_app_purchase_price_schedule')).toMatchObject({
      readOnly:false, risk:'remote_write', confirmation:'strong_confirmation',
    });
    const output = await executeAppStoreConnectPluginAction(input(repoRoot, 'create_in_app_purchase_price_schedule', {
      purchase_id:'iap-pro', price_point_id:'point-USA', base_territory:'USA', start_date:'2026-12-01', dry_run:true,
    }));
    expect(output).toMatchObject({ dryRun:true, request: {method:'POST',path:'/v1/inAppPurchasePriceSchedules',
      body:{ data:{type:'inAppPurchasePriceSchedules',relationships:{
        baseTerritory:{data:{type:'territories',id:'USA'}},
        inAppPurchase:{data:{type:'inAppPurchases',id:'iap-pro'}},
        manualPrices:{data:[{type:'inAppPurchasePrices',id:'price-1'}]},
      }}, included:[{type:'inAppPurchasePrices',id:'price-1',attributes:{startDate:'2026-12-01'},
        relationships:{inAppPurchasePricePoint:{data:{type:'inAppPurchasePricePoints',id:'point-USA'}}},
      }] } } });
    await expect(executeAppStoreConnectPluginAction(input(repoRoot, 'create_in_app_purchase_price_schedule', {
      purchase_id:'iap-pro',price_point_id:'p',base_territory:'US',dry_run:true,
    }))).rejects.toThrow('three-letter');
    await expect(executeAppStoreConnectPluginAction(input(repoRoot, 'create_in_app_purchase_price_schedule', {
      purchase_id:'iap-pro',price_point_id:'p',base_territory:'USA',start_date:'12/01/2026',dry_run:true,
    }))).rejects.toThrow('start date');
  });

  test('App Store release preflight only reads Apple-owned prerequisites and never claims approval', async () => {
    const repoRoot = root();
    const privateKeyPath = join(repoRoot, 'AuthKey_RELEASE_PREFLIGHT.p8');
    const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    writeFileSync(privateKeyPath, privateKey.export({ type: 'pkcs8', format: 'pem' }));
    await executeAppStoreConnectPluginAction(input(repoRoot, 'configure', {
      enabled: true, provider: 'app-store-connect-api', issuer_id: 'issuer-preflight', key_id: 'key-preflight',
      private_key_path: privateKeyPath,
    }));
    const original = globalThis.fetch;
    const urls: string[] = [];
    let missingBuild = false;
    globalThis.fetch = (async (request: string | URL | Request, init?: RequestInit) => {
      expect(init?.method ?? 'GET').toBe('GET');
      const url = new URL(String(request));
      urls.push(url.pathname);
      const relationships = { app: {data:{type:'apps', id:'app-1'}},
        build: {data: missingBuild ? null : {type:'builds',id:'build-1'}},
        appStoreReviewDetail:{data:{type:'appStoreReviewDetails',id:'detail-1'}} };
      if (url.pathname === '/v1/appStoreVersions/version-1')
        return Response.json({data:{id:'version-1',attributes:{versionString:'1.0.5',appStoreState:'PREPARE_FOR_SUBMISSION',platform:'IOS'},relationships}});
      if (url.pathname.endsWith('/build'))
        return Response.json({data:{id:'build-1',attributes:{processingState:'VALID',expired:false}}});
      if (url.pathname.endsWith('/appStoreVersionLocalizations'))
        return Response.json({data:[{id:'loc-1',attributes:{locale:'en-US',description:'Test',supportUrl:'https://example.com'}}]});
      if (url.pathname.endsWith('/appStoreReviewDetail'))
        return Response.json({data:{id:'detail-1',attributes:{contactEmail:'review@example.com',contactPhone:'123',
          contactFirstName:'A',contactLastName:'B',demoAccountPassword:'secret-not-for-output'}}});
      throw new Error('unexpected path ' + url.pathname);
    }) as typeof fetch;
    try {
      const valid = await executeAppStoreConnectPluginAction(input(repoRoot, 'check_release_readiness',
        {app_id:'app-1',version_id:'version-1'}));
      expect(valid).toMatchObject({preflightOnly:true,appleSubmissionAcceptanceVerified:false,
        result:'candidate_unverified',blockers:[],evidence:{versionId:'version-1',build:{id:'build-1',processingState:'VALID'}}});
      expect(JSON.stringify(valid)).not.toContain('secret-not-for-output');
      expect(urls).toContain('/v1/appStoreVersions/version-1/build');
      missingBuild = true;
      const missing = await executeAppStoreConnectPluginAction(input(repoRoot, 'check_release_readiness',
        {app_id:'app-1',version_id:'version-1'}));
      expect(missing).toMatchObject({result:'incomplete'});
      expect((missing.blockers as string[]).join(' ')).toContain('No App Store build');
      await expect(executeAppStoreConnectPluginAction(input(repoRoot, 'check_release_readiness',
        {app_id:'different-app',version_id:'version-1'}))).rejects.toThrow('does not belong');
    } finally { globalThis.fetch = original; }
  });


  test("Asset Library discovery follows Apple's app-to-library-to-asset paths", async () => {
    const repoRoot = root();
    const privateKeyPath = join(repoRoot, 'AuthKey_ASSETS.p8');
    const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    writeFileSync(privateKeyPath, privateKey.export({ type: 'pkcs8', format: 'pem' }));
    await executeAppStoreConnectPluginAction(input(repoRoot, 'configure', {
      enabled: true, provider: 'app-store-connect-api', issuer_id: 'issuer-assets', key_id: 'key-assets',
      private_key_path: privateKeyPath,
    }));
    const old = globalThis.fetch;
    const paths: string[] = [];
    globalThis.fetch = (async (request: string | URL | Request) => {
      paths.push(new URL(String(request)).pathname);
      return Response.json({data:[]});
    }) as typeof fetch;
    try {
      await executeAppStoreConnectPluginAction(input(repoRoot, 'get_app_asset_library', { app_id:'app-123' }));
      await executeAppStoreConnectPluginAction(input(repoRoot, 'list_app_asset_library_images', { library_id:'library-123' }));
      await executeAppStoreConnectPluginAction(input(repoRoot, 'list_app_asset_library_videos', { library_id:'library-123' }));
      await executeAppStoreConnectPluginAction(input(repoRoot, 'list_app_asset_library_reference_data', {}));
      await executeAppStoreConnectPluginAction(input(repoRoot, 'get_app_asset_library_image', { asset_id:'image-123' }));
      expect(paths).toEqual([
        '/v1/apps/app-123/assetLibrary',
        '/v1/appAssetLibraries/library-123/images',
        '/v1/appAssetLibraries/library-123/videos',
        '/v1/appAssetLibraryRefData',
        '/v1/appAssetLibraryImages/image-123',
      ]);
    } finally { globalThis.fetch = old; }
  });



  test('TestFlight revocations and invitation re-send use official exact relationship paths and strong confirmation', async () => {
    const repoRoot = root();
    await executeAppStoreConnectPluginAction(input(repoRoot, 'configure', { enabled: true, provider: 'mock' }));
    const manifest = buildAppStoreConnectPluginManifest(1, undefined, repoRoot);
    const cases = [
      { id: 'remove_beta_tester_from_group', args: { group_id: 'group-1', tester_id: 'tester-1' },
        method: 'DELETE', path: '/v1/betaGroups/group-1/relationships/betaTesters',
        body: { data: [{type: 'betaTesters', id: 'tester-1'}] } },
      { id: 'remove_build_from_beta_group', args: { group_id: 'group-1', build_id: 'build-1' },
        method: 'DELETE', path: '/v1/betaGroups/group-1/relationships/builds',
        body: { data: [{type: 'builds', id: 'build-1'}] } },
      { id: 'send_beta_tester_invitation', args: { app_id: 'app-1', tester_id: 'tester-1' },
        method: 'POST', path: '/v1/betaTesterInvitations',
        body: {data: {type:'betaTesterInvitations', relationships:{
          app:{data:{type:'apps',id:'app-1'}}, betaTester:{data:{type:'betaTesters',id:'tester-1'}},
        }}} },
      { id: 'delete_beta_group', args: { group_id: 'group-1' },
        method: 'DELETE', path: '/v1/betaGroups/group-1' },
      { id: 'delete_beta_tester', args: { tester_id: 'tester-1' },
        method: 'DELETE', path: '/v1/betaTesters/tester-1' },
    ] as const;
    for (const item of cases) {
      expect(manifest.actions.find(action => action.actionId === item.id)).toMatchObject({
        confirmation: 'strong_confirmation', risk: 'remote_write', readOnly: false,
      });
      const output = await executeAppStoreConnectPluginAction(input(repoRoot, item.id,
        {...item.args, dry_run: true}));
      expect(output).toMatchObject({dryRun: true, request: {
        method: item.method, path: item.path,
        ...('body' in item ? {body: item.body} : {}),
      }});
    }
  });

  test('TestFlight 204 no-content revocation returns Apple receipt without retrying the mutation', async () => {
    const repoRoot = root();
    const privateKeyPath = join(repoRoot, 'AuthKey_TESTFLIGHT_REVOKE.p8');
    const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    writeFileSync(privateKeyPath, privateKey.export({ type: 'pkcs8', format: 'pem' }));
    await executeAppStoreConnectPluginAction(input(repoRoot, 'configure', {
      enabled: true, provider: 'app-store-connect-api', issuer_id: 'issuer-testflight',
      key_id: 'key-testflight', private_key_path: privateKeyPath,
    }));
    const old = globalThis.fetch;
    const requests: Array<{url: URL; method?: string; body?: string}> = [];
    globalThis.fetch = (async (request: string | URL | Request, init?: RequestInit) => {
      requests.push({url: new URL(String(request)), method: init?.method, body: init?.body?.toString()});
      return new Response(null, {status: 204});
    }) as typeof fetch;
    try {
      const result = await executeAppStoreConnectPluginAction(input(repoRoot, 'remove_beta_tester_from_group', {
        group_id: 'special/id', tester_id: 'tester-1',
      }));
      expect(result).toEqual({});
      expect(requests).toHaveLength(1);
      expect(requests[0]?.url.pathname).toBe('/v1/betaGroups/special%2Fid/relationships/betaTesters');
      expect(requests[0]?.method).toBe('DELETE');
      expect(JSON.parse(requests[0]?.body ?? '{}')).toEqual({
        data: [{type: 'betaTesters', id: 'tester-1'}],
      });
    } finally { globalThis.fetch = old; }
  });

  test('TestFlight group/tester and Xcode Cloud build actions keep public, invite and quota effects strongly gated', async () => {
    const repoRoot = root();
    await executeAppStoreConnectPluginAction(input(repoRoot, 'configure', {enabled:true,provider:'mock'}));
    const manifest = buildAppStoreConnectPluginManifest(1, undefined, repoRoot);
    for (const id of ['create_beta_group','update_beta_group','create_beta_tester',
      'assign_beta_tester_to_group','start_xcode_cloud_build']) {
      expect(manifest.actions.find(a=>a.actionId===id)).toMatchObject({
        readOnly:false,risk:'remote_write',confirmation:'strong_confirmation',
      });
    }
    const group = await executeAppStoreConnectPluginAction(input(repoRoot, 'create_beta_group', {
      app_id:'app-1',name:'External Preview',public_link_enabled:false,dry_run:true,
    }));
    expect(group).toMatchObject({dryRun:true,request:{method:'POST',path:'/v1/betaGroups',
      body:{data:{type:'betaGroups',attributes:{name:'External Preview',isInternalGroup:false,publicLinkEnabled:false},
        relationships:{app:{data:{type:'apps',id:'app-1'}}}}}}});
    const tester = await executeAppStoreConnectPluginAction(input(repoRoot, 'create_beta_tester', {
      group_id:'group-1',email:'tester@example.com',first_name:'Test',dry_run:true,
    }));
    expect(tester).toMatchObject({dryRun:true,request:{method:'POST',path:'/v1/betaTesters',
      body:{data:{attributes:{email:'tester@example.com',firstName:'Test'},
        relationships:{betaGroups:{data:[{type:'betaGroups',id:'group-1'}]}}}}}});
    const assign = await executeAppStoreConnectPluginAction(input(repoRoot, 'assign_beta_tester_to_group', {
      group_id:'group-1',tester_id:'tester-1',dry_run:true,
    }));
    expect(assign).toMatchObject({request:{method:'POST',path:'/v1/betaGroups/group-1/relationships/betaTesters',
      body:{data:[{type:'betaTesters',id:'tester-1'}]}}});
    const build = await executeAppStoreConnectPluginAction(input(repoRoot, 'start_xcode_cloud_build', {
      workflow_id:'workflow-1',dry_run:true,
    }));
    expect(build).toMatchObject({request:{method:'POST',path:'/v1/ciBuildRuns',
      body:{data:{type:'ciBuildRuns',relationships:{workflow:{data:{type:'ciWorkflows',id:'workflow-1'}}}}}}});
    await expect(executeAppStoreConnectPluginAction(input(repoRoot, 'create_beta_tester', {
      group_id:'group-1',email:'not-an-email',dry_run:true,
    }))).rejects.toThrow('email is invalid');
    await expect(executeAppStoreConnectPluginAction(input(repoRoot, 'update_beta_group', {
      group_id:'group-1',public_link_limit:10_001,dry_run:true,
    }))).rejects.toThrow('1 to 10000');
  });


  test('team access, webhook deliveries, compliance and performance reads use exact Apple APIs', async () => {
    const repoRoot = root();
    const privateKeyPath = join(repoRoot, 'AuthKey_TEAM_READS.p8');
    const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    writeFileSync(privateKeyPath, privateKey.export({ type: 'pkcs8', format: 'pem' }));
    await executeAppStoreConnectPluginAction(input(repoRoot, 'configure', {
      enabled:true,provider:'app-store-connect-api',issuer_id:'issuer-team',key_id:'key-team',
      private_key_path:privateKeyPath,
    }));
    const original = globalThis.fetch;
    const calls: Array<{url:URL;headers:Headers;method:string}> = [];
    globalThis.fetch = (async (request: string | URL | Request, init?: RequestInit) => {
      calls.push({url:new URL(String(request)),headers:new Headers(init?.headers),method:init?.method??'GET'});
      return Response.json({data:[]});
    }) as typeof fetch;
    try {
      await executeAppStoreConnectPluginAction(input(repoRoot,'list_team_users',{role:'APP_MANAGER'}));
      await executeAppStoreConnectPluginAction(input(repoRoot,'list_pending_user_invitations',{}));
      await executeAppStoreConnectPluginAction(input(repoRoot,'list_webhook_deliveries',{webhook_id:'hook-1',state:'FAILED'}));
      await executeAppStoreConnectPluginAction(input(repoRoot,'get_app_power_performance',{
        app_id:'app-1',metric_type:'LAUNCH',device_type:'all_iphones',platform:'IOS',
      }));
      await executeAppStoreConnectPluginAction(input(repoRoot,'get_build_power_performance',{build_id:'build-1'}));
      await executeAppStoreConnectPluginAction(input(repoRoot,'get_age_rating_declaration',{info_id:'info-1'}));
      await executeAppStoreConnectPluginAction(input(repoRoot,'list_accessibility_declarations',{app_id:'app-1',state:'PUBLISHED'}));
      await executeAppStoreConnectPluginAction(input(repoRoot,'list_app_store_version_experiments_v2',{version_id:'v-1'}));
      expect(calls.map(c=>c.url.pathname)).toEqual([
        '/v1/users','/v1/userInvitations','/v1/webhooks/hook-1/deliveries',
        '/v1/apps/app-1/perfPowerMetrics','/v1/builds/build-1/perfPowerMetrics',
        '/v1/appInfos/info-1/ageRatingDeclaration','/v1/apps/app-1/accessibilityDeclarations',
        '/v1/appStoreVersions/v-1/appStoreVersionExperimentsV2',
      ]);
      expect(calls[0]?.url.searchParams.get('filter[roles]')).toBe('APP_MANAGER');
      expect(calls[2]?.url.searchParams.get('filter[deliveryState]')).toBe('FAILED');
      expect(calls[3]?.url.searchParams.get('filter[metricType]')).toBe('LAUNCH');
      expect(calls[3]?.headers.get('accept')).toContain('application/vnd.apple.xcode-metrics+json');
      expect(calls[5]?.headers.get('accept')).toBe('application/json');
      expect(calls[6]?.url.searchParams.get('filter[state]')).toBe('PUBLISHED');
      expect(calls.every(c=>c.method==='GET')).toBe(true);
    } finally {globalThis.fetch=original;}
  });



  test('Analytics report lifecycle reads status and requires strong confirmation to stop ongoing reports', async () => {
    const repoRoot = root();
    await executeAppStoreConnectPluginAction(input(repoRoot, 'configure', {enabled:true,provider:'mock'}));
    const manifest = buildAppStoreConnectPluginManifest(1, undefined, repoRoot);
    for (const id of ['get_analytics_report','get_analytics_report_instance']) {
      expect(manifest.actions.find(item=>item.actionId===id)).toMatchObject({
        readOnly:true,confirmation:'none',risk:'readonly',
      });
    }
    expect(manifest.actions.find(item=>item.actionId==='delete_analytics_report_request')).toMatchObject({
      readOnly:false,risk:'remote_write',confirmation:'strong_confirmation',
    });
    const preview = await executeAppStoreConnectPluginAction(input(repoRoot,'delete_analytics_report_request',{
      report_request_id:'report-request/1',dry_run:true,
    }));
    expect(preview).toMatchObject({dryRun:true,request:{
      method:'DELETE',path:'/v1/analyticsReportRequests/report-request%2F1',
    }});
    const privateKeyPath = join(repoRoot, 'AuthKey_ANALYTICS_READS.p8');
    const {privateKey}=generateKeyPairSync('ec',{namedCurve:'P-256'});
    writeFileSync(privateKeyPath,privateKey.export({type:'pkcs8',format:'pem'}));
    await executeAppStoreConnectPluginAction(input(repoRoot,'configure',{
      enabled:true,provider:'app-store-connect-api',issuer_id:'issuer-reports',key_id:'key-reports',
      private_key_path:privateKeyPath,
    }));
    const old=globalThis.fetch;
    const paths:string[]=[];
    globalThis.fetch=(async(request:string|URL|Request)=>{
      const path=new URL(String(request)).pathname;
      paths.push(path);
      return Response.json({data:{id:path.split('/').pop(),attributes:{granularity:'DAILY',
        processingDate:'2026-11-10'}}});
    }) as typeof fetch;
    try {
      await executeAppStoreConnectPluginAction(input(repoRoot,'get_analytics_report',{report_id:'report-1'}));
      const period=await executeAppStoreConnectPluginAction(input(repoRoot,'get_analytics_report_instance',{
        instance_id:'instance-1',
      }));
      expect(period).toMatchObject({data:{id:'instance-1',attributes:{
        granularity:'DAILY',processingDate:'2026-11-10',
      }}});
      expect(paths).toEqual(['/v1/analyticsReports/report-1','/v1/analyticsReportInstances/instance-1']);
    } finally {globalThis.fetch=old;}
  });

  test('historical ASO instance summary verifies all Apple segments and rejects incomplete pagination', async () => {
    const repoRoot=root();
    const privateKeyPath=join(repoRoot,'AuthKey_INSTANCE.p8');
    const {privateKey}=generateKeyPairSync('ec',{namedCurve:'P-256'});
    writeFileSync(privateKeyPath,privateKey.export({type:'pkcs8',format:'pem'}));
    await executeAppStoreConnectPluginAction(input(repoRoot,'configure',{
      enabled:true,provider:'app-store-connect-api',issuer_id:'issuer-instance',key_id:'key-instance',
      private_key_path:privateKeyPath,
    }));
    const a=gzipSync('Date\tSource Type\tCounts\n2026-11-01\tApp Store search\t8\n2026-11-01\tApp Store browse\t2\n');
    const b=gzipSync('Date\tSource Type\tCounts\n2026-11-02\tApp Store search\t12\n');
    const base='https://reports.s3.us-west-2.amazonaws.com';
    const original=globalThis.fetch;
    let forceNext=false;
    let missingChecksum=false;
    let noSegments=false;
    globalThis.fetch=(async (request:string|URL|Request)=>{
      const url=new URL(String(request));
      if (url.pathname.endsWith('/instances/')) throw new Error('Unexpected list endpoint');
      if (url.pathname==='/v1/analyticsReportInstances/instance-1/segments') {
        expect(url.searchParams.get('limit')).toBe('9');
        return Response.json({data:noSegments?[]:[
          {id:'seg-a',attributes:{url:base+'/a.csv.gz',sizeInBytes:a.length,checksum:missingChecksum?undefined:createHash('md5').update(a).digest('hex')}},
          {id:'seg-b',attributes:{url:base+'/b.csv.gz',sizeInBytes:b.length,checksum:createHash('md5').update(b).digest('hex')}},
        ],links:{next:forceNext?'https://api.appstoreconnect.apple.com/v1/analyticsReportInstances/instance-1/segments?cursor=next':null}});
      }
      if (url.pathname==='/a.csv.gz') return new Response(a);
      if (url.pathname==='/b.csv.gz') return new Response(b);
      throw new Error('Unexpected path '+url.pathname);
    }) as typeof fetch;
    try {
      const summary=await executeAppStoreConnectPluginAction(input(repoRoot,'summarize_analytics_instance',{
        instance_id:'instance-1',group_by:'Source Type',metric:'Counts',
      }));
      expect(summary).toMatchObject({instanceId:'instance-1',complete:true,segmentCount:2,checksumVerified:true,
        segments:['seg-a','seg-b'],sourceRows:3,distinctGroups:2,truncated:false,
        groups:[{dimensions:{'Source Type':'App Store search'},total:20},
          {dimensions:{'Source Type':'App Store browse'},total:2}],
      });
      forceNext=true;
      await expect(executeAppStoreConnectPluginAction(input(repoRoot,'summarize_analytics_instance',{
        instance_id:'instance-1',group_by:'Source Type',
      }))).rejects.toThrow('Too many segments');
      forceNext=false;
      missingChecksum=true;
      await expect(executeAppStoreConnectPluginAction(input(repoRoot,'summarize_analytics_instance',{
        instance_id:'instance-1',group_by:'Source Type',
      }))).rejects.toThrow('MD5 checksum');
      missingChecksum=false;
      noSegments=true;
      await expect(executeAppStoreConnectPluginAction(input(repoRoot,'summarize_analytics_instance',{
        instance_id:'instance-1',group_by:'Source Type',
      }))).rejects.toThrow('no downloadable segments');
    } finally {globalThis.fetch=original;}
  });

  test('verifies Apple-signed Analytics segment checksum and decodes bounded historical TSV', async () => {
    const repoRoot = root();
    const privateKeyPath = join(repoRoot, 'AuthKey_SEGMENT.p8');
    const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    writeFileSync(privateKeyPath, privateKey.export({ type: 'pkcs8', format: 'pem' }));
    await executeAppStoreConnectPluginAction(input(repoRoot, 'configure', {
      enabled: true, provider: 'app-store-connect-api', issuer_id: 'issuer-segment',
      key_id: 'key-segment', private_key_path: privateKeyPath,
    }));
    const bytes = gzipSync('Date\tSource Type\tImpressions\n2026-11-01\tApp Store search\t42\n2026-11-02\tApp Store browse\t20\n');
    const checksum = createHash('md5').update(bytes).digest('hex');
    const original = globalThis.fetch;
    const assetUrl = 'https://reports.s3.us-west-2.amazonaws.com/segment.csv.gz?signed=1';
    let invalidChecksum = false;
    let oversizedStream = false;
    globalThis.fetch = (async (request: string | URL | Request, init?: RequestInit) => {
      const target = String(request);
      if (target.includes('/v1/analyticsReportSegments/')) {
        expect(new Headers(init?.headers).get('authorization')).toMatch(/^Bearer /);
        return Response.json({ data: { attributes: { url: assetUrl, sizeInBytes: bytes.length,
          checksum: invalidChecksum ? '00000000000000000000000000000000' : checksum } } });
      }
      expect(target).toBe(assetUrl);
      expect(new Headers(init?.headers).has('authorization')).toBe(false);
      if (oversizedStream) {
        return new Response(new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new Uint8Array(9 * 1024 * 1024));
            controller.enqueue(new Uint8Array(8 * 1024 * 1024));
            controller.close();
          },
        }), {status: 200, headers: {'content-type':'application/a-gzip'}});
      }
      return new Response(bytes, { status: 200, headers: { 'content-type': 'application/a-gzip' } });
    }) as typeof fetch;
    try {
      const report = await executeAppStoreConnectPluginAction(input(repoRoot, 'read_analytics_segment_data',
        { segment_id: 'segment-1', max_rows: 1 }));
      expect(report).toMatchObject({ checksumVerified: true, totalRows: 2, truncated: true,
        columns: ['Date', 'Source Type', 'Impressions'], rows: [['2026-11-01','App Store search','42']] });
      const grouped = await executeAppStoreConnectPluginAction(input(repoRoot, 'summarize_analytics_segment',
        {segment_id:'segment-1',group_by:'Source Type',metric:'Impressions'}));
      expect(grouped).toMatchObject({checksumVerified:true,groupBy:['Source Type'],metric:'Impressions',
        distinctGroups:2,sourceRows:2,excludedRows:0,truncated:false,
        groups:[{dimensions:{'Source Type':'App Store search'},total:42},
          {dimensions:{'Source Type':'App Store browse'},total:20}],
      });
      const filtered = await executeAppStoreConnectPluginAction(input(repoRoot, 'summarize_analytics_segment',
        {segment_id:'segment-1',group_by:'Date',metric:'Impressions',filter_column:'Source Type',
          filter_value:'App Store search',max_groups:1}));
      expect(filtered).toMatchObject({distinctGroups:1,sourceRows:1,excludedRows:1,
        groups:[{dimensions:{Date:'2026-11-01'},total:42}]});
      await expect(executeAppStoreConnectPluginAction(input(repoRoot, 'summarize_analytics_segment',
        {segment_id:'segment-1',group_by:'Missing Column',metric:'Impressions'}))).rejects.toThrow('absent');
      invalidChecksum = true;
      await expect(executeAppStoreConnectPluginAction(input(repoRoot, 'read_analytics_segment_data',
        { segment_id: 'segment-1' }))).rejects.toThrow('checksum mismatch');
      oversizedStream = true;
      await expect(executeAppStoreConnectPluginAction(input(repoRoot, 'read_analytics_segment_data',
        { segment_id: 'segment-1' }))).rejects.toThrow('inline download limit');
    } finally {
      globalThis.fetch = original;
    }
  });

  test('uses team vendor reporting filters and decompresses official Sales and Finance TSV', async () => {
    const repoRoot = root();
    const privateKeyPath = join(repoRoot, 'AuthKey_SALES.p8');
    const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    writeFileSync(privateKeyPath, privateKey.export({ type: 'pkcs8', format: 'pem' }));
    await executeAppStoreConnectPluginAction(input(repoRoot, 'configure', {
      enabled: true, provider: 'app-store-connect-api', issuer_id: 'issuer-sales',
      key_id: 'key-sales', private_key_path: privateKeyPath,
    }));
    const original = globalThis.fetch;
    const bytes = gzipSync('Date\tUnits\n2026-11-01\t12\n');
    const urls: URL[] = [];
    globalThis.fetch = (async (request: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(request));
      urls.push(url);
      expect(new Headers(init?.headers).get('authorization')).toMatch(/^Bearer /);
      return new Response(bytes, { status: 200, headers: { 'content-type': 'application/a-gzip' } });
    }) as typeof fetch;
    try {
      const sales = await executeAppStoreConnectPluginAction(input(repoRoot, 'read_sales_report',
        { vendor_number: '12345678', report_date: '2026-11-01' }));
      expect(sales).toMatchObject({ reportType:'sales', rows:[['2026-11-01','12']], totalRows:1 });
      expect(urls[0]?.pathname).toBe('/v1/salesReports');
      expect(urls[0]?.searchParams.get('filter[vendorNumber]')).toBe('12345678');
      const finance = await executeAppStoreConnectPluginAction(input(repoRoot, 'read_finance_report',
        { vendor_number: '12345678', report_date: '2026-10', region_code: 'ZZ' }));
      expect(finance).toMatchObject({ reportType:'finance', totalRows:1 });
      expect(urls[1]?.pathname).toBe('/v1/financeReports');
      expect(urls[1]?.searchParams.get('filter[reportType]')).toBe('FINANCIAL');
      await expect(executeAppStoreConnectPluginAction(input(repoRoot, 'read_finance_report',
        { vendor_number:'123', report_date:'2026-11-01', region_code:'ZZ' }))).rejects.toThrow('date format');
    } finally { globalThis.fetch = original; }
  });

  test('imports legacy repo-harness config only through an explicit Controller context', async () => {
    const repoRoot = root();
    const legacyRoot = join(repoRoot, '.repo-harness', 'plugins');
    mkdirSync(legacyRoot, { recursive: true });
    writeFileSync(join(legacyRoot, 'app-store-connect.json'), JSON.stringify({
      schemaVersion: 1,
      enabled: true,
      provider: 'mock',
      defaultLocale: 'en-US',
    }, null, 2));

    const controllerHome = join(repoRoot, '.controller');
    const context = { controllerHome, repoId: 'repo-test', repoRoot, controllerScoped: false };
    migrateLegacyControllerPluginConfigs(controllerHome, undefined, [{ repoId: 'repo-test', canonicalRoot: repoRoot }]);
    const manifest = buildAppStoreConnectPluginManifest(1, undefined, repoRoot, context);
    expect(manifest.enabled).toBe(true);
    expect(manifest.health.ready).toBe(true);
    expect(manifest.authority.sourceOfTruth).toContain('controller-global:system/plugins/config/app-store-connect.json');
    const auth = await executeAppStoreConnectPluginAction(input(repoRoot, 'auth_status', {}));
    expect(auth).toMatchObject({ ready: true, provider: 'mock' });
  });


  test('controller-global profile is inherited by repositories without duplicating credential references', async () => {
    const repoRoot = root();
    const controllerHome = join(repoRoot, '.controller');
    const privateKeyPath = join(repoRoot, 'AuthKey_TEST.p8');
    writeFileSync(privateKeyPath, 'test-key-material-never-persisted-inline');

    const controllerInput = {
      ...input(repoRoot, 'configure', {
        enabled: true,
        provider: 'app-store-connect-api',
        issuer_id: 'issuer-global',
        key_id: 'key-global',
        private_key_path: privateKeyPath,
        team_id: 'TEAMGLOBAL',
      }),
      controllerHome,
      repoId: CONTROLLER_PLUGIN_CONFIG_SCOPE,
      repoRoot: controllerSystemRoot(controllerHome),
    };
    await executeAppStoreConnectPluginAction(controllerInput);

    const manifest = buildAppStoreConnectPluginManifest(1, undefined, repoRoot, {
      controllerHome,
      repoId: 'repo-child',
      repoRoot,
      controllerScoped: false,
    });
    expect(manifest.enabled).toBe(true);
    expect(manifest.health.details).toMatchObject({ teamId: 'TEAMGLOBAL', credentialSource: 'config:privateKeyPath' });
    expect(existsSync(join(repoRoot, '.forge', 'plugins', 'app-store-connect.json'))).toBe(false);

    const globalPath = controllerPluginConfigPath(controllerHome, 'app_store_connect');
    const persisted = readFileSync(globalPath, 'utf-8');
    expect(persisted).toContain(privateKeyPath);
    expect(persisted).not.toContain('test-key-material-never-persisted-inline');
  });

  test('capability and auth-status probes degrade invalid key references without reading secret bytes', async () => {
    const repoRoot = root();
    const privateKeyPath = join(repoRoot, 'AuthKey_DIRECTORY.p8');
    mkdirSync(privateKeyPath);
    await executeAppStoreConnectPluginAction(input(repoRoot, 'configure', {
      enabled: true,
      provider: 'app-store-connect-api',
      issuer_id: 'issuer-test',
      key_id: 'key-test',
      private_key_path: privateKeyPath,
    }));

    const manifest = buildAppStoreConnectPluginManifest(1, undefined, repoRoot, { controllerHome: join(repoRoot, '.controller'), repoId: 'repo-test', repoRoot, controllerScoped: false });
    expect(manifest.enabled).toBe(true);
    expect(manifest.health).toMatchObject({ state: 'degraded', ready: false, probed: true });
    expect(manifest.health.warnings.join(' ')).toContain('private key path is not a regular file');

    const auth = await executeAppStoreConnectPluginAction(input(repoRoot, 'auth_status', {})) as {
      ready: boolean;
      provider: string;
      warnings: string[];
    };
    expect(auth).toMatchObject({ ready: false, provider: 'app-store-connect-api' });
    expect(auth.warnings.join(' ')).toContain('private key path is not a regular file');
  });

  test('auth-status proves file-backed key material is locally readable and tolerates one transient EDEADLK', async () => {
    const repoRoot = root();
    const privateKeyPath = join(repoRoot, 'AuthKey_REMOTE.p8');
    const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    writeFileSync(privateKeyPath, privateKey.export({ type: 'pkcs8', format: 'pem' }));
    await executeAppStoreConnectPluginAction(input(repoRoot, 'configure', {
      enabled: true,
      provider: 'app-store-connect-api',
      issuer_id: 'issuer-remote',
      key_id: 'key-remote',
      private_key_path: privateKeyPath,
    }));

    const originalReadFile = fsPromises.readFile;
    const originalFetch = globalThis.fetch;
    const invokeOriginalReadFile = originalReadFile as unknown as (...args: unknown[]) => Promise<unknown>;
    let keyReadAttempts = 0;
    let requestedUrl = '';
    Object.defineProperty(fsPromises, 'readFile', {
      configurable: true,
      writable: true,
      value: async (...args: unknown[]) => {
        if (String(args[0]) === privateKeyPath) {
          keyReadAttempts += 1;
          if (keyReadAttempts === 1) {
            const error = new Error('simulated private-key filesystem contention') as NodeJS.ErrnoException;
            error.code = 'EDEADLK';
            throw error;
          }
        }
        return invokeOriginalReadFile(...args);
      },
    });
    globalThis.fetch = (async (request: string | URL | Request, init?: RequestInit) => {
      requestedUrl = String(request);
      expect(new Headers(init?.headers).get('authorization')).toMatch(/^Bearer \S+$/);
      return new Response(JSON.stringify({ data: [] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch;

    try {
      const auth = await executeAppStoreConnectPluginAction(input(repoRoot, 'auth_status', {})) as { ready: boolean; provider: string };
      expect(auth).toMatchObject({ ready: true, provider: 'app-store-connect-api' });
      expect(keyReadAttempts).toBe(2);

      const result = await executeAppStoreConnectPluginAction(input(repoRoot, 'list_xcode_cloud_products', { app_id: '6775778505' }));
      expect(result).toEqual({ data: [] });
      expect(keyReadAttempts).toBe(3);
      expect(requestedUrl).toContain('/v1/ciProducts');
      expect(requestedUrl).toContain('6775778505');

      const versions = await executeAppStoreConnectPluginAction(input(repoRoot, 'list_app_store_versions', {
        app_id: 'app/id', limit: 7,
      }));
      expect(versions).toEqual({ data: [] });
      const versionsUrl = new URL(requestedUrl);
      expect(versionsUrl.pathname).toBe('/v1/apps/app%2Fid/appStoreVersions');
      expect(versionsUrl.searchParams.get('limit')).toBe('7');
      expect(versionsUrl.searchParams.has('filter[app]')).toBe(false);
    } finally {
      Object.defineProperty(fsPromises, 'readFile', { configurable: true, writable: true, value: originalReadFile });
      globalThis.fetch = originalFetch;
    }
  });

  test('persistent EDEADLK is reported as local credential unavailability instead of provider outage', async () => {
    const repoRoot = root();
    const privateKeyPath = join(repoRoot, 'AuthKey_DATALESS.p8');
    const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    writeFileSync(privateKeyPath, privateKey.export({ type: 'pkcs8', format: 'pem' }));
    await executeAppStoreConnectPluginAction(input(repoRoot, 'configure', {
      enabled: true,
      provider: 'app-store-connect-api',
      issuer_id: 'issuer-dataless',
      key_id: 'key-dataless',
      private_key_path: privateKeyPath,
    }));

    const originalReadFile = fsPromises.readFile;
    let keyReadAttempts = 0;
    Object.defineProperty(fsPromises, 'readFile', {
      configurable: true,
      writable: true,
      value: async (...args: unknown[]) => {
        if (String(args[0]) === privateKeyPath) {
          keyReadAttempts += 1;
          const error = new Error('simulated dataless File Provider contention') as NodeJS.ErrnoException;
          error.code = 'EDEADLK';
          throw error;
        }
        return (originalReadFile as unknown as (...values: unknown[]) => Promise<unknown>)(...args);
      },
    });

    try {
      const auth = await executeAppStoreConnectPluginAction(input(repoRoot, 'auth_status', {})) as { ready: boolean; errors: string[] };
      expect(auth.ready).toBe(false);
      expect(auth.errors.join(' ')).toContain('not locally available');
      expect(keyReadAttempts).toBeGreaterThan(1);

      let failure: unknown;
      try {
        await executeAppStoreConnectPluginAction(input(repoRoot, 'list_apps', {}));
      } catch (error) {
        failure = error;
      }
      expect(failure).toMatchObject({ code: 'PLUGIN_AUTH_REQUIRED', retryable: false });
      expect(String((failure as Error).message)).toContain('stable local private_key_path');
    } finally {
      Object.defineProperty(fsPromises, 'readFile', { configurable: true, writable: true, value: originalReadFile });
    }
  });

  test('resolves a file-backed Xcode authentication reference from the controller-global profile for a repository', async () => {
    const repoRoot = root();
    const controllerHome = join(repoRoot, '.controller');
    const privateKeyPath = join(repoRoot, 'AuthKey_XCODE.p8');
    writeFileSync(privateKeyPath, 'file-backed-test-key');
    await executeAppStoreConnectPluginAction({
      ...input(repoRoot, 'configure', {
        enabled: true,
        provider: 'app-store-connect-api',
        issuer_id: 'issuer-xcode',
        key_id: 'key-xcode',
        private_key_path: privateKeyPath,
      }),
      controllerHome,
      repoId: CONTROLLER_PLUGIN_CONFIG_SCOPE,
      repoRoot: controllerSystemRoot(controllerHome),
    });

    const reference = resolveAppStoreConnectXcodeAuthenticationReference(repoRoot, controllerHome, 'repo-child');
    expect(reference).toEqual({ privateKeyPath, keyId: 'key-xcode', issuerId: 'issuer-xcode' });
    expect(existsSync(join(repoRoot, '.forge', 'plugins', 'app-store-connect.json'))).toBe(false);
  });

  test('configuration through any repository updates one Controller-global App Store Connect profile', async () => {
    const repoRoot = root();
    const controllerHome = join(repoRoot, '.controller');
    await executeAppStoreConnectPluginAction({
      ...input(repoRoot, 'configure', { enabled: true, provider: 'mock', team_id: 'GLOBAL', default_locale: 'en-US' }),
      controllerHome,
      repoId: CONTROLLER_PLUGIN_CONFIG_SCOPE,
      repoRoot: controllerSystemRoot(controllerHome),
    });

    const child = { ...input(repoRoot, 'configure', { default_locale: 'fr-FR' }), controllerHome, repoId: 'repo-child' };
    const configured = await executeAppStoreConnectPluginAction(child) as { config: { enabled: boolean; teamId?: string; defaultLocale?: string } };
    expect(configured.config).toMatchObject({ enabled: true, teamId: 'GLOBAL', defaultLocale: 'fr-FR' });
    const canonicalPath = controllerPluginConfigPath(controllerHome, 'app_store_connect');
    const stored = JSON.parse(readFileSync(canonicalPath, 'utf-8')) as Record<string, unknown>;
    expect(stored).toMatchObject({ schemaVersion: 1, enabled: true, teamId: 'GLOBAL', defaultLocale: 'fr-FR' });
    expect(existsSync(join(controllerHome, 'repositories', 'repo-child', 'plugins', 'config', 'app-store-connect.json'))).toBe(false);
    const otherRepository = buildAppStoreConnectPluginManifest(1, undefined, repoRoot, {
      controllerHome, repoId: 'repo-other', repoRoot, controllerScoped: false,
    });
    expect(otherRepository.enabled).toBe(true);

    await executeAppStoreConnectPluginAction({ ...child, requestId: 'test-disable', args: { enabled: false } });
    const disabled = buildAppStoreConnectPluginManifest(1, undefined, repoRoot, {
      controllerHome,
      repoId: 'repo-child',
      repoRoot,
      controllerScoped: false,
    });
    expect(disabled.enabled).toBe(false);
  });

  test('mock developer-resource reads stay read-only and preserve bounded typed filters', async () => {
    const repoRoot = root();
    await executeAppStoreConnectPluginAction(input(repoRoot, 'configure', { enabled: true, provider: 'mock' }));
    const bundleIds = await executeAppStoreConnectPluginAction(input(repoRoot, 'list_bundle_ids', { identifier: 'com.example.target', limit: 5 })) as { data: Array<{ attributes: { identifier: string } }> };
    const capabilities = await executeAppStoreConnectPluginAction(input(repoRoot, 'list_bundle_id_capabilities', { bundle_id_resource_id: 'bundle-1' })) as { data: Array<{ attributes: { capabilityType: string } }> };
    const devices = await executeAppStoreConnectPluginAction(input(repoRoot, 'list_devices', { udid: 'DEVICE-UDID' })) as { data: Array<{ attributes: { udid: string } }> };
    expect(bundleIds.data[0]?.attributes.identifier).toBe('com.example.target');
    expect(capabilities.data[0]?.attributes.capabilityType).toBe('ICLOUD');
    expect(devices.data[0]?.attributes.udid).toBe('DEVICE-UDID');
  });

  test('dry-run maps workflow trigger settings onto the official ciWorkflows PATCH resource', async () => {
    const repoRoot = root();
    await executeAppStoreConnectPluginAction(input(repoRoot, 'configure', { enabled: true, provider: 'mock' }));
    const result = await executeAppStoreConnectPluginAction(input(repoRoot, 'update_xcode_cloud_workflow', {
      workflow_id: 'workflow-1',
      is_enabled: true,
      clean: true,
      branch_start_condition: { source: { isAllMatch: true } },
      scheduled_start_condition: null,
      dry_run: true,
    }));
    expect(result).toMatchObject({
      dryRun: true,
      request: {
        method: 'PATCH',
        path: '/v1/ciWorkflows/workflow-1',
        body: {
          data: {
            type: 'ciWorkflows',
            id: 'workflow-1',
            attributes: {
              isEnabled: true,
              clean: true,
              branchStartCondition: { source: { isAllMatch: true } },
              scheduledStartCondition: null,
            },
          },
        },
      },
    });
  });
});
