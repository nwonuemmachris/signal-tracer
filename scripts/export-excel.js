// Run on demand:  npm run export
require('../lib/export')().then(r => console.log(`Wrote ${r.rows} signals to ${r.file}`)).catch(e => { console.error(e); process.exit(1); });
