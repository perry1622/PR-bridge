import argparse,json,time,urllib.request
from pathlib import Path
BASE='http://127.0.0.1:38473'
TOKEN_FILE=Path(__file__).resolve().parent/'runtime.json'
def request(path,data=None):
    if not TOKEN_FILE.is_file():raise RuntimeError('Run python scripts/setup.py first.')
    token=json.loads(TOKEN_FILE.read_text(encoding='utf-8'))['token']
    raw=None if data is None else json.dumps(data,ensure_ascii=False).encode()
    req=urllib.request.Request(BASE+path,data=raw,headers={'Content-Type':'application/json','X-Bridge-Token':token})
    with urllib.request.urlopen(req,timeout=25) as r:return json.load(r)
def run(data,timeout=50):
    j=request('/jobs',data);deadline=time.monotonic()+timeout
    while j['state'] in ('queued','running') and time.monotonic()<deadline:
        time.sleep(.4);j=request('/jobs/'+j['id'])
    return j
if __name__=='__main__':
    p=argparse.ArgumentParser();p.add_argument('file',nargs='?');p.add_argument('--status',action='store_true');p.add_argument('--output');a=p.parse_args()
    d=request('/health') if a.status else run(json.loads(Path(a.file).read_text(encoding='utf-8-sig')))
    if a.output:Path(a.output).write_text(json.dumps(d,ensure_ascii=False,indent=2),encoding='utf-8')
    if a.status:print(json.dumps(d,ensure_ascii=False))
    else:print(json.dumps({'id':d['id'],'state':d['state'],'error':d.get('error'),'artifacts':d.get('result',{}).get('artifacts'),'viewUnchanged':d.get('result',{}).get('viewUnchanged')},ensure_ascii=False))
