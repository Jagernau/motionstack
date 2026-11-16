"""Optional browser integration smoke test. pip install playwright, Chrome/Chromium required.
Usage: python tests/smoke_test.py /path/to/example.mp4
"""
import sys
from pathlib import Path
from playwright.sync_api import sync_playwright
root=Path(__file__).resolve().parents[1]
video=Path(sys.argv[1] if len(sys.argv)>1 else '/mnt/data/PXL_20261003_084004389.mp4')
assert video.is_file()
html=(root/'index.html').read_text().replace('<script src="studio.js"></script>','<script>'+(root/'studio.js').read_text()+'</script>')
with sync_playwright() as p:
 browser=p.chromium.launch(headless=True,executable_path='/usr/bin/chromium',args=['--no-sandbox','--autoplay-policy=no-user-gesture-required'])
 page=browser.new_page(viewport={'width':420,'height':860})
 errors=[]
 page.on('pageerror',lambda e: errors.append(str(e)))
 page.set_content(html,wait_until='load')
 page.locator('#videoFile').set_input_files(str(video))
 page.wait_for_function('window.MotionStackDebug.state.duration>0',timeout=20000)
 assert page.locator('#preview').is_visible()
 assert page.locator('#startRange').is_enabled()
 page.locator('#candidateCount').select_option('12')
 page.locator('#resolution').select_option('840')
 page.locator('#extract').click()
 page.wait_for_function('!MotionStackDebug.state.extracting',timeout=44000)
 assert page.evaluate('MotionStackDebug.state.frames.length')==12, page.locator('#status').inner_text()
 assert page.locator('#subjectStep').is_visible()
 page.evaluate('''() => {
  window.AndroidBridge = {
    segmentFrame: (id,data,x,y) => {
      const im=new Image();
      im.onload=()=>{
        const c=document.createElement('canvas');c.width=im.width;c.height=im.height;
        const ctx=c.getContext('2d');ctx.fillStyle='#ffffff';
        ctx.beginPath();ctx.ellipse(x*im.width,y*im.height,im.width*.065,im.height*.18,0,0,Math.PI*2);ctx.fill();
        window.motionStackReceive(id,c.toDataURL('image/png'),null);
      };im.src=data;
    },savePng:()=>{}
  };
}''')
 page.evaluate('autoSegmentAll({x:0.5,y:0.5})')
 page.wait_for_function('!MotionStackDebug.state.processing',timeout=45000)
 valid=page.evaluate('MotionStackDebug.state.masks.filter(m=>m?.valid).length')
 selected=page.evaluate('MotionStackDebug.state.enabled.size')
 dims=page.evaluate('[document.querySelector("#resultCanvas").width,document.querySelector("#resultCanvas").height]')
 print('video metadata',page.evaluate('MotionStackDebug.state.duration'))
 print('extracted',page.evaluate('MotionStackDebug.state.frames.length'),'valid',valid,'selected',selected,'output',dims)
 assert valid>=6, page.locator('#segFeedback').inner_text()
 assert selected>=1
 assert dims[0]>0 and dims[1]>0
 assert not errors, errors
 page.screenshot(path=str(root/'tests/test_after_mask.png'),full_page=True)
 browser.close()
