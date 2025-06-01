// server.js
// ─────────────────────────────────────────────────────────────────────────────
// • Parses/upload spreadsheet (XLSX or CSV) → writes normalized rows into data.json
// • Exposes endpoints for React UI, for AI Assistant tools, and for Twilio status callbacks
// • Implements “08–18 UK” + “no-vReg” + “<3/day” + “1-min backoff” logic in /api/process
// • Adds PATCH /api/updateRecord/:bookingId so that inline edits from React update data.json
// • Adds GET   /api/download         so user can download the latest data.json as CSV
// ─────────────────────────────────────────────────────────────────────────────

require('dotenv').config();
const express = require('express');
const fs = require('fs');
const path = require('path');
const cors = require('cors');
const multer = require('multer');
const XLSX = require('xlsx');
const bodyParser = require('body-parser');
const Twilio = require('twilio');

const app = express();
app.use(cors());
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: false }));

// ─── Multer setup (for handling file uploads) ─────────────────────────────────
const upload = multer({ storage: multer.memoryStorage() });

// ─── Twilio Client ───────────────────────────────────────────────────────────
const twilioClient = Twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
);

// ─── DATA FILE SETUP ──────────────────────────────────────────────────────────
// We keep all records in a simple JSON file called data.json. On startup, if it
// doesn’t exist, create it as an empty array.

const DATA_FILE = path.join(__dirname, 'data.json');

function ensureDataFileExists() {
  if (!fs.existsSync(DATA_FILE)) {
    fs.writeFileSync(DATA_FILE, '[]', 'utf8');
  }
}
ensureDataFileExists();

function readDataFile() {
  try {
    const raw = fs.readFileSync(DATA_FILE, 'utf8');
    return JSON.parse(raw);
  } catch (e) {
    console.error('Failed to read data.json, resetting:', e);
    return [];
  }
}

function writeDataFile(arr) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(arr, null, 2), 'utf8');
}

// ─── POST /api/upload ─────────────────────────────────────────────────────────
// Upload a spreadsheet (.xlsx or .csv). We parse it in-memory, auto-detect columns,
// normalize each row (bookingId, customerName, phoneNumber, bookingDetails, etc.), and
// write the entire array into data.json (overwriting any previous content).

app.post('/api/upload', upload.single('file'), (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No file uploaded' });
  }

  let workbook;
  try {
    // Let XLSX infer CSV vs XLSX based on file extension:
    const originalName = req.file.originalname || '';
    if (originalName.match(/\.csv$/i)) {
      workbook = XLSX.read(req.file.buffer, { type: 'buffer', raw: false });
    } else {
      workbook = XLSX.read(req.file.buffer, { type: 'buffer' });
    }
  } catch (err) {
    console.error('Error reading spreadsheet:', err);
    return res.status(500).json({ error: 'Failed to parse spreadsheet' });
  }

  // Assume the first sheet contains data
  const firstSheetName = workbook.SheetNames[0];
  const worksheet = workbook.Sheets[firstSheetName];
  const rawRows = XLSX.utils.sheet_to_json(worksheet, { defval: '' });
  // rawRows is an array of JS objects, e.g. [ { "Phone": "4475...", "Booking ID": "123", "Name": "Alice", ... }, ... ]

  if (rawRows.length === 0) {
    return res
      .status(400)
      .json({ error: 'Spreadsheet is empty or unparseable' });
  }

  // Autodetect headers (case-insensitive) for important fields
  const headers = Object.keys(rawRows[0]);

  function findHeader(regex) {
    return headers.find((h) => regex.test(h)) || null;
  }
  const phoneHeader = findHeader(/phone|tel/i);
  const idHeader = findHeader(/booking\s*id|id/i);
  const nameHeader = findHeader(/customer\s*name|name/i);
  const detailsHeader = findHeader(/booking\s*details|details/i);

  // Get current date in yyyy-mm-dd (UK) for “lastAttemptDate” initial value
  function getTodayString() {
    const now = new Date();
    const yyyy = now.getFullYear();
    const mm = String(now.getMonth() + 1).padStart(2, '0');
    const dd = String(now.getDate()).padStart(2, '0');
    return `${yyyy}-${mm}-${dd}`;
  }
  const todayStr = getTodayString();

  // Normalize each raw row into our schema:
  // { bookingId, customerName, phoneNumber, bookingDetails, vRegCaptured, attemptCountToday, lastAttemptDate, lastCallTime, lastCallStatus }
  const normalized = rawRows.map((row, idx) => {
    // Extract phone, strip to digits, prepend “+” if looks valid
    const phoneRaw = phoneHeader ? String(row[phoneHeader]) : '';
    const digits = phoneRaw.replace(/\D/g, '');
    const phoneNumber = digits.length >= 5 ? '+' + digits : '';

    return {
      bookingId: idHeader ? String(row[idHeader]) : String(idx + 1),
      customerName: nameHeader ? String(row[nameHeader]) : '',
      phoneNumber: phoneNumber,
      bookingDetails: detailsHeader ? String(row[detailsHeader]) : '',
      vRegCaptured: '', // initially empty
      attemptCountToday: 0, // reset on upload
      lastAttemptDate: todayStr, // set to today so we don’t reset mid-day
      lastCallTime: '', // blank until we place a call
      lastCallStatus: '', // blank until Twilio callback
    };
  });

  // Write the full array into data.json (overwriting any existing data):
  writeDataFile(normalized);

  return res.json({ success: true, count: normalized.length });
});

// ─── GET /api/allRecords ─────────────────────────────────────────────────────
// Returns the entire data.json array as JSON, so the React UI can render it.

app.get('/api/allRecords', (req, res) => {
  const arr = readDataFile();
  return res.json(arr);
});

// ─── POST /api/process ────────────────────────────────────────────────────────
// Called by the “Process & Call” button in your React UI. We load all rows from
// data.json, then for each row we check:
//
//   1)  row.vRegCaptured is still empty
//   2)  Current time in UK is between 08:00 and 18:00
//   3)  If row.lastAttemptDate ≠ today, reset row.attemptCountToday = 0 & set lastAttemptDate = today
//   4)  row.attemptCountToday < 3
//   5)  If row.lastCallTime exists, ensure it was at least 1 minute ago
//   6)  row.phoneNumber looks valid (e.g. /^\+\d{5,}$/)
//
// If all checks pass, we immediately create a Twilio Voice call with inline TwiML that
// connects to your AI Assistant (via <Connect><Assistant>…). We then bump row.attemptCountToday,
// update lastAttemptDate & lastCallTime & set lastCallStatus = 'queued'. Finally we write back
// the updated array into data.json.

app.post('/api/process', async (req, res) => {
  const arr = readDataFile();

  // Get UK “today” and “hour”
  const now = new Date();
  const ukString = now.toLocaleString('en-GB', { timeZone: 'Europe/London' });
  const ukDate = new Date(ukString);
  const ukHour = ukDate.getHours();

  // Check business hours (08–18 UK)
  if (ukHour < 8 || ukHour >= 23) {
    return res.json({
      success: false,
      message: 'Outside UK business hours (08–18).',
    });
  }

  function getTodayString() {
    const d = ukDate;
    const yyyy = d.getFullYear();
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    return `${yyyy}-${mm}-${dd}`;
  }
  const todayStr = getTodayString();

  let callsQueued = 0;

  for (let i = 0; i < arr.length; i++) {
    const row = arr[i];

    // 1) Skip if vReg is already captured
    if (row.vRegCaptured && row.vRegCaptured.trim() !== '') {
      continue;
    }

    // 2) Reset attemptCountToday if lastAttemptDate != today
    if (row.lastAttemptDate !== todayStr) {
      row.attemptCountToday = 0;
      row.lastAttemptDate = todayStr;
    }

    // 3) Skip if attemptCountToday >= 3
    if (row.attemptCountToday >= 3) {
      continue;
    }

    // 4) Skip if lastCallTime < 1 minute ago
    if (row.lastCallTime) {
      const lastTs = new Date(row.lastCallTime);
      if (now - lastTs < 60 * 1000) {
        continue;
      }
    }

    // 5) Phone must look like “+12345…”
    if (!row.phoneNumber || !/^\+\d{5,}$/.test(row.phoneNumber)) {
      continue;
    }

    // 6) Place the call via Twilio Voice API, inline TwiML to AI Assistant
    //    – You MUST set the “Assistant” SID in your .env as TWILIO_ASSISTANT_SID
    //    – TWILIO_FROM_NUMBER in your .env as a Twilio voice-capable number
    //    – NGROK_URL (or your HTTPS domain) so Twilio can reach your /api/callStatus

    const assistantSid = process.env.TWILIO_ASSISTANT_SID || '';
    const fromNumber = process.env.TWILIO_FROM_NUMBER || '';
    const baseCallback = process.env.NGROK_URL || '';

    if (!assistantSid || !fromNumber || !baseCallback) {
      console.warn(
        'Missing TWILIO_ASSISTANT_SID or TWILIO_FROM_NUMBER or NGROK_URL in .env'
      );
    }

    // Build inline TwiML string. You can customize welcomeGreeting or voice as needed.
    const twiml = `<Response>
  <Connect>
    <Assistant
      id="${assistantSid}"
      welcomeGreeting="Hi ${row.customerName}, I’m calling about your booking. I just need your car registration number."
      voice="en-GB-KateNeural"
    />
  </Connect>
</Response>`;

    try {
      await twilioClient.calls.create({
        to: row.phoneNumber,
        from: fromNumber,
        twiml: twiml,
        statusCallback: `${baseCallback}/api/callStatus`,
        statusCallbackMethod: 'POST',
        statusCallbackEvent: ['queued', 'busy', 'no-answer', 'completed'],
      });
    } catch (err) {
      console.error(`Failed to queue call to ${row.phoneNumber}:`, err.message);
      // Even on failure, we still mark an attempt so we don’t loop forever.
    }

    // Immediately update that row’s fields:
    row.lastCallStatus = 'queued';
    row.attemptCountToday += 1;
    row.lastAttemptDate = todayStr;
    row.lastCallTime = now.toISOString();
    callsQueued++;
  }

  // Write updates back to data.json
  writeDataFile(arr);

  return res.json({ success: true, callsQueued });
});

// ─── POST /api/callStatus ────────────────────────────────────────────────────
// Twilio’s statusCallback will POST here whenever a call’s status changes:
//   – queued, ringing, in-progress, completed, busy, no-answer, etc.
// We examine payload.To (the phone number), payload.CallStatus, and update
// that row in data.json: set row.lastCallStatus = CallStatus, row.lastCallTime = now.

app.post('/api/callStatus', (req, res) => {
  const payload = req.body || {};
  const phone = payload.To;
  const status = payload.CallStatus;

  if (!phone) {
    return res.sendStatus(400);
  }

  const arr = readDataFile();
  const idx = arr.findIndex((r) => r.phoneNumber === phone);
  if (idx >= 0) {
    arr[idx].lastCallStatus = status || '';
    arr[idx].lastCallTime = new Date().toISOString();
    writeDataFile(arr);
  }
  // Always respond 200 to Twilio
  return res.sendStatus(200);
});

// ─── GET /api/getBooking ─────────────────────────────────────────────────────
// Called by your AI Assistant’s “Get booking details” tool. It looks up the row
// in data.json by phone (e.g. ?phone=+447570843709) and returns { customerName, bookingDetails }.

// ─── GET /api/getBooking ─────────────────────────────────────────────────────
// Called by Twilio AI Assistant’s “Get booking details” tool. It looks in two places:
//   1) req.query.phone (if the tool passed ?phone=+4475…)
//   2) req.headers['x-identity'] (if the tool only sent an x-identity header).
// Returns { customerName, bookingDetails } or { error: 'not found' }.

app.get('/api/getBooking', (req, res) => {
  // 1) First try query-param “phone”
  let phone = req.query.phone;

  // 2) If no ?phone=, check for X-Identity header (format: "phone:+447570843709")
  if (!phone) {
    const idH = (req.headers['x-identity'] || '').trim();
    if (idH.startsWith('phone:')) {
      phone = idH.replace(/^phone:/, '').trim();
    }
  }

  // 3) If we still have no phone, it’s a bad request
  if (!phone) {
    return res
      .status(400)
      .json({ error: 'Missing phone (query or x-identity header).' });
  }

  // 4) Look up the record in data.json
  const arr = readDataFile();
  const row = arr.find((r) => r.phoneNumber === phone);
  if (!row) {
    return res.status(404).json({ error: 'not found' });
  }

  // 5) Return exactly the two fields
  return res.json({
    customerName: row.customerName,
    bookingDetails: row.bookingDetails,
  });
});

// ─── POST /api/saveVReg ──────────────────────────────────────────────────────
// Called by your AI Assistant’s “SaveVReg” tool. Expects JSON body { phone, vReg }.
// We find that row in data.json, set vRegCaptured = vReg, and write back.

/// ─── POST /api/saveVReg ──────────────────────────────────────────────────────
// Called by your AI Assistant’s “SaveVReg” tool. It accepts either:
//   • JSON body { phone: "+447570843709", vReg: "AB12XYZ" }
//       (or) { phone_number: "+447570843709", v_reg: "AB12XYZ" }
//   • Or else X-Identity header "phone:+447570843709" + JSON { v_reg: "AB12XYZ" }.
// We look up that phone in data.json, set vRegCaptured = v_reg (or vReg), and return { ok: true }.

app.post('/api/saveVReg', (req, res) => {
  const body = req.body || {};

  // 1) Try phone from body.phone or body.phone_number
  let phone = body.phone || body.phone_number;

  // 2) If still no phone, check X-Identity header "phone:+447570843709"
  if (!phone) {
    const idHeader = (req.headers['x-identity'] || '').trim();
    if (idHeader.startsWith('phone:')) {
      phone = idHeader.replace(/^phone:/, '').trim();
    }
  }

  // 3) Try vReg from body.vReg or body.v_reg
  const vReg = body.vReg || body.v_reg;

  // 4) Now we must have both phone and vReg
  if (!phone || !vReg) {
    return res.status(400).json({ error: 'missing phone or vReg' });
  }

  // 5) Look up the record by that exact phone (e.g. "+447570843709")
  const arr = readDataFile();
  const idx = arr.findIndex((r) => r.phoneNumber === phone);
  if (idx < 0) {
    return res.status(404).json({ error: 'not found' });
  }

  // 6) Save the new registration number and write back to data.json
  arr[idx].vRegCaptured = vReg;
  writeDataFile(arr);

  return res.json({ ok: true });
});

// ─── PATCH /api/updateRecord/:bookingId ───────────────────────────────────────
// Called by React when a cell is edited. Looks for row.bookingId == :bookingId,
// applies any fields in req.body, writes back to data.json, and returns the updated row.

app.patch('/api/updateRecord/:bookingId', (req, res) => {
  const bookingIdParam = req.params.bookingId;
  const updates = req.body || {};
  const arr = readDataFile();
  const idx = arr.findIndex(
    (r) => String(r.bookingId) === String(bookingIdParam)
  );
  if (idx < 0) {
    return res.status(404).json({ error: 'Record not found' });
  }

  // Apply each update key/value to that row object
  Object.keys(updates).forEach((key) => {
    if (arr[idx].hasOwnProperty(key)) {
      arr[idx][key] = updates[key];
    }
  });

  writeDataFile(arr);
  return res.json({ ok: true, updated: arr[idx] });
});

// ─── GET /api/download ─────────────────────────────────────────────────────────
// Reads data.json, converts it to a CSV string, and sends it back with
// Content-Disposition: attachment so the browser downloads it.

app.get('/api/download', (req, res) => {
  const arr = readDataFile();
  if (!Array.isArray(arr) || arr.length === 0) {
    return res.status(400).send('No data to download');
  }

  // Compute CSV headers from the keys of the first object
  const keys = Object.keys(arr[0]);
  const headerLine = keys.join(',');

  // Convert each row into a CSV line (escaping quotes)
  const lines = arr.map((row) =>
    keys
      .map((k) => {
        let cell =
          row[k] === null || row[k] === undefined ? '' : String(row[k]);
        // Escape double quotes
        cell = cell.replace(/"/g, '""');
        // Wrap cell in double quotes if it contains comma or newline
        if (cell.includes(',') || cell.includes('\n')) {
          cell = `"${cell}"`;
        }
        return cell;
      })
      .join(',')
  );

  const csv = [headerLine, ...lines].join('\n');

  // Send CSV with headers so browser treats it as a download
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader(
    'Content-Disposition',
    'attachment; filename="data_export.csv"'
  );
  return res.send(csv);
});

// ─── SERVE REACT FRONTEND ────────────────────────────────────────────────────
// (if you run `cd frontend && npm run build`, the production build lands in
//  frontend/build. This line lets Express serve those static files.)

app.use(express.static(path.join(__dirname, 'frontend', 'build')));
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'frontend', 'build', 'index.html'));
});

// ─── START THE SERVER ────────────────────────────────────────────────────────
const PORT = process.env.PORT || 4000;
app.listen(PORT, () => {
  console.log(`Server started on http://localhost:${PORT}`);
});
