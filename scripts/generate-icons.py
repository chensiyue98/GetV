"""Convert the approved GetV artwork into app and extension icon resources (Pillow)."""
import json
from pathlib import Path
from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parent.parent
source = Image.open(ROOT / 'output/icon/getv-line-icon.png').convert('RGBA')
background = (251, 251, 253, 255)
flat = Image.new('RGBA', source.size, background)
flat.alpha_composite(source)
flat = flat.convert('RGB')

def save(image, path, size):
    image.resize((size, size), Image.Resampling.LANCZOS).save(ROOT / path)

catalog = Path('Shared (App)/Assets.xcassets')
appdir = catalog / 'AppIcon.appiconset'
images = [{'filename': 'icon-ios-1024.png', 'idiom': 'universal', 'platform': 'ios', 'size': '1024x1024'}]
save(flat, appdir / 'icon-ios-1024.png', 1024)
# Native macOS icon silhouette with transparent space outside the rounded tile.
mac = Image.new('RGBA', (1024, 1024))
mask = Image.new('L', (824, 824))
ImageDraw.Draw(mask).rounded_rectangle((0, 0, 823, 823), radius=184, fill=255)
tile = flat.resize((824, 824), Image.Resampling.LANCZOS).convert('RGBA')
tile.putalpha(mask)
mac.alpha_composite(tile, (100, 100))
for points in (16, 32, 128, 256, 512):
    for scale in (1, 2):
        name = f'icon-mac-{points}@{scale}x.png'
        save(mac, appdir / name, points * scale)
        images.append({'filename': name, 'idiom': 'mac', 'scale': f'{scale}x', 'size': f'{points}x{points}'})
(ROOT / appdir / 'Contents.json').write_text(json.dumps({'images': images, 'info': {'author': 'xcode', 'version': 1}}, indent=2) + '\n')
large = []
for scale in (1, 2, 3):
    name = f'icon@{scale}x.png'
    save(flat, catalog / 'LargeIcon.imageset' / name, 128 * scale)
    large.append({'filename': name, 'idiom': 'universal', 'scale': f'{scale}x'})
(ROOT / catalog / 'LargeIcon.imageset/Contents.json').write_text(json.dumps({'images': large, 'info': {'author': 'xcode', 'version': 1}}, indent=2) + '\n')
save(flat, Path('Shared (App)/Resources/Icon.png'), 512)
for size in (48, 64, 96, 128, 256, 512):
    save(flat, Path(f'Shared (Extension)/Resources/images/icon-{size}.png'), size)
print('Generated app, introduction, and extension icons.')
