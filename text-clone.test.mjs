import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

async function fixture({ failFont = false } = {}) {
  const replies = [], events = [], nodes = new Map();
  const page = { id:'page',type:'PAGE',children:[],selection:[] };
  const target = { id:'target',type:'FRAME',width:1800,children:[],appendChild(node) { node.parent=this; this.children.push(node); } };
  const source = { id:'source',name:'Title',type:'TEXT',x:190,y:122,width:384,height:44,characters:'Original',textAlignHorizontal:'LEFT',hasMissingFont:false,
    getRangeAllFontNames() { return [{family:'MaokenAssortedSans',style:'Regular'},{family:'Inter',style:'Regular'}]; },
    clone() {
      events.push('clone');
      let characters=this.characters;
      const n={ id:'clone-'+nodes.size,name:this.name,type:'TEXT',x:this.x,y:this.y,width:this.width,height:this.height,textAlignHorizontal:this.textAlignHorizontal,
        get characters(){return characters;},
        set characters(value){characters=value; this.width=value.length*29;},
        remove(){if(this.parent)this.parent.children=this.parent.children.filter(child=>child!==this); nodes.delete(this.id);},
      };
      nodes.set(n.id,n);return n;
    },
  };
  [page,target,source].forEach(n=>nodes.set(n.id,n));
  const figma={currentPage:page,root:{name:'Fixture'},showUI(){},getNodeByIdAsync:async id=>nodes.get(id)||null,
    loadFontAsync:async font=>{events.push('font:'+font.family);if(failFont)throw new Error('Font unavailable');},
    ui:{postMessage:reply=>replies.push(JSON.parse(JSON.stringify(reply)))},
  };
  vm.runInNewContext(await readFile(new URL('./figma-plugin/code.js',import.meta.url),'utf8'),{figma,__html__:''});
  const run=async operation=>{await figma.ui.onmessage({type:'bridge-command',id:'test',command:{type:'apply_operations',operations:[operation]}});return replies.at(-1);};
  return {run,events,source,target,nodes};
}

test('mirrored text anchors to the source edge after replacement changes natural width, with glyphs readable',async()=>{
  const f=await fixture();
  const result=await f.run({op:'clone_text',sourceNodeId:'source',parentId:'target',characters:'Product PPT',mirrorFromSource:true});
  assert.equal(result.ok,true);
  const node=f.target.children[0];
  assert.equal(node.x+node.width,1800-f.source.x);
  assert.equal(node.y,122);
  assert.equal(node.textAlignHorizontal,'RIGHT');
  assert.equal(node.characters,'Product PPT');
  assert.ok(f.events.indexOf('clone')>f.events.indexOf('font:MaokenAssortedSans'));
  assert.ok(f.events.indexOf('clone')>f.events.indexOf('font:Inter'));
  assert.equal(f.source.characters,'Original');
  assert.equal(f.source.x,190);
});

test('missing fonts fail before a native clone can mutate the file',async()=>{
  const f=await fixture({failFont:true});
  const result=await f.run({op:'clone_text',sourceNodeId:'source',parentId:'target',characters:'4'});
  assert.equal(result.ok,false);
  assert.match(result.error,/Font unavailable/);
  assert.equal(f.target.children.length,0);
  assert.ok(!f.events.includes('clone'));
});

test('clone targets and mirror input are validated before insertion',async()=>{
  const f=await fixture();
  for(const operation of [
    {op:'clone_text',sourceNodeId:'target',parentId:'target'},
    {op:'clone_text',sourceNodeId:'source',parentId:'missing'},
    {op:'clone_text',sourceNodeId:'source',parentId:'target',mirrorFromSource:'true'},
  ]) {
    assert.equal((await f.run(operation)).ok,false);
    assert.equal(f.target.children.length,0);
  }
});
