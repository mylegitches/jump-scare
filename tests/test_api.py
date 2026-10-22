import os
import tempfile
from io import BytesIO
from PIL import Image
import unittest
os.environ['JUMPSCARE_DATA_DIR'] = tempfile.mkdtemp()
os.environ['JUMPSCARE_ADMIN_PIN'] = 'test-pin'
from fastapi.testclient import TestClient
from app.main import app

class BoothTests(unittest.TestCase):
    def setUp(self):
        self.client = TestClient(app)
        self.auth = {'X-Admin-Pin': 'test-pin'}

    def test_capture_admin_and_archive(self):
        self.assertEqual(self.client.get('/').status_code, 200)
        self.assertEqual(self.client.get('/api/health').json(), {'status': 'ok'})
        scenes = self.client.get('/api/scenes').json()
        self.assertEqual(len(scenes), 20)
        self.assertEqual(len({scene['ghoul'] for scene in scenes}), 20)
        self.assertEqual(len({scene['sound'] for scene in scenes}), 20)
        for scene in scenes:
            creature = self.client.get(scene['creature_src'])
            self.assertEqual(creature.status_code, 200)
            self.assertEqual(creature.content[:4], b'RIFF')
        self.assertEqual(self.client.get('/api/admin/captures').status_code, 401)
        r = self.client.post('/api/captures?scene=forest', content=b'video fixture')
        self.assertEqual(r.status_code, 200)
        capture_id = r.json()['id']
        self.assertEqual(self.client.put(f'/api/captures/{capture_id}/photo',content=b'bad').status_code,400)
        self.assertEqual(self.client.put(f'/api/captures/{capture_id}/photo',content=b'\xff\xd8\xfftest').status_code,200)
        self.assertEqual(self.client.get(f'/api/admin/media/{capture_id}/jpg').status_code,401)
        self.assertEqual(self.client.get(f'/api/admin/media/{capture_id}/jpg',headers=self.auth).content,b'\xff\xd8\xfftest')
        items=self.client.get('/api/admin/captures',headers=self.auth).json()
        self.assertTrue(any(x['id']==capture_id and x['photo'] for x in items))
        self.assertEqual(self.client.post(f'/api/admin/captures/{capture_id}/archive',headers=self.auth).status_code,200)
        self.assertFalse(any(x['id']==capture_id for x in self.client.get('/api/admin/captures',headers=self.auth).json()))
        self.assertEqual(self.client.get(f'/api/admin/media/{capture_id}/webm',headers=self.auth).status_code,200)

    def test_invalid_capture(self):
        self.assertEqual(self.client.post('/api/captures?scene=unknown',content=b'x').status_code,400)
        self.assertEqual(self.client.post('/api/captures?scene=forest',content=b'').status_code,400)
        self.assertEqual(self.client.post('/api/captures?scene=forest&kind=exe',content=b'x').status_code,400)

    def test_booth_settings(self):
        config = self.client.get('/api/config').json()
        self.assertEqual(config['reaction_seconds'], 1.5)
        self.assertEqual(config['booth_name'], 'Midnight Portrait Booth')
        self.assertTrue(config['show_header_controls'])
        self.assertEqual(self.client.get('/api/admin/settings').status_code, 401)
        response = self.client.put('/api/admin/settings', headers=self.auth, json={'reaction_seconds': 4.5, 'booth_name': '  Haunted Portraits  ', 'show_header_controls': False})
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()['reaction_seconds'], 4.5)
        self.assertEqual(response.json()['booth_name'], 'Haunted Portraits')
        self.assertFalse(response.json()['show_header_controls'])
        self.assertEqual(self.client.get('/api/config').json()['booth_name'], 'Haunted Portraits')
        self.assertEqual(self.client.put('/api/admin/settings', headers=self.auth, json={'reaction_seconds': 31, 'booth_name': 'Test', 'show_header_controls': True}).status_code, 422)
        self.assertEqual(self.client.put('/api/admin/settings', headers=self.auth, json={'reaction_seconds': 1.5, 'booth_name': '   ', 'show_header_controls': True}).status_code, 422)
        self.assertEqual(self.client.put('/api/admin/settings', headers=self.auth, json={'reaction_seconds': 1.5, 'booth_name': 'Midnight Portrait Booth', 'show_header_controls': True}).status_code, 200)

    def test_custom_creature_library_and_scene_assignment(self):
        self.assertEqual(self.client.get('/api/admin/creatures').status_code, 401)
        catalog = self.client.get('/api/admin/creatures', headers=self.auth).json()
        self.assertEqual(len(catalog['builtins']), 20)
        image_buffer = BytesIO()
        Image.new('RGBA', (64, 64), (80, 10, 10, 180)).save(image_buffer, 'PNG')
        png = image_buffer.getvalue()
        uploaded = self.client.post(
            '/api/admin/creatures?name=Lobby%20Lurker',
            headers=self.auth | {'Content-Type': 'image/png'},
            content=png,
        )
        self.assertEqual(uploaded.status_code, 200)
        creature = uploaded.json()
        self.assertTrue(creature['id'].startswith('custom:'))
        custom_id = creature['id'].removeprefix('custom:')
        image = self.client.get(f'/api/creatures/{custom_id}')
        self.assertEqual(image.status_code, 200)
        self.assertEqual(image.content, png)
        assigned = self.client.put(
            '/api/admin/scenes/forest/creature',
            headers=self.auth,
            json={'creature_id': creature['id']},
        )
        self.assertEqual(assigned.status_code, 200)
        forest = next(scene for scene in self.client.get('/api/scenes').json() if scene['id'] == 'forest')
        self.assertEqual(forest['creature_id'], creature['id'])
        self.assertEqual(forest['creature_src'], f'/api/creatures/{custom_id}')
        builtin = self.client.put(
            '/api/admin/scenes/forest/creature',
            headers=self.auth,
            json={'creature_id': 'builtin:grinning-clown'},
        )
        self.assertEqual(builtin.status_code, 200)
        forest = next(scene for scene in self.client.get('/api/scenes').json() if scene['id'] == 'forest')
        self.assertEqual(forest['creature_id'], 'builtin:grinning-clown')
        self.client.put('/api/admin/scenes/forest/creature', headers=self.auth, json={'creature_id': creature['id']})
        deleted = self.client.delete(f'/api/admin/creatures/{custom_id}', headers=self.auth)
        self.assertEqual(deleted.status_code, 200)
        forest = next(scene for scene in self.client.get('/api/scenes').json() if scene['id'] == 'forest')
        self.assertEqual(forest['creature_id'], 'builtin:antler-witch')
        self.assertEqual(self.client.get(f'/api/creatures/{custom_id}').status_code, 404)
        self.assertEqual(
            self.client.post('/api/admin/creatures?name=Bad', headers=self.auth, content=b'not an image').status_code,
            400,
        )
