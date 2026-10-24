/* Relative indicators only; thresholds are demo heuristics, not medical measurements. */
(function(root){
const clamp=(v,a=0,b=1)=>Math.max(a,Math.min(b,v));
const distance=(a,b)=>Math.hypot(a.x-b.x,a.y-b.y);
const mean=values=>values.reduce((a,b)=>a+b,0)/values.length;
const deviation=values=>{const avg=mean(values);return Math.sqrt(mean(values.map(v=>(v-avg)**2)));};
class Analyzer{
 constructor(){this.reset();}
 resetProximity(){this.faceClose=false;this.filteredFaceRatio=null;this.closeSince=null;this.farSince=null;}
 reset(){this.baseline=null;this.samples=[];this.calibrating=false;this.calibrationStart=0;this.calibrationHint='';this.filteredSeverity=null;this.filteredPostureSeverity=null;this.blinks=[];this.firstFace=0;this.blinkBaseline=null;this.closedAt=null;this.lastBlink=0;this.lastSample=0;this.faceMissingSince=0;this.exercise=null;this.resetProximity();}
 calibrate(now){this.samples=[];this.calibrating=true;this.calibrationStart=now;this.calibrationHint='顔と両肩を映して、楽な姿勢で静止してください。';this.baseline=null;this.filteredSeverity=null;this.filteredPostureSeverity=null;this.blinks=[];this.firstFace=0;this.blinkBaseline=null;this.faceMissingSince=0;this.resetProximity();}
 startExercise(kind,now){this.exercise={kind,start:now,hold:0,miss:0,cycles:0,up:false,neutral:null,lastSeen:now};}
 cancelExercise(){this.exercise=null;}
 process(pose,face,blend,now){
  if(this.lastSample&&now-this.lastSample>2000){this.firstFace=0;this.blinks=[];this.blinkBaseline=null;this.closedAt=null;this.filteredSeverity=null;this.filteredPostureSeverity=null;this.resetProximity();}const dt=Math.min(0.25,Math.max(0,(now-this.lastSample)/1000));this.lastSample=now;
  const valid=p=>p&&Number.isFinite(p.x)&&Number.isFinite(p.y)&&(p.visibility===undefined||p.visibility>.55);
  // Face proximity remains observable even when a close face pushes shoulders out of frame.
  const measuredFaceWidth=valid(face?.[234])&&valid(face?.[454])?distance(face[234],face[454]):null;
  const faceWidth=Number.isFinite(measuredFaceWidth)&&measuredFaceWidth>.02?measuredFaceWidth:null;
  const tracked=pose&&[pose[0],pose[11],pose[12]].every(valid);let metrics=null;
  if(tracked){const [nose,l,r]=[pose[0],pose[11],pose[12]],width=Math.max(.02,distance(l,r)),gap=((l.y+r.y)/2-nose.y)/width;
   const tilt=Math.atan((l.y-r.y)/(l.x-r.x||.001))*180/Math.PI;
   metrics={gap,faceWidth,tilt};
   if(this.calibrating&&faceWidth&&gap>.08){
    if(!this.samples.length)this.calibrationStart=now;
    this.samples.push(metrics);
    if(now-this.calibrationStart>=3000&&this.samples.length>=10){
     const gaps=this.samples.map(x=>x.gap),widths=this.samples.map(x=>x.faceWidth);
     if(deviation(gaps)<Math.max(.10,Math.abs(mean(gaps))*.12)&&deviation(widths)<Math.max(.012,mean(widths)*.10)){
      this.baseline={gap:mean(gaps),faceWidth:mean(widths),tilt:mean(this.samples.map(x=>x.tilt))};this.calibrating=false;this.calibrationHint='基準を登録しました。';
     }else{this.samples=[];this.calibrationStart=now;this.calibrationHint='動きが大きいため、もう一度3秒間静止してください。';}
    }
   }
  }
  if(this.calibrating&&(!metrics||!metrics.faceWidth||metrics.gap<=.08)){this.samples=[];this.calibrationStart=now;}
  if(!this.baseline||!faceWidth){this.resetProximity();}
  else{
   const ratio=faceWidth/this.baseline.faceWidth,blend=1-Math.exp(-dt/.35);
   this.filteredFaceRatio=this.filteredFaceRatio===null?ratio:this.filteredFaceRatio+(ratio-this.filteredFaceRatio)*blend;
   // A sustained 25% increase is an app heuristic, not a distance in centimetres.
   if(!this.faceClose){
    this.farSince=null;
    if(this.filteredFaceRatio>=1.25){if(this.closeSince===null)this.closeSince=now;if(now-this.closeSince>=1000)this.faceClose=true;}
    else this.closeSince=null;
   }else if(this.filteredFaceRatio<=1.15){
    if(this.farSince===null)this.farSince=now;
    if(now-this.farSince>=750){this.faceClose=false;this.closeSince=null;this.farSince=null;}
   }else this.farSince=null;
  }
  let blinkRate=null,blinkReduced=false;
  if(face?.length){
   this.faceMissingSince=0;
   if(!this.firstFace)this.firstFace=now;
   const left=blend?.find(x=>x.categoryName==='eyeBlinkLeft')?.score,right=blend?.find(x=>x.categoryName==='eyeBlinkRight')?.score;
   const closed=left!==undefined&&right!==undefined?(left+right)/2>.5:false;
   if(closed&&this.closedAt===null)this.closedAt=now;
   if(!closed&&this.closedAt!==null){const duration=now-this.closedAt;if(duration>=40&&duration<900&&now-this.lastBlink>180){this.blinks.push(now);this.lastBlink=now;}this.closedAt=null;}
   this.blinks=this.blinks.filter(t=>now-t<60000);
   if(now-this.firstFace>=60000){blinkRate=this.blinks.length;if(this.blinkBaseline===null)this.blinkBaseline=blinkRate;}
   blinkReduced=now-this.firstFace>=120000&&this.blinkBaseline>=6&&blinkRate<this.blinkBaseline*.6;
  }else{
   // A single missed face frame must not erase the two-minute blink baseline.
   this.closedAt=null;if(!this.faceMissingSince)this.faceMissingSince=now;
   if(now-this.faceMissingSince>3000){this.firstFace=0;this.blinks=[];this.blinkBaseline=null;}
  }
  let slouch=0,close=0,tilt=0;
  if(this.baseline&&metrics){slouch=clamp((this.baseline.gap-metrics.gap)/Math.max(.1,this.baseline.gap*.45));close=metrics.faceWidth?clamp((metrics.faceWidth/this.baseline.faceWidth-1)/.5):0;tilt=clamp(metrics.tilt-this.baseline.tilt,-12,12);}
  const severity=Math.max(slouch,close,blinkReduced?.65:0);
  // Locking work should react to physical posture/proximity, never blink-rate alone.
  const postureSeverity=Math.max(slouch,close);
  // Smooth noisy single-frame landmarks without modifying the raw posture measurement.
  if(!tracked||!this.baseline){this.filteredSeverity=null;this.filteredPostureSeverity=null;}
  else if(this.filteredSeverity===null){this.filteredSeverity=severity;this.filteredPostureSeverity=postureSeverity;}
  else{const blend=1-Math.exp(-dt/.5);this.filteredSeverity+=(severity-this.filteredSeverity)*blend;this.filteredPostureSeverity+=(postureSeverity-this.filteredPostureSeverity)*blend;}
  const score=Math.round(100-(this.filteredSeverity??0)*65);
  const postureScore=Math.round(100-(this.filteredPostureSeverity??0)*65);
  let progress=0,complete=false,cycles=0,exerciseTrackable=false;
  if(this.exercise){const e=this.exercise;
   exerciseTrackable=!!tracked&&(e.kind!=='banzai'||[pose[15],pose[16]].every(valid));
   if(tracked){if(now-e.lastSeen>1000){e.hold=0;e.up=false;e.neutral=null;}e.lastSeen=now;
    if(e.kind==='banzai'){const raised=[pose[15],pose[16]].every(valid)&&pose[15].y<pose[11].y-.07&&pose[16].y<pose[12].y-.07;if(raised){e.hold+=dt;e.miss=0;}else{e.miss+=dt;if(e.miss>1)e.hold=0;}progress=clamp(e.hold/15)*100;complete=e.hold>=15;}
    else{if(e.neutral===null)e.neutral=metrics.gap;const lifted=metrics.gap<e.neutral-.12;if(lifted)e.up=true;if(e.up&&metrics.gap>e.neutral-.04){e.cycles++;e.up=false;}progress=Math.min(clamp(e.cycles/3),clamp((now-e.start)/15000))*100;complete=e.cycles>=3&&now-e.start>=15000;cycles=e.cycles;}
   }else{e.hold=0;progress=0;}
  }
  const reasons=[];if(slouch>.45)reasons.push('上体の沈み込み');if(this.faceClose)reasons.push('顔が近い');if(blinkReduced)reasons.push('まばたきの減少');
  return {tracked,faceTracked:!!faceWidth,faceClose:this.faceClose,faceRatio:this.filteredFaceRatio,calibrated:!!this.baseline,calibrating:this.calibrating,calibrationProgress:this.calibrating&&this.samples.length?Math.min(99,Math.round((now-this.calibrationStart)/30)):this.calibrating?0:100,calibrationHint:this.calibrationHint,score,postureScore,severity,tilt,blinkRate,blinkLearning:!!this.firstFace&&now-this.firstFace<120000,reason:reasons.join('・'),progress,complete,cycles,exerciseTrackable};
 }
}
root.ErgoAnalyzer=Analyzer;
})(globalThis);
