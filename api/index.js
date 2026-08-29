import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import prisma from '../src/db.js';
import Razorpay from 'razorpay';

const razorpayClient = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID,
  key_secret: process.env.RAZORPAY_KEY_SECRET,
});

function createServer() {
  const server = new McpServer({ name: 'dispute-mcp', version: '1.0.0' });

  server.tool(
    'list_open_disputes',
    'List all open disputes eligible for resolution',
    {},
    async () => {
      const disputes = await prisma.transaction.findMany({
        where: {
          disputeStatus: { in: ['buyer_claimed', 'seller_denied'] },
          razorpayPaymentId: { not: null },
          paymentStatus: 'completed',
        },
        select: {
          id: true,
          price: true,
          razorpayPaymentId: true,
          disputeStatus: true,
          disputeNote: true,
          disputedAt: true,
        },
        orderBy: { id: 'asc' },
      });
      return { content: [{ type: 'text', text: JSON.stringify(disputes, null, 2) }] };
    },
  );

  server.tool(
    'check_dispute',
    'Evaluate a dispute for fraud risk. Returns allow or block with reasoning.',
    {
      transaction_id: z.number().describe('The transaction ID'),
      dispute_note: z.string().describe('The dispute claim note'),
      price: z.number().describe('The dispute amount in INR'),
    },
    async ({ transaction_id, dispute_note, price }) => {
      const reasons = [];

      const countMatch = (dispute_note || '').match(/\[buyerDisputeCount:(\d+)\]/);
      const buyerDisputeCount = countMatch ? parseInt(countMatch[1], 10) : 0;
      if (buyerDisputeCount >= 4) {
        reasons.push(`Buyer has ${buyerDisputeCount} disputes this month (threshold: 4)`);
      }

      if (price > 10000) {
        reasons.push(`High-value claim: ₹${price} (threshold: ₹10,000)`);
      }

      const fraudKeywords = ['never arrived', 'not received', 'fake', 'scam', 'fraud', 'chargeback'];
      const lowerNote = (dispute_note || '').toLowerCase();
      for (const kw of fraudKeywords) {
        if (lowerNote.includes(kw)) {
          reasons.push(`Suspicious keyword: "${kw}"`);
        }
      }

      const blocked = reasons.length > 0;

      await prisma.transaction.update({
        where: { id: transaction_id },
        data: {
          disputeNote: `${dispute_note} [check: ${blocked ? 'blocked' : 'cleared'}]`,
        },
      });

      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            decision: blocked ? 'block' : 'allow',
            transaction_id,
            reasons,
          }),
        }],
      };
    },
  );

  server.tool(
    'resolve_dispute_refund',
    'Resolve a dispute by issuing a Razorpay refund',
    {
      transaction_id: z.number().describe('The transaction ID'),
      price: z.number().describe('The dispute amount in INR'),
      razorpay_payment_id: z.string().describe('The Razorpay payment ID to refund'),
    },
    async ({ transaction_id, price, razorpay_payment_id }) => {
      const amountInPaise = Math.round(price * 100);
      const refund = await razorpayClient.payments.refund(razorpay_payment_id, {
        amount: amountInPaise,
        speed: 'normal',
      });
      const current = await prisma.transaction.findUnique({
        where: { id: transaction_id },
        select: { disputeNote: true },
      });
      await prisma.transaction.update({
        where: { id: transaction_id },
        data: {
          disputeStatus: 'admin_resolved',
          disputeNote: `${current?.disputeNote ?? ''} [Agent: refund_buyer]`,
        },
      });
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({ refundId: refund.id, amount: amountInPaise, status: refund.status }),
        }],
      };
    },
  );

  return server;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      try { resolve(body ? JSON.parse(body) : {}); }
      catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

export default async function handler(req, res) {
  if (req.method === 'GET') {
    res.setHeader('Content-Type', 'application/json');
    return res.status(200).json({
      name: 'dispute-mcp',
      status: 'ok',
      tools: ['list_open_disputes', 'check_dispute', 'resolve_dispute_refund'],
    });
  }

  if (req.method !== 'POST') {
    res.setHeader('Content-Type', 'application/json');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const key = req.headers['x-demo-key'];
  if (key !== process.env.DEMO_KEY) {
    res.setHeader('Content-Type', 'application/json');
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    const body = await readBody(req);
    const server = createServer();
    const transport = new StreamableHTTPServerTransport({
      enableJsonResponse: true,
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, body);
  } catch (err) {
    console.error('MCP handler error:', err);
    if (!res.headersSent) {
      res.setHeader('Content-Type', 'application/json');
      res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: err.message }, id: null });
    }
  }
}
