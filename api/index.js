require('dotenv').config();
const express = require('express');
const axios = require('axios');
const cors = require('cors');
const jwt = require('jsonwebtoken');

const app = express();
// Menaikkan limit payload agar muat upload file audio Base64
app.use(express.json({ limit: '15mb' }));
app.use(express.urlencoded({ limit: '15mb', extended: true }));
app.use(cors());

// BASE URL APIs
const ATLANTIC_BASE_URL = "https://atlantich2h.com/api";
const CASAKU_BASE_URL = "https://api.casaku.id";

async function queryTurso(sql, args = []) {
    const rawUrl = process.env.TURSO_DATABASE_URL || '';
    const token = process.env.TURSO_AUTH_TOKEN || '';

    if (!rawUrl || !token) throw new Error("TURSO credentials not set!");

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
        { headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' } }
    );

    const result = response.data.results[0];
    if (result.type === "error") throw new Error(result.error.message);

    const execResult = result.response.result;
    const cols = execResult.cols.map(c => c.name);
    return {
        rows: execResult.rows.map(row => {
            const obj = {};
            row.forEach((cell, idx) => {
                let val = cell.value;
                if (cell.type === "integer") val = Number(val);
                obj[cols[idx]] = val;
            });
            return obj;
        })
    };
}

const getSettings = async () => {
    try {
        if (!process.env.TURSO_DATABASE_URL || !process.env.TURSO_AUTH_TOKEN) return {};
        const res = await queryTurso("SELECT * FROM settings");
        const config = {};
        if (res && res.rows) res.rows.forEach(r => config[r.key] = r.value);
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

async function postAtlantic(endpoint, params) {
    const searchParams = new URLSearchParams();
    for (const key in params) {
        if (params[key] !== undefined && params[key] !== null) searchParams.append(key, params[key]);
    }
    return await axios.post(`${ATLANTIC_BASE_URL}${endpoint}`, searchParams, {
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
    });
}

// -------------------------------------------------------------
// PUBLIC ENDPOINTS
// -------------------------------------------------------------

app.get('/api/settings/public', async (req, res) => {
    const config = await getSettings();
    let playlist = [];
    try {
        if (config.playlist_data) playlist = JSON.parse(config.playlist_data);
    } catch(e) {}
    res.json({ bg_music: config.bg_music || '', playlist: playlist });
});

app.get('/api/products', async (req, res) => {
    try {
        const result = await queryTurso("SELECT * FROM products");
        res.json(result.rows || []);
    } catch (err) { res.status(500).json({ message: err.message }); }
});

// -------------------------------------------------------------
// ATLANTIC H2H & CASAKU ENDPOINTS
// -------------------------------------------------------------

app.get('/api/atlantic/profile', async (req, res) => {
    const config = await getSettings();
    const apiKey = config.atlantic_key || process.env.ATLANTIC_API_KEY;
    try {
        const response = await postAtlantic('/get-profile', { api_key: apiKey });
        res.json(response.data);
    } catch (err) { res.status(500).json({ status: false, message: err.message }); }
});

app.post('/api/atlantic/prabayar/layanan', async (req, res) => {
    const config = await getSettings();
    const apiKey = config.atlantic_key || process.env.ATLANTIC_API_KEY;
    try {
        const response = await postAtlantic('/layanan/prabayar', { api_key: apiKey });
        res.json(response.data);
    } catch (err) { res.status(500).json({ status: false, message: err.message }); }
});

app.post('/api/atlantic/prabayar/transaksi', async (req, res) => {
    const { code, target, phone } = req.body;
    const config = await getSettings();
    const apiKey = config.atlantic_key || process.env.ATLANTIC_API_KEY;
    const reffId = "REF-" + Date.now();
    try {
        const response = await postAtlantic('/transaksi/create', { api_key: apiKey, code, target, reff_id: reffId });
        if (response.data && response.data.status) {
            await queryTurso("INSERT INTO transactions (order_id, customer_phone, description, amount, status) VALUES (?, ?, ?, ?, ?)",
                [reffId, phone, `Prabayar: ${code} ke ${target}`, response.data.data?.price || 0, 'PENDING']);
            res.json({ success: true, data: response.data.data });
        } else { res.status(400).json({ success: false, message: response.data?.message || "Gagal" }); }
    } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

app.post('/api/create-transaction', async (req, res) => {
    const { cart, phone } = req.body;
    if (!cart || !phone) return res.status(400).json({ message: "Data tidak lengkap" });

    const config = await getSettings();
    const apiKey = config.api_key || process.env.CASAKU_API_KEY;
    const merchantId = config.merchant_id || process.env.CASAKU_MERCHANT_ID;

    if (!apiKey || !merchantId) return res.status(500).json({ message: "Kredensial Casaku belum diisi!" });

    let totalAmount = 0, itemsName = [];
    for (let item of cart) {
        const prodRes = await queryTurso("SELECT * FROM products WHERE id = ?", [item.id]);
        const prod = prodRes.rows[0];
        if (!prod || prod.stock < item.qty) return res.status(400).json({ message: `Stok ${item.name} habis!` });
        totalAmount += prod.price * item.qty;
        itemsName.push(`${prod.name} (${item.qty}x)`);
    }

    try {
        const response = await axios.post(`${CASAKU_BASE_URL}/api/generate/v2/qris`, {
            qr_id: merchantId, amount: totalAmount, useUniqueCode: true,
            packageIds: ["id.dana"], expiredInMinutes: 15, qrType: "dynamic", paymentMethod: "qris", useQris: true, prefix: "CSK"
        }, { headers: { 'x-license-key': apiKey, 'Content-Type': 'application/json' } });

        if (response.data && (response.data.status === 200 || response.data.status === true)) {
            const resData = response.data.data || {};
            const finalAmount = resData.totalAmount || totalAmount;
            const transactionId = resData.transactionId || ("CSK-" + Date.now());

            await queryTurso("INSERT INTO transactions (order_id, customer_phone, description, amount, status) VALUES (?, ?, ?, ?, ?)",
                [transactionId, phone, itemsName.join(', '), finalAmount, 'PENDING']);

            res.json({ success: true, transactionId, totalAmount: finalAmount, qr_string: resData.qr_string });
        } else { res.status(400).json({ message: response.data?.message || "Gagal QRIS" }); }
    } catch (error) { res.status(500).json({ message: error.message }); }
});

app.post('/api/casaku/check-status', async (req, res) => {
    const { transactionId } = req.body;
    const config = await getSettings();
    const apiKey = config.api_key || process.env.CASAKU_API_KEY;
    try {
        const response = await axios.post(`${CASAKU_BASE_URL}/api/generate/check-status`, { transactionId }, {
            headers: { 'x-license-key': apiKey, 'Content-Type': 'application/json' }
        });
        res.json(response.data);
    } catch (error) { res.status(500).json({ success: false, message: error.message }); }
});

// -------------------------------------------------------------
// ADMIN ROUTES
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
    try {
        const { name, price, stock, image } = req.body;
        await queryTurso("INSERT INTO products (name, price, stock, image) VALUES (?, ?, ?, ?)", [name, price, stock, image || '']);
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
    const { merchant_id, api_key, bg_music, atlantic_key, playlist_data } = req.body;
    if (merchant_id !== undefined) await queryTurso("INSERT OR REPLACE INTO settings (key, value) VALUES ('merchant_id', ?)", [merchant_id]);
    if (api_key !== undefined) await queryTurso("INSERT OR REPLACE INTO settings (key, value) VALUES ('api_key', ?)", [api_key]);
    if (bg_music !== undefined) await queryTurso("INSERT OR REPLACE INTO settings (key, value) VALUES ('bg_music', ?)", [bg_music]);
    if (atlantic_key !== undefined) await queryTurso("INSERT OR REPLACE INTO settings (key, value) VALUES ('atlantic_key', ?)", [atlantic_key]);
    if (playlist_data !== undefined) await queryTurso("INSERT OR REPLACE INTO settings (key, value) VALUES ('playlist_data', ?)", [playlist_data]);
    res.json({ success: true, message: "Pengaturan Disimpan!" });
});

module.exports = app;
                                          
