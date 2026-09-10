"""Build a reviewed snapshot from downloaded official HTML; never invent missing fields.
Input HTML is temporary research material, not part of the application or handoff.
Output consists only of public business facts and attributed image references.
"""
import copy
import hashlib
import html
import json
import re
from pathlib import Path
from html.parser import HTMLParser

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / 'backend/data'
STAMP = '2026-09-09T00:00:00Z'
ASSETS = {}

def clean(value):
    return ' '.join(html.unescape(re.sub('<[^>]+>', ' ', value)).split())

class Page(HTMLParser):
    def __init__(self, source):
        super().__init__(); self.images = []; self.gallery = []; self.links = []; self.in_gallery = False
        self.feed(source)
    def handle_starttag(self, tag, attrs):
        a = dict(attrs)
        if tag == 'a':
            self.links.append(a.get('href', ''))
            self.in_gallery = 'f-gallery-lightbox' in a.get('class', '')
        if tag == 'img' and a.get('src'):
            self.images.append(a)
            if self.in_gallery: self.gallery.append(a['src'])
    def handle_endtag(self, tag):
        if tag == 'a': self.in_gallery = False

def asset(url, brand, page, kind):
    extension = Path(url.split('?')[0]).suffix.lower()
    if extension not in ['.jpg', '.jpeg', '.png', '.webp', '.avif']: return None
    name = 'official-' + brand + '-' + hashlib.sha256(url.encode()).hexdigest()[:12] + extension
    ASSETS[url] = {'file': name, 'url': url, 'source_url': page, 'credit': brand, 'kind': kind,
                   'rights': 'Published by the brand. Copyright retained by its owner; no open license asserted.'}
    return '/media/' + name

def photo(url, brand, page, kind='food'):
    return dict(image_url=asset(url,brand,page,kind), image_credit=brand + ' · official website',
                image_source_url=page, image_is_illustrative=False)

def restaurant(slug, name, city, division, area, address, source, cuisine):
    return dict(catalog_slug='official-'+slug, name=name, cuisine=cuisine,
                description='Official-source directory listing. Not yet a Cravio delivery partner.',
                source_url=source, verified_at=STAMP, is_demo=False, ordering_enabled=False,
                owner_email=None, categories=[], branches=[dict(city=city,division=division,area=area,
                address=address, is_open=False,latitude=None,longitude=None)], gallery=[])

def save(brand, rows):
    catalog = dict(schema_version=1, notice='Official website snapshot, 9 September 2026. Not exhaustive. Menus are published prices, not a Cravio quote. Delivery availability is unverified.',restaurants=rows)
    (DATA / ('official-'+brand+'.json')).write_text(json.dumps(catalog,ensure_ascii=False,indent=2)+'\n')
    print(brand, len(rows), 'branches;',sum(len(c['items']) for r in rows for c in r['categories']), 'menu entries')

# Kacchi Bhai: exact branch-address blocks and photographs from each branch's gallery.
base='https://www.kacchibhai.com'
home=Path('/tmp/cravio-kacchi-home.html').read_text(); hp=Page(home)
logo=next(i['src'] for i in hp.images if i.get('alt')=='Kacchi Bhai Home Logo')
# Four unambiguous single-portion dishes; the site publishes conflicting tehari prices, omitted.
kb_items=[]
for name, fragment, price in [('Basmati Kacchi (1 person)','6827579bc165ae0a8cd98119_basmoti',330),('Borhani (1 person)','67e2e276d01406da1f601c9f_Borhani',80),('Firni (1 person)','67e2e276f0c9973a78928728_Firni',70),('Chicken Roast (1 person)','67e2e32a4ea1908c6e846b60_Chicken',150)]:
    url=next(i['src'] for i in hp.images if fragment in i['src'])
    kb_items.append(dict(name=name,price=price,is_available=False,description='Published single-portion price; may vary by branch.',**photo(url,'Kacchi-Bhai',base+'/')))
locations={
 'board-bazar':('Gazipur','Dhaka'), 'konabari':('Gazipur','Dhaka'),'tongi':('Gazipur','Dhaka'),
 'siddhirganj':('Narayanganj','Dhaka'),'narayanganj':('Narayanganj','Dhaka'),'savar':('Savar','Dhaka'),'hemayetpur':('Savar','Dhaka'),'ashulia':('Ashulia','Dhaka'),
 'barishal':('Barishal','Barishal'),'feni':('Feni','Chattogram'),'pabna':('Pabna','Rajshahi'),'coxs-bazer':("Cox's Bazar",'Chattogram'),
 'chittagong':('Chattogram','Chattogram'),'rajshahi':('Rajshahi','Rajshahi'),'khulna':('Khulna','Khulna'),'bogura':('Bogura','Rajshahi'),
 'rangpur':('Rangpur','Rangpur'),'sylhet':('Sylhet','Sylhet'),'jessore':('Jashore','Khulna'),'faridpur':('Faridpur','Dhaka'),
 'mymensingh':('Mymensingh','Mymensingh'),'tangail':('Tangail','Dhaka'),'kushtia':('Kushtia','Khulna'),'dinajpur':('Dinajpur','Rangpur'),
 'narsingdi':('Narsingdi','Dhaka'),'brahmanbaria':('Brahmanbaria','Chattogram'),'kishoreganj':('Kishoreganj','Dhaka')}
rows=[]
for link in dict.fromkeys(p for p in hp.links if p.startswith('/branch/')):
    slug=link.split('/')[-1]; source=base+link; content=Path('/tmp/cravio-kb-'+slug+'.html').read_text(); page=Page(content)
    match=re.search(r'<p[^>]*class="paragraph-6"[^>]*>(.*?)</p>',content,re.S)
    if not match or not clean(match.group(1)): raise ValueError('Missing address: '+slug)
    city,division=locations.get(slug,('Dhaka','Dhaka'));area=slug.replace('-',' ').title()
    r=restaurant('kacchi-bhai-'+slug,'Kacchi Bhai — '+area,city,division,area,clean(match.group(1)),source,'Kacchi Biryani')
    r.update(logo_url=asset(logo,'Kacchi-Bhai',base+'/','logo'),logo_source_url=base+'/',menu_source_url=base+'/',menu_scope='brand')
    r['categories']=[dict(name='Published brand menu',items=copy.deepcopy(kb_items))]
    for url in list(dict.fromkeys(page.gallery))[:5]:
        r['gallery'].append(dict(caption='Published on the official '+area+' branch page',**photo(url,'Kacchi-Bhai',source,'branch')))
    if r['gallery']:r.update({k:v for k,v in r['gallery'][0].items() if k!='caption'})
    else:r.update(photo(logo,'Kacchi-Bhai',base+'/','logo'))
    phone=next((v[4:] for v in page.links if v.startswith('tel:')),None)
    if phone and len(phone)<=20:r['branches'][0]['phone']=phone
    rows.append(r)
save('kacchi-bhai',rows)

# Engaze is the published online menu linked by the brands. Keep per-branch menus.
for index,brand,brandname in [(1,'bfc','BFC'),(2,'chillox','Chillox')]:
    home=json.loads(Path('/tmp/cravio-engaze-'+str(index)+'.json').read_text())['storeHomeData']; rows=[]
    for b in home['deliveryBranches']:
        source=f"https://{brand}.engaze.ai/{home['_id']}/{b['_id']}/delivery"
        content=Path(f"/tmp/cravio-{brand}-{b['_id']}.html").read_text()
        data=json.loads(re.search(r'<script id="__NEXT_DATA__" type="application/json">(.*?)</script>',content,re.S).group(1))['props']['pageProps']['storeBranchServiceData']
        name=b['name']; city='Dhaka';division='Dhaka'
        for term,c,d in [('Chittagong','Chattogram','Chattogram'),('Mymensingh','Mymensingh','Mymensingh'),('Narayanganj','Narayanganj','Dhaka'),('Khulna','Khulna','Khulna'),('Rajshahi','Rajshahi','Rajshahi'),('Bogura','Bogura','Rajshahi'),('Sylhet','Sylhet','Sylhet')]:
            if term.lower() in name.lower(): city=c;division=d
        slug=re.sub('[^a-z0-9]+','-',name.lower()).strip('-')
        r=restaurant(brand+'-'+slug,brandname+' — '+name,city,division,b.get('area') or name,
                      name+', '+city+' (area-level listing; street address not supplied by this source)',source,'Fried Chicken Burgers' if brand=='bfc' else 'Burgers Chicken')
        lng,lat=b['location']['coordinates'];r['branches'][0].update(latitude=lat,longitude=lng)
        r.update(logo_url=asset(home['logoPreview'],brand,source,'logo'),logo_source_url=source,menu_source_url=source,menu_scope='branch')
        used=set()
        for category in data['productsByCategory']:
            items=[]
            for p in category['products']:
                variations=[v for v in p.get('variations',[]) if isinstance(v.get('price'),(int,float)) and 0<v['price']<=100000]
                if not variations:continue
                variation=min(variations,key=lambda v:v['price']);name=p['name'].strip()
                if name in used or len(name)>100:continue
                used.add(name)
                chosen=', '.join(v['optionName'] for v in variation.get('variants',[]) if v.get('optionName'))
                item=dict(name=name,price=variation['price'],is_available=False,description='Published price'+(' for '+chosen if chosen else '')+'. Check the official menu for options and current availability.')
                url=p.get('previewImage') or p.get('thumbnailImage')
                if url:item.update(photo(url,brand,source))
                items.append(item)
            if items:r['categories'].append(dict(name=category['category']['name'][:50],items=items))
        cover=next((i for c in r['categories'] for i in c['items'] if i.get('image_url')),None)
        r.update({k:v for k,v in cover.items() if k.startswith('image_')} if cover else photo(home['logoPreview'],brand,source,'logo'))
        rows.append(r)
    save(brand,rows)

# KFC national menu (not a branch-specific quote); product image alt names and displayed prices.
menu=[]; used=set()
for path in sorted(Path('/tmp').glob('cravio-kfc-menu-*.html')):
    content=path.read_text(); source='https://kfcbd.com/menu/'+path.stem.replace('cravio-kfc-menu-','');items=[]
    matches=list(re.finditer(r'<img[^>]+src="https://kfcbd.com/storage/products/[^\"]+"[^>]*>',content))
    for match in matches:
        img=Page(match.group()).images[0];name=img.get('title') or img.get('alt'); tail=content[match.end():]
        price=re.search('৳\\s*([0-9,]+(?:\\.[0-9]+)?)',clean(tail[:7000]))
        if not name or name in used or not price:continue
        used.add(name);items.append(dict(name=name,price=float(price.group(1).replace(',','')),is_available=False,description='Published national menu price; branch availability, options and taxes must be checked with KFC.',**photo(img['src'],'KFC',source)))
    if items:menu.append(dict(name=path.stem.replace('cravio-kfc-menu-','').replace('-',' ').title(),items=items))
rows=[]
for b in json.loads(Path('/tmp/cravio-kfc-stores.json').read_text()):
    if b['status']!=1:continue
    address=b['address'];city='Dhaka';division='Dhaka'
    for term,c,d in [('Chittagong','Chattogram','Chattogram'),('Chattogram','Chattogram','Chattogram'),('Coxbazar',"Cox's Bazar",'Chattogram'),('Cumilla','Cumilla','Chattogram'),('Bogura','Bogura','Rajshahi'),('Rajshahi','Rajshahi','Rajshahi'),('Khulna','Khulna','Khulna'),('Barishal','Barishal','Barishal'),('Mymensingh','Mymensingh','Mymensingh'),('Narayanganj','Narayanganj','Dhaka'),('Gazipur','Gazipur','Dhaka'),('Savar','Savar','Dhaka')]:
        if term.lower() in address.lower():city=c;division=d;break
    source='https://kfcbd.com/store-locator';r=restaurant(b['slug'],b['name'],city,division,b['name'].replace('KFC ',''),address,source,'Fried Chicken Burgers')
    r['branches'][0].update(latitude=float(b['lat']),longitude=float(b['lng']),phone=next((v.strip() for v in (b['store_phone'] or '').split(',') if v.strip().startswith('096')), None))
    r.update(logo_url=asset('https://kfcbd.com/frontend/Content/images/logo-black.png','KFC',source,'logo'),logo_source_url=source,menu_source_url='https://kfcbd.com/menu/chicken',menu_scope='brand',categories=copy.deepcopy(menu))
    cover=next((i for c in menu if c['name']=='Burgers' for i in c['items'] if i.get('image_url')),None)
    if cover:r.update({k:v for k,v in cover.items() if k.startswith('image_')})
    rows.append(r)
save('kfc',rows)
(DATA/'official-photo-sources.json').write_text(json.dumps(list(ASSETS.values()),indent=2)+'\n')
print(len(ASSETS),'distinct official assets referenced. Download these exact URLs using the manifest.')
