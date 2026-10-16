// Local end-to-end: CAP stock service (mocked auth) + this agent + real LLM. Checks answers AND the audit trail.
const { spawn } = require('node:child_process'), fs = require('node:fs'), assert = require('node:assert')
const env = Object.fromEntries(fs.readFileSync(process.env.HOME + '/deepseek-dev/.env', 'utf8').split('\n').filter(l => /^\w+=/.test(l)).map(l => [l.split('=')[0], l.slice(l.indexOf('=') + 1).trim().replace(/^["']|["']$/g, '')]))
const CAP = process.env.HOME + '/Projects/sap-gov-sandbox'
const kids = []
const start = (cmd, args, opts) => { const p = spawn(cmd, args, { stdio: 'ignore', detached: true, ...opts }); kids.push(p); return p }
const up = async url => { for (let i = 0; i < 60; i++) { try { await fetch(url); return } catch { await new Promise(r => setTimeout(r, 500)) } } throw new Error('not up ' + url) }
const basic = (u, p) => 'Basic ' + Buffer.from(u + ':' + p).toString('base64')

;(async () => {
  start('npx', ['cds-serve', '--port', '4731'], { cwd: CAP, env: { ...process.env, NODE_ENV: 'development' } })
  start('node', ['server.js'], { cwd: __dirname + '/..', env: { ...process.env, PORT: '4732', STOCK_BASE: 'http://localhost:4731/stock', STOCK_BASIC: 'agent:agent',
    ACCESS_USER: 'tester', ACCESS_PASSWORD: 'local-test-only', LLM_API_KEY: env.ANTHROPIC_AUTH_TOKEN } })
  await up('http://localhost:4731/stock/'); await up('http://localhost:4732/')
  try {
    assert.strictEqual((await fetch('http://localhost:4732/api/chat', { method: 'POST' })).status, 401, 'chat page is gated')
    const H = { 'Content-Type': 'application/json', Authorization: basic('tester', 'local-test-only') }
    const ask = async (text, cid) => (await fetch('http://localhost:4732/api/chat', { method: 'POST', headers: H, body: JSON.stringify({ messages: [{ role: 'user', content: text }], conversationId: cid }) })).json()

    const a = await ask('Is order 1000001 ready to proceed? Which material is short and by how much?', 'audit-demo-1')
    console.log('REPLY1:', a.reply.replace(/\n+/g, ' ').slice(0, 400)); console.log('TOOLS1:', a.trace.map(t => t.tool + ':' + t.status).join(', '))
    assert.ok(a.trace.some(t => t.tool === 'validate_order_stock' && t.status === 200), 'used the governed validation tool')
    assert.ok(/42/.test(a.reply) && /1\.2/.test(a.reply), 'reply names material 42 short by 1.2')
    assert.ok(!/41[^.]{0,60}short by 1\.2/i.test(a.reply), 'does NOT blame material 41')

    const b = await ask('Check order 999999', 'audit-demo-2')
    console.log('REPLY2:', b.reply.replace(/\n+/g, ' ').slice(0, 250)); console.log('TOOLS2:', b.trace.map(t => t.tool + ':' + t.status).join(', '))
    assert.ok(b.trace.some(t => t.status === 404), 'not-found surfaced from the service')

    await new Promise(r => setTimeout(r, 600))
    const rows = (await (await fetch('http://localhost:4731/stock/AuditLog?$orderby=timestamp', { headers: { Authorization: basic('auditor', 'auditor') } })).json()).value
    const mine = rows.filter(r => /^conv-audit-demo-/.test(r.correlationID))
    console.log('AUDIT rows for these conversations:\n' + mine.map(r => `  ${r.correlationID} | ${r.tool} | ${r.outcome}/${r.httpStatus}`).join('\n'))
    assert.ok(mine.some(r => r.correlationID === 'conv-audit-demo-1' && r.tool === 'validateOrderStock' && r.outcome === 'OK'), 'conversation 1 audited')
    assert.ok(mine.some(r => r.correlationID === 'conv-audit-demo-2' && r.outcome === 'ERROR' && r.httpStatus === 404), 'conversation 2 not-found audited')
    console.log('OK - agent answers from the governed service and every call is audited under its conversation id')
  } finally { for (const p of kids) try { process.kill(-p.pid) } catch {} }
  process.exit(0)
})().catch(e => { console.error(e); for (const p of kids) try { process.kill(-p.pid) } catch {}; process.exit(1) })
