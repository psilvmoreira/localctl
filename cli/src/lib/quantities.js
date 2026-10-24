// Kubernetes resource quantities, parsed exactly with BigInt. cpu is in millicores (up to 1024
// cores), memory in bytes (up to 1 TiB). Neither can be zero, memory has no milli suffix, and a
// request can't exceed its limit.
const CPU=/^(\d{1,7})(\.\d{1,3})?(m)?$/, MEM=/^(\d{1,13})(\.\d{1,3})?(k|Ki|Mi|Gi|Ti|M|G|T)?$/;
const MUL={'':1n,k:10n**3n,M:10n**6n,G:10n**9n,T:10n**12n,Ki:1n<<10n,Mi:1n<<20n,Gi:1n<<30n,Ti:1n<<40n};
const MAX_CPU_M=1024n*1000n, MAX_MEM=1n<<40n; // 1024 cores, 1 TiB
function scaled(int,frac,mult){ // exact: (int.frac)*mult, rejects sub-unit remainders
  const f=(frac||'').slice(1), den=10n**BigInt(f.length), num=BigInt(int+f)*mult;
  if(num%den!==0n) throw new Error('too precise'); return num/den; }
function parseCpu(v){const m=CPU.exec(String(v)); if(!m) throw new Error(`cpu "${v}": use 500m, 1 or 0.5`);
  const milli=m[3]? scaled(m[1],m[2],1n) : scaled(m[1],m[2],1000n);
  if(milli<=0n) throw new Error('cpu must be > 0'); if(milli>MAX_CPU_M) throw new Error('cpu max 1024 cores'); return milli;}
function parseMem(v){const m=MEM.exec(String(v)); if(!m) throw new Error(`memory "${v}": use 256Mi, 2Gi, 1G`);
  const b=scaled(m[1],m[2],MUL[m[3]||'']); if(b<=0n) throw new Error('memory must be > 0'); if(b>MAX_MEM) throw new Error('memory max 1Ti'); return b;}
function checkResources({requests={},limits={}}={}){
  for(const [k,p] of [['cpu',parseCpu],['memory',parseMem]]){
    const r=requests[k]!==undefined?p(requests[k]):null, l=limits[k]!==undefined?p(limits[k]):null;
    if(r!==null&&l!==null&&r>l) throw new Error(`${k} request ${requests[k]} exceeds limit ${limits[k]}`);}
  return true;}
module.exports={parseCpu,parseMem,checkResources};
