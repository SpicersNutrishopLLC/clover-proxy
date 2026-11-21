# clover-proxy

Serves two things:

- **MealPrep OS** routes (`/clover`, `/clover-charge`, `/clover-print`, `/clover-pakms`) — unchanged.
- **Nutrishop Inventory** API at `/api/*` and dashboard at `/app/`. The Clover tokens for
  the inventory live only in Render environment variables, and the dashboard needs a password.

## Inventory API

| Route | What it does |
|---|---|
| `GET /api/health` | Wake-up / config check (no login) |
| `POST /api/login` `{username,password}` | Returns a 30-day sign-in token |
| `GET /api/inventory[?fresh=1]` | All three stores, merged by product name (cached 30s) |
| `POST /api/items/update` `{changes:[{store,itemId,price?,cost?,qty?}]}` | Edits; only fields sent are changed |
| `POST /api/items/create` `{name,sku?,code?,category?,price,cost,stores:{franklin:{qty,price?,cost?},…}}` | Creates a product at the chosen stores |

Prices are in dollars in requests; Clover stores cents. Inventory, item edits and new products
are admin-only.

### People, counts and history (Postgres)

| Route | Who | What it does |
|---|---|---|
| `GET/POST /api/users`, `POST /api/users/:id` | admin | List, add, edit, turn off people |
| `GET /api/counts/stores` | all | Each store's open count and last count |
| `POST /api/counts` `{store}` | all | Start or rejoin the store's open count |
| `GET /api/counts/:id`, `PUT /api/counts/:id/lines` | all | Count sheet; autosave `[{itemId,counted}]` |
| `GET /api/counts/:id/review` | all | Differences vs Clover right now (costs for admins only) |
| `POST /api/counts/:id/submit` | all | Writes counted quantities to Clover (only this touches Clover) |
| `POST /api/counts/:id/discard`, `/retry` | admin/starter, admin | Throw away; retry failed lines |
| `GET /api/reports/counts[/:id]`, `/api/reports/edits` | admin | Count history; manual changes |

On first start with an empty database, an `admin` account is created with `INVENTORY_PASSWORD`.
Tables are created automatically (see `db.js`).

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
