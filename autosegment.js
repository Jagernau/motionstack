/* MotionStack v0.2 — tap-to-segment with MediaPipe MagicTouch bundled in Android.
   Processing stays on the device. No guessing poses or adding fake frames. */
'use strict';
const autoPending = new Map();
let autoRequest = 0, autoBusy = false, cleanBackground = null;
window.motionStackReceive = function(id, maskDataUrl, error) {
  const job=autoPending.get(id);
  if(!job)return;
  autoPending.delete(id);
  error ? job.reject(new Error(error)) : job.resolve(maskDataUrl);
};
function nativeSegment(dataUrl,pointX,pointY) {
  return new Promise((resolve,reject)=>{
    if(!window.AndroidBridge || typeof AndroidBridge.segmentFrame!=='function')
      return reject(new Error('Автовыделение доступно в APK v0.2+, не в браузере Termux.'));
    const id=++autoRequest;
    autoPending.set(id,{resolve,reject});
    try { AndroidBridge.segmentFrame(id,dataUrl,pointX,pointY); }
    catch(e){autoPending.delete(id);reject(e)}
  });
}
function loadImage(url) {
  return new Promise((resolve,reject)=>{
    const im = new Image();
    im.onload=()=>resolve(im);
    im.onerror=()=>reject(new Error('Не удалось открыть маску от нейросети'));
    im.src=url;
  });
}
// A lightweight colour-patch tracker propagates the tap across real video frames.
// It is a heuristic, NOT guaranteed person tracking (crowds and occlusions may fail).
const patchThumbs=new Map();
function trackerImage(index) {
  if(patchThumbs.has(index))return patchThumbs.get(index);
  const source=frames[index],size=320,scale=Math.min(1,size/Math.max(source.width,source.height));
  const w=Math.max(2,Math.round(source.width*scale)),h=Math.max(2,Math.round(source.height*scale));
  const cv=document.createElement('canvas');cv.width=w;cv.height=h;
  const ctx=cv.getContext('2d',{willReadFrequently:true});ctx.drawImage(source,0,0,w,h);
  const item={w,h,arr:ctx.getImageData(0,0,w,h).data};
  patchThumbs.set(index,item);return item;
}
function trackPersonPoint(prevIndex,nextIndex,normalized) {
  const a=trackerImage(prevIndex),b=trackerImage(nextIndex);
  const x=Math.round(normalized.x*a.w),y=Math.round(normalized.y*a.h);
  const prev=idx=>(a.arr[idx]+a.arr[idx+1]*1.2+a.arr[idx+2]*.6);
  const next=idx=>(b.arr[idx]+b.arr[idx+1]*1.2+b.arr[idx+2]*.6);
  // Compare a 13x13 patch, searching up to 13% of short side for nearby movement.
  const radius=Math.max(6,Math.round(Math.min(b.w,b.h)*.13));
  let best=Infinity,bx=x,by=y;
  for(let cy=Math.max(9,y-radius);cy<=Math.min(b.h-10,y+radius);cy+=2)
    for(let cx=Math.max(9,x-radius);cx<=Math.min(b.w-10,x+radius);cx+=2) {
      let score=0;
      for(let dy=-6;dy<=6;dy+=3)for(let dx=-6;dx<=6;dx+=3){
        const ax=Math.max(0,Math.min(a.w-1,x+dx)),ay=Math.max(0,Math.min(a.h-1,y+dy));
        const ai=(ay*a.w+ax)*4,bi=((cy+dy)*b.w+cx+dx)*4;
        score+=Math.abs(prev(ai)-next(bi));
      }
      score+=.35*(Math.abs(cx-x)+Math.abs(cy-y)); // favour temporal continuity
      if(score<best){best=score;bx=cx;by=cy}
    }
  return {x:Math.min(.999,Math.max(.001,bx/b.w)),y:Math.min(.999,Math.max(.001,by/b.h))};
}
function cropAround(frame,point,overrideZoom=null) {
  // Zooming in makes small skaters easier for the model; the mask is put back
  // into FULL-FRAME coordinates, fixing accidental cropping of later phases.
  const zoom=overrideZoom||Number($('aiCropZoom')?.value||2.0);
  const w=Math.min(frame.width,Math.round(frame.width/zoom));
  const h=Math.min(frame.height,Math.round(frame.height/zoom));
  const x=Math.round(clamp(point.x*frame.width-w/2,0,frame.width-w));
  const y=Math.round(clamp(point.y*frame.height-h/2,0,frame.height-h));
  const cv=document.createElement('canvas');cv.width=w;cv.height=h;
  cv.getContext('2d').drawImage(frame,x,y,w,h,0,0,w,h);
  const nx=clamp((point.x*frame.width-x)/w,.001,.999);
  const ny=clamp((point.y*frame.height-y)/h,.001,.999);
  // Keep payload reasonable even when frames are high resolution.
  const maxSide=900,scale=Math.min(1,maxSide/Math.max(w,h));
  const input=document.createElement('canvas');
  input.width=Math.round(w*scale);input.height=Math.round(h*scale);
  input.getContext('2d').drawImage(cv,0,0,input.width,input.height);
  return {x,y,w,h,input,nx,ny};
}

async function segmentSingle(i,seed) {
  const frame=frames[i];
  const configuredZoom=Number($('aiCropZoom')?.value||2);
  const attempts=[...new Set([configuredZoom,Math.max(1,configuredZoom/1.5),1].map(x=>Number(x.toFixed(3))))];
  for(let attempt=0;attempt<attempts.length;attempt++){
    const crop=cropAround(frame,seed,attempts[attempt]);
    const maskData=await nativeSegment(crop.input.toDataURL('image/jpeg',.91),crop.nx,crop.ny);
    const bitmap=await loadImage(maskData);
    // If a segmented object hits the crop boundary, try a wider crop.
    const diagnostic=document.createElement('canvas');
    diagnostic.width=80;diagnostic.height=80;
    const diagnosticCtx=diagnostic.getContext('2d',{willReadFrequently:true});
    diagnosticCtx.drawImage(bitmap,0,0,80,80);
    const data=diagnosticCtx.getImageData(0,0,80,80).data;
    let edgeHits=0,foreground=0;
    for(let y=0;y<80;y++)for(let x=0;x<80;x++){
      const alpha=data[(y*80+x)*4+3];
      if(alpha>125){
        foreground++;
        if(x<2||y<2||x>77||y>77)edgeHits++;
      }
    }
    if(foreground<3)throw new Error('Модель не нашла объект: кадр '+(i+1));
    if(foreground>4800)throw new Error('Слишком большая область: кадр '+(i+1)+'. Нажми точнее на торс.');
    if(edgeHits>4 && attempt<attempts.length-1)continue;

    // Mask and cutout both have dimensions of the FULL decoded video frame,
    // even if the neural network was only run on a small crop.
    const mask=document.createElement('canvas');
    mask.width=frame.width;mask.height=frame.height;
    const mctx=mask.getContext('2d');
    mctx.drawImage(bitmap,crop.x,crop.y,crop.w,crop.h);
    const silhouette=document.createElement('canvas');
    silhouette.width=frame.width;silhouette.height=frame.height;
    const sctx=silhouette.getContext('2d');
    sctx.drawImage(frame,0,0);
    sctx.globalCompositeOperation='destination-in';
    sctx.drawImage(mask,0,0);
    sctx.globalCompositeOperation='source-over';
    return {type:'auto',overlay:silhouette,mask,seed};
  }
  throw new Error('Не удалось получить маску: кадр '+(i+1));
}
async function autoSegmentAll(startPoint) {
  if(!frames.length||autoBusy)return;
  if(typeof AndroidBridge==='undefined'||typeof AndroidBridge.segmentFrame!=='function'){
    $('phaseStatus').textContent='Авто работает в Android APK v0.2+. В Termux доступна ручная обводка.';
    return;
  }
  autoBusy=true;
  const startIndex=active,originalMode=mode;
  setMode('pan');
  $('tapMode').disabled=true;$('extract').disabled=true;
  patchThumbs.clear();
  const sequences=[[startIndex,1],...Array.from({length:frames.length-startIndex-1},(_,k)=>[startIndex+1+k,1]),
                   ...Array.from({length:startIndex},(_,k)=>[startIndex-1-k,-1])];
  let done=0,prev=startIndex,seed=startPoint,failed=[],lastDirection=null;
  try {
    for(const [i,dir] of sequences) {
      if(i===startIndex){seed=startPoint}
      else {
        if (lastDirection!==null && lastDirection!==dir) {
          prev=startIndex;seed=startPoint;
        }
        seed=trackPersonPoint(prev,i,seed);
      }
      lastDirection=dir;
      report('Нейросеть: кадр '+(i+1)+' из '+frames.length+' — '+times[i].toFixed(2)+' с');
      try {
        masks[i]=await segmentSingle(i,seed);done++;
      } catch(e) {failed.push((i+1)+': '+e.message);masks[i]=null;}
      prev=i;
      renderFrameButtons();if(i===active)showFrame();renderComposite();
      await sleep(5);
    }
    report('Готово: автоматически выделено '+done+'/'+frames.length+' кадров.'+
      (failed.length?' Ошибки: '+failed.join('; '):' Можно нажать на человека ещё раз для повторной обработки.'));
    showFrame();
  } catch(e) {report('Ошибка автоматического выделения: '+e.message)}
  finally {
    autoBusy=false;$('tapMode').disabled=false;$('extract').disabled=false;
    setMode(originalMode==='draw'?'draw':'tap');renderFrameButtons();showFrame();renderComposite();
  }
}
// Auto background uses per-channel median from first, middle and last frame.
// This suppresses transient moving shapes without inventing a new pose.
function medianBackground() {
  if(cleanBackground)return cleanBackground;
  const picks=[0,Math.floor(frames.length/2),frames.length-1];
  const images=picks.map(i=>frames[i].getContext('2d',{willReadFrequently:true}).getImageData(
    0,0,frames[i].width,frames[i].height));
  const a=images[0].data,b=images[1].data,c=images[2].data,output=images[1];
  for(let i=0;i<a.length;i+=4)for(let k=0;k<3;k++){
    const x=a[i+k],y=b[i+k],z=c[i+k];
    output.data[i+k]=x+y+z-Math.min(x,y,z)-Math.max(x,y,z);
  }
  const cv=document.createElement('canvas');cv.width=frames[0].width;cv.height=frames[0].height;
  cv.getContext('2d').putImageData(output,0,0);cleanBackground=cv;
  return cv;
}
