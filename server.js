const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');

const app = express();
const PORT = process.env.PORT || 3000;

// Allow requests from any browser origin (your dashboard)
app.use(cors());
app.use(express.json());

// Health check
app.get('/', (req, res) => {
  res.json({ status: 'MealPrep OS Proxy running ✅' });
});

// ── PROXY: GET any Clover endpoint ──────────────────────
// Usage: GET /clover?path=/v3/merchants/MERCHANT_ID/items&expand=itemStock
app.get('/clover', async (req, res) => {
  const token      = req.headers['x-clover-token'];
  const { path, ...params } = req.query;

  if (!token) return res.status(401).json({ error: 'Missing x-clover-token header' });
  if (!path)  return res.status(400).json({ error: 'Missing path query param' });

  // Build query string from remaining params
  const qs = new URLSearchParams(params).toString();
  const url = `https://api.clover.com${path}${qs ? '?' + qs : ''}`;

  try {
    const cloverRes = await fetch(url, {
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
      }
    });

    const data = await cloverRes.json();

    if (!cloverRes.ok) {
      return res.status(cloverRes.status).json(data);
    }

    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`Clover proxy running on port ${PORT}`);
});
