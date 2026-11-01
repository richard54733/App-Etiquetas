import glob, os, re, json, unicodedata, subprocess
from PIL import Image
import numpy as np
SRC='/home/claude/pdfsrc/pdfs de etiquetas'; OUT='/home/claude/app/catalog'
def slug(s):
    s=unicodedata.normalize('NFKD',s).encode('ascii','ignore').decode().lower()
    return re.sub(r'[^a-z0-9]+','-',s).strip('-')
items=[]
for f in sorted(glob.glob(SRC+'/*.pdf'), key=lambda x: os.path.basename(x).lower()):
    base=os.path.basename(f)[:-4]
    raw=re.sub(r'\s+',' ',base.replace(' pim','')).strip()
    code=None; m=re.search(r'\s(\d{3})$',raw)
    if m: code=m.group(1); raw=raw[:m.start()].strip()
    size=None; m=re.search(r'\s(\d+(?:[.,]\d+)?)\s*(L|ML|ml|Ml)$',raw)
    if m:
        n=m.group(1).replace('.',','); u=m.group(2).lower()
        size=(n+' L') if u=='l' else (n+' ml'); raw=raw[:m.start()].strip()
    name=raw.title().replace(' P/ ',' p/ ').replace(' De ',' de ').replace(' Com ',' com ').replace(' Do ',' do ').replace(' Para ',' para ')
    sid=slug(base)
    dst=f'{OUT}/pdf/{sid}.pdf'
    subprocess.run(['cp',f,dst])
    subprocess.run(['pdftoppm','-r','150','-png','-singlefile',f,f'/tmp/th_{sid}'],check=True)
    im=Image.open(f'/tmp/th_{sid}.png').convert('RGB'); a=np.array(im)
    H,W=a.shape[:2]; reg=a[:H//5,:W//3]; mask=(reg<235).any(axis=2); ys,xs=np.where(mask)
    pad=14; box=(max(xs.min()-pad,0),max(ys.min()-pad,0),min(xs.max()+pad,W//3),min(ys.max()+pad,H//5))
    crop=im.crop(box); crop.thumbnail((480,480)); crop.save(f'{OUT}/thumbs/{sid}.webp','WEBP',quality=88)
    items.append(dict(id=sid,name=name,size=size,code=code,file=f'catalog/pdf/{sid}.pdf',thumb=f'catalog/thumbs/{sid}.webp',title=base,pages=1,bytes=os.path.getsize(f)))
json.dump(dict(version=1,items=items),open(f'{OUT}/catalog.json','w'),ensure_ascii=False,indent=1)
print(len(items)); print([ (i['name'],i['size'],i['code']) for i in items[:80]])
