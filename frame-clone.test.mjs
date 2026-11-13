import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';

async function fixture({failFont=false}={}) {
  const nodes=new Map(), events=[], replies=[];
  const attach=(parent,node)=>{if(node.parent)node.parent.children=node.parent.children.filter(n=>n!==node);node.parent=parent;parent.children.push(node);};
  const page={id:'page',type:'PAGE',children:[],selection:[],appendChild(node){attach(this,node);}};
  const destination={...page,id:'destination',children:[]};
  const source={id:'source',type:'FRAME',name:'Banner',x:1800,y:39604,width:1800,height:300,visible:true,clipsContent:true,
    fills:[{type:'SOLID',color:{r:.94,g:.94,b:.937}}],children:[],
    clone(){
      events.push('clone');
      const copy=node=>{
        const n={};
        for(const [key,value] of Object.entries(node))if(!['id','parent','children','clone'].includes(key)&&typeof value!=='function')n[key]=structuredClone(value);
        n.id='copy-'+nodes.size; nodes.set(n.id,n);
        n.remove=function(){if(this.parent)this.parent.children=this.parent.children.filter(q=>q!==this);nodes.delete(this.id);};
        n.resizeWithoutConstraints=function(width,height){this.width=width;this.height=height;};
        if(node.children){n.children=[];for(const child of node.children)attach(n,copy(child));}
        return n;
      };
      const clone=copy(this);page.appendChild(clone);return clone;
    },
  };
  source.children=[
    {id:'image',type:'RECTANGLE',name:'Photo',x:731,y:275,width:102,height:206,opacity:.3,relativeTransform:[[0,1,731],[-1,0,275]],fills:[{type:'IMAGE',imageHash:'native-image',scaleMode:'CROP',imageTransform:[[.7,0,.1],[0,.6,.2]],opacity:.3}]},
    {id:'curve',type:'VECTOR',name:'Contour',x:896,y:0,width:904,height:300,vectorPaths:[{windingRule:'NONZERO',data:'M 0 0 C 100 200 200 200 300 300 L 904 300 L 904 0 Z'}],effects:[{type:'DROP_SHADOW',radius:18,color:{r:.2,g:.2,b:.2,a:.46},offset:{x:-12.5,y:2.5}}]},
    {id:'text',type:'TEXT',name:'Heading',characters:'展示视频',fontName:{family:'LXGW Neo ZhiSong',style:'Regular'},fontSize:48,lineHeight:{unit:'PIXELS',value:44},textAlignHorizontal:'LEFT',hasMissingFont:false,getRangeAllFontNames(){return [this.fontName];}},
  ];
  for(const n of source.children){n.parent=source;nodes.set(n.id,n);}
  page.appendChild(source);[source,page,destination].forEach(n=>nodes.set(n.id,n));
  const figma={showUI(){},currentPage:page,root:{name:'Fixture'},getNodeByIdAsync:async id=>nodes.get(id)||null,loadFontAsync:async font=>{events.push('font:'+font.family);if(failFont)throw new Error('Font unavailable');},ui:{postMessage:r=>replies.push(JSON.parse(JSON.stringify(r)))}};
  vm.runInNewContext(await readFile(new URL('./figma-plugin/code.js',import.meta.url),'utf8'),{figma,__html__:''});
  const run=async operation=>{await figma.ui.onmessage({type:'bridge-command',id:'test',command:{type:'apply_operations',operations:[operation]}});return replies.at(-1);};
  const snapshot=node=>Object.fromEntries(Object.entries(node).filter(([key,value])=>!['id','parent','children'].includes(key)&&typeof value!=='function'));
  return {run,events,source,page,destination,snapshot};
}

test('native frame copy preserves crop, rotation, text styles, paths and shadows and returns all descendant IDs',async()=>{
  const f=await fixture();
  const before=f.source.children.map(n=>structuredClone(f.snapshot(n)));
  const result=await f.run({op:'clone_frame',sourceNodeId:'source',sourceParentId:'page',parentId:'destination',expectedSourceWidth:1800,expectedSourceHeight:300,x:1800,y:43600,width:1600,height:400,name:'New banner'});
  assert.equal(result.ok,true);
  const copy=f.destination.children[0];
  assert.equal(copy.x,1800);assert.equal(copy.y,43600);assert.equal(copy.name,'New banner');
  assert.equal(copy.width,1600);assert.equal(copy.height,400);
  assert.equal(copy.clipsContent,true);
  assert.deepEqual(copy.children.map(n=>f.snapshot(n)),before);
  assert.deepEqual(f.source.children.map(n=>f.snapshot(n)),before);
  assert.equal(f.source.y,39604);assert.equal(f.page.children.length,1);
  assert.ok(f.events.indexOf('font:LXGW Neo ZhiSong')<f.events.indexOf('clone'));
  const info=result.result.results[0];
  assert.equal(info.createdNodeIds.length,4);
  assert.deepEqual(info.nodeMap.map(n=>n.sourceNodeId),['source','image','curve','text']);
});

test('unavailable fonts and stale scope or dimensions fail before a clone is created',async()=>{
  const f=await fixture({failFont:true});
  const result=await f.run({op:'clone_frame',sourceNodeId:'source',sourceParentId:'page',parentId:'destination'});
  assert.equal(result.ok,false);assert.match(result.error,/Font unavailable/);assert.ok(!f.events.includes('clone'));
  const ready=await fixture();
  for(const extra of [{sourceParentId:'wrong'},{expectedSourceWidth:1600},{parentId:'source'}]) {
    const answer=await ready.run({op:'clone_frame',sourceNodeId:'source',sourceParentId:'page',parentId:'destination',...extra});
    assert.equal(answer.ok,false);assert.equal(ready.destination.children.length,0);
  }
  assert.ok(!ready.events.includes('clone'));
});
