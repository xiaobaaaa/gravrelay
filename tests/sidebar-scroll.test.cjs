const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm');
const install=require('../runtime/sidebar-scroll.cjs');
function fixture({child=false,sticky=true,host=true}={}) {
 const frames=new Map(),mutations=[],resizes=[];let next=0;
 function style(initial={}) {const values=new Map(Object.entries(initial).map(([k,v])=>[k,{v,p:''}]));return{
  getPropertyValue:k=>values.get(k)?.v||'',getPropertyPriority:k=>values.get(k)?.p||'',
  setProperty:(k,v,p='')=>values.set(k,{v,p}),removeProperty:k=>values.delete(k),
 };}
 function nodes() {
  const scroller={scrollTop:0,clientHeight:900,clientTop:0,style:style(),events:new Map(),
   getBoundingClientRect:()=>({top:100}),addEventListener(k,f){this.events.set(k,f)},removeEventListener(k,f){if(this.events.get(k)===f)this.events.delete(k)}};
  const remote={isConnected:true,hidden:false};
  const row={isConnected:true,style:style({position:sticky?'sticky':'relative',top:'0px'}),
   matches:s=>s==='[data-index]',querySelector:()=>host?remote:null,closest:()=>scroller,
   getBoundingClientRect:()=>({top:100-scroller.scrollTop})};
  const heading={parentElement:row,style:style()};const plus={closest:()=>heading};
  return{scroller,row,heading,remote,plus};
 }
 let current=nodes();const window={};window.top=child?{}:window;
 const context=vm.createContext({window,document:{documentElement:{},querySelector:()=>current.plus},Map,
  getComputedStyle:e=>({position:e.style.getPropertyValue('position')}),
  requestAnimationFrame:fn=>{frames.set(++next,fn);return next},cancelAnimationFrame:id=>frames.delete(id),
  MutationObserver:class{constructor(fn){this.fn=fn;mutations.push(this)}observe(target){this.target=target}disconnect(){this.disconnected=true}},
  ResizeObserver:class{constructor(fn){this.fn=fn;resizes.push(this)}observe(){}disconnect(){this.disconnected=true}},
 });
 const run=()=>vm.runInContext('('+install.toString()+')()',context);run();
 const flush=()=>{let rounds=0;while(frames.size){assert(++rounds<20);let q=[...frames.values()];frames.clear();q.forEach(f=>f())}};
 return{context,run,flush,mutations,resizes,frames,get current(){return current},remount(){current=nodes();mutations[0].fn();flush()},scroll(y){current.scroller.scrollTop=y;current.scroller.events.get('scroll')?.();flush()}};
}
test('scrolls the SSH virtual item normally and pins only its heading',()=>{
 const f=fixture();f.scroll(1500);assert.equal(f.current.row.style.getPropertyValue('position'),'relative');
 assert.equal(f.current.heading.style.getPropertyValue('transform'),'translateY(1500px)');
 assert.equal(f.current.scroller.scrollTop,1500);assert.equal(f.current.scroller.events.size,1);
});
test('resizing and native style reconciliation keep one scrollbar without changing its offset',()=>{
 const f=fixture();f.scroll(650);f.current.row.style.setProperty('position','sticky');
 f.mutations.find(m=>m.target===f.current.row).fn();f.resizes[0].fn();f.flush();
 assert.equal(f.current.row.style.getPropertyValue('position'),'relative');assert.equal(f.current.scroller.scrollTop,650);
 assert.equal(f.current.scroller.events.size,1);
});
test('collapse restores the native header and expanding binds it again',()=>{
 const f=fixture();f.current.remote.hidden=true;f.mutations[0].fn();f.flush();
 assert.equal(f.current.row.style.getPropertyValue('position'),'sticky');assert.equal(f.current.scroller.events.size,0);
 f.current.remote.hidden=false;f.mutations[0].fn();f.flush();assert.equal(f.current.scroller.events.size,1);
});
test('native row remount does not leave listeners or a second scrolling layer',()=>{
 const f=fixture(),old=f.current;f.remount();assert.equal(old.scroller.events.size,0);
 assert.equal(old.row.style.getPropertyValue('position'),'sticky');assert.equal(f.current.scroller.events.size,1);
});
test('removal cancels pending work and restores only styles still owned by the adapter',()=>{
 const f=fixture();f.current.heading.style.setProperty('background-color','red');
 f.current.scroller.events.get('scroll')();f.context.__gravRelaySidebarScrolling.remove();f.flush();
 assert.equal(f.current.heading.style.getPropertyValue('background-color'),'red');
 assert.equal(f.current.heading.style.getPropertyValue('transform'),'');assert.equal(f.current.row.style.getPropertyValue('position'),'sticky');
 assert.equal(f.current.scroller.events.size,0);assert(f.mutations.every(m=>m.disconnected));assert(f.resizes.every(m=>m.disconnected));
});
test('does not patch embedded SSH workspaces, absent SSH rows or a native nonsticky layout',()=>{
 for(const options of[{child:true},{host:false},{sticky:false}]){const f=fixture(options);assert.equal(f.current.scroller.events.size,0)}
});
test('installing twice cannot add duplicate observers or scroll handlers',()=>{
 const f=fixture(),n=f.mutations.length;f.run();assert.equal(f.mutations.length,n);assert.equal(f.current.scroller.events.size,1);
});
