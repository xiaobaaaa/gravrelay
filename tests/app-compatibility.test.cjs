const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm');
const compatibility=require('../runtime/compatibility.json');
const {supportedAppVersions,isAppVersionSupported,installCompatibilityNotice}=require('../runtime/app-compatibility.cjs');

test('only explicitly reviewed application versions are supported',()=>{
  assert.equal(isAppVersionSupported(compatibility,'2.29.0'),true);
  assert.equal(isAppVersionSupported(compatibility,'2.31.0'),true);
  for(const version of ['2.30.0','2.31.1','2.32.0','99.0.0',''])
    assert.equal(isAppVersionSupported(compatibility,version),false,version);
});
test('legacy metadata remains supported and malformed allowlists fail closed',()=>{
  assert.deepEqual(supportedAppVersions({appVersion:'2.29.0'}),['2.29.0']);
  for(const values of [[], '2.31.0', [null], ['2.31.*']])
    assert.deepEqual(supportedAppVersions({appVersion:'2.29.0',supportedAppVersions:values}),[]);
});

function fixture(ready=true){
  class Element{
    constructor(tag){this.tag=tag;this.children=[];this.attributes={};this.style={};}
    setAttribute(k,v){this.attributes[k]=v;}getAttribute(k){return this.attributes[k];}
    append(...nodes){for(const n of nodes){n.parent=this;this.children.push(n);}}
    remove(){if(this.parent)this.parent.children=this.parent.children.filter(n=>n!==this);}
  }
  const body=new Element('body'),callbacks=[];
  const document={body:ready?body:null,createElement:tag=>new Element(tag),getElementById:id=>body.children.find(e=>e.id===id),addEventListener:(event,fn)=>callbacks.push({event,fn})};
  const context=vm.createContext({document});
  const show=(version='2.32.0')=>vm.runInContext('('+installCompatibilityNotice.toString()+')('+JSON.stringify(version)+','+JSON.stringify(['2.29.0','2.31.0'])+')',context);
  return{body,document,callbacks,show};
}
test('unsupported notice reports preserved data and can be dismissed for this app session',()=>{
  const x=fixture();x.show();x.show();assert.equal(x.body.children.length,1);
  const box=x.body.children[0];assert.equal(box.getAttribute('role'),'status');
  assert.match(box.children[1].textContent,/2.32.0/);assert.match(box.children[1].textContent,/preserved/);
  assert.equal(box.children[2].href,'https://github.com/xiaobaaaa/gravrelay/releases/latest');
  box.children[3].onclick();x.show();assert.equal(x.body.children.length,0);
  x.show('2.33.0');assert.equal(x.body.children.length,1);
});
test('notice waits for the new frontend document without losing the explanation',()=>{
  const x=fixture(false);x.show();assert.equal(x.callbacks[0].event,'DOMContentLoaded');
  assert.equal(x.body.children.length,0);x.document.body=x.body;x.callbacks[0].fn();
  assert.equal(x.body.children.length,1);
});
