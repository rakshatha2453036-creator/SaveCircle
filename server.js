import 'dotenv/config';
import express from 'express';
import crypto from 'crypto';
import fs from 'fs';

const app = express();
app.use(express.json());
app.use(express.static('public'));

const PP = 'https://api-m.sandbox.paypal.com';
const MAX_POT = Number(process.env.MAX_POT || 2000);
const FILE = 'data.json';

// ======= EDIT THESE 4 EMAILS: paste your 4 sandbox PERSONAL emails =======
const SEED = {
  name: 'Coimbatore Friends Circle', amount: 100, currency: 'USD',
  members: [
  { name: 'Priya',   email: 'sb-7nrnn53833181@personal.example.com', onTime: 11, late: 1, missed: 0 },
  { name: 'Arun',    email: 'sb-augp153833163@personal.example.com', onTime: 6,  late: 5, missed: 1 },
  { name: 'Meena',   email: 'sb-lr59j53833177@personal.example.com', onTime: 12, late: 0, missed: 0 },
  { name: 'Karthik', email: 'sb-43ujtb53833473@personal.example.com', onTime: 2,  late: 2, missed: 2 },
],
};
// =========================================================================

// ---------- state ----------
function newCircle(cfg) {
  return {
    name: cfg.name, amount: Number(cfg.amount), currency: cfg.currency || 'USD',
    members: cfg.members.map((m, i) => ({ id: 'm' + (i + 1), name: m.name, email: m.email,
      onTime: m.onTime || 0, late: m.late || 0, missed: m.missed || 0 })),
    order: null, seed: null, round: 0, rounds: [], audit: [],
  };
}
let C = fs.existsSync(FILE) ? JSON.parse(fs.readFileSync(FILE, 'utf8')) : newCircle(SEED);
const save = () => fs.writeFileSync(FILE, JSON.stringify(C, null, 2));
const audit = (msg) => { C.audit.push({ t: new Date().toISOString(), msg }); save(); };
const member = (id) => C.members.find((m) => m.id === id);

// Bayesian risk: prior = 8 good / 2 bad payments ("assume 80% reliable until proven otherwise").
// bad = late + 2*missed. Few payments => score stays near the prior, and confidence is "low".
function risk(m) {
  const bad = m.late + 2 * m.missed, good = m.onTime;
  return Math.round((100 * (2 + bad)) / (10 + good + bad));
}
function confidence(m) {
  const n = m.onTime + m.late + m.missed;
  return n < 4 ? 'low' : n < 10 ? 'medium' : 'high';
}

// ---------- PayPal ----------
let tok = { v: null, exp: 0 };
async function token() {
  if (tok.v && Date.now() < tok.exp) return tok.v;
  const basic = Buffer.from(`${process.env.PAYPAL_CLIENT_ID}:${process.env.PAYPAL_SECRET}`).toString('base64');
  const r = await fetch(`${PP}/v1/oauth2/token`, { method: 'POST',
    headers: { Authorization: `Basic ${basic}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=client_credentials' });
  const j = await r.json();
  if (!r.ok) throw new Error('PayPal auth failed: ' + JSON.stringify(j));
  tok = { v: j.access_token, exp: Date.now() + (j.expires_in - 60) * 1000 };
  return tok.v;
}
async function pp(path, method = 'GET', body) {
  const r = await fetch(PP + path, { method,
    headers: { Authorization: `Bearer ${await token()}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined });
  const t = await r.text();
  let j = {}; try { j = t ? JSON.parse(t) : {}; } catch { j = { raw: t }; }
  if (!r.ok) throw new Error(j.message || j.error_description || JSON.stringify(j));
  return j;
}

// ---------- circle logic ----------
function rng(seed) {
  let a = parseInt(crypto.createHash('sha256').update(seed).digest('hex').slice(0, 8), 16);
  return () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const started = () => C.rounds.length > 0;

function draw() {
  if (started()) throw new Error('Order is locked once collection has started.');
  const seed = crypto.randomBytes(8).toString('hex');
  const r = rng(seed); const ids = C.members.map((m) => m.id);
  for (let i = ids.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [ids[i], ids[j]] = [ids[j], ids[i]]; }
  C.order = ids; C.seed = seed;
  audit(`Payout order drawn with public seed ${seed} (SHA-256 seeded shuffle, not AI): ${ids.map((i) => member(i).name).join(' -> ')}`);
}

async function refresh() {
  const r = C.rounds[C.round]; if (!r) return;
  for (const inv of Object.values(r.invoices)) {
    if (inv.status === 'PAID') continue;
    try { inv.status = (await pp(`/v2/invoicing/invoices/${inv.id}`)).status; } catch {}
  }
  save();
}

async function collect() {
  if (!C.order) throw new Error('Draw the payout order first.');
  if (C.round >= C.members.length) throw new Error('Circle is complete.');
  if (C.rounds[C.round]) throw new Error('This round was already collected.');
  const pot = C.amount * C.members.length;
  if (pot > MAX_POT) throw new Error(`Blocked by guardrail: pot ${pot} exceeds cap ${MAX_POT}.`);
  const due = new Date(Date.now() + 7 * 864e5).toISOString().slice(0, 10);
  const r = { winner: C.order[C.round], invoices: {}, paidOut: false };
  for (const m of C.members) {
    const n = await pp('/v2/invoicing/generate-next-invoice-number', 'POST');
    const c = await pp('/v2/invoicing/invoices', 'POST', {
      detail: { invoice_number: n.invoice_number, currency_code: C.currency,
        note: `${C.name}: contribution for round ${C.round + 1}`,
        payment_term: { term_type: 'DUE_ON_DATE_SPECIFIED', due_date: due } },
      primary_recipients: [{ billing_info: { name: { given_name: m.name }, email_address: m.email } }],
      items: [{ name: `${C.name} - Round ${C.round + 1}`, quantity: '1',
        unit_amount: { currency_code: C.currency, value: C.amount.toFixed(2) } }],
    });
    const id = c.href.split('/').pop();
    await pp(`/v2/invoicing/invoices/${id}/send`, 'POST', { send_to_recipient: true, send_to_invoicer: false });
    r.invoices[m.id] = { id, status: 'SENT' };
  }
  C.rounds[C.round] = r;
  audit(`Round ${C.round + 1}: ${C.members.length} PayPal invoices of ${C.currency} ${C.amount} sent. Winner this round: ${member(r.winner).name}`);
}

async function markPaid(mid) { // DEMO shortcut: records a payment on the invoice
  const inv = C.rounds[C.round]?.invoices[mid];
  if (!inv) throw new Error('No invoice for this member yet.');
  await pp(`/v2/invoicing/invoices/${inv.id}/payments`, 'POST', { method: 'CASH',
    payment_date: new Date().toISOString().slice(0, 10),
    amount: { currency_code: C.currency, value: C.amount.toFixed(2) } });
  inv.status = 'PAID'; audit(`${member(mid).name}'s contribution recorded as paid`);
}

async function payout() {
  await refresh();
  const r = C.rounds[C.round];
  if (!r) throw new Error('Collect this round first.');
  if (r.paidOut) throw new Error('Already paid out.');
  const unpaid = Object.values(r.invoices).filter((i) => i.status !== 'PAID').length;
  if (unpaid) throw new Error(`Blocked by guardrail: ${unpaid} contribution(s) still unpaid.`);
  const w = member(r.winner); const pot = C.amount * C.members.length;
  if (pot > MAX_POT) throw new Error('Blocked by guardrail: pot exceeds cap.');
  const j = await pp('/v1/payments/payouts', 'POST', {
    sender_batch_header: { sender_batch_id: `sc-${C.seed}-${C.round}-${Date.now()}`, email_subject: `You received the ${C.name} pot!` },
    items: [{ recipient_type: 'EMAIL', amount: { value: pot.toFixed(2), currency: C.currency }, receiver: w.email,
      note: `Round ${C.round + 1} pot`, sender_item_id: `round-${C.round + 1}` }],
  });
  r.paidOut = true; r.batch = j.batch_header.payout_batch_id;
  C.members.forEach((m) => { m.onTime++; });
  audit(`PAYOUT: ${C.currency} ${pot} sent to ${w.name} via PayPal Payouts (batch ${r.batch})`);
  C.round++; save();
}

function view() {
  const r = C.rounds[C.round];
  return { name: C.name, amount: C.amount, currency: C.currency, round: Math.min(C.round + 1, C.members.length),
    total: C.members.length, seed: C.seed, collected: !!r,
    winner: r ? member(r.winner).name : (C.order ? member(C.order[C.round])?.name : null),
    complete: C.round >= C.members.length, audit: C.audit.slice(-12).reverse(),
    members: C.members.map((m) => ({ id: m.id, name: m.name, email: m.email, risk: risk(m), confidence: confidence(m),
      turn: C.order ? C.order.indexOf(m.id) + 1 : null,
      status: r ? r.invoices[m.id]?.status : '-', history: `${m.onTime} on time / ${m.late} late / ${m.missed} missed` })) };
}

// ---------- AI treasurer (Groq, OpenAI-compatible API) ----------
const fn = (name, description, properties = {}, required = []) => ({
  type: 'function',
  function: { name, description, parameters: { type: 'object', properties, required } },
});
const tools = [
  fn('get_circle', 'Get the circle: members (with ids), payment history, Bayesian risk score (0-100, higher = riskier) with confidence, payout order, current round status.'),
  fn('create_circle', "Create/replace the savings circle from the organizer's description. Needs name, contribution amount and every member name+email.", {
    name: { type: 'string' }, amount: { type: 'number' }, currency: { type: 'string' },
    members: { type: 'array', items: { type: 'object', properties: { name: { type: 'string' }, email: { type: 'string' } }, required: ['name', 'email'] } },
  }, ['name', 'amount', 'members']),
  fn('propose_order', 'Propose a risk-aware payout order (most reliable members first, riskiest last, so a late payer cannot take the pot early and then stop paying). Does NOT apply it. Use member ids like m1, m2.', {
    order: { type: 'array', items: { type: 'string' } }, reasoning: { type: 'string' },
  }, ['order', 'reasoning']),
  fn('propose_message', 'Draft a kind, clear message to one member (reminder, grace plan, or mediation) in the language they use. Does NOT send.', {
    member_id: { type: 'string' }, message: { type: 'string' },
  }, ['member_id', 'message']),
];
const SYSTEM = `You are SaveCircle, an AI treasurer for community savings circles (chit funds, committees, tandas, susus).
You NEVER move money and never say money was sent: you propose, the organizer approves with a button. Payout order randomness is handled by a seeded draw, not by you; you only explain it or propose a risk-aware alternative.
Risk scores come from a Bayesian reliability model (prior 8 on-time / 2 bad); explain them and mention confidence when it is low.
Call get_circle before answering questions about members, risk or status. Refer to members by name. Be brief and kind. Reply in the language the organizer uses.`;

async function llm(messages) {
  const r = await fetch(`${process.env.AI_BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.AI_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: process.env.AI_MODEL, messages, tools, tool_choice: 'auto', max_tokens: 1200 }),
  });
  const j = await r.json();
  if (!r.ok) throw new Error('AI error: ' + JSON.stringify(j).slice(0, 400));
  return j.choices[0].message;
}

app.post('/api/chat', async (req, res) => {
  try {
    const msgs = [{ role: 'system', content: SYSTEM }, ...req.body.messages.map((m) => ({ role: m.role, content: m.content }))];
    const proposals = [];
    for (let i = 0; i < 6; i++) {
      const m = await llm(msgs);
      if (!m.tool_calls?.length) return res.json({ reply: m.content || 'Done.', proposals });
      // keep only the fields Groq accepts back
      msgs.push({ role: 'assistant', content: m.content || '', tool_calls: m.tool_calls });
      for (const c of m.tool_calls) {
        let input = {};
        try { input = JSON.parse(c.function.arguments || '{}'); } catch {}
        let out;
        if (c.function.name === 'get_circle') out = view();
        else if (c.function.name === 'create_circle') { C = newCircle(input); audit('Circle created by AI from organizer instructions'); out = 'Circle created.'; }
        else {
          proposals.push({ kind: c.function.name, ...input,
            orderNames: input.order?.map((id) => member(id)?.name || id),
            memberName: member(input.member_id)?.name });
          out = 'Shown to organizer for approval. Not applied yet.';
        }
        msgs.push({ role: 'tool', tool_call_id: c.id, content: JSON.stringify(out) });
      }
    }
    res.json({ reply: 'Done.', proposals });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/approve', async (req, res) => {
  try {
    const p = req.body;
    if (p.kind === 'propose_order') {
      if (started()) throw new Error('Order is locked once collection has started.');
      const ok = Array.isArray(p.order) && p.order.length === C.members.length && C.members.every((m) => p.order.includes(m.id));
      if (!ok) throw new Error('Invalid order proposal.');
      C.order = p.order; C.seed = 'ai-' + crypto.randomBytes(4).toString('hex');
      audit(`AI risk-aware order approved by organizer: ${p.order.map((i) => member(i).name).join(' -> ')}. Reason: ${p.reasoning}`);
    } else {
      const inv = C.rounds[C.round]?.invoices[p.member_id];
      let sent = false;
      if (inv && inv.status !== 'PAID') {
        await pp(`/v2/invoicing/invoices/${inv.id}/remind`, 'POST', { subject: `A note from ${C.name}`, note: p.message.slice(0, 3900), send_to_invoicer: false });
        sent = true;
      }
      audit(`Message to ${member(p.member_id)?.name} approved${sent ? ' and sent via PayPal invoice reminder' : ' (logged; no open invoice)'}: "${p.message}"`);
    }
    res.json({ ok: true });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

const wrap = (fn) => async (req, res) => { try { await fn(req); await refresh(); res.json(view()); } catch (e) { res.status(400).json({ error: e.message }); } };
app.get('/api/circle', wrap(async () => {}));
app.post('/api/draw', wrap(async () => draw()));
app.post('/api/collect', wrap(collect));
app.post('/api/markpaid/:id', wrap((req) => markPaid(req.params.id)));
app.post('/api/payout', wrap(payout));
app.post('/api/reset', wrap(async () => { C = newCircle(SEED); save(); }));

app.listen(process.env.PORT || 3000, () => console.log('SaveCircle running on port ' + (process.env.PORT || 3000)));