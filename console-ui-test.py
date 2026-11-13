from playwright.sync_api import sync_playwright, expect
from pathlib import Path
import socket, json
out=Path(__file__).parent/'console-checks'
out.mkdir(exist_ok=True)
with socket.socket() as sock:
    sock.bind(('127.0.0.1',0))
    port=sock.getsockname()[1]
with sync_playwright() as p:
    browser=p.chromium.launch(executable_path=r'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe',headless=True)
    page=browser.new_page(viewport={'width':1440,'height':900})
    errors=[]
    page.on('pageerror',lambda error:errors.append(str(error)))
    page.goto('http://127.0.0.1:38470')
    page.wait_for_load_state('networkidle')
    page.locator('.panel-heading h1').wait_for()
    expect(page.locator('[data-row-port="38471"]')).to_be_visible()
    page.screenshot(path=str(out/'desktop.png'),full_page=True)
    first=page.locator('[data-row-port="38471"]')
    first.get_by_role('button',name='详情',exact=True).click()
    expect(page.locator('#details-38471')).to_be_visible()
    page.get_by_role('button',name='刷新状态').click()
    expect(page.locator('#details-38471')).to_be_visible()
    page.screenshot(path=str(out/'table-expanded.png'),full_page=True)
    first.get_by_role('button',name='收起',exact=True).click()
    page.get_by_role('button',name='＋ 添加端口').click()
    page.get_by_label('端口号',exact=True).fill(str(port))
    page.get_by_role('button',name='添加端口',exact=True).click()
    row=page.locator(f'[data-row-port="{port}"]')
    row.wait_for()
    try:
        row.get_by_role('button',name='启动',exact=True).click()
        expect(row.get_by_role('button',name='停止',exact=True)).to_be_enabled()
        expect(first.get_by_role('button',name='停止',exact=True)).to_be_enabled()
        row.get_by_role('button',name='配置',exact=True).click()
        page.get_by_role('heading',name='连接这个端口',exact=True).wait_for()
        assert 'PR-bridge' in page.get_by_label('统一 Figma 插件路径').input_value()
        assert f'127.0.0.1:{port}' in page.get_by_label('Agent 的 MCP 配置').input_value()
        page.get_by_role('dialog').get_by_role('button',name='关闭',exact=True).click()
        row.get_by_role('button',name='停止',exact=True).click()
        row.get_by_role('button',name='启动',exact=True).wait_for()
        row.get_by_role('button',name='移除',exact=True).click()
        row.wait_for(state='detached')
    finally:
        page.request.post('http://127.0.0.1:38470/api/action',headers={'x-pr-console':'1'},data={'action':'stop','port':port})
        page.request.post('http://127.0.0.1:38470/api/action',headers={'x-pr-console':'1'},data={'action':'remove','port':port})
    page.set_viewport_size({'width':390,'height':844})
    expect(page.locator('#toast')).to_be_hidden(timeout=6000)
    page.screenshot(path=str(out/'mobile.png'),full_page=True)
    assert page.evaluate('document.documentElement.scrollWidth <= innerWidth'),'Whole page overflow'
    assert page.locator('.connection-scroll').evaluate('(el)=>el.scrollWidth>el.clientWidth'),'Narrow-screen table must scroll'
    page.locator('.connection-scroll').evaluate('(el)=>el.scrollLeft=el.scrollWidth')
    first.get_by_role('button',name='配置',exact=True).click()
    expect(page.get_by_role('heading',name='连接这个端口',exact=True)).to_be_visible()
    assert '38471' in page.get_by_label('Agent 的 MCP 配置').input_value()
    assert not errors,errors
    print(json.dumps({'ui':'passed','errors':errors,'screenshots':str(out)},ensure_ascii=False))
    browser.close()
