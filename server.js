const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const cors = require('cors');
const passport = require('passport');
const GoogleStrategy = require('passport-google-oauth20').Strategy;
const session = require('express-session');
const db = require('./database');

const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = 'your-secret-key-change-in-production';
app.use(cors());
app.use(express.json());
app.use(express.static('public'));
app.use('/uploads', express.static('uploads'));

// Session configuration for passport
app.use(session({
    secret: 'your-session-secret-change-in-production',
    resave: false,
    saveUninitialized: false
}));

app.use(passport.initialize());
app.use(passport.session());

// Google OAuth Configuration
// Set these as environment variables for security:
// export GOOGLE_CLIENT_ID="your-client-id"
// export GOOGLE_CLIENT_SECRET="your-client-secret"
passport.use(new GoogleStrategy({
    clientID: process.env.GOOGLE_CLIENT_ID || 'YOUR_GOOGLE_CLIENT_ID',
    clientSecret: process.env.GOOGLE_CLIENT_SECRET || 'YOUR_GOOGLE_CLIENT_SECRET',
    callbackURL: 'http://localhost:3000/api/auth/google/callback'
},
    async (accessToken, refreshToken, profile, done) => {
        try {
            // Check if user exists
            db.get('SELECT * FROM users WHERE google_id = ?', [profile.id], async (err, user) => {
                if (err) return done(err);

                if (user) {
                    // User exists, return user
                    return done(null, user);
                } else {
                    // Create new user
                    const username = profile.displayName.replace(/\s+/g, '_').toLowerCase() + '_' + Date.now();
                    const email = profile.emails[0].value;

                    db.run(
                        'INSERT INTO users (username, email, google_id) VALUES (?, ?, ?)',
                        [username, email, profile.id],
                        function (err) {
                            if (err) return done(err);

                            db.get('SELECT * FROM users WHERE id = ?', [this.lastID], (err, newUser) => {
                                if (err) return done(err);
                                return done(null, newUser);
                            });
                        }
                    );
                }
            });
        } catch (error) {
            return done(error);
        }
    }));

passport.serializeUser((user, done) => {
    done(null, user.id);
});

passport.deserializeUser((id, done) => {
    db.get('SELECT * FROM users WHERE id = ?', [id], (err, user) => {
        done(err, user);
    });
});

// Create uploads directory if it doesn't exist
if (!fs.existsSync('uploads')) {
    fs.mkdirSync('uploads');
}

// Configure multer for file uploads
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        cb(null, 'uploads/');
    },
    filename: (req, file, cb) => {
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        cb(null, uniqueSuffix + path.extname(file.originalname));
    }
});

const upload = multer({
    storage: storage,
    limits: { fileSize: 50 * 1024 * 1024 }, // 50MB limit
    fileFilter: (req, file, cb) => {
        const allowedTypes = /jpeg|jpg|png|gif|mp4|mov|avi|webm/;
        const extname = allowedTypes.test(path.extname(file.originalname).toLowerCase());
        const mimetype = allowedTypes.test(file.mimetype);

        if (mimetype && extname) {
            return cb(null, true);
        } else {
            cb(new Error('Only images and videos are allowed'));
        }
    }
});

// JWT Authentication Middleware
const authenticateToken = (req, res, next) => {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];

    if (!token) {
        return res.status(401).json({ error: 'Access token required' });
    }

    jwt.verify(token, JWT_SECRET, (err, user) => {
        if (err) {
            return res.status(403).json({ error: 'Invalid or expired token' });
        }
        req.user = user;
        next();
    });
};

// ==================== AUTH ROUTES ====================


// ==================== GOOGLE OAUTH ROUTES ====================

// Initiate Google OAuth
app.get('/api/auth/google',
    passport.authenticate('google', { scope: ['profile', 'email'] })
);

// Google OAuth callback
app.get('/api/auth/google/callback',
    passport.authenticate('google', { failureRedirect: '/' }),
    (req, res) => {
        // Successful authentication
        const token = jwt.sign(
            { id: req.user.id, username: req.user.username },
            JWT_SECRET,
            { expiresIn: '7d' }
        );

        // Redirect to frontend with token
        res.redirect(`/?token=${token}&user=${encodeURIComponent(JSON.stringify({
            id: req.user.id,
            username: req.user.username,
            email: req.user.email
        }))}`);
    }
);

// ==================== AUTHENTICATION ROUTES ====================

// Signup
app.post('/api/auth/signup', async (req, res) => {
    const { username, email, password } = req.body;

    if (!username || !email || !password) {
        return res.status(400).json({ error: 'All fields are required' });
    }

    try {
        const hashedPassword = await bcrypt.hash(password, 10);

        db.run(
            'INSERT INTO users (username, email, password_hash) VALUES (?, ?, ?)',
            [username, email, hashedPassword],
            function (err) {
                if (err) {
                    if (err.message.includes('UNIQUE')) {
                        return res.status(400).json({ error: 'Username or email already exists' });
                    }
                    return res.status(500).json({ error: 'Database error' });
                }

                const token = jwt.sign({ id: this.lastID, username }, JWT_SECRET, { expiresIn: '7d' });
                res.json({
                    token,
                    user: { id: this.lastID, username, email }
                });
            }
        );
    } catch (error) {
        res.status(500).json({ error: 'Server error' });
    }
});

// Login
app.post('/api/auth/login', (req, res) => {
    const { email, password } = req.body;

    if (!email || !password) {
        return res.status(400).json({ error: 'Email and password are required' });
    }

    db.get('SELECT * FROM users WHERE email = ?', [email], async (err, user) => {
        if (err) {
            return res.status(500).json({ error: 'Database error' });
        }

        if (!user) {
            return res.status(401).json({ error: 'Invalid credentials' });
        }

        const validPassword = await bcrypt.compare(password, user.password_hash);
        if (!validPassword) {
            return res.status(401).json({ error: 'Invalid credentials' });
        }

        const token = jwt.sign({ id: user.id, username: user.username }, JWT_SECRET, { expiresIn: '7d' });
        res.json({
            token,
            user: { id: user.id, username: user.username, email: user.email, bio: user.bio, avatar: user.avatar }
        });
    });
});

// ==================== POST ROUTES ====================

// Create post
app.post('/api/posts', authenticateToken, upload.single('media'), (req, res) => {
    if (!req.file) {
        return res.status(400).json({ error: 'Media file is required' });
    }

    const { caption, is_reel, collab_user_id, filter_type } = req.body;
    const mediaUrl = '/uploads/' + req.file.filename;
    const mediaType = req.file.mimetype.startsWith('video') ? 'video' : 'image';

    // If it's a reel, ensure it's a video (simple check)
    const isReel = is_reel === 'true' || is_reel === true ? 1 : 0;

    db.run(
        'INSERT INTO posts (user_id, media_url, media_type, caption, is_reel, collab_user_id, filter_type) VALUES (?, ?, ?, ?, ?, ?, ?)',
        [req.user.id, mediaUrl, mediaType, caption || '', isReel, collab_user_id || null, filter_type || ''],
        function (err) {
            if (err) {
                return res.status(500).json({ error: 'Failed to create post' });
            }

            res.json({
                id: this.lastID,
                user_id: req.user.id,
                media_url: mediaUrl,
                media_type: mediaType,
                caption: caption || '',
                is_reel: isReel,
                collab_user_id: collab_user_id || null,
                filter_type: filter_type || '',
                created_at: new Date().toISOString()
            });
        }
    );
});

// Get feed (paginated)
app.get('/api/posts/feed', authenticateToken, (req, res) => {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 10;
    const offset = (page - 1) * limit;

    const query = `
    SELECT 
      posts.*,
      users.username,
      users.avatar,
      (SELECT COUNT(*) FROM likes WHERE likes.post_id = posts.id) as like_count,
      (SELECT COUNT(*) FROM likes WHERE likes.post_id = posts.id AND likes.user_id = ?) as user_liked
    FROM posts
    JOIN users ON posts.user_id = users.id
    ORDER BY posts.created_at DESC
    LIMIT ? OFFSET ?
  `;

    db.all(query, [req.user.id, limit, offset], (err, posts) => {
        if (err) {
            return res.status(500).json({ error: 'Failed to fetch posts' });
        }

        res.json(posts.map(post => ({
            ...post,
            user_liked: post.user_liked > 0
        })));
    });
});

// Get user posts
app.get('/api/posts/user/:userId', authenticateToken, (req, res) => {
    const userId = req.params.userId;

    const query = `
    SELECT 
      posts.*,
      users.username,
      users.avatar,
      (SELECT COUNT(*) FROM likes WHERE likes.post_id = posts.id) as like_count,
      (SELECT COUNT(*) FROM likes WHERE likes.post_id = posts.id AND likes.user_id = ?) as user_liked
    FROM posts
    JOIN users ON posts.user_id = users.id
    WHERE posts.user_id = ?
    ORDER BY posts.created_at DESC
  `;

    db.all(query, [req.user.id, userId], (err, posts) => {
        if (err) {
            return res.status(500).json({ error: 'Failed to fetch user posts' });
        }

        res.json(posts.map(post => ({
            ...post,
            user_liked: post.user_liked > 0
        })));
    });
});

// Helper to create notification
const createNotification = (recipientId, actorId, type, postId = null) => {
    if (recipientId === actorId) return; // Don't notify if user interacts with own content

    db.run(
        'INSERT INTO notifications (recipient_id, actor_id, type, post_id) VALUES (?, ?, ?, ?)',
        [recipientId, actorId, type, postId],
        (err) => {
            if (err) console.error('Error creating notification:', err);
        }
    );
};

// ==================== COMMENT ROUTES ====================

// Get comments for a post
app.get('/api/posts/:postId/comments', authenticateToken, (req, res) => {
    const postId = req.params.postId;

    const query = `
    SELECT 
      comments.*,
      users.username,
      users.avatar
    FROM comments
    JOIN users ON comments.user_id = users.id
    WHERE comments.post_id = ?
    ORDER BY comments.created_at DESC
  `;

    db.all(query, [postId], (err, comments) => {
        if (err) {
            return res.status(500).json({ error: 'Failed to fetch comments' });
        }
        res.json(comments);
    });
});

// Add comment
app.post('/api/posts/:postId/comments', authenticateToken, (req, res) => {
    const postId = req.params.postId;
    const { content } = req.body;

    if (!content) {
        return res.status(400).json({ error: 'Comment content is required' });
    }

    db.run(
        'INSERT INTO comments (post_id, user_id, content) VALUES (?, ?, ?)',
        [postId, req.user.id, content],
        function (err) {
            if (err) {
                return res.status(500).json({ error: 'Failed to add comment' });
            }

            const commentId = this.lastID;

            // Fetch post owner to create notification
            db.get('SELECT user_id FROM posts WHERE id = ?', [postId], (err, post) => {
                if (!err && post) {
                    createNotification(post.user_id, req.user.id, 'comment', postId);
                }
            });

            // Return the created comment with user details
            db.get(
                `SELECT comments.*, users.username, users.avatar 
         FROM comments 
         JOIN users ON comments.user_id = users.id 
         WHERE comments.id = ?`,
                [commentId],
                (err, newComment) => {
                    if (err) return res.status(500).json({ error: 'Comment created but failed to fetch details' });
                    res.json(newComment);
                }
            );
        }
    );
});

// ==================== LIKE ROUTES ====================

// Like post
app.post('/api/posts/:postId/like', authenticateToken, (req, res) => {
    const postId = req.params.postId;

    db.run(
        'INSERT INTO likes (user_id, post_id) VALUES (?, ?)',
        [req.user.id, postId],
        function (err) {
            if (err) {
                if (err.message.includes('UNIQUE')) {
                    return res.status(400).json({ error: 'Post already liked' });
                }
                return res.status(500).json({ error: 'Failed to like post' });
            }

            // Create notification
            db.get('SELECT user_id FROM posts WHERE id = ?', [postId], (err, post) => {
                if (!err && post) {
                    createNotification(post.user_id, req.user.id, 'like', postId);
                }
            });

            res.json({ success: true });
        }
    );
});

// Unlike post
app.delete('/api/posts/:postId/like', authenticateToken, (req, res) => {
    const postId = req.params.postId;

    db.run(
        'DELETE FROM likes WHERE user_id = ? AND post_id = ?',
        [req.user.id, postId],
        function (err) {
            if (err) {
                return res.status(500).json({ error: 'Failed to unlike post' });
            }

            res.json({ success: true });
        }
    );
});

// Search users
app.get('/api/users/search', authenticateToken, (req, res) => {
    const query = req.query.q;

    if (!query) {
        return res.json([]);
    }

    db.all(
        'SELECT id, username, avatar, bio FROM users WHERE username LIKE ? LIMIT 10',
        [`%${query}%`],
        (err, users) => {
            if (err) return res.status(500).json({ error: 'Search failed' });
            res.json(users);
        }
    );
});

// ==================== FOLLOW ROUTES ====================

// Follow user
app.post('/api/users/:userId/follow', authenticateToken, (req, res) => {
    const followingId = req.params.userId;
    const followerId = req.user.id;

    if (parseInt(followingId) === followerId) {
        return res.status(400).json({ error: 'Cannot follow yourself' });
    }

    db.run(
        'INSERT INTO follows (follower_id, following_id) VALUES (?, ?)',
        [followerId, followingId],
        function (err) {
            if (err) {
                if (err.message.includes('PRIMARY')) {
                    return res.status(400).json({ error: 'Already following' });
                }
                return res.status(500).json({ error: 'Failed to follow user' });
            }

            createNotification(followingId, followerId, 'follow');
            res.json({ success: true });
        }
    );
});

// Unfollow user
app.delete('/api/users/:userId/follow', authenticateToken, (req, res) => {
    const followingId = req.params.userId;
    const followerId = req.user.id;

    db.run(
        'DELETE FROM follows WHERE follower_id = ? AND following_id = ?',
        [followerId, followingId],
        function (err) {
            if (err) {
                return res.status(500).json({ error: 'Failed to unfollow user' });
            }
            res.json({ success: true });
        }
    );
});

// Get followers
app.get('/api/users/:userId/followers', authenticateToken, (req, res) => {
    const userId = req.params.userId;

    const query = `
    SELECT users.id, users.username, users.avatar, users.bio
    FROM follows
    JOIN users ON follows.follower_id = users.id
    WHERE follows.following_id = ?
  `;

    db.all(query, [userId], (err, followers) => {
        if (err) return res.status(500).json({ error: 'Failed to fetch followers' });
        res.json(followers);
    });
});

// Get following
app.get('/api/users/:userId/following', authenticateToken, (req, res) => {
    const userId = req.params.userId;

    const query = `
    SELECT users.id, users.username, users.avatar, users.bio
    FROM follows
    JOIN users ON follows.following_id = users.id
    WHERE follows.follower_id = ?
  `;

    db.all(query, [userId], (err, following) => {
        if (err) return res.status(500).json({ error: 'Failed to fetch following' });
        res.json(following);
    });
});

// ==================== NOTIFICATION ROUTES ====================

// Get notifications
app.get('/api/notifications', authenticateToken, (req, res) => {
    const query = `
    SELECT 
      notifications.*,
      users.username as actor_username,
      users.avatar as actor_avatar,
      posts.media_url,
      posts.media_type
    FROM notifications
    JOIN users ON notifications.actor_id = users.id
    LEFT JOIN posts ON notifications.post_id = posts.id
    WHERE notifications.recipient_id = ?
    ORDER BY notifications.created_at DESC
    LIMIT 20
  `;

    db.all(query, [req.user.id], (err, notifications) => {
        if (err) return res.status(500).json({ error: 'Failed to fetch notifications' });
        res.json(notifications);
    });
});

// Mark notification as read
app.put('/api/notifications/:id/read', authenticateToken, (req, res) => {
    const notificationId = req.params.id;

    db.run(
        'UPDATE notifications SET is_read = 1 WHERE id = ? AND recipient_id = ?',
        [notificationId, req.user.id],
        function (err) {
            if (err) return res.status(500).json({ error: 'Failed to update notification' });
            res.json({ success: true });
        }
    );
});

// ==================== PROFILE ROUTES ====================

// Get user profile
app.get('/api/users/:userId', authenticateToken, (req, res) => {
    const userId = req.params.userId;

    db.get(
        `SELECT 
      users.id, 
      users.username, 
      users.email, 
      users.bio, 
      users.avatar,
      users.created_at,
      (SELECT COUNT(*) FROM posts WHERE posts.user_id = users.id) as post_count
    FROM users 
    WHERE users.id = ?`,
        [userId],
        (err, user) => {
            if (err) {
                return res.status(500).json({ error: 'Database error' });
            }

            if (!user) {
                return res.status(404).json({ error: 'User not found' });
            }

            res.json(user);
        }
    );
});

// Get current user
app.get('/api/auth/me', authenticateToken, (req, res) => {
    db.get(
        'SELECT id, username, email, bio, avatar FROM users WHERE id = ?',
        [req.user.id],
        (err, user) => {
            if (err) {
                return res.status(500).json({ error: 'Database error' });
            }

            if (!user) {
                return res.status(404).json({ error: 'User not found' });
            }

            res.json(user);
        }
    );
});

// Update profile
app.put('/api/users/me', authenticateToken, (req, res) => {
    const { bio, avatar } = req.body;

    db.run(
        'UPDATE users SET bio = ?, avatar = ? WHERE id = ?',
        [bio, avatar, req.user.id],
        function (err) {
            if (err) return res.status(500).json({ error: 'Failed to update profile' });
            res.json({ success: true, bio, avatar });
        }
    );
});

// ==================== STORIES ROUTES ====================

// Upload story
app.post('/api/stories', authenticateToken, upload.single('media'), (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'Media file is required' });

    const mediaUrl = `/uploads/${req.file.filename}`;
    const mediaType = req.file.mimetype.startsWith('video') ? 'video' : 'image';

    // Set expiration to 24 hours from now
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();

    db.run(
        'INSERT INTO stories (user_id, media_url, media_type, expires_at) VALUES (?, ?, ?, ?)',
        [req.user.id, mediaUrl, mediaType, expiresAt],
        function (err) {
            if (err) return res.status(500).json({ error: 'Failed to create story' });
            res.status(201).json({ success: true, id: this.lastID, media_url: mediaUrl });
        }
    );
});

// Get active stories
app.get('/api/stories', authenticateToken, (req, res) => {
    const now = new Date().toISOString();

    // Get stories from followed users and self
    db.all(`
        SELECT s.*, u.username, u.avatar 
        FROM stories s
        JOIN users u ON s.user_id = u.id
        WHERE s.expires_at > ? 
        AND (
            s.user_id = ? 
            OR s.user_id IN (SELECT following_id FROM follows WHERE follower_id = ?)
        )
        ORDER BY s.created_at DESC
    `, [now, req.user.id, req.user.id], (err, stories) => {
        if (err) return res.status(500).json({ error: 'Failed to fetch stories' });
        res.json(stories);
    });
});

// ==================== SAVED POSTS ROUTES ====================

// Save post
app.post('/api/posts/:postId/save', authenticateToken, (req, res) => {
    db.run(
        'INSERT OR IGNORE INTO saved_posts (user_id, post_id) VALUES (?, ?)',
        [req.user.id, req.params.postId],
        (err) => {
            if (err) return res.status(500).json({ error: 'Failed to save post' });
            res.json({ success: true });
        }
    );
});

// Unsave post
app.delete('/api/posts/:postId/save', authenticateToken, (req, res) => {
    db.run(
        'DELETE FROM saved_posts WHERE user_id = ? AND post_id = ?',
        [req.user.id, req.params.postId],
        (err) => {
            if (err) return res.status(500).json({ error: 'Failed to unsave post' });
            res.json({ success: true });
        }
    );
});

// Get saved posts
app.get('/api/posts/saved', authenticateToken, (req, res) => {
    db.all(`
        SELECT p.*, u.username, u.avatar,
        (SELECT COUNT(*) FROM likes WHERE post_id = p.id) as like_count,
        EXISTS(SELECT 1 FROM likes WHERE post_id = p.id AND user_id = ?) as user_liked,
        1 as user_saved
        FROM saved_posts sp
        JOIN posts p ON sp.post_id = p.id
        JOIN users u ON p.user_id = u.id
        WHERE sp.user_id = ?
        ORDER BY sp.created_at DESC
    `, [req.user.id, req.user.id], (err, posts) => {
        if (err) return res.status(500).json({ error: 'Failed to fetch saved posts' });
        res.json(posts);
    });
});

// ==================== EXPLORE ROUTES ====================

app.get('/api/posts/explore', authenticateToken, (req, res) => {
    // Return random posts or trending (most liked recent)
    // For simplicity, just return 20 random posts excluding own posts
    db.all(`
        SELECT p.*, u.username, u.avatar,
        (SELECT COUNT(*) FROM likes WHERE post_id = p.id) as like_count,
        EXISTS(SELECT 1 FROM likes WHERE post_id = p.id AND user_id = ?) as user_liked,
        EXISTS(SELECT 1 FROM saved_posts WHERE post_id = p.id AND user_id = ?) as user_saved
        FROM posts p
        JOIN users u ON p.user_id = u.id
        WHERE p.user_id != ?
        ORDER BY RANDOM() LIMIT 20
    `, [req.user.id, req.user.id, req.user.id], (err, posts) => {
        if (err) return res.status(500).json({ error: 'Failed to fetch explore posts' });
        res.json(posts);
    });
});

// ==================== MESSAGES ROUTES ====================

// Get conversations (users communicated with)
app.get('/api/messages/conversations', authenticateToken, (req, res) => {
    db.all(`
        SELECT u.id, u.username, u.avatar,
        (SELECT content FROM messages 
         WHERE (sender_id = u.id AND receiver_id = ?) OR (sender_id = ? AND receiver_id = u.id)
         ORDER BY created_at DESC LIMIT 1) as last_message,
         (SELECT created_at FROM messages 
         WHERE (sender_id = u.id AND receiver_id = ?) OR (sender_id = ? AND receiver_id = u.id)
         ORDER BY created_at DESC LIMIT 1) as last_message_time
        FROM users u
        WHERE u.id IN (
            SELECT DISTINCT CASE 
                WHEN sender_id = ? THEN receiver_id 
                ELSE sender_id 
            END
            FROM messages 
            WHERE sender_id = ? OR receiver_id = ?
        )
        ORDER BY last_message_time DESC
    `, [req.user.id, req.user.id, req.user.id, req.user.id, req.user.id, req.user.id, req.user.id], (err, users) => {
        if (err) return res.status(500).json({ error: 'Failed to fetch conversations' });
        res.json(users);
    });
});

// Get messages with a user
app.get('/api/messages/:userId', authenticateToken, (req, res) => {
    const otherId = req.params.userId;
    db.all(`
        SELECT * FROM messages 
        WHERE (sender_id = ? AND receiver_id = ?) 
           OR (sender_id = ? AND receiver_id = ?)
        ORDER BY created_at ASC
    `, [req.user.id, otherId, otherId, req.user.id], (err, messages) => {
        if (err) return res.status(500).json({ error: 'Failed to fetch messages' });
        res.json(messages);
    });
});

// Send message
app.post('/api/messages/:userId', authenticateToken, (req, res) => {
    const { content } = req.body;
    const receiverId = req.params.userId;

    if (!content) return res.status(400).json({ error: 'Message content required' });

    db.run(
        'INSERT INTO messages (sender_id, receiver_id, content) VALUES (?, ?, ?)',
        [req.user.id, receiverId, content],
        function (err) {
            if (err) return res.status(500).json({ error: 'Failed to send message' });
            res.json({ success: true, id: this.lastID, created_at: new Date().toISOString() });
        }
    );
});

// ==================== REELS ====================

app.get('/api/reels', authenticateToken, (req, res) => {
    const userId = req.user.id;
    // Get reels (vertical videos) from users not followed + followed, prioritize random popular
    db.all(`
    SELECT p.*, u.username, u.avatar, 
    (SELECT COUNT(*) FROM likes WHERE post_id = p.id) as like_count,
    EXISTS(SELECT 1 FROM likes WHERE post_id = p.id AND user_id = ?) as user_liked,
    EXISTS(SELECT 1 FROM saved_posts WHERE post_id = p.id AND user_id = ?) as user_saved
    FROM posts p
    JOIN users u ON p.user_id = u.id
    WHERE p.is_reel = 1
    ORDER BY RANDOM()
    LIMIT 10
  `, [userId, userId], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows.map(post => ({
            ...post,
            user_liked: post.user_liked > 0,
            user_saved: post.user_saved > 0
        })));
    });
});

// ==================== LIVE STREAMING ====================

app.post('/api/live/start', authenticateToken, (req, res) => {
    const userId = req.user.id;

    // End any existing active streams for this user first
    db.run("UPDATE live_streams SET status = 'ended', ended_at = CURRENT_TIMESTAMP WHERE user_id = ? AND status = 'live'", [userId]);

    db.run(`INSERT INTO live_streams (user_id, status) VALUES (?, 'live')`, [userId], function (err) {
        if (err) return res.status(500).json({ error: err.message });
        res.status(201).json({ id: this.lastID, status: 'live' });
    });
});

app.post('/api/live/end', authenticateToken, (req, res) => {
    const userId = req.user.id;
    db.run("UPDATE live_streams SET status = 'ended', ended_at = CURRENT_TIMESTAMP WHERE user_id = ? AND status = 'live'", [userId], (err) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ success: true });
    });
});

app.get('/api/live', authenticateToken, (req, res) => {
    db.all(`
    SELECT l.*, u.username, u.avatar 
    FROM live_streams l
    JOIN users u ON l.user_id = u.id
    WHERE l.status = 'live'
    ORDER BY l.created_at DESC
  `, [], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows);
    });
});

app.post('/api/live/:streamId/message', authenticateToken, (req, res) => {
    const { streamId } = req.params;
    const { content } = req.body;
    const userId = req.user.id;

    if (!content) return res.status(400).json({ error: "Content required" });

    db.run(`INSERT INTO live_messages (stream_id, user_id, content) VALUES (?, ?, ?)`, [streamId, userId, content], function (err) {
        if (err) return res.status(500).json({ error: err.message });
        res.status(201).json({ id: this.lastID, content });
    });
});

app.get('/api/live/:streamId/messages', authenticateToken, (req, res) => {
    const { streamId } = req.params;
    // Get last 50 messages
    db.all(`
    SELECT m.*, u.username, u.avatar
    FROM live_messages m
    JOIN users u ON m.user_id = u.id
    WHERE m.stream_id = ?
    ORDER BY m.created_at ASC
    LIMIT 50
  `, [streamId], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows);
    });
});

// Start server
app.listen(PORT, () => {
    console.log(`\n🚀 Social Media Server running on http://localhost:${PORT}`);
    console.log(`📁 Uploads directory: ${path.join(__dirname, 'uploads')}\n`);
});

// Export app for Vercel
module.exports = app;

// Only listen if run directly
if (require.main === module) {
    app.listen(PORT, () => {
        console.log(`Server running on http://localhost:${PORT}`);
    });
}
