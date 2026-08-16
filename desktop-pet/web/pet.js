(function(){
  const DISMISSED_KEY='hermes-pet-dismissed';
  const COLLAPSED_KEY='hermes-pet-collapsed';
  const COLLAPSE_EXPLICIT_KEY='hermes-pet-collapsed-explicit';
  const SESSION_VIEWED_COUNTS_KEY='hermes-session-viewed-counts';
  const SESSION_COMPLETION_UNREAD_KEY='hermes-session-completion-unread';
  const SKIN_KEY='hermes-pet-skin';
  const PET_SIZE_KEY='hermes-pet-size';
  const PET_SIZE_CHANGE_EVENT='pet-size-change';
  const RESTART_POSITION_KEY='hermes-pet-restart-position';
  const PET_NATIVE_RESTART_REQUESTED_EVENT='pet-native-restart-requested';
  const PET_PERMISSION_TOGGLE_EVENT='pet-permission-toggle';
  const POLL_MS=1000;
  const FRAME_MS=520;
  const PET_DISPLAY_SCALE=2/3;
  const DRAG_CLICK_SUPPRESS_PX=4;
  const DRAG_CLICK_SUPPRESS_MS=450;
  const DRAG_HEAD_RATIO=0.7;
  const PET_BADGE_FIXED={right:16,top:14,size:26,gap:-24,hitPad:8};
  let currentPetDisplaySize={width:128,height:139};
  let currentPetWindowSize={width:146,height:139};
  let currentPetScale=(()=>{const n=Number(localStorage.getItem(PET_SIZE_KEY));return Number.isFinite(n)&&n>=50&&n<=200?Math.round(n):100;})();
  let pendingPetSize=null;
  let petLayoutFrameId=0;
  let dragLayoutPoll=0;
  let dragLastMoveAt=0;
  let dragStartedAt=0;
  let latestPetMonitor=null;
  const DEFAULT_PET_LAYOUT={columns:8,rows:9,frameWidth:192,frameHeight:208,states:[{name:'idle',row:0,frames:6},{name:'running-right',row:1,frames:8},{name:'running-left',row:2,frames:8},{name:'waving',row:3,frames:4},{name:'jumping',row:4,frames:5},{name:'failed',row:5,frames:8},{name:'waiting',row:6,frames:6},{name:'running',row:7,frames:6},{name:'review',row:8,frames:6}]};
  const shell=document.getElementById('petShell');
  const badge=document.getElementById('petBadge');
  const stage=document.getElementById('petStage');
  const sprite=document.getElementById('petSprite');
  let state='idle', frame=0, sessions=[], dismissed=_readJson(DISMISSED_KEY,{});
  let petSkins=[{id:'keeper',displayName:'May',spritesheetUrl:'/extensions/pets/keeper/spritesheet.webp',layout:DEFAULT_PET_LAYOUT}];
  let activeSkinId=localStorage.getItem(SKIN_KEY)||'keeper';
  let lastSkinSelectionAt=0;
  let petPreferences={enabled:true,allow_direct_send:false,allow_inline_action_responses:false};
  let _isDragging=false;
  let dragAnimUntil=0;
  let dragLastScreenX=null;
  let dragStartScreenX=null;
  const INTERACT_ANIM_HOLD_MS=1500;
  let dragStartPoint=null;
  let suppressStageClickUntil=0;
  let celebrateUntil=0;
  let wasReady=null;      // null=首帧未初始化（启动时不因既有 ready 触发庆祝）
  let attentionBooted=false;  // refresh 首次成功后才允许边沿检测（防 storage 事件竞态提前置位）

  const I18N_FALLBACKS={
    desktop_pet_close:'Close pet',
    desktop_pet_collapse_updates:'Collapse updates',
    desktop_pet_permission_allow_direct_send:'Direct send',
    desktop_pet_permission_allow_inline_actions:'Approval / clarify responses',
    desktop_pet_permissions_control:'Permission control',
    desktop_pet_expand_updates:'Expand updates',
    desktop_pet_manage_pets:'Manage pets...',
    desktop_pet_restart:'Restart pet',
    desktop_pet_shell_label:'{0} desktop pet',
    desktop_pet_switch_skin:'Switch skin',
    desktop_pet_title:'Hermes Pet'
  };
  function _formatFallback(value,args){return String(value).replace(/\{(\d+)\}/g,(_,idx)=>String(args[Number(idx)]??''));}
  function _petT(key,...args){return typeof t==='function'?t(key,...args):_formatFallback(I18N_FALLBACKS[key]||key,args);}
  function _readJson(key,fallback){try{const parsed=JSON.parse(localStorage.getItem(key)||'null');return parsed&&typeof parsed==='object'?parsed:fallback;}catch(_){return fallback;}}
  function _writeJson(key,value){try{localStorage.setItem(key,JSON.stringify(value));}catch(_){}}
  function _clean(value){return String(value||'').replace(/\s+/g,' ').trim();}
  function _normalizePreferences(value){const source=value&&typeof value==='object'?value:{};return {enabled:typeof source.enabled==='boolean'?source.enabled:true,allow_direct_send:typeof source.allow_direct_send==='boolean'?source.allow_direct_send:false,allow_inline_action_responses:typeof source.allow_inline_action_responses==='boolean'?source.allow_inline_action_responses:false};}
  function _csrfHeaders(){
    const token=window.__HERMES_CONFIG__&&window.__HERMES_CONFIG__.csrfToken;
    return token?{'X-Hermes-CSRF-Token':token}:{};
  }
  async function _registerDesktopPetProcess(){
    const params=new URLSearchParams(location.search||'');
    const pid=Number(params.get('desktop_pet_pid')||0);
    if(!Number.isInteger(pid)||pid<=0) return false;
    try{
      const res=await fetch('/api/pet/register',{method:'POST',credentials:'include',headers:{'Content-Type':'application/json',..._csrfHeaders()},body:JSON.stringify({pid,base_url:location.origin})});
      return res.ok;
    }catch(_){return false;}
  }
  async function _loadPreferences(){
    try{
      const data=await fetch('/api/pet/preference',{cache:'no-store'}).then(res=>{if(!res.ok) throw new Error(`Pet preferences failed: ${res.status}`);return res.json();});
      petPreferences=_normalizePreferences(data);
    }catch(err){console.warn('Failed to load pet preferences',err);}
    return petPreferences;
  }
  async function _setPreferences(patch){
    const data=await fetch('/api/pet/preference',{method:'POST',credentials:'include',headers:{'Content-Type':'application/json',..._csrfHeaders()},body:JSON.stringify(patch||{})}).then(res=>{if(!res.ok) throw new Error(`Pet preference update failed: ${res.status}`);return res.json();});
    petPreferences=_normalizePreferences(data);
    return petPreferences;
  }

  function _localizeStaticLabels(){
    if(typeof applyLocaleToDOM==='function') applyLocaleToDOM();
    document.title=_petT('desktop_pet_title');
    badge.setAttribute('aria-label',_petT('desktop_pet_expand_updates'));
  }
  function _normalizeSkinLayout(layout){
    if(!layout||typeof layout!=='object') return DEFAULT_PET_LAYOUT;
    const columns=Number(layout.columns),rows=Number(layout.rows),frameWidth=Number(layout.frameWidth),frameHeight=Number(layout.frameHeight);
    const states=Array.isArray(layout.states)?layout.states.map(item=>({name:String(item&&item.name||'').trim(),row:Number(item&&item.row),frames:Number(item&&item.frames)})).filter(item=>/^[A-Za-z0-9_-]+$/.test(item.name)&&Number.isInteger(item.row)&&Number.isInteger(item.frames)):[];
    const required=DEFAULT_PET_LAYOUT.states.map(item=>item.name);
    if(!Number.isInteger(columns)||!Number.isInteger(rows)||!Number.isInteger(frameWidth)||!Number.isInteger(frameHeight)||columns<1||rows<1||frameWidth<1||frameHeight<1) return DEFAULT_PET_LAYOUT;
    if(!required.every(name=>states.some(item=>item.name===name))) return DEFAULT_PET_LAYOUT;
    return {columns,rows,frameWidth,frameHeight,states};
  }
  function _safeSkin(skin){
    if(!skin||typeof skin!=='object') return null;
    const id=String(skin.id||'').trim();
    const displayName=String(skin.displayName||id).trim()||id;
    const spritesheetUrl=String(skin.spritesheetUrl||'').trim();
    if(!/^[A-Za-z0-9_-]+$/.test(id)||!spritesheetUrl) return null;
    return {id,displayName,spritesheetUrl,layout:_normalizeSkinLayout(skin.layout)};
  }
  function _activeSkin(){return petSkins.find(skin=>skin.id===activeSkinId)||petSkins[0];}
  function _activeLayout(){const skin=_activeSkin();return _normalizeSkinLayout(skin&&skin.layout);}
  function _displaySizeForLayout(layout){const safe=_normalizeSkinLayout(layout);return {width:Math.max(1,Math.round(safe.frameWidth*PET_DISPLAY_SCALE*currentPetScale/100)),height:Math.max(1,Math.round(safe.frameHeight*PET_DISPLAY_SCALE*currentPetScale/100))};}
  function _windowSizeForDisplaySize(display){const s=currentPetScale/100;return {width:display.width+Math.round((PET_BADGE_FIXED.gap+PET_BADGE_FIXED.size+PET_BADGE_FIXED.right)*s),height:display.height};}
  function _logicalSize(width,height){const Ctor=_tauriDpiCtor('LogicalSize');return Ctor?new Ctor(width,height):null;}
  function _applyPetDisplaySize(layout){
    currentPetDisplaySize=_displaySizeForLayout(layout);
    currentPetWindowSize=_windowSizeForDisplaySize(currentPetDisplaySize);
    document.documentElement.style.setProperty('--pet-width',`${currentPetDisplaySize.width}px`);
    document.documentElement.style.setProperty('--pet-height',`${currentPetDisplaySize.height}px`);
    document.documentElement.style.setProperty('--pet-window-width',`${currentPetWindowSize.width}px`);
    document.documentElement.style.setProperty('--pet-window-height',`${currentPetWindowSize.height}px`);
    const s=currentPetScale/100;
    document.documentElement.style.setProperty('--pet-badge-gap',`${PET_BADGE_FIXED.gap*s}px`);
    document.documentElement.style.setProperty('--pet-badge-right',`${PET_BADGE_FIXED.right*s}px`);
    document.documentElement.style.setProperty('--pet-badge-top',`${PET_BADGE_FIXED.top*s}px`);
    document.documentElement.style.setProperty('--pet-badge-size',`${PET_BADGE_FIXED.size*s}px`);
    document.documentElement.style.setProperty('--pet-badge-hit-pad',`${PET_BADGE_FIXED.hitPad*s}px`);
    sprite.style.width=`${currentPetDisplaySize.width}px`;
    sprite.style.height=`${currentPetDisplaySize.height}px`;
    stage.style.width=`${currentPetDisplaySize.width}px`;
    stage.style.height=`${currentPetDisplaySize.height}px`;
    const win=_currentTauriWindow();
    const logical=_logicalSize(currentPetWindowSize.width,currentPetWindowSize.height);
    if(win&&logical&&typeof win.setSize==='function') win.setSize(logical).then(()=>_emitPetLayout()).catch(err=>console.warn('Failed to resize pet window',err));
  }
  const BUBBLE_STYLE_KEY='hermes-pet-bubble-style';
  const BUBBLE_STYLES=['default','chatgpt','chatgpt-dark'];
  function _applyBubbleStyle(style){
    const next=BUBBLE_STYLES.includes(style)?style:'default';
    document.body.dataset.bubbleStyle=next;
    try{localStorage.setItem(BUBBLE_STYLE_KEY,next);}catch(_){}
  }
  function _applyPetSkin(skinId,persist){
    const requested=String(skinId||'').trim();
    if(!requested) return;
    activeSkinId=requested;
    const next=petSkins.find(skin=>skin.id===requested)||petSkins[0];
    if(!next) return;
    if(persist){
      try{localStorage.setItem(SKIN_KEY,requested);}catch(error){console.warn('Failed to save pet skin selection',error);}
    }
    const layout=_normalizeSkinLayout(next.layout);
    _applyPetDisplaySize(layout);
    sprite.style.backgroundImage=`url("${next.spritesheetUrl}")`;
    sprite.style.backgroundSize=`${layout.columns*100}% ${layout.rows*100}%`;
    stage.setAttribute('aria-label',next.displayName);
    shell.setAttribute('aria-label',_petT('desktop_pet_shell_label',next.displayName));
  }
  async function _loadPetSkins(){
    try{
      const data=await fetch('/api/pet/skins',{cache:'no-store'}).then(res=>{if(!res.ok) throw new Error(`Pet skins failed: ${res.status}`);return res.json();});
      const skins=(Array.isArray(data.skins)?data.skins:[]).map(_safeSkin).filter(Boolean);
      if(skins.length) petSkins=skins;
      _applyPetSkin(activeSkinId,false);
      return true;
    }catch(err){console.warn('Failed to load pet skins',err);_applyPetSkin(activeSkinId,false);return false;}
  }
  async function _listenPetSkinChanges(){
    const tauri=window.__TAURI__;
    if(!tauri||!tauri.event||typeof tauri.event.listen!=='function') return;
    try{await tauri.event.listen('pet-skin-change',event=>_applyPetSkin(String(event.payload||''),true));}catch(err){console.warn('Failed to listen for pet skin changes',err);}
  }
  async function _listenPetSizeChanges(){
    const tauri=window.__TAURI__;
    if(!tauri||!tauri.event||typeof tauri.event.listen!=='function') return;
    try{await tauri.event.listen(PET_SIZE_CHANGE_EVENT,event=>_applyPetSize(String(event.payload||'')));}catch(err){console.warn('Failed to listen for pet size changes',err);}
  }
  function _applyPetSize(percent){
    const p=Math.round(Number(percent));
    if(!Number.isFinite(p)) return;
    const next=Math.min(200,Math.max(50,p));
    currentPetScale=next;
    try{localStorage.setItem(PET_SIZE_KEY,String(next));}catch(_){}
    if(_isDragging){pendingPetSize=next;return;}
    _applyPetDisplaySize(_activeLayout());
  }
  async function _listenBubbleStyleChanges(){
    const tauri=window.__TAURI__;
    if(!tauri||!tauri.event||typeof tauri.event.listen!=='function') return;
    try{await tauri.event.listen('pet-bubble-style-change',event=>_applyBubbleStyle(String(event.payload||'')));}catch(err){console.warn('Failed to listen for bubble style changes',err);}
  }
  async function _pollPetSkinSelection(){
    try{
      const data=await fetch(`/api/pet/skin_selection?since=${encodeURIComponent(String(lastSkinSelectionAt||0))}`,{cache:'no-store'}).then(res=>{if(!res.ok) throw new Error(`Pet skin selection failed: ${res.status}`);return res.json();});
      if(Number(data.updated_at_ms||0)>lastSkinSelectionAt) lastSkinSelectionAt=Number(data.updated_at_ms||0);
      const skinId=String(data.skin_id||'').trim();
      if(data.changed&&skinId) {
        await _loadPetSkins();
        _applyPetSkin(skinId,true);
      }
      const found=petSkins.some(skin=>skin.id===activeSkinId);
      if(!found){ await _loadPetSkins(); if(!petSkins.some(skin=>skin.id===activeSkinId)) return; _applyPetSkin(activeSkinId,false); }
      return true;
    }catch(err){console.warn('Failed to poll pet skin selection',err);return false;}
  }
  async function _restartPetInPlace(){
    try{await _savePetRestartPosition();}catch(err){console.warn('Failed to save pet restart position',err);}
    const tauri=window.__TAURI__;
    try{
      if(tauri&&tauri.event&&typeof tauri.event.emit==='function'){
        tauri.event.emit(PET_NATIVE_RESTART_REQUESTED_EVENT,{}).catch(()=>{
          location.reload();
        });
        return;
      }
    }catch(err){console.warn('Failed to notify native restart',err);}
    location.reload();
  }
  async function _listenPetRestartRequests(){
    const tauri=window.__TAURI__;
    if(!tauri||!tauri.event||typeof tauri.event.listen!=='function') return;
    try{await tauri.event.listen('pet-restart-requested',()=>_restartPetInPlace());}catch(err){console.warn('Failed to listen for pet restart requests',err);}
  }
  function _stateSpec(){const layout=_activeLayout();return layout.states.find(item=>item.name===state)||layout.states[0]||DEFAULT_PET_LAYOUT.states[0];}
  function _frameCount(){const layout=_activeLayout();const spec=_stateSpec();return Math.max(1,Math.min(layout.columns,Number(spec.frames)||layout.columns));}
  function _applyFrame(){const layout=_activeLayout();const spec=_stateSpec();const col=frame%_frameCount();const row=Math.max(0,Math.min(layout.rows-1,Number(spec.row)||0));const x=layout.columns>1?(col/(layout.columns-1))*100:0;const y=layout.rows>1?(row/(layout.rows-1))*100:0;sprite.style.backgroundPosition=`${x}% ${y}%`;}
  function _setState(next){const layout=_activeLayout();if(state!==next){state=layout.states.some(item=>item.name===next)?next:'idle';frame=0;}_applyFrame();}
  function _tick(){frame=(frame+1)%_frameCount();_applyFrame();}
  function _attentionQuery(){
    const params=new URLSearchParams();
    try{params.set('viewed_counts',localStorage.getItem(SESSION_VIEWED_COUNTS_KEY)||'{}');}catch(_){params.set('viewed_counts','{}');}
    try{params.set('completion_unread',localStorage.getItem(SESSION_COMPLETION_UNREAD_KEY)||'{}');}catch(_){params.set('completion_unread','{}');}
    const query=params.toString();
    return query?`?${query}`:'';
  }
  function _dismissKeyForRow(row,status){
    const sid=String(row&&row.session_id||'');
    if(status==='action_required') return `action_required:${String(row&&row.action_required_key||sid).trim()}`;
    if(status==='ready') return `${sid}:ready:${Number(row&&row.message_count||0)}`;
    return `${sid}:${status}`;
  }
  // Subagent sessions are excluded from pet-side attention (same predicate as
  // bubbles.js): their ready/completed cards would otherwise pin wasReady=true
  // and starve the completion-feedback edge trigger for real user sessions.
  // The WebUI renders them with the fixed title "Subagent Session" and they are
  // view-only (no rename entry point). If the WebUI ever changes that title,
  // this predicate must be updated in sync.
  function _isSubagentItem(item){
    return String(item&&item.title||'').replace(/\s+/g,' ').trim()==='Subagent Session';
  }
  function _attentionItems(){
    dismissed=_readJson(DISMISSED_KEY,{});
    return sessions.map(row=>{
      const status=String(row&&row.status||'idle');
      const dismissKey=_dismissKeyForRow(row,status);
      return {...row,status,dismissKey,text:_clean(row.process_text)};
    }).filter(item=>item.status!=='idle'&&dismissed[item.dismissKey]!==true&&!_isSubagentItem(item)).sort((a,b)=>{
      const priority={action_required:3,running:2,ready:1};
      if(a.status!==b.status) return (priority[b.status]||0)-(priority[a.status]||0);
      return Number(b.last_message_at||0)-Number(a.last_message_at||0);
    });
  }
  function render(){
    const items=_attentionItems();
    const count=items.length;
    const collapsed=localStorage.getItem(COLLAPSED_KEY)==='true' && localStorage.getItem(COLLAPSE_EXPLICIT_KEY)==='1';
    badge.hidden=!count;
    badge.classList.toggle('is-expanded',!!count&&!collapsed);
    if(count&&!collapsed){
      badge.innerHTML='<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="6 9 12 15 18 9"/></svg>';
      badge.setAttribute('aria-label',_petT('desktop_pet_collapse_updates'));
    }else{
      badge.textContent=String(count);
      badge.setAttribute('aria-label',_petT('desktop_pet_expand_updates'));
    }
    if(!_isDragging){
      const hasAction=items.some(item=>item.status==='action_required');
      const hasRunning=items.some(item=>item.status==='running');
      const hasReady=items.some(item=>item.status==='ready');
      // ready 边沿检测：attention 就绪后、ready 从无到有且无更高优先级状态 → 触发一次完成反馈（review）
      if(!attentionBooted||wasReady===null){wasReady=hasReady;}
      else if(hasReady&&!wasReady&&!hasAction&&!hasRunning){
        const layout=_activeLayout();
        const spec=layout.states.find(s=>s.name==='review');
        const frames=Math.max(1,Math.min(layout.columns,Number(spec&&spec.frames)||layout.columns));
        celebrateUntil=Date.now()+frames*FRAME_MS;   // 动态：播满一轮 review（keeper 6 帧×520ms≈3.1s）
        wasReady=true;
      }
      else{wasReady=hasReady;}
      if(Date.now()<dragAnimUntil){/* 拖拽动画驻留中，跳过状态覆盖 */}
      else if(Date.now()<celebrateUntil){_setState('review');}   // 完成反馈驻留
      else{_setState(hasAction?'waiting':(hasRunning?'running':(hasReady?'waving':'idle')));}
    }
    _emitPetAttentionUpdate(count,collapsed);
    _emitPetLayout().catch(()=>{});
  }
  async function refresh(){
    try{
      const data=await fetch('/api/pet/attention'+_attentionQuery(),{cache:'no-store'}).then(res=>{if(!res.ok) throw new Error(`Pet attention failed: ${res.status}`);return res.json();});
      sessions=Array.isArray(data.sessions)?data.sessions:[];
      if(!attentionBooted){attentionBooted=true;wasReady=null;}   // 首帧竞态保护：首次 refresh 前不触发庆祝；重置 wasReady 基线，防 boot 前 storage 事件（空 sessions render）污染基线导致启动误播（审阅低危 1 修正）
      render();
      return true;
    }catch(_){return false;}
  }
  function _currentTauriWindow(){
    const tauri=window.__TAURI__;
    if(!tauri) return null;
    if(tauri.webviewWindow&&typeof tauri.webviewWindow.getCurrentWebviewWindow==='function') return tauri.webviewWindow.getCurrentWebviewWindow();
    if(tauri.window&&typeof tauri.window.getCurrent==='function') return tauri.window.getCurrent();
    return null;
  }
  function _tauriDpiCtor(name){
    const tauri=window.__TAURI__;
    return (tauri&&tauri.dpi&&tauri.dpi[name])||(tauri&&tauri.window&&tauri.window[name])||null;
  }
  function _physicalPosition(x,y){const Ctor=_tauriDpiCtor('PhysicalPosition');return Ctor?new Ctor(Math.round(x),Math.round(y)):null;}
  function _browserWindowGeometry(){
    const x=Number(window.screenX),y=Number(window.screenY),width=Number(window.outerWidth),height=Number(window.outerHeight);
    if(!Number.isFinite(x)||!Number.isFinite(y)||!Number.isFinite(width)||!Number.isFinite(height)||width<=0||height<=0) return null;
    return {x,y,width,height,scale:Number(window.devicePixelRatio||1)||1,coordinateSpace:'physical'};
  }
  function _browserMonitorBounds(){
    const screenObj=window.screen||{};
    const scale=Number(window.devicePixelRatio||1)||1;
    const x=Number(screenObj.availLeft||0)*scale,y=Number(screenObj.availTop||0)*scale;
    const width=Number(screenObj.availWidth||screenObj.width||0)*scale,height=Number(screenObj.availHeight||screenObj.height||0)*scale;
    return {x,y,width,height,scale,coordinateSpace:'physical'};
  }
  function _monitorBounds(monitor){
    const pos=(monitor&&monitor.position)||monitor||{};
    const size=(monitor&&monitor.size)||monitor||{};
    return {x:Number(pos.x||0),y:Number(pos.y||0),width:Number(size.width||0),height:Number(size.height||0),scale:Number(monitor&&(monitor.scale||monitor.scaleFactor)||1)||1};
  }
  function _monitorUsable(monitor){
    const bounds=_monitorBounds(monitor);
    return Number.isFinite(bounds.width)&&Number.isFinite(bounds.height)&&bounds.width>0&&bounds.height>0;
  }
  function _monitorContainsPoint(monitor,x,y){
    if(!_monitorUsable(monitor)||!Number.isFinite(x)||!Number.isFinite(y)) return false;
    const b=_monitorBounds(monitor);
    return x>=b.x&&x<b.x+b.width&&y>=b.y&&y<b.y+b.height;
  }
  async function _windowGeometry(win){
    if(!win||typeof win.outerPosition!=='function'||typeof win.outerSize!=='function') return null;
    const [pos,size]=await Promise.all([win.outerPosition(),win.outerSize()]);
    return {x:Number(pos&&pos.x||0),y:Number(pos&&pos.y||0),width:Number(size&&size.width||0),height:Number(size&&size.height||0),coordinateSpace:'physical'};
  }
  function _safeRestartPosition(value){
    if(!value||typeof value!=='object') return null;
    const x=Number(value.x), y=Number(value.y);
    if(!Number.isFinite(x)||!Number.isFinite(y)) return null;
    const ts=Number(value.ts||0);
    if(ts&&Date.now()-ts>5*60*1000) return null;
    return {x,y};
  }
  async function _savePetRestartPosition(){
    const win=_currentTauriWindow();
    const geo=await _windowGeometry(win);
    if(!geo) return false;
    try{localStorage.setItem(RESTART_POSITION_KEY,JSON.stringify({x:geo.x,y:geo.y,ts:Date.now()}));return true;}catch(_){return false;}
  }
  async function _restorePetRestartPosition(){
    let saved=null;
    try{saved=_safeRestartPosition(JSON.parse(localStorage.getItem(RESTART_POSITION_KEY)||'null'));}catch(_){}
    try{localStorage.removeItem(RESTART_POSITION_KEY);}catch(_){}
    if(!saved) return false;
    const win=_currentTauriWindow();
    if(!win||typeof win.setPosition!=='function') return false;
    const pos=_physicalPosition(saved.x,saved.y);
    if(!pos) return false;
    try{await win.setPosition(pos);return true;}catch(err){console.warn('Failed to restore pet restart position',err);return false;}
  }
  async function _availableMonitorsList(win){
    // The WebviewWindow INSTANCE does not expose availableMonitors() in Tauri
    // v2 — it is a module-level function on window.__TAURI__.window. Relying on
    // win.availableMonitors silently yields []. currentMonitor() also returns
    // null on secondary / negative-origin external displays, so we need the
    // full list to find the monitor that actually contains the pet.
    const tauri=window.__TAURI__;
    const fn=(tauri&&tauri.window&&tauri.window.availableMonitors)||(win&&typeof win.availableMonitors==='function'?win.availableMonitors.bind(win):null);
    if(typeof fn!=='function') return [];
    try{const list=await fn();return Array.isArray(list)?list:[];}catch(_){return [];}
  }
  async function _monitorForWindow(win,geo){
    const cx=geo?geo.x+geo.width/2:null, cy=geo?geo.y+geo.height/2:null;
    let monitor=null;
    try{if(win&&typeof win.currentMonitor==='function') monitor=await win.currentMonitor();}catch(_){}
    if(monitor&&(!geo||_monitorContainsPoint(monitor,cx,cy))) return monitor;
    const monitors=await _availableMonitorsList(win);
    if(monitors.length&&geo){
      // Prefer the monitor whose bounds contain the pet center; this is robust
      // across negative-origin arrangements where nearest-center can pick wrong.
      const contains=monitors.find(item=>_monitorContainsPoint(item,cx,cy));
      if(contains) return contains;
      const usable=monitors.filter(item=>_monitorUsable(item));
      if(usable.length) return usable.map(item=>{const b=_monitorBounds(item);return {item,dist:Math.hypot(cx-(b.x+b.width/2),cy-(b.y+b.height/2))};}).sort((a,b)=>a.dist-b.dist)[0].item;
    }
    return null;
  }
  async function _clampPetWindowToMonitor(win,geo,monitor){
    if(!win||!geo||!monitor||typeof win.setPosition!=='function') return geo;
    const b=_monitorBounds(monitor);
    if(!b.width||!b.height) return geo;
    const margin=8*b.scale;
    const maxX=Math.max(b.x+margin,b.x+b.width-geo.width-margin);
    const maxY=Math.max(b.y+margin,b.y+b.height-geo.height-margin);
    const nextX=Math.min(maxX,Math.max(b.x+margin,geo.x));
    const nextY=Math.min(maxY,Math.max(b.y+margin,geo.y));
    if(Math.abs(nextX-geo.x)<1&&Math.abs(nextY-geo.y)<1) return geo;
    const pos=_physicalPosition(nextX,nextY);
    if(!pos) return geo;
    try{await win.setPosition(pos);return {...geo,x:nextX,y:nextY};}catch(err){console.warn('Failed to clamp pet window',err);return geo;}
  }
  function _badgeGeometryForPet(pet){
    if(!pet||!pet.width||!pet.height) return null;
    const s=currentPetScale/100;
    const scaleX=pet.width/currentPetWindowSize.width;
    const scaleY=pet.height/currentPetWindowSize.height;
    const width=PET_BADGE_FIXED.size*s*scaleX;
    const height=PET_BADGE_FIXED.size*s*scaleY;
    return {
      x:pet.x+(currentPetDisplaySize.width+PET_BADGE_FIXED.gap*s)*scaleX,
      y:pet.y+PET_BADGE_FIXED.top*s*scaleY,
      width,
      height
    };
  }
  async function _emitPetLayout(options){
    const dragging=!!(options&&options.dragging);
    const tauri=window.__TAURI__;
    if(!tauri||!tauri.event||typeof tauri.event.emit!=='function') return;
    const win=_currentTauriWindow();
    const tauriGeo=await _windowGeometry(win);
    const monitor=dragging?latestPetMonitor:await _monitorForWindow(win,tauriGeo);
    if(monitor) latestPetMonitor=monitor;
    const bounds=tauriGeo&&_monitorUsable(monitor)?_monitorBounds(monitor):_browserMonitorBounds();
    const clamped=!dragging&&tauriGeo?await _clampPetWindowToMonitor(win,tauriGeo,_monitorUsable(monitor)?monitor:null):null;
    const nextGeo=dragging?tauriGeo:(clamped||tauriGeo||_browserWindowGeometry());
    if(!nextGeo) return;
    const badgeGeo=_badgeGeometryForPet(nextGeo);
    await tauri.event.emit('pet-layout-update',{pet:nextGeo,badge:badgeGeo,monitor:bounds,coordinateSpace:nextGeo.coordinateSpace||bounds.coordinateSpace||'physical',dragging});
  }
  function _schedulePetLayoutFrame(){
    if(petLayoutFrameId) return;
    petLayoutFrameId=requestAnimationFrame(()=>{petLayoutFrameId=0;_emitPetLayout().catch(()=>{});});
  }
  function _eventPoint(event){
    if(!event) return null;
    const x=Number(Number.isFinite(event.screenX)?event.screenX:event.clientX);
    const y=Number(Number.isFinite(event.screenY)?event.screenY:event.clientY);
    return Number.isFinite(x)&&Number.isFinite(y)?{x,y}:null;
  }
  function _dragDistanceFromStart(event){
    const point=_eventPoint(event);
    if(!dragStartPoint||!point) return 0;
    return Math.hypot(point.x-dragStartPoint.x,point.y-dragStartPoint.y);
  }
  function _suppressNextStageClick(){
    suppressStageClickUntil=Date.now()+DRAG_CLICK_SUPPRESS_MS;
  }
  function _consumeSuppressedStageClick(event){
    if(Date.now()>suppressStageClickUntil) return false;
    suppressStageClickUntil=0;
    if(event&&typeof event.preventDefault==='function') event.preventDefault();
    if(event&&typeof event.stopPropagation==='function') event.stopPropagation();
    return true;
  }
  function _startDragLayoutTracking(event){
    const now=Date.now();
    _isDragging=true;dragLastScreenX=null;dragStartScreenX=null;dragLastMoveAt=now;dragStartedAt=now;
    dragStartPoint=_eventPoint(event);
    const screenX=Number(window.screenX);
    if(Number.isFinite(screenX)){dragLastScreenX=screenX;dragStartScreenX=screenX;}
    if(!dragLayoutPoll) dragLayoutPoll=setInterval(_pollDragLayout,50);
  }
  function _pollDragLayout(){
    if(!dragLayoutPoll) return;
    const now=Date.now();
    if(dragStartedAt&&now-dragStartedAt>=15000){
      clearInterval(dragLayoutPoll);dragLayoutPoll=0;
      _finishDragLayoutTracking();
      return;
    }
    const screenX=Number(window.screenX);
    let moved=false;
    if(Number.isFinite(screenX)){
      if(dragLastScreenX!==null){
        if(screenX>dragLastScreenX+2){if(!_isDragging) dragStartedAt=now;_isDragging=true;_setState('running-right');moved=true;}
        else if(screenX<dragLastScreenX-2){if(!_isDragging) dragStartedAt=now;_isDragging=true;_setState('running-left');moved=true;}
      }
      dragLastScreenX=screenX;
    }
    if(moved) dragLastMoveAt=now;
    else if(_isDragging&&now-dragLastMoveAt>=500) _finishDragLayoutTracking();
    _emitPetLayout({dragging:_isDragging}).catch(()=>{});
  }
  function _finishDragLayoutTracking(event){
    if(!_isDragging&&!dragLayoutPoll) return;
    if(event){
      const screenX=Number(window.screenX);
      const dragged=_dragDistanceFromStart(event)||(Number.isFinite(screenX)&&Number.isFinite(dragStartScreenX)&&Math.abs(screenX-dragStartScreenX)>DRAG_CLICK_SUPPRESS_PX);
      if(dragged) _suppressNextStageClick();
    }
    _isDragging=false;
    if(pendingPetSize){_applyPetSize(pendingPetSize);pendingPetSize=null;}
    dragAnimUntil=0;
    dragStartPoint=null;dragStartScreenX=null;dragLastMoveAt=0;
    _emitPetLayoutBurst();
    render();
  }
  function _emitPetAttentionUpdate(count,collapsed){
    const tauri=window.__TAURI__;
    if(!tauri||!tauri.event||typeof tauri.event.emit!=='function') return;
    tauri.event.emit('pet-attention-update',{count,collapsed}).catch(()=>{});
  }
  function _eventInsideBadge(event){
    if(!event||badge.hidden) return false;
    const x=Number(event.clientX),y=Number(event.clientY);
    if(!Number.isFinite(x)||!Number.isFinite(y)) return false;
    const rect=badge.getBoundingClientRect();
    const pad=Number(PET_BADGE_FIXED.hitPad||0);
    return x>=rect.left-pad&&x<=rect.right+pad&&y>=rect.top-pad&&y<=rect.bottom+pad;
  }
  async function _startTauriWindowDrag(event,options={}){
    if(!event) return;
    if(_eventInsideBadge(event)) return;
    const stageRect=stage.getBoundingClientRect();
    const dragY=Number(event.clientY);
    if(Number.isFinite(dragY)&&dragY>stageRect.top+stageRect.height*DRAG_HEAD_RATIO) return;
    if(event.type==='pointerdown'&&event.pointerType==='mouse') return;
    if('button' in event&&event.button!==0) return;
    const win=_currentTauriWindow();
    if(!win||typeof win.startDragging!=='function') return;
    if(options.preventDefault===true&&typeof event.preventDefault==='function') event.preventDefault();
    _startDragLayoutTracking(event);
    try{await win.startDragging();}catch(_){}
  }
  function _onBadgeActivate(){
    const collapsed=localStorage.getItem(COLLAPSED_KEY)==='true';
    localStorage.setItem(COLLAPSED_KEY,collapsed?'false':'true');
    const nextCollapsed=!collapsed;
    if(nextCollapsed){
      try{localStorage.setItem(COLLAPSE_EXPLICIT_KEY,'1');}catch(_){}
    }else{
      try{localStorage.removeItem(COLLAPSE_EXPLICIT_KEY);}catch(_){}
    }
    render();
    _emitPetLayout();
  }
  function _handleAccessibleKey(event,handler){
    if(!event||(event.key!=='Enter'&&event.key!==' ')) return;
    event.preventDefault();
    handler();
  }
  function _onStageClick(event){
    if(_consumeSuppressedStageClick(event)) return;
    if(_eventInsideBadge(event)){
      event.preventDefault();
      event.stopPropagation();
      _onBadgeActivate();
      return;
    }
    dragAnimUntil=Date.now()+INTERACT_ANIM_HOLD_MS;
    _setState('jumping');
  }
  function _onStageKeyboardActivate(){
    dragAnimUntil=Date.now()+INTERACT_ANIM_HOLD_MS;
    _setState('jumping');
  }
  async function _openPetContextMenu(event){
    event.preventDefault();
    event.stopPropagation();
    const tauri=window.__TAURI__;
    if(!tauri||!tauri.event||typeof tauri.event.emit!=='function') return;
    try{
      await _loadPetSkins();
      await _loadPreferences();
      await tauri.event.emit('pet-context-menu',{skins:petSkins,activeSkinId:(_activeSkin()||{}).id||'keeper',activeBubbleStyle:localStorage.getItem(BUBBLE_STYLE_KEY)||'default',permissions:petPreferences});
    }catch(err){console.warn('Failed to open pet context menu',err);}
  }
  badge.addEventListener('click',_onBadgeActivate);
  badge.addEventListener('keydown',event=>_handleAccessibleKey(event,_onBadgeActivate));
  window.addEventListener('storage',event=>{
    if(event.key!==SKIN_KEY||!event.newValue) return;
    _applyPetSkin(event.newValue,false);
  });
  function _emitPetLayoutBurst(){[0,80,180,360,720].forEach(delay=>setTimeout(()=>_emitPetLayout().catch(()=>{}),delay));}
  async function _listenPetWindowGeometry(){
    const win=_currentTauriWindow();
    if(!win) return;
    const sync=()=>_schedulePetLayoutFrame();
    try{if(typeof win.onMoved==='function') await win.onMoved(sync);}catch(err){console.warn('Failed to listen for pet window moves',err);}
    try{if(typeof win.onResized==='function') await win.onResized(sync);}catch(err){console.warn('Failed to listen for pet window resizes',err);}
  }
  async function _listenPetPermissionMenu(){
    const tauri=window.__TAURI__;
    if(!tauri||!tauri.event||typeof tauri.event.listen!=='function') return;
    try{
      await tauri.event.listen(PET_PERMISSION_TOGGLE_EVENT,event=>{
        const payload=event&&event.payload||{};
        const key=String(payload.key||'');
        if(!['allow_direct_send','allow_inline_action_responses'].includes(key)) return;
        _setPreferences({[key]:Boolean(payload.enabled)}).catch(err=>console.warn('Failed to toggle pet permission',err));
      });
    }catch(err){console.warn('Failed to listen for pet permission menu',err);}
  }
  let _badgePointerToggleAt=0;
  function _consumeUnifiedBadgeEvent(event){
    if(!_eventInsideBadge(event)) return false;
    event.preventDefault();
    event.stopPropagation();
    if(typeof event.stopImmediatePropagation==='function') event.stopImmediatePropagation();
    return true;
  }
  function _onUnifiedBadgePointerDown(event){
    if(!_consumeUnifiedBadgeEvent(event)) return;
    _badgePointerToggleAt=Date.now();
    _onBadgeActivate();
  }
  function _onUnifiedBadgeClick(event){
    if(!_consumeUnifiedBadgeEvent(event)) return;
    if(Date.now()-_badgePointerToggleAt<700) return;
    _onBadgeActivate();
  }
  document.addEventListener('contextmenu',_openPetContextMenu);
  document.addEventListener('pointerdown',_onUnifiedBadgePointerDown,{capture:true});
  document.addEventListener('click',_onUnifiedBadgeClick,{capture:true});
  stage.addEventListener('mousedown',_startTauriWindowDrag,{capture:true});
  stage.addEventListener('pointerdown',_startTauriWindowDrag,{capture:true});
  ['mouseup','pointerup','blur'].forEach(type=>window.addEventListener(type,event=>_finishDragLayoutTracking(event),{capture:true}));

  stage.addEventListener('click',_onStageClick);
  stage.addEventListener('keydown',event=>_handleAccessibleKey(event,_onStageKeyboardActivate));
  window.addEventListener('storage',event=>{if(event.key===COLLAPSED_KEY||event.key===DISMISSED_KEY) render();});
  setInterval(_tick,FRAME_MS);
  setInterval(refresh,POLL_MS);
  setInterval(_pollPetSkinSelection,1200);
  setInterval(_emitPetLayout,1000);
  async function _bootPet(){
    _localizeStaticLabels();
    _registerDesktopPetProcess().catch(()=>{});
    await _restorePetRestartPosition();
    await _loadPetSkins();
    await refresh();
    _listenPetSkinChanges();
    _listenPetSizeChanges();
    const tauri=window.__TAURI__;
    if(tauri&&tauri.event&&typeof tauri.event.emit==='function'){
      tauri.event.emit('pet-scale-request',{}).catch(()=>{});
    }
    let initialBubbleStyle='default';
    try{initialBubbleStyle=localStorage.getItem(BUBBLE_STYLE_KEY)||'default';}catch(_){}
    _applyBubbleStyle(initialBubbleStyle);
    _listenBubbleStyleChanges();
    _pollPetSkinSelection();
    _listenPetRestartRequests();
    _listenPetWindowGeometry();
    _listenPetPermissionMenu();
    _emitPetLayout();
  }
  _bootPet();
})();
