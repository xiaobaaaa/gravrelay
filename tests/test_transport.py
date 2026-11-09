import asyncio
import importlib.util
from pathlib import Path
import ssl
import subprocess
import tempfile
import re
from unittest.mock import patch
from types import SimpleNamespace
import unittest

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('stable_transport', ROOT / 'runtime/transport.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class Process:
    next_pid = 100000

    def __init__(self):
        Process.next_pid += 1
        self.pid = Process.next_pid
        self.exit_code = None

    def poll(self):
        return self.exit_code


class TransportTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.path = Path(self.directory.name)
        subprocess.run([
            'openssl', 'req', '-x509', '-newkey', 'rsa:2048', '-nodes',
            '-keyout', str(self.path / 'key.pem'), '-out', str(self.path / 'cert.pem'),
            '-days', '1', '-subj', '/CN=localhost',
        ], check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        self.server_context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        self.server_context.load_cert_chain(self.path / 'cert.pem', self.path / 'key.pem')
        self.client_context = ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
        self.client_context.check_hostname = False
        self.client_context.load_verify_locations(self.path / 'cert.pem')
        self.killed = []
        connector = SimpleNamespace(
            VERSION='fixture', terminate=lambda process: self.killed.append(process.pid),
        )
        self.transport = module.StableTransport(connector, 'fixture', self.path)
        self.backends = []
        self.runner = None

    async def asyncTearDown(self):
        self.transport.stopping.set()
        if self.runner:
            await asyncio.wait_for(self.runner, 5)
        if self.transport.server:
            self.transport.server.close()
            await self.transport.server.wait_closed()
        for writer in list(self.transport.connections):
            writer.close()
        for task in list(self.transport.tasks):
            task.cancel()
        await asyncio.gather(*self.transport.tasks, return_exceptions=True)
        for backend in self.backends:
            backend.close()
            await backend.wait_closed()
        self.directory.cleanup()

    async def backend(self, text):
        async def respond(reader, writer):
            try:
                await reader.readuntil(b'\r\n\r\n')
                payload = text.encode()
                writer.write(b'HTTP/1.1 200 OK\r\nConnection: close\r\nContent-Length: ' +
                             str(len(payload)).encode() + b'\r\n\r\n' + payload)
                await writer.drain()
            except (OSError, asyncio.IncompleteReadError):
                pass
            finally:
                writer.close()
        server = await asyncio.start_server(respond, '127.0.0.1', 0, ssl=self.server_context)
        self.backends.append(server)
        return server.sockets[0].getsockname()[1]

    async def request(self):
        reader, writer = await asyncio.open_connection(
            '127.0.0.1', self.transport.local_port,
            ssl=self.client_context, server_hostname='localhost',
        )
        try:
            writer.write(b'GET / HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n')
            await writer.drain()
            return await asyncio.wait_for(reader.read(), 5)
        finally:
            writer.close()
            await writer.wait_closed()

    async def wait_until(self, predicate):
        for _ in range(100):
            if predicate():
                return
            await asyncio.sleep(.05)
        self.fail('Transport did not reach the expected state.')

    async def test_stable_tls_origin_survives_ssh_reconnect(self):
        first, second = await self.backend('first'), await self.backend('second')
        children = [Process(), Process()]
        targets = [first, second]

        async def discover():
            return 4321

        async def forward(_):
            return children.pop(0), targets.pop(0)

        self.transport.discover = discover
        self.transport.start_forward = forward
        await self.transport.bind()
        original_port = self.transport.local_port
        self.runner = asyncio.create_task(self.transport.maintain())
        await self.wait_until(lambda: self.transport.state == 'connected')
        self.assertTrue((await self.request()).endswith(b'first'))
        old_ssh = self.transport.ssh
        old_ssh.exit_code = 255
        await self.wait_until(lambda: self.transport.ssh is not old_ssh and self.transport.state == 'connected')
        self.assertEqual(self.transport.local_port, original_port)
        self.assertTrue((await self.request()).endswith(b'second'))
        self.assertIsNone(self.transport.legacy_owner)
        self.assertEqual(len(self.backends), 2)

    async def test_frontend_listener_reuses_port_after_supervisor_restart(self):
        await self.transport.bind()
        port = self.transport.local_port
        self.transport.server.close()
        await self.transport.server.wait_closed()
        replacement = module.StableTransport(self.transport.connector, 'fixture', self.path)
        await replacement.bind()
        try:
            self.assertEqual(replacement.local_port, port)
        finally:
            replacement.server.close()
            await replacement.server.wait_closed()


class EntrypointTests(unittest.TestCase):
    def test_cli_creates_async_resources_on_the_running_loop(self):
        with tempfile.TemporaryDirectory() as directory:
            connector = SimpleNamespace(
                DATA=Path(directory), VERSION='fixture', ALIAS=re.compile(r'fixture'),
            )
            class Probe(module.StableTransport):
                def __init__(self, *args, **kwargs):
                    asyncio.get_running_loop()
                    super().__init__(*args, **kwargs)
                async def run(self):
                    asyncio.get_running_loop().call_soon(self.stopping.set)
                    await self.stopping.wait()
            with patch.object(module, 'load_connector', return_value=connector), patch.object(module, 'StableTransport', Probe):
                module.main('fixture')


if __name__ == '__main__':
    unittest.main()
