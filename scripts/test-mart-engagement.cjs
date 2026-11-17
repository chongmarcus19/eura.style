const vm = require('node:vm'), fs = require('node:fs'), assert = require('node:assert/strict');
const source = fs.readFileSync(require('node:path').join(__dirname, '../m/m.js'),'utf8');
const id='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', item='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
class Element {
  constructor(tag) { this.tag=tag; this.children=[]; this.attrs={}; this.handlers={}; this.classList={add(){},remove(){}}; }
  setAttribute(k,v) { this.attrs[k]=String(v); }
  getAttribute(k) { return this.attrs[k]; }
  append(...nodes){ this.children.push(...nodes); }
  replaceChildren(...nodes){ this.children=nodes; }
  addEventListener(k, fn){ this.handlers[k]=fn; }
  querySelector(q){ if(q==='button') return new Element('button'); return nodes[q] || (nodes[q]=new Element(q)); }
}
let nodes={};
async function run(isInternal){
  nodes={}; const calls=[], storage=new Map(isInternal ? [['eura-internal-activity','1']] : []), main=new Element('main');
  const window={matchMedia:()=>({matches:true}), setInterval(){}, setTimeout, dataLayer:[]};
  const context={window, Node:Element, URL, URLSearchParams, AbortController, setTimeout, clearTimeout, location:{hostname:'localhost',origin:'http://localhost',search:`?id=${id}`,hash:'#t=secret'}, localStorage:{getItem:k=>storage.get(k)||null,setItem:(k,v)=>storage.set(k,v),removeItem:k=>storage.delete(k)}, document:{getElementById:()=>main,createElement:t=>new Element(t),head:new Element('head')}, fetch:async (url, options)=>{ calls.push([url,options]); return url.endsWith('/engagement') ? {ok:true} : {ok:true,json:async()=>({data:{name:'Test',items:[{id:item,title:'Test product',url:'https://example.com/item'}],lines:[]}})}; }};
  vm.runInNewContext(source,context);
  await new Promise(resolve=>setTimeout(resolve,10));
  const view=calls.find(([u])=>u.endsWith('/engagement')); assert.equal(JSON.parse(view[1].body).event_type,'view'); assert.equal(JSON.parse(view[1].body).is_internal,isInternal); assert.equal(view[1].headers['X-Mart-Token'],'secret');
  const findCard = node => node instanceof Element && (node.tag==='a' && node.handlers.click ? node : node.children.map(findCard).find(Boolean));
  const card=findCard(main); assert.ok(card); card.handlers.click();
  const click=calls.filter(([u])=>u.endsWith('/engagement'))[1]; assert.equal(JSON.parse(click[1].body).item_id,item); assert.equal(JSON.parse(click[1].body).is_internal,isInternal); assert.equal(click[1].keepalive,true);
}
(async()=>{ await run(false); await run(true); console.log('Browser event checks passed'); })().catch(e=>{console.error(e);process.exitCode=1});
