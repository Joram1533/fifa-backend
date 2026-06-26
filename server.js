/**
 * server.js — FIFA WC26 Ticket Purchasing Backend
 * Stack: Node.js + Express + Firebase Firestore
 * Payment: PayPal Orders API v2
 *
 * Install:
 * npm install express cors dotenv express-rate-limit firebase-admin nodemailer
 */

import express from "express";
import cors from "cors";
import "dotenv/config";
import rateLimit from "express-rate-limit";
import crypto from "crypto";
import fs from "fs";
import nodemailer from "nodemailer";

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

// ── Nodemailer transporter ───────────────────────────────────────────────────
const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST || "smtp.gmail.com",
  port: parseInt(process.env.SMTP_PORT) || 587,
  secure: false,
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
  },
});

// Test SMTP connection
transporter.verify((err, success) => {
  if (err) console.error("❌ SMTP error:", err.message);
  else console.log("✅ SMTP ready");
});

// ── PayPal base URL ──────────────────────────────────────────────────────────
// 🔥 SANDBOX TEST MODE
const PAYPAL_BASE = "https://api-m.sandbox.paypal.com"; 

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

  // 🛑 SANDBOX TEST KEYS 🛑
  const CLIENT_ID = process.env.PAYPAL_CLIENT_ID || "BAAKFXkqw6irAtENi26zdhIUpDxkMk95kihwAa4XeZAxPI3LHLIEA-2OJ7RaO3dLYi6v0BYhVZWUt-_Tsw".trim();
  const SECRET = process.env.PAYPAL_SECRET || "ED7zSoqpiHOiVReyRqNVSvQcyND2-mN1jGdHBx-TFINGInqYPl_4UTeCDABl6jT3EOUXJtR81B7K8hXn".trim();

  const creds = Buffer.from(`${CLIENT_ID}:${SECRET}`).toString("base64");

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

// Helper for authenticated PayPal requests
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

  return { data, ok: response.ok, status: response.status };
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

// 🔥 LIVE MATCHES ENDPOINT: Fetches games from Firestore
app.get("/api/matches", async (req, res) => {
  try {
    const snapshot = await db.collection("matches").get();
    
    if (snapshot.empty) {
      const fallbackMatches = [
        { date:'Jun 11', day:'Thu', num:'11', grp:'A', t1:'Mexico', t2:'South Africa', result:'2–0', venue:'Estadio Azteca', city:'Mexico City', tags:[{l:'Opening match',c:'tag-hot'},{l:'Group A',c:'tag-group'}], played:false },
        { date:'Jun 11', day:'Thu', num:'11', grp:'A', t1:'South Korea', t2:'Czechia', result:'2–1', venue:'Estadio Akron', city:'Zapopan', tags:[{l:'Group A',c:'tag-group'}], played:false },
        { date:'Jun 12', day:'Fri', num:'12', grp:'B', t1:'Canada', t2:'Bosnia and Herzegovina', result:'1–1', venue:'Toronto Stadium', city:'Toronto', tags:[{l:'Canada debut',c:'tag-debut'},{l:'Group B',c:'tag-group'}], played:false },
        { date:'Jun 12', day:'Fri', num:'12', grp:'D', t1:'USA', t2:'Paraguay', result:'4–1', venue:'SoFi Stadium', city:'Los Angeles', tags:[{l:'USA debut',c:'tag-debut'},{l:'Group D',c:'tag-group'}], played:false },
        { date:'Jun 13', day:'Sat', num:'13', grp:'B', t1:'Qatar', t2:'Switzerland', result:'1–1', venue:"Levi's Stadium", city:'Santa Clara', tags:[{l:'Group B',c:'tag-group'}], played:false },
        { date:'Jun 13', day:'Sat', num:'13', grp:'C', t1:'Brazil', t2:'Morocco', result:'1–1', venue:'MetLife Stadium', city:'East Rutherford', tags:[{l:'Group C',c:'tag-group'}], played:false },
        { date:'Jun 13', day:'Sat', num:'13', grp:'C', t1:'Haiti', t2:'Scotland', result:'0–1', venue:'Gillette Stadium', city:'Foxborough', tags:[{l:'Group C',c:'tag-group'}], played:false },
        { date:'Jun 14', day:'Sun', num:'14', grp:'D', t1:'Australia', t2:'Türkiye', result:'2–0', venue:'BC Place', city:'Vancouver', tags:[{l:'Group D',c:'tag-group'}], played:false },
        { date:'Jun 14', day:'Sun', num:'14', grp:'E', t1:'Germany', t2:'Curaçao', result:'7–1', venue:'Houston Stadium', city:'Houston', tags:[{l:'Group E',c:'tag-group'}], played:false },
        { date:'Jun 14', day:'Sun', num:'14', grp:'F', t1:'Netherlands', t2:'Japan', result:'2–2', venue:'Dallas Stadium', city:'Arlington', tags:[{l:'Group F',c:'tag-group'}], played:false },
        { date:'Jun 14', day:'Sun', num:'14', grp:'E', t1:'Ivory Coast', t2:'Ecuador', result:'1–0', venue:'Philadelphia Stadium', city:'Philadelphia', tags:[{l:'Group E',c:'tag-group'}], played:false },
        { date:'Jun 14', day:'Sun', num:'14', grp:'F', t1:'Sweden', t2:'Tunisia', result:'5–1', venue:'Monterrey Stadium', city:'Monterrey', tags:[{l:'Group F',c:'tag-group'}], played:false },
        { date:'Jun 15', day:'Mon', num:'15', grp:'H', t1:'Spain', t2:'Cape Verde', result:'0–0', venue:'Mercedes-Benz Stadium', city:'Atlanta', tags:[{l:'Group H',c:'tag-group'}], played:false },
        { date:'Jun 15', day:'Mon', num:'15', grp:'G', t1:'Belgium', t2:'Egypt', result:'1–1', venue:'Lumen Field', city:'Seattle', tags:[{l:'Group G',c:'tag-group'}], played:false },
        { date:'Jun 15', day:'Mon', num:'15', grp:'H', t1:'Saudi Arabia', t2:'Uruguay', result:'1–1', venue:'Hard Rock Stadium', city:'Miami Gardens', tags:[{l:'Group H',c:'tag-group'}], played:false },
        { date:'Jun 15', day:'Mon', num:'15', grp:'G', t1:'Iran', t2:'New Zealand', result:'2–2', venue:'SoFi Stadium', city:'Los Angeles', tags:[{l:'Group G',c:'tag-group'}], played:false },
        { date:'Jun 16', day:'Tue', num:'16', grp:'I', t1:'France', t2:'Senegal', result:'3–1', venue:'MetLife Stadium', city:'East Rutherford', tags:[{l:'Group I',c:'tag-group'}], played:false },
        { date:'Jun 16', day:'Tue', num:'16', grp:'I', t1:'Iraq', t2:'Norway', result:'1–4', venue:'Gillette Stadium', city:'Foxborough', tags:[{l:'Group I',c:'tag-group'}], played:false },
        { date:'Jun 16', day:'Tue', num:'16', grp:'J', t1:'Argentina', t2:'Algeria', result:'3–0', venue:'Arrowhead Stadium', city:'Kansas City', tags:[{l:'Group J',c:'tag-group'}], played:false },
        { date:'Jun 17', day:'Wed', num:'17', grp:'J', t1:'Austria', t2:'Jordan', result:'3–1', venue:"Levi's Stadium", city:'Santa Clara', tags:[{l:'Group J',c:'tag-group'}], played:false },
        { date:'Jun 17', day:'Wed', num:'17', grp:'K', t1:'Portugal', t2:'DR Congo', result:'1–1', venue:'NRG Stadium', city:'Houston', tags:[{l:'Group K',c:'tag-group'}], played:false },
        { date:'Jun 17', day:'Wed', num:'17', grp:'L', t1:'England', t2:'Croatia', result:'4–2', venue:'AT&T Stadium', city:'Arlington', tags:[{l:'Group L',c:'tag-group'}], played:false },
        { date:'Jun 17', day:'Wed', num:'17', grp:'L', t1:'Ghana', t2:'Panama', result:'1–0', venue:'BMO Field', city:'Toronto', tags:[{l:'Group L',c:'tag-group'}], played:false },
        { date:'Jun 17', day:'Wed', num:'17', grp:'K', t1:'Uzbekistan', t2:'Colombia', result:'1–3', venue:'Estadio Azteca', city:'Mexico City', tags:[{l:'Group K',c:'tag-group'}], played:false },
        { date:'Jun 18', day:'Thu', num:'18', grp:'A', t1:'Czechia', t2:'South Africa', result:'1–1', venue:'Mercedes-Benz Stadium', city:'Atlanta', tags:[{l:'Group A',c:'tag-group'}], played:false },
        { date:'Jun 18', day:'Thu', num:'18', grp:'B', t1:'Switzerland', t2:'Bosnia & Herzegovina', result:'4–1', venue:'SoFi Stadium', city:'Los Angeles', tags:[{l:'Group B',c:'tag-group'}], played:false },
        { date:'Jun 18', day:'Thu', num:'18', grp:'B', t1:'Canada', t2:'Qatar', time:'6:00 PM ET', venue:'BC Place', city:'Vancouver', tags:[{l:'Canada',c:'tag-debut'},{l:'Group B',c:'tag-group'}], played:false },
        { date:'Jun 18', day:'Thu', num:'18', grp:'A', t1:'Mexico', t2:'South Korea', time:'9:00 PM ET', venue:'Estadio Akron', city:'Zapopan', tags:[{l:'Group A',c:'tag-group'}], played:false },
        { date:'Jun 19', day:'Fri', num:'19', grp:'D', t1:'USA', t2:'Australia', time:'3:00 PM ET', venue:'Lumen Field', city:'Seattle', tags:[{l:'USA',c:'tag-debut'},{l:'Group D',c:'tag-group'}], played:false },
        { date:'Jun 19', day:'Fri', num:'19', grp:'C', t1:'Scotland', t2:'Morocco', time:'6:00 PM ET', venue:'Gillette Stadium', city:'Foxborough', tags:[{l:'Group C',c:'tag-group'}], played:false },
        { date:'Jun 19', day:'Fri', num:'19', grp:'C', t1:'Brazil', t2:'Haiti', time:'8:30 PM ET', venue:'Lincoln Financial Field', city:'Philadelphia', tags:[{l:'Group C',c:'tag-group'}], played:false },
        { date:'Jun 19', day:'Fri', num:'19', grp:'D', t1:'Türkiye', t2:'Paraguay', time:'11:00 PM ET', venue:"Levi's Stadium", city:'Santa Clara', tags:[{l:'Group D',c:'tag-group'}], played:false },
        { date:'Jun 20', day:'Sat', num:'20', grp:'F', t1:'Netherlands', t2:'Sweden', time:'1:00 PM ET', venue:'NRG Stadium', city:'Houston', tags:[{l:'Group F',c:'tag-group'}], played:false },
        { date:'Jun 20', day:'Sat', num:'20', grp:'E', t1:'Germany', t2:'Ivory Coast', time:'4:00 PM ET', venue:'BMO Field', city:'Toronto', tags:[{l:'Group E',c:'tag-group'}], played:false },
        { date:'Jun 20', day:'Sat', num:'20', grp:'E', t1:'Ecuador', t2:'Curaçao', time:'8:00 PM ET', venue:'Arrowhead Stadium', city:'Kansas City', tags:[{l:'Group E',c:'tag-group'}], played:false },
        { date:'Jun 21', day:'Sun', num:'21', grp:'F', t1:'Tunisia', t2:'Japan', time:'12:00 AM ET', venue:'Estadio BBVA', city:'Monterrey', tags:[{l:'Group F',c:'tag-group'}], played:false },
        { date:'Jun 21', day:'Sun', num:'21', grp:'H', t1:'Spain', t2:'Saudi Arabia', time:'12:00 PM ET', venue:'Mercedes-Benz Stadium', city:'Atlanta', tags:[{l:'Group H',c:'tag-group'}], played:false },
        { date:'Jun 21', day:'Sun', num:'21', grp:'G', t1:'Belgium', t2:'Iran', time:'3:00 PM ET', venue:'SoFi Stadium', city:'Los Angeles', tags:[{l:'Group G',c:'tag-group'}], played:false },
        { date:'Jun 21', day:'Sun', num:'21', grp:'H', t1:'Uruguay', t2:'Cape Verde', time:'6:00 PM ET', venue:'Hard Rock Stadium', city:'Miami Gardens', tags:[{l:'Group H',c:'tag-group'}], played:false },
        { date:'Jun 21', day:'Sun', num:'21', grp:'G', t1:'New Zealand', t2:'Egypt', time:'9:00 PM ET', venue:'BC Place', city:'Vancouver', tags:[{l:'Group G',c:'tag-group'}], played:false },
        { date:'Jun 22', day:'Mon', num:'22', grp:'J', t1:'Argentina', t2:'Austria', time:'1:00 PM ET', venue:'AT&T Stadium', city:'Arlington', tags:[{l:'Group J',c:'tag-group'}], played:false },
        { date:'Jun 22', day:'Mon', num:'22', grp:'I', t1:'France', t2:'Iraq', time:'5:00 PM ET', venue:'Lincoln Financial Field', city:'Philadelphia', tags:[{l:'Group I',c:'tag-group'}], played:false },
        { date:'Jun 22', day:'Mon', num:'22', grp:'I', t1:'Norway', t2:'Senegal', time:'8:00 PM ET', venue:'MetLife Stadium', city:'East Rutherford', tags:[{l:'Group I',c:'tag-group'}], played:false },
        { date:'Jun 22', day:'Mon', num:'22', grp:'J', t1:'Jordan', t2:'Algeria', time:'11:00 PM ET', venue:"Levi's Stadium", city:'Santa Clara', tags:[{l:'Group J',c:'tag-group'}], played:false },
        { date:'Jun 23', day:'Tue', num:'23', grp:'K', t1:'Portugal', t2:'Uzbekistan', time:'1:00 PM ET', venue:'NRG Stadium', city:'Houston', tags:[{l:'Group K',c:'tag-group'}], played:false },
        { date:'Jun 23', day:'Tue', num:'23', grp:'L', t1:'England', t2:'Ghana', time:'4:00 PM ET', venue:'Gillette Stadium', city:'Foxborough', tags:[{l:'Group L',c:'tag-group'}], played:false },
        { date:'Jun 23', day:'Tue', num:'23', grp:'L', t1:'Panama', t2:'Croatia', time:'7:00 PM ET', venue:'BMO Field', city:'Toronto', tags:[{l:'Group L',c:'tag-group'}], played:false },
        { date:'Jun 23', day:'Tue', num:'23', grp:'K', t1:'Colombia', t2:'DR Congo', time:'10:00 PM ET', venue:'Estadio Akron', city:'Zapopan', tags:[{l:'Group K',c:'tag-group'}], played:false },
        { date:'Jun 24', day:'Wed', num:'24', grp:'B', t1:'Switzerland', t2:'Canada', time:'3:00 PM ET', venue:'BC Place', city:'Vancouver', tags:[{l:'Group B',c:'tag-group'},{l:'Final matchday',c:'tag-hot'}], played:false },
        { date:'Jun 24', day:'Wed', num:'24', grp:'B', t1:'Bosnia & Herzegovina', t2:'Qatar', time:'3:00 PM ET', venue:'Lumen Field', city:'Seattle', tags:[{l:'Group B',c:'tag-group'},{l:'Final matchday',c:'tag-hot'}], played:false },
        { date:'Jun 24', day:'Wed', num:'24', grp:'C', t1:'Scotland', t2:'Brazil', time:'6:00 PM ET', venue:'Hard Rock Stadium', city:'Miami Gardens', tags:[{l:'Group C',c:'tag-group'},{l:'Final matchday',c:'tag-hot'}], played:false },
        { date:'Jun 24', day:'Wed', num:'24', grp:'C', t1:'Morocco', t2:'Haiti', time:'6:00 PM ET', venue:'Mercedes-Benz Stadium', city:'Atlanta', tags:[{l:'Group C',c:'tag-group'},{l:'Final matchday',c:'tag-hot'}], played:false },
        { date:'Jun 24', day:'Wed', num:'24', grp:'A', t1:'Czechia', t2:'Mexico', time:'9:00 PM ET', venue:'Estadio Azteca', city:'Mexico City', tags:[{l:'Group A',c:'tag-group'},{l:'Final matchday',c:'tag-hot'}], played:false },
        { date:'Jun 24', day:'Wed', num:'24', grp:'A', t1:'South Africa', t2:'South Korea', time:'9:00 PM ET', venue:'Estadio BBVA', city:'Monterrey', tags:[{l:'Group A',c:'tag-group'},{l:'Final matchday',c:'tag-hot'}], played:false },
        { date:'Jun 25', day:'Thu', num:'25', grp:'E', t1:'Curaçao', t2:'Ivory Coast', time:'4:00 PM ET', venue:'Lincoln Financial Field', city:'Philadelphia', tags:[{l:'Group E',c:'tag-group'},{l:'Final matchday',c:'tag-hot'}], played:false },
        { date:'Jun 25', day:'Thu', num:'25', grp:'E', t1:'Ecuador', t2:'Germany', time:'4:00 PM ET', venue:'MetLife Stadium', city:'East Rutherford', tags:[{l:'Group E',c:'tag-group'},{l:'Final matchday',c:'tag-hot'}], played:false },
        { date:'Jun 25', day:'Thu', num:'25', grp:'F', t1:'Japan', t2:'Sweden', time:'7:00 PM ET', venue:'AT&T Stadium', city:'Arlington', tags:[{l:'Group F',c:'tag-group'},{l:'Final matchday',c:'tag-hot'}], played:false },
        { date:'Jun 25', day:'Thu', num:'25', grp:'F', t1:'Tunisia', t2:'Netherlands', time:'7:00 PM ET', venue:'Arrowhead Stadium', city:'Kansas City', tags:[{l:'Group F',c:'tag-group'},{l:'Final matchday',c:'tag-hot'}], played:false },
        { date:'Jun 25', day:'Thu', num:'25', grp:'D', t1:'Türkiye', t2:'USA', time:'10:00 PM ET', venue:'SoFi Stadium', city:'Los Angeles', tags:[{l:'USA',c:'tag-debut'},{l:'Group D',c:'tag-group'},{l:'Final matchday',c:'tag-hot'}], played:false },
        { date:'Jun 25', day:'Thu', num:'25', grp:'D', t1:'Paraguay', t2:'Australia', time:'10:00 PM ET', venue:"Levi's Stadium", city:'Santa Clara', tags:[{l:'Group D',c:'tag-group'},{l:'Final matchday',c:'tag-hot'}], played:false },
        { date:'Jun 26', day:'Fri', num:'26', grp:'I', t1:'Norway', t2:'France', time:'3:00 PM ET', venue:'Gillette Stadium', city:'Foxborough', tags:[{l:'Group I',c:'tag-group'},{l:'Final matchday',c:'tag-hot'}], played:false },
        { date:'Jun 26', day:'Fri', num:'26', grp:'I', t1:'Senegal', t2:'Iraq', time:'3:00 PM ET', venue:'BMO Field', city:'Toronto', tags:[{l:'Group I',c:'tag-group'},{l:'Final matchday',c:'tag-hot'}], played:false },
        { date:'Jun 26', day:'Fri', num:'26', grp:'H', t1:'Cape Verde', t2:'Saudi Arabia', time:'8:00 PM ET', venue:'NRG Stadium', city:'Houston', tags:[{l:'Group H',c:'tag-group'},{l:'Final matchday',c:'tag-hot'}], played:false },
        { date:'Jun 26', day:'Fri', num:'26', grp:'H', t1:'Uruguay', t2:'Spain', time:'8:00 PM ET', venue:'Estadio Akron', city:'Zapopan', tags:[{l:'Group H',c:'tag-group'},{l:'Final matchday',c:'tag-hot'}], played:false },
        { date:'Jun 26', day:'Fri', num:'26', grp:'G', t1:'Egypt', t2:'Iran', time:'11:00 PM ET', venue:'Lumen Field', city:'Seattle', tags:[{l:'Group G',c:'tag-group'},{l:'Final matchday',c:'tag-hot'}], played:false },
        { date:'Jun 26', day:'Fri', num:'26', grp:'G', t1:'New Zealand', t2:'Belgium', time:'11:00 PM ET', venue:'BC Place', city:'Vancouver', tags:[{l:'Group G',c:'tag-group'},{l:'Final matchday',c:'tag-hot'}], played:false },
        { date:'Jun 27', day:'Sat', num:'27', grp:'L', t1:'Panama', t2:'England', time:'5:00 PM ET', venue:'MetLife Stadium', city:'East Rutherford', tags:[{l:'Group L',c:'tag-group'},{l:'Final matchday',c:'tag-hot'}], played:false },
        { date:'Jun 27', day:'Sat', num:'27', grp:'L', t1:'Croatia', t2:'Ghana', time:'5:00 PM ET', venue:'Lincoln Financial Field', city:'Philadelphia', tags:[{l:'Group L',c:'tag-group'},{l:'Final matchday',c:'tag-hot'}], played:false },
        { date:'Jun 27', day:'Sat', num:'27', grp:'K', t1:'Colombia', t2:'Portugal', time:'7:30 PM ET', venue:'Hard Rock Stadium', city:'Miami Gardens', tags:[{l:'Group K',c:'tag-group'},{l:'Final matchday',c:'tag-hot'}], played:false },
        { date:'Jun 27', day:'Sat', num:'27', grp:'K', t1:'DR Congo', t2:'Uzbekistan', time:'7:30 PM ET', venue:'Mercedes-Benz Stadium', city:'Atlanta', tags:[{l:'Group K',c:'tag-group'},{l:'Final matchday',c:'tag-hot'}], played:false },
        { date:'Jun 27', day:'Sat', num:'27', grp:'J', t1:'Algeria', t2:'Austria', time:'10:00 PM ET', venue:'Arrowhead Stadium', city:'Kansas City', tags:[{l:'Group J',c:'tag-group'},{l:'Final matchday',c:'tag-hot'}], played:false },
        { date:'Jun 27', day:'Sat', num:'27', grp:'J', t1:'Jordan', t2:'Argentina', time:'10:00 PM ET', venue:'AT&T Stadium', city:'Arlington', tags:[{l:'Group J',c:'tag-group'},{l:'Final matchday',c:'tag-hot'}], played:false },
        { date:'Jun 28', day:'Sun', num:'28', grp:'R32', t1:'Runner-up A', t2:'Runner-up B', time:'3:00 PM ET', venue:'SoFi Stadium', city:'Los Angeles', tags:[{l:'Round of 32',c:'tag-knockout'}], played:false, knockout:true },
        { date:'Jun 29', day:'Mon', num:'29', grp:'R32', t1:'Winner C', t2:'Runner-up F', time:'1:00 PM ET', venue:'NRG Stadium', city:'Houston', tags:[{l:'Round of 32',c:'tag-knockout'}], played:false, knockout:true },
        { date:'Jun 29', day:'Mon', num:'29', grp:'R32', t1:'Winner E', t2:'Best 3rd', time:'4:30 PM ET', venue:'Gillette Stadium', city:'Foxborough', tags:[{l:'Round of 32',c:'tag-knockout'}], played:false, knockout:true },
        { date:'Jun 29', day:'Mon', num:'29', grp:'R32', t1:'Winner F', t2:'Runner-up C', time:'9:00 PM ET', venue:'Estadio BBVA', city:'Monterrey', tags:[{l:'Round of 32',c:'tag-knockout'}], played:false, knockout:true },
        { date:'Jun 30', day:'Tue', num:'30', grp:'R32', t1:'Runner-up E', t2:'Runner-up I', time:'1:00 PM ET', venue:'AT&T Stadium', city:'Arlington', tags:[{l:'Round of 32',c:'tag-knockout'}], played:false, knockout:true },
        { date:'Jul 1',  day:'Wed', num:'1',  grp:'R32', t1:'Winner L', t2:'Best 3rd', time:'12:00 PM ET', venue:'Mercedes-Benz Stadium', city:'Atlanta', tags:[{l:'Round of 32',c:'tag-knockout'}], played:false, knockout:true },
        { date:'Jul 2',  day:'Thu', num:'2',  grp:'R32', t1:'Winner H', t2:'Runner-up J', time:'3:00 PM ET', venue:'SoFi Stadium', city:'Los Angeles', tags:[{l:'Round of 32',c:'tag-knockout'}], played:false, knockout:true },
        { date:'Jul 3',  day:'Fri', num:'3',  grp:'R32', t1:'Winner K', t2:'Best 3rd', time:'9:30 PM ET', venue:'Arrowhead Stadium', city:'Kansas City', tags:[{l:'Round of 32',c:'tag-knockout'}], played:false, knockout:true },
        { date:'Jul 4',  day:'Sat', num:'4',  grp:'R16', t1:'TBD', t2:'TBD', time:'1:00 PM ET', venue:'NRG Stadium', city:'Houston', tags:[{l:'Round of 16',c:'tag-knockout'},{l:'High demand',c:'tag-urgent'}], played:false, knockout:true },
        { date:'Jul 4',  day:'Sat', num:'4',  grp:'R16', t1:'TBD', t2:'TBD', time:'5:00 PM ET', venue:'Lincoln Financial Field', city:'Philadelphia', tags:[{l:'Round of 16',c:'tag-knockout'},{l:'High demand',c:'tag-urgent'}], played:false, knockout:true },
        { date:'Jul 5',  day:'Sun', num:'5',  grp:'R16', t1:'TBD', t2:'TBD', time:'4:00 PM ET', venue:'MetLife Stadium', city:'East Rutherford', tags:[{l:'Round of 16',c:'tag-knockout'},{l:'High demand',c:'tag-urgent'}], played:false, knockout:true },
        { date:'Jul 6',  day:'Mon', num:'6',  grp:'R16', t1:'TBD', t2:'TBD', time:'3:00 PM ET', venue:'AT&T Stadium', city:'Arlington', tags:[{l:'Round of 16',c:'tag-knockout'},{l:'High demand',c:'tag-urgent'}], played:false, knockout:true },
        { date:'Jul 7',  day:'Tue', num:'7',  grp:'R16', t1:'TBD', t2:'TBD', time:'12:00 PM ET', venue:'Mercedes-Benz Stadium', city:'Atlanta', tags:[{l:'Round of 16',c:'tag-knockout'},{l:'High demand',c:'tag-urgent'}], played:false, knockout:true },
        { date:'Jul 9',  day:'Thu', num:'9',  grp:'QF', t1:'TBD', t2:'TBD', time:'TBD', venue:'SoFi Stadium', city:'Los Angeles', tags:[{l:'Quarterfinal',c:'tag-knockout'},{l:'Selling fast',c:'tag-urgent'}], played:false, knockout:true },
        { date:'Jul 10', day:'Fri', num:'10', grp:'QF', t1:'TBD', t2:'TBD', time:'TBD', venue:'MetLife Stadium', city:'East Rutherford', tags:[{l:'Quarterfinal',c:'tag-knockout'},{l:'Selling fast',c:'tag-urgent'}], played:false, knockout:true },
        { date:'Jul 11', day:'Sat', num:'11', grp:'QF', t1:'TBD', t2:'TBD', time:'TBD', venue:'AT&T Stadium', city:'Arlington', tags:[{l:'Quarterfinal',c:'tag-knockout'},{l:'Selling fast',c:'tag-urgent'}], played:false, knockout:true },
        { date:'Jul 14', day:'Tue', num:'14', grp:'SF', t1:'TBD', t2:'TBD', time:'TBD', venue:'Hard Rock Stadium', city:'Miami Gardens', tags:[{l:'Semifinal',c:'tag-knockout'},{l:'Only 2% left',c:'tag-urgent'}], played:false, knockout:true },
        { date:'Jul 15', day:'Wed', num:'15', grp:'SF', t1:'TBD', t2:'TBD', time:'TBD', venue:'AT&T Stadium', city:'Arlington', tags:[{l:'Semifinal',c:'tag-knockout'},{l:'Only 2% left',c:'tag-urgent'}], played:false, knockout:true },
        { date:'Jul 18', day:'Sat', num:'18', grp:'3P', t1:'TBD', t2:'TBD', time:'5:00 PM ET', venue:'Hard Rock Stadium', city:'Miami Gardens', tags:[{l:'Third-place match',c:'tag-knockout'}], played:false, knockout:true },
        { date:'Jul 19', day:'Sun', num:'19', grp:'FINAL', t1:'TBD', t2:'TBD', time:'3:00 PM ET', venue:'MetLife Stadium', city:'East Rutherford', tags:[{l:'World Cup Final',c:'tag-hot'},{l:'Extremely limited',c:'tag-urgent'}], played:false, knockout:true },
      ];
      return res.json(fallbackMatches);
    }

    // If matches exist in Firestore, send them to React
    const matches = [];
    snapshot.forEach(doc => {
      matches.push({ id: doc.id, ...doc.data() });
    });
    
    res.json(matches);
  } catch (err) {
    console.error("Error fetching matches from Firestore:", err.message);
    res.status(500).json({ error: "Failed to fetch live matches" });
  }
});

app.post("/api/paypal/create-order", async (req, res) => {
  try {
    const { tierId, qty, buyer } = req.body;
    const { unitPrice, subtotal, serviceFee, bookingFee, total } = calcTotal(tierId, qty);
    const internalOrderId = generateOrderId();

    const { data: paypalOrder, ok, status } = await paypalRequest("POST", "/v2/checkout/orders", {
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

    if (!ok) throw new Error(`API failed (${status}): ${JSON.stringify(paypalOrder)}`);

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

    // ── STEP 1: Check Firestore first — block double capture ────────────────
    const orderRef = db.collection("orders").doc(paypalOrderId);
    const orderSnap = await orderRef.get();
    
    if (orderSnap.exists) {
      const order = orderSnap.data();
      if (order.status === "paid") {
        console.log(`🛡️ Prevented double-capture. Order ${order.internalOrderId} is already paid.`);
        return res.json({
          success: true,
          orderId: order.internalOrderId,
          total: order.total,
          buyer: order.buyer,
        });
      }
    }

    // ── STEP 2: Attempt PayPal capture ──────────────────────────────────────
    const { data: capture, ok, status } = await paypalRequest(
      "POST",
      `/v2/checkout/orders/${paypalOrderId}/capture`,
      {}
    );

    // ── STEP 3: Handle ORDER_ALREADY_CAPTURED gracefully ────────────────────
    if (!ok) {
      const issue = capture?.details?.[0]?.issue;
      if (issue === "ORDER_ALREADY_CAPTURED") {
        console.log(`⚠️  ORDER_ALREADY_CAPTURED for ${paypalOrderId} — returning success.`);
        if (orderSnap.exists) {
          const order = orderSnap.data();
          return res.json({
            success: true,
            orderId: order.internalOrderId,
            total: order.total,
            buyer: order.buyer,
          });
        }
        return res.json({ success: true, orderId: "WC26-CAPTURED", total: 0 });
      }
      throw new Error(`API failed (${status}): ${JSON.stringify(capture)}`);
    }

    // ── STEP 4: Verify capture completed ────────────────────────────────────
    if (capture.status !== "COMPLETED") {
      throw new Error(`Payment not completed. Status: ${capture.status}`);
    }

    const captureId = capture.purchase_units[0]?.payments?.captures[0]?.id;
    
    // ── STEP 5: Mark order as paid in Firestore and Send Email ──────────────
    if (orderSnap.exists) {
      const order = orderSnap.data();
      
      await orderRef.update({
        status: "paid",
        captureId,
        updatedAt: FieldValue.serverTimestamp()
      });

      console.log(`✅ Payment captured — order ${order.internalOrderId}, capture ${captureId}`);

      // Auto-send the receipt email directly after successful DB update
      try {
        await transporter.sendMail({
          from: `"WC26 Tickets" <${process.env.SMTP_USER}>`,
          to: order.buyer.email,
          subject: `Your WC26 Booking Confirmation — ${order.internalOrderId}`,
          html: `
            <div style="font-family:Arial,sans-serif;max-width:520px;margin:auto;padding:24px;border:1px solid #e0e0e0;border-radius:12px">
              <div style="background:#1a003d;padding:18px 20px;border-radius:8px;margin-bottom:24px">
                <h1 style="color:#fff;font-size:18px;margin:0">🎫 FIFA World Cup 2026</h1>
                <p style="color:rgba(255,255,255,0.6);font-size:12px;margin:4px 0 0">Booking Confirmation</p>
              </div>

              <p style="font-size:14px;color:#333">Hi <strong>${order.buyer?.firstName}</strong>,</p>
              <p style="font-size:14px;color:#555">Your tickets have been confirmed. Here are your booking details:</p>

              <div style="background:#f8f8f8;border-radius:8px;padding:16px;margin:20px 0;font-size:13px">
                <div style="display:flex;justify-content:space-between;margin-bottom:8px">
                  <span style="color:#888">Booking reference</span>
                  <strong style="font-family:monospace;letter-spacing:1px">${order.internalOrderId}</strong>
                </div>
                <div style="display:flex;justify-content:space-between;margin-bottom:8px">
                  <span style="color:#888">Category</span>
                  <strong>${order.tierId?.toUpperCase()}</strong>
                </div>
                <div style="display:flex;justify-content:space-between;margin-bottom:8px">
                  <span style="color:#888">Quantity</span>
                  <strong>${order.qty} ticket${order.qty > 1 ? "s" : ""}</strong>
                </div>
                <div style="border-top:1px solid #e0e0e0;margin-top:10px;padding-top:10px;display:flex;justify-content:space-between">
                  <span style="color:#888">Total paid</span>
                  <strong style="color:#1a003d;font-size:15px">$${order.total?.toFixed(2)}</strong>
                </div>
              </div>

              <p style="font-size:13px;color:#555">
                Your tickets will be available in your account under 
                <a href="${process.env.PAYPAL_RETURN_URL?.replace("/checkout/success", "/my-tickets") || "http://localhost:5173/my-tickets"}" style="color:#1a003d">My Tickets</a>.
              </p>

              <div style="margin-top:24px;padding-top:16px;border-top:1px solid #e0e0e0;font-size:11px;color:#aaa;text-align:center">
                WC26 Tickets · This is an automated email, please do not reply.
              </div>
            </div>
          `,
        });
        console.log(`📧 Receipt sent to ${order.buyer.email}`);
      } catch (mailErr) {
        console.error("⚠️ Email failed (payment still succeeded):", mailErr.message);
      }

      return res.json({
        success: true,
        orderId: order.internalOrderId,
        total: order.total,
        buyer: order.buyer,
      });
    }

    console.warn(`⚠️  Capture succeeded but no Firestore doc for ${paypalOrderId}`);
    return res.json({ success: true, orderId: paypalOrderId });

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

// ── POST /api/orders/send-receipt ────────────────────────────────────────────
// Manual trigger endpoint (in case you want to resend receipts later)
app.post("/api/orders/send-receipt", async (req, res) => {
  try {
    const { orderId, email } = req.body;
    if (!orderId || !email) throw new Error("Missing orderId or email");

    const snapshot = await db.collection("orders")
      .where("internalOrderId", "==", orderId)
      .limit(1)
      .get();

    if (snapshot.empty) throw new Error("Order not found");

    const order = snapshot.docs[0].data();

    await transporter.sendMail({
      from: `"WC26 Tickets" <${process.env.SMTP_USER}>`,
      to: email,
      subject: `Your WC26 Booking Confirmation — ${orderId}`,
      html: `
        <div style="font-family:Arial,sans-serif;max-width:520px;margin:auto;padding:24px;border:1px solid #e0e0e0;border-radius:12px">
          <div style="background:#1a003d;padding:18px 20px;border-radius:8px;margin-bottom:24px">
            <h1 style="color:#fff;font-size:18px;margin:0">🎫 FIFA World Cup 2026</h1>
            <p style="color:rgba(255,255,255,0.6);font-size:12px;margin:4px 0 0">Booking Confirmation</p>
          </div>
          <p style="font-size:14px;color:#333">Hi <strong>${order.buyer?.firstName}</strong>,</p>
          <p style="font-size:14px;color:#555">Your tickets have been confirmed. Here are your booking details:</p>
          <div style="background:#f8f8f8;border-radius:8px;padding:16px;margin:20px 0;font-size:13px">
            <div style="display:flex;justify-content:space-between;margin-bottom:8px">
              <span style="color:#888">Booking reference</span>
              <strong style="font-family:monospace;letter-spacing:1px">${orderId}</strong>
            </div>
            <div style="display:flex;justify-content:space-between;margin-bottom:8px">
              <span style="color:#888">Category</span>
              <strong>${order.tierId?.toUpperCase()}</strong>
            </div>
            <div style="display:flex;justify-content:space-between;margin-bottom:8px">
              <span style="color:#888">Quantity</span>
              <strong>${order.qty} ticket${order.qty > 1 ? "s" : ""}</strong>
            </div>
            <div style="border-top:1px solid #e0e0e0;margin-top:10px;padding-top:10px;display:flex;justify-content:space-between">
              <span style="color:#888">Total paid</span>
              <strong style="color:#1a003d;font-size:15px">$${order.total?.toFixed(2)}</strong>
            </div>
          </div>
          <p style="font-size:13px;color:#555">
            Your tickets will be available in your account under 
            <a href="${process.env.PAYPAL_RETURN_URL?.replace("/checkout/success", "/my-tickets") || "http://localhost:5173/my-tickets"}" style="color:#1a003d">My Tickets</a>.
          </p>
          <div style="margin-top:24px;padding-top:16px;border-top:1px solid #e0e0e0;font-size:11px;color:#aaa;text-align:center">
            WC26 Tickets · This is an automated email, please do not reply.
          </div>
        </div>
      `,
    });

    console.log(`📧 Receipt manually sent to ${email} for order ${orderId}`);
    res.json({ success: true });

  } catch (err) {
    console.error("Send-receipt error:", err.message);
    res.status(400).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => console.log(`🎫 Ticket API running on port ${PORT}`));