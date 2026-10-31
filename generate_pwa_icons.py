import os
import shutil
import pymupdf
from PIL import Image

# 1. Base App Icon SVG (Standard Any-purpose Icon)
# Blue rounded app badge with airplane silhouette, clean gradient effect and soft circle
svg_standard_template = """<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="512" height="512">
  <defs>
    <linearGradient id="bgGrad" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#2d8cf0"/>
      <stop offset="100%" stop-color="#1557bf"/>
    </linearGradient>
    <filter id="shadow" x="-10%" y="-10%" width="120%" height="120%">
      <feDropShadow dx="0" dy="16" stdDeviation="20" flood-color="#0a2550" flood-opacity="0.35"/>
    </filter>
  </defs>
  <!-- Background with smooth rounded rectangle -->
  <rect width="512" height="512" rx="115" fill="url(#bgGrad)"/>
  <circle cx="256" cy="256" r="210" fill="#ffffff" opacity="0.08"/>
  <!-- Airplane Graphic -->
  <g transform="translate(256, 256) scale(6.2) translate(-32, -32)" filter="url(#shadow)">
    <path d="M45 47 41 29l8-8c3-3 4-7 2.5-8.5-1.5-1.5-5.5-.5-8.5 2.5l-8 8-18-4-3 3 13 8-5 7h-6l-2 2 7 4 4 7 2-2v-6l7-5 8 13 3-3z" fill="#ffffff"/>
  </g>
</svg>"""

# 2. Maskable Icon SVG (Safe zone: inner 80% circle, 10% padding on all sides)
svg_maskable_template = """<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="512" height="512">
  <defs>
    <linearGradient id="bgGradMask" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#2d8cf0"/>
      <stop offset="100%" stop-color="#1557bf"/>
    </linearGradient>
    <filter id="shadowMask" x="-10%" y="-10%" width="120%" height="120%">
      <feDropShadow dx="0" dy="12" stdDeviation="16" flood-color="#0a2550" flood-opacity="0.35"/>
    </filter>
  </defs>
  <!-- Full bleed background for maskable -->
  <rect width="512" height="512" fill="url(#bgGradMask)"/>
  <circle cx="256" cy="256" r="190" fill="#ffffff" opacity="0.08"/>
  <!-- Scaled down airplane safely inside 80% safe zone (radius 204px) -->
  <g transform="translate(256, 256) scale(5.2) translate(-32, -32)" filter="url(#shadowMask)">
    <path d="M45 47 41 29l8-8c3-3 4-7 2.5-8.5-1.5-1.5-5.5-.5-8.5 2.5l-8 8-18-4-3 3 13 8-5 7h-6l-2 2 7 4 4 7 2-2v-6l7-5 8 13 3-3z" fill="#ffffff"/>
  </g>
</svg>"""

out_dirs = ['assets/icons', 'dist/assets/icons']
for d in out_dirs:
    os.makedirs(d, exist_ok=True)

def render_svg_to_png(svg_str, target_path, size):
    doc = pymupdf.open("svg", svg_str.encode('utf-8'))
    page = doc[0]
    zoom = size / 512.0
    mat = pymupdf.Matrix(zoom, zoom)
    pix = page.get_pixmap(matrix=mat, alpha=True)
    pix.save(target_path)
    print(f"Rendered: {target_path} ({pix.width}x{pix.height})")

# Generate standard icons
render_svg_to_png(svg_standard_template, 'assets/icons/icon-512.png', 512)
render_svg_to_png(svg_standard_template, 'assets/icons/icon-192.png', 192)
render_svg_to_png(svg_standard_template, 'assets/icons/apple-touch-icon.png', 180)
render_svg_to_png(svg_standard_template, 'assets/icons/favicon-32.png', 32)
render_svg_to_png(svg_standard_template, 'assets/icons/favicon-16.png', 16)

# Generate maskable icons
render_svg_to_png(svg_maskable_template, 'assets/icons/icon-maskable-512.png', 512)
render_svg_to_png(svg_maskable_template, 'assets/icons/icon-maskable-192.png', 192)

# Copy to dist/assets/icons
for fname in os.listdir('assets/icons'):
    src = os.path.join('assets/icons', fname)
    dst = os.path.join('dist/assets/icons', fname)
    shutil.copy2(src, dst)
    print(f"Copied to {dst}")

print("All PWA icons generated successfully!")
