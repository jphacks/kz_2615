/* Optional, aggregate-only local insights. No images, landmark coordinates or memo text are retained. */
(function(root){
'use strict';
const DATA_KEY='ergopulse.insights.v1',SETTINGS_KEY='ergopulse.insights.preferences';
const nonnegative=value=>Number.isFinite(value)&&value>=0?Math.min(value,1e12):0;
const dateKey=date=>[date.getFullYear(),String(date.getMonth()+1).padStart(2,'0'),String(date.getDate()).padStart(2,'0')].join('-');
const FIELDS=[
 'workMs','trackedMs','riskMs','offered','started','completed','promptCompleted','deferred','cancelled','restCompleted',
 'faceCloseCount','faceCloseNormal','faceCloseZoomed','zoomAccepted',
 'recoveryCount','recoveryMsTotal','giantRecoveryCount','giantRecoveryMs','quietRecoveryCount','quietRecoveryMs',
 'dismissedCount','annoyanceSum','annoyanceCount'
];

class InsightsStore{
 constructor(storage,now=()=>Date.now()){
  this.storage=storage;this.now=now;this.lastWrite=0;this.lastPosture=null;
  const prefs=this.read(SETTINGS_KEY,{});
  this.enabled=prefs.enabled===true;this.adaptive=this.enabled&&prefs.adaptive===true;
  const data=this.read(DATA_KEY,{});
  this.days={};
  if(data.days&&typeof data.days==='object'&&!Array.isArray(data.days)){
   for(const [key,row] of Object.entries(data.days))if(/^\d{4}-\d{2}-\d{2}$/.test(key)&&row&&typeof row==='object'&&!Array.isArray(row))this.days[key]=row;
  }
  this.feedback=Array.isArray(data.feedback)?data.feedback.filter(v=>v===1||v===-1||v===-2).slice(-10):[];
  this.catEvents=Array.isArray(data.catEvents)?data.catEvents.filter(e=>e&&typeof e==='object').slice(-12):[];
 }
 read(key,fallback){try{return JSON.parse(this.storage.getItem(key))??fallback;}catch{return fallback;}}
 day(){return dateKey(new Date(this.now()));}
 entry(){
  const key=this.day(),row=this.days[key]??{};
  const normalized={};
  for(const name of FIELDS)normalized[name]=nonnegative(row[name]);
  this.days[key]=normalized;
  return normalized;
 }
 save(force=false){
  if(!this.enabled)return;
  const now=this.now();if(!force&&now-this.lastWrite<5000)return;
  this.lastWrite=now;
  const recent=Object.keys(this.days).sort().slice(-60),days={};for(const key of recent)days[key]=this.days[key];
  this.days=days;
  try{this.storage.setItem(DATA_KEY,JSON.stringify({days,feedback:this.feedback,catEvents:this.catEvents}));}catch{}
 }
 savePreferences(){try{this.storage.setItem(SETTINGS_KEY,JSON.stringify({enabled:this.enabled,adaptive:this.adaptive}));}catch{}}
 setEnabled(value){this.enabled=!!value;if(!this.enabled){this.adaptive=false;this.reset();}this.savePreferences();}
 setAdaptive(value){this.adaptive=this.enabled&&!!value;this.savePreferences();}
 reset(){this.days={};this.feedback=[];this.catEvents=[];this.lastPosture=null;try{this.storage.removeItem(DATA_KEY);}catch{}}
 addWork(ms){if(!this.enabled||!Number.isFinite(ms)||ms<=0)return;this.entry().workMs+=Math.min(ms,15*60000);this.save();}
 observePosture(measured,risk,time=this.now()){
  const previous=this.lastPosture;this.lastPosture=time;
  if(!this.enabled||!measured||previous===null)return;
  const delta=Math.max(0,Math.min(1200,time-previous));
  this.entry().trackedMs+=delta;if(risk)this.entry().riskMs+=delta;
  this.save();
 }
 record(kind){
  if(!this.enabled)return;
  const field={
   offered:'offered',started:'started',completed:'completed',promptCompleted:'promptCompleted',
   deferred:'deferred',cancelled:'cancelled',restCompleted:'restCompleted',
   dismissed:'dismissedCount',zoomAccepted:'zoomAccepted',
   faceCloseNormal:'faceCloseNormal',faceCloseZoomed:'faceCloseZoomed'
  }[kind];
  if(!field)return;
  const d=this.entry();
  d[field]++;
  if(kind==='faceCloseNormal'||kind==='faceCloseZoomed')d.faceCloseCount++;
  if(kind==='dismissed'){
   this.catEvents.push({kind:'dismiss',ms:0});
   this.catEvents=this.catEvents.slice(-12);
  }
  if(kind==='completed'||kind==='deferred'||kind==='cancelled'){
   this.feedback.push(kind==='completed'?1:kind==='deferred'?-1:-2);
   this.feedback=this.feedback.slice(-10);
  }
  this.save(true);
 }
 recordFaceClose(zoomed=false){
  this.record(zoomed?'faceCloseZoomed':'faceCloseNormal');
 }
 recordRecovery(recoveryMs,mode='giant'){
  if(!this.enabled||!Number.isFinite(recoveryMs)||recoveryMs<=0)return;
  const clamped=Math.min(300000,Math.max(500,Math.round(recoveryMs)));
  const d=this.entry();
  d.recoveryCount++;
  d.recoveryMsTotal+=clamped;
  if(mode==='quiet'){d.quietRecoveryCount++;d.quietRecoveryMs+=clamped;}
  else{d.giantRecoveryCount++;d.giantRecoveryMs+=clamped;}
  this.catEvents.push({kind:'recover',ms:clamped,mode});
  this.catEvents=this.catEvents.slice(-12);
  this.save(true);
 }
 recordAnnoyance(score){
  const n=Number(score);
  if(!this.enabled||!Number.isFinite(n)||n<1||n>5)return;
  const d=this.entry();
  d.annoyanceSum+=Math.round(n);
  d.annoyanceCount++;
  this.save(true);
 }
 recommendedCatStyle(){
  const recovers=this.catEvents.filter(e=>e.kind==='recover');
  const dismissals=this.catEvents.filter(e=>e.kind==='dismiss').length;
  const avgSec=recovers.length?Math.round(recovers.reduce((s,e)=>s+(e.ms||0),0)/recovers.length/1000):null;
  if(!this.enabled||!this.adaptive||(recovers.length+dismissals<2)){
   return {mode:'standard',triggerBonusSec:0,preferGiant:true,avgSec,dismissals,label:'標準（反応を記録しながら、画面半分までの巨大化を使用します）'};
  }
  if((avgSec!==null&&avgSec<=8&&dismissals===0)||(dismissals>=2&&dismissals>=recovers.length)){
   return {mode:'gentle',triggerBonusSec:4,preferGiant:false,avgSec,dismissals,label:'控えめモード（小さな通知で戻せる・または×で閉じられたため、通知開始を+4秒遅らせ控えめに調整中）'};
  }
  return {mode:'giant',triggerBonusSec:0,preferGiant:true,avgSec,dismissals,label:'巨大ねこ優先モード（小さな通知より巨大ねこの演出で姿勢が戻っています）'};
 }
 effectiveGap(baseMinutes){
  const base=Math.max(1,Math.min(30,Number(baseMinutes)||5));
  if(!this.enabled||!this.adaptive)return base;
  const score=this.feedback.reduce((sum,value)=>sum+value,0);
  // Adaptation only reduces interruption frequency; it never becomes more frequent than the user's setting.
  return Math.min(30,Math.max(base,Math.round(base*(1+Math.min(1.5,Math.max(0,-score)*.18)))));
 }
 recent(days=7){
  const result=[];const date=new Date(this.now());date.setHours(12,0,0,0);
  for(let i=days-1;i>=0;i--){
   const d=new Date(date);d.setDate(date.getDate()-i);const key=dateKey(d);const raw=this.days[key]??{};
   const item={day:key};
   for(const name of FIELDS)item[name]=nonnegative(raw[name]);
   result.push(item);
  }
  return result;
 }
 csv(){
  const header=[
   '日付','作業分','姿勢測定分','姿勢変化分','案内回数','動作開始回数','動作完了回数','提案からの動作完了回数','延期回数','中止回数','通常休憩完了回数',
   '顔接近回数(合計)','顔接近回数(標準表示)','顔接近回数(拡大表示)','文字拡大採用回数',
   '姿勢復帰回数','平均姿勢復帰秒数','巨大ねこ平均復帰秒数','文字通知平均復帰秒数','通知を閉じた回数','邪魔度評価平均(1-5)'
  ];
  const rows=Object.keys(this.days).sort().map(day=>{
   const d=this.days[day]??{};
   const avgRec=nonnegative(d.recoveryCount)>0?(nonnegative(d.recoveryMsTotal)/nonnegative(d.recoveryCount)/1000).toFixed(1):'0.0';
   const avgGiant=nonnegative(d.giantRecoveryCount)>0?(nonnegative(d.giantRecoveryMs)/nonnegative(d.giantRecoveryCount)/1000).toFixed(1):'0.0';
   const avgQuiet=nonnegative(d.quietRecoveryCount)>0?(nonnegative(d.quietRecoveryMs)/nonnegative(d.quietRecoveryCount)/1000).toFixed(1):'0.0';
   const avgAnnoy=nonnegative(d.annoyanceCount)>0?(nonnegative(d.annoyanceSum)/nonnegative(d.annoyanceCount)).toFixed(2):'';
   return [
    day,
    ...['workMs','trackedMs','riskMs'].map(k=>(nonnegative(d[k])/60000).toFixed(2)),
    ...['offered','started','completed','promptCompleted','deferred','cancelled','restCompleted',
        'faceCloseCount','faceCloseNormal','faceCloseZoomed','zoomAccepted','recoveryCount'].map(k=>String(nonnegative(d[k]))),
    avgRec,avgGiant,avgQuiet,
    String(nonnegative(d.dismissedCount)),
    avgAnnoy
   ].join(',');
  });
  return '\uFEFF'+[header.join(','),...rows].join('\r\n');
 }
}

root.ErgoInsightsStore=InsightsStore;
if(!root.document?.getElementById('insights-enabled'))return;
let localStore;
try{localStore=root.localStorage;}catch{localStore={getItem:()=>null,setItem(){},removeItem(){}};}
const el=id=>document.getElementById(id),store=new InsightsStore(localStore);
let lastRender=0;
function draw(force=false){
 const now=Date.now();if(!force&&now-lastRender<2500)return;lastRender=now;
 el('insights-enabled').checked=store.enabled;el('adaptive-enabled').checked=store.adaptive;el('adaptive-enabled').disabled=!store.enabled;
 el('insights-data').hidden=!store.enabled;el('insights-intro').hidden=store.enabled;
 if(!store.enabled)return;
 const recent=store.recent(),today=recent[recent.length-1],total=recent.reduce((v,d)=>v+d.workMs,0);
 el('insights-work').textContent=Math.floor(today.workMs/60000)+'分';
 el('insights-risk').textContent=today.trackedMs>=5000?Math.round(today.riskMs/today.trackedMs*100)+'%':'未計測';
 el('insights-breaks').textContent=today.completed+'回';
 el('insights-acceptance').textContent=today.offered>0?Math.min(100,Math.round(today.promptCompleted/today.offered*100))+'%':'—';
 if(el('insights-recovery-time')){
  el('insights-recovery-time').textContent=today.recoveryCount>0?(today.recoveryMsTotal/today.recoveryCount/1000).toFixed(1)+'秒':'—';
 }
 if(el('insights-dismissed')){
  el('insights-dismissed').textContent=today.dismissedCount+'回';
 }
 if(el('insights-face-zoom')){
  el('insights-face-zoom').textContent='標準 '+today.faceCloseNormal+'回 / 拡大後 '+today.faceCloseZoomed+'回';
 }
 if(el('insights-annoyance-value')){
  el('insights-annoyance-value').textContent=today.annoyanceCount>0?(today.annoyanceSum/today.annoyanceCount).toFixed(1)+' / 5':'未回答';
 }
 const max=Math.max(60000,...recent.map(d=>d.workMs));
 el('insights-bars').innerHTML=recent.map(d=>{const value=Math.max(0,Math.min(100,d.workMs/max*100));const display=Math.round(d.workMs/60000);return '<div class="insights-day"><div class="insights-bar" title="'+d.day+'：'+display+'分"><i style="height:'+value.toFixed(1)+'%"></i></div><span>'+d.day.slice(5)+'</span></div>';}).join('');
 el('insights-bars').setAttribute('aria-label','過去7日間の作業時間：'+recent.map(d=>d.day+' '+Math.round(d.workMs/60000)+'分').join('、'));
 const catStyle=store.recommendedCatStyle();
 el('adaptive-state').textContent=store.adaptive?'現在の通知間隔：'+store.effectiveGap(Number(el('notice-gap').value))+'分（設定値より頻繁には通知しません） · ねこの注意方法：'+catStyle.label:'自動調整はオフです。';
 el('insights-note').textContent='直近7日間の記録時間 '+Math.floor(total/60000)+'分。姿勢を戻すまでの平均秒数・通知を閉じた回数・表示拡大前後の顔接近回数を比較できます。いずれも個人の医療診断ではありません。';
}
el('insights-enabled').addEventListener('change',()=>{store.setEnabled(el('insights-enabled').checked);draw(true);});
el('adaptive-enabled').addEventListener('change',()=>{store.setAdaptive(el('adaptive-enabled').checked);draw(true);});
if(el('annoyance-record')){
 el('annoyance-record').onclick=()=>{
  if(!store.enabled)return;
  store.recordAnnoyance(el('annoyance-rating')?.value||3);
  draw(true);
 };
}
el('insights-reset').onclick=()=>{if(root.confirm?.('このブラウザーに保存した作業・姿勢・休憩の履歴を削除しますか？')!==true)return;store.reset();draw(true);};
el('insights-export').onclick=()=>{
 if(!store.enabled)return;
 const blob=new Blob([store.csv()],{type:'text/csv;charset=utf-8'}),url=URL.createObjectURL(blob),link=document.createElement('a');
 link.href=url;link.download='ErgoPulse_history.csv';document.body.appendChild(link);link.click();link.remove();setTimeout(()=>URL.revokeObjectURL(url),1000);
};
root.ergoInsights={
 addWork:ms=>{store.addWork(ms);draw();},
 observePosture:(measured,risk,time)=>{store.observePosture(measured,risk,time);draw();},
 record:kind=>{store.record(kind);draw(true);},
 recordFaceClose:zoomed=>{store.recordFaceClose(zoomed);draw(true);},
 recordRecovery:(ms,mode)=>{store.recordRecovery(ms,mode);draw(true);},
 recordAnnoyance:score=>{store.recordAnnoyance(score);draw(true);},
 recommendedCatStyle:()=>store.recommendedCatStyle(),
 gapMinutes:base=>store.effectiveGap(base),
};
draw(true);
})(globalThis);
