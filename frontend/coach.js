/* Pattern C / Pattern B controller. No cloud LLM or API key is required. */
(()=>{
'use strict';
const el=id=>document.getElementById(id),app=window.ergoApp;
const base=new URL('.',document.currentScript.src).href;
const isPhone=new URLSearchParams(location.search).get('phone');
let socket=null,room=null,key=null,retry=null,retries=0,closed=false,lastSend=0,phoneEnabled=false,lastEvent='',phoneState=null,restoredPair=false;
let sensor=null,worker=null,cameraStream=null,cameraTimer=null,cameraBusy=false,cameraGeneration=0,inFlight=false,ready=false;
let recovery=null,pending=null,suppressedUntil=0,reliefUntil=0,lastNotice=0,lastMode='standby',phoneCount=0;
let lastTimerReminder=0;
let riskOn=false,sustainedRiskAt=0,previousFrameTime=-1,frameStarted=0,nextFrameAt=0,inferenceMs=0;
const postureGuard=new window.ErgoPostureGuard();
let guardWasLocked=false,guardLastPostAt=0,guardLastSent=null,guardLastTracked=false,guardLastPlayful=null,guardLastPause=null,guardPosting=false;
let guardLastFaceClose=null,guardLastGrow=null,guardLastZoomHint=null,knownServerDismissals=null;
let catBadSince=0,catPeakMs=0;
let wasFaceClose=false,faceCloseStreak=0,zoomSuggested=false,zoomDismissedUntil=0,simulatedFaceCloseUntil=0,currentZoom=100;
let badEpisodeStartedAt=0;
const uid=()=>globalThis.crypto?.randomUUID?.()||Date.now()+'-'+Math.random().toString(36).slice(2);
const guardSource=uid().replace(/[^A-Za-z0-9_-]/g,'');
const gapMinutes=()=>window.ergoInsights?.gapMinutes(Number(el('notice-gap').value))??Number(el('notice-gap').value);
const recordInsight=kind=>{if(!el('demo').checked)window.ergoInsights?.record(kind);};
const send=data=>{if(socket?.readyState===1){socket.send(JSON.stringify(data));return true;}return false;};
function say(text){if(!phoneEnabled||!('speechSynthesis' in window))return;try{speechSynthesis.cancel();const utterance=new SpeechSynthesisUtterance(text);utterance.lang='ja-JP';utterance.rate=.95;utterance.onerror=()=>{el('phone-capability').textContent='音声を再生できません。画面の案内をご利用ください。';};speechSynthesis.speak(utterance);}catch{}}
function silence(){if('speechSynthesis' in window)speechSynthesis.cancel();navigator.vibrate?.(0);}
function connect(){
 if(closed||!room)return;clearTimeout(retry);const wsProtocol=location.protocol==='https:'?'wss:':'ws:';
 const ws=new WebSocket(wsProtocol+'//'+location.host+'/ws/'+encodeURIComponent(room)+'?role='+(isPhone?'phone':'pc')+(key?'&key='+encodeURIComponent(key):''));socket=ws;
 ws.onopen=()=>{retries=0;if(!isPhone){restoredPair=false;lastSend=0;publish('state');}};
 ws.onmessage=({data})=>{let state;try{state=JSON.parse(data);}catch{return;}
  if(isPhone){if(state.type==='state'||state.type==='intervene'||state.type==='recovered'){phoneState=state;phoneUpdate(state);}}
  else if(state.type==='command'){
   if(state.action==='start'){if(!pending&&!recovery)return;el('exercise-kind').value=state.exercise;startRecovery();}
   if(state.action==='defer')defer();if(state.action==='cancel')cancelRecovery();if(state.action==='commit')contextBreak('コミット完了');
  }else if(state.phones!==undefined){phoneCount=state.phones;el('connection-status').textContent='連携中 · スマホ '+phoneCount+'台';}
 };
 ws.onerror=()=>{};
 ws.onclose=event=>{if(socket!==ws)return;if(isPhone){el('phone-connection').textContent='接続が切れました';silence();el('phone-start').disabled=true;}else el('connection-status').textContent='接続が切れました。再接続しています。';if(event.code===1008){if(!isPhone&&restoredPair&&retries<2){retries++;retry=setTimeout(connect,1200);return;}if(isPhone)el('phone-connection').textContent='URLの有効期限を確認してください';else{clearSavedPair();el('connection-status').textContent='連携が終了しました。もう一度「連携を始める」を押してください。';}return;}if(!closed)retry=setTimeout(connect,Math.min(10000,1000*2**Math.min(retries++,3)));};
}
function publish(type='state',override={}){
 const data={type,mode:recovery?'recovery':pending?'buddy':lastMode,score:currentScore()??100,progress:recovery?.progress||0,remaining:recovery?Math.max(0,Math.ceil(15-(Date.now()-recovery.started)/1000)):0,event_id:recovery?.id||pending?.id||'',reason:pending?.reason||'',exercise:recovery?.exercise||el('exercise-kind').value,demo:el('demo').checked,tracking:!!(sensor?.tracked&&sensor?.calibrated),...override};
 send(data);lastSend=Date.now();
}
function currentScore(){return el('demo').checked?Number(el('posture-range').value):(sensor?.calibrated&&sensor?.tracked?sensor.score:null);}
function currentPostureScore(){return el('demo').checked?Number(el('posture-range').value):(sensor?.calibrated&&sensor?.tracked?sensor.postureScore??null:null);}
function faceIsClose(demo){
 if(Date.now()<simulatedFaceCloseUntil)return true;
 return !demo&&sensor?.calibrated===true&&sensor?.faceClose===true;
}
function applyPageZoom(percent,save=true){
 const normalized=[100,115,125].includes(Number(percent))?Number(percent):100;
 currentZoom=normalized;
 document.documentElement?.style?.setProperty('--ergo-zoom',String(normalized/100));
 if(document.body?.dataset)document.body.dataset.zoom=String(normalized);
 if(el('quick-zoom'))el('quick-zoom').value=String(normalized);
 if(el('accept-zoom')){
  const next=normalized<115?115:125;
  el('accept-zoom').textContent='表示を大きくする（'+next+'%）';
 }
 if(save)saveQuickPref('pageZoom',String(normalized));
}
function updateFaceZoomTracking(close,demo,now){
 if(close&&!wasFaceClose){
  faceCloseStreak++;
  if(!demo)window.ergoInsights?.recordFaceClose(currentZoom>100);
  if(faceCloseStreak>=2&&currentZoom<125&&now>=zoomDismissedUntil){
   zoomSuggested=true;
  }
 }
 wasFaceClose=close;
 if(currentZoom>=125)zoomSuggested=false;
 if(el('face-zoom-box'))el('face-zoom-box').hidden=!zoomSuggested;
}
function updatePostureCat(score,demo){
 const measured=score!==null&&Number.isFinite(score);
 const severity=measured?Math.max(0,Math.min(1,(100-score)/65)):0;
 const scale=(.90+.68*severity).toFixed(3);
 el('posture-cat').style.setProperty('--cat-scale',scale);
 const playful=el('quick-cat-motion').checked;
 const now=Date.now();
 if(!playful||!measured||score>=70){catBadSince=0;catPeakMs=0;}
 else if(score<60){if(!catBadSince)catBadSince=now;}
 else if(catBadSince){catPeakMs=Math.max(catPeakMs,now-catBadSince);catBadSince=0;}
 const badMs=Math.max(catPeakMs,catBadSince?now-catBadSince:0);
 el('cat-stage').classList.toggle('warning',measured&&score<60);
 el('cat-stage').classList.toggle('playful',playful);
 el('cat-stage').classList.toggle('cuddly',playful&&measured&&score>=75);
 el('cat-stage').classList.toggle('kitten-one',playful&&badMs>=5000);
 el('cat-stage').classList.toggle('kitten-two',playful&&badMs>=13000);
 const message=!measured?'まだ姿勢を測定していないよ':zoomSuggested?'ねこ「文字、小さくない？ 表示を大きくできるよ」':score<60?'ねこが大きくなった！ 姿勢を少し整えよう':score<75?'ねこが少し大きくなっているよ':'ねこは落ち着いているよ';
 el('cat-state').textContent=demo?message+'（デモ）':message;
 el('posture-cat').setAttribute('aria-label',measured?'姿勢の目安 '+Math.round(score)+'点。猫の大きさ '+scale+'倍':'姿勢は未計測です。小さな猫を表示しています。');
}
function reportDesktopGuard(active,score,playful,pauseOnKittens,faceClose,grow,zoomHint,now){
 // Windows helper only reads a short-lived signal from the local PC, never from LAN clients.
 if(isPhone||!['localhost','127.0.0.1','::1'].includes(location.hostname)||typeof fetch!=='function')return;
 const tracked=Number.isFinite(score);
 // Transmit about once per second, immediately on a new/lost measurement.
 if(guardPosting||(guardLastSent===active&&guardLastTracked===tracked&&guardLastPlayful===playful&&guardLastPause===pauseOnKittens&&guardLastFaceClose===faceClose&&guardLastGrow===grow&&guardLastZoomHint===zoomHint&&now-guardLastPostAt<900))return;
 guardPosting=true;guardLastSent=active;guardLastTracked=tracked;guardLastPlayful=playful;guardLastPause=pauseOnKittens;guardLastFaceClose=faceClose;guardLastGrow=grow;guardLastZoomHint=zoomHint;guardLastPostAt=now;
 const body={source:guardSource,active,score:tracked?score:null,playful,pause_on_kittens:pauseOnKittens,face_close:faceClose,grow};
 if(zoomHint)body.zoom_hint=true;
 const req=fetch('/api/posture-guard/update',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
 if(req?.then){
  req.then(r=>r?.json?.()).then(data=>{
   if(data&&typeof data.dismissals==='number'){
    if(knownServerDismissals!==null&&data.dismissals>knownServerDismissals){
     const diff=data.dismissals-knownServerDismissals;
     for(let i=0;i<diff;i++)recordInsight('dismissed');
     badEpisodeStartedAt=0;
    }
    knownServerDismissals=data.dismissals;
   }
  }).catch(()=>{}).finally(()=>{guardPosting=false;});
 }else{
  req.catch(()=>{}).finally(()=>{guardPosting=false;});
 }
}
function updatePostureGuard(now,score,a,demo){
 const adaptiveCat=el('quick-adaptive-cat')?.checked!==false;
 const catStyle=adaptiveCat?window.ergoInsights?.recommendedCatStyle?.():null;
 const bonusSec=catStyle?.mode==='gentle'?catStyle.triggerBonusSec||0:0;
 postureGuard.triggerMs=(Number(el('guard-duration').value)+bonusSec)*1000;
 const enabled=el('guard-enabled').checked;
 const measured=demo||(sensor?.tracked&&sensor?.calibrated);
 const working=!a.rest&&!a.sessionPaused&&!recovery&&(a.started||demo);
 const status=postureGuard.step({now,enabled,score:measured?score:null,working});
 if(working&&measured&&enabled){
  if(status.locked&&!badEpisodeStartedAt){badEpisodeStartedAt=now;}
  else if(badEpisodeStartedAt&&score!==null&&score>=70){
   if(!demo)window.ergoInsights?.recordRecovery(now-badEpisodeStartedAt,el('quick-cat-growth').checked?'giant':'quiet');
   badEpisodeStartedAt=0;
  }
 }else if(!working||!measured){
  badEpisodeStartedAt=0;
 }
 const experimentalBlock=status.locked&&el('guard-experimental').checked;
 window.ergoPostureLocked=experimentalBlock;
 el('guard-screen').hidden=!experimentalBlock;
 el('guard-cue').hidden=!status.locked||experimentalBlock;
 const main=document.querySelector?.('main');if(main)main.inert=experimentalBlock;
 if(experimentalBlock){
  const seconds=Math.max(1,Math.ceil(status.recoveryMs/1000));
  el('guard-recovery').textContent='姿勢の目安が75点以上になってから、あと'+seconds+'秒で自動再開します。';
  el('guard-status').textContent='実験用の操作停止中。Escキーでいつでも解除できます。';
  if(!guardWasLocked)el('guard-bypass').focus?.();
 }else if(status.locked){
  el('guard-status').textContent='姿勢変化を検知。画面を遮らずに小さくお知らせしています。';
 }else{
  el('guard-status').textContent=!enabled?'静かな姿勢サインはオフです。':status.bypassed?'一時休止中（約'+Math.ceil((postureGuard.bypassUntil-now)/1000)+'秒）':!measured?'未計測。カメラを開始してください。':!a.started&&!demo?'作業計測を開始すると判定します。':score<60?'姿勢変化を確認中。あと'+Math.ceil(status.remainingMs/1000)+'秒で小さく知らせます。':'大きな姿勢変化はありません。';
 }
 guardWasLocked=experimentalBlock;
 // Demo mode is deliberately browser-only, including the optional Windows corner cue.
 const desktopActive=enabled&&!demo&&a.started&&!a.sessionPaused&&!a.rest&&!recovery;
 const nativeScore=desktopActive&&measured?score:null;
 const effectiveGrow=el('quick-cat-growth').checked&&catStyle?.mode!=='gentle';
 const close=desktopActive&&faceIsClose(demo);
 reportDesktopGuard(status.locked&&!demo&&enabled,nativeScore,el('quick-cat-motion').checked,el('quick-cat-pause').checked,close,effectiveGrow,close&&zoomSuggested,now);
}
function bypassGuard(){
 recordInsight('dismissed');
 badEpisodeStartedAt=0;
 postureGuard.bypass(Date.now());
 updatePostureGuard(Date.now(),currentPostureScore(),app.get(),el('demo').checked);
}
function contextBreak(reason){const a=app.get();if(!a.started||a.sessionPaused||recovery||a.rest)return false;const now=Date.now();if(now<suppressedUntil||now<reliefUntil)return false;const score=currentScore(),risk=(score!==null&&score<60)||a.workMs>=(el('demo').checked?20000:Number(el('interval').value)*60000)||a.longWorkMs>=3000000;if(risk)return intervene(reason);return false;}
function intervene(reason){const now=Date.now(),gap=gapMinutes()*60000;if(recovery||pending||now-lastNotice<gap)return false;lastNotice=now;pending={id:uid(),reason};el('break-kind').value='coach';lastMode='buddy';recordInsight('offered');publish('intervene');return true;}
function defer(){if(pending)recordInsight('deferred');suppressedUntil=Date.now()+300000;pending=null;lastMode='standby';app.defer();silence();publish();app.render();}
function startRecovery(){if(recovery||app.get().rest)return;const exercise=el('exercise-kind').value;recovery={id:uid(),exercise,started:Date.now(),progress:0,demo:el('demo').checked,fromPrompt:!!pending};pending=null;recordInsight('started');window.ergoRecovering=true;el('demo').disabled=true;worker?.postMessage({type:'exercise',exercise,now:performance.now()});publish();app.render();}
function cancelRecovery(){if(!recovery)return;recordInsight('cancelled');worker?.postMessage({type:'cancel'});recovery=null;window.ergoRecovering=false;el('demo').disabled=false;suppressedUntil=Date.now()+30000;lastMode='standby';el('toast').textContent='動きを中止しました。完了回数には含めません。';publish();app.render();}
function finishRecovery(manual=false){if(!recovery)return;if(manual&&Date.now()-recovery.started<15000)return;const id=recovery.id;recordInsight('completed');if(recovery.fromPrompt)recordInsight('promptCompleted');worker?.postMessage({type:'cancel'});recovery=null;pending=null;window.ergoRecovering=false;el('demo').disabled=false;reliefUntil=Date.now()+60000;suppressedUntil=reliefUntil;lastMode='standby';app.finish();publish('recovered',{event_id:id});app.render();}
function tick(){
 if(isPhone)return;const a=app.get(),now=Date.now(),demo=el('demo').checked;
 if(a.rest&&pending){pending=null;publish('state',{mode:'rest'});}
 const dueAt=(demo?20000:Number(el('interval').value)*60000);
 if(a.workMs<dueAt||!a.externalSession)lastTimerReminder=0;
 if(a.externalSession&&!a.sessionPaused&&!a.rest&&!recovery&&a.workMs>=dueAt&&now>=a.snoozeUntil&&now>=a.finishedUntil&&document.hidden&&(!lastTimerReminder||now-lastTimerReminder>=gapMinutes()*60000)){
  if('Notification' in window&&Notification.permission==='granted'){
   try{new Notification('ErgoPulse：そろそろ小休止',{body:'作業時間が設定した間隔に達しました。区切りのよいところでひと息つきましょう。',tag:'ergopulse-rest'});lastTimerReminder=now;}catch{}
  }
 }
 if(sensor&&now-sensor.received>2000){sensor=null;el('sensor-status').textContent='カメラの計測が止まっています。映り方を確認してください。';}
 const score=currentScore(),risk=score!==null&&(riskOn?score<70:score<60);riskOn=risk; // Unknown tracking is not a healthy posture score.
 el('posture-state').textContent=demo?'姿勢：デモ値 '+score+' / 100':sensor?.calibrating?'姿勢：基準を登録中':score===null?'姿勢：未計測（カメラの確認・再調整が必要）':'姿勢の目安：'+score+' / 100'+(sensor?.reason?'（'+sensor.reason+'）':'');
 const postureScore=currentPostureScore();
 const close=faceIsClose(demo)&&((a.started&&!a.sessionPaused&&!a.rest&&!recovery)||now<simulatedFaceCloseUntil);
 updateFaceZoomTracking(close,demo,now);
 updatePostureCat(postureScore,demo);
 updatePostureGuard(now,postureScore,a,demo);
 updateQuickPanel(a,postureScore,demo,close);
 if(risk){if(!sustainedRiskAt)sustainedRiskAt=now;}else sustainedRiskAt=0;
 const validRisk=risk&&(demo||now-sustainedRiskAt>1500);
 window.ergoInsights?.observePosture(!demo&&a.started&&!a.sessionPaused&&!a.rest&&!recovery&&score!==null,validRisk,now);
 lastMode=a.rest?'rest':recovery?'recovery':pending?'buddy':'standby';
 el('recovery-box').hidden=!recovery;
 if(recovery){
  el('status').textContent='体を動かしています';el('break-title').textContent=recovery.exercise==='banzai'?'両手を上げて、15秒。':'肩をゆっくり、3回以上。';el('break-copy').textContent='PCカメラに上半身が映る位置で、無理のない範囲で動きましょう。';
  el('stretch').disabled=true;el('stretch').textContent='動きを確認しています';el('cancel-break').hidden=false;el('later').hidden=true;el('break-kind').disabled=true;
  const cameraTracking=!!(sensor?.exerciseTrackable&&ready&&now-sensor.received<2000),elapsed=(now-recovery.started)/1000;
  el('recovery-hint').textContent=cameraTracking?(recovery.exercise==='banzai'?'両手首を肩より上に保つと進みます。':'肩の上下動を3回以上、15秒かけて行います。'):demo?'デモ中です。15秒動いたら下のボタンで完了できます。':'動作に必要な部位を確認できません。15秒後に手動で完了できます。';
  el('recovery-bar').style.width=recovery.progress+'%';el('recovery-progress').textContent=Math.round(recovery.progress)+'%';el('manual-finish').hidden=elapsed<15||cameraTracking;
 }else if(pending&&!a.rest){el('status').textContent='休憩の案内';el('break-title').textContent='今のうちに、15秒。';el('break-copy').textContent=pending.reason+'をきっかけに、短い動きを案内しています。';el('stretch').textContent='15秒の動きを始める';el('later').hidden=false;}
 if(room&&now-lastSend>=1000)publish();
}
window.ergoTick=tick;window.ergoStartRecovery=startRecovery;window.ergoCancelRecovery=cancelRecovery;window.ergoMarkBoundary=()=>contextBreak('作業の区切り');window.ergoDefer=()=>{if(pending)recordInsight('deferred');pending=null;suppressedUntil=Date.now()+300000;publish();};
el('manual-finish').onclick=()=>finishRecovery(true);
el('guard-enabled').addEventListener('change',()=>{if(!el('guard-enabled').checked)postureGuard.clear();app.render();});
el('guard-duration').addEventListener('change',()=>{postureGuard.clear();app.render();});
el('guard-experimental').addEventListener('change',()=>app.render());
el('guard-bypass').onclick=bypassGuard;
el('guard-disable').onclick=()=>{el('guard-enabled').checked=false;postureGuard.clear();app.render();};
document.addEventListener('keydown',event=>{if(event.key==='Escape'&&window.ergoPostureLocked){event.preventDefault();bypassGuard();}});
el('demo').addEventListener('change',()=>{pending=null;lastNotice=0;reliefUntil=0;suppressedUntil=0;publish();});
el('simulate-commit').onclick=()=>contextBreak('コミット完了');
if(el('simulate-face-close')){
 el('simulate-face-close').onclick=()=>{
  if(currentZoom>=125)applyPageZoom(100);
  wasFaceClose=false;
  faceCloseStreak=1;
  simulatedFaceCloseUntil=Date.now()+8000;
  app.render();
 };
}
if(el('accept-zoom')){
 el('accept-zoom').onclick=()=>{
  const next=currentZoom<115?115:125;
  applyPageZoom(next);
  zoomSuggested=false;
  simulatedFaceCloseUntil=0;
  wasFaceClose=false;
  recordInsight('zoomAccepted');
  if(el('face-zoom-box'))el('face-zoom-box').hidden=true;
  el('quick-state').textContent='表示を'+next+'%に大きくしました。画面から少し離れて楽な姿勢で作業できます。';
 };
}
if(el('dismiss-zoom')){
 el('dismiss-zoom').onclick=()=>{
  zoomSuggested=false;
  zoomDismissedUntil=Date.now()+300000;
  simulatedFaceCloseUntil=0;
  if(el('face-zoom-box'))el('face-zoom-box').hidden=true;
 };
}
el('desktop-notify').onclick=async()=>{
 const note=el('desktop-notify-status');
 if(!('Notification' in window)||!window.isSecureContext){note.textContent='この環境では通知を使えません。PCで http://localhost:8000 またはHTTPSから開いてください。';return;}
 try{const permission=await Notification.requestPermission();note.textContent=permission==='granted'?'通知を有効にしました。別アプリ作業の時間が来るとPCで知らせます。':'通知は許可されていません。ブラウザーのサイト設定から変更できます。';}
 catch{note.textContent='通知権限の確認に失敗しました。ブラウザーの設定を確認してください。';}
};

function setJoinUrl(url){el('phone-link').value=url||'';const box=el('phone-qr-box');try{if(!url||!globalThis.ErgoQR)throw Error();el('phone-qr').innerHTML=ErgoQR.toSvg(url);box.hidden=false;}catch{el('phone-qr').innerHTML='';box.hidden=true;}}
function fillJoinChoices(urls){const select=el('phone-link-choice'),many=urls.length>1;select.innerHTML='';urls.forEach(u=>{const o=document.createElement('option');o.value=u;o.textContent=new URL(u).hostname;select.appendChild(o);});select.hidden=!many;el('phone-link-choice-label').hidden=!many;}
const PAIR_STORAGE='ergopulse.pair';
function clearSavedPair(){try{sessionStorage.removeItem(PAIR_STORAGE);}catch{}}
function savePair(urls){try{sessionStorage.setItem(PAIR_STORAGE,JSON.stringify({room,key,urls,expires:Date.now()+12*60*60000}));}catch{}}
function restorePair(){
 if(isPhone||location.protocol==='file:')return;
 try{
  const saved=JSON.parse(sessionStorage.getItem(PAIR_STORAGE)||'null');
  if(!saved||saved.expires<=Date.now()||!Array.isArray(saved.urls)||!saved.urls.length||!/^[\w-]{20,64}$/.test(saved.room)||!/^[\w-]{20,64}$/.test(saved.key)){clearSavedPair();return;}
  room=saved.room;key=saved.key;restoredPair=true;
  setJoinUrl(saved.urls[0]);fillJoinChoices(saved.urls);updateHook();el('pair-info').hidden=false;
  el('network-help').textContent='前回の連携を復元しています。スマホ側は同じURLを利用できます。';
  el('connection-status').textContent='スマホ連携に再接続しています…';connect();
 }catch{clearSavedPair();}
}
el('phone-link-choice').addEventListener('change',()=>{el('manual-host').value='';setJoinUrl(el('phone-link-choice').value);});
async function pair(){
 if(location.protocol==='file:'){el('connection-status').textContent='ZIP内の start_windows.bat でサーバーを起動し、localhost:8000 を開いてください。';return;}
 el('pair-phone').disabled=true;
 try{const response=await fetch('/api/session',{method:'POST'});if(!response.ok)throw Error();const session=await response.json();closed=true;clearTimeout(retry);socket?.close();closed=false;room=session.room;key=session.controller_key;restoredPair=false;el('pair-info').hidden=false;const join=session.join_urls[0];setJoinUrl(join);fillJoinChoices(session.join_urls);savePair(session.join_urls);el('network-help').textContent=join?'QRコードを読み取るか、このURLをスマホで開き、「案内を有効にする」を押します。':'IPv4アドレスを下に入力してください（Windowsの ipconfig で確認）。';el('connection-status').textContent='スマホの接続を待っています。';updateHook();connect();}catch{el('connection-status').textContent='サーバーに接続できません。start_windows.bat から起動してください。';}finally{el('pair-phone').disabled=false;}
}
function updateHook(){el('hook-command').value='curl --silent --max-time 2 -X POST -H "X-Controller-Key: '+key+'" "'+location.origin+'/api/git-commit-hook/'+room+'" >/dev/null\n';}
el('pair-phone').onclick=pair;
el('manual-host').addEventListener('input',()=>{const host=el('manual-host').value.trim();if(/^\d{1,3}(\.\d{1,3}){3}$/.test(host)&&host.split('.').every(x=>+x<=255))setJoinUrl(location.protocol+'//'+host+(location.port?':'+location.port:'')+'/?phone='+encodeURIComponent(room));});

function stopCamera(){cameraGeneration++;clearInterval(cameraTimer);worker?.terminate();worker=null;ready=false;inFlight=false;inferenceMs=0;nextFrameAt=0;cameraStream?.getTracks().forEach(t=>t.stop());cameraStream=null;el('video').srcObject=null;el('video').hidden=true;el('camera').textContent='カメラ検知を開始';el('recalibrate').hidden=true;sensor=null;el('camera-note').textContent='カメラを停止しました。';}
async function startCamera(){
 if(cameraBusy)return;if(cameraStream){stopCamera();return;}cameraBusy=true;el('camera').disabled=true;const generation=++cameraGeneration;
 try{
  if(location.protocol==='file:')throw Error('カメラ検知は付属サーバーを起動し、http://localhost:8000 で開いてください。');
  if(!navigator.mediaDevices?.getUserMedia)throw Error('カメラを使うPCでは http://localhost:8000 またはHTTPSで開いてください。');
  el('camera-note').textContent='カメラと検知モデルを準備しています…';
  cameraStream=await navigator.mediaDevices.getUserMedia({video:{width:640,height:480},audio:false});el('video').srcObject=cameraStream;el('video').hidden=false;await el('video').play();
  worker=new Worker(base+'vision-worker.js');worker.onmessage=({data})=>{
   if(generation!==cameraGeneration)return;
   if(data.type==='ready'){ready=true;el('camera').textContent='カメラ検知を停止';el('recalibrate').hidden=false;el('camera-note').textContent='楽な姿勢で3秒お待ちください。顔と両肩が映るようにします。';worker.postMessage({type:'calibrate',now:performance.now()});}
   if(data.type==='result'){inFlight=false;const duration=Math.max(0,performance.now()-frameStarted);inferenceMs=inferenceMs?inferenceMs*.7+duration*.3:duration;nextFrameAt=performance.now()+Math.max(document.hidden?250:70,Math.min(500,inferenceMs*.7));sensor={...data.result,received:Date.now()};el('sensor-status').textContent=!sensor.tracked?'顔と両肩をカメラに映してください。':sensor.calibrating?'基準登録 '+sensor.calibrationProgress+'% · '+sensor.calibrationHint:!sensor.calibrated?'基準未登録。「登録し直す」を押してください。':'姿勢の目安 '+sensor.score+' / 100 · '+(sensor.reason||'大きな変化はありません')+' · まばたき '+(sensor.blinkLearning?'学習中（約2分）':sensor.blinkRate===null?'顔を確認中':sensor.blinkRate+'回/分');if(recovery){recovery.progress=sensor.progress;if(sensor.complete)finishRecovery();}}
   if(data.type==='error'){stopCamera();el('camera-note').textContent='検知モデルを起動できませんでした。モデル同梱ファイルとブラウザーを確認してください。';console.error(data.message);}
  };
  worker.onerror=error=>{stopCamera();el('camera-note').textContent='カメラ検知を開始できません。付属サーバーとモデルファイルを確認してください。';console.error(error.message);};worker.postMessage({type:'init'});
  previousFrameTime=-1;cameraTimer=setInterval(async()=>{
   if(!ready||el('demo').checked)return;
   const work=app.get();
   // An explicitly started session may keep the opted-in camera active while this tab is hidden.
   if(document.hidden&&(!work.externalSession||work.sessionPaused))return;
   if(performance.now()<nextFrameAt)return;
   if(inFlight){if(performance.now()-frameStarted>10000){stopCamera();el('camera-note').textContent='カメラ処理が停止しました。もう一度開始してください。';}return;}
   const video=el('video');if(video.readyState<2||video.currentTime===previousFrameTime)return;previousFrameTime=video.currentTime;inFlight=true;frameStarted=performance.now();
   try{const bitmap=await createImageBitmap(video);if(generation!==cameraGeneration||!worker){bitmap.close();inFlight=false;return;}worker.postMessage({type:'frame',bitmap,now:performance.now()},[bitmap]);}catch{inFlight=false;}
  },80);
 }catch(error){stopCamera();el('camera-note').textContent=error.name==='NotAllowedError'?'カメラの使用を許可してください。':error.message||'カメラを開けませんでした。';}finally{cameraBusy=false;el('camera').disabled=false;}
}
el('camera').onclick=startCamera;el('recalibrate').onclick=()=>{sensor=null;worker?.postMessage({type:'calibrate',now:performance.now()});};

function readQuickPref(name,defaultValue){
 try{const stored=readQuickValue(name);return stored===null?defaultValue:stored!=='false';}
 catch{return defaultValue;}
}
function readQuickValue(name){try{return localStorage.getItem('ergopulse.'+name);}catch{return null;}}
function saveQuickPref(name,value){try{localStorage.setItem('ergopulse.'+name,String(value));}catch{}}
function relaySettingChange(target){target.dispatchEvent(new Event('change'));}
function updateQuickPanel(a,postureScore,demo,close){
 if(isPhone)return;
 const measured=Number.isFinite(postureScore)&&!demo;
 el('quick-face-warning').hidden=!close;
 el('quick-score').textContent=measured?String(Math.round(postureScore)):'—';
 el('quick-running').textContent=!a.started?'停止中':a.sessionPaused?'一時停止中':!cameraStream?'カメラ待ち':measured?'計測中':'調整中';
 el('quick-state').textContent=demo?'デモ中：Windowsのねこは動きません。':close?(zoomSuggested?'「顔が近い」が繰り返されています。上のボタンで文字を大きくできます。':'画面から少し離れて、楽な位置に戻ってみよう。'):a.sessionPaused?'作業計測を一時停止しています。':measured?postureScore<60?(el('quick-cat-growth').checked?'悪い姿勢が続くと、ねこが画面の半分ほどまで大きくなります。':'姿勢が崩れています。楽な姿勢に戻ってみよう。'):'姿勢を計測しています。':cameraStream?el('sensor-status').textContent||el('camera-note').textContent:el('camera-note').textContent;
 el('quick-camera').textContent=cameraBusy?'カメラの準備中…':cameraStream?'カメラを停止':'カメラを開始・再試行';
 el('quick-camera').disabled=cameraBusy;
 el('quick-recalibrate').disabled=!ready||!cameraStream;
 el('quick-session').textContent=!a.externalSession?'作業計測を開始':a.sessionPaused?'作業計測を再開':'作業計測を一時停止';
}
function initializeQuickControls(){
 const auto=el('quick-auto-camera'),cat=el('quick-cat-enabled'),motion=el('quick-cat-motion'),pause=el('quick-cat-pause'),growth=el('quick-cat-growth'),adaptiveCat=el('quick-adaptive-cat'),zoom=el('quick-zoom');
 auto.checked=readQuickPref('autoCamera',true);
 cat.checked=readQuickPref('floatingCat',true);
 motion.checked=readQuickPref('catMotion',true);
 growth.checked=readQuickPref('catGrowth',true);
 // Growth is the new default. A full-screen pause would hide the enlarging cat.
 pause.checked=!growth.checked&&readQuickPref('catPause',false);
 if(adaptiveCat)adaptiveCat.checked=readQuickPref('adaptiveCat',true);
 const savedZoom=readQuickValue('pageZoom');
 applyPageZoom(['100','115','125'].includes(savedZoom)?Number(savedZoom):100,false);
 el('guard-enabled').checked=cat.checked;
 const savedDuration=readQuickValue('notificationDelay');
 if(['5','6','10'].includes(savedDuration))el('guard-duration').value=savedDuration;
 el('quick-duration').value=el('guard-duration').value;
 el('quick-interval').value=el('interval').value;
 auto.addEventListener('change',()=>saveQuickPref('autoCamera',auto.checked));
 motion.addEventListener('change',()=>{saveQuickPref('catMotion',motion.checked);app.render();});
 pause.addEventListener('change',()=>{if(pause.checked){growth.checked=false;saveQuickPref('catGrowth',false);}saveQuickPref('catPause',pause.checked);app.render();});
 growth.addEventListener('change',()=>{if(growth.checked){pause.checked=false;saveQuickPref('catPause',false);}saveQuickPref('catGrowth',growth.checked);app.render();});
 if(adaptiveCat)adaptiveCat.addEventListener('change',()=>{saveQuickPref('adaptiveCat',adaptiveCat.checked);app.render();});
 if(zoom)zoom.addEventListener('change',()=>{applyPageZoom(Number(zoom.value),true);if(Number(zoom.value)>=115){zoomSuggested=false;if(el('face-zoom-box'))el('face-zoom-box').hidden=true;}app.render();});
 cat.addEventListener('change',()=>{
  el('guard-enabled').checked=cat.checked;relaySettingChange(el('guard-enabled'));
 });
 el('guard-enabled').addEventListener('change',()=>{cat.checked=el('guard-enabled').checked;saveQuickPref('floatingCat',cat.checked);});
 el('quick-duration').addEventListener('change',()=>{
  el('guard-duration').value=el('quick-duration').value;relaySettingChange(el('guard-duration'));
 });
 el('guard-duration').addEventListener('change',()=>{
  el('quick-duration').value=el('guard-duration').value;
  saveQuickPref('notificationDelay',el('guard-duration').value);
 });
 el('quick-interval').addEventListener('change',()=>{
  el('interval').value=el('quick-interval').value;relaySettingChange(el('interval'));
 });
 el('interval').addEventListener('change',()=>{el('quick-interval').value=el('interval').value;});
 el('quick-camera').onclick=()=>el('camera').onclick();
 el('quick-recalibrate').onclick=()=>el('recalibrate').onclick();
 el('quick-session').onclick=()=>el('work-session').onclick();
 // This callback runs after the page has loaded. Browser/OS camera permission
 // cannot be bypassed: on first use the user must approve the native prompt.
 if(auto.checked&&location.protocol!=='file:')setTimeout(()=>{
  if(!el('quick-auto-camera').checked||el('demo').checked||isPhone)return;
  if(!app.get().externalSession)el('work-session').onclick();
  if(!cameraStream&&!cameraBusy)startCamera();
 },0);
}

function phoneUpdate(state){
 const online=state.pc_online!==false;el('phone-connection').textContent=online?'PCと接続中':'PCの接続を待っています';el('phone-start').disabled=!online;
 if(!online){silence();el('phone-message').textContent='PCの接続が切れました。PC側で連携を開始してください。';el('phone-start').hidden=true;return;}
 const active=state.mode==='buddy',moving=state.mode==='recovery';
 el('phone-card').classList.toggle('notice',active||moving);el('phone-figure').classList.toggle('shoulder',state.exercise==='shoulder');el('phone-arms').setAttribute('d',state.exercise==='shoulder'?'M60 57L35 68L31 96M60 57L85 68L89 96':'M60 57L37 48L24 15M60 57L83 48L96 15');
 el('phone-title').textContent=moving?'ゆっくり、体を動かす。':active?'今のうちに、15秒。':'作業の区切りに、ひと息。';
 el('phone-message').textContent=moving?(state.exercise==='shoulder'?'肩をゆっくり回しましょう。PC側では肩の上下動を3回以上、15秒かけて確認します。':'PCカメラの前で、両手を肩より上に15秒保ちましょう。'):active?'手が止まった今、15秒だけ体を動かしませんか。':'PCで入力している間は、音声で割り込みません。';
 el('phone-start').hidden=!phoneEnabled||!active;el('phone-defer').hidden=!phoneEnabled||!active;el('phone-cancel').hidden=!moving;el('phone-replay').hidden=!phoneEnabled||(!active&&!moving);
 el('phone-progress').textContent=moving?(state.tracking?Math.round(state.progress||0)+'%':state.remaining>0?'残り '+state.remaining+'秒':'PCで完了を確認'):'15秒';el('phone-bar').style.width=(moving?state.progress||0:0)+'%';
 if(state.type==='recovered'){el('phone-title').textContent='おつかれさまでした。';el('phone-message').textContent='PCの視界をクリアにしました。自分のペースで再開しましょう。';el('phone-progress').textContent='完了';el('phone-bar').style.width='100%';silence();}
 if(state.mode==='ambient'||state.mode==='standby'||state.mode==='rest')silence();
 if(state.type==='intervene'&&state.event_id!==lastEvent&&phoneEnabled){lastEvent=state.event_id;navigator.vibrate?.([180,80,180]);say(state.exercise==='shoulder'?'今のうちに15秒だけ、肩をゆっくり回しましょう。':'今のうちに15秒だけ、両手を上げて伸びをしましょう。');}
}
if(isPhone){
 document.body.classList.add('phone-mode');el('phone-screen').hidden=false;room=isPhone;
 el('phone-enable').onclick=()=>{phoneEnabled=true;el('phone-enable').hidden=true;el('phone-capability').textContent=('vibrate' in navigator?'振動は端末とブラウザーの対応状況によります。':'このブラウザーは振動に対応していません。画面と音声で案内します。')+('speechSynthesis' in window?'':' 音声にも非対応です。');say('休憩の案内を有効にしました。');if(phoneState)phoneUpdate({...phoneState,type:phoneState.mode==='buddy'?'intervene':'state'});};
 el('phone-start').onclick=()=>send({type:'start',exercise:phoneState?.exercise||'banzai'});el('phone-defer').onclick=()=>{silence();send({type:'defer'});};el('phone-cancel').onclick=()=>send({type:'cancel'});el('phone-replay').onclick=()=>say(el('phone-message').textContent);
 document.addEventListener('visibilitychange',()=>{if(document.hidden)silence();else if(!socket||socket.readyState>1)connect();});connect();
}else{restorePair();initializeQuickControls();tick();}
window.addEventListener('pagehide',()=>{closed=true;clearTimeout(retry);socket?.close();stopCamera();silence();});
})();
