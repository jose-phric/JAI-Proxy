const https = require('https');

https.get('https://openrouter.ai/', res => {
  console.log('✅ Connected successfully:', res.statusCode);
}).on('error', err => {
  console.error('🔴 TLS Error:', err);
});
