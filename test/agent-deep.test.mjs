import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, chmodSync, existsSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { AgentChatModel, agentContext } from '../dist/ai/llm/agent.js';
import { requestEnv } from '../dist/search/client.js';

function fixture(t, agent, text = 'fixture analysis') {
    const dir = mkdtempSync(join(tmpdir(), 'grafly-agent-test-'));
    t.after(() => { assert.ok(resolve(dir).startsWith(resolve(tmpdir()) + sep)); rmSync(dir, { recursive: true, force: true }); });
    const entry = join(dir, 'node_modules', agent === 'codex' ? '@openai/codex/bin/codex.js' : '@anthropic-ai/claude-code/cli.js');
    mkdirSync(resolve(entry, '..'), { recursive: true });
    const script = `const fs = require('node:fs');
let prompt=''; process.stdin.setEncoding('utf8'); process.stdin.on('data', d=>prompt+=d);
process.stdin.on('end',()=>{
 const args=process.argv.slice(2);
 fs.appendFileSync(process.env.FAKE_CAPTURE+'.calls', '1\\n');
 fs.writeFileSync(process.env.FAKE_CAPTURE, JSON.stringify({args,prompt,cwd:process.cwd(),codexHome:process.env.CODEX_HOME,claudeHome:process.env.CLAUDE_CONFIG_DIR,marker:process.env.CLAUDECODE}));
 if(process.env.FAKE_FAIL) {console.error('401 authentication required'); process.exitCode=1; return;}
 const output=args.indexOf('--output-last-message');
 if(output>=0) {fs.writeFileSync(args[output+1], process.env.FAKE_TEXT); console.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:12,output_tokens:3}}));}
 else {
  const body=Buffer.from(JSON.stringify({subtype:'success',is_error:false,result:process.env.FAKE_TEXT,usage:{input_tokens:12,output_tokens:3}}));
  if(process.env.FAKE_SPLIT) {const at=body.indexOf(Buffer.from('한글'))+1;process.stdout.write(body.subarray(0,at));setTimeout(()=>process.stdout.write(body.subarray(at)),20);}
  else process.stdout.write(body);
 }
});`;
    writeFileSync(entry, script);
    writeFileSync(join(dir, `${agent}.cmd`), '@rem fixture resolved through npm entry');
    writeFileSync(join(dir, agent), `#!${process.execPath}\n${script}`);
    chmodSync(join(dir, agent), 0o755);
    const home = join(dir, 'profile'); mkdirSync(home);
    writeFileSync(join(home, 'models_cache.json'), JSON.stringify({ models: [
        { slug: 'gpt-6.1-terra', visibility: 'list' }, { slug: 'gpt-7-luna', visibility: 'hide' }, { slug: 'gpt-6-luna', visibility: 'list' },
    ] }));
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toUpperCase() !== 'PATH'));
    Object.assign(env, { PATH: dir, FAKE_CAPTURE: join(dir, 'capture.json'), FAKE_TEXT: text, CLAUDECODE: '1' });
    return { dir, home, env, context: { agent, home }, capture: () => JSON.parse(readFileSync(env.FAKE_CAPTURE, 'utf8')) };
}

for (const agent of ['codex', 'claude']) test(`${agent} uses a hidden noninteractive CLI with its profile and lightweight model`, async t => {
    const f = fixture(t, agent, '{"symbols":[{"id":"a","summary":"Checks inputs."}]}');
    const model = new AgentChatModel(f.context, f.env);
    const response = await model.create({ messages: [{ role: 'user', content: 'source excerpt' }],
        responseFormat: { kind: 'tool', name: 'record' }, tools: [{ name: 'record', description: 'Record', parameters: { type: 'object' } }] });
    assert.equal(response.toolCalls[0].args.symbols[0].id, 'a');
    assert.equal(response.usage.output, 3);
    const call = f.capture();
    assert.equal(call.args[call.args.indexOf('--model') + 1], agent === 'codex' ? 'gpt-6-luna' : 'haiku');
    assert.equal(agent === 'codex' ? call.codexHome : call.claudeHome, f.home);
    assert.equal(call.marker, undefined);
    assert.ok(call.prompt.includes('source excerpt'));
    assert.equal(existsSync(call.cwd), false, 'temporary prompt/output directory removed');
    if (agent === 'codex') {
        assert.ok(call.args.includes('--ephemeral'));
        assert.ok(call.args.includes('features.shell_tool=false'));
        for (const feature of ['apps', 'plugins', 'image_generation', 'skill_search'])
            assert.ok(call.args.includes(`features.${feature}=false`), `${feature} must be unavailable during source analysis`);
        assert.equal(call.args[call.args.indexOf('--sandbox') + 1], 'read-only');
    } else {
        assert.equal(call.args[call.args.indexOf('--tools') + 1], '');
        assert.ok(call.args.includes('--no-session-persistence'));
        assert.ok(call.args.includes('{"fallbackModel":[]}'));
    }
});

test('failed and malformed CLI responses fail explicitly without changing agent or model', async t => {
    const f = fixture(t, 'codex'); f.env.FAKE_FAIL = '1';
    await assert.rejects(new AgentChatModel(f.context, f.env).create({ messages: [] }), /401 authentication/);
    assert.equal(existsSync(f.capture().cwd), false);
    delete f.env.FAKE_FAIL;
    await assert.rejects(new AgentChatModel(f.context, f.env).create({ messages: [], responseFormat: { kind: 'tool', name: 'record' }, tools: [{ name: 'record', parameters: {} }] }), SyntaxError);
});

test('UTF-8 analysis survives CLI output split inside a multibyte character', async t => {
    const f = fixture(t, 'claude', '한글 요약'); f.env.FAKE_SPLIT = '1';
    assert.equal((await new AgentChatModel(f.context, f.env).create({ messages: [] })).text, '한글 요약');
});

test('active host selection and resident requests retain the caller configuration scope', () => {
    assert.equal(agentContext(undefined, {}), null);
    assert.deepEqual(agentContext(undefined, { CODEX_THREAD_ID: 'thread', CODEX_HOME: '/profile' }), { agent: 'codex', home: '/profile' });
    assert.equal(agentContext(undefined, { CLAUDECODE: '1', CODEX_THREAD_ID: 'parent' }).agent, 'claude');
    for (const key of ['CODEX_HOME', 'CODEX_THREAD_ID', 'CLAUDECODE', 'CLAUDE_CONFIG_DIR']) assert.ok(requestEnv.test(key), key);
    assert.equal(requestEnv.test('CODEX_ACCESS_TOKEN'), false);
    assert.throws(() => agentContext('unknown'), /supports/);
});

test('authentication failure stops Deep after one CLI request and preserves structural retrieval', t => {
    const f = fixture(t, 'codex'); f.env.FAKE_FAIL = '1';
    const root = join(f.dir, 'project'); mkdirSync(join(root, '.git'), { recursive: true });
    for (const file of ['one.js', 'two.js']) writeFileSync(join(root, file), 'export function classify(value) {\n if (value > 10) return "large";\n return "small";\n}\n');
    const script = `import {buildDeepProject} from ${JSON.stringify(new URL('../dist/hosts/auto-deep.js', import.meta.url).href)};
const result=await buildDeepProject(${JSON.stringify(root)},${JSON.stringify({ transport: 'agent', agentContext: f.context, concurrency: 1 })});
console.log(JSON.stringify(result));`;
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], { env: f.env, encoding: 'utf8', windowsHide: true, timeout: 30000 });
    assert.ifError(result.error); assert.equal(result.status, 0, result.stderr);
    const state = JSON.parse(result.stdout.trim());
    assert.equal(state.status, 'incomplete');
    assert.ok(state.fatal, JSON.stringify(state));
    assert.equal(readFileSync(f.env.FAKE_CAPTURE + '.calls', 'utf8').trim().split('\n').length, 1);
    assert.ok(existsSync(join(root, '.grafly/.graph/wiring.json')));
});
