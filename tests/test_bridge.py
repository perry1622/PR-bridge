import importlib.util
import json
import shutil
import subprocess
import tempfile
import threading
import unittest
import urllib.error
import urllib.request
from pathlib import Path


SOURCE = Path(__file__).resolve().parents[1]


class BridgeProtocolTest(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        (self.root / 'scripts').mkdir()
        (self.root / 'plugin').mkdir()
        for relative in (
            'scripts/setup.py', 'scripts/server.py', 'scripts/client.py',
            'plugin/ui.template.html',
        ):
            shutil.copy2(SOURCE / relative, self.root / relative)

        first = subprocess.run(
            ['python', str(self.root / 'scripts' / 'setup.py')],
            check=True, capture_output=True, text=True,
        )
        self.token = json.loads(
            (self.root / 'scripts' / 'runtime.json').read_text(encoding='utf-8')
        )['token']
        self.assertNotIn(self.token, first.stdout)
        subprocess.run(
            ['python', str(self.root / 'scripts' / 'setup.py')],
            check=True, capture_output=True, text=True,
        )
        self.assertEqual(
            self.token,
            json.loads((self.root / 'scripts' / 'runtime.json').read_text(encoding='utf-8'))['token'],
        )
        self.assertIn(self.token, (self.root / 'plugin' / 'ui.html').read_text(encoding='utf-8'))

        spec = importlib.util.spec_from_file_location(
            'isolated_bridge_server', self.root / 'scripts' / 'server.py'
        )
        self.module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(self.module)
        self.server = self.module.ThreadingHTTPServer(('127.0.0.1', 0), self.module.Handler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.base = f'http://127.0.0.1:{self.server.server_address[1]}'

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=2)
        self.temporary.cleanup()

    def request(self, path, data=None, token=True, method=None):
        headers = {'Content-Type': 'application/json'}
        if token:
            headers['X-Bridge-Token'] = self.token
        request = urllib.request.Request(
            self.base + path,
            data=None if data is None else json.dumps(data).encode(),
            headers=headers,
            method=method,
        )
        try:
            with urllib.request.urlopen(request, timeout=25 if path == '/poll' else 3) as response:
                body = response.read()
                return response.status, json.loads(body) if body else None, response.headers
        except urllib.error.HTTPError as error:
            return error.code, json.load(error), error.headers

    def test_requires_token_and_allows_plugin_preflight(self):
        self.assertEqual(403, self.request('/health', token=False)[0])
        self.assertEqual(200, self.request('/health')[0])
        status, _, headers = self.request('/health', method='OPTIONS', token=False)
        self.assertEqual(204, status)
        self.assertIn('X-Bridge-Token', headers['Access-Control-Allow-Headers'])

    def test_queue_is_scoped_and_result_is_idempotent(self):
        task = {
            'taskId': 'isolated-inspect', 'kind': 'inspect',
            'fileName': 'Test File', 'pageId': '1:1', 'frameIds': ['1:2'],
        }
        self.assertEqual(403, self.request('/jobs', task, token=False)[0])
        status, job, _ = self.request('/jobs', task)
        self.assertEqual((202, 'queued'), (status, job['state']))
        self.assertEqual(job['id'], self.request('/jobs', task)[1]['id'])
        _, wrong_page, _ = self.request(
            '/poll', {'clientId': 'wrong', 'fileName': 'Test File', 'pageId': '2:1'}
        )
        self.assertIsNone(wrong_page['jobId'])
        _, assigned, _ = self.request(
            '/poll', {'clientId': 'test', 'fileName': 'Test File', 'pageId': '1:1'}
        )
        self.assertEqual(job['id'], assigned['jobId'])
        self.assertEqual(200, self.request('/result', {
            'clientId': 'test', 'jobId': job['id'], 'ok': True,
            'result': {'frames': []},
        })[0])
        self.assertEqual('completed', self.request('/jobs/' + job['id'])[1]['state'])


if __name__ == '__main__':
    unittest.main()
