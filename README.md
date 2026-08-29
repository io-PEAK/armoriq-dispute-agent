<div align="center">

<img src="public/favicon.png" alt="ArmorIQ Dispute Agent" width="80" />

<h1>ArmorIQ Dispute Resolution Agent</h1>

<p>
  <b>Autonomous dispute refunds, gated by cryptographic policy, not code.</b><br />
  An AI agent that reads disputed transactions from a Postgres DB and issues real Razorpay refunds. Refunds below ₹2,000 execute autonomously. Refunds of ₹2,000+ are held for human approval via ArmorIQ.
</p>

<br />

[![Node.js](https://img.shields.io/badge/Node.js-25-339933?style=for-the-badge&logo=node.js&logoColor=white)](https://nodejs.org)
[![Prisma](https://img.shields.io/badge/Prisma-6-2D3748?style=for-the-badge&logo=prisma&logoColor=white)](https://prisma.io)
[![Razorpay](https://img.shields.io/badge/Razorpay-Test-07263F?style=for-the-badge&logo=razorpay&logoColor=white)](https://razorpay.com)
[![ArmorIQ](https://img.shields.io/badge/ArmorIQ-SDK-FF6B35?style=for-the-badge)](https://armoriq.ai)
[![MCP](https://img.shields.io/badge/MCP-Protocol-8B5CF6?style=for-the-badge)](https://modelcontextprotocol.io)
[![Vercel](https://img.shields.io/badge/Vercel-Deploy-000000?style=for-the-badge&logo=vercel&logoColor=white)](https://vercel.com)

</div>

---

## What This Does

A marketplace gets dispute requests: buyers claim items never arrived or weren't as described. An agent automatically refunds them. But what if the refund is ₹4,538 instead of ₹899? The same code path handles both. There's no resistance.

ArmorIQ fixes this. A cryptographic policy layer sits between the agent and the MCP server:

- **Refunds below ₹2,000** → execute autonomously (no human needed)
- **Refunds ≥ ₹2,000** → held for human approval on ArmorIQ dashboard

The **hold side** (≥ ₹2,000) is enforced cryptographically by ArmorIQ: the agent captures a plan, gets an intent token bound to a Merkle-sealed plan, and invokes through the proxy. The proxy re-verifies the sealed plan at execution time, so the agent cannot quietly change the amount after approval or skip the hold. The **allow side** (< ₹2,000) is evaluated locally in the agent so small refunds don't need to round-trip through the proxy — this is a pragmatic fast-path while ArmorIQ's policy engine doesn't yet support amount as a condition field.

### Live Demo

**Frontend UI (primary):** https://armoriq-dispute-agent.zopcloud.zop.dev
**Frontend UI (mirror):** https://armoriq-dispute-agent.vercel.app
**MCP Server:** https://armoriq-dispute-agent.vercel.app/api/index
**Agent API:** https://armoriq-dispute-agent.vercel.app/api/agent
**LLM Agent:** https://armoriq-dispute-agent.vercel.app/api/v1/chat

> Deployed on Zop.dev (sponsor platform) and Vercel. The Zop.dev instance serves the full app on an Express server; Vercel runs the same handlers as serverless functions.

---

## The Problem

Phase 1 of this project proved the danger: an unguarded agent refunded ₹257.82 and ₹3,599.19 identically. Same code. Same speed. No resistance. The agent's code doesn't know the difference between the two amounts.

Hardcoding a threshold (`if (price > 2000)`) doesn't work because:
- Agent code is open source and auditable, so it's trivially bypassed
- Thresholds don't account for context, such as a new customer versus a repeat offender
- The check lives inside the agent, which is the thing you don't trust

---

## How ArmorIQ Solves It

```
Agent captures plan, gets intent token, invokes MCP tool
                        |
                        v
              ArmorIQ Proxy evaluates
                        |
            +-----------+-----------+
            |                       |
            v                       v
     amount < ₹2,000         amount >= ₹2,000
            |                       |
            v                       v
     Auto-execute refund     Hold for approval
                                    |
                                    v
                        Human approves on dashboard
                                    |
                                    v
                        Re-invoke, then execute
```

The policy `dispute-refund-guard` has these rules:

| Tool | Action | Reason |
|------|--------|--------|
| `list_open_disputes` | Allow | Read only, no financial impact |
| `check_dispute` | Allow | Fraud evaluation, no financial impact |
| `resolve_dispute_refund` | Hold | Financial impact — any refund requires human approval |

The high-value path: the agent captures a plan, gets an intent token, and invokes `resolve_dispute_refund` through the ArmorIQ proxy. A `PolicyHoldException` triggers a delegation request that lands in the dashboard's approval queue. A human approves or rejects. The agent never bypasses this — a modified agent can't forge the intent token or Merkle proof.

For the low-value fast-path (< ₹2,000) the agent executes the refund directly so common small disputes don't stall on round trips. This threshold is configurable via `DISPUTE_REFUND_THRESHOLD_INR`.

---

## Seed Disputes

The seed function creates 3 disputes with mixed amounts to demonstrate both paths:

| # | Price | Threshold | Expected Outcome |
|---|-------|-----------|------------------|
| #3 | ₹899 | < ₹2,000 | Auto-executes immediately |
| #1 | ₹4,538.94 | ≥ ₹2,000 | Held for human approval |
| #4 | ₹4,500 | ≥ ₹2,000 | Held for human approval |

After reset, the seed always picks 1 dispute below the threshold and 2 above it.

---

## Features

### Dual Agent Modes

| Mode | Description |
|------|-------------|
| **Deterministic** | Rule-based processing. Same input produces the same outcome every time. |
| **LLM Agent** | GPT-4o-mini reads dispute notes, evaluates context, decides refund. Streams reasoning via SSE. |

### Threshold-Based Governance

| Amount | Behavior | Who decides |
|--------|----------|-------------|
| < ₹2,000 | Auto-execute immediately | Agent (autonomous) |
| ≥ ₹2,000 | Hold for human approval | ArmorIQ (governance) |

### Fraud Detection (`check_dispute`)

- **Repeat offender**: Buyer with 4+ disputes this month → block
- **High-value claim**: Amount > ₹10,000 → block
- **Suspicious keywords**: "never arrived", "fake", "scam", "fraud", "chargeback" → block

### Real-Time SSE Streaming

LLM agent streams reasoning via Server-Sent Events — tool calls, thinking, and decisions appear live.

### Settings Panel

- Auto-run Deterministic / LLM toggles
- Reset All (with confirmation modal)
- Mode persists in localStorage

---

## Architecture

```
           +------------------------------------+
           | FRONTEND (public/index.html)       |
           | Dual-mode tab: Deterministic | LLM |
           | LLM reasoning panel (SSE stream)   |
           | Auto-poll for approval             |
           +------------------------------------+
                             |
              +--------------+--------------+
              v                             v
+---------------------------------+  +---------------------------------+
| DETERMINISTIC AGENT             |  | LLM AGENT                       |
| src/agent.js                    |  | api/v1/chat.js                  |
| Fast-path < threshold → direct  |  | Fast-path < threshold → direct  |
| capturePlan + invoke via ArmorIQ|  | OpenRouter + tool loop + SSE    |
+---------------------------------+  +---------------------------------+
                             |
                             v
             +----------------------------------+
             | ArmorIQ Proxy (proxy.armoriq.ai) |
             | Policy: dispute-refund-guard     |
             | Delegation Queue: Held Actions   |
             +----------------------------------+
                             |
                             v
             +----------------------------------+
             | PostgreSQL (Neon) + Prisma ORM   |
             +----------------------------------+
                             |
                             v
                   +---------------------+
                   | Razorpay API (Test) |
                   +---------------------+
```

---

## Project Structure

```
armoriq-dispute-agent/
├── api/
│   ├── index.js              MCP handler (3 tools)
│   ├── agent.js              Deterministic agent endpoint
│   ├── seed.js               Seeds up to 3 disputes (incl. fraud signals)
│   ├── reset.js              Resets all disputes
│   ├── status.js             Returns disputed transactions
│   ├── verify.js             Validates demo access key
│   └── v1/
│       └── chat.js           LLM agent (GPT-4o-mini + SSE + threshold)
├── public/
│   ├── index.html            Frontend UI
│   └── favicon.png           Site favicon
├── src/
│   ├── agent.js              Deterministic agent logic
│   ├── armoriqClient.js      ArmorIQ SDK client
│   ├── auth.js               Access key auth helpers
│   ├── db.js                 Prisma client singleton
│   ├── disputeMcp.js         Tool functions (list, check, refund)
│   ├── errorClassifier.js    Structured error message mapping
│   └── llmClient.js          System prompt + tool schemas
├── prisma/schema.prisma      Transaction model
├── server.js                 Express server (Zop.dev deployment)
├── vercel.json               Vercel config
└── .env.example              Environment variables
```

---

## Environment Variables

| Variable | Purpose |
|----------|---------|
| `DATABASE_URL` | PostgreSQL connection string (Neon) |
| `RAZORPAY_KEY_ID` | Razorpay test mode key |
| `RAZORPAY_KEY_SECRET` | Razorpay test mode secret |
| `ARMORIQ_API_KEY` | ArmorIQ SDK authentication |
| `OPENROUTER_API_KEY` | OpenRouter API key for LLM agent |
| `ADMIN_EMAIL` | Email for delegation requests (must differ from dashboard login) |
| `DEMO_KEY` | Shared access key protecting all mutating endpoints |
| `DISPUTE_REFUND_THRESHOLD_INR` | Refund threshold (default 2000). Below → auto-execute, ≥ → ArmorIQ hold |

---

## Agent Flows

### Deterministic

1. Query DB for open disputes
2. Fraud check each dispute (`check_dispute`)
3. Block suspicious ones, proceed with clean ones
4. **Threshold**: < ₹2,000 → auto-execute | ≥ ₹2,000 → ArmorIQ proxy → Hold
5. Create delegation → dashboard notification
6. Poll for approval → execute refund

### LLM Agent

1. GPT-4o-mini reads disputes, evaluates context
2. Calls `check_dispute` for fraud risk
3. Calls `resolve_dispute_refund` — threshold enforced in proxy layer
4. Reasoning mentions threshold policy: *"₹899 below ₹2,000, auto-executing"*
5. SSE streams tool calls and reasoning live

---

## How the Policy Works

```
Policy: dispute-refund-guard
Binding: dispute-mcp (MCP server)

+---------------------------+--------+
| Tool                      | Action |
+---------------------------+--------+
| list_open_disputes        | Allow  |
| check_dispute             | Allow  |
| resolve_dispute_refund    | Hold   |
| (anything else)           | Block  |
+---------------------------+--------+
```

The hold enforced by ArmorIQ is the governance backstop. Refunds below the configurable threshold (`DISPUTE_REFUND_THRESHOLD_INR`) take a local fast-path so they don't stall on a proxy round-trip; everything at or above it goes through the proxy and requires human approval.

Two layers of control:

| Layer | Controls | Lives in |
|-------|----------|----------|
| Agent code | Which tools to call, in what order | `src/agent.js` |
| ArmorIQ policy | Whether each call succeeds | ArmorIQ dashboard |

The agent decides what to do. ArmorIQ decides whether it's allowed.
