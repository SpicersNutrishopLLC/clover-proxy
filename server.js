const express = require('express');
const cors    = require('cors');
const fetch   = require('node-fetch');
const Stripe  = require('stripe');

const app  = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// Health check
app.get('/', (req, res) => {
  res.json({ status: 'MealPrep OS Proxy running ✅' });
});

// ── GET any Clover endpoint ──
app.get('/clover', async (req, res) => {
  const token = req.headers['x-clover-token'];
  const { path, ...params } = req.query;
  if (!token) return res.status(401).json({ error: 'Missing x-clover-token header' });
  if (!path)  return res.status(400).json({ error: 'Missing path query param' });
  const qs  = new URLSearchParams(params).toString();
  const url = `https://api.clover.com${path}${qs ? '?' + qs : ''}`;
  try {
    const r = await fetch(url, {
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' }
    });
    const data = await r.json();
    res.status(r.status).json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST to any Clover endpoint ──
app.post('/clover', async (req, res) => {
  const token = req.headers['x-clover-token'];
  const { path } = req.query;
  if (!token) return res.status(401).json({ error: 'Missing x-clover-token header' });
  if (!path)  return res.status(400).json({ error: 'Missing path query param' });
  const url = `https://api.clover.com${path}`;
  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(req.body)
    });
    const data = await r.json();
    res.status(r.status).json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── PUT to any Clover endpoint ──
app.put('/clover', async (req, res) => {
  const token = req.headers['x-clover-token'];
  const { path } = req.query;
  if (!token) return res.status(401).json({ error: 'Missing x-clover-token header' });
  if (!path)  return res.status(400).json({ error: 'Missing path query param' });
  const url = `https://api.clover.com${path}`;
  try {
    const r = await fetch(url, {
      method: 'PUT',
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(req.body)
    });
    const data = await r.json();
    res.status(r.status).json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Stripe: Create Payment Intent ──
// POST /stripe/create-payment-intent
// Body: { amount, currency, location, metadata }
app.post('/stripe/create-payment-intent', async (req, res) => {
  const { amount, currency = 'usd', location, metadata = {} } = req.body;

  // Select the right Stripe secret key based on location
  const keyMap = {
    franklin:  process.env.STRIPE_SECRET_FRANKLIN,
    gulch:     process.env.STRIPE_SECRET_GULCH,
    henderson: process.env.STRIPE_SECRET_HENDERSON,
  };

  const secretKey = keyMap[location];
  if (!secretKey) {
    return res.status(400).json({ error: `No Stripe key configured for location: ${location}` });
  }

  try {
    const stripe = Stripe(secretKey);
    const paymentIntent = await stripe.paymentIntents.create({
      amount,       // in cents
      currency,
      metadata,
      automatic_payment_methods: { enabled: true },
    });
    res.json({ clientSecret: paymentIntent.client_secret });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => console.log(`Proxy running on port ${PORT}`));
