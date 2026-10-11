/* Lumora retail — 10 defined test scenarios against the REAL DevNexus engine. */
const $=(s,r=document)=>r.querySelector(s);
const api=async(p,b)=>{const r=await fetch('/api/'+p,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(b||{})});return r.json();};
const IMG=(id)=>`https://images.unsplash.com/${id}?w=600&q=80&auto=format&fit=crop`;
const ART={P1001:['photo-1590658268037-6bf12165a8df','🎧'],P1002:['photo-1521572163474-6864f9cf17ab','👕'],
  P1003:['photo-1544367567-0f2fcb009e0b','🧘'],P1004:['photo-1447933601403-0c6688de566e','☕'],
  P1005:['photo-1527443224154-c4a3942d3acf','🖥️'],P2001:['photo-1523275335684-37898b6baf30','⌚']};
const GTILES=[
  {id:'site_traffic_index',label:'Site traffic',max:100},{id:'conversion_rate_pct',label:'Conversion %',max:8},
  {id:'season_demand',label:'Season demand',max:100},{id:'is_flash_sale',label:'Flash sale',bool:true},{id:'is_festival',label:'Festival',bool:true},
];
const REQ={customer_tier:'regular',region:'metro',quantity:1,is_first_purchase:false,cart_value:1500};
let S={items:[],base:{},sym:'₹',repriced:0,decisions:0,added:new Set()};
const money=v=>S.sym+Math.round(v).toLocaleString('en-IN');
const find=(ps,id)=>(ps||[]).find(p=>p.item_id===id)||{price:S.base[id]||0,drivers:[]};

function renderGlobals(){$('#gtiles').innerHTML=GTILES.map(t=>t.bool
  ?`<div class="gtile bool" id="gt_${t.id}"><label>${t.label}</label><div class="val">Off</div></div>`
  :`<div class="gtile" id="gt_${t.id}"><label>${t.label}</label><div class="val">—</div><div class="bar"><i style="width:0%"></i></div></div>`).join('');}
function paintGlobal(id,val){const t=GTILES.find(x=>x.id===id);const el=$('#gt_'+id);if(!el)return;el.classList.add('flash');setTimeout(()=>el.classList.remove('flash'),500);
  if(t.bool){const on=val===true||val==='true'||val==='True';el.classList.toggle('on',on);el.querySelector('.val').textContent=on?'On':'Off';}
  else{el.querySelector('.val').textContent=Number(val).toFixed(t.id==='conversion_rate_pct'?1:0);el.querySelector('.bar i').style.width=Math.min(100,val/t.max*100)+'%';}}
function cardHTML(it){const art=ART[it.item_id]||['','🛍️'];const img=art[0]?`<img src="${IMG(art[0])}" alt="" onerror="this.remove()"/>`:'';
  return `<article class="card" id="c_${it.item_id}" data-base="${it.base_price}">
  <div class="card-img"><div class="fallback">${art[1]}</div>${img}<span class="tag">${it.item_id}</span></div>
  <div class="card-body"><div class="name">${it.name}</div><div class="brand">${(it.attributes&&(it.attributes.brand||it.attributes.category))||'Lumora'}</div>
  <div class="price-row"><span class="live">${money(it.base_price)}</span><span class="base">${money(it.base_price)}</span><span class="delta flat">0%</span></div>
  <div class="fired" id="fire_${it.item_id}"></div></div></article>`;}
function renderProducts(){$('#productGrid').innerHTML=S.items.map(cardHTML).join('');}
function paintPrice(p){const card=$('#c_'+p.item_id);if(!card)return;const base=+card.dataset.base;const price=Number(p.price||base);
  const live=card.querySelector('.live');const prev=+(live.dataset.v||base);live.dataset.v=price;live.textContent=money(price);
  live.classList.toggle('up',price>prev+.01);live.classList.toggle('down',price<prev-.01);
  const pr=card.querySelector('.price-row');pr.classList.remove('flash-pr');void pr.offsetWidth;pr.classList.add('flash-pr');
  const d=((price-base)/base*100);const db=card.querySelector('.delta');db.className='delta '+(d>0.5?'up':d<-0.5?'down':'flat');db.textContent=(d>0?'+':'')+d.toFixed(1)+'%';
  $('#fire_'+p.item_id).innerHTML=(p.drivers||[]).map(dr=>{const up=String(dr.impact).includes('+');return `<span class="rb ${up?'up':'down'}">${dr.factor} ${dr.impact}</span>`;}).join('');}
async function reprice(){$('#reqLabel').textContent=`${REQ.customer_tier} · ${REQ.region} · qty ${REQ.quantity}`;
  const r=await api('price-all',{item_ids:S.items.map(i=>i.item_id),request:REQ});(r.prices||[]).forEach(paintPrice);return r.prices||[];}
async function setGlobals(obj){await api('context',{signals:obj});Object.entries(obj).forEach(([k,v])=>paintGlobal(k,v));}
async function itemSignals(id,obj){await api('item-signals',{item_id:id,signals:obj});}
function driverBadges(p){return (p.drivers||[]).map(d=>{const up=String(d.impact).includes('+');return `<span class="rb ${up?'up':'down'}">${d.factor} ${d.impact}</span>`;}).join('')||'no rules fired';}
function summary(id,p){const base=S.base[id]||+($('#c_'+id)?.dataset.base||0);const name=(S.items.find(i=>i.item_id===id)||{}).name||id;
  const pct=base?((p.price-base)/base*100):0;return `${name}: ${money(base)} → <b>${money(p.price)}</b> (${pct>0?'+':''}${pct.toFixed(0)}%)<br>${driverBadges(p)}`;}
async function addProduct(){if(S.added.has('P2001'))return;const p={item_id:'P2001',name:'Aurora Smartwatch',base_price:8999,cost:5200,attributes:{category:'Wearables',brand:'Aurora'},signals:{inventory:60,days_of_cover:20,sales_velocity:5,rating:4.4,return_rate_pct:5,competitor_gap_pct:2}};
  await api('item/create',{...p});S.added.add('P2001');S.base['P2001']=8999;S.items.push({...p});$('#productGrid').insertAdjacentHTML('beforeend',cardHTML(p));$('#c_P2001').classList.add('added');}
async function removeAdded(id){const c=$('#c_'+id);if(c){c.classList.add('removing');setTimeout(()=>c.remove(),400);}await api('item/delete',{item_id:id});S.added.delete(id);S.items=S.items.filter(i=>i.item_id!==id);}

const CASES=[
 {group:'pricing',title:'Flash sale',desc:'Store-wide flash sale turns on → −15% on every product.',
   run:async()=>{await setGlobals({is_flash_sale:true});return summary('P1003',find(await reprice(),'P1003'));}},
 {group:'pricing',title:'Festival + traffic surge',desc:'Festival event + heavy traffic (88) → demand uplifts.',
   run:async()=>{await setGlobals({is_festival:true,site_traffic_index:88});return summary('P1003',find(await reprice(),'P1003'));}},
 {group:'pricing',title:'Low stock on Earbuds',desc:'Earbuds inventory drops to 5 → scarcity premium (+8%).',
   run:async()=>{await itemSignals('P1001',{inventory:5});return summary('P1001',find(await reprice(),'P1001'));}},
 {group:'pricing',title:'Overstock clearance',desc:'Monitor sits on 120 days of cover → clearance (−12%).',
   run:async()=>{await itemSignals('P1005',{days_of_cover:120});return summary('P1005',find(await reprice(),'P1005'));}},
 {group:'pricing',title:'VIP shopper in a metro',desc:'Customer tier VIP + metro region → loyalty − / metro +.',
   run:async()=>{REQ.customer_tier='vip';REQ.region='metro';return summary('P1001',find(await reprice(),'P1001'));}},
 {group:'pricing',title:'Bulk order + first purchase',desc:'Qty 12 and a first-time buyer → stacked discounts.',
   run:async()=>{REQ.quantity=12;REQ.is_first_purchase=true;return summary('P1004',find(await reprice(),'P1004'));}},
 {group:'notif',title:'Price swing → real decision',desc:'Flash sale + festival + a stock-out combine → raises a REAL approval and pushes it to your phone.',
   run:async()=>{await setGlobals({is_flash_sale:true,is_festival:true,site_traffic_index:95});await itemSignals('P1001',{inventory:3});
     const ps=await reprice();const r=await api('raise-decision',{reason:'Large price swing on Wireless Earbuds Pro'});
     
     return `🔔 Real decision pushed to your phone (sent: ${r.pushed}).<br>Earbuds now <b>${money(find(ps,'P1001').price)}</b>. Open the app → <b>Decisions</b>.`;}},
 {group:'crud',title:'Add a new product',desc:'Lists the Aurora Smartwatch in the live catalogue.',
   run:async()=>{await addProduct();return 'Added <b>Aurora Smartwatch</b> (₹8,999) — priced live.';}},
 {group:'crud',title:'Update a price',desc:'Raises the T-Shirt list price by 8%.',
   run:async()=>{const np=Math.round((S.base['P1002']||799)*1.08);await api('item/update',{item_id:'P1002',base_price:np});S.base['P1002']=np;
     const c=$('#c_P1002');if(c){c.dataset.base=np;c.querySelector('.base').textContent=money(np);}await reprice();return `T-Shirt list price → <b>${money(np)}</b>.`;}},
 {group:'crud',title:'Delete the added product',desc:'Removes the Aurora Smartwatch.',
   run:async()=>{if(!S.added.has('P2001'))return 'Smartwatch not present — run "Add a new product" first.';await removeAdded('P2001');return 'Deleted <b>Aurora Smartwatch</b>.';}},
];
const GROUPS=[['pricing','Pricing',6],['notif','Notification',1],['crud','Catalogue',3]];
function renderCases(){let h='';GROUPS.forEach(([g,label,count])=>{h+=`<div class="case-group"><div class="case-group-h">${label} <span class="gn">${count}</span></div>`;
  CASES.forEach((c,i)=>{if(c.group!==g)return;h+=`<div class="case ${g}" id="case_${i}"><div class="case-top"><div class="case-main"><div class="case-title">${c.title}</div><div class="case-desc">${c.desc}</div></div><button class="case-run" data-i="${i}">Run</button></div><div class="case-result" id="res_${i}" hidden></div></div>`;});h+='</div>';});
  $('#cases').innerHTML=h;$('#cases').querySelectorAll('.case-run').forEach(b=>b.addEventListener('click',()=>runCase(+b.dataset.i)));}
async function runCase(i){const c=CASES[i];const btn=$(`#case_${i} .case-run`);const res=$('#res_'+i);btn.disabled=true;btn.textContent='…';
  try{const out=await c.run();res.hidden=false;res.className='case-result ok';res.innerHTML=out||'done';btn.textContent='Re-run';btn.classList.add('done');}
  catch(e){res.hidden=false;res.className='case-result';res.innerHTML='⚠ '+e;btn.textContent='Run';}finally{btn.disabled=false;}}
let allRunning=false;
async function runAll(){if(allRunning)return;allRunning=true;const ab=$('#runAllBtn');ab.textContent='Running…';ab.disabled=true;
  for(let i=0;i<CASES.length;i++){await runCase(i);await new Promise(r=>setTimeout(r,1100));}ab.textContent='▶ Run all in sequence';ab.disabled=false;allRunning=false;}
async function boot(){renderGlobals();renderCases();
  const r=await api('bootstrap',{});if(!r.ok){$('#loading p').textContent='Backend error: '+(r.error||'');return;}
  S.sym=({INR:'₹',USD:'$',EUR:'€',GBP:'£'})[r.currency]||'₹';
  S.items=r.items.map(it=>({item_id:it.item_id,name:it.name,base_price:it.base_price,cost:it.cost,attributes:it.attributes||{},signals:it.signals||it.context||{}}));
  S.items.forEach(it=>S.base[it.item_id]=it.base_price);renderProducts();
  $('#connPill').className='pill on';$('#connText').textContent='Connected';$('#loading').classList.add('gone');
  await setGlobals({site_traffic_index:50,conversion_rate_pct:3,season_demand:50,is_flash_sale:false,is_festival:false});}
$('#runAllBtn').addEventListener('click',runAll);boot();

