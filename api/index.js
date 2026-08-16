require('dotenv').config();
const express = require('express');
const axios = require('axios');
const cors = require('cors');
const jwt = require('jsonwebtoken');

const app = express();
app.use(express.json());
app.use(cors());

// BASE URL API ATLANTIC H2H
const ATLANTIC_BASE_URL = "https://atlantich2h.com/api";

// -------------------------------------------------------------
// FUNKSI DATABASE TURSO HTTP REST API MURNI (BEBAS ERROR MIGRATION 400)
// -------------------------------------------------------------
async function queryTurso(sql, args = []) {
    const rawUrl = process.env.TURSO_DATABASE_URL || '';
    const httpUrl = rawUrl.replace('libsql://', 'https://');

    const formattedArgs = args.map(arg => {
        if (typeof arg === 'number') return { type: "integer", value: String(arg) };
        if (arg === null || arg === undefined) return { type: "null" };
        return { type: "text", value: String(arg) };
    });

    const response = await axios.post(
        `${httpUrl}/v2/pipeline`,
        {
            requests: [
                { type: "execute", stmt: { sql: sql, args: formattedArgs } },
                { type: "close" }
            ]
        },
        {
            headers: {
                'Authorization': `Bearer ${process.env.TURSO_AUTH_TOKEN}`,
                'Content-Type': 'application/json'
            }
        }
    );

    const result = response.data.results[0];
    if (result.type === "error") throw new Error(result.error.message);

    const execResult = result.response.result;
    const cols = execResult.cols.map(c => c.name);
    const rows = execResult.rows.map(row => {
        const obj = {};
        row.forEach((cell, idx) => {
            let val = cell.value;
            if (cell.type === "integer") val = Number(val);
            obj[cols[idx]] = val;
        });
        return obj;
    });

    return { rows };
}

const getSettings = async () => {
    try {
        const res = await queryTurso("SELECT * FROM settings");
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
    } catch (e) { res.status(403).json({ message: "Sesi login kadaluarsa" }); }
};

// Helper Request Form-Data ke Atlantic H2H
async function postAtlantic(endpoint, params) {
    const searchParams = new URLSearchParams();
    for (const key in params) {
        if (params[key] !== undefined && params[key] !== null) {
            searchParams.append(key, params[key]);
        }
    }
    return await axios.post(`${ATLANTIC_BASE_URL}${endpoint}`, searchParams, {
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
    });
}

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
        const response = await postAtlantic('/get-profile', { api_key: apiKey });
        res.json(response.data);
    } catch (err) {
        const errMsg = err.response?.data?.message || err.message;
        res.status(500).json({ status: false, message: `Atlantic: ${errMsg}` });
    }
});

// Layanan Prabayar Atlantic H2H
app.post('/api/atlantic/prabayar/layanan', async (req, res) => {
    const config = await getSettings();
    const apiKey = config.atlantic_key || process.env.ATLANTIC_API_KEY;
    try {
        const response = await postAtlantic('/layanan/prabayar', { api_key: apiKey });
        res.json(response.data);
    } catch (err) {
        const errMsg = err.response?.data?.message || err.message;
        res.status(500).json({ status: false, message: `Atlantic: ${errMsg}` });
    }
});

// Transaksi Prabayar (Pulsa/Data/Game) via Atlantic H2H
app.post('/api/atlantic/prabayar/transaksi', async (req, res) => {
    const { code, target, phone } = req.body;
    const config = await getSettings();
    const apiKey = config.atlantic_key || process.env.ATLANTIC_API_KEY;
    const reffId = "REF-" + Date.now();

    try {
        const response = await postAtlantic('/transaksi/create', {
            api_key: apiKey,
            code: code,
            target: target,
            reff_id: reffId
        });

        if (response.data && response.data.status) {
            await queryTurso(
                "INSERT INTO transactions (order_id, customer_phone, description, amount, status) VALUES (?, ?, ?, ?, ?)",
                [reffId, phone, `Prabayar: ${code} ke ${target}`, response.data.data?.price || 0, 'PENDING']
            );
            res.json({ success: true, data: response.data.data });
        } else {
            res.status(400).json({ success: false, message: response.data?.message || "Transaksi H2H Gagal" });
        }
    } catch (err) {
        const errMsg = err.response?.data?.message || err.message;
        res.status(500).json({ success: false, message: `Atlantic: ${errMsg}` });
    }
});

// Cek Tagihan Pascabayar (PLN/BPJS/PDAM) via Atlantic H2H
app.post('/api/atlantic/pascabayar/cek', async (req, res) => {
    const { code, target } = req.body;
    const config = await getSettings();
    const apiKey = config.atlantic_key || process.env.ATLANTIC_API_KEY;

    try {
        const response = await postAtlantic('/pascabayar/cek', {
            api_key: apiKey,
            code: code,
            target: target
        });
        res.json(response.data);
    } catch (err) {
        const errMsg = err.response?.data?.message || err.message;
        res.status(500).json({ status: false, message: `Atlantic: ${errMsg}` });
    }
});

// Transfer Bank via Atlantic H2H
app.post('/api/atlantic/transfer', async (req, res) => {
    const { bank_code, account_no, amount, phone } = req.body;
    const config = await getSettings();
    const apiKey = config.atlantic_key || process.env.ATLANTIC_API_KEY;
    const reffId = "TRF-" + Date.now();

    try {
        const response = await postAtlantic('/transfer/create', {
            api_key: apiKey,
            bank_code: bank_code,
            account_no: account_no,
            amount: amount,
            reff_id: reffId
        });

        if (response.data && response.data.status) {
            await queryTurso(
                "INSERT INTO transactions (order_id, customer_phone, description, amount, status) VALUES (?, ?, ?, ?, ?)",
                [reffId, phone, `Transfer ${bank_code} ke ${account_no}`, amount, 'PENDING']
            );
            res.json({ success: true, data: response.data.data });
        } else {
            res.status(400).json({ success: false, message: response.data?.message || "Transfer Gagal" });
        }
    } catch (err) {
        const errMsg = err.response?.data?.message || err.message;
        res.status(500).json({ success: false, message: `Atlantic: ${errMsg}` });
    }
});

// Request Deposit Saldo Otomatis via Atlantic H2H
app.post('/api/atlantic/deposit', async (req, res) => {
    const { nominal, method } = req.body;
    const config = await getSettings();
    const apiKey = config.atlantic_key || process.env.ATLANTIC_API_KEY;

    try {
        const response = await postAtlantic('/deposit/create', {
            api_key: apiKey,
            nominal: nominal,
            metode: method
        });
        res.json(response.data);
    } catch (err) {
        const errMsg = err.response?.data?.message || err.message;
        res.status(500).json({ status: false, message: `Atlantic: ${errMsg}` });
    }
});

// Manual Katalog Produk RianShop
app.get('/api/products', async (req, res) => {
    try {
        const result = await queryTurso("SELECT * FROM products");
        res.json(result.rows || []);
    } catch (err) { res.status(500).json({ message: err.message }); }
});

// Transaksi Checkout Casaku
app.post('/api/generate/qris', async (req, res) => {
    const { cart, phone } = req.body;
    if (!cart || cart.length === 0 || !phone) return res.status(400).json({ message: "Data tidak lengkap" });

    const config = await getSettings();
    const apiKey = config.api_key || process.env.CASAKU_API_KEY;
    const merchantId = config.id || process.env.CASAKU_MERCHANT_ID;

    let totalAmount = 0, itemsName = [];
    for (let item of cart) {
        const prodRes = await queryTurso("SELECT * FROM products WHERE id = ?", [item.id]);
        const prod = prodRes.rows[0];
        if (!prod || prod.stock < item.qty) return res.status(400).json({ message: `Stok produk ${item.name} habis!` });
        totalAmount += prod.price * item.qty;
        itemsName.push(`${prod.name} (${item.qty}x)`);
    }

    const orderId = "INV-" + Date.now();
    const host = req.headers.host;
    const protocol = req.headers['x-forwarded-proto'] || 'https';

    try {
        const response = await axios.post('https://api.casaku.id/api/generate/qris', {
            id: merchantId,
            order_id: orderId,
            amount: totalAmount,
            customer_phone: phone,
            description: itemsName.join(', '),
            callback_url: `${protocol}://${host}/api/casaku-callback`
        }, {
            headers: { 'Authorization': `Bearer ${apiKey}`, 'x-license-key': apiKey, 'Content-Type': 'application/json' }
        });

        if (response.data && response.data.payment_url) {
            await queryTurso(
                "INSERT INTO transactions (order_id, customer_phone, description, amount, status) VALUES (?, ?, ?, ?, ?)",
                [orderId, phone, itemsName.join(', '), totalAmount, 'PENDING']
            );
            res.json({ success: true, payment_url: response.data.payment_url });
        } else {
            res.status(400).json({ message: response.data?.message || "Gagal membuat invoice Casaku." });
        }
    } catch (error) {
        const errMsg = error.response?.data?.message || error.message;
        res.status(500).json({ message: `Casaku Error: ${errMsg}` });
    }
});

app.post('/api/casaku-callback', async (req, res) => {
    const { order_id, status, customer_phone, description, amount } = req.body;
    if (status === 'SUCCESS' || status === 'PAID') {
        await queryTurso("UPDATE transactions SET status = 'SUCCESS' WHERE order_id = ?", [order_id]);
        const productsRes = await queryTurso("SELECT * FROM products");
        for (let p of productsRes.rows) {
            if (description.includes(p.name)) {
                await queryTurso("UPDATE products SET stock = MAX(0, stock - 1) WHERE id = ?", [p.id]);
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
        await queryTurso(
            "INSERT INTO products (name, price, stock, image) VALUES (?, ?, ?, ?)",
            [name, price, stock, image || '']
        );
        res.json({ success: true });
    } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

app.put('/api/admin/products/:id', authenticateAdmin, async (req, res) => {
    try {
        const { name, price, stock, image } = req.body;
        await queryTurso(
            "UPDATE products SET name = ?, price = ?, stock = ?, image = ? WHERE id = ?",
            [name, price, stock, image || '', req.params.id]
        );
        res.json({ success: true });
    } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

app.delete('/api/admin/products/:id', authenticateAdmin, async (req, res) => {
    try {
        await queryTurso("DELETE FROM products WHERE id = ?", [req.params.id]);
        res.json({ success: true });
    } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

app.get('/api/admin/settings', authenticateAdmin, async (req, res) => {
    const config = await getSettings();
    res.json(config);
});

app.post('/api/admin/settings', authenticateAdmin, async (req, res) => {
    const { merchant_id, api_key, bg_music, atlantic_key } = req.body;
    if (merchant_id !== undefined) await queryTurso("INSERT OR REPLACE INTO settings (key, value) VALUES ('merchant_id', ?)", [merchant_id]);
    if (api_key !== undefined) await queryTurso("INSERT OR REPLACE INTO settings (key, value) VALUES ('api_key', ?)", [api_key]);
    if (bg_music !== undefined) await queryTurso("INSERT OR REPLACE INTO settings (key, value) VALUES ('bg_music', ?)", [bg_music]);
    if (atlantic_key !== undefined) await queryTurso("INSERT OR REPLACE INTO settings (key, value) VALUES ('atlantic_key', ?)", [atlantic_key]);
    res.json({ success: true, message: "Pengaturan Disimpan!" });
});

module.exports = app;
