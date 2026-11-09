const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm');
const install=require('../runtime/permissions.cjs');
function fixture({top=false,host='devbox',frontendHost=host}={}) {
 const input={showPermissionsSelector:false,enableMicrophone:true},scope={enabled:false};
 const cache=new Map([['inputComponent',input],['conversationScopedPermissions',scope],['unrelated',{enabled:false}]]);
 const features={getCache:cache,get:key=>cache.get(key),featureNames:['inputComponent','conversationScopedPermissions'],runtimeEnvironment:{}};
 const holder={memoizedProps:{value:features},return:null};
 const root={__reactFiber_fixture:{return:holder}};
 const window={top:top?null:{}};if(top)window.top=window;
 let callback,disconnected=false;
 const context=vm.createContext({window,URL,location:new URL('https://127.0.0.1:4000/?__gravrelay_ssh='+host),__gravRelayCLIFrontend:{host:frontendHost},document:{documentElement:{},querySelector:()=>root},queueMicrotask:fn=>fn(),MutationObserver:class{constructor(fn){callback=fn}observe(){}disconnect(){disconnected=true}}});
 vm.runInContext('('+install.toString()+')()',context);
 return {context,cache,features,input,scope,holder,root,mutate:()=>callback?.(),disconnected:()=>disconnected};
}
test('restores the native picker without enabling unsupported permission features',()=>{
 const x=fixture();
 assert.equal(x.cache.get('inputComponent').showPermissionsSelector,true);
 assert.equal(x.cache.get('inputComponent').enableMicrophone,true);
 assert.equal(x.cache.get('conversationScopedPermissions').enabled,false);
 assert.equal(x.input.showPermissionsSelector,false);
 assert.equal(x.scope.enabled,false);
 assert.deepEqual([...x.cache.keys()],['inputComponent','conversationScopedPermissions','unrelated']);
 assert.equal(x.cache.get('unrelated').enabled,false);
 assert.equal(x.context.__gravRelayNativePermissions.version,2);
});
test('never changes the Mac client or another backend frame',()=>{
 const root=fixture({top:true});
 assert.equal(root.cache.get('inputComponent'),root.input);
 const other=fixture({frontendHost:'other-host'});
 assert.equal(other.cache.get('inputComponent'),other.input);
});
test('handles a replaced native feature provider after async startup',()=>{
 const x=fixture(),input={showPermissionsSelector:false},scope={enabled:false};
 const cache=new Map([['inputComponent',input],['conversationScopedPermissions',scope]]);
 const features={getCache:cache,get:key=>cache.get(key),featureNames:[],runtimeEnvironment:{}};
 x.holder.memoizedProps.value=features;x.mutate();
 assert.equal(cache.get('inputComponent').showPermissionsSelector,true);
 assert.equal(cache.get('conversationScopedPermissions').enabled,false);
});
test('removal restores its own feature changes while preserving newer native changes',()=>{
 const x=fixture(),newer={showPermissionsSelector:false,reason:'native refresh'};
 x.cache.set('inputComponent',newer);
 x.context.__gravRelayNativePermissions.remove();
 assert.equal(x.cache.get('inputComponent'),newer);
 assert.equal(x.cache.get('conversationScopedPermissions'),x.scope);
 assert.equal(x.disconnected(),true);
});

