const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const html = fs.readFileSync(path.join(__dirname, '../frontend/index.html'), 'utf8');
const inline = html.match(/<script>\s*([\s\S]*?)<\/script>/)?.[1];
assert(inline, 'main inline controller was not found');
const coach = fs.readFileSync(path.join(__dirname, '../frontend/coach.js'), 'utf8');
const compactCss = fs.readFileSync(path.join(__dirname, '../frontend/compact.css'), 'utf8');
const insights = fs.readFileSync(path.join(__dirname, '../frontend/insights.js'), 'utf8');
const postureGuard = fs.readFileSync(path.join(__dirname, '../frontend/posture-guard.js'), 'utf8');
assert(!html.includes('id="editor"')&&!html.includes('id="save-memo"'), 'the memo editor and save option were removed');
assert.match(compactCss,/height:\s*100dvh/,'the default desktop panel uses the viewport height');

function fixture(storedPair=null, initialPrefs={}) {
  let now = Date.parse('2026-10-24T10:00:00Z');
  const byId = new Map();
  const make = id => {
    const listeners = new Map();
    const classes = new Set();
    return {
      id, value: '', checked: false, hidden: false, disabled: false, textContent: '',
      style: {setProperty(k,v) {this[k]=String(v);}}, classList: {
        add(k) {classes.add(k);}, remove(k) {classes.delete(k);},
        toggle(k,forced) {const next=forced===undefined?!classes.has(k):forced;if(next)classes.add(k);else classes.delete(k);return next;},
        contains(k) {return classes.has(k);}},
      addEventListener(type, fn) {const list = listeners.get(type) || []; list.push(fn); listeners.set(type, list);},
      fire(type) {for (const fn of listeners.get(type) || []) fn({preventDefault() {}});},
      dispatchEvent(event) {this.fire(event.type);},
      setAttribute() {}, getAttribute() {return null;},appendChild() {},
    };
  };
  for (const match of html.matchAll(/\bid="([^"]+)"/g)) byId.set(match[1], make(match[1]));
  const el = id => {assert(byId.has(id), `missing UI element ${id}`); return byId.get(id);};
  for (const [id, value] of Object.entries({interval:'20','notice-gap':'5','break-kind':'eyes','posture-range':'92','exercise-kind':'banzai','guard-duration':'6','quick-zoom':'100','annoyance-rating':'3'})) el(id).value = value;
  const intervalTasks = [];
  const startupTasks = [];
  const notifications=[];
  const requests=[];
  const sockets=[];
  class WebSocket {constructor(url){this.url=url;this.readyState=0;sockets.push(this);}send(){}close(){}}
  class Notification {static permission='granted';static async requestPermission(){return 'granted';}constructor(title,options){notifications.push({title,options});}}
  const memory = () => {const items = new Map();return {getItem:k=>items.get(k)??null,setItem:(k,v)=>items.set(k,String(v)),removeItem:k=>items.delete(k)};};
  const fakeDate = class extends Date {constructor(...args) {super(...(args.length ? args : [now]));} static now() {return now;}};
  const document = {
    getElementById: el, hidden:false, currentScript:{src:'http://localhost:8000/coach.js'},
    body:{dataset:{},classList:{add() {}}}, documentElement:{style:{setProperty(k,v) {this[k]=String(v);}}},
    addEventListener() {}, createElement:()=>make('created')
  };
  const sessionStorage=memory();if(storedPair)sessionStorage.setItem('ergopulse.pair',JSON.stringify(storedPair));
  const localStorage=memory();for(const [k,v] of Object.entries(initialPrefs))localStorage.setItem(k,v);
  const context = {document,location:{protocol:'http:',host:'localhost:8000',hostname:'localhost',origin:'http://localhost:8000',search:''},Date:fakeDate,
    localStorage,sessionStorage,WebSocket,setInterval:fn=>(intervalTasks.push(fn),intervalTasks.length),
    setTimeout:(fn,delay)=>{if(delay===0)startupTasks.push(fn);return 1;},clearTimeout() {},clearInterval() {},navigator:{},URL,URLSearchParams,
    fetch:(url,options)=>{requests.push({url,options});return {catch(){return {finally(fn){fn();}}}};},
    console,performance:{now:()=>now},crypto:{randomUUID:()=> 'unique-event'},Notification,isSecureContext:true,
    Event:class Event{constructor(type){this.type=type;}},
  };
  context.window=context;
  context.addEventListener=()=>{};
  vm.createContext(context);
  vm.runInContext(inline,context,{filename:'index.html'});
  vm.runInContext(insights,context,{filename:'insights.js'});
  vm.runInContext(postureGuard,context,{filename:'posture-guard.js'});
  vm.runInContext(coach,context,{filename:'coach.js'});
  return {context,el,document,notifications,sockets,requests,runStartup:()=>startupTasks.forEach(fn=>fn()),
    advance:ms=>{now+=ms;intervalTasks.forEach(fn=>fn());}};
}

{
  const {context,el,runStartup} = fixture();
  let permissionRequests=0;
  context.navigator.mediaDevices={getUserMedia:()=>{permissionRequests++;return Promise.reject(new Error('denied'));}};
  assert.equal(el('quick-auto-camera').checked,true,'camera auto-start is enabled by default');
  assert.equal(el('quick-cat-motion').checked,true,'the cat starts with playful animations enabled');
  assert.equal(el('quick-cat-growth').checked,true,'giant cat is enabled by default');
  assert.equal(el('quick-cat-pause').checked,false,'full-screen pause does not hide the giant cat');
  assert.equal(context.ergoApp.get().externalSession,false,'automatic session starts after page initialization');
  runStartup();
  assert.equal(context.ergoApp.get().externalSession,true,'opening the app starts the external work session');
  assert.equal(permissionRequests,1,'page load requests camera permission without a manual start click');
  el('quick-interval').value='25';el('quick-interval').fire('change');
  assert.equal(el('interval').value,'25','quick settings control the actual interval');
  el('quick-cat-enabled').checked=false;el('quick-cat-enabled').fire('change');
  assert.equal(el('guard-enabled').checked,false,'cat visibility switch disables the native cat');
  el('quick-cat-motion').checked=false;el('quick-cat-motion').fire('change');
  assert.equal(context.localStorage.getItem('ergopulse.catMotion'),'false','cat animation opt-out persists');
  el('quick-cat-pause').checked=false;el('quick-cat-pause').fire('change');
  assert.equal(context.localStorage.getItem('ergopulse.catPause'),'false','full-screen pause opt-out persists');
  el('quick-duration').value='10';el('quick-duration').fire('change');
  assert.equal(el('guard-duration').value,'10','notification delay controls the actual rule');
}

{
  const {context,el,runStartup} = fixture(null,{'ergopulse.autoCamera':'false'});
  assert.equal(el('quick-auto-camera').checked,false,'a prior camera opt-out is remembered');
  runStartup();
  assert.equal(context.ergoApp.get().externalSession,false,'camera opt-out suppresses automatic startup');
}

{
  const {context,el,document,advance} = fixture();
  assert.match(el('posture-state').textContent,/未計測/,'no camera is not interpreted as a healthy posture');
  el('work-session').onclick();
  assert(context.ergoApp.get().externalSession);
  document.hidden=true;
  advance(60000);
  assert.equal(el('elapsed').textContent,'01:00','explicit work session counts background wall time');
  el('work-session').onclick();
  advance(10000);
  assert.equal(el('elapsed').textContent,'01:00','pause freezes work session');
  el('work-session').onclick();
  advance(15000);
  assert.equal(el('elapsed').textContent,'01:15','resume continues work session');
  el('work-session-end').onclick();
  assert.equal(el('elapsed').textContent,'00:00');
  assert.equal(context.ergoApp.get().externalSession,false);
}

{
  const {el,advance} = fixture();
  el('demo').checked=true;el('demo').fire('change');
  el('posture-range').value='40';
  advance(9000);
  assert.notEqual(el('break-title').textContent,'今のうちに、15秒。','without a work session no memo-based interruption occurs');
}

{
  const {el,advance} = fixture();
  el('demo').checked=true;el('demo').fire('change');
  el('posture-range').value='40';
  el('work-session').onclick();
  advance(9000);
  assert.notEqual(el('break-title').textContent,'今のうちに、15秒。','external work does not trigger a continuous posture interruption');
  el('work-boundary').onclick();
  advance(250);
  assert.equal(el('break-title').textContent,'今のうちに、15秒。','manual work boundary can trigger coaching');
}

{
  const {el,document,notifications,advance} = fixture();
  el('work-session').onclick();document.hidden=true;
  for(let i=0;i<20;i++)advance(60000);
  assert.equal(notifications.length,1,'a background work session can issue an opted-in desktop reminder');
  advance(60000);
  assert.equal(notifications.length,1,'a second reminder is rate limited');
}

{
  const {el,advance} = fixture();
  el('insights-enabled').checked=true;el('insights-enabled').fire('change');
  assert.equal(el('insights-data').hidden,false,'opt-in reveals local dashboard');
  el('work-session').onclick();advance(65000);
  assert.equal(el('insights-work').textContent,'1分','work timer updates the dashboard');
  el('adaptive-enabled').checked=true;el('adaptive-enabled').fire('change');
  assert.match(el('adaptive-state').textContent,/通知間隔/);
}

{
  const {el,advance} = fixture();
  el('insights-enabled').checked=true;el('insights-enabled').fire('change');
  el('work-session').onclick();for(let i=0;i<20;i++)advance(60000);
  el('work-boundary').onclick();advance(250);
  el('stretch').onclick();advance(15000);
  assert.equal(el('manual-finish').hidden,false);
  el('manual-finish').onclick();
  assert.equal(el('insights-acceptance').textContent,'100%','prompt-to-completion conversion is measured separately from manual exercise');
}

{
  const room='room_ABCDEFGHIJKLMNOPQRSTUVWXY',key='controller_ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  const {sockets,el}=fixture({room,key,urls:[`http://192.168.1.12:8000/?phone=${room}`],expires:Date.parse('2026-10-24T11:00:00Z')});
  assert.equal(sockets.length,1,'a page reload attempts to rejoin the existing PC room');
  assert(sockets[0].url.includes(encodeURIComponent(key)));
  assert.equal(el('pair-info').hidden,false);
}

{
  const {el,advance,requests} = fixture();
  el('quick-cat-enabled').checked=false;el('quick-cat-enabled').fire('change');
  el('demo').checked=true;el('demo').fire('change');el('posture-range').value='40';
  el('work-session').onclick();
  advance(9000);
  assert.equal(el('guard-screen').hidden,true,'no default fullscreen blocking');
  assert.equal(el('guard-cue').hidden,true,'quiet cue is always opt-in');
  assert(Number(el('posture-cat').style['--cat-scale'])>1.3,'the cat visibly grows as posture score declines');
  el('quick-cat-enabled').checked=true;el('quick-cat-enabled').fire('change');
  advance(5750);
  assert.equal(el('guard-cue').hidden,true,'brief posture change does not trigger a warning');
  advance(500);
  assert.equal(el('guard-cue').hidden,false,'sustained poor posture triggers a quiet cue');
  assert.equal(el('guard-screen').hidden,true,'quiet cue never blocks the workspace');
  assert.equal(requests.filter(req=>req.url==='/api/posture-guard/update'&&JSON.parse(req.options.body).active).length,0,
    'demo pauses never trigger a native Windows overlay');
  assert(requests.filter(req=>req.url==='/api/posture-guard/update').every(req=>JSON.parse(req.options.body).score===null),
    'demo posture never leaks a score into the native overlay');
  const activeElapsed=el('elapsed').textContent;advance(3000);
  assert.notEqual(el('elapsed').textContent,activeElapsed,'work continues while the quiet cue appears');
  el('posture-range').value='80';advance(250);advance(1750);
  assert.equal(el('guard-cue').hidden,false,'brief good posture must not flicker cue visibility');
  advance(500);
  assert.equal(el('guard-cue').hidden,true,'cue disappears after two seconds of recovered posture');
  assert(Number(el('posture-cat').style['--cat-scale'])<1.2,'cat shrinks as posture improves');
  el('guard-experimental').checked=true;el('guard-experimental').fire('change');
  el('posture-range').value='40';advance(250);advance(6500);
  assert.equal(el('guard-screen').hidden,false,'experimental fullscreen pause is explicitly opted into');
  el('guard-bypass').onclick();
  assert.equal(el('guard-screen').hidden,true,'user can always override the pause');
  advance(30000);
  assert.equal(el('guard-screen').hidden,true,'override gives two minutes to work');
  el('guard-disable').onclick();
  assert.equal(el('guard-enabled').checked,false);
}

{
  const {el,requests,advance}=fixture();
  el('guard-enabled').checked=true;el('work-session').onclick();
  advance(1000);
  const payloads=requests.filter(req=>req.url==='/api/posture-guard/update').map(req=>JSON.parse(req.options.body));
  assert(payloads.length>0,'desktop overlay receives heartbeat states');
  assert(payloads.every(data=>data.score===null&&!data.active),'camera-off status hides the native cat');
  assert(payloads.every(data=>data.playful===true),'cat motion preference reaches the native helper');
  assert(payloads.every(data=>data.pause_on_kittens===false),'screen pause is off by default');
  assert(payloads.every(data=>data.grow===true),'growth preference reaches the native helper');
  assert(payloads.every(data=>data.face_close===false),'camera off clears the face warning');
}

{
  const {el,requests,advance}=fixture(null,{'ergopulse.catMotion':'false','ergopulse.catPause':'false'});
  assert.equal(el('quick-cat-motion').checked,false,'saved opt-out suppresses animations');
  assert.equal(el('quick-cat-pause').checked,false,'saved opt-out suppresses screen pauses');
  el('work-session').onclick();advance(1000);
  const payload=requests.filter(req=>req.url==='/api/posture-guard/update').at(-1);
  assert.equal(JSON.parse(payload.options.body).playful,false,'saved opt-out is relayed to Windows');
  assert.equal(JSON.parse(payload.options.body).pause_on_kittens,false,'screen pause opt-out is relayed to Windows');
}

{
  const {el,advance}=fixture();
  el('demo').checked=true;el('demo').fire('change');
  el('posture-range').value='40';
  advance(1000);
  assert.equal(el('cat-stage').classList.contains('kitten-one'),false,'no immediate multiplication');
  advance(5000);
  assert.equal(el('cat-stage').classList.contains('kitten-one'),true,'first child appears after 5 seconds');
  assert.equal(el('cat-stage').classList.contains('kitten-two'),false);
  advance(8000);
  assert.equal(el('cat-stage').classList.contains('kitten-two'),true,'second child appears after 13 seconds');
  el('posture-range').value='85';advance(250);
  assert.equal(el('cat-stage').classList.contains('kitten-one'),false,'children depart when posture recovers');
  assert.equal(el('cat-stage').classList.contains('kitten-two'),false);
}

console.log('PASS: one-screen layout, animated-cat preferences, sessions, reminders, pairing, optional reversible posture pause');

{
 const {el,context,requests,advance}=fixture(null,{'ergopulse.catPause':'true'});
 assert.equal(el('quick-cat-growth').checked,true);
 assert.equal(el('quick-cat-pause').checked,false,'old full-screen preference cannot hide the new giant cat');
 el('quick-cat-pause').checked=true;el('quick-cat-pause').fire('change');
 assert.equal(el('quick-cat-growth').checked,false,'screen pause and giant cat are separate modes');
 assert.equal(context.localStorage.getItem('ergopulse.catGrowth'),'false');
 advance(250);
 assert.equal(JSON.parse(requests.at(-1).options.body).grow,false);
 el('quick-cat-growth').checked=true;el('quick-cat-growth').fire('change');
 assert.equal(el('quick-cat-pause').checked,false);
 assert.equal(context.localStorage.getItem('ergopulse.catPause'),'false');
 advance(250);
 assert.equal(JSON.parse(requests.at(-1).options.body).grow,true);
}

// Test Feature 1 (repeated face-close -> zoom suggestion -> zoom applied) & Feature 2 (recovery time & dismissal metrics)
{
 const {el,document,context}=fixture();
 el('insights-enabled').checked=true;el('insights-enabled').fire('change');
 assert.equal(el('face-zoom-box').hidden,true,'zoom suggestion is initially hidden');
 el('simulate-face-close').onclick();
 assert.equal(el('face-zoom-box').hidden,false,'repeated face-close suggests enlarging text');
 assert.equal(el('quick-face-warning').hidden,false);
 el('accept-zoom').onclick();
 assert.equal(document.documentElement.style['--ergo-zoom'],'1.15','accepting zoom increases display scale to 115%');
 assert.equal(context.localStorage.getItem('ergopulse.pageZoom'),'115');
 assert.equal(el('face-zoom-box').hidden,true,'accepting zoom hides the suggestion banner');
}

async function testCameraWarningLifecycle(){
 const {el,context,requests,advance}=fixture();
 el('insights-enabled').checked=true;el('insights-enabled').fire('change');
 let fakeWorker,stopped=false;
 context.navigator.mediaDevices={getUserMedia:async()=>({getTracks:()=>[{stop(){stopped=true;}}]})};
 context.Worker=class Worker {constructor(){fakeWorker=this;}postMessage(){}terminate(){}};
 el('video').play=async()=>{};
 await el('camera').onclick();
 fakeWorker.onmessage({data:{type:'ready'}});
 el('work-session').onclick();
 const received=result=>fakeWorker.onmessage({data:{type:'result',result}});
 const payload=()=>JSON.parse(requests.filter(r=>r.url==='/api/posture-guard/update').at(-1).options.body);
 received({calibrated:true,tracked:false,faceTracked:true,faceClose:true,postureScore:100,score:100,reason:'顔が近い'});
 advance(250);
 assert.equal(el('quick-face-warning').hidden,false,'warning survives shoulders leaving frame');
 assert(html.includes('aria-live="polite" hidden>顔が近い</p>'));
 assert.equal(payload().face_close,true);
 assert.equal(payload().score,null,'missing shoulders do not invent a posture score');
 received({calibrated:true,tracked:true,faceTracked:true,faceClose:false,postureScore:100,score:100});
 advance(250);
 assert.equal(el('quick-face-warning').hidden,true);
 assert.equal(payload().face_close,false,'recovery is sent immediately, not after heartbeat throttle');
 // Second face-close event triggers the zoom suggestion and relays zoom_hint to Windows cat
 received({calibrated:true,tracked:true,faceTracked:true,faceClose:true,postureScore:40,score:40});
 advance(250);
 assert.equal(el('face-zoom-box').hidden,false,'second face-close occurrence prompts to enlarge display');
 assert.equal(payload().zoom_hint,true,'zoom_hint is relayed to the Windows desktop cat');
 el('quick-cat-enabled').checked=false;el('quick-cat-enabled').fire('change');advance(250);
 assert.equal(payload().face_close,false,'turning off the native cat also clears its text');
 el('quick-cat-enabled').checked=true;el('quick-cat-enabled').fire('change');advance(250);
 assert.equal(payload().face_close,true);
 el('work-session').onclick();advance(250);
 assert.equal(payload().face_close,false,'paused work has no native warning');
 assert.equal(el('quick-face-warning').hidden,true);
 el('work-session').onclick();advance(250);
 assert.equal(payload().face_close,true);
 advance(2500);
 assert.equal(payload().face_close,false,'stale sensor measurements expire');
 assert.equal(payload().score,null);
 received({calibrated:true,tracked:true,faceTracked:true,faceClose:true,postureScore:40,score:40});advance(250);
 await el('camera').onclick();advance(250);
 assert(stopped);
 assert.equal(payload().face_close,false,'stopping camera clears the warning');
 assert.equal(el('quick-face-warning').hidden,true);
 console.log('PASS: camera-to-desktop proximity lifecycle, zoom suggestion, and mutually exclusive growth/pause modes');
}
testCameraWarningLifecycle().catch(error=>{console.error(error);process.exitCode=1;});
