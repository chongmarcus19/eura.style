"""Render the website's mobile crop from assets/marts/demo.mp4.

Review caption framing and these scene boundaries after replacing the master.
The first 3.6 seconds and final 4.6 seconds retain wider title-card framing.
"""
from pathlib import Path
import subprocess

assets = Path(__file__).resolve().parents[1] / 'assets' / 'marts'
subprocess.run([
    'ffmpeg', '-y', '-i', str(assets / 'demo.mp4'), '-filter_complex',
    "[0:v]split=2[wide][tight];"
    "[wide]crop=900:1920:90:0,scale=780:1664,pad=780:1920:0:128:color=0xF3EFE6[a];"
    "[tight]crop=780:1920:150:0[b];"
    "[a][b]blend=all_expr='if(lt(T,3.6)+gte(T,34),A,B)'[v]",
    '-map', '[v]', '-c:v', 'libx264', '-crf', '18', '-preset', 'fast',
    '-pix_fmt', 'yuv420p', '-movflags', '+faststart', '-an',
    str(assets / 'demo-mobile.mp4'), '-loglevel', 'error',
], check=True)
subprocess.run([
    'ffmpeg', '-y', '-ss', '12.6', '-i', str(assets / 'demo-mobile.mp4'),
    '-frames:v', '1', '-q:v', '2', str(assets / 'demo-mobile-poster.jpg'),
    '-loglevel', 'error',
], check=True)
