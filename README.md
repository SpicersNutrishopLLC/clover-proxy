# clover-proxy

Serves two things:

- **MealPrep OS** routes (`/clover`, `/clover-charge`, `/clover-print`, `/clover-pakms`) — unchanged.
- **Nutrishop Inventory** API at `/api/*` and dashboard at `/app/`. The Clover tokens for
  the inventory live only in Render environment variables, and the dashboard needs a password.

## Inventory API

| Route | What it does |
|---|---|
| `GET /api/health` | Wake-up / config check (no login) |
| `POST /api/login` `{password}` | Returns a 12-hour sign-in token |
| `GET /api/inventory[?fresh=1]` | All three stores, merged by product name (cached 30s) |
| `POST /api/items/update` `{changes:[{store,itemId,price?,cost?,qty?}]}` | Edits; only fields sent are changed |
| `POST /api/items/create` `{name,sku?,code?,category?,price,cost,stores:{franklin:{qty,price?,cost?},…}}` | Creates a product at the chosen stores |

Prices are in dollars in requests; Clover stores cents.

## Environment variables

See `.env.example`. `SESSION_SECRET` should be a long random string (e.g. run
`openssl rand -hex 32`). Changing it signs everyone out.

## Run locally

```
npm install
FRANKLIN_MERCHANT_ID=… FRANKLIN_TOKEN=… (etc) INVENTORY_PASSWORD=… SESSION_SECRET=… npm start
# open http://localhost:3000/app/
```

## Dashboard hosting

`public/index.html` works in two places:
- served by this server at `https://clover-proxy-hs3q.onrender.com/app/`
- on Firebase (`nstninventory.web.app`) — it then calls the Render API automatically.
