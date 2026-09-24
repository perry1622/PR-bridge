"""Generate a per-install broker token and its local Figma plugin UI."""
import json
import secrets
from pathlib import Path

ROOT=Path(__file__).resolve().parent.parent
RUNTIME=ROOT/'scripts'/'runtime.json'
TEMPLATE=ROOT/'plugin'/'ui.template.html'
UI=ROOT/'plugin'/'ui.html'

if RUNTIME.exists():
    token=json.loads(RUNTIME.read_text(encoding='utf-8'))['token']
    if not isinstance(token,str) or len(token)<32:
        raise SystemExit('Invalid runtime token. Resolve locally without printing it.')
else:
    token=secrets.token_urlsafe(48)
    RUNTIME.write_text(json.dumps({'token':token}),encoding='utf-8')

template=TEMPLATE.read_text(encoding='utf-8')
if template.count('__BRIDGE_TOKEN_JSON__')!=1:
    raise SystemExit('Plugin UI template does not contain exactly one token slot.')
UI.write_text(template.replace('__BRIDGE_TOKEN_JSON__',json.dumps(token)),encoding='utf-8')
print('Local bridge configuration ready. Token files stay on this computer.')
