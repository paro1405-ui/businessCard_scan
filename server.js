
require('dotenv').config({ override: true });

const express = require('express');
const cors = require('cors');
const multer = require('multer');
const fs = require('fs');
const { Pool } = require('pg');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const sharp = require('sharp');

const app = express();
const upload = multer({ dest: 'uploads/', limits: { fileSize: 20 * 1024 * 1024 } });

app.use(cors());
app.use(express.json());

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

const makeDbConfig = () => {
  const connectionString = process.env.DATABASE_URL;
  const password = process.env.PGPASSWORD;

  if (connectionString !== undefined && typeof connectionString !== 'string') {
    throw new Error('DATABASE_URL must be a string');
  }

  if (password !== undefined && typeof password !== 'string') {
    throw new Error('PGPASSWORD must be a string');
  }

  if (!connectionString && !process.env.PGHOST) {
    throw new Error('Database configuration is missing. Set DATABASE_URL or PGHOST/PGUSER/PGPASSWORD/PGDATABASE.');
  }

  return {
    connectionString: connectionString ? String(connectionString) : undefined,
    host: process.env.PGHOST,
    user: process.env.PGUSER,
    password: password ? String(password) : undefined,
    database: process.env.PGDATABASE,
    ssl: process.env.PGSSLMODE === 'require' ? { rejectUnauthorized: false } : false
  };
};

const pool = new Pool(makeDbConfig());

const initDb = async () => {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS business_cards (
        id SERIAL PRIMARY KEY,
        event_name TEXT,
        name TEXT,
        designation TEXT,
        company TEXT,
        phone TEXT,
        email TEXT,
        website TEXT,
        address TEXT,
        remarks TEXT,
        file_path TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS event_list (
        id SERIAL PRIMARY KEY,
        name TEXT UNIQUE NOT NULL,
        is_active BOOLEAN NOT NULL DEFAULT true,
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    console.log('Connected to PostgreSQL database and ensured required tables exist');
  } catch (err) {
    console.error('Error initializing PostgreSQL database:', err);
    process.exit(1);
  }
};

// Normalize event name by removing spaces
const normalizeEventName = (eventName) => {
  if (!eventName || typeof eventName !== 'string') {
    return 'default';
  }
  return eventName.trim().replace(/\s+/g, '');
};

// Helper function to ensure event folder exists
const ensureEventFolder = (eventName) => {
  const normalizedEventName = normalizeEventName(eventName);
  const eventFolder = `uploads/${normalizedEventName}`;
  if (!fs.existsSync(eventFolder)) {
    fs.mkdirSync(eventFolder, { recursive: true });
  }
  return eventFolder;
};

initDb();

app.get('/', (req, res) => {
  res.send('Business Card AI Scanner Backend Running');
});

app.get('/api/events', async (req, res) => {
  try {
    const activeOnly = req.query.active === 'true';
    let query = 'SELECT id, event_name, isactive FROM eventlist';
    const params = [];
    if (activeOnly) {
      query += ' WHERE isactive = true';
    }
    query += ' ORDER BY event_name ASC';

    const result = await pool.query(query, params);
    res.json(result.rows);
  } catch (error) {
    console.error('Error fetching event list:', error);
    res.status(500).json({ error: 'Failed to fetch event list', details: error.message });
  }
});

app.post('/api/scan-card', async (req, res) => {
  const startTime = Date.now();
  const DEBUG = process.env.DEBUG === 'true';
  const eventName = normalizeEventName(req.query.event || 'default');
  
  // Create custom multer for this event
  const eventFolder = ensureEventFolder(eventName);
  const uploadEvent = multer({ dest: eventFolder, limits: { fileSize: 20 * 1024 * 1024 } });
  
  uploadEvent.single('image')(req, res, async (err) => {
    if (err) {
      return res.status(400).json({ error: 'Upload failed', details: err.message });
    }

    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }
  
    try {
      const model = genAI.getGenerativeModel(
        { model: process.env.GEMINI_MODEL || 'gemini-2.5-flash' },
        { apiVersion: 'v1' }
      );

      const imagePath = req.file.path;
      let imageBuffer = fs.readFileSync(imagePath);

      console.log('[SCAN] /scan-card request received:', {
        event: eventName,
        file: req.file.originalname,
        mimeType: req.file.mimetype,
        sizeKB: (imageBuffer.length / 1024).toFixed(2)
      });
      
      // Check file size (limit to 20MB)
      if (imageBuffer.length > 20 * 1024 * 1024) {
        fs.unlinkSync(imagePath);
        console.log('[SCAN] Rejected upload: file too large');
        return res.status(400).json({
          error: 'Image file too large. Maximum size: 20MB'
        });
      }

      console.log(`[SCAN] Original size: ${(imageBuffer.length / 1024).toFixed(2)}KB`);

      // Compress image with sharp
      imageBuffer = await sharp(imagePath)
        .resize(1200, 1200, {
          fit: 'inside',
          withoutEnlargement: true
        })
        .jpeg({ quality: 80 })
        .toBuffer();

      if (DEBUG) {
        console.log(`[SCAN] Compressed size: ${(imageBuffer.length / 1024).toFixed(2)}KB`);
      }

      const prompt = `Extract business card info as JSON only. Fields: name, designation, company, phone, email, website, address. Use empty string for missing fields.`;
      console.log('[SCAN] Sending image to Gemini API with prompt length', prompt.length);

      // Set timeout for API call (30 seconds)
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 30000);

      const result = await model.generateContent([
        prompt,
        {
          inlineData: {
            data: imageBuffer.toString('base64'),
            mimeType: 'image/jpeg'
          }
        }
      ]);

      clearTimeout(timeoutId);

      const responseText = result.response.text();
      
      let cleaned = responseText
        .replace(/```json/g, '')
        .replace(/```/g, '')
        .trim();

      const parsed = JSON.parse(cleaned);

      fs.unlinkSync(imagePath);
      console.log('[SCAN] Parsed response:', parsed);

      if (DEBUG) {
        console.log(`[SCAN] Completed in ${Date.now() - startTime}ms`);
      }

      // Return parsed data with event name and file path
      res.json({
        ...parsed,
        event_name: eventName,
        file_path: imagePath
      });

    } catch (error) {
      try {
        fs.unlinkSync(req.file.path);
      } catch (e) {}
      
      console.error('[SCAN] Scan error:', {
        message: error.message,
        stack: error.stack
      });
      
      const statusCode = error.message?.includes('abort') ? 504 : 500;
      res.status(statusCode).json({
        error: 'Failed to scan business card',
        details: error.message
      });
    }
  });
});

// Save Business Card Data to Database
app.post('/api/save-data', async (req, res) => {
  try {
    let { name, designation, company, phone, email, website, address, remarks, event_name, event, file_path } = req.body;
    event_name = normalizeEventName(event_name || event || 'default');

    // Validate required fields
    if (!name) {
      return res.status(400).json({
        error: 'Name is a required field'
      });
    }

    const query = `
      INSERT INTO business_cards (event_name, name, designation, company, phone, email, website, address, remarks, file_path)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
      RETURNING id
    `;

    const result = await pool.query(query, [event_name, name, designation, company, phone, email, website, address, remarks, file_path]);

    res.json({
      success: true,
      message: 'Data saved successfully',
      id: result.rows[0].id
    });
  } catch (error) {
    console.error('Error in save-data route:', error);
    res.status(500).json({
      error: 'Failed to save data',
      details: error.message
    });
  }
});

// Get all saved business cards (with optional event filter)
app.get('/api/get-data', async (req, res) => {
  try {
    const eventName = req.query.event_name ? normalizeEventName(req.query.event_name) : (req.query.event ? normalizeEventName(req.query.event) : undefined);
    let query = 'SELECT * FROM business_cards';
    let params = [];

    if (eventName) {
      query += ' WHERE event_name = $1';
      params.push(eventName);
    }

    query += ' ORDER BY created_at DESC';
    const result = await pool.query(query, params);
    res.json(result.rows);
  } catch (err) {
    console.error('Error fetching data:', err);
    res.status(500).json({
      error: 'Failed to fetch data',
      details: err.message
    });
  }
});

// Export saved data as CSV for Excel (with optional event filter)
app.get('/api/export-data', async (req, res) => {
  try {
    const eventName = req.query.event_name ? normalizeEventName(req.query.event_name) : (req.query.event ? normalizeEventName(req.query.event) : undefined);
    let query = 'SELECT * FROM business_cards';
    let params = [];

    if (eventName) {
      query += ' WHERE event_name = $1';
      params.push(eventName);
    }

    query += ' ORDER BY created_at DESC';
    const result = await pool.query(query, params);
    const rows = result.rows;
    console.log('[EXPORT] CSV export count:', rows.length, 'eventName:', eventName || 'all');

    const escapeCsv = (value) => {
      if (value === null || value === undefined) {
        return '';
      }
      const text = String(value);
      if (/[",\r\n]/.test(text)) {
        return `"${text.replace(/"/g, '""')}"`;
      }
      return text;
    };

    const headers = ['id', 'event_name', 'name', 'designation', 'company', 'phone', 'email', 'website', 'address', 'remarks', 'created_at'];
    const csvRows = [headers.join(',')];

    rows.forEach(row => {
      const rowValues = headers.map(header => escapeCsv(row[header]));
      csvRows.push(rowValues.join(','));
    });

    const csv = csvRows.join('\r\n');
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="business_cards.csv"');
    res.send(csv);
  } catch (err) {
    console.error('Error exporting data:', err);
    res.status(500).json({
      error: 'Failed to export data',
      details: err.message
    });
  }
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on port ${PORT}`);
});
