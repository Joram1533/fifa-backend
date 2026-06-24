/**
 * server.js — FIFA WC26 Ticket Purchasing Backend
 * Stack: Node.js + Express + Firebase Firestore
 * Payment: PayPal Orders API v2
 *
 * Install:
 * npm install express cors dotenv express-rate-limit firebase-admin
 */

import express from "express";
import cors from "cors";
import "dotenv/config";
import rateLimit from "express-rate-limit";
import crypto from "crypto";
import fs from "fs";

// 🔥 Updated: Modern ES Module imports for Firebase Admin
import { initializeApp, cert } from "firebase-admin/app";
import { getFirestore, FieldValue } from "firebase-admin/firestore";

const app = express();

// ── Middleware ───────────────────────────────────────────────────────────────
// BULLETPROOF CORS FIX: Explicitly allowing your Vite frontend
app.use(cors({
  origin: ['http://localhost:5173', 'http://127.0.0.1:5173'],
  methods: ['GET', 'POST', 'PUT', 'DELETE'],
  credentials: true
}));

app.use(express.json());

// Rate limiting — prevent ticket hoarding bots
const limiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 30 });
app.use("/api/", limiter);

// ── CONNECT TO FIREBASE FIRESTORE ────────────────────────────────────────────
let db;
try {
  const serviceAccount = JSON.parse(fs.readFileSync('./serviceAccountKey.json', 'utf8'));
  
  initializeApp({
    credential: cert(serviceAccount)
  });
  
  db = getFirestore();
  console.log('🔥 Firebase Firestore connected successfully');
} catch (error) {
  console.error('❌ Firebase connection error:', error.message);
}
// ─────────────────────────────────────────────────────────────────────────────

// ── PayPal base URL ──────────────────────────────────────────────────────────
// 🔥 LIVE PRODUCTION MODE
const PAYPAL_BASE = "https://api-m.paypal.com"; 

// ── In-memory ticket inventory ───────────────────────────────────────────────
const INVENTORY = {
  cat1:        { price: "850.00",  available: 12 },
  cat2:        { price: "520.00",  available: 28 },
  cat3:        { price: "290.00",  available: 47 },
  hospitality: { price: "2200.00", available: 4  },
};

const SERVICE_RATE = 0.12;
const BOOKING_FEE  = 4.99;

// ── Helpers ──────────────────────────────────────────────────────────────────
function calcTotal(tierId, qty) {
  const tier = INVENTORY[tierId];
  if (!tier) throw new Error("Invalid ticket category");
  if (qty < 1 || qty > 8) throw new Error("Quantity must be between 1 and 8");
  if (qty > tier.available) throw new Error("Not enough tickets available");

  const unitPrice  = parseFloat(tier.price);
  const subtotal   = unitPrice * qty;
  const serviceFee = parseFloat((subtotal * SERVICE_RATE).toFixed(2));
  const total      = parseFloat((subtotal + serviceFee + BOOKING_FEE).toFixed(2));

  return { unitPrice, subtotal, serviceFee, bookingFee: BOOKING_FEE, total };
}

function generateOrderId() {
  return `WC26-${crypto.randomBytes(3).toString("hex").toUpperCase()}`;
}

// ── PayPal OAuth token (NATIVE FETCH REWRITE) ────────────────────────────────
let paypalToken = null;
let paypalTokenExpiry = 0;

async function getPayPalToken() {
  if (paypalToken && Date.now() < paypalTokenExpiry) return paypalToken;

  // 🛑 PASTE YOUR REAL LIVE KEYS HERE 🛑
  const LIVE_CLIENT_ID = "AdoOEDCzZZUQVIn3OZlGIt76Qb_jFgYPFI2scS663TWQnHUr104bsUk3g2AstAASh83ghNmjM08nN6P3".trim();
  const LIVE_SECRET = "EKdsXnWx5XRT7BF2ceRH7nrjm_f-EBcdDvYvYOzUlK7XZcEiFInv7qrHd8sVKUWnodFrAWxenP759B_W".trim();

  const creds = Buffer.from(`${LIVE_CLIENT_ID}:${LIVE_SECRET}`).toString("base64");

  // 🔥 Using native fetch to bypass Akamai WAF blocks
  const response = await fetch(`${PAYPAL_BASE}/v1/oauth2/token`, {
    method: "POST",
    headers: {
      "Authorization": `Basic ${creds}`,
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body: "grant_type=client_credentials"
  });

  const text = await response.text();
  let data;
  try { data = JSON.parse(text); } catch (e) { data = text; }

  if (!response.ok) {
    throw new Error(`Auth failed (${response.status}): ${typeof data === 'string' ? data : JSON.stringify(data)}`);
  }

  paypalToken = data.access_token;
  paypalTokenExpiry = Date.now() + (data.expires_in - 60) * 1000;
  return paypalToken;
}

// Helper for authenticated PayPal requests (NATIVE FETCH REWRITE)
async function paypalRequest(method, path, body) {
  const token = await getPayPalToken();
  
  const response = await fetch(`${PAYPAL_BASE}${path}`, {
    method,
    headers: {
      "Authorization": `Bearer ${token}`,
      "Content-Type": "application/json"
    },
    body: body ? JSON.stringify(body) : undefined
  });

  const text = await response.text();
  let data;
  try { data = JSON.parse(text); } catch (e) { data = text; }

  if (!response.ok) {
    throw new Error(`API failed (${response.status}): ${typeof data === 'string' ? data : JSON.stringify(data)}`);
  }

  return data;
}

// ── Routes ───────────────────────────────────────────────────────────────────

app.get("/api/tickets/availability", (req, res) => {
  const tiers = Object.entries(INVENTORY).map(([id, t]) => ({
    id,
    price: parseFloat(t.price),
    available: t.available,
  }));
  res.json({ tiers });
});

app.post("/api/paypal/create-order", async (req, res) => {
  try {
    const { tierId, qty, buyer } = req.body;
    const { unitPrice, subtotal, serviceFee, bookingFee, total } = calcTotal(tierId, qty);
    const internalOrderId = generateOrderId();

    const paypalOrder = await paypalRequest("POST", "/v2/checkout/orders", {
      intent: "CAPTURE",
      purchase_units: [
        {
          reference_id: internalOrderId,
          description: `FIFA WC26 Tickets — ${tierId} × ${qty}`,
          amount: {
            currency_code: "USD",
            value: total.toFixed(2),
            breakdown: {
              item_total:  { currency_code: "USD", value: subtotal.toFixed(2) },
              handling:    { currency_code: "USD", value: serviceFee.toFixed(2) },
              insurance:   { currency_code: "USD", value: bookingFee.toFixed(2) },
            },
          },
          items: [
            {
              name: `FIFA WC26 Ticket — ${tierId}`,
              unit_amount: { currency_code: "USD", value: unitPrice.toFixed(2) },
              quantity: String(qty),
              category: "DIGITAL_GOODS",
            },
          ],
        },
      ],
      application_context: {
        brand_name: "WC26 Tickets",
        landing_page: "LOGIN",
        user_action: "PAY_NOW",
        return_url: process.env.PAYPAL_RETURN_URL || "http://localhost:5173/checkout/success",
        cancel_url: process.env.PAYPAL_CANCEL_URL || "http://localhost:5173",
      },
      payer: {
        name: { given_name: buyer.firstName, surname: buyer.lastName },
        email_address: buyer.email,
        phone: {
          phone_type: "MOBILE",
          phone_number: { national_number: buyer.phone.replace(/\D/g, "") },
        },
      },
    });

    const approvalUrl = paypalOrder.links?.find(l => l.rel === "approve")?.href;
    if (!approvalUrl) throw new Error("No approval URL returned from PayPal");

    await db.collection("orders").doc(paypalOrder.id).set({
      internalOrderId,
      tierId,
      qty,
      buyer,
      total,
      status: "pending",
      createdAt: FieldValue.serverTimestamp() 
    });

    res.json({
      approvalUrl,
      orderId: internalOrderId,
      paypalOrderId: paypalOrder.id,
      total,
    });
  } catch (err) {
    console.error("PayPal create-order error:", err.message);
    res.status(400).json({ error: err.message });
  }
});

app.post("/api/paypal/capture-order", async (req, res) => {
  try {
    const { paypalOrderId } = req.body;
    if (!paypalOrderId) throw new Error("Missing paypalOrderId");

    const capture = await paypalRequest(
      "POST",
      `/v2/checkout/orders/${paypalOrderId}/capture`,
      {}
    );

    if (capture.status !== "COMPLETED") {
      throw new Error(`Payment not completed. Status: ${capture.status}`);
    }

    const orderRef = db.collection("orders").doc(paypalOrderId);
    const orderSnap = await orderRef.get();
    
    if (orderSnap.exists) {
      const order = orderSnap.data();
      const captureId = capture.purchase_units[0]?.payments?.captures[0]?.id;
      
      await orderRef.update({
        status: "paid",
        captureId: captureId,
        updatedAt: FieldValue.serverTimestamp()
      });

      console.log(`✅ Payment captured — order ${order.internalOrderId}, capture ${captureId}`);

      res.json({
        success: true,
        orderId: order.internalOrderId,
        total: order.total,
        buyer: order.buyer,
      });
    } else {
      res.json({ success: true, orderId: paypalOrderId });
    }
  } catch (err) {
    console.error("PayPal capture error:", err.message);
    res.status(400).json({ error: err.message });
  }
});

app.get("/api/paypal/order-status/:paypalOrderId", async (req, res) => {
  try {
    const orderSnap = await db.collection("orders").doc(req.params.paypalOrderId).get();
    if (!orderSnap.exists) return res.status(404).json({ error: "Order not found" });
    
    const order = orderSnap.data();
    res.json({ status: order.status, orderId: order.internalOrderId });
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch order status" });
  }
});

app.post("/api/paypal/webhook", (req, res) => {
  const event = req.body;
  console.log("PayPal webhook event:", event.event_type, event.resource?.id);

  if (event.event_type === "PAYMENT.CAPTURE.COMPLETED") {
    console.log("✅ Capture confirmed via webhook:", event.resource.id);
  }
  if (event.event_type === "PAYMENT.CAPTURE.DENIED") {
    console.log("❌ Capture denied:", event.resource.id);
  }
  if (event.event_type === "CUSTOMER.DISPUTE.CREATED") {
    console.log("⚠️  Dispute opened:", event.resource.dispute_id);
  }

  res.sendStatus(200);
});

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => console.log(`🎫 Ticket API running on port ${PORT}`));