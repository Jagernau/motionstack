/* MotionStack Studio v0.3.0
 * All imagery comes from the source recording. No generative imaging.
 * Video decode & compositing: browser Canvas. Point segmentation: bundled native MagicTouch.
 */
'use strict';
const $ = id => document.getElementById(id);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const clamp = (n, min, max) => Math.max(min, Math.min(max, n));
const round = (n, k=2) => Number(n).toFixed(k);
const busy = text => { $('busy').textContent = text || ''; $('busy').classList.toggle('on', Boolean(text)); };
const status = text => $('status').textContent = text;
const rawVideo = $('preview');
const state = {
  srcURL: null, file: null, duration: 0, start: 0, end: 1.5, playingLoop: true,
  extracting: false, processing: false, frames: [], times: [], masks: [], enabled: new Set(),
  selected: 0, canvasW: 0, canvasH: 0, zoom: 1, mode: 'tap', boardMode: false,
  backgroundCache: null, showRaw: false, pan: null, shifts: [], busyRun: 0,
};
const canvas = $('subjectCanvas'), cctx = canvas.getContext('2d', {willReadFrequently:false});
const output = $('resultCanvas'), outctx = output.getContext('2d');
const videoTime = t => `${Math.floor(t/60)}:${round(t%60).padStart(5,'0')}`;
const hasNative = () => Boolean(window.AndroidBridge && typeof window.AndroidBridge.segmentFrame === 'function');

function refreshTrimUI() {
  if (!state.duration) return;
  $('startRange').value=String(state.start); $('endRange').value=String(state.end);
  $('startValue').textContent=`${round(state.start)} с`;
  $('endValue').textContent=`${round(state.end)} с`;
  $('selectionLine').style.left=`${100*state.start/state.duration}%`;
  $('selectionLine').style.right=`${100*(state.duration-state.end)/state.duration}%`;
  updatePlayerTime();
}
function updatePlayerTime() {
  $('timeStatus').textContent = videoTime(rawVideo.currentTime||0)+' / '+videoTime(state.duration);
  $('playhead').style.left=(state.duration ? (100*clamp(rawVideo.currentTime/state.duration,0,1)) : 0)+'%';
}
function setTrim(which, value) {
  const t = clamp(Number(value),0,state.duration);
  if (which === 'start') state.start=Math.min(t,state.end-.08);
  else state.end=Math.max(t,state.start+.08);
  state.start=clamp(state.start,0,state.duration-.08);
  state.end=clamp(state.end,state.start+.08,state.duration);
  if(rawVideo.readyState>=1) rawVideo.currentTime=which==='start'?state.start:state.end;
  refreshTrimUI();
}
function releaseFrames() {
  state.frames=[];state.times=[];state.masks=[];state.enabled.clear();state.shifts=[];
  state.backgroundCache=null; state.canvasW=0; state.canvasH=0; phaseThumbs.clear();
  $('subjectStep').hidden=true; $('resultStep').hidden=true;
}
function enableVideoUI(yes) {
  for(const id of ['play','loop','toStart','toEnd','startRange','endRange','extract']) $(id).disabled=!yes;
}
function loadFile() {
  const file = $('videoFile').files?.[0]; if(!file)return;
  rawVideo.pause(); releaseFrames();
  if(state.srcURL)URL.revokeObjectURL(state.srcURL);
  state.file=file;state.srcURL=URL.createObjectURL(file);state.duration=0;
  enableVideoUI(false); $('placeholder').hidden=false;
  rawVideo.src=state.srcURL;rawVideo.load();
  status('Читаю длительность и кадры видео…');
}
rawVideo.addEventListener('loadedmetadata', () => {
  const duration=rawVideo.duration;
  if(!Number.isFinite(duration)||duration<=.1){status('Ошибка чтения длительности видео.');return;}
  state.duration=duration;state.start=0;state.end=Math.min(1.5,duration);
  for(const id of ['startRange','endRange']){$(id).max=String(duration);$(id).step='0.02';}
  $('placeholder').hidden=true;enableVideoUI(true);refreshTrimUI();
  status(`Открыто ${rawVideo.videoWidth}×${rawVideo.videoHeight}; ${round(duration)} с. Выбери фрагмент и смотри его в плеере.`);
  generateFilmstrip().catch(e=>{console.warn('Filmstrip error',e);});
});
rawVideo.addEventListener('timeupdate', () => {
  if(!state.extracting && !state.processing && state.playingLoop && !rawVideo.paused && rawVideo.currentTime>=state.end-.03) rawVideo.currentTime=state.start;
  updatePlayerTime();
});
rawVideo.addEventListener('ended', () => {if(state.playingLoop && !state.extracting){rawVideo.currentTime=state.start;rawVideo.play().catch(()=>{});}});
rawVideo.addEventListener('error', () => status('Видео не декодируется в Android WebView. Проверь MP4/H.264.'));
$('videoFile').addEventListener('change',loadFile);
$('startRange').addEventListener('input',e=>setTrim('start',e.target.value));
$('endRange').addEventListener('input',e=>setTrim('end',e.target.value));
$('play').addEventListener('click',async()=>{if(rawVideo.paused){if(rawVideo.currentTime<state.start||rawVideo.currentTime>=state.end)rawVideo.currentTime=state.start;try{await rawVideo.play();$('play').textContent='⏸ Пауза'}catch(e){status('Не удалось воспроизвести: '+e.message)}}else{rawVideo.pause();$('play').textContent='▶ Смотреть'}});
rawVideo.addEventListener('pause',()=>{$('play').textContent='▶ Смотреть'});
$('loop').addEventListener('click',()=>{state.playingLoop=!state.playingLoop;$('loop').textContent=`↻ Повтор отрезка: ${state.playingLoop?'да':'нет'}`;$('loop').classList.toggle('selected',state.playingLoop)});
$('toStart').addEventListener('click',()=>setTrim('start',rawVideo.currentTime));
$('toEnd').addEventListener('click',()=>setTrim('end',rawVideo.currentTime));
$('timeline').addEventListener('click', e=>{
  if(!state.duration||state.extracting)return;
  const b=$('filmstrip').getBoundingClientRect(),fraction=clamp((e.clientX-b.left)/b.width,0,1);
  rawVideo.currentTime=state.duration*fraction;
});

function waitFor(media,event,timeout=15000) {return new Promise((resolve,reject)=>{
  let timer;const clean=()=>{clearTimeout(timer);media.removeEventListener(event,onOK);media.removeEventListener('error',onError)};
  const onOK=()=>{clean();resolve();};const onError=()=>{clean();reject(new Error('Ошибка декодирования видео'))};
  timer=setTimeout(()=>{clean();reject(new Error(`Тайм-аут: ${event}`))},timeout);
  media.addEventListener(event,onOK,{once:true});media.addEventListener('error',onError,{once:true});
});}
async function seekVideo(media,t) {
  const target=clamp(t,.002,Math.max(.002,media.duration-.025));
  if(Math.abs(media.currentTime-target)>.006){const promise=waitFor(media,'seeked',22000);media.currentTime=target;await promise;}
  if(media.readyState<2)await waitFor(media,'loadeddata',22000);
  await new Promise(resolve=>requestAnimationFrame(resolve));
}
async function generateFilmstrip(){
  const url=state.srcURL;const duration=state.duration;if(!url||!duration)return;
  const holder=$('filmstrip');holder.replaceChildren();
  const sample = document.createElement('video');sample.muted=true;sample.playsInline=true;sample.preload='auto';sample.src=url;
  try {
    sample.load();await waitFor(sample,'loadedmetadata',25000);
    const thumb=document.createElement('canvas');thumb.width=96;thumb.height=96;const ctx=thumb.getContext('2d');
    for(let i=0;i<8;i++) {
      if(url!==state.srcURL)return;
      await seekVideo(sample,duration*i/7);
      ctx.drawImage(sample,0,0,96,96);
      const img=document.createElement('img');img.src=thumb.toDataURL('image/jpeg',.65);img.alt='';holder.appendChild(img);
    }
  } catch(e){console.warn('Cannot make filmstrip:',e.message);}
  finally{sample.pause();sample.removeAttribute('src');sample.load();}
}

function downsampleGray(source,side=138){
  const scale=side/Math.max(source.width,source.height);const w=Math.round(source.width*scale),h=Math.round(source.height*scale);
  const cv=document.createElement('canvas');cv.width=w;cv.height=h;const cx=cv.getContext('2d',{willReadFrequently:true});
  cx.drawImage(source,0,0,w,h);const data=cx.getImageData(0,0,w,h).data,arr=new Uint8Array(w*h);
  for(let p=0;p<arr.length;p++)arr[p]=(data[p*4]*3+data[p*4+1]*6+data[p*4+2])/10;
  return {w,h,arr};
}
// Background-only translational stabilization: safe, small corrections (no invented image detail).
function estimateShift(reference,candidate){
  const a=downsampleGray(reference),b=downsampleGray(candidate);if(a.w!==b.w||a.h!==b.h)return{x:0,y:0};
  const {w,h}=a,max=3;let best=Infinity,dxBest=0,dyBest=0;
  for(let dy=-max;dy<=max;dy++)for(let dx=-max;dx<=max;dx++){
    let loss=0,n=0;
    for(let y=10;y<h-10;y+=3)for(let x=8;x<w-8;x+=3){
      // Prefer mostly static upper architecture and peripheral floor, avoid main subject and crowd.
      if(y>h*.36&&y<h*.77&&x>w*.23&&x<w*.83)continue;
      const xx=x-dx,yy=y-dy;if(xx<0||yy<0||xx>=w||yy>=h)continue;
      const v=Math.abs(a.arr[y*w+x]-b.arr[yy*w+xx]);loss+=Math.min(v,38);n++;
    }
    const score=loss/Math.max(1,n)+.3*(Math.abs(dx)+Math.abs(dy));
    if(score<best){best=score;dxBest=dx;dyBest=dy;}
  }
  const scale=reference.width/w;
  return{x:Math.round(dxBest*scale),y:Math.round(dyBest*scale)};
}
function stabilizeFrames(){
  const ref=state.frames[0];state.shifts=state.frames.map(()=>({x:0,y:0}));
  if(!$('stabilize').checked)return;
  for(let i=1;i<state.frames.length;i++){
    const move=estimateShift(ref,state.frames[i]);
    state.shifts[i]=move;
    if(Math.abs(move.x)+Math.abs(move.y)<1)continue;
    const aligned=document.createElement('canvas');aligned.width=ref.width;aligned.height=ref.height;
    const cx=aligned.getContext('2d');cx.drawImage(ref,0,0);cx.drawImage(state.frames[i],move.x,move.y);
    state.frames[i]=aligned;
  }
}
function setCanvasDimensions(){
  canvas.width=state.canvasW;canvas.height=state.canvasH;state.zoom=1;$('zoom').value='1';setZoom();
  output.width=state.canvasW;output.height=state.canvasH;
}
async function extractFrames(){
  if(!state.duration||state.extracting||state.processing)return;
  state.extracting=true;rawVideo.pause();$('extract').disabled=true;releaseFrames();busy('Извлекаю реальные кадры…');
  const duration=state.end-state.start;const count=Number($('candidateCount').value);
  const sample=document.createElement('video');sample.muted=true;sample.playsInline=true;sample.preload='auto';sample.src=state.srcURL;
  try{
    sample.load();await waitFor(sample,'loadedmetadata',26000);
    const side=Number($('resolution').value);const f=Math.min(1,side/Math.max(sample.videoWidth,sample.videoHeight));
    const w=Math.max(2,Math.round(sample.videoWidth*f)),h=Math.max(2,Math.round(sample.videoHeight*f));
    state.canvasW=w;state.canvasH=h;
    const source=document.createElement('canvas');source.width=w;source.height=h;
    const sc=source.getContext('2d',{alpha:false});
    for(let i=0;i<count;i++){
      const t=state.start+duration*i/(count-1);
      busy(`Извлечение кадров: ${i+1}/${count} · ${round(t)} с`);
      await seekVideo(sample,t);
      sc.drawImage(sample,0,0,w,h);
      const frame=document.createElement('canvas');frame.width=w;frame.height=h;
      frame.getContext('2d',{alpha:false}).drawImage(source,0,0);
      state.frames.push(frame);state.times.push(t);
      await sleep(0);
    }
    state.masks=Array(count).fill(null);state.selected=Math.floor((count-1)/2);state.backgroundCache=null;
    busy('Выравниваю небольшие сдвиги камеры…');stabilizeFrames();setCanvasDimensions();
    renderPhaseStrip();renderSubject();
    $('subjectStep').hidden=false;$('resultStep').hidden=false;
    $('segFeedback').textContent='Нажми на дочь на крупном кадре: программа найдёт её на остальных фазах и выберет неповторяющиеся положения.';
    $('resultStatus').textContent='Сначала выбери человека на любом кадре.';
    $('export').disabled=true;status(`Готово: ${count} кадров (${round(state.start)}–${round(state.end)} с). Выбери спортсмена.`);
  }catch(e){status('Не удалось извлечь кадры: '+e.message);releaseFrames();console.error(e);}
  finally{sample.pause();sample.removeAttribute('src');sample.load();state.extracting=false;$('extract').disabled=false;busy(null);}
}
$('extract').addEventListener('click',extractFrames);

const maskPromises=new Map();let maskId=0;
window.motionStackReceive=(id,url,error)=>{
  const req=maskPromises.get(Number(id));if(!req)return;
  maskPromises.delete(Number(id));clearTimeout(req.timer);
  if(error)req.reject(new Error(String(error)));
  else if(typeof url!=='string'||!url.startsWith('data:image/png;base64,'))req.reject(new Error('Неверная маска от Android'));
  else req.resolve(url);
};
function nativeSegment(dataURL,x,y){
  return new Promise((resolve,reject)=>{
    if(!hasNative())return reject(new Error('Модель доступна только в Android APK.'));
    const id=++maskId;
    const timer=setTimeout(()=>{maskPromises.delete(id);reject(new Error('Нейросеть не ответила за 60 секунд'))},60000);
    maskPromises.set(id,{resolve,reject,timer});
    try{window.AndroidBridge.segmentFrame(id,dataURL,clamp(x,.001,.999),clamp(y,.001,.999));}
    catch(e){clearTimeout(timer);maskPromises.delete(id);reject(e);}
  });
}
function imageFromURL(src){return new Promise((resolve,reject)=>{const i=new Image();i.onload=()=>resolve(i);i.onerror=()=>reject(new Error('Маска PNG не загрузилась'));i.src=src;});}
function maskSource(frame,seed,overrideZoom){
  const scale=overrideZoom||Number($('cropScale').value);
  const width=Math.min(frame.width,Math.max(32,Math.round(frame.width/scale)));
  const height=Math.min(frame.height,Math.max(32,Math.round(frame.height/scale)));
  const x=Math.round(clamp(seed.x*frame.width-width/2,0,frame.width-width));
  const y=Math.round(clamp(seed.y*frame.height-height/2,0,frame.height-height));
  const input=document.createElement('canvas');const f=Math.min(1,800/Math.max(width,height));input.width=Math.round(width*f);input.height=Math.round(height*f);
  input.getContext('2d').drawImage(frame,x,y,width,height,0,0,input.width,input.height);
  return {x,y,width,height,input,px:clamp((seed.x*frame.width-x)/width,.001,.999),py:clamp((seed.y*frame.height-y)/height,.001,.999)};
}
// A downscaled mask is enough for overlay and quality checks and saves phone memory.
function cropMaskTouchesBorder(image) {
  const probe=document.createElement('canvas');probe.width=96;probe.height=96;
  const ctx=probe.getContext('2d',{willReadFrequently:true});ctx.drawImage(image,0,0,96,96);
  const data=ctx.getImageData(0,0,96,96).data;
  let border=0;
  for(let y=0;y<96;y++)for(let x=0;x<96;x++) {
    if(x>=2&&x<94&&y>=2&&y<94)continue;
    if(data[(y*96+x)*4+3]>145)border++;
  }
  return border>6;
}
function maskWithStats(image,crop,frame) {
  const full=document.createElement('canvas');const ratio=Math.min(1,640/Math.max(frame.width,frame.height));
  full.width=Math.max(40,Math.round(frame.width*ratio));full.height=Math.max(40,Math.round(frame.height*ratio));
  const fx=full.getContext('2d',{willReadFrequently:true});
  fx.drawImage(image,crop.x*ratio,crop.y*ratio,crop.width*ratio,crop.height*ratio);
  const data=fx.getImageData(0,0,full.width,full.height).data;
  let pixels=0,mass=0,sx=0,sy=0,x0=full.width,y0=full.height,x1=-1,y1=-1,border=0;
  for(let y=0;y<full.height;y++)for(let x=0;x<full.width;x++){
    const alpha=data[(y*full.width+x)*4+3];if(alpha<90)continue;
    pixels++;mass+=alpha;sx+=alpha*x;sy+=alpha*y;
    x0=Math.min(x0,x);x1=Math.max(x1,x);y0=Math.min(y0,y);y1=Math.max(y1,y);
    if(x===0||x===full.width-1||y===0||y===full.height-1)border++;
  }
  const n=full.width*full.height,ratioArea=pixels/n;
  const bbox={x:x0/full.width,y:y0/full.height,w:Math.max(0,x1-x0+1)/full.width,h:Math.max(0,y1-y0+1)/full.height};
  const center={x:mass?sx/mass/full.width:.5,y:mass?sy/mass/full.height:.5};
  const side=pixels?Math.sqrt(Math.max(1,(x1-x0+1)*(y1-y0+1))):0;
  const compactness=pixels?pixels/Math.max(1,(x1-x0+1)*(y1-y0+1)):0;
  const stats={bbox,center,area:ratioArea,px:pixels,border,compactness,side};
  return {canvas:full,stats};
}
function appearanceSample(frame,mask,seed,bbox) {
  // Coarse clothing-color signature around the tapped torso; NOT facial recognition.
  const W=frame.width,H=frame.height,px=seed.x*W,py=seed.y*H;
  const rx=Math.max(5,Math.round(bbox.w*W*.33)),ry=Math.max(6,Math.round(bbox.h*H*.23));
  const x0=clamp(Math.round(px-rx),0,W-1),y0=clamp(Math.round(py-ry),0,H-1);
  const x1=clamp(Math.round(px+rx),x0+1,W),y1=clamp(Math.round(py+ry),y0+1,H);
  const width=x1-x0,height=y1-y0;
  const pixels=frame.getContext('2d',{willReadFrequently:true}).getImageData(x0,y0,width,height).data;
  const mdata=mask.getContext('2d',{willReadFrequently:true}).getImageData(0,0,mask.width,mask.height).data;
  let rr=0,gg=0,bb=0,n=0;
  for(let dy=0;dy<height;dy+=Math.max(2,Math.round(height/12)))
    for(let dx=0;dx<width;dx+=Math.max(2,Math.round(width/12))){
      const gx=x0+dx,gy=y0+dy;
      const mx=Math.min(mask.width-1,Math.floor(gx/W*mask.width)),my=Math.min(mask.height-1,Math.floor(gy/H*mask.height));
      if(mdata[(my*mask.width+mx)*4+3]<90)continue;
      const ii=(dy*width+dx)*4;rr+=pixels[ii];gg+=pixels[ii+1];bb+=pixels[ii+2];n++;
    }
  return n>=4?[rr/(n*255),gg/(n*255),bb/(n*255)]:null;
}
function goodMask(entry,seed,previous=null) {
  const s=entry.stats;
  if(s.px<18)return {good:false,reason:'Слишком маленький объект'};
  if(s.area>.18)return {good:false,reason:'Выделен слишком большой участок фона'};
  if(s.border>Math.max(7,s.side*.24))return {good:false,reason:'Маска упирается в край кадра'};
  if(s.compactness<.1)return {good:false,reason:'Силуэт слишком разорван'};
  if(s.bbox.w>.8||s.bbox.h>.85)return {good:false,reason:'Подозрительно большой силуэт'};
  const tapAlpha=maskAlpha(entry.canvas,seed.x,seed.y);
  if(tapAlpha<55)return {good:false,reason:'Выбранная точка не принадлежит маске'};
  if(previous){
    const d=Math.hypot(s.center.x-previous.center.x,s.center.y-previous.center.y);
    const maxJump=Math.max(.07,Math.sqrt(previous.area)*2.8);
    if(d>maxJump)return {good:false,reason:'Человек резко переместился: возможно, выбран другой'};
    if(s.area>previous.area*4.2||s.area<previous.area*.2)return {good:false,reason:'Площадь силуэта резко изменилась'};
    if(s.appearance && previous.appearance){
      const colorDrift=Math.hypot(...s.appearance.map((v,j)=>v-previous.appearance[j]));
      if(colorDrift>.4)return {good:false,reason:'Цвет выбранного объекта сильно отличается: проверь человека'};
    }
  }
  return {good:true,reason:'Маска построена'};
}
function maskAlpha(mask,x,y){
  const cx=mask.getContext('2d',{willReadFrequently:true});
  return cx.getImageData(clamp(Math.floor(x*mask.width),0,mask.width-1),clamp(Math.floor(y*mask.height),0,mask.height-1),1,1).data[3];
}
async function findMask(i,seed,previous=null) {
  const frame=state.frames[i]; const initial=Number($('cropScale').value);
  const zooms=[...new Set([initial,Math.max(1,initial/1.6),1].map(n=>Number(n.toFixed(2))))];
  let last=null;
  for(let a=0;a<zooms.length;a++){
    const crop=maskSource(frame,seed,zooms[a]);
    const data=await nativeSegment(crop.input.toDataURL('image/jpeg',.86),crop.px,crop.py);
    const img=await imageFromURL(data);
    if(cropMaskTouchesBorder(img)&&a<zooms.length-1)continue;
    const out=maskWithStats(img,crop,frame);
    out.stats.appearance=appearanceSample(frame,out.canvas,seed,out.stats.bbox);
    const result=goodMask(out,seed,previous);
    last={...out,seed,valid:result.good,reason:result.reason,time:state.times[i],kind:'auto'};
    if(result.good) return last;
    // Enlarging the crop can repair clipped arms/skateboard, but never hide uncertainty.
  }
  return last;
}
function trackerThumb(index){
  const frame=state.frames[index],w=Math.round(230*frame.width/Math.max(frame.width,frame.height)),h=Math.round(230*frame.height/Math.max(frame.width,frame.height));
  const cv=document.createElement('canvas');cv.width=w;cv.height=h;
  const ctx=cv.getContext('2d',{willReadFrequently:true});ctx.drawImage(frame,0,0,w,h);
  return {w,h,data:ctx.getImageData(0,0,w,h).data};
}
// Patch-based forward/backward tracking; quality gate still checks each segmentation mask.
function trackSeed(prevIndex,i,point) {
  const a=trackerThumb(prevIndex),b=trackerThumb(i);
  const x=Math.floor(point.x*a.w),y=Math.floor(point.y*a.h);
  const maxRadius=Math.max(4,Math.floor(Math.min(a.w,a.h)*.115));
  const patch=Math.max(3,Math.floor(Math.min(a.w,a.h)*.035));
  const samples=[];
  for(let yy=-patch;yy<=patch;yy+=2)for(let xx=-patch;xx<=patch;xx+=2){
    const sx=x+xx,sy=y+yy;if(sx<0||sx>=a.w||sy<0||sy>=a.h)continue;
    const p=(sy*a.w+sx)*4;samples.push([xx,yy,a.data[p],a.data[p+1],a.data[p+2]]);
  }
  if(!samples.length)return point;
  let best=Infinity,bx=x,by=y;
  for(let yy=Math.max(patch,y-maxRadius);yy<Math.min(b.h-patch,y+maxRadius);yy+=2)
  for(let xx=Math.max(patch,x-maxRadius);xx<Math.min(b.w-patch,x+maxRadius);xx+=2){
    let loss=0;
    for(const [dx,dy,r,g,bl] of samples){const p=((yy+dy)*b.w+xx+dx)*4;
      const dr=r-b.data[p],dg=g-b.data[p+1],db=bl-b.data[p+2];
      loss+=Math.min(300,Math.abs(dr)+Math.abs(dg)+Math.abs(db));}
    loss=loss/samples.length+0.22*(Math.abs(xx-x)+Math.abs(yy-y));
    if(loss<best){best=loss;bx=xx;by=yy;}
  }
  return {x:clamp(bx/b.w,.001,.999),y:clamp(by/b.h,.001,.999)};
}
function phaseThumb(i){
  const cv=document.createElement('canvas');cv.width=100;cv.height=100;
  cv.getContext('2d').drawImage(state.frames[i],0,0,100,100);
  return cv.toDataURL('image/jpeg',.66);
}
const phaseThumbs=new Map();
function renderPhaseStrip(){
  const strip=$('phaseStrip');strip.replaceChildren();
  for(let i=0;i<state.frames.length;i++){
    const entry=state.masks[i],enabled=state.enabled.has(i),button=document.createElement('button');
    button.className='phase'+(state.selected===i?' selected':'')+(!enabled?' off':'')+(entry&&!entry.valid?' bad':'');
    button.type='button';button.setAttribute('aria-label','Кадр '+(i+1));
    if(!phaseThumbs.has(i))phaseThumbs.set(i,phaseThumb(i));
    const img=document.createElement('img');img.src=phaseThumbs.get(i);img.alt='Кадр '+(i+1);
    const tm=document.createElement('small');tm.textContent=`${round(state.times[i])} с`;
    const flag=document.createElement('span');flag.textContent=entry?(entry.valid?(enabled?'✓':'◦'):'!'):'–';
    button.append(img,tm,flag);
    button.addEventListener('click',()=>{state.selected=i;renderPhaseStrip();renderSubject();});
    strip.appendChild(button);
  }
}
function setZoom(){const w=Math.min(480,Math.max(240,window.innerWidth-56));
  canvas.style.width=Math.round(w*state.zoom)+'px';canvas.style.height='auto';
  $('zoomLabel').textContent=state.zoom+'×';
}
$('zoom').addEventListener('input',e=>{
  state.zoom=Number(e.target.value);setZoom();renderSubject();
  const vp=$('subjectViewport');
  vp.scrollLeft=(vp.scrollWidth-vp.clientWidth)/2;
  vp.scrollTop=(vp.scrollHeight-vp.clientHeight)/2;
});
function renderSubject(){
  if(!state.frames.length)return;
  const i=state.selected,entry=state.masks[i],frame=state.frames[i];
  cctx.clearRect(0,0,canvas.width,canvas.height);cctx.drawImage(frame,0,0);
  if(entry?.canvas){
    const tint=document.createElement('canvas');tint.width=entry.canvas.width;tint.height=entry.canvas.height;
    const tc=tint.getContext('2d');tc.drawImage(entry.canvas,0,0);
    tc.globalCompositeOperation='source-in';tc.fillStyle=entry.valid?'#62f0af':'#ff8b8b';
    tc.fillRect(0,0,tint.width,tint.height);
    cctx.save();cctx.globalAlpha=.55;cctx.drawImage(tint,0,0,canvas.width,canvas.height);cctx.restore();
  }
  $('currentFrameLabel').textContent=`Кадр ${i+1} · ${round(state.times[i])} с`;
  $('maskStatus').textContent=entry?(entry.valid?'✓ Выделен':`⚠ ${entry.reason}`):'Не выделен';
  $('maskStatus').style.color=entry?(entry.valid?'var(--green)':'var(--red)'):'var(--muted)';
}
function setEditMode(mode){state.mode=mode;for(const id of ['tapMode','panMode','addBoard'])$(id).classList.toggle('selected',
  (mode==='tap'&&id==='tapMode')||(mode==='pan'&&id==='panMode')||(mode==='board'&&id==='addBoard'));
  canvas.style.cursor=mode==='pan'?'grab':'crosshair';}
$('tapMode').addEventListener('click',()=>setEditMode('tap'));
$('panMode').addEventListener('click',()=>setEditMode('pan'));
$('addBoard').addEventListener('click',()=>setEditMode('board'));
$('redoPhase').addEventListener('click',()=>{state.masks[state.selected]=null;state.backgroundCache=null;state.enabled.delete(state.selected);setEditMode('tap');renderPhaseStrip();renderSubject();renderOutput();$('segFeedback').textContent='Нажми ещё раз на человека на этом кадре.';});
$('excludePhase').addEventListener('click',()=>{state.enabled.delete(state.selected);renderPhaseStrip();renderOutput()});
$('includePhase').addEventListener('click',()=>{if(state.masks[state.selected]?.valid){state.enabled.add(state.selected);renderPhaseStrip();renderOutput();}else $('segFeedback').textContent='Сперва исправь выделение на этом кадре.';});
$('reselectPhases').addEventListener('click',()=>{autoPickPhases();renderPhaseStrip();renderOutput()});
$('stabilize').addEventListener('change',()=>{$('segFeedback').textContent='Настройка выравнивания вступит в силу после повторного извлечения кадров.';});
canvas.addEventListener('pointerdown',async e=>{
  if(state.processing||!state.frames.length)return;
  if(state.mode==='pan'){
    canvas.setPointerCapture(e.pointerId);state.pan={x:e.clientX,y:e.clientY,l:$('subjectViewport').scrollLeft,t:$('subjectViewport').scrollTop};return;
  }
  const rect=canvas.getBoundingClientRect();const x=clamp((e.clientX-rect.left)/rect.width,.001,.999),y=clamp((e.clientY-rect.top)/rect.height,.001,.999);
  e.preventDefault();
  if(state.mode==='board')await addBoardAt({x,y});
  else await autoSegmentAll({x,y});
});
canvas.addEventListener('pointermove',e=>{
  if(!state.pan)return;
  $('subjectViewport').scrollLeft=state.pan.l+state.pan.x-e.clientX;
  $('subjectViewport').scrollTop=state.pan.t+state.pan.y-e.clientY;
});
canvas.addEventListener('pointerup',()=>state.pan=null);
canvas.addEventListener('pointercancel',()=>state.pan=null);
async function addBoardAt(point){
  if(state.processing)return;const i=state.selected,original=state.masks[i];
  if(!original||!original.valid){$('segFeedback').textContent='Сначала выдели человека, затем добавь доску.';return;}
  state.processing=true;busy('Ищу скейтборд на выбранном кадре…');
  try{
    const board=await findMask(i,point);
    if(!board||!board.valid)throw new Error(board?.reason||'Доска не найдена');
    const cx=original.canvas.getContext('2d');cx.drawImage(board.canvas,0,0);
    // Update quality stats on combined silhouette; keep prior identity confidence.
    original.stats=maskWithStats(original.canvas,{x:0,y:0,width:state.canvasW,height:state.canvasH},state.frames[i]).stats;
    state.backgroundCache=null;state.enabled.add(i);renderPhaseStrip();renderSubject();renderOutput();
    $('segFeedback').textContent='Дополнительный объект добавлен на кадр '+(i+1)+'. Проверь контур.';
  }catch(e){$('segFeedback').textContent='Не получилось добавить доску: '+e.message;}
  finally{state.processing=false;busy(null);}
}

function bboxIoU(a,b){
  const x0=Math.max(a.x,b.x),y0=Math.max(a.y,b.y),x1=Math.min(a.x+a.w,b.x+b.w),y1=Math.min(a.y+a.h,b.y+b.h);
  const intersection=Math.max(0,x1-x0)*Math.max(0,y1-y0),union=a.w*a.h+b.w*b.h-intersection;
  return union>0?intersection/union:0;
}
function phaseDistance(i,j){
  const a=state.masks[i].stats,b=state.masks[j].stats;
  const dist=Math.hypot(a.center.x-b.center.x,a.center.y-b.center.y);
  const scale=Math.max(.025,Math.sqrt((a.area+b.area)/2));
  return .58*clamp(dist/(scale*2.0),0,1)+.32*(1-bboxIoU(a.bbox,b.bbox))+.10*Math.abs(state.times[i]-state.times[j])/(state.end-state.start);
}
function autoPickPhases(){
  const viable=state.masks.map((m,i)=>m?.valid?i:-1).filter(i=>i>=0);
  state.enabled.clear();if(!viable.length)return;
  const cap=Math.min(Number($('phaseCount').value),viable.length);
  // Start with the cleanest, reasonably-sized visible subject.
  const score=i=>{const m=state.masks[i].stats;return Math.min(.03,m.area)+.008*Math.min(1,m.compactness/.45)};
  viable.sort((i,j)=>score(j)-score(i));
  state.enabled.add(viable[0]);
  while(state.enabled.size<cap){
    let best=-1,bestD=-1;
    for(const i of viable){if(state.enabled.has(i))continue;
      const minD=Math.min(...[...state.enabled].map(j=>phaseDistance(i,j)));
      if(minD>bestD){bestD=minD;best=i;}
    }
    if(best<0 || bestD<.25)break; // do not force visually overlapping silhouettes
    state.enabled.add(best);
  }
  $('segFeedback').textContent=`Выбрано ${state.enabled.size} разных фаз из ${viable.length} уверенно выделенных. Остальные выключены, но их можно включить вручную.`;
}
async function autoSegmentAll(point){
  if(state.processing||!state.frames.length)return;
  if(!hasNative()){$('segFeedback').textContent='Автоматическая сегментация работает только в APK для Android.';return;}
  state.processing=true;state.busyRun++;const run=state.busyRun;
  const origin=state.selected;
  const orders=[origin];for(let i=origin+1;i<state.frames.length;i++)orders.push(i);
  for(let i=origin-1;i>=0;i--)orders.push(i);
  let last=origin,prevSeed=point,prevStats=null,previousDirection=1,accepted=0,suspect=0;
  try{
    for(const i of orders){
      const dir=i>=origin?1:-1;
      if(i===origin||dir!==previousDirection){last=origin;prevSeed=point;prevStats=null;}
      if(i!==origin)prevSeed=trackSeed(last,i,prevSeed);
      busy(`AI-маски: ${accepted+suspect+1}/${orders.length} · ${round(state.times[i])} с`);
      let entry;
      try { entry=await findMask(i,prevSeed,prevStats); }
      catch(e){entry={valid:false,reason:e.message,time:state.times[i]};}
      state.masks[i]=entry;state.backgroundCache=null;
      if(entry.valid){accepted++;prevStats=entry.stats;prevSeed={x:.75*prevSeed.x+.25*entry.stats.center.x,y:.75*prevSeed.y+.25*entry.stats.center.y};}
      else{suspect++; /* do not trust or composite this phase */}
      last=i;previousDirection=dir;
      if(i===state.selected)renderSubject();
      renderPhaseStrip();await sleep(1);
    }
    autoPickPhases();renderPhaseStrip();renderSubject();renderOutput();
    $('segFeedback').textContent+=` Надёжно: ${accepted}. Требуют проверки: ${suspect}.`;
  }catch(e){console.error(e);$('segFeedback').textContent='Ошибка обработки: '+e.message;}
  finally{if(state.busyRun===run){state.processing=false;busy(null);}}
}

function maskAt(i){return state.masks[i]?.valid?state.masks[i].canvas:null;}
function drawMaskInFull(ctx,mask){ctx.drawImage(mask,0,0,state.canvasW,state.canvasH);}
function backgroundCanvas(){
  const mode=$('backgroundMode').value;
  if(state.backgroundCache?.mode===mode)return state.backgroundCache.canvas;
  const n=state.frames.length;
  const mid=Math.floor(n/2);
  const validIndices=state.masks.map((m,i)=>m?.valid?i:-1).filter(i=>i>=0);
  const cleanBase=validIndices.sort((a,b)=>Math.abs(a-mid)-Math.abs(b-mid))[0] ?? mid;
  const baseIndex=mode==='last'?n-1:(mode==='first'?0:cleanBase);
  const base=state.frames[baseIndex];
  const bg=document.createElement('canvas');bg.width=state.canvasW;bg.height=state.canvasH;
  const ctx=bg.getContext('2d',{willReadFrequently:true});ctx.drawImage(base,0,0);
  if(mode==='clean' && maskAt(baseIndex)){
    const baseMask=maskAt(baseIndex),w=bg.width,h=bg.height;
    const mctx=document.createElement('canvas');mctx.width=w;mctx.height=h;
    const mx=mctx.getContext('2d',{willReadFrequently:true});drawMaskInFull(mx,baseMask);
    const mdata=mx.getImageData(0,0,w,h).data;
    const pix=ctx.getImageData(0,0,w,h);
    // Get donor pixels from temporally distant UNMASKED frames only.
    const donors=[];
    const order=Array.from({length:n},(_,i)=>i).filter(i=>i!==baseIndex&&maskAt(i));
    order.sort((a,b)=>Math.abs(a-baseIndex)-Math.abs(b-baseIndex));
    // Limit memory consumption: only load the largest few distinct source frames.
    for(const i of order.slice(0,10)){
      const mc=document.createElement('canvas');mc.width=w;mc.height=h;
      const mcx=mc.getContext('2d',{willReadFrequently:true});drawMaskInFull(mcx,maskAt(i));
      donors.push({image:state.frames[i].getContext('2d',{willReadFrequently:true}).getImageData(0,0,w,h).data,
                   mask:mcx.getImageData(0,0,w,h).data});
    }
    if(donors.length){
      for(let p=0;p<pix.data.length;p+=4){
        const baseAlpha=mdata[p+3];if(baseAlpha<12)continue;
        let donor=null;
        for(const d of donors){if(d.mask[p+3]<16){donor=d.image;break;}}
        if(!donor)continue;
        const alpha=baseAlpha/255;
        for(let k=0;k<3;k++)pix.data[p+k]=pix.data[p+k]*(1-alpha)+donor[p+k]*alpha;
      }
      ctx.putImageData(pix,0,0);
    }
  }
  state.backgroundCache={mode,canvas:bg};return bg;
}
function actionRect(){
  const W=state.canvasW,H=state.canvasH;
  const indices=[...state.enabled].filter(i=>maskAt(i));
  if(!indices.length)return{x:0,y:0,w:W,h:H};
  let x0=1,y0=1,x1=0,y1=0;
  for(const i of indices){const r=state.masks[i].stats.bbox;x0=Math.min(x0,r.x);y0=Math.min(y0,r.y);x1=Math.max(x1,r.x+r.w);y1=Math.max(y1,r.y+r.h);}
  const padX=Math.max(.06,(x1-x0)*.30),padY=Math.max(.06,(y1-y0)*.32);
  x0=clamp(x0-padX,0,1);x1=clamp(x1+padX,0,1);y0=clamp(y0-padY,0,1);y1=clamp(y1+padY,0,1);
  let w=Math.max(.36,x1-x0)*W,h=Math.max(.34,y1-y0)*H;
  let cx=(x0+x1)/2*W,cy=(y0+y1)/2*H;
  w=Math.min(W,w);h=Math.min(H,h);
  if($('cropMode').value==='portrait'){
    const ratio=.8;if(w/h>ratio)h=w/ratio;else w=h*ratio;
    if(w>W){w=W;h=Math.min(H,w/ratio)}if(h>H){h=H;w=Math.min(W,h*ratio)}
  }
  return{x:Math.round(clamp(cx-w/2,0,W-w)),y:Math.round(clamp(cy-h/2,0,H-h)),w:Math.round(w),h:Math.round(h)};
}
function renderOutput(){
  if(!state.frames.length)return;
  const enabled=[...state.enabled].filter(i=>maskAt(i)).sort((a,b)=>a-b);
  const crop=$('cropMode').value==='original'?{x:0,y:0,w:state.canvasW,h:state.canvasH}:actionRect();
  const composed=document.createElement('canvas');composed.width=state.canvasW;composed.height=state.canvasH;
  const cx=composed.getContext('2d');cx.drawImage(backgroundCanvas(),0,0);
  if(!state.showRaw){
    const layer=document.createElement('canvas');layer.width=state.canvasW;layer.height=state.canvasH;
    const lc=layer.getContext('2d');
    for(const i of enabled){
      lc.globalCompositeOperation='source-over';lc.clearRect(0,0,layer.width,layer.height);
      lc.drawImage(state.frames[i],0,0);
      lc.globalCompositeOperation='destination-in';drawMaskInFull(lc,maskAt(i));
      lc.globalCompositeOperation='source-over';cx.drawImage(layer,0,0);
    }
  }
  output.width=Math.max(2,crop.w);output.height=Math.max(2,crop.h);
  outctx.clearRect(0,0,output.width,output.height);
  outctx.drawImage(composed,crop.x,crop.y,crop.w,crop.h,0,0,crop.w,crop.h);
  $('export').disabled=enabled.length===0;
  $('resultStatus').textContent=`На фото: ${enabled.length} неповторяющихся фаз · ${crop.w}×${crop.h} px. ${enabled.length<2?'Для хронофотографии нужны хотя бы две достоверные фазы.':''}`;
}
$('backgroundMode').addEventListener('change',()=>{state.backgroundCache=null;renderOutput()});
$('cropMode').addEventListener('change',renderOutput);
$('render').addEventListener('click',renderOutput);
$('compare').addEventListener('click',()=>{state.showRaw=!state.showRaw;$('compare').textContent=state.showRaw?'◉ Вернуться к результату':'◉ Показать исходный фон';renderOutput()});
$('phaseCount').addEventListener('change',()=>{if(state.masks.some(m=>m?.valid)){autoPickPhases();renderPhaseStrip();renderOutput()}});
$('export').addEventListener('click',()=>{
  if(state.enabled.size<1)return;state.showRaw=false;renderOutput();
  const name=`MotionStack_${Date.now()}.png`;
  if(window.AndroidBridge&&typeof AndroidBridge.savePng==='function'){
    try{AndroidBridge.savePng(output.toDataURL('image/png'));status('Открылось сохранение PNG. Выбери папку.')}
    catch(e){status('Ошибка сохранения: '+e.message)}
  }else output.toBlob(blob=>{
    if(!blob)return;const url=URL.createObjectURL(blob),a=document.createElement('a');
    a.href=url;a.download=name;document.body.appendChild(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),8000);
  },'image/png');
});
// Testable helpers; no production network access is needed.
window.MotionStackDebug={state,phaseDistance,autoPickPhases,renderOutput,extractFrames,setTrim,maskWithStats,goodMask,actionRect};