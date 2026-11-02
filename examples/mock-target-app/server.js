// GhostIQ demo shop: a small app with deliberately planted, labelled bugs.
// Every bug is listed in bugs.json (id, category, where, how it should be detected).
// The benchmark (scripts/bench-bugs.mjs) measures how many GhostIQ finds.
//
// DO NOT copy any of this into a real app: the bugs are intentional.
const express = require('express');
const path = require('path');

const app = express();
const PORT = Number(process.env.PORT) || 3000;
// BUG-VISUAL-REGRESSION: when set, the cart's order button moves and changes colour.
const VISUAL_REGRESSION = process.env.MOCK_VISUAL_REGRESSION === '1';

// BUG-POWERED-BY: Express advertises itself (x-powered-by is left enabled).
// BUG-SEC-HEADERS: no Content-Security-Policy, no X-Content-Type-Options anywhere.
app.use(express.json());

const page = (name) => (_req, res) => res.sendFile(path.join(__dirname, 'public', name));

// A well-formed 404 page (the broken links are the bug, not this page).
const NOT_FOUND_PAGE =
  '<!doctype html><html lang="en"><head><title>Not found - Ghost Shop</title></head><body><main><h1>404: page not found</h1><a href="/">Back to the shop</a></main></body></html>';

// ---------------------------------------------------------------- state (in memory)
const products = [
  { id: 1, name: 'Ghost Hoodie', price: 49 },
  { id: 2, name: 'Phantom Mug', price: 12 },
  { id: 3, name: 'Specter Socks', price: 9 },
];
let cart = [];
const orders = [];
const users = [];

// Test-only UI change (POST /__ui): the login button's label, to exercise replay healing.
const DEFAULT_LOGIN_LABEL = 'Sign In';
let loginLabel = DEFAULT_LOGIN_LABEL;
const fs = require('fs');

// ---------------------------------------------------------------- pages
app.get('/', (req, res) => {
  if (loginLabel === DEFAULT_LOGIN_LABEL) return page('index.html')(req, res);
  const html = fs.readFileSync(path.join(__dirname, 'public', 'index.html'), 'utf8');
  res
    .type('html')
    .send(html.replace(`>${DEFAULT_LOGIN_LABEL}</button>`, `>${loginLabel}</button>`));
});
app.get('/products', page('products.html'));
app.get('/products/:id', (req, res) => {
  // BUG-BROKEN-LINK-PRODUCT99: the catalogue links to a product that does not exist.
  if (!products.some((p) => String(p.id) === req.params.id)) {
    return res.status(404).send(NOT_FOUND_PAGE);
  }
  page('product.html')(req, res);
});
app.get('/cart', (req, res) => {
  if (VISUAL_REGRESSION) return page('cart-v2.html')(req, res);
  page('cart.html')(req, res);
});
app.get('/signup', page('signup.html'));
app.get('/orders', page('orders.html'));
// BUG-ADMIN-NO-AUTH: the admin page is served to anyone, logged in or not.
app.get('/admin', page('admin.html'));
// BUG-IDOR-ACCOUNT: any account id can be viewed by changing the URL.
app.get('/account/:id', page('account.html'));
// BUG-REDIRECT-LOOP: two pages redirect to each other forever.
app.get('/old-promo', (_req, res) => res.redirect('/promo'));
app.get('/promo', (_req, res) => res.redirect('/old-promo'));
// BUG-BROKEN-LINK-HELP: /help is linked from every page but does not exist (falls to 404).

// ---------------------------------------------------------------- API
app.post('/api/auth/login', (req, res) => {
  const { email, password } = req.body ?? {};
  if (!email || !password)
    return res.status(400).json({ error: 'Email and password are required' });
  if (email === 'invalid-email-format') {
    return res.status(400).json({ error: 'Please enter a valid email address structure.' });
  }
  // BUG-INSECURE-COOKIE: session cookie without HttpOnly or SameSite.
  res.setHeader('Set-Cookie', 'session=demo-session-token; Path=/');
  res.json({ success: true, user: { email, role: 'admin' } });
});

app.get('/api/products', async (req, res) => {
  // BUG-SLOW-PRODUCTS: every catalogue load takes 1.6 s.
  await new Promise((r) => setTimeout(r, 1600));
  const q = String(req.query.q ?? '').toLowerCase();
  res.json({
    query: req.query.q ?? '',
    items: products.filter((p) => p.name.toLowerCase().includes(q)),
  });
});

app.get('/api/products/:id', (req, res) => {
  const product = products.find((p) => String(p.id) === req.params.id);
  if (!product) return res.status(404).json({ error: 'Product not found' });
  if (product.id === 3) {
    // BUG-5XX-PRODUCT3 + BUG-STACK-TRACE: a crash leaks the stack trace to the client.
    return res.status(500).json({
      error: "TypeError: Cannot read properties of undefined (reading 'inventory')",
      stack:
        "TypeError: Cannot read properties of undefined (reading 'inventory')\n    at getStock (/srv/shop/src/inventory.js:42:17)\n    at /srv/shop/src/routes/products.js:88:21",
    });
  }
  res.json(product);
});

app.post('/api/cart', (req, res) => {
  // BUG-DOUBLE-CART: no idempotency, a double click adds the item twice.
  const product = products.find((p) => p.id === Number(req.body?.productId));
  if (!product) return res.status(400).json({ error: 'Unknown product' });
  cart.push({ ...product, quantity: 1 });
  res.status(201).json({ items: cart });
});

app.get('/api/cart', (_req, res) => res.json({ items: cart }));

app.post('/api/orders', (req, res) => {
  const quantity = Number(req.body?.quantity ?? 1);
  // BUG-QTY-BOUNDARY-500: large or odd quantities crash the server instead of a 400.
  if (!Number.isFinite(quantity) || quantity > 99) {
    return res.status(500).json({ error: 'Internal Server Error' });
  }
  // BUG-DOUBLE-ORDER: a double submit creates two orders.
  const order = { id: orders.length + 1, items: cart.length, quantity, createdAt: Date.now() };
  orders.push(order);
  res.status(201).json(order);
});

// BUG-HANG-ORDERS: order history never responds; the page spins forever.
app.get('/api/orders/history', () => {});

app.post('/api/signup', (req, res) => {
  // BUG-VALIDATION-SIGNUP: no server-side validation at all. Empty, malformed or
  // absurd values are accepted with 201.
  const user = { id: users.length + 1, ...req.body };
  users.push(user);
  res.status(201).json(user);
});

// BUG-DEBUG-ENDPOINT: a forgotten debug endpoint leaks configuration secrets.
app.get('/api/debug', (_req, res) => {
  res.json({
    node: process.version,
    config: {
      db_password: 'hunter2-prod',
      stripe_api_key: 'sk_live_51Hdemo0000000000',
      debug: true,
    },
  });
});

app.get('/api/slow-items', async (_req, res) => {
  // BUG-SLOW-ITEMS: microservice list takes 1.5 s.
  await new Promise((r) => setTimeout(r, 1500));
  res.json({
    items: [
      { id: 1, name: 'Cloud Server Instance', status: 'active' },
      { id: 2, name: 'Postgres DB Node', status: 'degraded' },
    ],
  });
});

app.get('/api/broken', (_req, res) => {
  // BUG-5XX-DB: the "Trigger DB Call" button always fails.
  res.status(500).json({ error: 'Database Connection Timeout Error.' });
});

// Test-only: reset state between benchmark runs.
app.post('/__reset', (_req, res) => {
  cart = [];
  orders.length = 0;
  users.length = 0;
  loginLabel = DEFAULT_LOGIN_LABEL;
  res.json({ ok: true });
});

// Test-only: simulate a UI change (renamed login button) without restarting.
app.post('/__ui', (req, res) => {
  const label = typeof req.body?.loginLabel === 'string' ? req.body.loginLabel.slice(0, 40) : '';
  loginLabel = label.replace(/[<>&"]/g, '') || DEFAULT_LOGIN_LABEL;
  res.json({ ok: true, loginLabel });
});

app.use(express.static(path.join(__dirname, 'public'), { index: false }));
app.use((_req, res) => res.status(404).send(NOT_FOUND_PAGE));

app.listen(PORT, () => {
  console.log(
    `🎯 GhostIQ demo shop on http://localhost:${PORT}${VISUAL_REGRESSION ? ' (visual regression ON)' : ''}`,
  );
});
