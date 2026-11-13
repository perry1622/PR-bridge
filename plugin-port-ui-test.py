from playwright.sync_api import sync_playwright, expect
from pathlib import Path
from concurrent.futures import ThreadPoolExecutor
import subprocess,json,urllib.request

root=Path(__file__).parent
fixture=subprocess.Popen(['node','plugin-port-fixture.mjs'],cwd=root,stdin=subprocess.PIPE,stdout=subprocess.PIPE,text=True)
def get(port,path):
    return json.load(urllib.request.urlopen(f'http://127.0.0.1:{port}{path}',timeout=5))
def command(port):
    req=urllib.request.Request(f'http://127.0.0.1:{port}/command',data=json.dumps({'type':'current_page'}).encode(),headers={'Content-Type':'application/json'})
    return json.load(urllib.request.urlopen(req,timeout=15))
try:
    info=json.loads(fixture.stdout.readline());a,b=info['ports']
    with sync_playwright() as p, ThreadPoolExecutor() as pool:
        browser=p.chromium.launch(executable_path=r'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe',headless=True)
        page=browser.new_page(viewport={'width':360,'height':240})
        page.add_init_script('''window.savedPorts=[]; window.addEventListener('message', event=>{
          const m=event.data.pluginMessage;if(!m)return;
          if(m.type==='bridge-settings-load')window.postMessage({pluginMessage:{type:'bridge-settings',port:PORT}},'*');
          if(m.type==='bridge-settings-save')window.savedPorts.push(m.port);
          if(m.type==='bridge-context-request')window.postMessage({pluginMessage:{type:'bridge-context',name:'测试文件',pageName:'测试页',pageId:'1:1'}},'*');
          if(m.type==='bridge-command')window.testCommand=m;
        });'''.replace('PORT',str(a)))
        page.goto(f"http://127.0.0.1:{info['ui']}")
        expect(page.locator('#status')).to_have_text(f'{a} · 已连接',timeout=10000)
        assert get(a,'/health')['pluginConnected']
        page.get_by_label('连接端口',exact=True).select_option(str(b))
        page.get_by_role('button',name='切换',exact=True).click()
        expect(page.locator('#status')).to_have_text(f'{b} · 已连接',timeout=10000)
        assert not get(a,'/health')['pluginConnected']
        assert get(b,'/health')['pluginConnected']
        assert page.evaluate('savedPorts')==[a,b]
        pending=pool.submit(command,b)
        expect(page.locator('#status')).to_have_text(f'{b} · 正在执行')
        expect(page.get_by_label('连接端口',exact=True)).to_be_disabled()
        expect(page.get_by_role('button',name='切换',exact=True)).to_be_disabled()
        page.evaluate("window.postMessage({pluginMessage:{type:'bridge-result',id:window.testCommand.id,ok:true,result:{page:'test'}}},'*')")
        assert pending.result()['result']=={'page':'test'}
        expect(page.get_by_role('button',name='切换',exact=True)).to_be_enabled()
        page.screenshot(path=str(root/'console-checks'/'plugin-port-selector.png'))
        page.get_by_role('button',name='断开',exact=True).click()
        expect(page.locator('#status')).to_have_text('已断开')
        assert not get(b,'/health')['pluginConnected']
        page.route(f'http://localhost:{b}/health',lambda route:route.abort('connectionrefused'))
        page.get_by_role('button',name='连接',exact=True).click()
        expect(page.locator('#status')).to_contain_text(f'无法连接 {b}')
        expect(page.get_by_role('button',name='连接',exact=True)).to_be_enabled()
        page.unroute(f'http://localhost:{b}/health')
        page.get_by_role('button',name='连接',exact=True).click()
        expect(page.locator('#status')).to_have_text(f'{b} · 已连接',timeout=10000)
        page.get_by_role('button',name='断开',exact=True).click()
        expect(page.locator('#status')).to_have_text('已断开')
        browser.close()
        print('Port selection, remembered setting, exclusive switch, busy lock, result routing and disconnect passed.')
finally:
    fixture.stdin.close()
    try:fixture.wait(timeout=5)
    except subprocess.TimeoutExpired:fixture.terminate()
