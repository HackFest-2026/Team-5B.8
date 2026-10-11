/* Meridian rate desk — 10 defined test scenarios against the REAL DevNexus APR engine. */
const $=(s,r=document)=>r.querySelector(s);
const api=async(p,b)=>{const r=await fetch('/api/'+p,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(b||{})});return r.json();};
const ICON={'LN-PL':'💵','LN-HL':'🏠','LN-AL':'🚗','LN-CC':'💳','LN-BL':'🏢','LN-EL':'🎓','LN-GL':'🥇'};
const MARKET=[{id:'repo_rate',label:'Repo rate',suffix:'%'},{id:'market_competition_index',label:'Market competition',suffix:''}];
const APP={credit_score:720,annual_income:1200000,debt_to_income_pct:30,loan_amount:500000,tenure_months:60,loan_to_value_pct:70,down_payment_pct:15,employment_type:'salaried',relationship_tier:'existing'};
const DEF={...APP};
let S={items:[],base:{},repriced:0,decisions:0,added:new Set()};
const apr=v=>Number(v).toFixed(2)+'%';
const find=(ps,id)=>(ps||[]).find(p=>p.item_id===id)||{price:S.base[id]||0,drivers:[]};

function renderMarket(){$('#gtiles').innerHTML=MARKET.map(m=>`<div class="gtile" id="gt_${m.id}"><label>${m.label}</label><div class="val" id="v_${m.id}">—</div></div>`).join('');}
function paintMarket(id,val){const el=$('#gt_'+id);if(!el)return;el.classList.add('flash');setTimeout(()=>el.classList.remove('flash'),500);
  $('#v_'+id).innerHTML=(id==='repo_rate'?Number(val).toFixed(2):Math.round(val))+(id==='repo_rate'?'<small>%</small>':'');}
function rateHTML(it){return `<div class="rate" id="r_${it.item_id}" data-base="${it.base_price}">
  <div class="rate-ic">${ICON[it.item_id]||'🏦'}</div>
  <div class="rate-main"><div class="rname">${it.name.replace(/\s*\(APR %\)/,'')}</div><div class="rmeta">${it.item_id} · base ${Number(it.base_price).toFixed(1)}%</div><div class="rate-drivers" id="dv_${it.item_id}"></div></div>
  <div class="rate-apr"><div class="apr" id="apr_${it.item_id}">${Number(it.base_price).toFixed(2)}<small>%</small></div><div class="apr-base">${Number(it.base_price).toFixed(1)}%</div></div></div>`;}
function renderRates(){$('#rateList').innerHTML=S.items.map(rateHTML).join('');}
function paintRate(p){const row=$('#r_'+p.item_id);if(!row)return;const base=+row.dataset.base;const v=Number(p.price||base);
  const el=$('#apr_'+p.item_id);const prev=+(el.dataset.v||base);el.dataset.v=v;el.innerHTML=v.toFixed(2)+'<small>%</small>';
  el.classList.toggle('up',v>base+.001);el.classList.toggle('down',v<base-.001);
  row.classList.remove('flash-pr');void row.offsetWidth;row.classList.add('flash-pr');
  $('#dv_'+p.item_id).innerHTML=(p.drivers||[]).map(d=>{const up=String(d.impact).includes('+');return `<span class="rb ${up?'up':'down'}">${d.factor} ${d.impact}</span>`;}).join('');}
async function reprice(){$('#profLabel').textContent=`score ${APP.credit_score} · ${APP.relationship_tier} · ${APP.employment_type}`;
  const r=await api('price-all',{item_ids:S.items.map(i=>i.item_id),request:APP});(r.prices||[]).forEach(paintRate);return r.prices||[];}
async function setMarket(obj){await api('context',{signals:obj});Object.entries(obj).forEach(([k,v])=>paintMarket(k,v));}
function driverBadges(p){return (p.drivers||[]).map(d=>{const up=String(d.impact).includes('+');return `<span class="rb ${up?'up':'down'}">${d.factor} ${d.impact}</span>`;}).join('')||'no rules fired';}
function summary(id,p){const base=S.base[id]||+($('#r_'+id)?.dataset.base||0);const name=((S.items.find(i=>i.item_id===id)||{}).name||id).replace(/\s*\(APR %\)/,'');
  const d=(p.price-base);return `${name}: ${base.toFixed(1)}% → <b>${Number(p.price).toFixed(2)}%</b> (${d>0?'+':''}${d.toFixed(2)} pts)<br>${driverBadges(p)}`;}
function setApp(obj){Object.assign(APP,obj);}
async function addGold(){if(S.added.has('LN-GL'))return;const p={item_id:'LN-GL',name:'Gold Loan (APR %)',base_price:9.5,cost:7,attributes:{loan_type:'gold',secured:'yes'},signals:{base_risk_premium:0.5,is_secured:true}};
  await api('item/create',{...p});S.added.add('LN-GL');S.base['LN-GL']=9.5;S.items.push({...p});$('#rateList').insertAdjacentHTML('beforeend',rateHTML(p));$('#r_LN-GL').classList.add('added');}
async function removeAdded(id){const r=$('#r_'+id);if(r){r.classList.add('removing');setTimeout(()=>r.remove(),400);}await api('item/delete',{item_id:id});S.added.delete(id);S.items=S.items.filter(i=>i.item_id!==id);}

const CASES=[
 {group:'pricing',title:'Subprime applicant',desc:'Credit 580 + high DTI 55 → risk premium on the rate.',
   run:async()=>{setApp({credit_score:580,debt_to_income_pct:55});return summary('LN-PL',find(await reprice(),'LN-PL'));}},
 {group:'pricing',title:'Prime borrower + premier',desc:'Credit 820, premier relationship, 35% down → discounts.',
   run:async()=>{setApp({credit_score:820,relationship_tier:'premier',down_payment_pct:35});return summary('LN-HL',find(await reprice(),'LN-HL'));}},
 {group:'pricing',title:'Near-prime, existing customer',desc:'Credit 700 + existing relationship.',
   run:async()=>{setApp({credit_score:700,relationship_tier:'existing'});return summary('LN-CC',find(await reprice(),'LN-CC'));}},
 {group:'pricing',title:'Self-employed + high LTV',desc:'Self-employed, 90% LTV, 96-month tenure → surcharges.',
   run:async()=>{setApp({credit_score:720,employment_type:'self_employed',loan_to_value_pct:90,tenure_months:96});return summary('LN-BL',find(await reprice(),'LN-BL'));}},
 {group:'pricing',title:'High income + big down payment',desc:'₹30L income, 40% down, prime → best rate.',
   run:async()=>{setApp({credit_score:810,annual_income:3000000,down_payment_pct:40,relationship_tier:'existing'});return summary('LN-AL',find(await reprice(),'LN-AL'));}},
 {group:'pricing',title:'Repo hike + competitive market',desc:'Central bank repo 7.5% + strong competition (90).',
   run:async()=>{await setMarket({repo_rate:7.5,market_competition_index:90});return summary('LN-PL',find(await reprice(),'LN-PL'));}},
 {group:'notif',title:'Rate hits ceiling → real decision',desc:'Subprime + high DTI on a credit card pushes APR to the 42% cap → raises a REAL approval and pushes it to your phone.',
   run:async()=>{setApp({credit_score:600,debt_to_income_pct:60});await setMarket({repo_rate:7.5});const ps=await reprice();
     const r=await api('raise-decision',{reason:'Credit-card APR hit the usury ceiling'});
     return `🔔 Real decision pushed to your phone (sent: ${r.pushed}).<br>Credit Card at <b>${Number(find(ps,'LN-CC').price).toFixed(1)}%</b>. Open the app → <b>Decisions</b>.`;}},
 {group:'crud',title:'Launch Gold Loan',desc:'Adds a new secured loan product to the live book.',
   run:async()=>{await addGold();return 'Launched <b>Gold Loan</b> (base 9.5% APR) — priced live.';}},
 {group:'crud',title:'Update a base rate',desc:'Raises the Personal Loan base APR by 0.5 points.',
   run:async()=>{const np=+( (S.base['LN-PL']||14)+0.5 ).toFixed(1);await api('item/update',{item_id:'LN-PL',base_price:np});S.base['LN-PL']=np;
     const row=$('#r_LN-PL');if(row){row.dataset.base=np;row.querySelector('.rmeta').textContent='LN-PL · base '+np.toFixed(1)+'%';}await reprice();return `Personal Loan base APR → <b>${np.toFixed(1)}%</b>.`;}},
 {group:'crud',title:'Withdraw Gold Loan',desc:'Removes the product you launched.',
   run:async()=>{if(!S.added.has('LN-GL'))return 'Gold Loan not present — run "Launch Gold Loan" first.';await removeAdded('LN-GL');return 'Withdrew <b>Gold Loan</b> from the book.';}},
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
async function boot(){renderMarket();renderCases();
  const r=await api('bootstrap',{});if(!r.ok){$('#loading p').textContent='Backend error: '+(r.error||'');return;}
  S.items=r.items.map(it=>({item_id:it.item_id,name:it.name,base_price:it.base_price,cost:it.cost,attributes:it.attributes||{},signals:it.signals||{}}));
  S.items.forEach(it=>S.base[it.item_id]=it.base_price);renderRates();
  $('#connPill').className='pill on';$('#connText').textContent='Connected';$('#loading').classList.add('gone');
  await setMarket({repo_rate:6.5,market_competition_index:60});}
$('#runAllBtn').addEventListener('click',runAll);boot();

