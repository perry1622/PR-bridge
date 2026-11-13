from pathlib import Path
from playwright.sync_api import sync_playwright, expect
import json,time

root=Path(__file__).parent
now=int(time.time()*1000)
bridge={'port':38473,'status':'running','managed':True,
        'health':{'pluginConnected':True,'queuedCommands':0,'pendingCommands':0,'executing':None},
        'dashboard':{'agents':[],'queue':[],'history':[],'file':{'name':'测试文件','pageName':'Page 1','pageId':'1:1'}}}
snapshot={'updatedAt':now,'bridges':[bridge]}
with sync_playwright() as p:
    browser=p.chromium.launch(executable_path=r'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe',headless=True)
    page=browser.new_page(viewport={'width':1200,'height':800})
    errors=[]
    page.on('pageerror',lambda e:errors.append(str(e)))
    page.route('**/api/state',lambda route:route.fulfill(content_type='application/json',body=json.dumps(snapshot)))
    page.goto('http://127.0.0.1:38470')
    row=page.locator('[data-row-port="38473"]')
    expect(row).to_contain_text('暂无记录')
    # A caller without MCP heartbeat must appear during execution.
    bridge['health']['executing']={'clientId':'direct-http-agent','id':'test','startedAt':now,'timedOut':False}
    page.get_by_role('button',name='刷新状态').click()
    expect(row).to_contain_text('direct-http-agent')
    expect(row).to_contain_text('执行中')
    expect(page.locator('#agent-count')).to_have_text('1')
    # A completed request is historical evidence, not an online connection.
    bridge['health']['executing']=None
    bridge['dashboard']['history']=[{'clientId':'direct-http-agent','id':'test','type':'inspect_nodes','finishedAt':now,'outcome':'success'}]
    page.get_by_role('button',name='刷新状态').click()
    expect(row).to_contain_text('最近调用')
    expect(page.locator('#agent-count')).to_have_text('0')
    expect(page.locator('#recent-agent-count')).to_have_text('1')
    row.get_by_role('button',name='详情').click()
    expect(page.locator('#details-38473')).to_contain_text('在线状态未知')
    # Multiple HTTP requests with the same client ID represent one caller.
    bridge['dashboard']['queue']=[{'clientId':'direct-http-agent','id':'q1','type':'current_page'},{'clientId':'direct-http-agent','id':'q2','type':'current_page'}]
    page.get_by_role('button',name='刷新状态').click()
    expect(row).to_contain_text('排队中')
    expect(page.locator('#agent-count')).to_have_text('1')
    # Expired execution is not proof of a live client.
    bridge['dashboard']['queue']=[]
    bridge['health']['executing']={'clientId':'direct-http-agent','id':'test','startedAt':now,'timedOut':True}
    page.get_by_role('button',name='刷新状态').click()
    expect(row).to_contain_text('结果待确认')
    expect(page.locator('#agent-count')).to_have_text('0')
    # Heartbeat and history are merged rather than counted twice; names are escaped.
    bridge['health']['executing']=None
    bridge['dashboard']['agents']=[{'clientId':'direct-http-agent','name':'<b>Agent</b>','online':True,'pid':123}]
    page.get_by_role('button',name='刷新状态').click()
    expect(row).to_contain_text('<b>Agent</b>')
    expect(row.locator('b')).to_have_count(0)
    expect(row).to_contain_text('在线空闲')
    expect(page.locator('#agent-count')).to_have_text('1')
    expect(page.locator('#recent-agent-count')).to_have_text('0')
    assert not errors,errors
    # Read-only inspection of the real console after removing test interception.
    page.unroute('**/api/state')
    page.reload();page.wait_for_load_state('networkidle')
    page.screenshot(path=str(root/'console-checks'/'agent-status-fixed.png'),full_page=True)
    page.set_viewport_size({'width':390,'height':844})
    assert page.evaluate('document.documentElement.scrollWidth <= innerWidth')
    browser.close()
print('HTTP execution, queue, history, uncertain outcome, heartbeat merge and escaped names passed; live console captured.')
