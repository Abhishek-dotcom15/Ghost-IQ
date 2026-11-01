const express = require('express');
const cors = require('cors');
const path = require('path');

const app = express();
const PORT = 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Mock endpoints
app.post('/api/auth/login', (req, res) => {
  const { email, password } = req.body;
  console.log(`[Target App] Login attempt: email=${email}`);

  if (!email || !password) {
    return res.status(400).json({ error: 'Email and password are required' });
  }

  // Simulate invalid email validation failure
  if (email === 'invalid-email-format') {
    return res.status(400).json({ error: 'Please enter a valid email address structure.' });
  }

  res.json({
    success: true,
    token: 'jwt-token-abcd-1234',
    user: { email, role: 'admin' }
  });
});

app.get('/api/slow-items', async (req, res) => {
  console.log(`[Target App] Slow items fetch initiated`);
  // Delay response by 1.5 seconds
  await new Promise(resolve => setTimeout(resolve, 1500));
  res.json({
    items: [
      { id: 1, name: 'Cloud Server Instance', status: 'active' },
      { id: 2, name: 'Postgres DB Node', status: 'degraded' }
    ]
  });
});

app.get('/api/broken', (req, res) => {
  console.log(`[Target App] Broken route hit`);
  res.status(500).json({ error: 'Database Connection Timeout Error.' });
});

app.listen(PORT, () => {
  console.log(`🎯 Mock Target App running on http://localhost:${PORT}`);
});
