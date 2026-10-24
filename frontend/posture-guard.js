/* Optional, reversible posture gate. All times below are in milliseconds. */
(function (root, factory) {
 const Guard = factory();
 if (typeof module === 'object' && module.exports) module.exports = Guard;
 else root.ErgoPostureGuard = Guard;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
 'use strict';
 return class ErgoPostureGuard {
  constructor({triggerMs=6000, recoverMs=2000, bypassMs=120000}={}) {
   this.triggerMs=triggerMs;this.recoverMs=recoverMs;this.bypassMs=bypassMs;
   this.locked=false;this.badSince=null;this.goodSince=null;this.bypassUntil=0;
  }
  clear() {this.locked=false;this.badSince=null;this.goodSince=null;}
  bypass(now) {this.bypassUntil=now+this.bypassMs;this.clear();}
  step({now,enabled,score,working}) {
   const measured=Number.isFinite(score)&&score>=0&&score<=100;
   if(!enabled||!working||!measured||now<this.bypassUntil){this.clear();return this.snapshot(now);}
   if(!this.locked){
    if(score<60){if(this.badSince===null)this.badSince=now;if(now-this.badSince>=this.triggerMs){this.locked=true;this.goodSince=null;}}
    else this.badSince=null;
   }else{
    if(score>=75){if(this.goodSince===null)this.goodSince=now;if(now-this.goodSince>=this.recoverMs){this.clear();}}
    else this.goodSince=null;
   }
   return this.snapshot(now);
  }
  snapshot(now){return {locked:this.locked,bypassed:now<this.bypassUntil,
   remainingMs:this.locked?0:this.badSince===null?this.triggerMs:Math.max(0,this.triggerMs-(now-this.badSince)),
   recoveryMs:this.goodSince===null?this.recoverMs:Math.max(0,this.recoverMs-(now-this.goodSince))};}
 };
});
