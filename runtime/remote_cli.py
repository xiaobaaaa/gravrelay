"""Connect to the official Antigravity CLI daemon through authenticated SSH."""
import json
import shlex

class CLIUnavailable(RuntimeError):
    def __init__(self, code, message):
        self.code = code
        super().__init__(message)

REMOTE = r'''
from pathlib import Path
import base64, hashlib, json, os, re, secrets, shutil, socket, ssl, stat, subprocess, sys, time
import urllib.request, urllib.error
alias, pin = sys.argv[1:]
unit = 'antigravity-cli-daemon.service'
home = Path.home()
config = home / '.config/gravrelay'
token_file = config / 'cli.env'
dropin = home / '.config/systemd/user' / (unit + '.d')

def fail(code, message):
    print(json.dumps({'ok': False, 'code': code, 'message': message}))
    raise SystemExit(0)

def systemctl(*args):
    return subprocess.run(['systemctl', '--user', *args], capture_output=True, text=True, timeout=20)

if not shutil.which('systemctl'):
    fail('unsupported', 'The SSH host needs a systemd user service for the Antigravity CLI.')
cli = shutil.which('agy')
if not cli and (home / '.local/bin/agy').is_file():
    cli = str(home / '.local/bin/agy')
if not cli:
    fail('cli_missing', 'Install the official Antigravity CLI on this SSH host, then sign in with agy acp --login.')
cli = str(Path(cli).resolve())
active = systemctl('is-active', unit).stdout.strip() == 'active'
if active and not token_file.exists():
    fail('needs_restart', 'The existing CLI daemon needs a one-time setup after its running tasks finish.')
config.mkdir(mode=0o700, parents=True, exist_ok=True)
if not token_file.exists():
    with token_file.open('x') as output:
        output.write('ANTIGRAVITY_SERVER_CSRF_TOKEN=' + secrets.token_urlsafe(32) + '\n')
    token_file.chmod(0o600)
info = token_file.lstat()
if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077:
    fail('private_config', 'The CLI connection file must be owned by this user and readable only by this user.')
token = token_file.read_text().strip().partition('=')[2]
if not re.fullmatch(r'[A-Za-z0-9_-]{32,128}', token):
    fail('private_config', 'The private CLI connection token is invalid.')
dropin.mkdir(parents=True, exist_ok=True)
csrf_config = dropin / 'gravrelay-csrf.conf'
wanted = '[Service]\nEnvironmentFile=%h/.config/gravrelay/cli.env\n'
if not csrf_config.exists() or csrf_config.read_text() != wanted:
    if active:
        fail('needs_restart', 'The existing CLI daemon needs a one-time setup after its running tasks finish.')
    csrf_config.write_text(wanted)
    csrf_config.chmod(0o600)
if not active:
    # A service uses the remote machine's own network. Never depend on a Mac tunnel.
    proxy_values = {k: os.environ[k] for k in ('HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy', 'NO_PROXY', 'no_proxy') if os.environ.get(k)}
    if proxy_values and not (dropin / 'gravrelay-proxy.conf').exists():
        lines = ['[Service]']
        for key, value in proxy_values.items():
            if '\n' not in value and '\r' not in value:
                lines.append('Environment="' + key + '=' + value.replace('\\', '\\\\').replace('"', '\\"').replace('%', '%%') + '"')
        network = dropin / 'gravrelay-proxy.conf'
        network.write_text('\n'.join(lines) + '\n')
        network.chmod(0o600)
    systemctl('daemon-reload')
    installed = (home / '.config/systemd/user' / unit).exists()
    result = subprocess.run([cli, 'remote-control', 'start', *([] if installed else ['--name', alias])], capture_output=True, text=True, timeout=60)
    if result.returncode:
        if 'not signed in' in (result.stdout + result.stderr).lower():
            fail('authentication_required', 'Sign in on the SSH host with agy acp --login, then reconnect.')
        fail('start_failed', 'The official Antigravity CLI service could not start. Check its remote daemon logs.')

last_error = None
for attempt in range(20):
    try:
        pid = int(systemctl('show', unit, '--property=MainPID', '--value').stdout.strip())
        proc = Path('/proc') / str(pid)
        executable = os.readlink(proc / 'exe').removesuffix(' (deleted)')
        if executable != cli or proc.stat().st_uid != os.getuid() or not (proc / 'cgroup').read_text().strip().endswith('/' + unit):
            raise RuntimeError('Unexpected CLI service process.')
        inodes = set()
        for fd in (proc / 'fd').iterdir():
            try:
                link = os.readlink(fd)
                if link.startswith('socket:['):
                    inodes.add(link[8:-1])
            except OSError:
                pass
        ports = set()
        for table in ('tcp', 'tcp6'):
            for line in (proc / 'net' / table).read_text().splitlines()[1:]:
                fields = line.split()
                if fields[3] == '0A' and fields[9] in inodes:
                    address, port = fields[1].rsplit(':', 1)
                    if address not in ('0100007F', '00000000000000000000000001000000'):
                        fail('listener_exposure', 'The CLI listener must bind only to the remote loopback interface.')
                    ports.add(int(port, 16))
        for port in sorted(ports):
            try:
                context = ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
                context.check_hostname = False
                context.verify_mode = ssl.CERT_NONE
                with socket.create_connection(('127.0.0.1', port), 3) as tcp:
                    with context.wrap_socket(tcp, server_hostname='localhost') as stream:
                        pem = ssl.DER_cert_to_PEM_cert(stream.getpeercert(binary_form=True))
                public = subprocess.check_output(['openssl', 'x509', '-pubkey', '-noout'], input=pem.encode())
                key = subprocess.check_output(['openssl', 'pkey', '-pubin', '-outform', 'DER'], input=public)
                if base64.b64encode(hashlib.sha256(key).digest()).decode() != pin:
                    fail('tls_key', 'The CLI TLS key does not match this supported release.')
                trusted = ssl.create_default_context(cadata=pem)
                browser = urllib.request.build_opener(urllib.request.ProxyHandler({}), urllib.request.HTTPSHandler(context=trusted))
                request = urllib.request.Request('https://localhost:' + str(port) + '/exa.language_server_pb.LanguageServerService/GetUserStatus', data=b'{}', headers={'Content-Type': 'application/json', 'X-Codeium-Csrf-Token': token})
                with browser.open(request, timeout=12) as response:
                    value = json.load(response)
                if 'userStatus' not in value:
                    raise ValueError('Missing CLI user status.')
                print(json.dumps({'ok': True, 'backend': 'cli', 'pid': pid, 'remotePort': port, 'csrf': token}))
                raise SystemExit(0)
            except (OSError, ValueError, urllib.error.HTTPError) as error:
                last_error = type(error).__name__
    except (OSError, ValueError, RuntimeError) as error:
        last_error = type(error).__name__
    time.sleep(1)
fail('not_ready', 'The CLI service is not accepting authenticated connections yet. It will retry automatically.')
'''

def ensure(connector, host):
    command = shlex.join(['python3', '-c', REMOTE, host, connector.BACKEND_CERT_SPKI])
    output = connector.remote(host, 'bash -lc ' + shlex.quote(command), timeout=390).splitlines()
    if not output:
        raise CLIUnavailable('invalid_response', 'The SSH host returned no CLI connection description.')
    result = json.loads(output[-1])
    if result.get('ok') is not True:
        raise CLIUnavailable(result.get('code', 'not_ready'), result.get('message', 'The remote CLI is not ready.'))
    if (result.get('backend') != 'cli' or not isinstance(result.get('remotePort'), int)
            or not 1024 <= result['remotePort'] <= 65535
            or not isinstance(result.get('pid'), int) or result['pid'] < 2):
        raise CLIUnavailable('invalid_response', 'The remote CLI returned an invalid connection description.')
    return result

