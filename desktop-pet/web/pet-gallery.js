(function(){
  const SKIN_KEY='hermes-pet-skin';
  const state={
    tab:'installed',
    query:'',
    offset:0,
    limit:12,
    activeSkinId:localStorage.getItem(SKIN_KEY)||'keeper',
    installed:[],
    gallery:null,
    busySlug:'',
    loadingInstalled:false,
    loadingGallery:false
  };
  const els={
    refresh:document.getElementById('refreshButton'),
    installedTab:document.getElementById('installedTab'),
    galleryTab:document.getElementById('galleryTab'),
    search:document.getElementById('searchInput'),
    status:document.getElementById('statusLine'),
    installedPanel:document.getElementById('installedPanel'),
    galleryPanel:document.getElementById('galleryPanel'),
    installedCount:document.getElementById('installedCount'),
    galleryCount:document.getElementById('galleryCount'),
    installedGrid:document.getElementById('installedGrid'),
    galleryGrid:document.getElementById('galleryGrid'),
    prev:document.getElementById('prevButton'),
    next:document.getElementById('nextButton'),
    pageStatus:document.getElementById('pageStatus')
  };

  function text(value){return String(value||'');}
  function clean(value){return text(value).replace(/\s+/g,' ').trim();}
  function setStatus(message,kind){
    els.status.textContent=message||'';
    els.status.className=`status-line${kind?` is-${kind}`:''}`;
  }
  function create(tag,className,content){
    const node=document.createElement(tag);
    if(className) node.className=className;
    if(content!==undefined) node.textContent=content;
    return node;
  }
  function button(label,className,handler,disabled){
    const node=create('button',className,label);
    node.type='button';
    node.disabled=Boolean(disabled);
    node.addEventListener('click',handler);
    return node;
  }
  async function fetchJson(url,options){
    const response=await fetch(url,options);
    let body=null;
    try{body=await response.json();}catch(_){}
    if(!response.ok||body&&body.ok===false){
      const message=body&&body.message||body&&body.error||`Request failed: ${response.status}`;
      const error=new Error(message);
      error.body=body;
      throw error;
    }
    return body||{};
  }
  function normalizeLayout(layout){
    const columns=Number(layout&&layout.columns)||8;
    const rows=Number(layout&&layout.rows)||9;
    const states=Array.isArray(layout&&layout.states)?layout.states:[];
    const idle=states.find((item)=>item&&item.name==='idle');
    const frames=Number(idle&&idle.frames)||6;
    return {columns:Math.max(1,columns),rows:Math.max(1,rows),frames:Math.max(1,frames),states};
  }
  function previewFrames(layout){
    const safe=normalizeLayout(layout);
    if(safe.states.length){
      const frames=[];
      for(const state of safe.states){
        const row=Math.max(0,Math.min(safe.rows-1,Number(state&&state.row)||0));
        const count=Math.max(1,Math.min(safe.columns,Number(state&&state.frames)||safe.frames));
        for(let col=0;col<count;col++) frames.push({col,row});
      }
      if(frames.length) return {columns:safe.columns,rows:safe.rows,frames};
    }
    const frames=[];
    const count=Math.max(1,Math.min(safe.columns,safe.frames));
    for(let col=0;col<count;col++) frames.push({col,row:0});
    return {columns:safe.columns,rows:safe.rows,frames};
  }
  function setPreviewFrame(sprite,index){
    const data=sprite&&sprite.__petPreview;
    if(!data||!data.frames.length) return;
    const frame=data.frames[index%data.frames.length];
    const x=data.columns>1?(frame.col/(data.columns-1))*100:0;
    const y=data.rows>1?(frame.row/(data.rows-1))*100:0;
    sprite.style.backgroundPosition=`${x}% ${y}%`;
  }
  function spritePreview(url,layout){
    const preview=create('div','pet-preview');
    if(!url){
      preview.append(create('span','pet-preview-empty','No preview'));
      return preview;
    }
    const safeLayout=normalizeLayout(layout);
    const frameData=previewFrames(layout);
    const sprite=create('div','pet-preview-sprite');
    sprite.style.backgroundSize=`${safeLayout.columns*100}% ${safeLayout.rows*100}%`;
    sprite.__petPreview=frameData;
    const loading=create('span','pet-preview-loading','Loading');
    preview.append(sprite,loading);
    const image=new Image();
    image.decoding='async';
    image.onload=()=>{
      sprite.style.backgroundImage=`url("${url.replace(/"/g,'%22')}")`;
      sprite.classList.add('is-loaded');
      preview.classList.add('is-loaded');
      setPreviewFrame(sprite,0);
    };
    image.onerror=()=>{
      preview.classList.add('is-error');
      loading.textContent='No preview';
    };
    image.src=url;
    return preview;
  }
  function skinPreview(skin){
    return spritePreview(clean(skin&&skin.spritesheetUrl),skin&&skin.layout);
  }
  function galleryPreview(pet){
    if(pet&&pet.installedSkin) return skinPreview(pet.installedSkin);
    return spritePreview(clean(pet&&pet.previewUrl||pet&&pet.spritesheetUrl),{columns:8,rows:9,states:[{name:'idle',frames:6}]});
  }
  function setTab(tab){
    state.tab=tab==='gallery'?'gallery':'installed';
    els.installedTab.classList.toggle('is-active',state.tab==='installed');
    els.galleryTab.classList.toggle('is-active',state.tab==='gallery');
    els.installedTab.setAttribute('aria-selected',state.tab==='installed'?'true':'false');
    els.galleryTab.setAttribute('aria-selected',state.tab==='gallery'?'true':'false');
    els.installedPanel.classList.toggle('is-active',state.tab==='installed');
    els.galleryPanel.classList.toggle('is-active',state.tab==='gallery');
    if(state.tab==='gallery'&&!state.gallery) loadGallery().catch(reportError);
    render();
  }
  async function notifySkinChange(skinId){
    try{
      await fetchJson('/api/pet/skin_selection',{
        method:'POST',
        headers:{'Content-Type':'application/json'},
        body:JSON.stringify({skin_id:skinId})
      });
    }catch(error){
      console.warn('Failed to post pet skin selection',error);
    }
    try{
      const tauri=window.__TAURI__;
      if(tauri&&tauri.event&&typeof tauri.event.emit==='function'){
        await tauri.event.emit('pet-skin-change',skinId);
      }
    }catch(error){
      console.warn('Failed to notify pet skin change',error);
    }
  }
  async function useSkin(skinId){
    if(!skinId) return;
    state.activeSkinId=skinId;
    try{localStorage.setItem(SKIN_KEY,skinId);}catch(_){}
    render();
    try{
      await notifySkinChange(skinId);
      setStatus('Skin applied to Desktop Companion.','ok');
    }catch(error){
      reportError(error);
    }
  }
  function installedMatches(skin){
    if(!state.query) return true;
    const query=state.query.toLowerCase();
    return [skin.id,skin.displayName,skin.description,skin.source,skin.hermesPetSlug].some((value)=>text(value).toLowerCase().includes(query));
  }
  function skinSourceLabel(skin){
    if(skin.source==='hermes-pets') return 'Hermes pet';
    return 'Bundled';
  }
  function renderInstalled(){
    els.installedGrid.replaceChildren();
    const skins=state.installed.filter(installedMatches);
    els.installedCount.textContent=state.loadingInstalled?'Loading skins...':`${skins.length} shown, ${state.installed.length} installed`;
    if(!skins.length){
      els.installedGrid.append(create('div','empty-state',state.loadingInstalled?'Loading installed skins...':'No installed skins match this search.'));
      return;
    }
    for(const skin of skins){
      const active=skin.id===state.activeSkinId;
      const card=create('article',`pet-card${active?' is-active':''}`);
      card.append(skinPreview(skin));
      const body=create('div','pet-body');
      const titleRow=create('div','pet-title-row');
      titleRow.append(create('h3','pet-title',skin.displayName||skin.id));
      titleRow.append(create('span',`pet-badge${active?' is-active':''}`,active?'Active':skinSourceLabel(skin)));
      const meta=create('div','pet-meta');
      meta.append(create('span','',skin.id));
      if(skin.hermesPetSlug) meta.append(create('span','',skin.hermesPetSlug));
      const description=create('p','pet-description',skin.description||'Ready to use in Desktop Companion.');
      const actions=create('div','pet-actions');
      actions.append(button(active?'Using':'Use','primary-button',()=>useSkin(skin.id),active));
      if(skin.source==='hermes-pets'&&skin.hermesPetSlug){
        actions.append(button('Remove','danger-button',()=>removePet(skin.hermesPetSlug),state.busySlug===skin.hermesPetSlug));
      }
      body.append(titleRow,meta,description,actions);
      card.append(body);
      els.installedGrid.append(card);
    }
  }
  function renderGallery(){
    els.galleryGrid.replaceChildren();
    const gallery=state.gallery;
    const total=gallery&&Number(gallery.total)||0;
    const end=Math.min(total,state.offset+state.limit);
    els.galleryCount.textContent=state.loadingGallery?'Loading gallery...':(gallery?`${total} results from ${gallery.manifestTotal||total} pets`:'Search or browse installable pets.');
    els.pageStatus.textContent=gallery&&total?`${state.offset+1}-${end} of ${total}`:'';
    els.prev.disabled=state.loadingGallery||state.offset<=0;
    els.next.disabled=state.loadingGallery||!gallery||state.offset+state.limit>=total;
    if(state.loadingGallery&&!gallery){
      els.galleryGrid.append(create('div','empty-state','Loading Petdex gallery...'));
      return;
    }
    const pets=gallery&&Array.isArray(gallery.pets)?gallery.pets:[];
    if(!pets.length){
      els.galleryGrid.append(create('div','empty-state',state.query?'No gallery pets match this search.':'No gallery pets loaded.'));
      return;
    }
    for(const pet of pets){
      const busy=state.busySlug===pet.slug;
      const supported=pet.compatibility==='supported';
      const unsupported=pet.compatibility==='unsupported';
      const active=supported&&pet.skinId===state.activeSkinId;
      const card=create('article',`pet-card${active?' is-active':''}${busy?' is-busy':''}`);
      card.append(galleryPreview(pet));
      const body=create('div','pet-body');
      const titleRow=create('div','pet-title-row');
      titleRow.append(create('h3','pet-title',pet.displayName||pet.slug));
      titleRow.append(create('span',`pet-badge${active?' is-active':''}${unsupported?' is-warning':''}`,active?'Active':(unsupported?'Unsupported':(pet.installed?'Installed':'Petdex'))));
      const meta=create('div','pet-meta');
      meta.append(create('span','',pet.slug));
      if(pet.kind) meta.append(create('span','',pet.kind));
      if(pet.submittedBy) meta.append(create('span','',`by ${pet.submittedBy}`));
      const description=create('p','pet-description',unsupported
        ? 'Installed, but this spritesheet is not supported by the current Desktop Companion renderer.'
        : (supported ? 'Installed and ready to use in Desktop Companion.' : 'Install into the Hermes pet store, then use it as a Desktop Companion skin.'));
      const actions=create('div','pet-actions');
      if(supported){
        actions.append(button(active?'Using':'Use','primary-button',()=>useSkin(pet.skinId),active||busy));
        actions.append(button('Remove','danger-button',()=>removePet(pet.slug),busy));
      }else if(pet.installed&&unsupported){
        actions.append(button('Remove','danger-button',()=>removePet(pet.slug),busy));
      }else{
        actions.append(button(busy?'Installing...':'Install','primary-button',()=>installPet(pet.slug),busy));
      }
      body.append(titleRow,meta,description,actions);
      card.append(body);
      els.galleryGrid.append(card);
    }
  }
  function render(){
    renderInstalled();
    renderGallery();
  }
  async function loadInstalled(){
    state.loadingInstalled=true;
    renderInstalled();
    const data=await fetchJson('/api/pet/skins',{cache:'no-store'});
    state.installed=Array.isArray(data.skins)?data.skins:[];
    state.loadingInstalled=false;
    renderInstalled();
  }
  async function loadGallery(){
    state.loadingGallery=true;
    renderGallery();
    const params=new URLSearchParams();
    if(state.query) params.set('q',state.query);
    params.set('offset',String(state.offset));
    params.set('limit',String(state.limit));
    state.gallery=await fetchJson(`/api/pet/gallery?${params.toString()}`,{cache:'no-store'});
    state.loadingGallery=false;
    renderGallery();
  }
  async function reloadAll(){
    setStatus('Refreshing pets...');
    try{
      await loadInstalled();
      if(state.tab==='gallery'||state.gallery) await loadGallery();
      setStatus('Pet data refreshed.','ok');
    }catch(error){
      reportError(error);
    }finally{
      state.loadingInstalled=false;
      state.loadingGallery=false;
      render();
    }
  }
  async function installPet(slug){
    state.busySlug=slug;
    setStatus(`Installing ${slug}...`);
    render();
    try{
      const result=await fetchJson('/api/pet/gallery/install',{
        method:'POST',
        headers:{'Content-Type':'application/json'},
        body:JSON.stringify({slug})
      });
      await loadInstalled();
      await loadGallery();
      if(result.supported){
        setStatus(`${slug} installed. Click Use to apply it.`, 'ok');
      }else{
        setStatus(`${slug} installed, but this renderer cannot use its spritesheet yet.`, 'error');
      }
    }catch(error){
      reportError(error);
    }finally{
      state.busySlug='';
      render();
    }
  }
  async function removePet(slug){
    if(!slug) return;
    if(!window.confirm(`Remove ${slug} from installed Hermes pets?`)) return;
    state.busySlug=slug;
    setStatus(`Removing ${slug}...`);
    render();
    try{
      await fetchJson('/api/pet/gallery/remove',{
        method:'POST',
        headers:{'Content-Type':'application/json'},
        body:JSON.stringify({slug})
      });
      if(state.activeSkinId===`hermes-${slug}`) await useSkin('keeper');
      await loadInstalled();
      if(state.gallery) await loadGallery();
      setStatus(`${slug} removed.`, 'ok');
    }catch(error){
      reportError(error);
    }finally{
      state.busySlug='';
      render();
    }
  }
  function reportError(error){
    console.error(error);
    setStatus(error&&error.message?error.message:'Pet manager failed.','error');
  }
  let searchTimer=0;
  els.installedTab.addEventListener('click',()=>setTab('installed'));
  els.galleryTab.addEventListener('click',()=>setTab('gallery'));
  els.refresh.addEventListener('click',()=>reloadAll());
  els.prev.addEventListener('click',()=>{
    state.offset=Math.max(0,state.offset-state.limit);
    loadGallery().catch(reportError);
  });
  els.next.addEventListener('click',()=>{
    state.offset+=state.limit;
    loadGallery().catch(reportError);
  });
  els.search.addEventListener('input',()=>{
    state.query=clean(els.search.value);
    state.offset=0;
    renderInstalled();
    clearTimeout(searchTimer);
    if(state.tab==='gallery'||state.gallery){
      searchTimer=setTimeout(()=>loadGallery().catch(reportError),180);
    }
  });
  window.addEventListener('storage',(event)=>{
    if(event.key!==SKIN_KEY) return;
    state.activeSkinId=localStorage.getItem(SKIN_KEY)||state.activeSkinId;
    render();
  });
  setInterval(()=>{
    const tick=Math.floor(Date.now()/320);
    document.querySelectorAll('.pet-preview-sprite.is-loaded').forEach((sprite,index)=>{
      setPreviewFrame(sprite,tick+index);
    });
  },320);
  loadInstalled().then(()=>setStatus('Ready.')).catch(reportError);
})();
