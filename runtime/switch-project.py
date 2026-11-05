#!/usr/bin/python3
"""Register a project using an existing, verified Antigravity SSH tunnel."""
import base64
import hashlib
import json
from pathlib import Path
import re
import socket
import ssl
import struct
import subprocess
import sys
import urllib.parse
import urllib.request

PIN = json.loads(Path(__file__).with_name('compatibility.json').read_text())['linuxX64']['tlsSpki']
SERVICE = '/exa.language_server_pb.LanguageServerService/'

port = int(sys.argv[1])
selection = json.loads(sys.argv[2])
syncing = 'projects' in selection
projects = selection['projects'] if syncing else [selection]
probe = ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
probe.check_hostname = False
probe.verify_mode = ssl.CERT_NONE
with socket.create_connection(('127.0.0.1', port), timeout=4) as tcp:
    with probe.wrap_socket(tcp, server_hostname='localhost') as secured:
        pem = ssl.DER_cert_to_PEM_cert(secured.getpeercert(binary_form=True))
public = subprocess.check_output(['/usr/bin/openssl', 'x509', '-pubkey', '-noout'], input=pem.encode())
spki = subprocess.check_output(['/usr/bin/openssl', 'pkey', '-pubin', '-outform', 'DER'], input=public)
if base64.b64encode(hashlib.sha256(spki).digest()).decode() != PIN:
    raise SystemExit('Unexpected backend certificate.')
context = ssl.create_default_context(cadata=pem)
browser = urllib.request.build_opener(urllib.request.ProxyHandler({}), urllib.request.HTTPSHandler(context=context))
base = f'https://localhost:{port}'
with browser.open(base + '/', timeout=4) as response:
    html = response.read(100000).decode()
csrf = re.search(r'"?csrfToken"?\s*:\s*"([^"]+)"', html)[1]


def rpc(name, payload):
    request = urllib.request.Request(base + SERVICE + name, json.dumps(payload).encode(), {
        'Content-Type': 'application/json',
        'Connect-Protocol-Version': '1',
        'X-Codeium-Csrf-Token': csrf,
    })
    with browser.open(request, timeout=6) as response:
        data = response.read(8 * 1024 * 1024 + 1)
        if len(data) > 8 * 1024 * 1024:
            raise RuntimeError('Unexpectedly large workspace response.')
        return json.loads(data)


existing = set(rpc('ListProjects', {}).get('projectIds', []))
registered = False
for project in projects:
    if project['id'] in existing:
        continue
    rpc('CreateProject', {'project': {
        'id': project['id'], 'name': project['name'],
        'projectResources': {'resources': [
            {'folderUri': 'file://' + urllib.parse.quote(folder)} for folder in project['folders']
        ]},
    }})
    registered = True
if registered:
    existing = set(rpc('ListProjects', {}).get('projectIds', []))
if any(project['id'] not in existing for project in projects):
    raise SystemExit('Project registration did not persist.')

def initial_summaries():
    payload = b'{}'
    request = urllib.request.Request(
        base + SERVICE + 'JetboxSubscribeToSummaries',
        struct.pack('>BI', 0, len(payload)) + payload,
        {
            'Content-Type': 'application/connect+json',
            'Connect-Protocol-Version': '1',
            'X-Codeium-Csrf-Token': csrf,
        },
    )
    with browser.open(request, timeout=6) as response:
        header = response.read(5)
        if len(header) != 5:
            raise RuntimeError('The conversation stream ended before its initial state.')
        flags, size = struct.unpack('>BI', header)
        if flags or size > 8 * 1024 * 1024:
            raise RuntimeError('Invalid initial conversation state.')
        message = json.loads(response.read(size))
        return message.get('updates', {})


if syncing:
    conversations = {project['id']: [] for project in projects}
    summaries = initial_summaries()
    for cascade_id, summary in summaries.items():
        if not re.fullmatch(r'[0-9a-fA-F]{8}(?:-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}', cascade_id):
            continue
        metadata = summary.get('trajectoryMetadata') or {}
        annotations = summary.get('annotations') or {}
        project_id = metadata.get('projectId')
        if project_id not in conversations or annotations.get('archived') or metadata.get('parentConversationId'):
            continue
        title = annotations.get('title') or summary.get('summary') or 'Untitled conversation'
        title = ' '.join(title.split())[:180] if isinstance(title, str) else ''
        updated = summary.get('lastModifiedTime', '')
        conversations[project_id].append({
            'id': cascade_id,
            'title': title or 'Untitled conversation',
            'updated': updated if isinstance(updated, str) else '',
        })
    for project_id, rows in conversations.items():
        rows.sort(key=lambda row: row['updated'], reverse=True)
        conversations[project_id] = rows[:100]
    print(json.dumps(conversations, ensure_ascii=False))
