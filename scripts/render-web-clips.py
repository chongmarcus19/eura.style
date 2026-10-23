"""Rebuild website cuts from the untouched original: python3 scripts/render-web-clips.py [source.mp4]. Requires ffmpeg."""
from pathlib import Path
import subprocess, tempfile, sys
ROOT = Path(__file__).resolve().parents[1]
SOURCE = Path(sys.argv[1]).resolve() if len(sys.argv)>1 else ROOT/'assets/marts/demo.mp4'
OUT = ROOT/'assets/marts'
# start, duration, crop width/height/x/y, playback duration multiplier.
CUTS = {
 'tv-demo': (960,720,[
  (6.35,1.35,(694,520,193,405),1.6),
  (8.7,1.5,(694,520,193,640),1.5),
  (11.9,2.0,(694,520,193,600),1.3),
  (22.35,1.35,(694,520,193,1290),1.8),
  (24.0,1.45,(694,520,193,660),1.5),
  (27.2,1.8,(800,600,140,1100),1.5),
  (32.1,1.7,(694,520,193,660),1.5),
 ]),
 'create-loop': (540,1168,[(6.25,8.5,(694,1502,193,330),1.0)]),
 'refine-loop': (540,1168,[(20.4,5.3,(694,1502,193,330),1.1)]),
 'discover-loop': (540,1168,[(26.9,2.5,(820,1772,130,60),1.2),(32.0,2.2,(694,1502,193,330),1.2)]),
}
with tempfile.TemporaryDirectory() as tmp:
 for name,(width,height,cuts) in CUTS.items():
  parts=[]
  for i,(start,duration,crop,speed) in enumerate(cuts):
   part=Path(tmp)/f'{name}-{i}.mp4'; parts.append(part)
   filters=f"crop={':'.join(map(str,crop))},scale={width}:{height}:flags=lanczos,setsar=1,setpts={speed}*(PTS-STARTPTS),fps=24"
   subprocess.run(['ffmpeg','-hide_banner','-loglevel','error','-ss',str(start),'-i',str(SOURCE),'-t',str(duration*speed),'-vf',filters,'-an','-c:v','libx264','-preset','medium','-crf','21','-pix_fmt','yuv420p','-y',str(part)],check=True)
  listing=Path(tmp)/f'{name}.txt'; listing.write_text(''.join(f"file '{p}'\n" for p in parts))
  subprocess.run(['ffmpeg','-hide_banner','-loglevel','error','-f','concat','-safe','0','-i',str(listing),'-c','copy','-movflags','+faststart','-y',str(OUT/f'{name}.mp4')],check=True)
  subprocess.run(['ffmpeg','-hide_banner','-loglevel','error','-ss','0.6','-i',str(OUT/f'{name}.mp4'),'-frames:v','1','-q:v','2','-y',str(OUT/f'{name}-poster.jpg')],check=True)
  print(f'Rendered {name}',flush=True)
