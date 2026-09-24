import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { TextDecoder } from "node:util";

/** Finite localhost checks; --live opts into at most three gpt-6-luna requests. */
const base = `http://127.0.0.1:${process.argv[2] ?? "8788"}`;
const token = (await readFile("secrets/bridge-token", "utf8")).trim();
const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
assert.equal((await fetch(base+"/health")).status,401);
const ready = await fetch(base+"/ready",{headers});
assert.equal(ready.status,200,await ready.text());
assert.equal((await fetch(base+"/health",{headers:{...headers,origin:"https://example.invalid"}})).status,403);
const models = await (await fetch(base+"/v1/models",{headers})).json();
assert(models.data.some(model=>model.id==="gpt-6-luna"));
assert.equal((await fetch(base+"/admin/api/overview")).status,401);
process.stdout.write(`Readiness, auth, models (${models.data.length}), management isolation: PASS\n`);
/** No caller tool is ever executed; a synthetic result exercises continuation only. */
async function call(body) {
  const response = await fetch(base+"/v1/chat/completions",{method:"POST",headers,body:JSON.stringify({model:"gpt-6-luna",reasoning_effort:"low",...body}),signal:AbortSignal.timeout(180000)});
  if(response.status!==200) throw new Error(`Model check failed: HTTP ${response.status}`);
  return response;
}
if(process.argv.includes("--live")) {
  const stream = await call({stream:true,messages:[{role:"user",content:"Do not use tools. Reply exactly: DOCKER_BRIDGE_OK"}]});
  let buffer="", content="", done=false, chunks=0;
  const decoder = new TextDecoder();
  for await (const bytes of stream.body) {
    buffer += decoder.decode(bytes,{stream:true});
    let boundary;
    while((boundary=buffer.indexOf("\n\n"))!==-1) {
      const frame=buffer.slice(0,boundary);buffer=buffer.slice(boundary+2);
      if(!frame.startsWith("data: "))continue;
      const data=frame.slice(6);
      if(data==="[DONE]"){done=true;continue;}
      const item=JSON.parse(data);assert(!item.error);
      for(const choice of item.choices??[])if(choice.delta?.content){content+=choice.delta.content;chunks++;}
    }
  }
  assert(done);assert.equal(content,"DOCKER_BRIDGE_OK");
  const messages=[{role:"user",content:"Call bridge_probe exactly once with marker DOCKER_TOOL_OK. After receiving its result reply exactly DOCKER_TOOL_OK. Do not use any other tools."}];
  const tools=[{type:"function",function:{name:"bridge_probe",description:"Synthetic client-owned echo tool; no side effects.",parameters:{type:"object",properties:{marker:{type:"string"}},required:["marker"],additionalProperties:false}}}];
  const first=await (await call({messages,tools})).json();
  const assistant=first.choices[0].message;
  assert.equal(assistant.tool_calls.length,1);
  const tool=assistant.tool_calls[0];assert.equal(tool.function.name,"bridge_probe");
  assert.deepEqual(JSON.parse(tool.function.arguments),{marker:"DOCKER_TOOL_OK"});
  const last=await (await call({tools,messages:[...messages,assistant,{role:"tool",tool_call_id:tool.id,content:"DOCKER_TOOL_OK"}]})).json();
  assert.equal(last.choices[0].message.content,"DOCKER_TOOL_OK");
  process.stdout.write(`Live SSE (${chunks} chunks) and client-tool continuation: PASS (3 requests)\n`);
}
