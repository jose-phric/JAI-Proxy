const express = require('express');
const cors = require('cors');
const app = express();
const port = 3000;

app.use(cors()); // allow CORS
app.use(express.json());

app.use((req, res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.path}`);
  next();
});

app.post('/completions', (req, res) => {
  console.log('Headers:', req.headers);
  console.log('Body:', req.body);
  res.json({ message: 'Received', echo: req.body });
});

app.listen(port, () => {
  console.log(`✅ Server running at http://localhost:${port}`);
});
