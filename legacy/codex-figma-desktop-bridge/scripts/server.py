"""Local, serialized Figma job broker. No desktop input, focus or clipboard APIs."""
import base64, hashlib, hmac, json, threading, time, uuid
from pathlib import Path
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
ROOT=Path(__file__).resolve().parent
RUNTIME=ROOT/'runtime.json'
if not RUNTIME.is_file():
    raise SystemExit('Run python scripts/setup.py before starting the bridge.')
TOKEN=json.loads(RUNTIME.read_text(encoding='utf-8'))['token']
DATA=ROOT/'jobs'; DATA.mkdir(exist_ok=True)
LOCK=threading.Condition(); JOBS={}; CLIENTS={}; ACTIVE=None
for p in DATA.glob('*.json'):
    try:
        j=json.loads(p.read_text(encoding='utf-8'))
        if j['state'] in ('queued','running'):j['state']='interrupted';j['error']='Broker restarted; write will not be repeated automatically.'
        JOBS[j['id']]=j
    except (ValueError,KeyError):pass
def save(j):
    p=DATA/(j['id']+'.json'); tmp=p.with_suffix('.tmp')
    tmp.write_text(json.dumps(j,ensure_ascii=False),encoding='utf-8');tmp.replace(p)
def housekeeping():
    global ACTIVE
    now=time.time()
    for j in JOBS.values():
        if j['state']=='queued' and now>j['expiresAt']:j.update(state='expired',error='Not dispatched before deadline');save(j)
        if j['state']=='running' and now-j['startedAt']>120:j.update(state='unknown',error='Plugin response timed out; do not automatically replay');save(j);ACTIVE=None
def enqueue(data):
    for k in ['taskId','fileName','pageId','frameIds','kind']:
        if not data.get(k):raise ValueError('Required: '+k)
    if data['kind'] not in ['inspect','replace_scene','set','export','save_version']:raise ValueError('Unsupported job kind')
    if not isinstance(data['frameIds'],list) or len(data['frameIds'])>20:raise ValueError('frameIds must name 1-20 target frames')
    if data['kind']=='replace_scene' and {f['id'] for f in data['frames']}!=set(data['frameIds']):raise ValueError('Scene frame IDs must equal declared scope')
    raw=json.dumps(data,sort_keys=True,ensure_ascii=False);digest=hashlib.sha256(raw.encode()).hexdigest()
    with LOCK:
        housekeeping()
        for j in JOBS.values():
            if j['request']['taskId']==data['taskId']:
                if j['digest']!=digest:raise ValueError('taskId already used for a different payload')
                return j
        j={'id':uuid.uuid4().hex,'state':'queued','createdAt':time.time(),'expiresAt':time.time()+min(int(data.get('ttl',600)),3600),'digest':digest,'request':data}
        JOBS[j['id']]=j;save(j);LOCK.notify_all();return j
class Handler(BaseHTTPRequestHandler):
    def log_message(self,*args):pass
    def authorized(self):
        if hmac.compare_digest(self.headers.get('X-Bridge-Token',''),TOKEN):return True
        self.reply({'error':'Unauthorized'},403)
        return False
    def reply(self,data,code=200):
        b=json.dumps(data,ensure_ascii=False).encode();self.send_response(code)
        for k,v in {'Content-Type':'application/json; charset=utf-8','Access-Control-Allow-Origin':'*','Access-Control-Allow-Headers':'Content-Type, X-Bridge-Token','Access-Control-Allow-Methods':'GET, POST, OPTIONS','Access-Control-Allow-Private-Network':'true','Content-Length':str(len(b))}.items():self.send_header(k,v)
        self.end_headers()
        try:self.wfile.write(b)
        except (BrokenPipeError,ConnectionResetError):pass
    def do_OPTIONS(self):self.reply({},204)
    def do_GET(self):
        if not self.authorized():return
        with LOCK:
            housekeeping()
            if self.path=='/health':return self.reply({'ok':True,'activeJob':ACTIVE,'clients':[dict(c,connected=time.time()-c['lastSeen']<35) for c in CLIENTS.values()],'queued':sum(j['state']=='queued' for j in JOBS.values())})
            if self.path.startswith('/jobs/'):
                j=JOBS.get(self.path.rsplit('/',1)[-1]);return self.reply(j or {'error':'Unknown job'},200 if j else 404)
        self.reply({'error':'Not found'},404)
    def do_POST(self):
        global ACTIVE
        if not self.authorized():return
        try:
            size=int(self.headers.get('Content-Length','0'))
            if size>25000000:raise ValueError('Payload too large')
            d=json.loads(self.rfile.read(size) or b'{}')
            if self.path=='/jobs':return self.reply(enqueue(d),202)
            if self.path=='/poll':
                with LOCK:
                    cid=d['clientId'];CLIENTS[cid]=dict(d,lastSeen=time.time());deadline=time.time()+20
                    while time.time()<deadline:
                        housekeeping();CLIENTS[cid]['lastSeen']=time.time()
                        if ACTIVE is None:
                            for j in JOBS.values():
                                q=j['request']
                                if j['state']=='queued' and q['fileName']==d['fileName'] and q['pageId']==d['pageId'] and (not q.get('clientId') or q['clientId']==cid):
                                    peers=[c for c in CLIENTS.values() if c['fileName']==d['fileName'] and c['pageId']==d['pageId'] and time.time()-c['lastSeen']<35]
                                    if len(peers)>1 and not q.get('clientId'):continue
                                    ACTIVE=j['id'];j.update(state='running',clientId=cid,startedAt=time.time());save(j)
                                    return self.reply({'jobId':j['id'],'request':q})
                        LOCK.wait(timeout=min(1,max(0,deadline-time.time())))
                    return self.reply({'jobId':None})
            if self.path=='/result':
                with LOCK:
                    j=JOBS.get(d['jobId'])
                    if not j or j.get('clientId')!=d['clientId']:raise ValueError('Job ownership mismatch')
                    result=d.get('result',{});artifacts=[]
                    for im in result.pop('images',[]):
                        name=j['id']+'_'+im['nodeId'].replace(':','-')+'.png';raw=base64.b64decode(im['base64'],validate=True)
                        if not raw.startswith(b'\x89PNG\r\n\x1a\n'):raise ValueError('Invalid image')
                        (DATA/name).write_bytes(raw);artifacts.append({'nodeId':im['nodeId'],'path':str(DATA/name)})
                    if artifacts:result['artifacts']=artifacts
                    j.update(state='completed' if d.get('ok') else 'failed',finishedAt=time.time(),result=result,error=d.get('error'))
                    save(j)
                    if ACTIVE==j['id']:ACTIVE=None
                    LOCK.notify_all();return self.reply({'ok':True})
            self.reply({'error':'Not found'},404)
        except Exception as e:self.reply({'error':str(e)},400)
if __name__=='__main__':
    print('Figma background broker: http://127.0.0.1:38473',flush=True)
    ThreadingHTTPServer(('127.0.0.1',38473),Handler).serve_forever()
