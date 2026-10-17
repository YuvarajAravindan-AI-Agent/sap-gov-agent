const express = require('express')
const crypto = require('node:crypto')

const PORT = process.env.PORT || 8080
const LLM_BASE = process.env.LLM_BASE_URL || 'https://api.deepseek.com'
const LLM_MODEL = process.env.LLM_MODEL || 'deepseek-chat'
const LLM_KEY = process.env.LLM_API_KEY
const DEST = process.env.STOCK_DEST || 'GovStockService'
const MAX_STEPS = 6

// ---- Access control for the chat page itself (the stock service has its own XSUAA) ----
const USER = process.env.ACCESS_USER, PASS = process.env.ACCESS_PASSWORD
const safeEq = (a, b) => { const x = Buffer.from(a), y = Buffer.from(b); return x.length === y.length && crypto.timingSafeEqual(x, y) }
function gate(req, res, next) {
  if (!USER || !PASS) return res.status(503).send('ACCESS_USER / ACCESS_PASSWORD not configured')
  const m = /^Basic (.+)$/.exec(req.headers.authorization || '')
  const [u = '', p = ''] = m ? Buffer.from(m[1], 'base64').toString().split(/:(.*)/s) : []
  if (m && safeEq(u, USER) && safeEq(p, PASS)) return next()
  res.set('WWW-Authenticate', 'Basic realm="Governed stock agent"').status(401).send('Authentication required')
}

// ---- Where the stock service lives: BTP destination on CF, or a direct URL for local testing ----
let destCache
async function stockTarget() {
  if (process.env.STOCK_BASE) {
    const h = process.env.STOCK_BASIC ? { Authorization: 'Basic ' + Buffer.from(process.env.STOCK_BASIC).toString('base64') } : {}
    return { base: process.env.STOCK_BASE, headers: h }
  }
  if (destCache && destCache.exp > Date.now()) return destCache.v
  const c = JSON.parse(process.env.VCAP_SERVICES).destination[0].credentials
  const t = await fetch(c.url + '/oauth/token', { method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Authorization: 'Basic ' + Buffer.from(`${c.clientid}:${c.clientsecret}`).toString('base64') },
    body: 'grant_type=client_credentials' })
  const token = (await t.json()).access_token
  const r = await fetch(`${c.uri}/destination-configuration/v1/destinations/${DEST}`, { headers: { Authorization: 'Bearer ' + token } })
  if (!r.ok) throw new Error(`destination ${DEST} lookup failed (${r.status})`)
  const d = await r.json()
  const auth = (d.authTokens || [])[0]
  if (!auth || auth.error) throw new Error(`destination ${DEST}: no usable token (${auth && auth.error})`)
  const v = { base: d.destinationConfiguration.URL, headers: { Authorization: auth.http_header.value } }
  destCache = { v, exp: Date.now() + 4 * 60 * 1000 }
  return v
}

// ---- Tools: thin wrappers over the six governed functions. No arithmetic happens in the model or here. ----
const TOOLS = {
  get_maintenance_order:     { fn: 'getMaintenanceOrderDetails', arg: 'orderID',     desc: 'Header data of a maintenance order.' },
  get_order_operations:      { fn: 'getOrderOperations',         arg: 'orderID',     desc: 'List the operations of a maintenance order.' },
  get_operation_components:  { fn: 'getOperationComponents',     arg: 'operationID', desc: 'List the components (material, required quantity) of one operation.' },
  get_material_details:      { fn: 'getMaterialDetails',         arg: 'materialID',  desc: 'Material master data including total stockLevel across locations.' },
  get_material_stock_levels: { fn: 'getMaterialStockLevels',     arg: 'materialID',  desc: 'Stock per plant and storage location for a material.' },
  validate_order_stock:      { fn: 'validateOrderStock',         arg: 'orderID',     desc: 'Authoritative stock check for a whole order: per component required, available, status and shortBy, computed in code. Use this for any "is the order ready / is there enough stock" question.' }
}
const toolSpecs = Object.entries(TOOLS).map(([name, t]) => ({ type: 'function', function: {
  name, description: t.desc, parameters: { type: 'object', properties: { [t.arg]: { type: 'integer' } }, required: [t.arg] } } }))

async function runTool(name, args, cid) {
  const t = TOOLS[name]
  if (!t) return { status: 400, result: { error: `unknown tool ${name}` } }
  const id = Number(args[t.arg])
  if (!Number.isInteger(id)) return { status: 400, result: { error: `${t.arg} must be an integer` } }
  const { base, headers } = await stockTarget()
  const r = await fetch(`${base}/${t.fn}(${t.arg}=${id})`, { headers: { ...headers, 'x-correlation-id': cid, 'x-end-user': USER || 'anonymous' } })
  const body = await r.json().catch(() => ({}))
  if (!r.ok) return { status: r.status, result: { error: body.error?.message || `HTTP ${r.status}` } }
  return { status: r.status, result: typeof body.value === 'string' ? JSON.parse(body.value) : body }
}

const SYSTEM = `You are a maintenance stock validation assistant for SAP maintenance orders.
Rules:
- Every quantity, stock level and shortage you state MUST come from a tool result in this conversation. Never estimate, round or compute quantities yourself.
- For "is order N ready / enough stock / any shortage" questions call validate_order_stock and report required, available and shortBy exactly as returned, per material.
- If a tool returns an error (for example not found or forbidden), say so plainly and do not guess.
- If a result has reconciliation.status MISMATCH, say that the figures disagree with the system of record and name the materials and both numbers from reconciliation.mismatches. If it is UNAVAILABLE, say the check against the system of record could not be done. If it is MATCH, you may add that the figures were confirmed against the system of record.
- Reply in plain text only: no Markdown, no asterisks. Be concise. Name the material IDs. If everything is sufficient, say so.`

async function chat(messages, cid) {
  const trace = []
  const convo = [{ role: 'system', content: SYSTEM }, ...messages]
  for (let step = 0; step < MAX_STEPS; step++) {
    const r = await fetch(LLM_BASE + '/chat/completions', { method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + LLM_KEY },
      body: JSON.stringify({ model: LLM_MODEL, messages: convo, tools: toolSpecs, temperature: 0 }) })
    if (!r.ok) throw new Error(`LLM HTTP ${r.status}`)
    const msg = (await r.json()).choices[0].message
    convo.push(msg)
    if (!msg.tool_calls?.length) return { reply: msg.content, trace }
    for (const tc of msg.tool_calls) {
      let args = {}; try { args = JSON.parse(tc.function.arguments || '{}') } catch {}
      let out; try { out = await runTool(tc.function.name, args, cid) } catch (e) { out = { status: 502, result: { error: e.message } } }
      trace.push({ tool: tc.function.name, args, status: out.status, result: out.result })
      convo.push({ role: 'tool', tool_call_id: tc.id, content: JSON.stringify(out.result) })
    }
  }
  return { reply: 'I could not finish within the allowed number of tool steps.', trace }
}

const app = express()
app.use(express.json({ limit: '100kb' }))
app.use(gate)
app.use(express.static(__dirname + '/public'))
app.post('/api/chat', async (req, res) => {
  try {
    if (!LLM_KEY) throw new Error('LLM_API_KEY not configured')
    const raw = String(req.body.conversationId || crypto.randomUUID()).replace(/[^\w-]/g, '')
    const cid = 'conv-' + raw.replace(/^(conv-)+/, '').slice(0, 40)
    const messages = (req.body.messages || []).filter(m => ['user', 'assistant'].includes(m.role)).slice(-20)
    res.json({ conversationId: cid, ...(await chat(messages, cid)) })
  } catch (e) { res.status(500).json({ error: e.message }) }
})
app.listen(PORT, () => console.log('agent listening on', PORT))
