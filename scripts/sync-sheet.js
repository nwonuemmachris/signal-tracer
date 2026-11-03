// Run on demand:  npm run sync-sheet
require('../lib/sheets').sync().then(r => console.log(`Google Sheet updated: ${r.rows} signals`)).catch(e => { console.error(e.message); process.exit(1); });
