import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

async function fixture() {
  const replies = [], nodes = new Map();
  const page = { id: 'page', name: 'PPT', type: 'PAGE', children: [], selection: [], appendChild(n) { this.children.push(n); n.parent = this; } };
  const target = { id: 'target', name: 'Authorized banner', type: 'FRAME', children: [], appendChild(n) { this.children.push(n); n.parent = this; } };
  nodes.set(page.id, page); nodes.set(target.id, target);
  let sequence = 0;
  const figma = { root: { name: 'Fixture' }, currentPage: page, showUI() {}, ui: { postMessage: reply => replies.push(JSON.parse(JSON.stringify(reply))) }, getNodeByIdAsync: async id => nodes.get(id) || null,
    createVector() {
      let paths = [];
      const n = { id: 'vector-' + (++sequence), name: 'Vector', type: 'VECTOR', x: 0, y: 0, width: 1800, height: 300, visible: true, fills: [], strokes: [{type:'SOLID'}], effects: [],
        get vectorPaths() { return paths; },
        set vectorPaths(value) { if (value.some(p => p.data.includes('INVALID'))) throw new Error('Native path rejected'); paths = value; },
        remove() { this.parent.children = this.parent.children.filter(child => child !== this); nodes.delete(this.id); },
      };
      page.appendChild(n); nodes.set(n.id, n); return n;
    },
  };
  vm.runInNewContext(await readFile(new URL('./figma-plugin/code.js', import.meta.url), 'utf8'), { figma, __html__: '' });
  const run = async command => { await figma.ui.onmessage({type:'bridge-command',id:'test',command}); return replies.at(-1); };
  return { run, nodes, target, page };
}

const operation = { op: 'create_vector', parentId: 'target', name: 'Paper curve', x: 700, y: 0, paths: [{data:'M 0 0 C 0 140 200 240 360 300 L 1100 300 L 1100 0 Z'}], fill:'#236D95', shadow:{color:'#12354B',opacity:0.35,x:-10,y:1,radius:24} };

test('Bezier creation preserves authorized parent, borderless fill and native shadow, and readback includes paths', async () => {
  const f = await fixture();
  const result = await f.run({type:'apply_operations',operations:[operation]});
  assert.equal(result.ok, true);
  const id = result.result.results[0].id;
  const node = f.nodes.get(id);
  assert.equal(node.parent.id, 'target');
  assert.equal(node.x, 700);
  assert.equal(node.strokes.length, 0);
  assert.equal(node.effects[0].type, 'DROP_SHADOW');
  assert.equal(node.effects[0].color.a, 0.35);
  assert.match(node.vectorPaths[0].data, / C /);
  const readback = await f.run({type:'inspect_nodes',nodeIds:[id],depth:0});
  assert.equal(readback.result.nodes[0].vectorPaths[0].data, operation.paths[0].data);
  assert.equal(readback.result.nodes[0].effects[0].offset.x, -10);
});

test('invalid parent and style fail without inserting an orphan', async () => {
  const f = await fixture();
  for (const invalid of [{...operation,parentId:'missing'},{...operation,parentId:undefined},{...operation,fill:'bad'},{...operation,shadow:{radius:-1}}]) {
    const result = await f.run({type:'apply_operations',operations:[invalid]});
    assert.equal(result.ok, false);
    assert.equal(f.target.children.length, 0);
    assert.equal(f.page.children.length, 0);
  }
});

test('native path rejection removes the just-created vector', async () => {
  const f = await fixture();
  const result = await f.run({type:'apply_operations',operations:[{...operation,paths:[{data:'INVALID'}]}]});
  assert.equal(result.ok, false);
  assert.match(result.error, /Native path rejected/);
  assert.equal(f.target.children.length, 0);
});

test('gradients and capability detection are available after plugin reload', async () => {
  const f = await fixture();
  const result = await f.run({type:'apply_operations',operations:[{...operation,gradientStops:[{position:0,color:'#16577C'},{position:1,color:'#3B8FB8'}]}]});
  assert.equal(result.ok, true);
  assert.equal(f.nodes.get(result.result.results[0].id).fills[0].type, 'GRADIENT_LINEAR');
  const status = await f.run({type:'status'});
  assert.equal(status.result.vectorCapabilities.create, true);
});
