// YardDex — family nature field guide (Firebase edition)
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import { getAuth, GoogleAuthProvider, onAuthStateChanged, signInWithPopup, signInWithRedirect, getRedirectResult, signOut } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { getFirestore, collection, doc, addDoc, updateDoc, deleteDoc, setDoc, onSnapshot, query, orderBy } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { getStorage, ref as sref, uploadBytes, getDownloadURL, deleteObject } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-storage.js";
import { getFunctions, httpsCallable } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-functions.js";
import { firebaseConfig, functionsRegion } from "./firebase-config.js";

const fb = initializeApp(firebaseConfig);
const auth = getAuth(fb), db = getFirestore(fb), storage = getStorage(fb);
const identifyFn = httpsCallable(getFunctions(fb, functionsRegion), "identify", { timeout: 70000 });

// ---------- state ----------
const S = {
  tab: "dex", finds: [], loaded: false, loadError: "", filter: "all", user: null, authReady: false,
  family: { explorers: ["Jay", "Dad", "Mom"], places: ["Backyard", "Front yard", "Park", "Trail"] },
  add: null, lastSpotter: null, lastPlace: null, unsub: [],
};
const KINDS = {
  bird:{label:"Bird",v:"--k-bird"}, bug:{label:"Bug",v:"--k-bug"}, spider:{label:"Spider",v:"--k-bug"},
  plant:{label:"Plant",v:"--k-plant"}, tree:{label:"Tree",v:"--k-plant"}, flower:{label:"Flower",v:"--k-flower"},
  fungus:{label:"Fungus",v:"--k-fungus"}, mammal:{label:"Mammal",v:"--k-mammal"},
  reptile:{label:"Reptile",v:"--k-herp"}, amphibian:{label:"Amphibian",v:"--k-herp"}, fish:{label:"Fish",v:"--k-herp"},
  "nature-object":{label:"Treasure",v:"--k-object"}, other:{label:"Other",v:"--k-object"}
};
const kindOf = k => KINDS[k] || KINDS.other;
const $ = (s, r=document) => r.querySelector(s);
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const stars = n => { n = Math.max(1, Math.min(5, Math.round(n||1))); return `<span class="stars" aria-label="${n} of 5 stars">${"★".repeat(n)}<span class="off">${"★".repeat(5-n)}</span></span>`; };
const RARITY = ["", "Everyday", "Common", "Uncommon", "Rare", "Legendary"];
const thumbOf = f => f.thumbUrl || f.photoUrl || "";
const photoOf = f => f.photoUrl || f.thumbUrl || "";
const dayKey = iso => { const d = new Date(iso); return d.getFullYear()+"-"+String(d.getMonth()+1).padStart(2,"0")+"-"+String(d.getDate()).padStart(2,"0"); };
const fmtDate = iso => new Date(iso).toLocaleDateString(undefined, { month:"short", day:"numeric", year:"numeric" });
const keyOf = f => (f.name || "Mystery").trim().toLowerCase();
function toast(msg){ const t=$("#toast"); t.textContent=msg; t.hidden=false; clearTimeout(toast._t); toast._t=setTimeout(()=>t.hidden=true, 2800); }

// ---------- derived ----------
function species(){
  const map = new Map();
  const asc = [...S.finds].sort((a,b)=>a.createdAt.localeCompare(b.createdAt));
  for (const f of asc){
    const k = keyOf(f);
    if (!map.has(k)) map.set(k, { key:k, num: map.size+1, finds: [] });
    map.get(k).finds.push(f);
  }
  return [...map.values()];
}
function streaks(){
  const days = new Set(S.finds.map(f=>dayKey(f.createdAt)));
  let cur = 0; const d = new Date();
  if (!days.has(dayKey(d.toISOString()))) d.setDate(d.getDate()-1);
  while (days.has(dayKey(d.toISOString()))){ cur++; d.setDate(d.getDate()-1); }
  const sorted = [...days].sort(); let best=0, run=0, prev=null;
  for (const k of sorted){ const t=new Date(k+"T12:00:00"); if (prev && (t-prev)/864e5 < 1.5) run++; else run=1; best=Math.max(best,run); prev=t; }
  return { cur, best, days };
}

// ---------- render ----------
function render(){
  document.querySelectorAll(".tab").forEach(b => b.setAttribute("aria-current", b.dataset.tab===S.tab ? "page" : "false"));
  $("#tabs").hidden = !S.user;
  $("#btnExplorers").hidden = !S.user;
  const v = $("#view");
  if (!S.authReady){ v.innerHTML = `<div class="thinking">${magSvg()}Opening the field guide…</div>`; return; }
  if (!S.user){ v.innerHTML = viewSignIn(); $("#subline").textContent = "Our family field guide"; return; }
  const sp = species();
  $("#subline").textContent = S.finds.length ? `${sp.length} species · ${S.finds.length} finds` : "Our family field guide";
  if (S.tab==="dex") v.innerHTML = viewDex(sp);
  else if (S.tab==="map") { v.innerHTML = viewMap(); drawMap(); }
  else if (S.tab==="badges") v.innerHTML = viewBadges(sp);
  else if (S.tab==="print") v.innerHTML = viewPrint();
}
function viewSignIn(){
  return `<div class="signin">
    <div class="example" aria-hidden="true"><div class="art"></div><div><span class="tag">Example</span><div style="font-family:var(--f-display);font-weight:700;font-size:20px">Northern Cardinal</div>${stars(1)}</div></div>
    <h2 style="margin:0">Snap it. Name it. Collect it.</h2>
    <p class="muted" style="margin:0">Take a photo of anything you find outside. YardDex tells you what it is and adds it to your family’s collection.</p>
    <button class="big" type="button" id="btnSignIn">Sign in with Google</button>
    ${S.loadError?`<p class="warn" style="margin:0">${esc(S.loadError)}</p>`:""}
  </div>`;
}
function loadingOrError(){
  if (S.loadError) return `<div class="empty"><b>${esc(S.loadError)}</b><button class="small" type="button" id="btnSignOut">Sign out</button></div>`;
  if (!S.loaded) return `<div class="thinking">${magSvg()}Opening the field guide…</div>`;
  return "";
}
function viewDex(sp){
  const le = loadingOrError(); if (le) return le;
  const st = streaks();
  let html = `<div class="stats">
    <div class="stat"><b>${sp.length}</b><small>Species</small></div>
    <div class="stat"><b>${S.finds.length}</b><small>Finds</small></div>
    <div class="stat"><b>${st.cur}</b><small>Day streak</small></div></div>`;
  if (!S.finds.length){
    return html + `<div class="empty">
      <div><h2 style="margin-top:0">Your YardDex is empty</h2>
      <p class="muted" style="margin:0">Every bird, bug, leaf and mushroom you find becomes a card here, with its own number, rarity stars and a fun fact. Tap the yellow <b>Snap</b> button and take a photo of something outside to add the first one.</p></div>
      <div class="example" aria-label="Example card"><div class="art"></div>
        <div><span class="tag">Example</span><div class="card" style="box-shadow:none;background:none"><span class="num">#001</span>
        <span class="nm" style="font-family:var(--f-display);font-weight:700;font-size:19px">Northern Cardinal</span>${stars(1)}
        <span class="kind" style="--k:var(--k-bird)">Bird</span></div></div></div>
      <button class="small" type="button" id="btnHearEx">${speakerSvg()}Hear an example card</button></div>`;
  }
  const people = [...new Set(S.finds.map(f=>f.spotter).filter(Boolean))];
  html += `<div class="chips" role="group" aria-label="Filter by explorer">${["all",...people].map(p=>`<button type="button" class="chip" data-filter="${esc(p)}" aria-pressed="${S.filter===p}">${p==="all"?"Everyone":esc(p)}</button>`).join("")}</div>`;
  const list = sp.filter(s => S.filter==="all" || s.finds.some(f=>f.spotter===S.filter)).sort((a,b)=>b.num-a.num);
  html += `<div class="grid">` + list.map(s => {
    const latest = s.finds[s.finds.length-1];
    const k = kindOf(latest.kind);
    return `<button type="button" class="card" data-open="${esc(s.key)}">
      <img class="ph" alt="${esc(latest.name)}" src="${esc(thumbOf(latest))}" loading="lazy">
      ${s.finds.length>1?`<span class="seen">×${s.finds.length}</span>`:""}
      ${s.finds.some(f=>f.printPick)?`<span class="pick">Print pick</span>`:""}
      <span class="meta"><span class="num">#${String(s.num).padStart(3,"0")}</span>
      <span class="nm">${esc(latest.name)}</span>${stars(latest.rarity)}
      <span class="kind" style="--k:var(${k.v})">${k.label}</span></span></button>`;
  }).join("") + `</div>`;
  if (!list.length) html += `<p class="muted">No finds for ${esc(S.filter)} yet.</p>`;
  return html;
}

// ---------- badges ----------
function badgeList(sp){
  const n = S.finds.length, kinds = k => sp.filter(s=>k.includes(s.finds[0].kind)).length;
  const maxR = Math.max(0, ...S.finds.map(f=>f.rarity||0));
  const places = new Set(S.finds.map(f=>f.place).filter(Boolean)).size;
  const st = streaks();
  const B = (id,label,desc,have,need,color) => ({id,label,desc,have:Math.min(have,need),need,done:have>=need,color});
  return [
    B("first","First Find","Add your first card",n,1,"var(--leaf)"),
    B("ten","Ten Finds","10 cards in the dex",n,10,"var(--leaf)"),
    B("fifty","Field Expert","50 finds",n,50,"var(--pine)"),
    B("birds","Bird Watcher","5 kinds of birds",kinds(["bird"]),5,"var(--k-bird)"),
    B("bugs","Bug Hunter","5 kinds of bugs or spiders",kinds(["bug","spider"]),5,"var(--k-bug)"),
    B("plants","Green Thumb","5 plants, trees or flowers",kinds(["plant","tree","flower"]),5,"var(--k-plant)"),
    B("fungus","Mushroom Spotter","Find a fungus",kinds(["fungus"]),1,"var(--k-fungus)"),
    B("treasure","Treasure Finder","Pinecone, feather, nest or rock",kinds(["nature-object"]),1,"var(--k-object)"),
    B("rare","Rare Find","A 4-star find",maxR>=4?1:0,1,"var(--berry)"),
    B("legend","Legendary","A 5-star find",maxR>=5?1:0,1,"var(--sun)"),
    B("streak3","3-Day Streak","Finds 3 days in a row",st.best,3,"var(--sky)"),
    B("streak7","7-Day Streak","Finds 7 days in a row",st.best,7,"var(--sky)"),
    B("explorer","Explorer","Finds in 3 places",places,3,"var(--k-mammal)"),
  ];
}
function viewBadges(sp){
  const le = loadingOrError(); if (le) return le;
  const st = streaks(); const bl = badgeList(sp);
  const week = []; const d = new Date(); d.setDate(d.getDate()-6);
  for (let i=0;i<7;i++){ week.push(`<span class="${st.days.has(dayKey(d.toISOString()))?"on":""}">${d.toLocaleDateString(undefined,{weekday:"narrow"})}</span>`); d.setDate(d.getDate()+1); }
  const counts = {}; S.finds.forEach(f=>{ if(f.spotter) counts[f.spotter]=(counts[f.spotter]||0)+1; });
  const firsts = {}; sp.forEach(s=>{ const p=s.finds[0].spotter; if(p) firsts[p]=(firsts[p]||0)+1; });
  return `<div class="streak"><div class="n">${st.cur}</div><div><b>day streak</b><div class="muted" style="font-size:13px">Best ever: ${st.best} days. Add a find today to keep it going.</div><div class="week">${week.join("")}</div></div></div>
  <h2>Badges <span class="muted" style="font-size:15px">${bl.filter(b=>b.done).length} of ${bl.length}</span></h2>
  <div class="badges">${bl.map(b=>`<div class="badge ${b.done?"":"locked"}" style="--m:${b.color}"><div class="medal">${b.done?"★":b.have+"/"+b.need}</div><b>${b.label}</b><small>${b.desc}</small>${b.done?"":`<div class="bar"><i style="width:${Math.round(100*b.have/b.need)}%"></i></div>`}</div>`).join("")}</div>
  <h2>Explorers</h2>
  <div class="lb">${S.family.explorers.map(p=>`<div class="lbrow"><span>${esc(p)}<br><small>${firsts[p]||0} new species first spotted</small></span><span>${counts[p]||0} finds</span></div>`).join("")}</div>`;
}

// ---------- map ----------
function viewMap(){
  const le = loadingOrError(); if (le) return le;
  const geo = S.finds.filter(f=>typeof f.lat==="number" && typeof f.lon==="number");
  const pc = {}; S.finds.forEach(f=>{ const p=f.place||"Somewhere"; pc[p]=(pc[p]||0)+1; });
  const max = Math.max(1,...Object.values(pc));
  const usedKinds = [...new Set(geo.map(f=>f.kind))];
  return `<h2 style="margin-top:4px">Where we found things</h2>
  <div class="mapbox"><canvas id="map" width="1040" height="780" aria-label="Map of finds"></canvas>
  ${geo.length?`<div class="legend">${usedKinds.map(k=>`<span><i style="--k:var(${kindOf(k).v})"></i>${kindOf(k).label}</span>`).join("")}</div>`:""}</div>
  <p class="note">${geo.length?`${geo.length} of ${S.finds.length} finds have a GPS spot. Tap a dot to open its card.`:`No GPS spots yet. Allow location when YardDex asks while adding a find, and the spot is saved with it.`}</p>
  <h2>Places</h2>
  <div class="places">${Object.entries(pc).sort((a,b)=>b[1]-a[1]).map(([p,c])=>`<div class="place"><span>${esc(p)}</span><span>${c}</span><div class="bar"><i style="width:${Math.round(100*c/max)}%"></i></div></div>`).join("") || `<p class="muted">Nothing yet.</p>`}</div>`;
}
let mapPts = [];
function drawMap(){
  const c = $("#map"); if (!c) return;
  const ctx = c.getContext("2d"), W=c.width, H=c.height, cs=getComputedStyle(document.documentElement);
  const col = v => cs.getPropertyValue(v).trim();
  ctx.fillStyle = col("--surface-2"); ctx.fillRect(0,0,W,H);
  ctx.strokeStyle = col("--line"); ctx.lineWidth = 2;
  for (let x=0;x<=W;x+=W/8){ ctx.beginPath(); ctx.moveTo(x,0); ctx.lineTo(x,H); ctx.stroke(); }
  for (let y=0;y<=H;y+=H/6){ ctx.beginPath(); ctx.moveTo(0,y); ctx.lineTo(W,y); ctx.stroke(); }
  const geo = S.finds.filter(f=>typeof f.lat==="number" && typeof f.lon==="number");
  mapPts = [];
  ctx.font = "700 26px Nunito, sans-serif"; ctx.textAlign="center";
  if (!geo.length){ ctx.fillStyle = col("--ink-2"); ctx.fillText("Finds with GPS will appear here", W/2, H/2); return; }
  let la0=Math.min(...geo.map(f=>f.lat)), la1=Math.max(...geo.map(f=>f.lat)), lo0=Math.min(...geo.map(f=>f.lon)), lo1=Math.max(...geo.map(f=>f.lon));
  const kx = Math.cos((la0+la1)/2*Math.PI/180);
  let spanX=(lo1-lo0)*kx, spanY=la1-la0; const minSpan=0.0006;
  if (spanX<minSpan){ const m=(lo0+lo1)/2; lo0=m-minSpan/kx/2; lo1=m+minSpan/kx/2; spanX=minSpan; }
  if (spanY<minSpan){ const m=(la0+la1)/2; la0=m-minSpan/2; la1=m+minSpan/2; spanY=minSpan; }
  const pad=70, sc=Math.min((W-2*pad)/spanX,(H-2*pad)/spanY);
  const ox=(W-spanX*sc)/2, oy=(H-spanY*sc)/2;
  const metersPerPx = 111320/sc; const m = [10,25,50,100,250,500,1000,2500,5000].find(v=>v/metersPerPx>120) || 5000;
  const bl = m/metersPerPx; ctx.fillStyle=col("--ink-2"); ctx.fillRect(30,H-34,bl,6); ctx.textAlign="left"; ctx.font="700 22px Nunito, sans-serif"; ctx.fillText(m>=1000?(m/1000)+" km":m+" m",30,H-44);
  for (const f of geo){
    const x = ox+(f.lon-lo0)*kx*sc, y = H-(oy+(f.lat-la0)*sc);
    mapPts.push({x,y,f});
    ctx.beginPath(); ctx.arc(x,y,18,0,7); ctx.fillStyle=col(kindOf(f.kind).v); ctx.fill();
    ctx.lineWidth=5; ctx.strokeStyle=col("--surface"); ctx.stroke();
  }
}

// ---------- print (lithophane) ----------
function viewPrint(){
  const le = loadingOrError(); if (le) return le;
  const picks = S.finds.filter(f=>f.printPick);
  let html = `<h2 style="margin-top:4px">Lithophane prints</h2>
  <p class="muted" style="margin-top:0">A lithophane is a thin white print that shows the photo when you hold it up to a window or lamp. Star a find as a <b>Print pick</b> on its card, then make the 3D file here.</p>`;
  if (!picks.length) return html + `<div class="empty"><b>No print picks yet</b><span class="muted">Open any card in the Dex and tap “Make print pick”.</span></div>`;
  html += `<div class="grid">${picks.map(f=>`<button type="button" class="card" data-lith="${esc(f.id)}"><img class="ph" alt="${esc(f.name)}" src="${esc(thumbOf(f))}" loading="lazy"><span class="meta"><span class="nm">${esc(f.name)}</span><span class="num">${esc(f.spotter||"")} · ${fmtDate(f.createdAt)}</span></span></button>`).join("")}</div>`;
  return html;
}
const LITH = { shape:"square", size:100, detail:0.4, minT:0.8, maxT:3.0, border:3 };
function openLith(f){
  S.lithFind = f;
  openSheet(`<div class="sheethead"><h1>${esc(f.name)}</h1><button class="iconbtn" data-close type="button">Done</button></div>
  <div class="lith">
    <div class="lithprev"><figure><canvas id="lpA"></canvas><figcaption>Photo</figcaption></figure><figure><canvas id="lpB"></canvas><figcaption>Held up to the light</figcaption></figure></div>
    <div class="label">Shape</div>
    <div class="seg" data-seg="shape">${[["square","Square"],["land","Wide"],["port","Tall"]].map(([v,l])=>`<button type="button" data-v="${v}" aria-pressed="${LITH.shape===v}">${l}</button>`).join("")}</div>
    <div class="label">Longest side</div>
    <div class="seg" data-seg="size">${[80,100,120].map(v=>`<button type="button" data-v="${v}" aria-pressed="${LITH.size===v}">${v} mm</button>`).join("")}</div>
    <div class="label">Detail</div>
    <div class="seg" data-seg="detail">${[[0.5,"Quick"],[0.4,"Standard"],[0.3,"Fine"]].map(([v,l])=>`<button type="button" data-v="${v}" aria-pressed="${LITH.detail===v}">${l}</button>`).join("")}</div>
    <p class="note" id="lithInfo"></p>
    <button class="big" id="btnStl" type="button">Download STL</button>
    <p class="note">Print in white PLA at 100% infill, 0.12 mm layers, standing upright on its edge with a brim. Thickness runs 0.8 mm (bright) to 3.0 mm (dark) with a 3 mm frame. The textured side faces you; light goes behind the flat side.</p>
  </div>`);
  loadImg(photoOf(f), true).then(img => { S.lithImg = img; drawLithPreview(); }).catch(()=>toast("Couldn’t load that photo. Check the Storage CORS step in the README."));
}
function lithDims(){
  const L = LITH.size, a = LITH.shape==="square"?1:(LITH.shape==="land"?4/3:3/4);
  return { W: a>=1?L:L*a, H: a>=1?L/a:L };
}
function cropDraw(img, w, h){
  const c = document.createElement("canvas"); c.width=w; c.height=h; const ctx=c.getContext("2d");
  const ia = img.naturalWidth/img.naturalHeight, ta=w/h; let sw,sh,sx,sy;
  if (ia>ta){ sh=img.naturalHeight; sw=sh*ta; sx=(img.naturalWidth-sw)/2; sy=0; } else { sw=img.naturalWidth; sh=sw/ta; sx=0; sy=(img.naturalHeight-sh)/2; }
  ctx.imageSmoothingQuality="high"; ctx.drawImage(img,sx,sy,sw,sh,0,0,w,h); return c;
}
function heightGrid(pitch){
  const {W,H} = lithDims(), p=pitch||LITH.detail, b=LITH.border;
  const nx = Math.round(W/p)+1, ny = Math.round(H/p)+1, bx = Math.max(1, Math.round(b/p));
  const iw = nx-2*bx, ih = ny-2*bx;
  const src = cropDraw(S.lithImg, iw, ih).getContext("2d").getImageData(0,0,iw,ih).data;
  const h = new Float32Array(nx*ny);
  for (let r=0;r<ny;r++) for (let c=0;c<nx;c++){
    let t = LITH.maxT;
    const ir = r-bx, ic = c-bx;
    if (ir>=0 && ir<ih && ic>=0 && ic<iw){
      const k=(ir*iw+ic)*4; const lum=Math.pow((0.299*src[k]+0.587*src[k+1]+0.114*src[k+2])/255, 0.9);
      t = LITH.minT + (1-lum)*(LITH.maxT-LITH.minT);
    }
    h[r*nx+c] = t;
  }
  return { h, nx, ny, p };
}
function drawLithPreview(){
  if (!S.lithImg) return;
  const {W,H} = lithDims(), pw = 300, ph = Math.round(pw*H/W);
  const A=$("#lpA"), B=$("#lpB"); if (!A) return;
  A.width=B.width=pw; A.height=B.height=ph;
  A.getContext("2d").drawImage(cropDraw(S.lithImg,pw,ph),0,0);
  const g = heightGrid(Math.max(W,H)/pw);
  const ctx = B.getContext("2d"), im = ctx.createImageData(pw,ph);
  for (let y=0;y<ph;y++) for (let x=0;x<pw;x++){
    const gx=Math.min(g.nx-1,Math.round(x*(g.nx-1)/(pw-1))), gy=Math.min(g.ny-1,Math.round(y*(g.ny-1)/(ph-1)));
    const L=Math.exp(-1.15*(g.h[gy*g.nx+gx]-0.6)); const k=(y*pw+x)*4;
    im.data[k]=Math.min(255,255*L); im.data[k+1]=Math.min(255,235*L); im.data[k+2]=Math.min(255,190*L); im.data[k+3]=255;
  }
  ctx.putImageData(im,0,0);
  const nx=Math.round(W/LITH.detail)+1, ny=Math.round(H/LITH.detail)+1;
  const tris = 2*(nx-1)*(ny-1) + 6*((nx-1)+(ny-1));
  $("#lithInfo").textContent = `${W.toFixed(0)} × ${H.toFixed(0)} mm · about ${(tris*50/1048576).toFixed(1)} MB STL`;
}
export function buildSTL(grid){
  const { h, nx, ny, p } = grid || heightGrid();
  const per = 2*((nx-1)+(ny-1));
  const T = 2*(nx-1)*(ny-1) + 3*per;
  const buf = new ArrayBuffer(84+50*T), dv = new DataView(buf);
  const hdr = "YardDex lithophane"; for (let i=0;i<hdr.length;i++) dv.setUint8(i,hdr.charCodeAt(i));
  dv.setUint32(80,T,true);
  let o=84;
  const X = c => c*p, Y = r => (ny-1-r)*p;
  const tri = (a,b,c) => {
    const ux=b[0]-a[0],uy=b[1]-a[1],uz=b[2]-a[2],vx=c[0]-a[0],vy=c[1]-a[1],vz=c[2]-a[2];
    const nx_=uy*vz-uz*vy, ny_=uz*vx-ux*vz, nz_=ux*vy-uy*vx; const l=Math.hypot(nx_,ny_,nz_)||1;
    dv.setFloat32(o,nx_/l,true); dv.setFloat32(o+4,ny_/l,true); dv.setFloat32(o+8,nz_/l,true); o+=12;
    for (const v of [a,b,c]){ dv.setFloat32(o,v[0],true); dv.setFloat32(o+4,v[1],true); dv.setFloat32(o+8,v[2],true); o+=12; }
    dv.setUint16(o,0,true); o+=2;
  };
  const V = (r,c) => [X(c), Y(r), h[r*nx+c]];
  for (let r=0;r<ny-1;r++) for (let c=0;c<nx-1;c++){
    const a=V(r+1,c), b=V(r+1,c+1), cc=V(r,c+1), d=V(r,c);
    tri(a,b,cc); tri(a,cc,d);
  }
  const loop=[];
  for (let c=0;c<nx-1;c++) loop.push([ny-1,c]);
  for (let r=ny-1;r>0;r--) loop.push([r,nx-1]);
  for (let c=nx-1;c>0;c--) loop.push([0,c]);
  for (let r=0;r<ny-1;r++) loop.push([r,0]);
  const ctr=[X(nx-1)/2, Y(0)/2, 0];
  for (let i=0;i<loop.length;i++){
    const A=V(...loop[i]), B=V(...loop[(i+1)%loop.length]);
    const Ab=[A[0],A[1],0], Bb=[B[0],B[1],0];
    tri(Ab,Bb,B); tri(Ab,B,A);
    tri(ctr,Bb,Ab);
  }
  return new Uint8Array(buf, 0, o);
}
async function saveSTL(){
  const f = S.lithFind; if (!S.lithImg) return;
  const btn=$("#btnStl"); btn.disabled=true; btn.textContent="Building…";
  await new Promise(r=>setTimeout(r,30));
  try{
    const stl = buildSTL();
    const slug = (f.name||"find").toLowerCase().replace(/[^a-z0-9]+/g,"-").replace(/^-|-$/g,"") || "find";
    const url = URL.createObjectURL(new Blob([stl], { type:"model/stl" }));
    const a = document.createElement("a"); a.href=url; a.download=`yarddex-${slug}-lithophane.stl`;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(()=>URL.revokeObjectURL(url), 60000);
    toast("STL ready");
  }catch{ toast("Couldn’t build the file. Try Quick detail."); }
  btn.disabled=false; btn.textContent="Download STL";
}

// ---------- detail ----------
function openSpecies(key, focusId){
  const s = species().find(x=>x.key===key); if (!s) return;
  const f = s.finds.find(x=>x.id===focusId) || s.finds[s.finds.length-1];
  const maps = typeof f.lat==="number" ? `<a href="https://maps.apple.com/?ll=${f.lat},${f.lon}&q=${encodeURIComponent(f.name)}" target="_blank" rel="noopener">Open in Maps</a>` : "";
  openSheet(`<div class="sheethead"><span class="num" style="font-family:var(--f-mono);color:var(--ink-2)">#${String(s.num).padStart(3,"0")}</span><button class="iconbtn" data-close type="button">Close</button></div>
  <div class="reveal" style="animation:none">${cardBody(f)}</div>
  ${s.finds.length>1?`<div class="label" style="margin-top:12px">Sightings (${s.finds.length})</div><div class="sightings">${s.finds.slice().reverse().map(x=>`<button type="button" data-sighting="${esc(x.id)}" aria-pressed="${x.id===f.id}"><img alt="${esc(x.spotter||"")} ${fmtDate(x.createdAt)}" src="${esc(thumbOf(x))}"></button>`).join("")}</div>`:""}
  <div class="btnrow" style="margin-top:12px">
    <button class="small" type="button" data-say="${esc(f.id)}">${speakerSvg()}Read it to me</button>
    <button class="small ${f.printPick?"on":""}" type="button" data-pickprint="${esc(f.id)}">${starSvg()}${f.printPick?"Print pick":"Make print pick"}</button>
  </div>
  <div class="foot" style="margin-top:10px">${maps}</div>
  <div id="delZone" style="margin-top:14px"><button class="small danger" type="button" data-askdel="${esc(f.id)}" style="width:100%">Remove this sighting</button></div>`);
  S.openKey = key;
}
function cardBody(f){
  const k = kindOf(f.kind);
  return `<img class="ph" alt="${esc(f.name)}" src="${esc(f._local || photoOf(f))}">
  <div class="body">
    <span class="kind" style="--k:var(${k.v})">${k.label}</span>
    <h3 class="nm">${esc(f.name)}</h3>
    ${f.scientific?`<div class="sci">${esc(f.scientific)}</div>`:""}
    <div class="rar">${stars(f.rarity)}<b>${RARITY[Math.max(1,Math.min(5,f.rarity||1))]}</b><span class="muted" style="font-size:13px">${esc(f.rarityWhy||"")}</span></div>
    ${f.safety?`<div class="warn">Careful: ${esc(f.safety)}</div>`:""}
    <div class="fact">${esc(f.fact||"")}</div>
    ${f.lookFor?`<div><b>Look for:</b> ${esc(f.lookFor)}</div>`:""}
    <div class="foot"><span>Spotted by ${esc(f.spotter||"someone")}</span><span>${esc(f.place||"")}</span><span>${fmtDate(f.createdAt)}</span>${f.confidence&&f.confidence!=="sure"?`<span>Claude’s ${esc(f.confidence)}</span>`:""}</div>
  </div>`;
}
function sayText(f){
  const r = Math.max(1,Math.min(5,f.rarity||1));
  return `${f.found===false?"Hmm, a mystery!":"You found a "+f.name+"!"} ${f.fact||""} ${f.lookFor?"Look for this: "+f.lookFor+".":""} ${f.safety?"Be careful: "+f.safety+".":""} It is ${RARITY[r].toLowerCase()}, ${r} star${r>1?"s":""}.`.replace(/\s+/g," ").trim();
}
function speak(text){
  try{
    if (!("speechSynthesis" in window)) throw 0;
    speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text); u.rate=0.92; u.pitch=1.1; u.lang="en-US";
    const v = speechSynthesis.getVoices().find(v=>/en-US/i.test(v.lang) && /Samantha|Karen|Nicky|Google US/i.test(v.name));
    if (v) u.voice = v;
    speechSynthesis.speak(u);
  }catch{ toast("Read-aloud isn’t available on this device."); }
}

// ---------- sheet helpers ----------
function openSheet(html){ $("#sheetBody").innerHTML = html; $("#sheet").hidden=false; $("#sheet").scrollTop=0; document.body.style.overflow="hidden"; }
function closeSheet(){ $("#sheet").hidden=true; document.body.style.overflow=""; S.add=null; S.openKey=null; S.lithImg=null; try{ speechSynthesis.cancel(); }catch{} render(); }

// ---------- add flow ----------
function openAdd(){ S.add = { step:"pick" }; renderAdd(); }
function renderAdd(){
  const A = S.add; if (!A) return;
  if (A.step==="pick"){
    openSheet(`<div class="sheethead"><h1>New find</h1><button class="iconbtn" data-close type="button">Cancel</button></div>
    <div class="stack">
      <label class="big sun filebtn">${camSvg()} Take a photo<input type="file" id="inCam" accept="image/*" capture="environment"></label>
      <label class="big ghost filebtn">Choose from Photos<input type="file" id="inLib" accept="image/*"></label>
      <p class="note">Get close and fill the picture with the thing you found. One thing per photo works best.</p>
    </div>`);
    return;
  }
  if (A.step==="details"){
    const ex = S.family.explorers, pl = S.family.places;
    A.spotter ??= (S.lastSpotter && ex.includes(S.lastSpotter)) ? S.lastSpotter : ex[0];
    A.place ??= S.lastPlace || pl[0];
    openSheet(`<div class="sheethead"><h1>New find</h1><button class="iconbtn" data-close type="button">Cancel</button></div>
    <div class="stack">
      <img class="preview" alt="Your photo" src="${A.previewUrl}">
      <p class="note" style="margin:0" id="gpsNote">${A.gps?"Location saved with this find.":"Finding your location…"}</p>
      <div class="label">Who spotted it?</div>
      <div class="row">${ex.map(p=>`<button type="button" class="chip" data-spotter="${esc(p)}" aria-pressed="${A.spotter===p}">${esc(p)}</button>`).join("")}</div>
      <div class="label">Where?</div>
      <div class="row">${pl.map(p=>`<button type="button" class="chip" data-place="${esc(p)}" aria-pressed="${A.place===p}">${esc(p)}</button>`).join("")}</div>
      <button class="big" id="btnIdentify" type="button">${magSvg(28)} What is it?</button>
    </div>`);
    return;
  }
  if (A.step==="thinking"){
    openSheet(`<div class="sheethead"><h1>Looking closely…</h1><button class="iconbtn" data-close type="button">Cancel</button></div>
    <div class="stack"><img class="preview" alt="" src="${A.previewUrl}"><div class="thinking">${magSvg()}<span id="thinkMsg">Claude is checking the field guide…</span></div></div>`);
    return;
  }
  if (A.step==="reveal"){
    const f = A.result;
    openSheet(`<div class="sheethead"><h1>${f.found===false?"Hmm, a mystery!":"You found it!"}</h1><button class="iconbtn" data-close type="button">Cancel</button></div>
    <div class="stack">
      <div class="reveal">${cardBody(f)}</div>
      <button class="small" type="button" id="btnSayNew">${speakerSvg()}Read it to me</button>
      <details><summary class="note" style="cursor:pointer">Wrong name? Fix it</summary>
        <div class="row" style="margin-top:8px"><input class="field" id="fixName" value="${esc(f.name)}" aria-label="Correct name"></div></details>
      <button class="big" id="btnSave" type="button">Add to YardDex</button>
      <button class="big ghost" id="btnRetry" type="button">Try another photo</button>
    </div>`);
  }
}
function getHereNow(){
  return new Promise(res => {
    if (!navigator.geolocation) return res(null);
    navigator.geolocation.getCurrentPosition(
      p => res({ lat:+p.coords.latitude.toFixed(6), lon:+p.coords.longitude.toFixed(6) }),
      () => res(null), { enableHighAccuracy:true, timeout:12000, maximumAge:60000 });
  });
}
async function onPhoto(file, fromCamera){
  if (!file) return;
  const A = S.add = { step:"details", file };
  const gpsP = (async () => (await readGps(file).catch(()=>null)) || (fromCamera ? await getHereNow() : null))();
  try{
    const img = await loadImg(URL.createObjectURL(file));
    A.img = img;
    A.previewUrl = cropDraw(img, 720, 720).toDataURL("image/jpeg", .85);
  }catch{ toast("That photo couldn’t be opened. Try a different one."); S.add={step:"pick"}; renderAdd(); return; }
  renderAdd();
  gpsP.then(g => { A.gps = g; const n=$("#gpsNote"); if (n) n.textContent = g ? "Location saved with this find." : "No location for this photo. That’s OK."; });
  A.uploads = (async () => {
    const id = Date.now().toString(36) + Math.random().toString(36).slice(2,8);
    const big = await scaleBlob(A.img, 2400, .88), thumb = await toBlob(cropDraw(A.img, 480, 480), .82);
    const pRef = sref(storage, `photos/${id}.jpg`), tRef = sref(storage, `photos/${id}_thumb.jpg`);
    await Promise.all([uploadBytes(pRef, big, { contentType:"image/jpeg" }), uploadBytes(tRef, thumb, { contentType:"image/jpeg" })]);
    const [photoUrl, thumbUrl] = await Promise.all([getDownloadURL(pRef), getDownloadURL(tRef)]);
    return { photoPath: pRef.fullPath, thumbPath: tRef.fullPath, photoUrl, thumbUrl };
  })();
  A.uploads.catch(()=>{ A.uploadFailed = true; });
  A.gpsP = gpsP;
}
async function identify(){
  const A = S.add; if (!A) return;
  A.step="thinking"; renderAdd();
  const msgs=["Claude is checking the field guide…","Counting legs and feathers…","Comparing colors and shapes…","Almost there…"]; let mi=0;
  const iv=setInterval(()=>{ const m=$("#thinkMsg"); if(m) m.textContent=msgs[++mi%msgs.length]; },2200);
  try{
    const blob = await scaleBlob(A.img, 1280, .85);
    const image = await blobToBase64(blob);
    const { data: r } = await identifyFn({ image, place: A.place, month: new Date().toLocaleDateString("en-US",{month:"long"}) });
    if (S.add !== A) return;
    const gps = await A.gpsP;
    const res = { ...r, spotter: A.spotter, place: A.place, createdAt: new Date().toISOString(), _local: A.previewUrl };
    if (gps){ res.lat = gps.lat; res.lon = gps.lon; }
    A.result = res; A.step="reveal";
  }catch(e){
    clearInterval(iv);
    if (S.add !== A) return;
    const code = e?.code || "";
    const msg = code.includes("resource-exhausted") ? "That’s a lot of finds today! Try again tomorrow." :
      code.includes("permission-denied") ? "This account isn’t on the family list yet." :
      "Claude couldn’t read that photo. Try again or use another photo.";
    toast(msg); A.step="details"; renderAdd(); return;
  }
  clearInterval(iv); renderAdd();
  try{ navigator.vibrate?.(60); }catch{}
}
async function saveFind(){
  const A = S.add; if (!A?.result) return;
  const btn=$("#btnSave"); btn.disabled=true; btn.textContent="Saving…";
  try{
    const ids = await A.uploads;
    const fix = $("#fixName")?.value.trim();
    const { _local, ...docData } = A.result;
    if (fix && fix!==docData.name){ docData.name = fix.slice(0,80); docData.confidence = "sure"; docData.fixedByFamily = true; }
    Object.assign(docData, ids, { addedBy: S.user.uid });
    const isNew = !S.finds.some(f=>keyOf(f)===keyOf(docData));
    await addDoc(collection(db, "finds"), docData);
    S.lastSpotter = A.spotter; S.lastPlace = A.place;
    S.tab="dex"; closeSheet();
    toast(isNew ? `New species: ${docData.name}!` : `Another ${docData.name} sighting!`);
  }catch{ btn.disabled=false; btn.textContent="Add to YardDex"; toast("Couldn’t save. Check your connection and try again."); }
}

// ---------- explorers ----------
function openExplorers(){
  const ex=S.family.explorers, pl=S.family.places;
  openSheet(`<div class="sheethead"><h1>Explorers & places</h1><button class="iconbtn" data-close type="button">Done</button></div>
  <div class="stack">
    <div class="label">Explorers</div>
    <div class="row">${ex.map(p=>`<button type="button" class="chip" data-rmex="${esc(p)}" aria-label="Remove ${esc(p)}">${esc(p)} ✕</button>`).join("")}</div>
    <div class="row" style="flex-wrap:nowrap"><input class="field" id="newEx" placeholder="Add a name" maxlength="20"><button class="small" type="button" id="addEx">Add</button></div>
    <div class="label">Places</div>
    <div class="row">${pl.map(p=>`<button type="button" class="chip" data-rmpl="${esc(p)}" aria-label="Remove ${esc(p)}">${esc(p)} ✕</button>`).join("")}</div>
    <div class="row" style="flex-wrap:nowrap"><input class="field" id="newPl" placeholder="Add a place" maxlength="24"><button class="small" type="button" id="addPl">Add</button></div>
    <p class="note">Tap a name to remove it. Past finds keep their names.</p>
    <p class="note">Signed in as ${esc(S.user?.email||"")}</p>
    <button class="small" type="button" id="btnSignOut">Sign out</button>
  </div>`);
}
async function saveFamily(){
  openExplorers();
  try{ await setDoc(doc(db, "settings", "family"), { explorers:S.family.explorers, places:S.family.places }); }catch{ toast("Couldn’t save that change."); }
}

// ---------- events ----------
document.addEventListener("click", async e => {
  const t = e.target.closest("button, [data-close]"); if (!t) return;
  if (t.matches("[data-close]")) return closeSheet();
  if (t.dataset.tab){ S.tab=t.dataset.tab; render(); window.scrollTo(0,0); return; }
  if (t.id==="btnSignIn") return doSignIn();
  if (t.id==="btnSignOut"){ closeSheet(); await signOut(auth); return; }
  if (t.id==="btnSnap") return openAdd();
  if (t.id==="btnExplorers") return openExplorers();
  if (t.id==="btnHearEx") return speak("You found a Northern Cardinal! Only the boy cardinals are bright red. The girls are brown with orange beaks. It is everyday, 1 star.");
  if (t.dataset.filter){ S.filter=t.dataset.filter; render(); return; }
  if (t.dataset.open) return openSpecies(t.dataset.open);
  if (t.dataset.sighting) return openSpecies(S.openKey, t.dataset.sighting);
  if (t.dataset.spotter){ S.add.spotter=t.dataset.spotter; renderAdd(); return; }
  if (t.dataset.place){ S.add.place=t.dataset.place; renderAdd(); return; }
  if (t.id==="btnIdentify") return identify();
  if (t.id==="btnSave") return saveFind();
  if (t.id==="btnRetry"){ S.add={step:"pick"}; renderAdd(); return; }
  if (t.id==="btnSayNew") return speak(sayText(S.add.result));
  if (t.dataset.say){ const f=S.finds.find(x=>x.id===t.dataset.say); if (f) speak(sayText(f)); return; }
  if (t.dataset.pickprint){
    const f=S.finds.find(x=>x.id===t.dataset.pickprint); if (!f) return;
    try{ await updateDoc(doc(db,"finds",f.id), { printPick: !f.printPick }); f.printPick=!f.printPick; openSpecies(S.openKey, f.id); toast(f.printPick?"Added to print picks":"Removed from print picks"); }catch{ toast("Couldn’t change that."); }
    return;
  }
  if (t.dataset.askdel){
    $("#delZone").innerHTML = `<div class="confirm"><b>Remove this sighting and its photo?</b><div class="btnrow"><button class="small" type="button" data-canceldel>Keep it</button><button class="small danger" type="button" data-dodel="${esc(t.dataset.askdel)}">Remove</button></div></div>`;
    return;
  }
  if (t.matches("[data-canceldel]")) return openSpecies(S.openKey);
  if (t.dataset.dodel){
    const f=S.finds.find(x=>x.id===t.dataset.dodel); if (!f) return;
    try{
      await deleteDoc(doc(db,"finds",f.id));
      for (const p of [f.photoPath,f.thumbPath]) if (p) deleteObject(sref(storage,p)).catch(()=>{});
      closeSheet(); toast("Removed");
    }catch{ toast("Couldn’t remove it."); }
    return;
  }
  if (t.dataset.lith){ const f=S.finds.find(x=>x.id===t.dataset.lith); if (f) openLith(f); return; }
  if (t.closest("[data-seg]")){ const seg=t.closest("[data-seg]").dataset.seg; const v=t.dataset.v; LITH[seg]= seg==="shape"?v:Number(v); t.parentElement.querySelectorAll("button").forEach(b=>b.setAttribute("aria-pressed", b===t)); drawLithPreview(); return; }
  if (t.id==="btnStl") return saveSTL();
  if (t.id==="addEx"||t.id==="addPl"){
    const inp=$(t.id==="addEx"?"#newEx":"#newPl"), v=inp.value.trim(); if (!v) return;
    const arr = t.id==="addEx"?S.family.explorers:S.family.places; if (!arr.includes(v)) arr.push(v);
    return saveFamily();
  }
  if (t.dataset.rmex){ if (S.family.explorers.length>1) S.family.explorers=S.family.explorers.filter(x=>x!==t.dataset.rmex); return saveFamily(); }
  if (t.dataset.rmpl){ if (S.family.places.length>1) S.family.places=S.family.places.filter(x=>x!==t.dataset.rmpl); return saveFamily(); }
});
document.addEventListener("change", e => { if (e.target.id==="inCam"||e.target.id==="inLib") onPhoto(e.target.files?.[0], e.target.id==="inCam"); });
document.addEventListener("keydown", e => {
  if (e.key==="Enter" && (e.target.id==="newEx"||e.target.id==="newPl")) $(e.target.id==="newEx"?"#addEx":"#addPl").click();
  if (e.key==="Escape" && !$("#sheet").hidden) closeSheet();
});
document.addEventListener("click", e => {
  const c = e.target.closest("#map"); if (!c) return;
  const r=c.getBoundingClientRect(), x=(e.clientX-r.left)*c.width/r.width, y=(e.clientY-r.top)*c.height/r.height;
  let best=null, bd=40*40; for (const p of mapPts){ const d=(p.x-x)**2+(p.y-y)**2; if (d<bd){ bd=d; best=p; } }
  if (best) openSpecies(keyOf(best.f), best.f.id);
});

// ---------- image utils ----------
function loadImg(src, cors){ return new Promise((res,rej)=>{ const i=new Image(); if (cors) i.crossOrigin="anonymous"; i.onload=()=>res(i); i.onerror=rej; i.src=src; }); }
function toBlob(c,q){ return new Promise((res,rej)=>c.toBlob(b=>b?res(b):rej(new Error("encode")),"image/jpeg",q)); }
function scaleBlob(img,max,q){ const s=Math.min(1,max/Math.max(img.naturalWidth,img.naturalHeight)); const c=document.createElement("canvas"); c.width=Math.round(img.naturalWidth*s); c.height=Math.round(img.naturalHeight*s); const x=c.getContext("2d"); x.imageSmoothingQuality="high"; x.drawImage(img,0,0,c.width,c.height); return toBlob(c,q); }
function blobToBase64(b){ return new Promise((res,rej)=>{ const r=new FileReader(); r.onload=()=>res(String(r.result).split(",")[1]); r.onerror=rej; r.readAsDataURL(b); }); }
async function readGps(file){
  const buf = await file.slice(0, 256*1024).arrayBuffer(); const v = new DataView(buf);
  if (v.byteLength<4 || v.getUint16(0)!==0xFFD8) return null;
  let o=2;
  while (o+4<v.byteLength){
    const m=v.getUint16(o), len=v.getUint16(o+2);
    if (m===0xFFE1 && v.getUint32(o+4)===0x45786966){
      const t=o+10, le=v.getUint16(t)===0x4949, u16=p=>v.getUint16(p,le), u32=p=>v.getUint32(p,le);
      const ifd = (p, want) => { const n=u16(p); for (let i=0;i<n;i++){ const e=p+2+i*12; if (u16(e)===want) return u32(e+8); } return null; };
      const gpsOff = ifd(t+u32(t+4), 0x8825); if (gpsOff==null) return null;
      const g=t+gpsOff, n=u16(g), tags={};
      for (let i=0;i<n;i++){ const e=g+2+i*12; tags[u16(e)] = { val:e+8 }; }
      const ref = k => tags[k] ? String.fromCharCode(v.getUint8(tags[k].val)) : "";
      const rat = k => { if(!tags[k]) return null; const p=t+u32(tags[k].val); const r=j=>u32(p+j*8)/u32(p+j*8+4); return r(0)+r(1)/60+r(2)/3600; };
      let lat=rat(2), lon=rat(4); if (lat==null||lon==null||!isFinite(lat)||!isFinite(lon)) return null;
      if (ref(1)==="S") lat=-lat; if (ref(3)==="W") lon=-lon;
      if (lat===0 && lon===0) return null;
      return { lat:+lat.toFixed(6), lon:+lon.toFixed(6) };
    }
    if ((m&0xFF00)!==0xFF00) break; o += 2+len;
  }
  return null;
}
// ---------- icons ----------
function magSvg(sz){ return `<svg class="${sz?"":"mag"}" ${sz?`width="${sz}" height="${sz}"`:""} viewBox="0 0 64 64" fill="none" aria-hidden="true"><circle cx="27" cy="27" r="16" stroke="currentColor" stroke-width="6"/><path d="M39 39l14 14" stroke="currentColor" stroke-width="7" stroke-linecap="round"/><circle cx="22" cy="22" r="4" fill="currentColor" opacity=".35"/></svg>`; }
function camSvg(){ return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 8h3l2-3h6l2 3h3v11H4z"/><circle cx="12" cy="13" r="3.5"/></svg>`; }
function speakerSvg(){ return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 10v4h4l5 4V6L8 10z"/><path d="M16.5 8.5a5 5 0 0 1 0 7M19 6a8.5 8.5 0 0 1 0 12"/></svg>`; }
function starSvg(){ return `<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 3l2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1-4.4-4.3 6.1-.9z"/></svg>`; }

// ---------- auth + data ----------
const isStandalone = () => window.matchMedia?.("(display-mode: standalone)").matches || navigator.standalone === true;
async function doSignIn(){
  const provider = new GoogleAuthProvider(); provider.setCustomParameters({ prompt:"select_account" });
  S.loadError = "";
  try{
    if (isStandalone()) await signInWithRedirect(auth, provider);
    else await signInWithPopup(auth, provider);
  }catch(e){
    if (e?.code==="auth/popup-blocked") return signInWithRedirect(auth, provider);
    if (e?.code!=="auth/popup-closed-by-user"){ S.loadError="Sign-in didn’t work. Try again."; render(); }
  }
}
function stopData(){ S.unsub.forEach(u=>{ try{u();}catch{} }); S.unsub=[]; }
function startData(){
  stopData(); S.loaded=false; S.loadError=""; render();
  const timer = setTimeout(()=>{ if (!S.loaded){ S.loadError="The field guide is taking a while to open. Check your connection."; render(); } }, 10000);
  S.unsub.push(onSnapshot(doc(db,"settings","family"), snap => {
    if (snap.exists()){ const d=snap.data(); if (Array.isArray(d.explorers)&&d.explorers.length) S.family.explorers=d.explorers.map(String); if (Array.isArray(d.places)&&d.places.length) S.family.places=d.places.map(String); }
    if ($("#sheet").hidden) render();
  }, ()=>{}));
  S.unsub.push(onSnapshot(query(collection(db,"finds"), orderBy("createdAt","asc")), snap => {
    clearTimeout(timer); S.loaded=true; S.loadError="";
    S.finds = snap.docs.map(d=>({ id:d.id, ...d.data() })).filter(f=>typeof f.createdAt==="string");
    if ($("#sheet").hidden) render();
  }, err => {
    clearTimeout(timer);
    S.loadError = err?.code==="permission-denied"
      ? `${S.user?.email||"This account"} isn’t on the family list yet. Ask Jag to add it in Firebase (config/family → members).`
      : "Couldn’t open the field guide right now. Try reloading.";
    render();
  }));
}
getRedirectResult(auth).catch(()=>{});
onAuthStateChanged(auth, user => {
  S.user = user; S.authReady = true;
  if (user) startData(); else { stopData(); S.finds=[]; render(); }
});
render();
if ("serviceWorker" in navigator) navigator.serviceWorker.register("./sw.js").catch(()=>{});
