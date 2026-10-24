const assert=require('node:assert/strict');require('../frontend/qr.js');
// Structure: finder patterns, timing pattern, determinism, size by version, SVG output.
const url='http://192.168.1.12:8000/?phone=AbCdEfGhIjKlMnOpQrStUvWx';
const q=ErgoQR.encode(url);
assert.equal(q.size,q.version*4+17);assert(q.version<=6,'pairing URL should stay a small, easily scanned QR');
const m=q.modules,n=q.size;
for(const [ox,oy] of [[0,0],[n-7,0],[0,n-7]]){for(let i=0;i<7;i++){assert(m[oy][ox+i]&&m[oy+6][ox+i]&&m[oy+i][ox]&&m[oy+i][ox+6]);}assert(m[oy+3][ox+3]&&!m[oy+1][ox+1]);}
for(let i=8;i<n-8;i++){assert.equal(m[6][i],i%2===0);assert.equal(m[i][6],i%2===0);}
assert.deepEqual(ErgoQR.encode(url).modules,m);
const svg=ErgoQR.toSvg(url);assert(svg.startsWith('<svg')&&svg.includes('viewBox="0 0 '+(n+8)));
assert.throws(()=>ErgoQR.encode('x'.repeat(300)),RangeError);
assert.equal(ErgoQR.encode('日本語').version,1);
console.log('PASS: QR structure, determinism, version bounds, SVG output');
