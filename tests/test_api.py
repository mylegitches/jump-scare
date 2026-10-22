import os
import tempfile
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
        scenes = self.client.get('/api/scenes').json()
        self.assertEqual(len(scenes), 20)
        self.assertEqual(len({scene['ghoul'] for scene in scenes}), 20)
        self.assertEqual(len({scene['sound'] for scene in scenes}), 20)
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
        self.assertEqual(self.client.get('/api/admin/settings').status_code, 401)
        response = self.client.put('/api/admin/settings', headers=self.auth, json={'reaction_seconds': 4.5, 'booth_name': '  Haunted Portraits  '})
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()['reaction_seconds'], 4.5)
        self.assertEqual(response.json()['booth_name'], 'Haunted Portraits')
        self.assertEqual(self.client.get('/api/config').json()['booth_name'], 'Haunted Portraits')
        self.assertEqual(self.client.put('/api/admin/settings', headers=self.auth, json={'reaction_seconds': 31, 'booth_name': 'Test'}).status_code, 422)
        self.assertEqual(self.client.put('/api/admin/settings', headers=self.auth, json={'reaction_seconds': 1.5, 'booth_name': '   '}).status_code, 422)
        self.assertEqual(self.client.put('/api/admin/settings', headers=self.auth, json={'reaction_seconds': 1.5, 'booth_name': 'Midnight Portrait Booth'}).status_code, 200)
