import {spawn,spawnSync} from 'node:child_process';
import http from 'node:http';
import {writeFileSync,unlinkSync,readFileSync,mkdtempSync,appendFileSync,mkdirSync,statSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
// Windows-only native TUI regression. Run in a terminal with Codex already set
// up. Uses a local model substitute and a temporary profile, never production HS.
// The test profile's authored hooks use the documented CI trust bypass; do not
// copy that bypass into production. Skip any updater; enter HS_LOCAL_HOLD once.
if(process.platform!=='win32')throw Error('This native TUI probe currently supports Windows only');
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const state=mkdtempSync(path.join(os.tmpdir(),'hs-ack-native-'));
const entry=process.env.CODEX_CLI_ENTRY;
if(!entry)throw Error('Set CODEX_CLI_ENTRY to the installed @openai/codex/bin/codex.js');
statSync(entry);
const codexHome=process.env.CODEX_HOME??path.join(os.homedir(),'.codex');
const evidenceDir=process.env.HS_ACK_EVIDENCE_DIR??state;mkdirSync(evidenceDir,{recursive:true});
let posts=0, firstResponse, release=false, evidence={result:'failed'}, requests=[];
function reply(res,n){
 const id='resp_local_'+n,msg={id:'msg_local_'+n,type:'message',role:'assistant',status:'completed',content:[{type:'output_text',text:'LOCAL_MODEL_OK',annotations:[]}]};
 const send=v=>res.write('data: '+JSON.stringify(v)+'\n\n');
 send({type:'response.output_item.added',output_index:0,item:{...msg,status:'in_progress',content:[]}});
 send({type:'response.output_text.delta',output_index:0,content_index:0,item_id:msg.id,delta:'LOCAL_MODEL_OK'});
 send({type:'response.output_item.done',output_index:0,item:msg});
 send({type:'response.completed',response:{id,object:'response',created_at:Math.floor(Date.now()/1000),status:'completed',model:'gpt-6-luna',output:[msg],usage:{input_tokens:0,output_tokens:0,total_tokens:0}}});res.end();
}
const server=http.createServer((req,res)=>{
 if(req.method!=='POST'){res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({data:[{id:'gpt-6-luna',object:'model'}]}));return;}
 let body='';req.on('data',c=>body+=c);req.on('end',()=>{
 requests.push({path:req.url,hold:body.includes('HS_LOCAL_HOLD'),seq445:body.includes('seq=445'),seq714:body.includes('seq=714')});
 const n=++posts;res.writeHead(200,{'content-type':'text/event-stream'});res.write('data: '+JSON.stringify({type:'response.created',response:{id:'resp_local_'+n,object:'response',created_at:Math.floor(Date.now()/1000),status:'in_progress',output:[]}})+'\n\n');
 if(body.includes('HS_LOCAL_HOLD')&&!release&&!firstResponse)firstResponse=res;else reply(res,n);
 });
});
await new Promise(r=>server.listen(0,'127.0.0.1',r));const port=server.address().port;
const wrapper=path.join(state,'hook.mjs');
writeFileSync(wrapper,`import {writeFileSync,appendFileSync} from 'node:fs';import {checkNotificationPrompt} from ${JSON.stringify(pathToFileURL(path.join(root,'dist/src/codex-notification-gate.js')).href)};let body='';for await(const c of process.stdin)body+=c;const input=JSON.parse(body);const state=${JSON.stringify(state)};if(input.hook_event_name==='SessionStart'){writeFileSync(state+'/thread.json',JSON.stringify({threadId:input.session_id}));const rec={id:'w-native-ack#445',workerId:'w-native-ack',runtime:'pi',seq:445,eventType:'run.completed',kind:'completed',createdAt:new Date().toISOString(),summary:{status:'completed'},target:{channel:'codex-queue',codexThreadId:input.session_id},delivery:{state:'delivered',channel:'codex-queue',attempts:1}};writeFileSync(state+'/notifications.jsonl',JSON.stringify(rec)+'\\n');}else{const result=await checkNotificationPrompt(input,state);if(result.block)console.log(JSON.stringify({decision:'block',reason:'HS_ACK_GATE_BLOCKED'}));}`);
const profileName=`hs-ack-queue-${process.pid}`,profile=path.join(codexHome,`${profileName}.config.toml`);
const command=`node '${wrapper.replaceAll("'","''")}'`;
writeFileSync(profile,`[features]\nhooks=true\n[[hooks.SessionStart]]\n[[hooks.SessionStart.hooks]]\ntype="command"\ncommand=${JSON.stringify(command)}\ntimeout=5\n[[hooks.UserPromptSubmit]]\n[[hooks.UserPromptSubmit.hooks]]\ntype="command"\ncommand=${JSON.stringify(command)}\ntimeout=5\n[mcp_servers.harness_supervisor]\nenabled=false\n`,{flag:'wx'});
const child=spawn(process.execPath,[entry,'--sandbox','read-only','--dangerously-bypass-hook-trust','-m','gpt-6-luna','-p',profileName,'-c','model_reasoning_effort="low"','-c','model_provider="hook_probe"','-c',`model_providers.hook_probe={name="hook_probe",base_url="http://127.0.0.1:${port}/v1",wire_api="responses",requires_openai_auth=false}`],{stdio:'inherit',windowsHide:true,env:{...process.env,TERM:'xterm-256color'}});
const wait=async(test,ms=20000)=>{const end=Date.now()+ms;while(Date.now()<end){try{if(test())return;}catch{}await new Promise(r=>setTimeout(r,100));}throw Error('probe condition timed out');};
async function queue(threadId,message){const cp=spawn(process.execPath,[entry,'queue','--thread',threadId,'--message',message],{stdio:['ignore','pipe','pipe'],windowsHide:true});let output='';cp.stdout.on('data',c=>output+=c);cp.stderr.resume();const code=await new Promise(r=>cp.on('close',r));if(code!==0)throw Error('queue failed '+code);return output;}
let finished=false;
const probe=(async()=>{try{
 await wait(()=>JSON.parse(readFileSync(state+'/thread.json')).threadId,45000);const {threadId}=JSON.parse(readFileSync(state+'/thread.json'));
 await wait(()=>firstResponse!==undefined);
 const text='[harness-supervisor] w-native-ack completed seq=445 | read worker_status for result';
 const receipt=await queue(threadId,text);const acceptedAt=new Date().toISOString();
 const n=JSON.parse(readFileSync(state+'/notifications.jsonl','utf8').trim());n.ackAt=new Date().toISOString();appendFileSync(state+'/notifications.jsonl',JSON.stringify(n)+'\n');
 release=true;reply(firstResponse,1);
 await wait(()=>readFileSync(state+'/notification-gate.jsonl','utf8').includes('block_acknowledged'));
 await new Promise(r=>setTimeout(r,500));
 if(requests.some(r=>r.seq445))throw Error('ACKed message reached local model');
 const fresh={...n,id:'w-native-ack#714',seq:714,ackAt:undefined};appendFileSync(state+'/notifications.jsonl',JSON.stringify(fresh)+'\n');
 await queue(threadId,'[harness-supervisor] w-native-ack completed seq=714 | read worker_status for result');
 await wait(()=>requests.some(r=>r.seq714));
 evidence={result:'passed',modelPostRequests:posts,ackedPointerModelRequests:0,freshPointerReachedModel:true,queueAcceptedAt:acceptedAt,ackAt:n.ackAt,checks:readFileSync(state+'/notification-gate.jsonl','utf8').trim().split('\n').map(JSON.parse),receiptAccepted:receipt.includes('Queued message'),note:'Native TUI and codex queue; local model substitute, no paid model.'};
}catch(e){evidence.error=String(e);process.exitCode=1;}finally{evidence.modelPostRequests=posts;evidence.requests=requests;finished=true;writeFileSync(path.join(evidenceDir,'codex-ack-gate-e2e.json'),JSON.stringify(evidence,null,2));spawnSync('taskkill',['/PID',String(child.pid),'/T','/F'],{windowsHide:true});}})();
const timeout=setTimeout(()=>{evidence.error='overall timeout';spawnSync('taskkill',['/PID',String(child.pid),'/T','/F'],{windowsHide:true});},70000);
await new Promise(r=>child.on('close',r));clearTimeout(timeout);await probe;server.close();unlinkSync(profile);console.log(JSON.stringify(evidence));
