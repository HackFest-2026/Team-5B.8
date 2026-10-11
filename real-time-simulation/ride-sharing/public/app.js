/* Velo surge control — 10 defined test scenarios against the REAL DevNexus engine. */
const $=(s,r=document)=>r.querySelector(s);
const api=async(p,b)=>{const r=await fetch('/api/'+p,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(b||{})});return r.json();};
const ICON={'RIDE001':'🏍️','RIDE002':'🛺','RIDE003':'🚗','RIDE004':'🚘','RIDE005':'🚙','RIDE006':'✨'};
const CITY=[
  {id:'surge_demand',label:'Surge demand',max:100,bar:true},
  {id:'available_drivers',label:'Drivers nearby',max:40},
  {id:'weather_severity',label:'Weather severity',max:100,bar:true},
  {id:'is_peak_hour',label:'Peak hour',bool:true},
];
const REQ={distance_km:8, rider_platform:'android', rider_tier:'regular', payment_method:'cash'};
let S={items:[],base:{},sym:'₹',repriced:0,decisions:0,added:new Set()};
const money=v=>S.sym+Math.round(v).toLocaleString('en-IN');
const find=(ps,id)=>(ps||[]).find(p=>p.item_id===id)||{price:S.base[id]||0,drivers:[]};
function updTrip(){ $('#tripLabel').textContent=`${REQ.distance_km}km · ${REQ.rider_platform} · ${REQ.rider_tier} · ${REQ.payment_method}`; }

function renderCity(){$('#gtiles').innerHTML=CITY.map(c=>{
  if(c.bool)return `<div class="gtile bool" id="gt_${c.id}"><label>${c.label}</label><div class="val">Off</div></div>`;
  return `<div class="gtile" id="gt_${c.id}"><label>${c.label}</label><div class="val">—</div>${c.bar?'<div class="bar"><i style="width:0%"></i></div>':''}</div>`;
}).join('');}
function paintCity(id,val){const c=CITY.find(x=>x.id===id);const el=$('#gt_'+id);if(!el)return;
  const hot=(id==='surge_demand'&&val>=70)||(id==='weather_severity'&&val>=60);
  el.classList.add(hot?'hot':'flash');setTimeout(()=>el.classList.remove('flash','hot'),600);
  if(c.bool){const on=val===true||val==='true';el.classList.toggle('on',on);el.querySelector('.val').textContent=on?'On':'Off';}
  else{el.querySelector('.val').textContent=Math.round(val);if(c.bar)el.querySelector('.bar i').style.width=Math.min(100,val/c.max*100)+'%';}
  if(id==='surge_demand'){const h=$('#surgeHeadline');const lvl=val>=80?'⚡ EXTREME SURGE':val>=70?'SURGING':val>=50?'busy':'calm';h.textContent=lvl;h.classList.toggle('hot',val>=70);}
}
function cardHTML(it){return `<article class="card" id="c_${it.item_id}" data-base="${it.base_price}">
  <div class="ride-top"><div class="ride-ic">${ICON[it.item_id]||'🚗'}</div>
    <div><div class="ride-name">${it.name}</div><div class="ride-meta">${it.item_id} · base ${money(it.base_price)}</div></div>
    <span class="surge-badge" id="mx_${it.item_id}">1.0×</span></div>
  <div class="fare-row"><span class="fare" id="fare_${it.item_id}">${money(it.base_price)}</span><span class="fare-base">${money(it.base_price)}</span></div>
  <div class="drivers" id="dv_${it.item_id}"></div></article>`;}
function renderRides(){$('#rideGrid').innerHTML=S.items.map(cardHTML).join('');}
function paintFare(p){const card=$('#c_'+p.item_id);if(!card)return;const base=+card.dataset.base;const fare=Number(p.price||base);
  const el=$('#fare_'+p.item_id);const prev=+(el.dataset.v||base);el.dataset.v=fare;el.textContent=money(fare);
  el.classList.toggle('up',fare>prev+.01);el.classList.toggle('down',fare<prev-.01);
  card.classList.remove('flash-pr');void card.offsetWidth;card.classList.add('flash-pr');
  const mult=fare/base;const mx=$('#mx_'+p.item_id);mx.textContent=mult.toFixed(2)+'×';mx.className='surge-badge'+(mult>1.08?' hot':'');
  $('#dv_'+p.item_id).innerHTML=(p.drivers||[]).map(d=>{const up=String(d.impact).includes('+');return `<span class="rb ${up?'up':'down'}">${d.factor} ${d.impact}</span>`;}).join('');}
async function reprice(){updTrip();const r=await api('price-all',{item_ids:S.items.map(i=>i.item_id),request:REQ});(r.prices||[]).forEach(paintFare);
  return r.prices||[];}
async function setCity(obj){await api('context',{signals:obj});Object.entries(obj).forEach(([k,v])=>paintCity(k,v));}
function driverBadges(p){return (p.drivers||[]).map(d=>{const up=String(d.impact).includes('+');return `<span class="rb ${up?'up':'down'}">${d.factor} ${d.impact}</span>`;}).join('')||'no rules fired';}
function fareSummary(id,p){const base=S.base[id]||+($('#c_'+id)?.dataset.base||0);const name=(S.items.find(i=>i.item_id===id)||{}).name||id;
  const pct=base?((p.price-base)/base*100):0;return `${name}: ${money(base)} → <b>${money(p.price)}</b> (${pct>0?'+':''}${pct.toFixed(0)}%)<br>${driverBadges(p)}`;}
async function addRide(){if(S.added.has('RIDE006'))return;const p={item_id:'RIDE006',name:'Premier',base_price:320,cost:230,attributes:{vehicle_class:'car'},signals:{}};
  await api('item/create',{...p});S.added.add('RIDE006');S.base['RIDE006']=320;S.items.push({...p});
  $('#rideGrid').insertAdjacentHTML('beforeend',cardHTML(p));$('#c_RIDE006').classList.add('added');}
async function removeAdded(id){const c=$('#c_'+id);if(c){c.classList.add('removing');setTimeout(()=>c.remove(),400);}await api('item/delete',{item_id:id});S.added.delete(id);S.items=S.items.filter(i=>i.item_id!==id);}

/* ── the 10 scenarios, in 3 groups ─────────────────────── */
const CASES=[
 {group:'pricing',title:'Surge spike',desc:'Demand jumps to 85 → surge pricing kicks in (+25%).',
   run:async()=>{await setCity({surge_demand:85});return fareSummary('RIDE004',find(await reprice(),'RIDE004'));}},
 {group:'pricing',title:'Driver scarcity',desc:'Only 3 drivers nearby → scarcity premium (+15%).',
   run:async()=>{await setCity({available_drivers:3});return fareSummary('RIDE004',find(await reprice(),'RIDE004'));}},
 {group:'pricing',title:'Bad weather',desc:'Weather severity 75 → bad-weather premium (+12%).',
   run:async()=>{await setCity({weather_severity:75});return fareSummary('RIDE004',find(await reprice(),'RIDE004'));}},
 {group:'pricing',title:'Peak hour',desc:'Peak-hour window → peak uplift (+10%).',
   run:async()=>{await setCity({is_peak_hour:true});return fareSummary('RIDE004',find(await reprice(),'RIDE004'));}},
 {group:'pricing',title:'iPhone vs Android rider',desc:'Same ride, two phones — iOS pays the platform premium (+5%).',
   run:async()=>{REQ.rider_platform='android';const a=find(await reprice(),'RIDE004');REQ.rider_platform='ios';const i=find(await reprice(),'RIDE004');
     return `Android <b>${money(a.price)}</b> &nbsp;·&nbsp; iPhone <b>${money(i.price)}</b><br><span class="rb up">iOS platform premium +5%</span>`;}},
 {group:'pricing',title:'Long trip + Plus + wallet',desc:'25 km, Plus member, wallet pay → stacked discounts.',
   run:async()=>{Object.assign(REQ,{distance_km:25,rider_tier:'plus',payment_method:'wallet'});return fareSummary('RIDE005',find(await reprice(),'RIDE005'));}},
 {group:'notif',title:'Surge cap hit → real decision',desc:'Everything surges past the +60% cap → raises a REAL approval and pushes it to your phone.',
   run:async()=>{await setCity({surge_demand:98,available_drivers:1,weather_severity:95,is_peak_hour:true});REQ.rider_platform='ios';
     const ps=await reprice();const r=await api('raise-decision',{reason:'Surge pricing hit the guardrail cap'});
     
     return `🔔 Real decision pushed to your phone (sent: ${r.pushed}).<br>Sedan clamped at <b>${money(find(ps,'RIDE004').price)}</b>. Open the app → <b>Decisions</b> to answer.`;}},
 {group:'crud',title:'Add "Premier" ride class',desc:'Creates a brand-new ride type in the live catalogue.',
   run:async()=>{await addRide();return 'Added <b>Premier</b> (base ₹320) — priced live in the grid.';}},
 {group:'crud',title:'Update a fare',desc:'Raises the Mini base fare by 10%.',
   run:async()=>{const np=Math.round((S.base['RIDE003']||100)*1.1);await api('item/update',{item_id:'RIDE003',base_price:np});S.base['RIDE003']=np;
     const c=$('#c_RIDE003');if(c){c.dataset.base=np;c.querySelector('.ride-meta').textContent='RIDE003 · base '+money(np);}await reprice();
     return `Mini base fare → <b>${money(np)}</b>.`;}},
 {group:'crud',title:'Delete "Premier" ride class',desc:'Removes the ride type you added.',
   run:async()=>{if(!S.added.has('RIDE006'))return 'Premier not present — run "Add Premier" first.';await removeAdded('RIDE006');return 'Deleted <b>Premier</b> from the catalogue.';}},
];
const GROUPS=[['pricing','Pricing',6],['notif','Notification',1],['crud','Catalogue',3]];

function renderCases(){
  let html='';
  GROUPS.forEach(([g,label,count])=>{
    html+=`<div class="case-group"><div class="case-group-h">${label} <span class="gn">${count}</span></div>`;
    CASES.forEach((c,i)=>{ if(c.group!==g) return;
      html+=`<div class="case ${g}" id="case_${i}">
        <div class="case-top"><div class="case-main"><div class="case-title">${c.title}</div><div class="case-desc">${c.desc}</div></div>
        <button class="case-run" data-i="${i}">Run</button></div>
        <div class="case-result" id="res_${i}" hidden></div></div>`;
    });
    html+='</div>';
  });
  $('#cases').innerHTML=html;
  $('#cases').querySelectorAll('.case-run').forEach(b=>b.addEventListener('click',()=>runCase(+b.dataset.i)));
}
async function runCase(i){
  const c=CASES[i];const btn=$(`#case_${i} .case-run`);const res=$('#res_'+i);
  btn.disabled=true;btn.textContent='…';
  try{ const out=await c.run(); res.hidden=false;res.className='case-result ok';res.innerHTML=out||'done';
       btn.textContent='Re-run';btn.classList.add('done'); }
  catch(e){ res.hidden=false;res.className='case-result';res.innerHTML='⚠ '+e;btn.textContent='Run'; }
  finally{ btn.disabled=false; }
}
let allRunning=false;
async function runAll(){
  if(allRunning)return;allRunning=true;const ab=$('#runAllBtn');ab.textContent='Running…';ab.disabled=true;
  for(let i=0;i<CASES.length;i++){ await runCase(i); await new Promise(r=>setTimeout(r,1100)); }
  ab.textContent='▶ Run all in sequence';ab.disabled=false;allRunning=false;
}
async function boot(){renderCity();renderCases();
  const r=await api('bootstrap',{});if(!r.ok){$('#loading p').textContent='Backend error: '+(r.error||'');return;}
  S.sym=({INR:'₹',USD:'$',EUR:'€',GBP:'£'})[r.currency]||'₹';
  S.items=r.items.map(it=>({item_id:it.item_id,name:it.name,base_price:it.base_price,cost:it.cost,attributes:it.attributes||{},signals:it.signals||{}}));
  S.items.forEach(it=>S.base[it.item_id]=it.base_price);
  renderRides();
  $('#connPill').className='pill on';$('#connText').textContent='Connected';$('#loading').classList.add('gone');
  await setCity({surge_demand:30,available_drivers:25,weather_severity:10,is_peak_hour:false});await reprice();
}
$('#runAllBtn').addEventListener('click',runAll);

boot();

