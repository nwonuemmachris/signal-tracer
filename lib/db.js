require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const opts = { auth: { persistSession: false } };
exports.admin = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, opts);
exports.anon = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY, opts);
