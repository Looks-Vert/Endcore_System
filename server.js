const express = require('express');
const mysql = require('mysql2');
const session = require('express-session');
const bodyParser = require('body-parser');
const fileUpload = require('express-fileupload');
const fs = require('fs');
const path = require('path');

const app = express();
const port = process.env.PORT || 3000;

// ================= KONFIGURASI FOLDER UPLOAD =================
const dirs = ['./public', './public/avatar', './public/splash', './public/news', './public/lore'];
dirs.forEach(dir => {
    if (!fs.existsSync(dir)){
        fs.mkdirSync(dir, { recursive: true });
    }
});

app.set('view engine', 'ejs');
app.use(bodyParser.urlencoded({ extended: true }));
app.use(express.static('public')); 
app.use(fileUpload()); 
app.use(session({ secret: 'endcore_secret_key', resave: false, saveUninitialized: true }));

// KONEKSI DATABASE CLOUD AIVEN (Menggunakan Environment Variables dari Railway)
const db = mysql.createConnection({
    host: process.env.DB_HOST,
    port: process.env.DB_PORT,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    ssl: {
        rejectUnauthorized: false
    }
});

db.connect((err) => {
    if (err) {
        console.error('Gagal koneksi ke database:', err.message);
        return;
    }
    console.log('Terkoneksi ke database arkcore_404');
});

// MIDDLEWARE AKSES
const checkAuth = (req, res, next) => {
    if (!req.session.user) return res.redirect('/login');
    next();
};

const checkAdmin = (req, res, next) => {
    if (!req.session.user || req.session.user.role !== 'admin') {
        return res.send('Akses Ditolak. Halaman ini diproteksi khusus level Administrator.');
    }
    next();
};

// ================= ROUTES FRONTEND =================
app.get('/', (req, res) => {
    // Menarik semua data ke halaman utama EJS
    const qChars = 'SELECT c.*, COUNT(l.id) as total_likes FROM chars c LEFT JOIN likes l ON c.id_char = l.char_id GROUP BY c.id_char';
    const qReviews = `
        SELECT r.*, u.username as user_name, c.nama as char_name, c.avatar_url as char_avatar_url 
        FROM reviews r 
        JOIN users u ON r.user_id = u.id 
        JOIN chars c ON r.char_id = c.id_char 
        ORDER BY r.id DESC LIMIT 10
    `;
    const qNews = 'SELECT * FROM news ORDER BY tanggal DESC';
    const qLore = 'SELECT * FROM lore_dunia';
    const qTopUp = 'SELECT * FROM top_up_packages';

    db.query(qChars, (err, charsData) => {
        if (err) throw err;
        db.query(qReviews, (err, reviewsData) => {
            if (err) throw err;
            db.query(qNews, (err, newsData) => {
                if (err) throw err;
                db.query(qLore, (err, loreData) => {
                    if (err) throw err;
                    db.query(qTopUp, (err, topupData) => {
                        if (err) throw err;
                        
                        // Kirim data utuh ke index.ejs
                        res.render('index', { 
                            chars: charsData, 
                            reviews: reviewsData,
                            newsList: newsData,
                            loreList: loreData,
                            topupPackages: topupData,
                            user: req.session.user 
                        });
                    });
                });
            });
        });
    });
});

// ================= AUTENTIKASI =================
app.get('/login', (req, res) => {
    res.render('login', { error: null });
});

app.post('/login', (req, res) => {
    const { email, password } = req.body;
    const query = 'SELECT * FROM users WHERE email = ? AND password = ?';
    db.query(query, [email, password], (err, results) => {
        if (results.length > 0) {
            req.session.user = results[0];
            if (results[0].role === 'admin') res.redirect('/dashboard');
            else res.redirect('/');
        } else {
            res.render('login', { error: 'Email atau Password salah!' });
        }
    });
});

app.get('/register', (req, res) => {
    res.render('register', { error: null, success: null });
});

app.post('/register', (req, res) => {
    const { username, email, password } = req.body;
    
    if (!req.session.user || req.session.user.role !== 'admin') {
        if (!email.endsWith('@endcoresystem.com')) {
            return res.render('register', { error: 'Gagal! Email WAJIB menggunakan akhiran @endcoresystem.com', success: null });
        }
    }

    const query = 'INSERT INTO users (username, email, password) VALUES (?, ?, ?)';
    db.query(query, [username, email, password], (err) => {
        if (err) {
            if(err.code === 'ER_DUP_ENTRY') return res.render('register', { error: 'Email sudah terdaftar!', success: null });
            throw err;
        }
        
        if (req.session.user && req.session.user.role === 'admin') {
            return res.redirect('/dashboard');
        }
        res.render('register', { error: null, success: 'Akun berhasil dibuat! Silakan Login.' });
    });
});

app.get('/logout', (req, res) => {
    req.session.destroy();
    res.redirect('/');
});

app.get('/delete-user/:id', checkAdmin, (req, res) => {
    db.query('DELETE FROM likes WHERE user_id = ?', [req.params.id], () => {
        db.query('DELETE FROM reviews WHERE user_id = ?', [req.params.id], () => {
            db.query('DELETE FROM users WHERE id = ?', [req.params.id], (err) => {
                if (err) throw err;
                res.redirect('/dashboard');
            });
        });
    });
});

// ================= INTERAKSI USER & SISTEM =================
app.post('/like-char/:char_id', checkAuth, (req, res) => {
    const userId = req.session.user.id;
    const charId = req.params.char_id;
    const checkSql = 'SELECT * FROM likes WHERE user_id = ? AND char_id = ?';
    
    db.query(checkSql, [userId, charId], (err, result) => {
        if (err) return res.status(500).json({ error: err.message });
        if (result.length > 0) {
            db.query('DELETE FROM likes WHERE user_id = ? AND char_id = ?', [userId, charId], (err) => {
                if (err) return res.status(500).json({ error: err.message });
                db.query('SELECT COUNT(*) AS totalLikes FROM likes WHERE char_id = ?', [charId], (err, countResult) => {
                    res.json({ status: 'unliked', totalLikes: countResult[0].totalLikes });
                });
            });
        } else {
            db.query('INSERT INTO likes (user_id, char_id) VALUES (?, ?)', [userId, charId], (err) => {
                if (err) return res.status(500).json({ error: err.message });
                db.query('SELECT COUNT(*) AS totalLikes FROM likes WHERE char_id = ?', [charId], (err, countResult) => {
                    res.json({ status: 'liked', totalLikes: countResult[0].totalLikes });
                });
            });
        }
    });
});

app.post('/review-char/:char_id', checkAuth, (req, res) => {
    const userId = req.session.user.id;
    const charId = req.params.char_id;
    const { komentar } = req.body;
    db.query('INSERT INTO reviews (user_id, char_id, komentar) VALUES (?, ?, ?)', [userId, charId, komentar], () => {
        res.redirect('/#ulasan');
    });
});

// Route Top Up yang Mengisi Tabel Riwayat Pesanan
app.post('/top-up', checkAuth, (req, res) => {
    const { user_id, nama_user, paket, jenis, harga, metode_pembayaran } = req.body;
    const query = 'INSERT INTO top_up (user_id, nama_user, paket, jenis, harga, metode_pembayaran) VALUES (?, ?, ?, ?, ?, ?)';
    db.query(query, [user_id, nama_user, paket, jenis, harga, metode_pembayaran], (err) => {
        if (err) throw err;
        res.redirect('/'); 
    });
});

// ================= DASHBOARD ADMIN LENGKAP =================
app.get('/dashboard', checkAdmin, (req, res) => {
    const qChars = `SELECT c.*, COUNT(l.id) as total_likes FROM chars c LEFT JOIN likes l ON c.id_char = l.char_id GROUP BY c.id_char`;
    const qUsers = 'SELECT id, username, email, role FROM users';
    const qNews = 'SELECT * FROM news ORDER BY tanggal DESC';
    const qLore = 'SELECT * FROM lore_dunia';
    const qReviews = 'SELECT r.id, r.komentar, u.username, c.nama as char_name FROM reviews r JOIN users u ON r.user_id = u.id JOIN chars c ON r.char_id = c.id_char';
    const qTopUp = 'SELECT * FROM top_up_packages';

    db.query(qChars, (err, charsData) => {
        if (err) throw err;
        db.query(qUsers, (err, usersData) => {
            if (err) throw err;
            db.query(qNews, (err, newsData) => {
                if (err) throw err;
                db.query(qLore, (err, loreData) => {
                    if (err) throw err;
                    db.query(qReviews, (err, reviewsData) => {
                        if (err) throw err;
                        db.query(qTopUp, (err, topupData) => {
                            if (err) throw err;
                            res.render('dashboard', { 
                                chars: charsData, 
                                usersList: usersData, 
                                newsList: newsData, 
                                loreList: loreData,
                                reviewsList: reviewsData,
                                topupPackages: topupData,
                                user: req.session.user 
                            });
                        });
                    });
                });
            });
        });
    });
});

// --- MANAJEMEN OPERATOR ---
app.post('/add-char', checkAdmin, (req, res) => {
    const { nama, faksi, elements, ras, role, deskripsi, avatar_url, splash_url } = req.body;
    let finalAvatar = avatar_url || '';
    let finalSplash = splash_url || '';

    if (req.files) {
        if (req.files.avatar_file) {
            let avaFile = req.files.avatar_file;
            let avaName = Date.now() + '_' + avaFile.name;
            avaFile.mv(path.join(__dirname, 'public', 'avatar', avaName));
            finalAvatar = avaName;
        }
        if (req.files.splash_file) {
            let splashFile = req.files.splash_file;
            let splashName = Date.now() + '_' + splashFile.name;
            splashFile.mv(path.join(__dirname, 'public', 'splash', splashName));
            finalSplash = splashName;
        }
    }
    const query = 'INSERT INTO chars (nama, faksi, elements, ras, role, deskripsi, avatar_url, splash_url) VALUES (?, ?, ?, ?, ?, ?, ?, ?)';
    db.query(query, [nama, faksi, elements, ras, role, deskripsi, finalAvatar, finalSplash], (err) => {
        if (err) throw err;
        res.redirect('/dashboard');
    });
});

app.post('/edit-char/:id', checkAdmin, (req, res) => {
    const { nama, faksi, elements, ras, role, deskripsi, avatar_url, splash_url } = req.body;
    let finalAvatar = avatar_url || '';
    let finalSplash = splash_url || '';

    if (req.files) {
        if (req.files.avatar_file) {
            let avaFile = req.files.avatar_file;
            let avaName = Date.now() + '_' + avaFile.name;
            avaFile.mv(path.join(__dirname, 'public', 'avatar', avaName));
            finalAvatar = avaName;
        }
        if (req.files.splash_file) {
            let splashFile = req.files.splash_file;
            let splashName = Date.now() + '_' + splashFile.name;
            splashFile.mv(path.join(__dirname, 'public', 'splash', splashName));
            finalSplash = splashName;
        }
    }
    const query = 'UPDATE chars SET nama=?, faksi=?, elements=?, ras=?, role=?, deskripsi=?, avatar_url=?, splash_url=? WHERE id_char=?';
    db.query(query, [nama, faksi, elements, ras, role, deskripsi, finalAvatar, finalSplash, req.params.id], (err) => {
        if (err) throw err;
        res.redirect('/dashboard');
    });
});

app.get('/delete-char/:id', checkAdmin, (req, res) => {
    db.query('DELETE FROM likes WHERE char_id = ?', [req.params.id], () => {
        db.query('DELETE FROM reviews WHERE char_id = ?', [req.params.id], () => {
            db.query('DELETE FROM chars WHERE id_char = ?', [req.params.id], (err) => {
                if (err) throw err;
                res.redirect('/dashboard');
            });
        });
    });
});

// --- MANAJEMEN TIER LIST ---
app.post('/update-tier', checkAdmin, (req, res) => {
    const { id_char, tier } = req.body;
    db.query('UPDATE chars SET tier = ? WHERE id_char = ?', [tier, id_char], (err) => {
        if (err) throw err;
        res.redirect('/dashboard');
    });
});

// --- MANAJEMEN REVIEW ---
app.get('/delete-review/:id', checkAdmin, (req, res) => {
    db.query('DELETE FROM reviews WHERE id = ?', [req.params.id], (err) => {
        if (err) throw err;
        res.redirect('/dashboard');
    });
});

// --- MANAJEMEN BERITA ---
app.post('/add-news', checkAdmin, (req, res) => {
    const { judul, tanggal, konten, gambar_url } = req.body;
    let finalGambar = gambar_url || '';

    if (req.files && req.files.gambar_file) {
        let imgFile = req.files.gambar_file;
        let imgName = Date.now() + '_' + imgFile.name;
        imgFile.mv(path.join(__dirname, 'public', 'news', imgName));
        finalGambar = imgName;
    }
    const query = 'INSERT INTO news (judul, tanggal, konten, gambar_url) VALUES (?, ?, ?, ?)';
    db.query(query, [judul, tanggal, konten, finalGambar], (err) => {
        if (err) throw err;
        res.redirect('/dashboard');
    });
});

app.post('/edit-news/:id', checkAdmin, (req, res) => {
    const { judul, tanggal, konten, gambar_url } = req.body;
    let finalGambar = gambar_url || '';

    if (req.files && req.files.gambar_file) {
        let imgFile = req.files.gambar_file;
        let imgName = Date.now() + '_' + imgFile.name;
        imgFile.mv(path.join(__dirname, 'public', 'news', imgName));
        finalGambar = imgName;
    }
    const query = 'UPDATE news SET judul=?, tanggal=?, konten=?, gambar_url=? WHERE id=?';
    db.query(query, [judul, tanggal, konten, finalGambar, req.params.id], (err) => {
        if (err) throw err;
        res.redirect('/dashboard');
    });
});

app.get('/delete-news/:id', checkAdmin, (req, res) => {
    db.query('DELETE FROM news WHERE id = ?', [req.params.id], (err) => {
        if (err) throw err;
        res.redirect('/dashboard');
    });
});

// --- MANAJEMEN LORE DUNIA ---
app.post('/add-lore', checkAdmin, (req, res) => {
    const { region, media_tipe, sejarah, media_url } = req.body;
    let finalMedia = media_url || '';

    if (req.files && req.files.media_file) {
        let mediaFile = req.files.media_file;
        let mediaName = Date.now() + '_' + mediaFile.name;
        mediaFile.mv(path.join(__dirname, 'public', 'lore', mediaName));
        finalMedia = mediaName;
    }
    const query = 'INSERT INTO lore_dunia (region, media_tipe, sejarah, media_url) VALUES (?, ?, ?, ?)';
    db.query(query, [region, media_tipe, sejarah, finalMedia], (err) => {
        if (err) throw err;
        res.redirect('/dashboard');
    });
});

app.post('/edit-lore/:id', checkAdmin, (req, res) => {
    const { region, media_tipe, sejarah, media_url } = req.body;
    let finalMedia = media_url || '';

    if (req.files && req.files.media_file) {
        let mediaFile = req.files.media_file;
        let mediaName = Date.now() + '_' + mediaFile.name;
        mediaFile.mv(path.join(__dirname, 'public', 'lore', mediaName));
        finalMedia = mediaName;
    }
    const query = 'UPDATE lore_dunia SET region=?, media_tipe=?, sejarah=?, media_url=? WHERE id=?';
    db.query(query, [region, media_tipe, sejarah, finalMedia, req.params.id], (err) => {
        if (err) throw err;
        res.redirect('/dashboard');
    });
});

app.get('/delete-lore/:id', checkAdmin, (req, res) => {
    db.query('DELETE FROM lore_dunia WHERE id = ?', [req.params.id], (err) => {
        if (err) throw err;
        res.redirect('/dashboard');
    });
});

// --- MANAJEMEN PAKET TOP-UP (Katalog Admin) ---
app.post('/add-topup-pkg', checkAdmin, (req, res) => {
    const { paket, jenis, harga, metode_pembayaran } = req.body;
    const query = 'INSERT INTO top_up_packages (paket, jenis, harga, metode_pembayaran) VALUES (?, ?, ?, ?)';
    db.query(query, [paket, jenis, harga, metode_pembayaran], (err) => {
        if (err) throw err;
        res.redirect('/dashboard');
    });
});

app.post('/edit-topup-pkg/:id', checkAdmin, (req, res) => {
    const { paket, jenis, harga, metode_pembayaran } = req.body;
    const query = 'UPDATE top_up_packages SET paket=?, jenis=?, harga=?, metode_pembayaran=? WHERE id=?';
    db.query(query, [paket, jenis, harga, metode_pembayaran, req.params.id], (err) => {
        if (err) throw err;
        res.redirect('/dashboard');
    });
});

app.get('/delete-topup-pkg/:id', checkAdmin, (req, res) => {
    db.query('DELETE FROM top_up_packages WHERE id = ?', [req.params.id], (err) => {
        if (err) throw err;
        res.redirect('/dashboard');
    });
});

// ================= BOOTING SERVER =================
app.listen(port, () => {
    console.log(`System Online: http://localhost:${port}`);
});