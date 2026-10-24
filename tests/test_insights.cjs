const assert=require('node:assert/strict');
require('../frontend/insights.js');

const values=new Map(),storage={getItem:key=>values.get(key)??null,setItem:(key,value)=>values.set(key,value),removeItem:key=>values.delete(key)};
let clock=Date.parse('2026-10-24T12:00:00');
const now=()=>clock;
const insights=new ErgoInsightsStore(storage,now);
assert.equal(insights.enabled,false,'insights are opt-in');
insights.addWork(60000);insights.record('offered');
assert.equal(insights.recent().at(-1).workMs,0,'disabled metrics do not accumulate');
assert.equal(insights.effectiveGap(5),5);

insights.setEnabled(true);insights.addWork(120000);
insights.observePosture(true,false,clock);clock+=1000;insights.observePosture(true,true,clock);
assert.equal(insights.recent().at(-1).trackedMs,1000);
assert.equal(insights.recent().at(-1).riskMs,1000);
insights.setAdaptive(true);
for(let i=0;i<3;i++){insights.record('offered');insights.record('deferred');}
assert(insights.effectiveGap(5)>5,'repeated deferrals reduce interruption frequency');
for(let i=0;i<4;i++)insights.record('completed');
insights.record('promptCompleted');
assert.equal(insights.effectiveGap(5),5,'positive feedback can return to user-selected baseline');

// Feature 1 & 2: Face-close before/after zoom, recovery time, dismissals, annoyance, and adaptive cat style
insights.recordFaceClose(false);
insights.recordFaceClose(false);
insights.record('zoomAccepted');
insights.recordFaceClose(true);
assert.equal(insights.recent().at(-1).faceCloseNormal,2);
assert.equal(insights.recent().at(-1).faceCloseZoomed,1);
assert.equal(insights.recent().at(-1).faceCloseCount,3);
assert.equal(insights.recent().at(-1).zoomAccepted,1);

insights.recordRecovery(5000,'quiet');
insights.recordRecovery(6000,'quiet');
assert.equal(insights.recommendedCatStyle().mode,'gentle','quick posture recovery recommends gentle notifications');
insights.record('dismissed');
insights.record('dismissed');
assert.equal(insights.recent().at(-1).dismissedCount,2);
assert.equal(insights.recommendedCatStyle().mode,'gentle','repeated dismissals also keep notifications gentle');

insights.recordAnnoyance(2);
insights.recordAnnoyance(4);
assert.equal(insights.recent().at(-1).annoyanceCount,2);
assert.equal(insights.recent().at(-1).annoyanceSum,6);

const restored=new ErgoInsightsStore(storage,now);
assert(restored.enabled&&restored.adaptive,'settings persist across reloads');
assert.equal(restored.recent().at(-1).workMs,120000);
assert.equal(restored.recent().at(-1).deferred,3);
assert.equal(restored.recent().at(-1).promptCompleted,1);
assert.equal(restored.recent().at(-1).faceCloseNormal,2);
assert.equal(restored.recent().at(-1).faceCloseZoomed,1);
assert.equal(restored.recent().at(-1).recoveryCount,2);
const csv=restored.csv();
assert(csv.includes('作業分')&&csv.includes('2026-10-24')&&csv.includes('2.00'));
assert(csv.includes('顔接近回数(標準表示)')&&csv.includes('平均姿勢復帰秒数')&&csv.includes('通知を閉じた回数')&&csv.includes('邪魔度評価平均(1-5)'));
assert(!csv.includes('memo')&&!csv.includes('faceLandmark'));
restored.setEnabled(false);
assert.equal(storage.getItem('ergopulse.insights.v1'),null,'disabling removes saved aggregates');
assert.equal(restored.effectiveGap(5),5);
console.log('PASS: opt-in local insights, measured risk, adaptive cooldown, zoom comparison, recovery time, dismissals, CSV, erasure');
