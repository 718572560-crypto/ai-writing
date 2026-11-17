'use strict';

const GF_EXP=Array(512).fill(0),GF_LOG=Array(256).fill(0);
(()=>{let x=1;for(let i=0;i<255;i++){GF_EXP[i]=x;GF_LOG[x]=i;x<<=1;if(x&256)x^=0x11d;}for(let i=255;i<512;i++)GF_EXP[i]=GF_EXP[i-255];})();
const multiply=(x,y)=>x&&y?GF_EXP[GF_LOG[x]+GF_LOG[y]]:0;
const capacities=[[1,19,7,1,1],[2,34,10,1,1],[3,55,15,1,1],[4,80,20,1,1],[5,108,26,1,1],[6,136,18,2,2],[7,156,20,2,2],[8,194,24,2,2],[9,232,30,2,2],[10,274,18,2,2]];
const alignments={2:[6,18],3:[6,22],4:[6,26],5:[6,30],6:[6,34],7:[6,22,38],8:[6,24,42],9:[6,26,46],10:[6,28,50]};

function generator(degree){let result=[1];for(let i=0;i<degree;i++){const next=Array(result.length+1).fill(0);for(let j=0;j<result.length;j++){next[j]^=result[j];next[j+1]^=multiply(result[j],GF_EXP[i]);}result=next;}return result;}
function remainder(bytes,degree){const poly=generator(degree),result=Array(degree).fill(0);for(const value of bytes){const factor=value^result.shift();result.push(0);for(let i=0;i<degree;i++)result[i]^=multiply(poly[i+1],factor);}return result;}
function codewords(bytes,dataCount,eccPerBlock,blockCount){
  const dataPerBlock=Math.floor(dataCount/blockCount),longBlocks=dataCount%blockCount,shortBlocks=blockCount-longBlocks,blocks=[];let offset=0;
  for(let i=0;i<blockCount;i++){const count=dataPerBlock+(i>=shortBlocks?1:0),part=bytes.slice(offset,offset+count);offset+=count;blocks.push({data:part,ecc:remainder(part,eccPerBlock)});}
  const output=[];for(let i=0;i<dataPerBlock+1;i++)for(const b of blocks)if(i<b.data.length)output.push(b.data[i]);
  for(let i=0;i<eccPerBlock;i++)for(const b of blocks)output.push(b.ecc[i]);
  if(output.length!==dataCount+blockCount*eccPerBlock)throw new Error('QR block length mismatch');return output;
}
function bch(value,poly){let remainder=value;while((31-Math.clz32(remainder))>=(31-Math.clz32(poly)))remainder^=poly<<((31-Math.clz32(remainder))-(31-Math.clz32(poly)));return remainder;}
const bit=(value,length)=>Array.from({length},(_,i)=>(value>>(length-i-1))&1);
function matrixFor(data,version,size,mask){
  const grid=Array.from({length:size},()=>Array(size).fill(null));
  const set=(x,y,value)=>{if(x>=0&&y>=0&&x<size&&y<size)grid[y][x]=!!value;};
  const finder=(cx,cy)=>{for(let dy=-1;dy<=7;dy++)for(let dx=-1;dx<=7;dx++){const x=cx+dx,y=cy+dy;set(x,y,dx>=0&&dx<=6&&dy>=0&&dy<=6&&(dx===0||dx===6||dy===0||dy===6||dx>=2&&dx<=4&&dy>=2&&dy<=4));}};
  finder(0,0);finder(size-7,0);finder(0,size-7);
  for(let i=8;i<size-8;i++){if(grid[i][6]===null)set(6,i,i%2===0);if(grid[6][i]===null)set(i,6,i%2===0);}
  for(const y of alignments[version]||[])for(const x of alignments[version]||[]){if(grid[y][x]!==null)continue;for(let dy=-2;dy<=2;dy++)for(let dx=-2;dx<=2;dx++)set(x+dx,y+dy,Math.max(Math.abs(dx),Math.abs(dy))!==1);}
  if(version>=7){let value=(version<<12)^bch(version<<12,0x1f25);for(let i=0;i<18;i++){const dark=((value>>i)&1)!==0;const a=size-11+i%3,b=Math.floor(i/3);set(a,b,dark);set(b,a,dark);}}
  const formatPositions=[];for(let i=0;i<=5;i++)formatPositions.push([8,i]);formatPositions.push([8,7],[8,8],[7,8]);for(let i=9;i<15;i++)formatPositions.push([14-i,8]);for(let i=0;i<15;i++){if(i<8)formatPositions.push([size-i-1,8]);else formatPositions.push([8,size-15+i]);}
  for(const [x,y] of formatPositions)set(x,y,false);set(8,size-8,true);
  const predicates=[(x,y)=>(x+y)%2===0,(x,y)=>y%2===0,(x,y)=>x%3===0,(x,y)=>(x+y)%3===0,(x,y)=>(Math.floor(y/2)+Math.floor(x/3))%2===0,(x,y)=>(x*y)%2+(x*y)%3===0,(x,y)=>((x*y)%2+(x*y)%3)%2===0,(x,y)=>((x+y)%2+(x*y)%3)%2===0];
  let index=0,upward=true;
  for(let right=size-1;right>=1;right-=2){if(right===6)right=5;for(let offset=0;offset<size;offset++){const y=upward?size-1-offset:offset;for(let dx=0;dx<2;dx++){const x=right-dx;if(grid[y][x]===null){const source=index<data.length*8?((data[Math.floor(index/8)]>>(7-index%8))&1)!==0:false;set(x,y,source!==predicates[mask](x,y));index++;}}}upward=!upward;}
  const formatData=(1<<3)|mask,format=(formatData<<10)|bch(formatData<<10,0x537),formatMasked=format^0x5412;
  for(let i=0;i<15;i++){const dark=((formatMasked>>i)&1)!==0;if(i<=5)set(8,i,dark);else if(i===6)set(8,7,dark);else if(i===7)set(8,8,dark);else if(i===8)set(7,8,dark);else set(14-i,8,dark);if(i<8)set(size-i-1,8,dark);else set(8,size-15+i,dark);}
  set(8,size-8,true);
  return grid;
}
function penalty(grid){const n=grid.length;let score=0,dark=0;for(let y=0;y<n;y++)for(let x=0;x<n;x++){if(grid[y][x])dark++;if(x+1<n&&y+1<n&&grid[y][x]===grid[y][x+1]&&grid[y][x]===grid[y+1][x]&&grid[y][x]===grid[y+1][x+1])score+=3;for(const [dx,dy]of [[1,0],[0,1]])if(x===0&&dx||y===0&&dy){let last=grid[y][x],run=1;for(let a=x+dx,b=y+dy;a<n&&b<n;a+=dx,b+=dy){if(grid[b][a]===last)run++;else{if(run>=5)score+=3+run-5;last=grid[b][a];run=1;}}if(run>=5)score+=3+run-5;}}
  const line=Array.from({length:n},(_,i)=>grid[0][i]);for(const direction of [0,1])for(let i=0;i<n;i++){let bits='';for(let j=0;j<n;j++)bits+=grid[direction?j:i][direction?i:j]?'1':'0';score+=(bits.match(/10111010000|00001011101/g)||[]).length*40;}
  score+=Math.floor(Math.abs(dark*100/(n*n)-50)/5)*10;return score;
}
function makeQrMatrix(text){
  const input=Buffer.from(String(text),'utf8');let versionRow;
  for(const row of capacities){const countBits=row[0]<=9?8:16;if(input.length<=Math.floor((row[1]*8-4-countBits)/8)){versionRow=row;break;}}
  if(!versionRow)throw Object.assign(new Error('支付码长度超出二维码容量。'),{status:400});
  const [version,dataCount,eccPerBlock,blockCount]=versionRow,total=dataCount+blockCount*eccPerBlock;
  const bits=[...bit(4,4),...bit(input.length,version<=9?8:16)];for(const byte of input)bits.push(...bit(byte,8));bits.push(...Array(Math.min(4,total*8-bits.length)).fill(0));while(bits.length%8)bits.push(0);
  const data=[];for(let i=0;i<bits.length;i+=8)data.push(bits.slice(i,i+8).reduce((value,b)=>value*2+b,0));
  for(let pad=0;data.length<dataCount;pad++)data.push(pad%2?0x11:0xec);
  const words=codewords(data,dataCount,eccPerBlock,blockCount),size=version*4+17;let best=null,bestScore=Infinity;
  for(let mask=0;mask<8;mask++){const candidate=matrixFor(words,version,size,mask),score=penalty(candidate);if(score<bestScore){best=candidate;bestScore=score;}}
  return best;
}
function qrSvg(text){const matrix=makeQrMatrix(text),pad=4,size=matrix.length+pad*2,rects=[];for(let y=0;y<matrix.length;y++)for(let x=0;x<matrix.length;x++)if(matrix[y][x])rects.push(`M${x+pad},${y+pad}h1v1h-1z`);return `<svg xmlns="http://www.w3.org/2000/svg" role="img" aria-label="支付二维码" shape-rendering="crispEdges" viewBox="0 0 ${size} ${size}"><rect width="100%" height="100%" fill="#fff"/><path d="${rects.join('')}" fill="#111"/></svg>`;}

module.exports={makeQrMatrix,qrSvg};
