#!/usr/bin/env python3
"""Keep one local HTTPS origin while its SSH transport reconnects."""
import argparse
import asyncio
import base64
import fcntl
import errno
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import signal
import socket
import ssl
import subprocess
import sys
import tempfile
import time
import traceback


def load_connector():
    path = Path(__file__).with_name('connect.py')
    spec = importlib.util.spec_from_file_location('workspace_connector', path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def atomic_json(file, value):
    with tempfile.NamedTemporaryFile(mode='w', dir=file.parent, prefix='.transport-', delete=False) as out:
        json.dump(value, out)
        temporary = Path(out.name)
    temporary.replace(file)


def json_file(file):
    try:
        return json.loads(file.read_text())
    except (OSError, ValueError):
        return {}


def reserve_port():
    with socket.socket() as sock:
        sock.bind(('127.0.0.1', 0))
        return sock.getsockname()[1]


class StableTransport:
    def __init__(self, connector, host, profile, adopt_port=None):
        self.connector = connector
        spec = importlib.util.spec_from_file_location('remote_cli', Path(__file__).with_name('remote_cli.py'))
        self.cli_module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(self.cli_module)
        self.backend = None
        self.app_pid = None
        self.host = host
        self.profile = profile
        self.record = profile / 'transport.json'
        self.port_file = profile / 'transport-port.json'
        self.local_port = adopt_port
        self.adopt_port = adopt_port
        self.remote_port = None
        self.server_path = '~/.local/share/antigravity-ssh-preview/' + connector.VERSION + '/language_server'
        self.target = None
        self.ready = asyncio.Event()
        self.rediscover = asyncio.Event()
        self.stopping = asyncio.Event()
        self.ssh = None
        self.server = None
        self.legacy_owner = None
        self.state = None
        self.failures = 0
        self.early_closes = 0
        self.last_discovery = 0
        self.connections = set()
        self.tasks = set()

    def publish(self, state, error=None):
        self.state = state
        atomic_json(self.record, {
            'schema': 3, 'backend': 'cli', 'host': self.host, 'supervisorPID': os.getpid(),
            'backendPID': self.backend.get('pid') if self.backend else None,
            'csrf': self.backend.get('csrf') if self.backend else None,
            'port': self.local_port, 'state': state,
            'remotePort': self.remote_port, 'sshPID': self.ssh.pid if self.ssh else None,
            'updatedAt': time.time(), 'attempts': self.failures,
            'error': error,
        })

    async def bind(self):
        if self.adopt_port:
            self.publish('connecting')
            return
        previous = json_file(self.port_file).get('port')
        if not isinstance(previous, int) or not 1024 <= previous <= 65535:
            previous = 0
        try:
            self.server = await asyncio.start_server(self.bridge, '127.0.0.1', previous)
        except OSError as error:
            if previous and error.errno == errno.EADDRINUSE:
                self.local_port = previous
                await self.activate_listener()
            else:
                raise
        self.local_port = self.server.sockets[0].getsockname()[1]
        atomic_json(self.port_file, {'port': self.local_port})
        self.publish('connecting')

    async def activate_listener(self):
        if self.server is not None:
            return
        self.publish('prepared')
        while not self.stopping.is_set():
            try:
                self.server = await asyncio.start_server(self.bridge, '127.0.0.1', self.local_port)
                atomic_json(self.port_file, {'port': self.local_port})
                return
            except OSError as error:
                if error.errno != errno.EADDRINUSE:
                    raise
                await asyncio.sleep(.2)
        raise RuntimeError('Transport stopped.')

    async def bridge(self, reader, writer):
        task = asyncio.current_task()
        self.tasks.add(task)
        self.connections.add(writer)
        upstream = None
        transferred = {'sent': 0, 'received': 0}

        async def copy(source, destination, key):
            try:
                while True:
                    chunk = await source.read(65536)
                    if not chunk:
                        break
                    transferred[key] += len(chunk)
                    destination.write(chunk)
                    await destination.drain()
            finally:
                if destination.can_write_eof() and not destination.is_closing():
                    destination.write_eof()

        try:
            await asyncio.wait_for(self.ready.wait(), timeout=120)
            upstream_reader, upstream = await asyncio.wait_for(
                asyncio.open_connection('127.0.0.1', self.target), timeout=5,
            )
            self.connections.add(upstream)
            await asyncio.gather(copy(reader, upstream, 'sent'), copy(upstream_reader, writer, 'received'))
        except (OSError, asyncio.TimeoutError):
            pass
        finally:
            if transferred['sent'] and not transferred['received']:
                self.early_closes += 1
                if self.early_closes >= 3 and time.monotonic() - self.last_discovery >= 30:
                    self.rediscover.set()
            elif transferred['received']:
                self.early_closes = 0
            for connection in (upstream, writer):
                if connection:
                    connection.close()
                    self.connections.discard(connection)
            self.tasks.discard(task)

    def verify_target(self, port):
        context = ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
        context.check_hostname = False
        context.verify_mode = ssl.CERT_NONE
        with socket.create_connection(('127.0.0.1', port), timeout=20) as stream:
            with context.wrap_socket(stream, server_hostname='localhost') as secured:
                certificate = ssl.DER_cert_to_PEM_cert(secured.getpeercert(binary_form=True))
        public = subprocess.check_output(['openssl', 'x509', '-pubkey', '-noout'], input=certificate.encode())
        key = subprocess.check_output(['openssl', 'pkey', '-pubin', '-outform', 'DER'], input=public)
        if base64.b64encode(hashlib.sha256(key).digest()).decode() != self.connector.BACKEND_CERT_SPKI:
            raise RuntimeError('The workspace TLS key does not match the supported release.')

    async def discover(self):
        self.backend = await asyncio.to_thread(self.cli_module.ensure, self.connector, self.host)
        self.last_discovery = time.monotonic()
        return self.backend['remotePort']

    async def start_forward(self, remote_port):
        local_port = reserve_port()
        args = [*self.connector.SSH, *self.connector.managed_ssh_config(self.host),
                '-N', '-o', 'ExitOnForwardFailure=yes', '-L',
                f'127.0.0.1:{local_port}:127.0.0.1:{remote_port}', self.host]
        child = subprocess.Popen(args, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                                 stderr=subprocess.DEVNULL)
        deadline = time.monotonic() + 90
        try:
            while child.poll() is None and time.monotonic() < deadline:
                if self.stopping.is_set():
                    raise RuntimeError('Transport stopped.')
                try:
                    await asyncio.to_thread(self.verify_target, local_port)
                    return child, local_port
                except (ConnectionError, ssl.SSLError, TimeoutError, OSError):
                    await asyncio.sleep(1)
            raise RuntimeError('The SSH transport could not connect.')
        except BaseException:
            await asyncio.to_thread(self.connector.terminate, child)
            raise

    async def wait_retry(self):
        self.failures += 1
        delay = min(30, 2 ** min(self.failures, 5))
        try:
            await asyncio.wait_for(self.stopping.wait(), timeout=delay)
        except asyncio.TimeoutError:
            pass

    async def maintain(self):
        while not self.stopping.is_set():
            try:
                if self.app_pid:
                    try:
                        os.kill(self.app_pid, 0)
                    except ProcessLookupError:
                        self.stopping.set()
                        break
                self.publish('connecting' if self.failures == 0 else 'reconnecting')
                # A lost SSH socket does not invalidate the running remote backend.
                remote_port = self.remote_port or await self.discover()
                if remote_port is None:
                    raise RuntimeError('The official remote CLI is not ready.')
                child, target = await self.start_forward(remote_port)
                self.ssh, self.target, self.remote_port = child, target, remote_port
                self.failures = 0
                await self.activate_listener()
                self.ready.set()
                self.publish('connected')
                while not self.stopping.is_set() and child.poll() is None:
                    if self.app_pid:
                        try:
                            os.kill(self.app_pid, 0)
                        except ProcessLookupError:
                            self.stopping.set()
                            break
                    if self.rediscover.is_set():
                        self.rediscover.clear()
                        try:
                            discovered = await self.discover()
                            if discovered and discovered != self.remote_port:
                                replacement, new_target = await self.start_forward(discovered)
                                self.ssh, self.target, self.remote_port = replacement, new_target, discovered
                                self.publish('connected')
                                await asyncio.to_thread(self.connector.terminate, child)
                                child = replacement
                        except (OSError, RuntimeError, subprocess.SubprocessError, ValueError):
                            pass
                    try:
                        await asyncio.wait_for(self.stopping.wait(), timeout=1)
                    except asyncio.TimeoutError:
                        pass
                self.ready.clear()
                self.publish('reconnecting')
            except (OSError, RuntimeError, subprocess.SubprocessError, ValueError) as error:
                self.ready.clear()
                self.remote_port = None
                phase = getattr(error, 'code', 'reconnecting')
                self.publish(phase, str(error) if isinstance(error, self.cli_module.CLIUnavailable) else type(error).__name__)
            finally:
                if self.ssh:
                    await asyncio.to_thread(self.connector.terminate, self.ssh)
                    self.ssh = None
            if not self.stopping.is_set():
                await self.wait_retry()

    async def run(self):
        await self.bind()
        loop = asyncio.get_running_loop()
        for name in (signal.SIGTERM, signal.SIGINT):
            loop.add_signal_handler(name, self.stopping.set)
        try:
            await self.maintain()
        finally:
            self.ready.clear()
            if self.server is not None:
                self.server.close()
                await self.server.wait_closed()
            for writer in list(self.connections):
                writer.close()
            for task in list(self.tasks):
                task.cancel()
            await asyncio.gather(*self.tasks, return_exceptions=True)
            record = json_file(self.record)
            if record.get('supervisorPID') == os.getpid():
                self.record.unlink(missing_ok=True)


def main(host=None):
    adopt_port = None
    app_pid = None
    if host is None:
        parser = argparse.ArgumentParser()
        parser.add_argument('--host', required=True)
        parser.add_argument('--adopt-port', type=int)
        parser.add_argument('--app-pid', type=int)
        args = parser.parse_args()
        host, adopt_port, app_pid = args.host, args.adopt_port, args.app_pid
        if adopt_port is not None and not 1024 <= adopt_port <= 65535:
            parser.error('Invalid local relay port.')
    connector = load_connector()
    if not connector.ALIAS.fullmatch(host):
        raise SystemExit('Invalid SSH host alias.')
    profile = connector.DATA / host
    profile.mkdir(mode=0o700, parents=True, exist_ok=True)
    with (profile / 'transport.lock').open('a') as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            return
        async def run_transport():
            transport = StableTransport(connector, host, profile, adopt_port)
            transport.app_pid = app_pid
            await transport.run()
        try:
            asyncio.run(run_transport())
        except Exception:
            (profile / 'transport-error.log').write_text(traceback.format_exc())
            os.chmod(profile / 'transport-error.log', 0o600)
            raise


if __name__ == '__main__':
    main()
