#!/usr/bin/env python3
"""Inspect/update an existing SSH CLI without stopping its backend service."""
import importlib.util
import json
from pathlib import Path
import shlex
import sys

ROOT=Path(__file__).resolve().parent


def execute(host,operation):
    spec=importlib.util.spec_from_file_location('cli_update_connector',ROOT/'connect.py')
    connector=importlib.util.module_from_spec(spec);spec.loader.exec_module(connector)
    if not connector.ALIAS.fullmatch(host) or operation not in ('check','refresh','update','restart'):
        raise ValueError('Invalid SSH CLI update request.')
    source=(ROOT/'cli_update_remote.py').read_text()
    record=connector.DATA/host/'transport.json'
    session=json.loads(record.read_text()) if record.exists() else {}
    port=session.get('remotePort',0) if session.get('backend')=='cli' and session.get('host')==host else 0
    command=shlex.join(['python3','-c',source,operation,str(port or 0),connector.BACKEND_CERT_SPKI])
    lines=connector.remote(host,'bash -lc '+shlex.quote(command),timeout=240).splitlines()
    if not lines:raise RuntimeError('The SSH host returned no CLI update status.')
    result=json.loads(lines[-1])
    if result.get('ok') is not True:raise RuntimeError(result.get('message','CLI update failed.'))
    value=result['status']
    if value.get('state') not in ('available','restart_required','current'):
        raise RuntimeError('The SSH host returned an invalid CLI update state.')
    record=connector.DATA/host/'cli-update.json';record.parent.mkdir(mode=0o700,parents=True,exist_ok=True)
    temporary=record.with_suffix('.tmp');temporary.write_text(json.dumps(value));temporary.chmod(0o600);temporary.replace(record)
    return value


if __name__=='__main__':
    try:print(json.dumps({'ok':True,'status':execute(sys.argv[1],sys.argv[2])}))
    except Exception as error:print(json.dumps({'ok':False,'message':str(error)}))
