from pathlib import Path
from datetime import datetime, timezone
import json
import os
import secrets
import sqlite3
import uuid
from fastapi import FastAPI, Request, HTTPException, Depends
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

ROOT = Path(__file__).parent
DATA = Path(os.environ.get('JUMPSCARE_DATA_DIR', str(ROOT.parent / 'data')))
DATA.mkdir(parents=True, exist_ok=True)
PIN = os.environ.get('JUMPSCARE_ADMIN_PIN') or secrets.token_urlsafe(12)
if not os.environ.get('JUMPSCARE_ADMIN_PIN'):
    print(f'JumpScare temporary admin PIN: {PIN}', flush=True)
DB = DATA / 'recordings.sqlite3'
with sqlite3.connect(DB) as db:
    db.execute('CREATE TABLE IF NOT EXISTS captures (id TEXT PRIMARY KEY, scene TEXT, created TEXT, video_type TEXT, archived INTEGER DEFAULT 0)')
    db.execute('CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)')
    db.execute("INSERT OR IGNORE INTO settings(key,value) VALUES('reaction_seconds','1.5')")
app = FastAPI(title='JumpScare')
app.mount('/static', StaticFiles(directory=ROOT / 'static'), name='static')
SCENES = [
    {'id':'cemetery','name':'The Forgotten Graveyard','tag':'Something is still awake.','kind':'cemetery','number':'01'},
    {'id':'forest','name':'Whispering Woods','tag':'You are not alone out here.','kind':'forest','number':'02'},
    {'id':'manor','name':'Blackwood Manor','tag':'Make yourself at home. Forever.','kind':'manor','number':'03'},
    {'id':'crypt','name':'The Underground','tag':'Some doors should stay closed.','kind':'crypt','number':'04'},
]

class BoothSettings(BaseModel):
    reaction_seconds: float = Field(ge=0, le=30)

def get_reaction_seconds():
    with sqlite3.connect(DB) as db:
        return float(db.execute("SELECT value FROM settings WHERE key='reaction_seconds'").fetchone()[0])

def admin(request: Request):
    if not secrets.compare_digest(request.headers.get('X-Admin-Pin', ''), PIN):
        raise HTTPException(401, 'Enter a valid admin PIN.')

@app.get('/')
@app.get('/admin')
def index():
    return FileResponse(ROOT / 'static/index.html')

@app.get('/api/scenes')
def scenes():
    return SCENES

@app.get('/api/config')
def config():
    return {'reaction_seconds': get_reaction_seconds()}

@app.get('/api/admin/settings', dependencies=[Depends(admin)])
def settings():
    return {'reaction_seconds': get_reaction_seconds()}

@app.put('/api/admin/settings', dependencies=[Depends(admin)])
def update_settings(settings: BoothSettings):
    with sqlite3.connect(DB) as db:
        db.execute("UPDATE settings SET value=? WHERE key='reaction_seconds'", (str(settings.reaction_seconds),))
    return {'reaction_seconds': settings.reaction_seconds}

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
        with sqlite3.connect(DB) as db:
            db.execute('INSERT INTO captures(id,scene,created,video_type) VALUES(?,?,?,?)',
                       (capture_id, scene, datetime.now(timezone.utc).isoformat(), kind))
    except BaseException:
        target.unlink(missing_ok=True)
        raise
    return {'id': capture_id}

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
