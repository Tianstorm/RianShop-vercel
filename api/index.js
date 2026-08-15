require('dotenv').config();
const express = require('express');
const axios = require('axios');
const cors = require('cors');
const { createClient } = require('@libsql/client');
const jwt = require('jsonwebtoken');

const app = express();
app.use(express.json());
app.use(cors());

// Koneksi Database Turso Cloud SQLite
const db = createClient({
  url: process.env.TURSO_DATABASE_URL,
  authToken: process.env.TURSO_AUTH_TOKEN
});

// Auto-Create Database Tables
async function initDb() {
    try {
        await db.execute(`CREATE TABLE IF NOT EXISTS products (
            id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT, price INTEGER, stock INTEGER
        )`);
        await db.execute(`CREATE TABLE IF NOT EXISTS transactions (
            id INTEGER PRIMARY KEY AUTOINCREMENT, order_id TEXT UNIQUE, customer_phone TEXT, description TEXT, amount INTEGER, status TEXT, created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )`);
        await db.execute(`CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT)`);
    } catch (e) {
        console.error("DB Init Error:", e);
    }
}
initDb();

const getCasakuConfig = async () => {
    try {
        const res = await db.execute("SELECT * FROM settings");
        const config = {};
        if (res.rows) res.rows.forEach(r => config[r.key] = r.value);
        return config;
    } catch (e) { return {}; }
};

const authenticateAdmin = (req, res, next) => {
    const authHeader = req.headers.authorization;
    if (!authHeader) return res.status(401).json({ message: "Akses ditolak" });
    const token = authHeader.split(' ')[1];
    try {
        req.admin = jwt.verify(token, process.env.JWT_SECRET);
        next();
    } catch (e) { res.status(403).json({ message: "Token tidak valid" }); }
};

// -------------------------------------------------------------
// PUBLIC ENDPOINTS
// -------------------------------------------------------------
app.get('/api/products', async (req, res) => {
    try {
        const result = await db.execute("SELECT * FROM products");
        res.json(result.rows || []);
    } catch (err) { res.status(500).json({ message: err.message }); }
});

app.post('/api/create-transaction', async (req, res) => {
    const { cart, phone } = req.body;
    if (!cart || cart.length === 0 || !phone) return res.status(400).json({ message: "Data tidak lengkap" });

    const config = await getCasakuConfig();
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

// -------------------------------------------------------------
// ADMIN ENDPOINTS
// -------------------------------------------------------------
app.post('/api/admin/login', (req, res) => {
    const { username, password } = req.body;
    if (username === process.env.ADMIN_USERNAME && password === process.env.ADMIN_PASSWORD) {
        const token = jwt.sign({ username }, process.env.JWT_SECRET, { expiresIn: '12h' });
        return res.json({ success: true, token });
    }
    res.status(401).json({ success: false, message: "Username/Password salah!" });
});

app.post('/api/admin/products', authenticateAdmin, async (req, res) => {
    const { name, price, stock } = req.body;
    await db.execute({ sql: "INSERT INTO products (name, price, stock) VALUES (?, ?, ?)", args: [name, price, stock] });
    res.json({ success: true });
});

app.put('/api/admin/products/:id', authenticateAdmin, async (req, res) => {
    const { name, price, stock } = req.body;
    await db.execute({ sql: "UPDATE products SET name = ?, price = ?, stock = ? WHERE id = ?", args: [name, price, stock, req.params.id] });
    res.json({ success: true });
});

app.delete('/api/admin/products/:id', authenticateAdmin, async (req, res) => {
    await db.execute({ sql: "DELETE FROM products WHERE id = ?", args: [req.params.id] });
    res.json({ success: true });
});

app.get('/api/admin/transactions', authenticateAdmin, async (req, res) => {
    const result = await db.execute("SELECT * FROM transactions ORDER BY id DESC");
    res.json(result.rows || []);
});

app.get('/api/admin/settings', authenticateAdmin, async (req, res) => {
    const config = await getCasakuConfig();
    res.json(config);
});

app.post('/api/admin/settings', authenticateAdmin, async (req, res) => {
    const { merchant_id, api_key } = req.body;
    await db.execute({ sql: "INSERT OR REPLACE INTO settings (key, value) VALUES ('merchant_id', ?)", args: [merchant_id] });
    await db.execute({ sql: "INSERT OR REPLACE INTO settings (key, value) VALUES ('api_key', ?)", args: [api_key] });
    res.json({ success: true, message: "Pengaturan Disimpan!" });
});

module.exports = app;
          
