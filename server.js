
require('dotenv').config();

const express = require('express');
const cors = require('cors');
const multer = require('multer');
const fs = require('fs');
const sqlite3 = require('sqlite3').verbose();
const { GoogleGenerativeAI } = require('@google/generative-ai');
const sharp = require('sharp');

const app = express();
const upload = multer({ dest: 'uploads/', limits: { fileSize: 20 * 1024 * 1024 } });

app.use(cors());
app.use(express.json());

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

// Initialize SQLite Database
const db = new sqlite3.Database('./business_cards.db', (err) => {
  if (err) {
    console.error('Error opening database:', err);
  } else {
    console.log('Connected to SQLite database');
    // Create table if not exists
    db.run(`
      CREATE TABLE IF NOT EXISTS business_cards (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT,
        designation TEXT,
        company TEXT,
        phone TEXT,
        email TEXT,
        website TEXT,
        address TEXT,
        remarks TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `, (err) => {
      if (err) {
        console.error('Error creating table:', err);
      } else {
        console.log('Business cards table ready');
      }
    });
  }
});

app.get('/', (req, res) => {
  res.send('Business Card AI Scanner Backend Running');
});

app.post('/scan-card', upload.single('image'), async (req, res) => {
  const startTime = Date.now();
  const DEBUG = process.env.DEBUG === 'true';
  
  try {
    const model = genAI.getGenerativeModel(
      { model: process.env.GEMINI_MODEL || 'gemini-2.5-flash' },
      { apiVersion: 'v1' }
    );

    const imagePath = req.file.path;
    let imageBuffer = fs.readFileSync(imagePath);

    console.log('[SCAN] /scan-card request received:', {
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

    res.json(parsed);

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

// Save Business Card Data to Database
app.post('/save-data', (req, res) => {
  try {
    const { name, designation, company, phone, email, website, address, remarks } = req.body;

    // Validate required fields
    if (!name) {
      return res.status(400).json({
        error: 'Name is a required field'
      });
    }

    const query = `
      INSERT INTO business_cards (name, designation, company, phone, email, website, address, remarks)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `;

    db.run(query, [name, designation, company, phone, email, website, address, remarks], function(err) {
      if (err) {
        console.error('Error saving data:', err);
        return res.status(500).json({
          error: 'Failed to save data',
          details: err.message
        });
      }

      res.json({
        success: true,
        message: 'Data saved successfully',
        id: this.lastID
      });
    });

  } catch (error) {
    console.error('Error in save-data route:', error);
    res.status(500).json({
      error: 'Server error',
      details: error.message
    });
  }
});

// Get all saved business cards (optional - for viewing stored data)
app.get('/get-data', (req, res) => {
  db.all('SELECT * FROM business_cards ORDER BY created_at DESC', (err, rows) => {
    if (err) {
      console.error('Error fetching data:', err);
      return res.status(500).json({
        error: 'Failed to fetch data',
        details: err.message
      });
    }
    res.json(rows);
  });
});

// Export saved data as CSV for Excel
app.get('/export-data', (req, res) => {
  db.all('SELECT * FROM business_cards ORDER BY created_at DESC', (err, rows) => {
    if (err) {
      console.error('Error exporting data:', err);
      return res.status(500).json({
        error: 'Failed to export data',
        details: err.message
      });
    }

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

    const headers = ['id', 'name', 'designation', 'company', 'phone', 'email', 'website', 'address', 'remarks', 'created_at'];
    const csvRows = [headers.join(',')];

    rows.forEach(row => {
      const rowValues = headers.map(header => escapeCsv(row[header]));
      csvRows.push(rowValues.join(','));
    });

    const csv = csvRows.join('\r\n');
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="business_cards.csv"');
    res.send(csv);
  });
});

const PORT = 3000;

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on port ${PORT}`);
});
