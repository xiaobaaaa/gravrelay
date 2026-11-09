#!/usr/bin/python3
"""Manage projects and conversations through a verified Antigravity SSH tunnel."""
import base64
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
import hashlib
import json
import os
import stat
from pathlib import Path, PurePosixPath
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
operation = selection.get('operation')
projects = selection['projects'] if syncing else [] if operation else [selection]
UUID = re.compile(r'[0-9a-fA-F]{8}(?:-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}')
probe = ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
probe.check_hostname = False
probe.verify_mode = ssl.CERT_NONE
with socket.create_connection(('127.0.0.1', port), timeout=8) as tcp:
    with probe.wrap_socket(tcp, server_hostname='localhost') as secured:
        pem = ssl.DER_cert_to_PEM_cert(secured.getpeercert(binary_form=True))
public = subprocess.check_output(['/usr/bin/openssl', 'x509', '-pubkey', '-noout'], input=pem.encode())
spki = subprocess.check_output(['/usr/bin/openssl', 'pkey', '-pubin', '-outform', 'DER'], input=public)
if base64.b64encode(hashlib.sha256(spki).digest()).decode() != PIN:
    raise SystemExit('Unexpected backend certificate.')
context = ssl.create_default_context(cadata=pem)
browser = urllib.request.build_opener(urllib.request.ProxyHandler({}), urllib.request.HTTPSHandler(context=context))
base = f'https://localhost:{port}'
session_file = os.environ.get('GRAVRELAY_BACKEND_SESSION')
session = None
if session_file:
    record = Path(session_file)
    info = record.lstat()
    if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077:
        raise RuntimeError('The backend session must be a private file.')
    session = json.loads(record.read_text())
    if session.get('schema') != 3 or session.get('backend') != 'cli' or session.get('port') != port:
        raise RuntimeError('The CLI session does not match this tunnel.')
    csrf = session.get('csrf')
    if not isinstance(csrf, str) or not re.fullmatch(r'[A-Za-z0-9_-]{32,128}', csrf):
        raise RuntimeError('Invalid CLI connection token.')
else:
    with browser.open(base + '/', timeout=8) as response:
        html = response.read(100000).decode()
    csrf = re.search(r'"?csrfToken"?\\s*:\\s*"([^"]+)"', html)[1]


def rpc(name, payload):
    request = urllib.request.Request(base + SERVICE + name, json.dumps(payload).encode(), {
        'Content-Type': 'application/json',
        'Connect-Protocol-Version': '1',
        'X-Codeium-Csrf-Token': csrf,
    })
    with browser.open(request, timeout=10) as response:
        data = response.read(8 * 1024 * 1024 + 1)
        if len(data) > 8 * 1024 * 1024:
            raise RuntimeError('Unexpectedly large workspace response.')
        return json.loads(data)


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
    with browser.open(request, timeout=10) as response:
        header = response.read(5)
        if len(header) != 5:
            raise RuntimeError('The conversation stream ended before its initial state.')
        flags, size = struct.unpack('>BI', header)
        if flags or size > 8 * 1024 * 1024:
            raise RuntimeError('Invalid initial conversation state.')
        message = json.loads(response.read(size))
        return message.get('updates', {})


def project_ids():
    response = rpc('ListProjects', {})
    ids = response.get('projectIds', [])
    if not isinstance(ids, list) or any(not isinstance(item, str) for item in ids):
        raise RuntimeError('Invalid project list.')
    return set(ids)


def register(project):
    rpc('CreateProject', {'project': {
        'id': project['id'], 'name': project['name'],
        'projectResources': {'resources': [
            {'folderUri': 'file://' + urllib.parse.quote(folder)} for folder in project['folders']
        ]},
    }})


def timestamp(value):
    try:
        return datetime.fromisoformat(value.replace('Z', '+00:00')).timestamp() if isinstance(value, str) else 0
    except ValueError:
        return 0


def manage():
    project_id = selection['project']
    if not UUID.fullmatch(project_id):
        raise ValueError('Invalid project.')
    if operation == 'deleteProject':
        if project_id in project_ids():
            rpc('DeleteProject', {'id': project_id})
        if project_id in project_ids():
            raise RuntimeError('Project deletion did not persist.')
        return
    cascade_id = selection['conversation']
    if not UUID.fullmatch(cascade_id):
        raise ValueError('Invalid conversation.')
    summary = initial_summaries().get(cascade_id, {})
    metadata = summary.get('trajectoryMetadata') or {}
    if metadata.get('projectId') != project_id or metadata.get('parentConversationId'):
        raise ValueError('Conversation no longer belongs to this project.')
    if operation == 'deleteConversation':
        rpc('DeleteCascadeTrajectory', {'cascadeId': cascade_id})
        return
    if operation == 'stopConversation':
        rpc('ForceStopCascadeTree', {'conversationId': cascade_id})
        return
    fields = {'pin': 'pinned', 'archive': 'archived', 'markUnread': 'markedAsUnread'}
    value = selection.get('value')
    if operation == 'rename' and isinstance(value, str) and 0 < len(value.strip()) <= 180:
        annotations = {'title': value.strip()}
    elif operation in fields and type(value) is bool:
        annotations = {fields[operation]: value}
        if operation == 'markUnread' and not value:
            annotations['lastUserViewTime'] = datetime.now(timezone.utc).isoformat().replace('+00:00', 'Z')
    else:
        raise ValueError('Unsupported conversation action.')
    rpc('UpdateConversationAnnotations', {
        'cascadeIds': [cascade_id], 'annotations': annotations, 'mergeAnnotations': True,
    })


if operation:
    manage()
    print('{}')
elif syncing:
    existing = project_ids()
    pending = [project for project in projects if project['id'] not in existing
               and project.get('pendingRegistration') is True]
    for project in pending:
        register(project)
    if pending:
        existing = project_ids()
    conversations = {project['id']: [] for project in projects if project['id'] in existing}
    def read_name(project_id):
        try:
            name = rpc('ReadProject', {'id': project_id}).get('project', {}).get('name')
            return project_id, name if isinstance(name, str) and 0 < len(name) <= 120 else None
        except (OSError, ValueError):
            return project_id, None
    summaries = initial_summaries() if conversations else {}
    for cascade_id, summary in summaries.items():
        if not UUID.fullmatch(cascade_id):
            continue
        metadata = summary.get('trajectoryMetadata') or {}
        annotations = summary.get('annotations') or {}
        project_id = metadata.get('projectId')
        if project_id not in conversations or metadata.get('parentConversationId'):
            continue
        title = annotations.get('title') or summary.get('summary') or 'Untitled conversation'
        title = ' '.join(title.split())[:180] if isinstance(title, str) else ''
        updated = summary.get('lastModifiedTime', '')
        unread = not annotations.get('archived') and not summary.get('notFullyIdle') and (
            annotations.get('markedAsUnread') is True or
            int(timestamp(updated)) > timestamp(annotations.get('lastUserViewTime'))
        )
        workspace_uris = metadata.get('workspaceUris') or []
        workspace = ''
        if workspace_uris and isinstance(workspace_uris[0], str):
            uri = urllib.parse.urlparse(workspace_uris[0])
            if uri.scheme == 'file':
                workspace = PurePosixPath(urllib.parse.unquote(uri.path)).name
        status = summary.get('status')
        has_subagents = summary.get('hasRunningSubagents') is True
        is_idle = status in (None, 0, 1, 'CASCADE_RUN_STATUS_UNSPECIFIED', 'CASCADE_RUN_STATUS_IDLE')
        running = not summary.get('killed') and (
            status in ('CASCADE_RUN_STATUS_RUNNING', 'CASCADE_RUN_STATUS_BUSY', 'CASCADE_RUN_STATUS_CANCELING', 2, 3, 4)
            or has_subagents
        )
        background_running = not summary.get('killed') and is_idle and not has_subagents and bool(summary.get('notFullyIdle'))
        conversations[project_id].append({
            'id': cascade_id,
            'title': title or 'Untitled conversation',
            'updated': updated if isinstance(updated, str) else '',
            'workspace': workspace,
            'pinned': annotations.get('pinned') is True,
            'archived': annotations.get('archived') is True,
            'unread': unread,
            'running': running,
            'backgroundRunning': background_running,
        })
    for project_id, rows in conversations.items():
        rows.sort(key=lambda row: (not row['archived'], row['pinned'], row['updated']), reverse=True)
        conversations[project_id] = rows[:100] + [row for row in rows[100:] if row['archived']][:100]
    if selection.get('catalog') is True:
        names = {}
        if selection.get('includeNames') is True:
            with ThreadPoolExecutor(max_workers=4) as pool:
                names = {key: name for key, name in pool.map(read_name, list(conversations)[:40]) if name}
        print(json.dumps({'conversations': conversations, 'names': names}, ensure_ascii=False))
    else:
        print(json.dumps(conversations, ensure_ascii=False))
else:
    project = selection
    if project['id'] not in project_ids():
        register(project)
    if project['id'] not in project_ids():
        raise SystemExit('Project registration did not persist.')
