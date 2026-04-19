const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const cors = require('cors');
const bodyParser = require('body-parser');

const app = express();
app.use(cors());
app.use(bodyParser.json());
app.use(express.static('public')); // Serve admin panel

app.get('/', (req, res) => {
    res.send('Daily Quotes API is running!');
});

// Initialize SQLite database
const db = new sqlite3.Database('./dailyquotes.db', (err) => {
    if (err) console.error(err.message);
    else console.log('Connected to the SQLite database.');
});

// Create tables
db.serialize(() => {
    // Users table holds both users and admin roles
    db.run(`CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT UNIQUE,
        password TEXT,
        role TEXT DEFAULT 'user',
        wallet REAL DEFAULT 0.0,
        quotes_today INTEGER DEFAULT 0,
        last_reset_date TEXT
    )`);
    
    // Add default admin if not exists
    db.get('SELECT * FROM users WHERE username = ?', ['admin'], (err, row) => {
        if (!row) {
            db.run('INSERT INTO users (username, password, role) VALUES (?, ?, ?)', ['admin', 'admin123', 'admin']);
        }
    });
});

const getTodayDateString = () => new Date().toISOString().split('T')[0];

const checkAndResetQuota = (user, callback) => {
    const today = getTodayDateString();
    if (user.last_reset_date !== today) {
        db.run('UPDATE users SET quotes_today = 0, last_reset_date = ? WHERE id = ?', [today, user.id], (err) => {
            user.quotes_today = 0;
            user.last_reset_date = today;
            callback(user);
        });
    } else {
        callback(user);
    }
};

// --- AUTHENTICATION API ---

app.post('/api/register', (req, res) => {
    const { username, password } = req.body;
    db.run('INSERT INTO users (username, password, last_reset_date) VALUES (?, ?, ?)', 
        [username, password, getTodayDateString()], 
        function(err) {
            if (err) return res.status(400).json({ error: 'Username already exists' });
            res.json({ id: this.lastID, username, wallet: 0.0, quotes_today: 0 });
    });
});

app.post('/api/login', (req, res) => {
    const { username, password } = req.body;
    db.get('SELECT * FROM users WHERE username = ? AND password = ?', [username, password], (err, row) => {
        if (err || !row) return res.status(401).json({ error: 'Invalid credentials' });
        checkAndResetQuota(row, (updatedUser) => {
            res.json(updatedUser);
        });
    });
});

// --- USER QUOTA & WALLET API ---

app.get('/api/user/:id', (req, res) => {
    db.get('SELECT id, username, wallet, quotes_today, last_reset_date FROM users WHERE id = ?', [req.params.id], (err, row) => {
        if (err || !row) return res.status(404).json({ error: 'User not found' });
        checkAndResetQuota(row, (updatedUser) => {
            // Max allowed by default is 3. If they bought extra, quotes_today can exceed but logic is: 
            // They have 3 standard. To make it simpler: remaining = max(0, 3 - quotes_today).
            res.json(updatedUser);
        });
    });
});

app.post('/api/quotes/consume', (req, res) => {
    const { userId } = req.body;
    db.get('SELECT * FROM users WHERE id = ?', [userId], (err, row) => {
        if (err || !row) return res.status(404).json({ error: 'User not found' });
        
        checkAndResetQuota(row, (user) => {
            // Check if they exceed the daily limit of 3 without extra allowance.
            // When bought extra, we just subtract 10 from quotes_today temporarily?
            // Actually, better logic: add a 'bonus_quotes' column. Let's just use quotes_today. 
            // Assuming 3 is max.
            db.get('SELECT quotes_today FROM users WHERE id = ?', [userId], (err, u) => {
                const used = u.quotes_today;
                if (used >= 3) {
                    return res.status(403).json({ error: 'Daily quote limit reached. Please recharge.' });
                }
                db.run('UPDATE users SET quotes_today = quotes_today + 1 WHERE id = ?', [userId], (err) => {
                    res.json({ success: true, remaining: 2 - used });
                });
            });
        });
    });
});

// To handle wallet purchasing: when you buy, we actually give them -10 in quotes_today, so they get 10 more uses!
app.post('/api/quotes/buy', (req, res) => {
    const { userId } = req.body;
    db.get('SELECT * FROM users WHERE id = ?', [userId], (err, user) => {
        if (err || !user) return res.status(404).json({ error: 'User not found' });
        if (user.wallet < 1.0) return res.status(402).json({ error: 'Insufficient wallet balance. Please tell Admin to recharge.' });
        
        // Deduct 1 rupee, effectively give 10 more quotes by subtracting from usage
        db.run('UPDATE users SET wallet = wallet - 1.0, quotes_today = quotes_today - 10 WHERE id = ?', [userId], (err) => {
            if (err) return res.status(500).json({ error: 'Database error' });
            res.json({ success: true, new_wallet_balance: user.wallet - 1.0 });
        });
    });
});

// --- ADMIN API ---

app.get('/api/admin/users', (req, res) => {
    db.all("SELECT id, username, password, wallet, quotes_today FROM users WHERE role = 'user'", [], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows);
    });
});

app.put('/api/admin/users/:id', (req, res) => {
    const { username, password, wallet } = req.body;
    const userId = req.params.id;
    db.run('UPDATE users SET username = ?, password = ?, wallet = ? WHERE id = ? AND role = "user"',
        [username, password, wallet, userId], function(err) {
            if (err) return res.status(500).json({ error: err.message });
            res.json({ success: true, updated: this.changes });
        }
    );
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Server listening on port ${PORT}`);
});
