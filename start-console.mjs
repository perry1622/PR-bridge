import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
const port = Number(process.env.PR_CONSOLE_PORT || 38470);
const url = `http://127.0.0.1:${port}`;
async function running() {
  let response;
  try { response = await fetch(url+'/api/state',{signal:AbortSignal.timeout(2500)}); } catch { return false; }
  const state=await response.json(); if(state.service!=='PR-bridge-console') throw new Error('控制台端口被其他服务占用'); return true;
}
if (!await running()) {
  const child=spawn(process.execPath,[fileURLToPath(new URL('./console-server.mjs',import.meta.url))],{detached:true,windowsHide:true,stdio:'ignore',env:process.env});child.unref();
  for(let i=0;i<30;i++){await delay(100);if(await running())break;}
  if(!await running())throw new Error('控制台启动失败');
}
console.log(url);
