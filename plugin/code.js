// No mouse, keyboard, clipboard, selection, viewport or page-switch operations.
figma.showUI(__html__,{visible:false});
let busy=false;
const fonts=new Set();
function rgb(h){h=h.replace('#','');return {r:parseInt(h.slice(0,2),16)/255,g:parseInt(h.slice(2,4),16)/255,b:parseInt(h.slice(4,6),16)/255};}
function paint(h,opacity){return [{type:'SOLID',color:rgb(h),opacity:opacity===undefined?1:opacity}];}
async function font(f){const k=f.family+'|'+f.style;if(!fonts.has(k)){await figma.loadFontAsync(f);fonts.add(k);}}
async function currentFonts(n){if(n.type==='TEXT')for(const s of n.getStyledTextSegments(['fontName']))await font(s.fontName);}
function scope(n,ids){for(let p=n;p&&p.type!=='PAGE';p=p.parent)if(ids.includes(p.id))return true;return false;}
function pageOf(n){while(n&&n.type!=='PAGE')n=n.parent;return n;}
function inspect(n,depth){const a={id:n.id,name:n.name,type:n.type,x:n.x,y:n.y,width:n.width,height:n.height};if(n.type==='TEXT'){a.text=n.characters;a.fontName=n.fontName;a.fontSize=n.fontSize;a.textAutoResize=n.textAutoResize;a.missingFont=n.hasMissingFont;a.links=n.getStyledTextSegments(['hyperlink']).filter(s=>s.hyperlink).map(s=>s.hyperlink);}if(depth&&n.children)a.children=n.children.map(c=>inspect(c,depth-1));return a;}
async function make(s,parent,created){
 let n;
 if(s.type==='TEXT'){
  const f=s.fontName||{family:'Noto Sans SC',style:s.bold?'Bold':'Regular'};await font(f);
  n=figma.createText();parent.appendChild(n);created.push(n);n.fontName=f;n.fontSize=s.fontSize||24;n.lineHeight={unit:'PIXELS',value:s.lineHeight||Math.round(n.fontSize*1.45)};n.characters=s.text||'';n.resize(s.width||500,100);n.textAutoResize='HEIGHT';if(parent.layoutMode&&parent.layoutMode!=='NONE')n.layoutSizingVertical='HUG';n.fills=paint(s.fill||'#1F2937');
  if(s.textAlignHorizontal)n.textAlignHorizontal=s.textAlignHorizontal;
  for(const link of s.links||[]){const i=n.characters.indexOf(link.text);if(i<0)throw Error('Link anchor missing: '+link.text);n.setRangeHyperlink(i,i+link.text.length,{type:'URL',value:link.url});}
  if(s.maxHeight && n.height>s.maxHeight+1)throw Error('Text exceeds reserved space: '+n.characters.slice(0,40)+' '+n.height+'>'+s.maxHeight);
 }else{
  n=s.type==='FRAME'?figma.createFrame():figma.createRectangle();parent.appendChild(n);created.push(n);n.resize(s.width,s.height);n.fills=s.fill?paint(s.fill,s.opacity):[];
  if(s.type==='IMAGE'){const im=figma.createImage(figma.base64Decode(s.base64));n.fills=[{type:'IMAGE',imageHash:im.hash,scaleMode:'FIT'}];}
  if(s.stroke){n.strokes=paint(s.stroke);n.strokeWeight=s.strokeWidth||1;}
  if(n.type==='FRAME')n.clipsContent=false;
 }
 n.name=s.name||(s.text?s.text.slice(0,60):s.type);n.x=s.x||0;n.y=s.y||0;
 for(const child of s.children||[])await make(child,n,created);
 return n;
}
function boundsCheck(root){const b=root.absoluteBoundingBox;return root.findAll(()=>true).filter(n=>{const a=n.absoluteBoundingBox;return a&&(a.x<b.x-.5||a.y<b.y-.5||a.x+a.width>b.x+b.width+.5||a.y+a.height>b.y+b.height+.5);}).map(n=>({id:n.id,name:n.name,bounds:n.absoluteBoundingBox}));}
async function execute(q){
 if(figma.root.name!==q.fileName||figma.currentPage.id!==q.pageId)throw Error('File/page changed; task not applied');
 const targets=[];
 for(const id of q.frameIds){const f=await figma.getNodeByIdAsync(id);if(!f||f.type!=='FRAME'||pageOf(f).id!==q.pageId)throw Error('Invalid target frame: '+id);targets.push(f);}
 const before={selection:figma.currentPage.selection.map(n=>n.id),viewport:{center:figma.viewport.center,zoom:figma.viewport.zoom}};
 const result={createdNodeIds:[],mutatedNodeIds:[],removedNodeIds:[],frames:[]};
 if(q.kind==='replace_scene'){
  const pending=[];
  try{
   for(const spec of q.frames){
    const f=targets.find(t=>t.id===spec.id);if(spec.expectedName&&f.name!==spec.expectedName)throw Error('Frame name changed');
    const old=f.children.filter(n=>n.getSharedPluginData('bgbridge','owner')===q.owner||(spec.replaceNodeIds||[]).includes(n.id));
    if((spec.replaceNodeIds||[]).some(id=>!old.some(n=>n.id===id)))throw Error('Replacement ID must be an immediate child of target frame');
    const created=[],root=figma.createFrame();f.appendChild(root);root.name=spec.name||q.owner;root.resize(f.width,f.height);root.x=0;root.y=0;root.fills=paint('#FFFFFF');root.visible=false;root.clipsContent=false;
    pending.push({root,old,frame:f});root.setSharedPluginData('bgbridge','owner',q.owner);
    for(const s of spec.children)await make(s,root,created);
    const overflow=boundsCheck(root);if(overflow.length)throw Error('Frame overflow: '+JSON.stringify(overflow));
    result.createdNodeIds.push(root.id,...created.map(n=>n.id));
   }
  }catch(e){for(const p of pending)if(!p.root.removed)p.root.remove();throw e;}
  figma.commitUndo();
  for(const p of pending){for(const o of p.old){result.removedNodeIds.push(o.id);o.remove();}p.root.visible=true;result.mutatedNodeIds.push(p.frame.id);}
  figma.commitUndo();
 }else if(q.kind==='set'){
  // Preflight all targets before the first mutation. Mutation errors report applied IDs.
  const plans=[];
  for(const o of q.operations){const n=await figma.getNodeByIdAsync(o.id);if(!n||!scope(n,q.frameIds))throw Error('Out-of-scope node: '+o.id);await currentFonts(n);plans.push([n,o]);}
  for(const [n,o] of plans){if(o.text!==undefined)n.characters=o.text;if(o.fill)n.fills=paint(o.fill,o.opacity);if(o.fontSize)n.fontSize=o.fontSize;if(o.width)n.resize(o.width,o.height||n.height);if(o.textAutoResize){n.textAutoResize=o.textAutoResize;if(n.parent.layoutMode&&n.parent.layoutMode!=='NONE')n.layoutSizingVertical='HUG';}if(o.x!==undefined)n.x=o.x;if(o.y!==undefined)n.y=o.y;result.mutatedNodeIds.push(n.id);}
  figma.commitUndo();
 }else if(q.kind==='save_version'){result.version=await figma.saveVersionHistoryAsync(q.title||q.taskId,q.description||'Scoped background editing');}
 result.frames=targets.map(f=>({id:f.id,name:f.name,overflow:boundsCheck(f),tree:inspect(f,q.depth===undefined?3:q.depth)}));
 if(q.kind==='export'||q.export){result.images=[];for(const f of targets)result.images.push({nodeId:f.id,base64:figma.base64Encode(await f.exportAsync({format:'PNG',constraint:{type:'SCALE',value:q.scale||1}}))});}
 result.viewUnchanged=JSON.stringify(before)===JSON.stringify({selection:figma.currentPage.selection.map(n=>n.id),viewport:{center:figma.viewport.center,zoom:figma.viewport.zoom}});
 return result;
}
figma.ui.onmessage=async m=>{
 if(m.type==='context'){figma.ui.postMessage({type:'context',context:{fileName:figma.root.name,pageId:figma.currentPage.id,fileKey:figma.fileKey||null}});return;}
 if(m.type!=='job')return;
 if(busy){figma.ui.postMessage({type:'result',jobId:m.jobId,ok:false,error:'Plugin busy'});return;}
 busy=true;
 try{const result=await execute(m.request);figma.ui.postMessage({type:'result',jobId:m.jobId,ok:true,result});}
 catch(e){figma.ui.postMessage({type:'result',jobId:m.jobId,ok:false,error:String(e)});}
 finally{busy=false;}
};
