require('dotenv').config();
const express = require('express');
const axios = require('axios');
const cors = require('cors');
const { createClient } = require('@libsql/client');
const jwt = require('jsonwebtoken');

const app = express();
app.use(express.json());
app.use(cors());

// BASE URL API ATLANTIC H2H
const ATLANTIC_BASE_URL = "https://atlantich2h.com/api";

// Database Turso Cloud SQLite
const db = createClient({
  url: process.env.TURSO_DATABASE_URL,
  authToken: process.env.TURSO_AUTH_TOKEN
});

// Auto-Create Database Tables & Auto Migration
async function initDb() {
    try {
        await db.execute(`CREATE TABLE IF NOT EXISTS products (
            id INTEGER PRIMARY KEY AUTOINCREMENT, 
            name TEXT, 
            price INTEGER, 
            stock INTEGER,
            image TEXT,
            category TEXT
        )`);
        
        try {
            await db.execute(`ALTER TABLE products ADD COLUMN image TEXT`);
        } catch (colErr) {}

        await db.execute(`CREATE TABLE IF NOT EXISTS transactions (
            id INTEGER PRIMARY KEY AUTOINCREMENT, 
            order_id TEXT UNIQUE, 
            customer_phone TEXT, 
            description TEXT, 
            amount INTEGER, 
            status TEXT, 
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )`);
        await db.execute(`CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT)`);
    } catch (e) {
        console.error("DB Init Error:", e);
    }
}
initDb();

const getSettings = async () => {
    try {
        const res = await db.execute("SELECT * FROM settings");
        const config = {};
        if (res.rows) res.rows.forEach(r => config[r.key] = r.value);
        return config;
    } catch (e) { return {}; }
};

const authenticateAdmin = (req, res, next) => {
    const authHeader = req.headers.authorization;
    if (!authHeader) return res.status(401).json({ message: "Akses ditolak: Token tidak ditemukan" });
    const token = authHeader.split(' ')[1];
    try {
        req.admin = jwt.verify(token, process.env.JWT_SECRET);
        next();
    } catch (e) { res.status(403).json({ message: "Sesi login kadaluarsa, silakan login ulang" }); }
};

// -------------------------------------------------------------
// PUBLIC & ATLANTIC H2H ENDPOINTS
// -------------------------------------------------------------

app.get('/api/settings/public', async (req, res) => {
    const config = await getSettings();
    res.json({ bg_music: config.bg_music || '' });
});

// Cek Profile / Saldo Atlantic H2H
app.get('/api/atlantic/profile', async (req, res) => {
    const config = await getSettings();
    const apiKey = config.atlantic_key || process.env.ATLANTIC_API_KEY;
    try {
        const response = await axios.post(`${ATLANTIC_BASE_URL}/get-profile`, {
            api_key: apiKey
        });
        res.json(response.data);
    } catch (err) {
        res.status(500).json({ status: false, message: "Gagal menghubungkan ke Atlantic H2H API" });
    }
});

// Layanan Prabayar Atlantic H2H
app.post('/api/atlantic/prabayar/layanan', async (req, res) => {
    const config = await getSettings();
    const apiKey = config.atlantic_key || process.env.ATLANTIC_API_KEY;
    try {
        const response = await axios.post(`${ATLANTIC_BASE_URL}/layanan/prabayar`, {
            api_key: apiKey
        });
        res.json(response.data);
    } catch (err) {
        res.status(500).json({ status: false, message: "Gagal mengambil data layanan Atlantic H2H" });
    }
});

// Transaksi Prabayar (Pulsa/Data/Game) via Atlantic H2H
app.post('/api/atlantic/prabayar/transaksi', async (req, res) => {
    const { code, target, phone } = req.body;
    const config = await getSettings();
    const apiKey = config.atlantic_key || process.env.ATLANTIC_API_KEY;
    const reffId = "REF-" + Date.now();

    try {
        const response = await axios.post(`${ATLANTIC_BASE_URL}/transaksi/create`, {
            api_key: apiKey,
            code: code,
            target: target,
            reff_id: reffId
        });

        if (response.data && response.data.status) {
            await db.execute({
                sql: "INSERT INTO transactions (order_id, customer_phone, description, amount, status) VALUES (?, ?, ?, ?, ?)",
                args: [reffId, phone, `Prabayar: ${code} ke ${target}`, response.data.data.price || 0, 'PENDING']
            });
            res.json({ success: true, data: response.data.data });
        } else {
            res.status(400).json({ success: false, message: response.data.message || "Transaksi H2H Gagal" });
        }
    } catch (err) {
        res.status(500).json({ success: false, message: "Gagal terhubung ke Atlantic H2H" });
    }
});

// Cek Tagihan Pascabayar (PLN/BPJS/PDAM) via Atlantic H2H
app.post('/api/atlantic/pascabayar/cek', async (req, res) => {
    const { code, target } = req.body;
    const config = await getSettings();
    const apiKey = config.atlantic_key || process.env.ATLANTIC_API_KEY;

    try {
        const response = await axios.post(`${ATLANTIC_BASE_URL}/pascabayar/cek`, {
            api_key: apiKey,
            code: code,
            target: target
        });
        res.json(response.data);
    } catch (err) {
        res.status(500).json({ status: false, message: "Gagal mengecek tagihan pascabayar" });
    }
});

// Transfer Bank via Atlantic H2H
app.post('/api/atlantic/transfer', async (req, res) => {
    const { bank_code, account_no, amount, phone } = req.body;
    const config = await getSettings();
    const apiKey = config.atlantic_key || process.env.ATLANTIC_API_KEY;
    const reffId = "TRF-" + Date.now();

    try {
        const response = await axios.post(`${ATLANTIC_BASE_URL}/transfer/create`, {
            api_key: apiKey,
            bank_code: bank_code,
            account_no: account_no,
            amount: amount,
            reff_id: reffId
        });

        if (response.data && response.data.status) {
            await db.execute({
                sql: "INSERT INTO transactions (order_id, customer_phone, description, amount, status) VALUES (?, ?, ?, ?, ?)",
                args: [reffId, phone, `Transfer ${bank_code} ke ${account_no}`, amount, 'PENDING']
            });
            res.json({ success: true, data: response.data.data });
        } else {
            res.status(400).json({ success: false, message: response.data.message || "Transfer Gagal" });
        }
    } catch (err) {
        res.status(500).json({ success: false, message: "Gagal memproses transfer bank" });
    }
});

// Request Deposit Saldo Otomatis via Atlantic H2H
app.post('/api/atlantic/deposit', async (req, res) => {
    const { nominal, method } = req.body;
    const config = await getSettings();
    const apiKey = config.atlantic_key || process.env.ATLANTIC_API_KEY;

    try {
        const response = await axios.post(`${ATLANTIC_BASE_URL}/deposit/create`, {
            api_key: apiKey,
            nominal: nominal,
            metode: method
        });
        res.json(response.data);
    } catch (err) {
        res.status(500).json({ status: false, message: "Gagal membuat tiket deposit" });
    }
});

// Manual Katalog Produk RianShop
app.get('/api/products', async (req, res) => {
    try {
        const result = await db.execute("SELECT * FROM products");
        res.json(result.rows || []);
    } catch (err) { res.status(500).json({ message: err.message }); }
});

app.post('/api/create-transaction', async (req, res) => {
    const { cart, phone } = req.body;
    if (!cart || cart.length === 0 || !phone) return res.status(400).json({ message: "Data tidak lengkap" });

    const config = await getSettings();
    const apiKey = config.api_key || process.env.CASAKU_API_KEY;
    const merchantId = config.merchant_id || process.env.CASAKU_MERCHANT_ID;

    let totalAmount = 0, itemsName = [];
    for (let item of cart) {
        const prodRes = await db.execute({ sql: "SELECT * FROM products WHERE id = ?", args: [item.id] });
        const prod = prodRes.rows[0];
        if (!prod || prod.stock < item.qty) return res.status(400).json({ message: `Stok produk ${item.name} habis!` });
        totalAmount += prod.price * item.qty;
        itemsName.push(`${prod.name} (${item.qty}x)`);
    }

    const orderId = "INV-" + Date.now();
    const host = req.headers.host;
    const protocol = req.headers['x-forwarded-proto'] || 'https';

    try {
        const response = await axios.post('https://api.casaku.id/v1/transaction/create', {
            merchant_id: merchantId,
            order_id: orderId,
            amount: totalAmount,
            customer_phone: phone,
            description: itemsName.join(', '),
            callback_url: `${protocol}://${host}/api/casaku-callback`
        }, {
            headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' }
        });

        if (response.data && response.data.payment_url) {
            await db.execute({
                sql: "INSERT INTO transactions (order_id, customer_phone, description, amount, status) VALUES (?, ?, ?, ?, ?)",
                args: [orderId, phone, itemsName.join(', '), totalAmount, 'PENDING']
            });
            res.json({ success: true, payment_url: response.data.payment_url });
        } else res.status(400).json({ message: "Gagal membuat invoice Casaku." });
    } catch (error) { res.status(500).json({ message: "Kesalahan server pembayaran." }); }
});

app.post('/api/casaku-callback', async (req, res) => {
    const { order_id, status, customer_phone, description, amount } = req.body;
    if (status === 'SUCCESS' || status === 'PAID') {
        await db.execute({ sql: "UPDATE transactions SET status = 'SUCCESS' WHERE order_id = ?", args: [order_id] });
        const productsRes = await db.execute("SELECT * FROM products");
        for (let p of productsRes.rows) {
            if (description.includes(p.name)) {
                await db.execute({ sql: "UPDATE products SET stock = MAX(0, stock - 1) WHERE id = ?", args: [p.id] });
            }
        }
        try {
            await axios.post('https://api.fonnte.com/send', {
                target: customer_phone,
                message: `*PEMBAYARAN SUCCESS!* 🎉\n\nNo. Order: ${order_id}\nProduk: ${description}\nTotal Bayar: Rp ${Number(amount).toLocaleString('id-ID')}\n\n*Terima kasih telah berbelanja di RianShop!*`
            }, { headers: { 'Authorization': process.env.WA_GATEWAY_TOKEN } });
        } catch (e) {}
        return res.status(200).json({ status: 'OK' });
    }
    res.status(400).json({ status: 'FAILED' });
});

// --- ADMIN ROUTES ---
app.post('/api/admin/login', (req, res) => {
    const { username, password } = req.body;
    if (username === process.env.ADMIN_USERNAME && password === process.env.ADMIN_PASSWORD) {
        const token = jwt.sign({ username }, process.env.JWT_SECRET, { expiresIn: '12h' });
        return res.json({ success: true, token });
    }
    res.status(401).json({ success: false, message: "Username/Password salah!" });
});

app.post('/api/admin/products', authenticateAdmin, async (req, res) => {
    try {
        const { name, price, stock, image } = req.body;
        await db.execute({ 
            sql: "INSERT INTO products (name, price, stock, image) VALUES (?, ?, ?, ?)", 
            args: [name, price, stock, image || ''] 
        });
        res.json({ success: true });
    } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

app.put('/api/admin/products/:id', authenticateAdmin, async (req, res) => {
    try {
        const { name, price, stock, image } = req.body;
        await db.execute({ 
            sql: "UPDATE products SET name = ?, price = ?, stock = ?, image = ? WHERE id = ?", 
            args: [name, price, stock, image || '', req.params.id] 
        });
        res.json({ success: true });
    } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

app.delete('/api/admin/products/:id', authenticateAdmin, async (req, res) => {
    try {
        await db.execute({ sql: "DELETE FROM products WHERE id = ?", args: [req.params.id] });
        res.json({ success: true });
    } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

app.get('/api/admin/settings', authenticateAdmin, async (req, res) => {
    const config = await getSettings();
    res.json(config);
});

app.post('/api/admin/settings', authenticateAdmin, async (req, res) => {
    const { merchant_id, api_key, bg_music, atlantic_key } = req.body;
    if (merchant_id !== undefined) await db.execute({ sql: "INSERT OR REPLACE INTO settings (key, value) VALUES ('merchant_id', ?)", args: [merchant_id] });
    if (api_key !== undefined) await db.execute({ sql: "INSERT OR REPLACE INTO settings (key, value) VALUES ('api_key', ?)", args: [api_key] });
    if (bg_music !== undefined) await db.execute({ sql: "INSERT OR REPLACE INTO settings (key, value) VALUES ('bg_music', ?)", args: [bg_music] });
    if (atlantic_key !== undefined) await db.execute({ sql: "INSERT OR REPLACE INTO settings (key, value) VALUES ('atlantic_key', ?)", args: [atlantic_key] });
    res.json({ success: true, message: "Pengaturan Disimpan!" });
});

module.exports = app;
      
