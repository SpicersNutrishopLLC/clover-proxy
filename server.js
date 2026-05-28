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

app.listen(PORT, () => console.log(`Proxy running on port ${PORT}`));
