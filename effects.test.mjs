import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';

async function fixture(){
 const replies=[];
 const parent={id:'frame',type:'FRAME'};
 const source={id:'curve',type:'VECTOR',parent,name:'Curve',x:10,y:20,width:300,height:300,fills:[{type:'SOLID',color:{r:.1,g:.3,b:.5}}],vectorPaths:[{windingRule:'NONZERO',data:'M 0 0 C 10 100 150 200 300 300 L 300 0 Z'}],effects:[{type:'DROP_SHADOW',radius:25,color:{r:.1,g:.2,b:.3,a:.32},offset:{x:-10,y:2},visible:true,blendMode:'NORMAL'}]};
 const figma={showUI(){},currentPage:{id:'page',name:'PPT',selection:[]},getNodeByIdAsync:async id=>id==='curve'?source:parent,ui:{postMessage:result=>replies.push(JSON.parse(JSON.stringify(result)))}};
 vm.runInNewContext(await readFile(new URL('./figma-plugin/code.js',import.meta.url),'utf8'),{figma,__html__:''});
 return {source,run:async operation=>{await figma.ui.onmessage({type:'bridge-command',id:'test',command:{type:'apply_operations',operations:[operation]}});return replies.at(-1);}};
}

test('shadow updates preserve vector identity, path, fill and placement while returning native effect readback',async()=>{
 const f=await fixture();const original=structuredClone({...f.source,parent:undefined});
 const effects=structuredClone(f.source.effects);effects[0].color.a=.53;effects[0].radius=22.5;
 const result=await f.run({op:'set_effects',nodeId:'curve',parentId:'frame',expectedEffects:original.effects,effects});
 assert.equal(result.ok,true);assert.equal(result.result.results[0].effects[0].color.a,.53);
 assert.deepEqual(result.result.results[0].previousEffects,original.effects);
 const after=structuredClone({...f.source,parent:undefined});delete original.effects;delete after.effects;
 assert.deepEqual(after,original);
});

test('stale effects and wrong parent are rejected before the native vector is touched',async()=>{
 const f=await fixture();const before=JSON.stringify(f.source.effects);
 for(const op of [{parentId:'other'},{parentId:'frame',expectedEffects:[]}]){
  const result=await f.run({op:'set_effects',nodeId:'curve',effects:[],...op});
  assert.equal(result.ok,false);assert.equal(JSON.stringify(f.source.effects),before);
 }
});
