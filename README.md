# SaveCircle

AI treasurer for community savings circles (chit funds, committees, tandas, susus), powered by PayPal.

**Live demo:** https://savecircle-6zmp.onrender.com (free tier: first load may take ~60 seconds)
**Demo video:** https://youtu.be/VloMVEXJ8ck?si=HIaMAsXu008e7z0y

## Problem
Hundreds of millions of people save through rotating savings circles that run on WhatsApp groups, notebooks and cash. Late payers, disputes, and organizer fraud are common, and one default can collapse the circle.

## Solution
SaveCircle runs a circle end to end: it collects contributions with PayPal invoices, draws the payout order transparently, scores each member's reliability, lets an AI propose fairer orders and kind reminders, and releases the pot only when everyone has paid.

## How PayPal is used
- **Invoicing API v2:** creates and sends one invoice per member per round; reminders; payment status tracking
- **Payouts API:** pays the pot to that round's winner
- OAuth client-credentials in the PayPal **sandbox**

## How AI is used
- Model: `openai/gpt-oss-120b` via Groq (OpenAI-compatible API) with tool calling
- The AI reads circle data, explains risk, proposes a risk-aware payout order, and drafts multilingual messages
- The AI **never moves money**: it only proposes, and the organizer approves

## Risk model
Bayesian reliability score with a prior of 8 on-time / 2 bad payments (late = 1, missed = 2). New members stay near the prior, and a confidence label (low / medium / high) shows how much history backs each score.

## Safety guardrails
- Human approval for every AI proposal
- Payout blocked until all contributions are paid
- Pot cap (`MAX_POT`)
- Transparent seeded draw (SHA-256 seeded shuffle, not AI), seed shown in the audit log
- Order locked once collection starts
- Full audit log

## Run it yourself
1. Create a PayPal sandbox app (Invoicing and Payouts enabled) under a **US Business** sandbox account, plus 4 **US Personal** sandbox accounts.
2. Put the 4 Personal emails in the `SEED` block of `server.js`.
3. Create `.env`:
