import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
const plain=value=>JSON.parse(JSON.stringify(value));

async function fixture(){
  const replies=[],resizes=[],nodes=new Map();
  const document={name:'Viewport fixture',children:[]};
  const page={id:'page',type:'PAGE',parent:document,children:[],flowStartingPoints:[],prototypeBackgrounds:[],loadAsync:async()=>{}};document.children.push(page);nodes.set(page.id,page);
  function node(id,parent,type,x,y,width,height){
    const n={id,name:id,type,parent,x,y,width,height,visible:true,layoutMode:'NONE',constraints:{horizontal:'MIN',vertical:'MIN'},reactions:[],overflowDirection:'NONE',
      resize(w,h){if(this.children)throw Error('Constraint-aware resize must not be used on frames');this.width=w;this.height=h;},
      resizeWithoutConstraints(w,h){resizes.push(id);this.width=w;this.height=h;},
      async setReactionsAsync(value){if(value.some(r=>r.actions?.some(a=>a.transition?.duration<0)))throw Error('Invalid native transition');this.reactions=plain(value);},
    };
    if(type==='FRAME'){n.children=[];n.numberOfFixedChildren=0;}
    if(type==='TEXT'){n.characters='Navigation';n.fontSize=48;n.fontName={family:'Inter',style:'Regular'};}
    parent.children.push(n);nodes.set(id,n);return n;
  }
  const root=node('screen',page,'FRAME',4000,5000,1236,2874);
  const shell=node('shell',root,'FRAME',0,0,1236,2874);
  const background=node('background',shell,'RECTANGLE',0,0,1236,2874);
  const content=node('content',shell,'FRAME',0,357,1236,2271);content.overflowDirection='VERTICAL';
  const body=node('body',content,'TEXT',48,400,900,100);
  const footer=node('footer',shell,'RECTANGLE',-12,2574,1260,324);
  const icon=node('icon',shell,'FRAME',136,2675,66,66);
  const label=node('label',shell,'TEXT',115,2768,116,63);
  const modal=node('modal',shell,'FRAME',0,2253,1236,621);
  const modalText=node('modal-text',modal,'TEXT',100,100,400,100);
  const figma={root:document,fileKey:'fixture',showUI(){},ui:{postMessage:reply=>replies.push(plain(reply))},currentPage:page,getNodeByIdAsync:async id=>nodes.get(id)||null};
  vm.runInNewContext(await readFile(new URL('./figma-plugin/code.js',import.meta.url),'utf8'),{figma,__html__:''});
  async function run(command){await figma.ui.onmessage({type:'bridge-command',id:'viewport-test',command});return replies.at(-1);}
  const fit={op:'fit_viewport',nodeId:'screen',viewportWidth:402,viewportHeight:874,scrollContainerIds:['content'],bottomNodeIds:['footer','icon','label','modal']};
  const apply=(operations,guard={})=>run({type:'apply_prototype',pageId:'page',scopeFrameIds:['screen'],operations,...guard});
  return{run,apply,fit,root,shell,background,content,body,footer,icon,label,modal,modalText,resizes};
}

test('viewport audit detects the observed phone footer crop without writing',async()=>{
  const f=await fixture();
  const response=await f.run({type:'get_prototype',nodeIds:['screen'],depth:0,viewportWidth:402,viewportHeight:874});
  assert.equal(response.ok,true);assert.equal(response.result.viewportCheck,'checked');
  assert.equal(response.result.viewportAudit[0].matches,false);
  assert.ok(Math.abs(response.result.viewportAudit[0].overflowPixels-60.7475728)<0.001);
  assert.equal(f.root.height,2874);assert.equal(f.resizes.length,0);
  const noTarget=await f.run({type:'get_prototype',nodeIds:['screen'],depth:0});
  assert.equal(noTarget.result.viewportCheck,'not_requested');
});

test('declared viewport rejects a mismatched frame before writing interactions',async()=>{
  const f=await fixture();
  const response=await f.apply([{op:'set_reactions',nodeId:'label',reactions:[]}],{viewportWidth:402,viewportHeight:874});
  assert.equal(response.ok,false);assert.match(response.error,/does not match the declared viewport/);
  assert.equal(f.resizes.length,0);assert.equal(f.root.height,2874);
});

test('viewport fit keeps footer controls inside phone, shrinks scrolling and preserves text and modal content',async()=>{
  const f=await fixture();const order=f.shell.children.map(n=>n.id),bodyY=f.body.y,modalTextY=f.modalText.y;
  assert.ok((f.label.y+f.label.height)*402/1236>874);
  const response=await f.apply([f.fit],{viewportWidth:402,viewportHeight:874});
  assert.equal(response.ok,true);assert.equal(response.result.viewportCheck,'checked');
  const target=1236*874/402,delta=target-2874;
  for(const n of[f.root,f.shell,f.background])assert.ok(Math.abs(n.height-target)<0.001);
  assert.ok(Math.abs(f.content.height-(2271+delta))<0.001);
  assert.ok((f.label.y+f.label.height)*402/1236<874);
  assert.ok(Math.abs(f.modal.y+f.modal.height-target)<0.001);
  assert.equal(f.label.constraints.vertical,'MAX');assert.equal(f.content.constraints.vertical,'STRETCH');
  assert.equal(f.body.y,bodyY);assert.equal(f.modalText.y,modalTextY);assert.equal(f.label.fontSize,48);
  assert.deepEqual(f.shell.children.map(n=>n.id),order);
  assert.ok(response.result.previous.some(p=>p.nodeId==='screen'&&p.property==='dimensions'&&p.value.height===2874));
  const y=f.label.y;assert.equal((await f.apply([f.fit])).ok,true);assert.equal(f.label.y,y);
});

test('viewport fit rejects unknown targets, nested bottom controls and invalid dimensions before mutation',async()=>{
  for(const invalid of[
    {bottomNodeIds:['missing']},{bottomNodeIds:['modal-text']},{viewportWidth:0},{scrollContainerIds:['background']},{viewportNodeIds:['content']},
  ]){
    const f=await fixture();const response=await f.apply([{...f.fit,...invalid}]);
    assert.equal(response.ok,false);assert.equal(f.root.height,2874);assert.equal(f.resizes.length,0);
  }
});

test('viewport geometry and anchors restore when a later native write fails',async()=>{
  const f=await fixture();const response=await f.apply([f.fit,{op:'set_reactions',nodeId:'label',reactions:[{trigger:{type:'ON_CLICK'},actions:[{type:'NODE',destinationId:'screen',navigation:'NAVIGATE',transition:{type:'DISSOLVE',duration:-1}}]}]}]);
  assert.equal(response.ok,false);assert.match(response.error,/earlier changes restored/);
  assert.equal(f.root.height,2874);assert.equal(f.shell.height,2874);assert.equal(f.background.height,2874);assert.equal(f.content.height,2271);assert.equal(f.label.y,2768);assert.equal(f.modal.y,2253);
  assert.deepEqual(plain(f.label.constraints),{horizontal:'MIN',vertical:'MIN'});
});

test('fixed children use the native count and preserve layer order; unsupported scrollBehavior is explicit',async()=>{
  const f=await fixture(),order=f.shell.children.map(n=>n.id);
  assert.equal((await f.apply([{op:'set_fixed_children',nodeId:'shell',count:2}])).ok,true);
  const read=await f.run({type:'get_prototype',nodeIds:['shell'],depth:0});
  assert.deepEqual(read.result.nodes[0].fixedChildIds,['label','modal']);
  assert.deepEqual(f.shell.children.map(n=>n.id),order);
  assert.equal((await f.apply([{op:'set_fixed_children',nodeId:'shell',count:100}])).ok,false);
  const unsupported=await f.apply([{op:'set_scroll',nodeId:'label',scrollBehavior:'FIXED'}]);
  assert.equal(unsupported.ok,false);assert.match(unsupported.error,/use set_fixed_children/);
});
