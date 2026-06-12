const express = require('express');
const cors    = require('cors');
const fetch   = require('node-fetch');

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

// ── GET Clover PAKMS key ──
app.get('/clover-pakms', async (req, res) => {
  const token = req.headers['x-clover-token'];
  if (!token) return res.status(401).json({ error: 'Missing x-clover-token header' });
  try {
    const r = await fetch('https://api.clover.com/pakms/apikey', {
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' }
    });
    const data = await r.json();
    res.status(r.status).json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST Clover Ecommerce charge ──
app.post('/clover-charge', async (req, res) => {
  const { amount, source, orderId, currency = 'USD', location, merchantId, clientIp } = req.body;
  if (!amount || !source) return res.status(400).json({ error: 'Missing amount or source' });

  const ecommTokenMap = {
    gulch:     process.env.CLOVER_ECOMM_GULCH,
    franklin:  process.env.CLOVER_ECOMM_FRANKLIN,
    henderson: process.env.CLOVER_ECOMM_HENDERSON,
  };
  const ecommToken = ecommTokenMap[location];
  if (!ecommToken) return res.status(400).json({ error: `No ecomm token for location: ${location}` });

  try {
    const body = { amount, source, currency, capture: true };
    if (orderId) body.order = { id: orderId };

    const headers = {
      'Authorization':   `Bearer ${ecommToken}`,
      'Content-Type':    'application/json',
      'x-forwarded-for': clientIp || req.ip || '127.0.0.1',
    };
    if (merchantId) headers['X-Clover-Merchant-Id'] = merchantId;

    console.log(`[charge] location=${location} amount=${amount} orderId=${orderId||'none'}`);
    const r    = await fetch('https://scl.clover.com/v1/charges', { method: 'POST', headers, body: JSON.stringify(body) });
    const data = await r.json();
    console.log(`[charge] status=${r.status} response=${JSON.stringify(data).substring(0,200)}`);
    res.status(r.status).json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST Clover print event (fires kitchen printer) ──
app.post('/clover-print', async (req, res) => {
  const token = req.headers['x-clover-token'];
  const { merchantId, orderId } = req.body;
  if (!token)     return res.status(401).json({ error: 'Missing x-clover-token header' });
  if (!merchantId || !orderId) return res.status(400).json({ error: 'Missing merchantId or orderId' });

  const url = `https://api.clover.com/v3/merchants/${merchantId}/print_event`;
  try {
    console.log(`[print] merchant=${merchantId} order=${orderId}`);
    const r    = await fetch(url, {
      method:  'POST',
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
      body:    JSON.stringify({ order: { id: orderId } })
    });
    const text = await r.text();
    console.log(`[print] status=${r.status} response=${text.substring(0,200)}`);
    res.status(r.status).json({ status: r.status, response: text });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => console.log(`Proxy running on port ${PORT}`));
