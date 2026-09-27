import os
import unittest
from unittest.mock import patch

from fastapi.testclient import TestClient
from backend.main import app
from backend.pairing import relay_message, sessions


class PairingTests(unittest.TestCase):
    def setUp(self):
        sessions.clear()
        self.client = TestClient(app)

    def pair(self):
        response = self.client.post('/api/pairing', json={'public_url': 'https://phone.example'})
        self.assertEqual(response.status_code, 200)
        return response.json()

    def test_https_qr_points_to_phone_not_dashboard(self):
        result = self.pair()
        self.assertTrue(result['secure'])
        self.assertEqual(len(result['session_id']), 32)
        self.assertEqual(result['mobile_url'], f"https://phone.example/mobile.html?session={result['session_id']}")
        self.assertTrue(result['qr_data_url'].startswith('data:image/png;base64,'))

    def test_two_qrs_share_session_and_differ(self):
        result = self.pair()
        self.assertEqual(result['handsfree_url'], f"https://phone.example/handsfree.html?session={result['session_id']}")
        self.assertTrue(result['handsfree_qr_data_url'].startswith('data:image/png;base64,'))
        self.assertNotEqual(result['qr_data_url'], result['handsfree_qr_data_url'])
        self.assertIn('handsfree-qr', self.client.get('/').text)
        self.assertIn('handsfree-worklet', self.client.get('/handsfree.js').text)
        self.assertIn('before checking the wake phrase', self.client.get('/handsfree.html').text)

    def test_replacing_phone_notifies_disconnect_before_reconnect(self):
        session = self.pair()['session_id']
        with self.client.websocket_connect(f'/ws/pair/{session}?role=pc') as pc:
            pc.receive_json()
            with self.client.websocket_connect(f'/ws/pair/{session}?role=mobile') as old:
                old.receive_json()
                pc.receive_json()
                with self.client.websocket_connect(f'/ws/pair/{session}?role=mobile') as new:
                    self.assertFalse(pc.receive_json()['connected'])
                    self.assertTrue(pc.receive_json()['connected'])
                    self.assertTrue(new.receive_json()['connected'])
                    new.send_json({'type': 'transcript', 'text': 'pause'})
                    self.assertEqual(pc.receive_json()['text'], 'pause')

    def test_audio_diagnostics_are_bounded_and_do_not_relay_background_text(self):
        result = relay_message('mobile', {'type':'phone_status', 'wake':'ignored', 'audio_settings':'x'*500, 'raw_transcript':'private conversation'})
        self.assertEqual(result['wake'], 'ignored')
        self.assertEqual(len(result['audio_settings']), 300)
        self.assertNotIn('raw_transcript', result)

    def test_tunnel_origin_from_environment(self):
        with patch.dict(os.environ, {'PAIR_BASE_URL': 'https://configured.example'}):
            result = self.client.post('/api/pairing').json()
        self.assertTrue(result['mobile_url'].startswith('https://configured.example/mobile.html'))

    def test_bad_public_url_is_rejected(self):
        for value in ['http://phone.example', 'https://user:password@phone.example', 'https://phone.example/path']:
            with self.subTest(value=value):
                self.assertEqual(self.client.post('/api/pairing', json={'public_url': value}).status_code, 422)

    def test_frame_transcript_and_guidance_relay_both_directions(self):
        session = self.pair()['session_id']
        with self.client.websocket_connect(f'/ws/pair/{session}?role=pc') as pc:
            self.assertFalse(pc.receive_json()['connected'])
            with self.client.websocket_connect(f'/ws/pair/{session}?role=mobile') as mobile:
                self.assertTrue(mobile.receive_json()['connected'])
                self.assertTrue(pc.receive_json()['connected'])
                frame = {'type': 'frame', 'image_base64': 'data:image/jpeg;base64,dGVzdA=='}
                mobile.send_json(frame)
                self.assertEqual(pc.receive_json(), frame)
                mobile.send_json({'type': 'transcript', 'text': 'Find the exit'})
                self.assertEqual(pc.receive_json(), {'type': 'transcript', 'text': 'Find the exit'})
                cue = {'type': 'guidance', 'text': 'Turn right, then stop.'}
                pc.send_json(cue)
                self.assertEqual(mobile.receive_json(), cue)
                mobile.send_json({'type': 'control', 'action': 'pause'})
                self.assertEqual(pc.receive_json()['action'], 'pause')
                pc.send_json({'type': 'session_state', 'running': False, 'target': 'exit'})
                self.assertFalse(mobile.receive_json()['running'])
            self.assertFalse(pc.receive_json()['connected'])

    def test_dashboard_disconnect_notifies_phone(self):
        session = self.pair()['session_id']
        with self.client.websocket_connect(f'/ws/pair/{session}?role=mobile') as mobile:
            self.assertFalse(mobile.receive_json()['connected'])
            with self.client.websocket_connect(f'/ws/pair/{session}?role=pc') as pc:
                self.assertTrue(pc.receive_json()['connected'])
                self.assertTrue(mobile.receive_json()['connected'])
            self.assertFalse(mobile.receive_json()['connected'])

    def test_protocol_bounds_and_direction_are_enforced(self):
        self.assertIsNone(relay_message('mobile', {'type': 'guidance', 'text': 'Move'}))
        self.assertIsNone(relay_message('pc', {'type': 'transcript', 'text': 'Find exit'}))
        self.assertIsNone(relay_message('mobile', {'type': 'transcript', 'text': 'x' * 501}))
        self.assertIsNone(relay_message('mobile', {'type': 'frame', 'image_base64': 'not an image'}))
        self.assertIsNone(relay_message('pc', {'type': 'session_state', 'running': 'yes'}))
        self.assertIsNone(relay_message('mobile', ['not', 'an', 'object']))

    def test_phone_has_only_permissions_and_speech_controls(self):
        page = self.client.get('/mobile.html').text
        for required in ['allow-permissions', 'record-command', 'spoken-output', 'repeat-guidance']:
            self.assertIn(required, page)
        for dashboard_only in ['pairing-qr', 'event-log', 'raw-result', 'traversability-overlay']:
            self.assertNotIn(dashboard_only, page)
        self.assertIn('capture-video', page)

    def test_dashboard_contains_diagnostics_and_pairing(self):
        page = self.client.get('/').text
        for required in ['pairing-qr', 'event-log', 'raw-result', 'speech-input', 'gemini-ms', 'camera-permission']:
            self.assertIn(required, page)


if __name__ == '__main__':
    unittest.main()
