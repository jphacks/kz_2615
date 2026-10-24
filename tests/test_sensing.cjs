const assert=require('node:assert/strict');require('../frontend/sensing.js');
function inputs(){const pose=Array.from({length:33},()=>({x:.5,y:.5,visibility:1}));pose[0]={x:.5,y:.3};pose[11]={x:.35,y:.6,visibility:1};pose[12]={x:.65,y:.6,visibility:1};pose[15]={x:.3,y:.2,visibility:1};pose[16]={x:.7,y:.2,visibility:1};const face=Array.from({length:478},()=>({x:.5,y:.3}));face[234]={x:.4,y:.3};face[454]={x:.6,y:.3};return {pose,face};}
const a=new ErgoAnalyzer(),f=inputs();let time=1000,result;const sample=(step=100,closed=false)=>{time+=step;return a.process(f.pose,f.face,[{categoryName:'eyeBlinkLeft',score:closed?.9:0},{categoryName:'eyeBlinkRight',score:closed?.9:0}],time);};
a.calibrate(time);for(let i=0;i<35;i++)result=sample();assert(result.calibrated);assert.equal(result.score,100);
f.pose[11].y=f.pose[12].y=.43;assert(sample().postureScore>60,'one noisy frame must not cause an immediate severe posture score');for(let i=0;i<14;i++)result=sample();assert(result.postureScore<60,'sustained slouch is detected');f.pose[11].y=f.pose[12].y=.6;for(let i=0;i<25;i++)sample();
f.face[234].x=.34;f.face[454].x=.66;for(let i=0;i<14;i++)result=sample();assert(result.postureScore<60,'sustained face proximity is detected');f.face[234].x=.4;f.face[454].x=.6;for(let i=0;i<25;i++)sample();
a.startExercise('banzai',time);for(let i=0;i<145;i++)result=sample();assert(!result.complete);for(let i=0;i<10;i++)result=sample();assert(result.complete);
a.startExercise('banzai',time);for(let i=0;i<100;i++)sample();f.pose[15].visibility=0;for(let i=0;i<5;i++){result=sample();assert(result.progress>0,'0.5s dropout is forgiven');assert(result.tracked);assert.equal(result.exerciseTrackable,false,'visible shoulders alone are insufficient to judge raised hands');}for(let i=0;i<7;i++)result=sample();assert.equal(result.progress,0,'over 1s without a raised wrist restarts');f.pose[15].visibility=1;assert(sample().exerciseTrackable);
a.startExercise('shoulder',time);sample();for(let i=0;i<3;i++){f.pose[11].y=f.pose[12].y=.55;sample();f.pose[11].y=f.pose[12].y=.6;sample();}result=sample();assert.equal(result.cycles,3);assert(!result.complete);for(let i=0;i<160;i++)result=sample();assert(result.complete);
a.cancelExercise();a.reset();a.calibrate(time);for(let i=0;i<35;i++)sample();for(let i=0;i<12;i++){for(let j=0;j<48;j++)sample(100);sample(100,true);result=sample(100);}assert(result.blinkRate>=10);for(let i=0;i<650;i++)result=sample();assert(result.reason.includes('まばたき'));assert.equal(result.postureScore,100,'blink slowdown cannot by itself trigger posture pause');
const b=new ErgoAnalyzer();let t=1000;b.process(f.pose,f.face,[],t);for(let i=0;i<10;i++)b.process(f.pose,null,[],t+=100);assert.equal(b.firstFace,1000,'temporary face occlusion keeps blink learning');for(let i=0;i<25;i++)b.process(f.pose,null,[],t+=100);assert.equal(b.firstFace,0,'long face occlusion resets blink learning');
const c=new ErgoAnalyzer(),j=inputs();let s=1000;c.calibrate(s);for(let i=0;i<40;i++){j.pose[11].y=j.pose[12].y=i%2?.65:.43;c.process(j.pose,j.face,[],s+=100);}assert.equal(c.baseline,null,'unstable calibration should not be accepted');j.pose[11].y=j.pose[12].y=.6;for(let i=0;i<80;i++)c.process(j.pose,j.face,[],s+=100);assert(c.baseline,'a stable new calibration window should complete');
console.log('PASS: stable calibration, smoothed posture, proximity, 15s raise, wrist fallback, shoulder cycle, blink decrease, face dropout grace');
// Proximity is a separate, sustained warning, including when shoulders leave view.
{
 const analyzer=new ErgoAnalyzer(),v=inputs();let clock=1000,out;
 analyzer.calibrate(clock);
 for(let i=0;i<35;i++)out=analyzer.process(v.pose,v.face,[],clock+=100);
 assert.equal(out.faceClose,false);
 v.face[234].x=.34;v.face[454].x=.66;
 for(let i=0;i<5;i++)out=analyzer.process(v.pose,v.face,[],clock+=100);
 assert.equal(out.faceClose,false,'a short lean toward the screen is not warned');
 for(let i=0;i<20;i++)out=analyzer.process(null,v.face,[],clock+=100);
 assert.equal(out.faceClose,true,'close faces remain detectable without shoulders');
 assert(out.reason.includes('顔が近い'));
 v.face[234].x=.38;v.face[454].x=.62;
 for(let i=0;i<30;i++)out=analyzer.process(v.pose,v.face,[],clock+=100);
 assert.equal(out.faceClose,true,'a 20% increase holds the warning without flicker');
 v.face[234].x=.4;v.face[454].x=.6;
 for(let i=0;i<30;i++)out=analyzer.process(v.pose,v.face,[],clock+=100);
 assert.equal(out.faceClose,false,'returning to the baseline clears the warning');
 v.face[234].x=.34;v.face[454].x=.66;
 for(let i=0;i<30;i++)out=analyzer.process(v.pose,v.face,[],clock+=100);
 assert.equal(out.faceClose,true);
 out=analyzer.process(v.pose,null,[],clock+=100);
 assert.equal(out.faceClose,false,'missing face clears stale proximity');
 v.face[234].x=NaN;
 out=analyzer.process(v.pose,v.face,[],clock+=100);
 assert.equal(out.faceClose,false,'invalid face coordinates are not proximity');
 assert.equal(out.faceRatio,null);
 analyzer.calibrate(clock);
 out=analyzer.process(v.pose,v.face,[],clock+=100);
 assert.equal(out.faceClose,false,'recalibration clears the old warning');
}
console.log('PASS: sustained close-face warning, independent shoulder tracking, hysteresis and loss reset');
