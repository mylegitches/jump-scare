from pathlib import Path
from datetime import datetime, timezone
from io import BytesIO
import json
import os
import secrets
import sqlite3
import uuid
from fastapi import FastAPI, Request, HTTPException, Depends
from fastapi.responses import FileResponse, Response
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field, field_validator
from PIL import Image, UnidentifiedImageError
import qrcode

ROOT = Path(__file__).parent
DATA = Path(os.environ.get('JUMPSCARE_DATA_DIR', str(ROOT.parent / 'data')))
DATA.mkdir(parents=True, exist_ok=True)
PIN = os.environ.get('JUMPSCARE_ADMIN_PIN') or secrets.token_urlsafe(12)
if not os.environ.get('JUMPSCARE_ADMIN_PIN'):
    print(f'JumpScare temporary admin PIN: {PIN}', flush=True)
DB = DATA / 'recordings.sqlite3'
CUSTOM_CREATURES = DATA / 'creatures'
CUSTOM_CREATURES.mkdir(parents=True, exist_ok=True)
with sqlite3.connect(DB) as db:
    db.execute('CREATE TABLE IF NOT EXISTS captures (id TEXT PRIMARY KEY, scene TEXT, created TEXT, video_type TEXT, archived INTEGER DEFAULT 0)')
    db.execute('CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)')
    db.execute("INSERT OR IGNORE INTO settings(key,value) VALUES('reaction_seconds','1.5')")
    db.execute("INSERT OR IGNORE INTO settings(key,value) VALUES('booth_name','Midnight Portrait Booth')")
    db.execute("INSERT OR IGNORE INTO settings(key,value) VALUES('show_header_controls','1')")
    db.execute('CREATE TABLE IF NOT EXISTS custom_creatures (id TEXT PRIMARY KEY, name TEXT NOT NULL, filename TEXT NOT NULL, content_type TEXT NOT NULL, created TEXT NOT NULL)')
    db.execute('CREATE TABLE IF NOT EXISTS scene_creatures (scene TEXT PRIMARY KEY, creature_id TEXT NOT NULL)')
    db.execute('CREATE TABLE IF NOT EXISTS capture_shares (capture_id TEXT PRIMARY KEY, token TEXT UNIQUE NOT NULL, created TEXT NOT NULL)')
app = FastAPI(title='JumpScare')
app.mount('/static', StaticFiles(directory=ROOT / 'static'), name='static')
SCENES = [
    {'id':'cemetery','name':'The Forgotten Graveyard','tag':'Something is still awake.','image':'forgotten-graveyard.webp','ghoul':'grave-warden','sound':'grave','number':'01'},
    {'id':'forest','name':'Whispering Woods','tag':'You are not alone out here.','image':'whispering-woods.webp','ghoul':'antler-witch','sound':'forest','number':'02'},
    {'id':'manor','name':'Blackwood Manor','tag':'Make yourself at home. Forever.','image':'blackwood-manor.webp','ghoul':'veiled-widow','sound':'manor','number':'03'},
    {'id':'crypt','name':'The Underground','tag':'Some doors should stay closed.','image':'underground-crypt.webp','ghoul':'bone-priest','sound':'crypt','number':'04'},
    {'id':'asylum','name':'Saint Mercy Ward','tag':'Visiting hours never end.','image':'abandoned-asylum.webp','ghoul':'patient-zero','sound':'asylum','number':'05'},
    {'id':'catacombs','name':'The Sunken Catacombs','tag':'The water remembers every name.','image':'flooded-catacombs.webp','ghoul':'drowned-monk','sound':'catacombs','number':'06'},
    {'id':'harvest','name':'Harvest Moon','tag':'The field has been waiting.','image':'harvest-field.webp','ghoul':'scarecrow','sound':'harvest','number':'07'},
    {'id':'chapel','name':'The Frozen Chapel','tag':'No prayer leaves this room.','image':'frozen-chapel.webp','ghoul':'frost-nun','sound':'chapel','number':'08'},
    {'id':'butcher','name':"The Butcher's Cellar",'tag':'The hooks are still warm.','image':'butcher-cellar.webp','ghoul':'hook-butcher','sound':'butcher','number':'09'},
    {'id':'nursery','name':'The Nursery','tag':'The rocking stopped by itself.','image':'cursed-nursery.webp','ghoul':'porcelain-child','sound':'nursery','number':'10'},
    {'id':'carnival','name':'Midnight Carnival','tag':'One final show before closing.','image':'deserted-carnival.webp','ghoul':'grinning-clown','sound':'carnival','number':'11'},
    {'id':'mine','name':'Black Vein Mine','tag':'Something followed the last crew.','image':'mine-shaft.webp','ghoul':'cave-crawler','sound':'mine','number':'12'},
    {'id':'village','name':'The Plague Village','tag':'The bell rings for new arrivals.','image':'plague-village.webp','ghoul':'plague-doctor','sound':'village','number':'13'},
    {'id':'swamp','name':'The Drowned Shrine','tag':'The water is not empty.','image':'swamp-shrine.webp','ghoul':'bog-hag','sound':'swamp','number':'14'},
    {'id':'shipwreck','name':'The Last Voyage','tag':'All hands are still aboard.','image':'shipwreck-hold.webp','ghoul':'dead-captain','sound':'shipwreck','number':'15'},
    {'id':'castle','name':'The Fallen Keep','tag':'The guard never abandoned his post.','image':'ruined-castle.webp','ghoul':'armored-revenant','sound':'castle','number':'16'},
    {'id':'school','name':'After-School','tag':'Class is back in session.','image':'haunted-school.webp','ghoul':'faceless-teacher','sound':'school','number':'17'},
    {'id':'theater','name':'Final Curtain','tag':'The understudy wants your part.','image':'possessed-theater.webp','ghoul':'mask-phantom','sound':'theater','number':'18'},
    {'id':'sewer','name':'Below the City','tag':'Do not disturb the nest.','image':'sewer-tunnel.webp','ghoul':'rat-king','sound':'sewer','number':'19'},
    {'id':'motel','name':'Room 13','tag':'Checkout was a long time ago.','image':'motel-hallway.webp','ghoul':'room-guest','sound':'motel','number':'20'},
]

class BoothSettings(BaseModel):
    reaction_seconds: float = Field(ge=0, le=30)
    booth_name: str = Field(min_length=1, max_length=40)
    show_header_controls: bool

    @field_validator('booth_name')
    @classmethod
    def clean_booth_name(cls, value: str):
        value = value.strip()
        if not value:
            raise ValueError('Booth name cannot be blank.')
        return value

class CreatureAssignment(BaseModel):
    creature_id: str = Field(min_length=1, max_length=80)

def get_settings():
    with sqlite3.connect(DB) as db:
        values = dict(db.execute("SELECT key,value FROM settings WHERE key IN ('reaction_seconds','booth_name','show_header_controls')"))
    return {
        'reaction_seconds': float(values['reaction_seconds']),
        'booth_name': values['booth_name'],
        'show_header_controls': values['show_header_controls'] == '1',
    }

def admin(request: Request):
    if not secrets.compare_digest(request.headers.get('X-Admin-Pin', ''), PIN):
        raise HTTPException(401, 'Enter a valid admin PIN.')

@app.get('/')
@app.get('/admin')
def index():
    return FileResponse(ROOT / 'static/index.html')

@app.get('/share/{token}', name='share_page')
def share_page(token: str):
    return FileResponse(ROOT / 'static/share.html')

def creature_name(creature_id: str):
    return ' '.join(word.capitalize() for word in creature_id.split('-'))

def creature_catalog():
    builtins = [
        {
            'id': f"builtin:{scene['ghoul']}",
            'name': creature_name(scene['ghoul']),
            'src': f"/static/creatures/{scene['ghoul']}.webp",
            'builtin': True,
        }
        for scene in SCENES
    ]
    with sqlite3.connect(DB) as db:
        db.row_factory = sqlite3.Row
        custom = [
            {
                'id': f"custom:{row['id']}",
                'name': row['name'],
                'src': f"/api/creatures/{row['id']}",
                'builtin': False,
            }
            for row in db.execute('SELECT id,name FROM custom_creatures ORDER BY created DESC')
        ]
    return builtins, custom

def resolved_scenes():
    with sqlite3.connect(DB) as db:
        assignments = dict(db.execute('SELECT scene,creature_id FROM scene_creatures'))
    builtins, custom = creature_catalog()
    creatures = {item['id']: item for item in builtins + custom}
    output = []
    for base in SCENES:
        default_id = f"builtin:{base['ghoul']}"
        creature_id = assignments.get(base['id'], default_id)
        creature = creatures.get(creature_id, creatures[default_id])
        output.append(base | {
            'ghoul': creature['id'],
            'default_ghoul': base['ghoul'],
            'creature_id': creature['id'],
            'creature_src': creature['src'],
        })
    return output

@app.get('/api/scenes')
def scenes():
    return resolved_scenes()

@app.get('/api/config')
def config():
    return get_settings()

@app.get('/api/health')
def health():
    return {'status': 'ok'}

@app.get('/api/admin/settings', dependencies=[Depends(admin)])
def settings():
    return get_settings()

@app.put('/api/admin/settings', dependencies=[Depends(admin)])
def update_settings(settings: BoothSettings):
    with sqlite3.connect(DB) as db:
        db.execute("UPDATE settings SET value=? WHERE key='reaction_seconds'", (str(settings.reaction_seconds),))
        db.execute("UPDATE settings SET value=? WHERE key='booth_name'", (settings.booth_name,))
        db.execute("UPDATE settings SET value=? WHERE key='show_header_controls'", ('1' if settings.show_header_controls else '0',))
    return settings

@app.get('/api/admin/creatures', dependencies=[Depends(admin)])
def creatures_admin():
    builtins, custom = creature_catalog()
    with sqlite3.connect(DB) as db:
        assignments = dict(db.execute('SELECT scene,creature_id FROM scene_creatures'))
    return {'builtins': builtins, 'custom': custom, 'assignments': assignments}

@app.post('/api/admin/creatures', dependencies=[Depends(admin)])
async def upload_creature(request: Request, name: str):
    name = name.strip()
    if not name or len(name) > 60:
        raise HTTPException(422, 'Use a creature name from 1 to 60 characters.')
    body = bytearray()
    async for chunk in request.stream():
        body.extend(chunk)
        if len(body) > 12 * 1024 * 1024:
            raise HTTPException(413, 'Creature image exceeds 12 MB.')
    signatures = [
        ('png', 'image/png', body.startswith(b'\x89PNG\r\n\x1a\n')),
        ('jpg', 'image/jpeg', body.startswith(b'\xff\xd8\xff')),
        ('webp', 'image/webp', len(body) >= 12 and body[:4] == b'RIFF' and body[8:12] == b'WEBP'),
    ]
    match = next(((ext, content_type) for ext, content_type, valid in signatures if valid), None)
    if not match:
        raise HTTPException(400, 'Upload a PNG, JPEG, or WebP image.')
    try:
        with Image.open(BytesIO(body)) as image:
            width, height = image.size
            image.verify()
        if width < 64 or height < 64 or width > 4096 or height > 4096:
            raise HTTPException(400, 'Creature images must be from 64 to 4096 pixels on each side.')
    except (UnidentifiedImageError, OSError, Image.DecompressionBombError):
        raise HTTPException(400, 'The uploaded creature image is damaged or unreadable.')
    creature_id = uuid.uuid4().hex
    extension, content_type = match
    filename = f'{creature_id}.{extension}'
    target = CUSTOM_CREATURES / filename
    with target.open('xb') as output:
        output.write(body)
    try:
        with sqlite3.connect(DB) as db:
            db.execute(
                'INSERT INTO custom_creatures(id,name,filename,content_type,created) VALUES(?,?,?,?,?)',
                (creature_id, name, filename, content_type, datetime.now(timezone.utc).isoformat()),
            )
    except BaseException:
        target.unlink(missing_ok=True)
        raise
    return {'id': f'custom:{creature_id}', 'name': name, 'src': f'/api/creatures/{creature_id}', 'builtin': False}

@app.delete('/api/admin/creatures/{creature_id}', dependencies=[Depends(admin)])
def delete_creature(creature_id: str):
    if len(creature_id) != 32 or any(c not in '0123456789abcdef' for c in creature_id):
        raise HTTPException(404)
    with sqlite3.connect(DB) as db:
        row = db.execute('SELECT filename FROM custom_creatures WHERE id=?', (creature_id,)).fetchone()
        if not row:
            raise HTTPException(404)
        db.execute('DELETE FROM scene_creatures WHERE creature_id=?', (f'custom:{creature_id}',))
        db.execute('DELETE FROM custom_creatures WHERE id=?', (creature_id,))
    (CUSTOM_CREATURES / row[0]).unlink(missing_ok=True)
    return {'deleted': True}

@app.put('/api/admin/scenes/{scene_id}/creature', dependencies=[Depends(admin)])
def assign_creature(scene_id: str, assignment: CreatureAssignment):
    scene = next((item for item in SCENES if item['id'] == scene_id), None)
    if not scene:
        raise HTTPException(404, 'Unknown scene.')
    creature_id = assignment.creature_id
    with sqlite3.connect(DB) as db:
        if creature_id == 'default':
            db.execute('DELETE FROM scene_creatures WHERE scene=?', (scene_id,))
            selected = f"builtin:{scene['ghoul']}"
        else:
            builtin_ids = {f"builtin:{item['ghoul']}" for item in SCENES}
            custom_exists = creature_id.startswith('custom:') and db.execute(
                'SELECT 1 FROM custom_creatures WHERE id=?', (creature_id.removeprefix('custom:'),)
            ).fetchone()
            if creature_id not in builtin_ids and not custom_exists:
                raise HTTPException(400, 'Unknown creature.')
            db.execute(
                'INSERT INTO scene_creatures(scene,creature_id) VALUES(?,?) ON CONFLICT(scene) DO UPDATE SET creature_id=excluded.creature_id',
                (scene_id, creature_id),
            )
            selected = creature_id
    return {'scene': scene_id, 'creature_id': selected}

@app.get('/api/creatures/{creature_id}')
def custom_creature(creature_id: str):
    if len(creature_id) != 32 or any(c not in '0123456789abcdef' for c in creature_id):
        raise HTTPException(404)
    with sqlite3.connect(DB) as db:
        row = db.execute('SELECT filename,content_type FROM custom_creatures WHERE id=?', (creature_id,)).fetchone()
    if not row:
        raise HTTPException(404)
    path = CUSTOM_CREATURES / row[0]
    if not path.is_file():
        raise HTTPException(404)
    return FileResponse(path, media_type=row[1])

@app.post('/api/captures')
async def capture(request: Request, scene: str, kind: str = 'webm'):
    if scene not in {s['id'] for s in SCENES} or kind not in {'webm','mp4'}:
        raise HTTPException(400, 'Unknown scene or video format.')
    # Streaming avoids loading an unbounded recording into memory.
    capture_id = uuid.uuid4().hex
    target = DATA / f'{capture_id}.{kind}'
    total = 0
    try:
        with target.open('xb') as output:
            async for chunk in request.stream():
                total += len(chunk)
                if total > 64 * 1024 * 1024:
                    raise HTTPException(413, 'Recording exceeds 64 MB.')
                output.write(chunk)
        if total == 0:
            raise HTTPException(400, 'Recording was empty.')
        share_token = secrets.token_urlsafe(24)
        with sqlite3.connect(DB) as db:
            db.execute('INSERT INTO captures(id,scene,created,video_type) VALUES(?,?,?,?)',
                       (capture_id, scene, datetime.now(timezone.utc).isoformat(), kind))
            db.execute(
                'INSERT INTO capture_shares(capture_id,token,created) VALUES(?,?,?)',
                (capture_id, share_token, datetime.now(timezone.utc).isoformat()),
            )
    except BaseException:
        target.unlink(missing_ok=True)
        raise
    return {
        'id': capture_id,
        'share_path': f'/share/{share_token}',
        'share_qr': f'/api/share/{share_token}/qr.png',
    }

@app.put('/api/captures/{capture_id}/photo')
async def photo(capture_id: str, request: Request):
    with sqlite3.connect(DB) as db:
        if not db.execute('SELECT id FROM captures WHERE id=?', (capture_id,)).fetchone():
            raise HTTPException(404)
    body = bytearray()
    async for chunk in request.stream():
        body.extend(chunk)
        if len(body) > 8 * 1024 * 1024:
            raise HTTPException(413)
    if not body.startswith(b'\xff\xd8\xff'):
        raise HTTPException(400, 'Expected JPEG photo.')
    target = DATA / f'{capture_id}.jpg'
    try:
        with target.open('xb') as f:
            f.write(body)
    except FileExistsError:
        raise HTTPException(409, 'Photo already saved.')
    return {'saved': True}

@app.get('/api/admin/captures', dependencies=[Depends(admin)])
def recordings():
    with sqlite3.connect(DB) as db:
        db.row_factory = sqlite3.Row
        return [dict(row) | {'photo': (DATA / f"{row['id']}.jpg").exists()} for row in db.execute('SELECT * FROM captures WHERE archived=0 ORDER BY created DESC')]

def shared_capture(token: str):
    if len(token) < 24 or len(token) > 80:
        raise HTTPException(404)
    with sqlite3.connect(DB) as db:
        db.row_factory = sqlite3.Row
        row = db.execute(
            'SELECT captures.* FROM captures JOIN capture_shares ON capture_shares.capture_id=captures.id WHERE capture_shares.token=?',
            (token,),
        ).fetchone()
    if not row:
        raise HTTPException(404)
    return dict(row)

@app.post('/api/admin/captures/{capture_id}/share', dependencies=[Depends(admin)])
def create_share(capture_id: str):
    with sqlite3.connect(DB) as db:
        if not db.execute('SELECT 1 FROM captures WHERE id=?', (capture_id,)).fetchone():
            raise HTTPException(404)
        row = db.execute('SELECT token FROM capture_shares WHERE capture_id=?', (capture_id,)).fetchone()
        if row:
            token = row[0]
        else:
            token = secrets.token_urlsafe(24)
            db.execute(
                'INSERT INTO capture_shares(capture_id,token,created) VALUES(?,?,?)',
                (capture_id, token, datetime.now(timezone.utc).isoformat()),
            )
    return {'path': f'/share/{token}', 'qr': f'/api/share/{token}/qr.png'}

@app.get('/api/share/{token}')
def share_details(token: str):
    item = shared_capture(token)
    scene = next((scene for scene in SCENES if scene['id'] == item['scene']), None)
    return {
        'scene': scene['name'] if scene else item['scene'],
        'created': item['created'],
        'photo': (DATA / f"{item['id']}.jpg").exists(),
        'video_type': item['video_type'],
        'photo_url': f'/api/share/{token}/media/jpg',
        'video_url': f"/api/share/{token}/media/{item['video_type']}",
        'booth_name': get_settings()['booth_name'],
    }

@app.get('/api/share/{token}/media/{kind}')
def share_media(token: str, kind: str):
    item = shared_capture(token)
    if kind not in {'jpg', 'webm', 'mp4'} or (kind != 'jpg' and kind != item['video_type']):
        raise HTTPException(404)
    path = DATA / f"{item['id']}.{kind}"
    if not path.is_file():
        raise HTTPException(404)
    media_types = {'jpg': 'image/jpeg', 'webm': 'video/webm', 'mp4': 'video/mp4'}
    return FileResponse(path, media_type=media_types[kind])

@app.get('/api/share/{token}/qr.png')
def share_qr(token: str, request: Request):
    shared_capture(token)
    scheme = request.headers.get('x-forwarded-proto', request.url.scheme).split(',')[0].strip()
    host = request.headers.get('x-forwarded-host', request.headers.get('host', request.url.netloc)).split(',')[0].strip()
    url = f'{scheme}://{host}/share/{token}'
    image = qrcode.make(url)
    output = BytesIO()
    image.save(output, format='PNG')
    return Response(output.getvalue(), media_type='image/png', headers={'Cache-Control': 'private, max-age=3600'})

@app.get('/api/admin/media/{capture_id}/{kind}', dependencies=[Depends(admin)])
def media(capture_id: str, kind: str):
    if len(capture_id) != 32 or any(c not in '0123456789abcdef' for c in capture_id) or kind not in {'jpg','webm','mp4'}:
        raise HTTPException(404)
    path = DATA / f'{capture_id}.{kind}'
    if not path.is_file():
        raise HTTPException(404)
    return FileResponse(path, filename=path.name)

@app.post('/api/admin/captures/{capture_id}/archive', dependencies=[Depends(admin)])
def archive(capture_id: str):
    with sqlite3.connect(DB) as db:
        if db.execute('UPDATE captures SET archived=1 WHERE id=? AND archived=0', (capture_id,)).rowcount != 1:
            raise HTTPException(404)
    with (DATA / 'audit.jsonl').open('a') as log:
        log.write(json.dumps({'action':'archive','id':capture_id,'at':datetime.now(timezone.utc).isoformat()}) + '\n')
    return {'archived':True}
