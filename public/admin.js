'use strict';
let TOKEN = localStorage.getItem('asap_admin_token') || '';
let current = null;      // current survey being edited
let questions = [];      // working copy
let COMPANIES = [];      // ASAP brand registry
let selectedCompany = 'legaltech';

const TYPES = {
  text:'نص قصير', textarea:'فقرة', number:'رقم', phone:'جوال', email:'بريد إلكتروني',
  single:'اختيار واحد', multi:'اختيارات متعددة', scale:'مقياس رقمي', section:'عنوان قسم'
};
const OPTION_TYPES = ['single','multi'];

function esc(s){return String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));}
function $(id){return document.getElementById(id);}

async function api(path, opts={}){
  opts.headers = Object.assign({'Authorization':'Bearer '+TOKEN}, opts.headers||{});
  const r = await fetch(path, opts);
  if(r.status===401){ logout(); throw new Error('انتهت الجلسة'); }
  return r;
}

let ME = null; // current user {email,name,role}

// ---------- auth ----------
async function login(){
  const p = $('pass').value; const email = $('loginEmail').value.trim();
  const r = await fetch('/api/admin/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email,password:p})});
  const j = await r.json();
  if(!r.ok){ $('loginErr').textContent = j.error||'خطأ'; return; }
  TOKEN = j.token; localStorage.setItem('asap_admin_token',TOKEN); ME = j.user||null;
  showApp();
}
function logout(){ TOKEN=''; localStorage.removeItem('asap_admin_token'); $('app').classList.add('hidden'); $('login').classList.remove('hidden'); }
async function showApp(){
  $('login').classList.add('hidden'); $('app').classList.remove('hidden');
  if(!COMPANIES.length){ try{ COMPANIES = await (await fetch('/api/companies')).json(); }catch(e){} }
  if(!ME){ try{ ME = await (await api('/api/admin/me')).json(); }catch(e){} }
  if(ME){ $('userBadge').textContent = (ME.name||ME.email) + (ME.role==='owner'?' — المالك':' — منشئ'); }
  $('usersBtn').style.display = (ME&&ME.role==='owner') ? '' : 'none';
  loadList();
}

// ---------- users management (owner) ----------
function showUsers(){
  $('listView').classList.add('hidden'); $('editView').classList.add('hidden'); $('usersView').classList.remove('hidden');
  loadUsers();
}
async function loadUsers(){
  const r=await api('/api/admin/users'); if(!r.ok){ alert('صلاحية غير كافية'); backToList(); return; }
  const users=await r.json();
  $('usersList').innerHTML = users.map(u=>`
    <div class="surveycard">
      <div class="meta">
        <div style="font-weight:800">${esc(u.name||u.email)} ${u.role==='owner'?'<span class="tag">المالك</span>':''} ${u.status==='invited'?'<span class="tag">بانتظار التفعيل</span>':''}</div>
        <small>${esc(u.email)} • ${u.surveys} استبيان</small>
      </div>
      <div class="row">
        ${u.status==='invited'?`<button class="btn btn-sm btn-ghost" onclick="reinvite(${u.id})">رابط الدعوة</button>`:''}
        ${u.role!=='owner'?`<button class="btn btn-sm btn-danger" onclick="delUser(${u.id},'${esc(u.email)}',${u.surveys})">حذف</button>`:''}
      </div>
    </div>`).join('');
}
async function inviteUser(){
  const email=$('inviteEmail').value.trim(), name=$('inviteName').value.trim();
  $('inviteErr').textContent='';
  const r=await api('/api/admin/users',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email,name})});
  const j=await r.json();
  if(!r.ok){ $('inviteErr').textContent=j.error; return; }
  $('inviteLink').value=j.invite_link; $('inviteResult').classList.remove('hidden');
  const res=$('inviteResult'); const msg=res.querySelector('.inv-status')||document.createElement('div');
  msg.className='inv-status'; msg.style.cssText='font-weight:700;margin-bottom:8px;color:'+(j.emailed?'#1a9d5a':'#8a6d00');
  msg.textContent = j.emailed ? '✅ تم إرسال الدعوة على بريده تلقائيًا. (يمكنك أيضًا نسخ الرابط)' : 'ℹ️ لم يُفعّل الإرسال التلقائي — انسخ الرابط وأرسله يدويًا:';
  if(!res.querySelector('.inv-status')) res.insertBefore(msg, res.firstChild);
  $('inviteEmail').value=''; $('inviteName').value=''; loadUsers();
}
function copyInvite(){ const el=$('inviteLink'); navigator.clipboard.writeText(el.value); alert('تم نسخ رابط الدعوة'); }
async function reinvite(id){
  const r=await api('/api/admin/users/'+id+'/invite',{method:'POST'}); const j=await r.json();
  if(!r.ok){ alert(j.error); return; }
  $('inviteLink').value=j.invite_link; $('inviteResult').classList.remove('hidden');
  $('inviteResult').scrollIntoView({behavior:'smooth'});
}
async function delUser(id,email,surveys){
  if(!confirm('حذف الحساب ('+email+')؟'+(surveys>0?'\nتنبيه: له '+surveys+' استبيان ستبقى لكن بدون مالك.':''))) return;
  const r=await api('/api/admin/users/'+id,{method:'DELETE'}); const j=await r.json();
  if(!r.ok){ alert(j.error); return; } loadUsers();
}

function renderCompanyGrid(){
  const el=$('companyGrid'); if(!el) return;
  el.innerHTML = COMPANIES.map(c=>`
    <div class="compcard ${c.key===selectedCompany?'sel':''}" data-key="${c.key}" onclick="pickCompany('${c.key}')">
      <img src="${c.logo}" alt="${esc(c.name)}">
      <span class="cdot" style="background:${c.color_primary}"></span>
      <span class="cname">${esc(c.name)}</span>
    </div>`).join('');
}
function pickCompany(key){
  const c = COMPANIES.find(x=>x.key===key); if(!c) return;
  selectedCompany = key;
  $('f_cp').value = c.color_primary; $('f_ca').value = c.color_accent;
  $('f_logo').value = c.logo; updateLogoPrev();
  renderCompanyGrid();
}

function showPassword(){ $('pwModal').classList.remove('hidden'); $('newPass').value=''; $('pwErr').textContent=''; }
async function savePassword(){
  const r = await api('/api/admin/password',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({password:$('newPass').value})});
  const j = await r.json();
  if(!r.ok){ $('pwErr').textContent=j.error; return; }
  $('pwModal').classList.add('hidden'); alert('تم تغيير كلمة المرور');
}

// ---------- list ----------
async function loadList(){
  $('listView').classList.remove('hidden'); $('editView').classList.add('hidden');
  const uv=$('usersView'); if(uv) uv.classList.add('hidden');
  const r = await api('/api/admin/surveys'); const list = await r.json();
  const el = $('slist');
  if(!list.length){ el.innerHTML='<div class="card note">لا توجد استبيانات بعد. أنشئ أول استبيان.</div>'; return; }
  el.innerHTML = list.map(s=>`
    <div class="surveycard">
      <div class="meta">
        <div style="font-weight:800;font-size:16px">${esc(s.title)} ${s.published?'':'<span class="tag">مسودة</span>'}</div>
        <small>
          <span class="swatch" style="background:${esc(s.color_primary)}"></span>
          <span class="swatch" style="background:${esc(s.color_accent)}"></span>
          &nbsp; الرابط: <a href="/s/${esc(s.slug)}" target="_blank">/s/${esc(s.slug)}</a>
          &nbsp;•&nbsp; ${s.responses} رد
          ${(ME&&ME.role==='owner'&&s.owner_email)?`&nbsp;•&nbsp; <span style="color:#888">${esc(s.owner_email)}</span>`:''}
          &nbsp; <span class="link-copy" onclick="copyLink('${esc(s.slug)}')">نسخ الرابط</span>
        </small>
      </div>
      <div class="row">
        <button class="btn btn-sm btn-accent" onclick="exportDirect(${s.id})">Excel ⬇</button>
        <button class="btn btn-sm" onclick="openSurvey(${s.id})">تحرير</button>
      </div>
    </div>`).join('');
}
function copyLink(slug){ navigator.clipboard.writeText(location.origin+'/s/'+slug); alert('تم نسخ الرابط:\n'+location.origin+'/s/'+slug); }

async function newSurvey(){
  const r = await api('/api/admin/surveys',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({title:'استبيان جديد',color_primary:'#7B2E8E',color_accent:'#29ABE2'})});
  const s = await r.json(); openSurvey(s.id);
}

// ---------- editor ----------
async function openSurvey(id){
  const r = await api('/api/admin/surveys/'+id); current = await r.json();
  questions = current.questions.map(q=>({...q}));
  $('listView').classList.add('hidden'); const uv=$('usersView'); if(uv)uv.classList.add('hidden'); $('editView').classList.remove('hidden');
  $('f_title').value=current.title||''; $('f_slug').value=current.slug||'';
  $('f_hero').value=current.hero_title||''; $('f_intro').value=current.intro||'';
  $('f_cp').value=current.color_primary||'#7B2E8E'; $('f_ca').value=current.color_accent||'#29ABE2';
  $('f_logo').value=current.logo||''; $('f_thanks').value=current.thanks||'';
  $('f_pub').checked=!!current.published;
  selectedCompany = current.company || 'legaltech';
  renderCompanyGrid();
  updateLogoPrev(); updateOpenLink(); renderQuestions(); loadResponses(); loadOwners();
}

// ---------- survey co-owners ----------
async function loadOwners(){
  const el=$('ownersList'); if(!el) return;
  const r=await api('/api/admin/surveys/'+current.id+'/owners');
  if(!r.ok){ el.innerHTML=''; return; }
  const d=await r.json();
  let html='';
  if(d.primary){
    html+=`<div class="surveycard" style="padding:10px 14px"><div class="meta"><b>${esc(d.primary.name||d.primary.email)}</b> <span class="tag">المالك الأساسي</span><br><small>${esc(d.primary.email)}</small></div></div>`;
  }
  d.coOwners.forEach(u=>{
    html+=`<div class="surveycard" style="padding:10px 14px"><div class="meta"><b>${esc(u.name||u.email)}</b> ${u.status==='invited'?'<span class="tag">بانتظار التفعيل</span>':'<span class="tag">مدير</span>'}<br><small>${esc(u.email)}</small></div>
      <button class="btn btn-sm btn-danger" onclick="removeOwner(${u.id})">إزالة</button></div>`;
  });
  el.innerHTML=html;
}
async function addOwner(){
  const email=$('coEmail').value.trim(); $('ownerErr').textContent=''; $('ownerInvite').classList.add('hidden');
  const r=await api('/api/admin/surveys/'+current.id+'/owners',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email})});
  const j=await r.json();
  if(!r.ok){ $('ownerErr').textContent=j.error; return; }
  $('coEmail').value='';
  if(j.isNew){
    $('ownerInviteMsg').textContent = j.emailed ? 'حساب جديد — أُرسلت الدعوة على بريده. (يمكنك أيضًا نسخ الرابط)' : 'حساب جديد — انسخ رابط الدعوة وأرسله له:';
    $('ownerInviteLink').value=j.invite_link; $('ownerInvite').classList.remove('hidden');
  }
  loadOwners();
}
async function removeOwner(uid){
  if(!confirm('إزالة هذا المدير من الاستبيان؟'))return;
  await api('/api/admin/surveys/'+current.id+'/owners/'+uid,{method:'DELETE'});
  loadOwners();
}
function copyOwnerInvite(){ navigator.clipboard.writeText($('ownerInviteLink').value); alert('تم نسخ رابط الدعوة'); }
function backToList(){ loadList(); }
function updateOpenLink(){ $('openLink').href='/s/'+($('f_slug').value||current.slug); }
function updateLogoPrev(){ const v=$('f_logo').value; const p=$('logoPrev'); if(v){p.src=v;p.style.display='block';}else p.style.display='none'; }
$('f_logo')?.addEventListener('input',updateLogoPrev);
$('f_slug')?.addEventListener('input',updateOpenLink);

async function uploadLogo(input){
  const f = input.files[0]; if(!f) return;
  const buf = await f.arrayBuffer();
  const r = await api('/api/admin/upload',{method:'POST',headers:{'Content-Type':f.type},body:buf});
  const j = await r.json(); $('f_logo').value=j.url; updateLogoPrev();
}

// ---------- questions builder ----------
function addQ(type){
  questions.push({label: type==='section'?'عنوان قسم':'سؤال جديد', help:'', type, required:false, options: OPTION_TYPES.includes(type)?['خيار 1']:[], max_select:0, scale_min:1, scale_max:5});
  renderQuestions();
  setTimeout(()=>{ const els=document.querySelectorAll('.qcard'); els[els.length-1]?.scrollIntoView({behavior:'smooth',block:'center'}); },50);
}
function delQ(i){ questions.splice(i,1); renderQuestions(); }
function moveQ(i,dir){ const j=i+dir; if(j<0||j>=questions.length)return; [questions[i],questions[j]]=[questions[j],questions[i]]; renderQuestions(); }

function renderQuestions(){
  const el=$('qlist');
  el.innerHTML = questions.map((q,i)=>qCard(q,i)).join('');
}
function qCard(q,i){
  const typeSel = Object.entries(TYPES).map(([k,v])=>`<option value="${k}" ${q.type===k?'selected':''}>${v}</option>`).join('');
  let body='';
  if(q.type==='section'){
    body=`<input placeholder="نص المساعدة (اختياري)" value="${esc(q.help)}" oninput="upd(${i},'help',this.value)">`;
  } else {
    body=`<input placeholder="نص المساعدة (اختياري)" value="${esc(q.help)}" oninput="upd(${i},'help',this.value)">`;
    if(OPTION_TYPES.includes(q.type)){
      body+=`<div class="opts" style="margin-top:8px">`+
        (q.options||[]).map((o,oi)=>`<div class="row" style="gap:6px"><input class="flex1" value="${esc(o)}" oninput="updOpt(${i},${oi},this.value)"><button class="btn btn-sm btn-danger" onclick="delOpt(${i},${oi})">×</button></div>`).join('')+
        `<button class="btn btn-sm btn-ghost" style="margin-top:6px" onclick="addOpt(${i})">+ خيار</button></div>`;
    }
    if(q.type==='multi'){
      body+=`<label class="row mini" style="margin-top:8px;gap:6px">الحد الأقصى للاختيارات (0 = بلا حد): <input type="number" min="0" style="width:80px" value="${q.max_select||0}" oninput="upd(${i},'max_select',+this.value)"></label>`;
    }
    if(q.type==='scale'){
      body+=`<div class="row mini" style="margin-top:8px;gap:10px">من <input type="number" style="width:70px" value="${q.scale_min}" oninput="upd(${i},'scale_min',+this.value)"> إلى <input type="number" style="width:70px" value="${q.scale_max}" oninput="upd(${i},'scale_max',+this.value)"></div>`;
    }
  }
  const reqBox = q.type==='section' ? '' :
    `<label class="row mini" style="gap:5px;margin:0"><input type="checkbox" ${q.required?'checked':''} onchange="upd(${i},'required',this.checked)"> مطلوب</label>`;
  return `<div class="qcard ${q.type==='section'?'section':''}">
    <div class="qtop">
      <span class="drag">⠿</span>
      <input class="flex1" value="${esc(q.label)}" oninput="upd(${i},'label',this.value)" placeholder="${q.type==='section'?'عنوان القسم':'نص السؤال'}">
      <select onchange="changeType(${i},this.value)">${typeSel}</select>
      ${reqBox}
    </div>
    ${body}
    <div class="row" style="margin-top:8px;gap:6px">
      <button class="btn btn-sm btn-ghost" onclick="moveQ(${i},-1)">▲</button>
      <button class="btn btn-sm btn-ghost" onclick="moveQ(${i},1)">▼</button>
      <button class="btn btn-sm btn-danger" onclick="delQ(${i})">حذف</button>
    </div>
  </div>`;
}
function upd(i,k,v){ questions[i][k]=v; }
function changeType(i,t){ questions[i].type=t; if(OPTION_TYPES.includes(t)&&(!questions[i].options||!questions[i].options.length)) questions[i].options=['خيار 1']; renderQuestions(); }
function addOpt(i){ questions[i].options.push('خيار '+(questions[i].options.length+1)); renderQuestions(); }
function updOpt(i,oi,v){ questions[i].options[oi]=v; }
function delOpt(i,oi){ questions[i].options.splice(oi,1); renderQuestions(); }

// ---------- save ----------
async function saveSurvey(){
  const payload={
    title:$('f_title').value, slug:$('f_slug').value, hero_title:$('f_hero').value,
    intro:$('f_intro').value, color_primary:$('f_cp').value, color_accent:$('f_ca').value,
    logo:$('f_logo').value, thanks:$('f_thanks').value, published:$('f_pub').checked,
    company:selectedCompany, questions
  };
  const r=await api('/api/admin/surveys/'+current.id,{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});
  const j=await r.json();
  if(!r.ok){ alert(j.error||'خطأ في الحفظ'); return; }
  current=j; questions=j.questions.map(q=>({...q})); $('f_slug').value=j.slug; updateOpenLink();
  const m=$('saveMsg'); m.textContent='تم الحفظ ✓'; m.classList.remove('hidden');
  setTimeout(()=>m.classList.add('hidden'),2000);
}
async function deleteSurvey(){
  if(!confirm('سيتم حذف الاستبيان وكل ردوده نهائيًا. متأكد؟'))return;
  await api('/api/admin/surveys/'+current.id,{method:'DELETE'}); loadList();
}

// ---------- responses ----------
async function loadResponses(){
  const r=await api('/api/admin/surveys/'+current.id+'/responses'); const rows=await r.json();
  $('respCount').textContent=rows.length;
  const qs=questions.filter(q=>q.type!=='section');
  if(!rows.length){ $('respWrap').innerHTML='<div class="note" style="padding:16px">لا توجد ردود بعد.</div>'; return; }
  let html='<table><thead><tr><th>#</th><th>التاريخ</th>'+qs.map(q=>`<th>${esc(q.label)}</th>`).join('')+'</tr></thead><tbody>';
  rows.forEach((row,idx)=>{
    html+=`<tr><td>${rows.length-idx}</td><td>${esc(row.created_at)}</td>`;
    qs.forEach(q=>{ let v=row.data[q.id]; if(Array.isArray(v))v=v.join('، '); html+=`<td>${esc(v??'')}</td>`; });
    html+='</tr>';
  });
  html+='</tbody></table>'; $('respWrap').innerHTML=html;
}
function exportXlsx(){ downloadExport(current.id); }
function exportDirect(id){ downloadExport(id); }
async function downloadExport(id){
  const r=await api('/api/admin/surveys/'+id+'/export');
  if(!r.ok){ alert('تعذر التصدير'); return; }
  const blob=await r.blob(); const a=document.createElement('a');
  a.href=URL.createObjectURL(blob); a.download='survey-'+id+'-responses.xlsx';
  document.body.appendChild(a); a.click(); a.remove();
}

// ---------- init ----------
if(TOKEN){ // verify token still valid
  api('/api/admin/surveys').then(r=>{ if(r.ok) showApp(); else logout(); }).catch(()=>logout());
}
$('pass')?.addEventListener('keydown',e=>{if(e.key==='Enter')login();});
