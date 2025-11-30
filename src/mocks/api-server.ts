import express from 'express';

const app = express();
app.use(express.json());

// Simulate enrichment: add `region` + occasional failure
app.post('/enrich', (req, res) => {
  const user = req.body;
  const fail = Math.random() < 0.10; // simulate 10% failure rate
  // const fail = false;

  if (fail) {
    return res.status(500).json({ error: 'API timeout' });
  }

  // Simulate latency
  setTimeout(() => {
    const region = user.country === 'US' ? 'NA' : 'INTL';
    res.json({ ...user, enriched: true, region });
  }, 200 + Math.random() * 300);
});

app.listen(3001, () => console.log('Mock API running on http://localhost:3001'));