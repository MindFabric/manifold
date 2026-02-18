const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

const JOURNAL_DIR = path.join(os.homedir(), 'Documents', 'journal');
const BUFFER_MAX_LINES = 400;
const SUMMARIZE_INTERVAL = 5 * 60 * 1000; // 5 minutes

// Per-terminal ring buffers: id -> { name, lines[] }
const buffers = new Map();

// Strip ANSI escape codes and control chars from terminal output
function stripAnsi(str) {
  return str
    .replace(/\x1B\[[0-9;]*[a-zA-Z]/g, '')
    .replace(/\x1B\][^\x07]*\x07/g, '')
    .replace(/\x1B[()][A-Z0-9]/g, '')
    .replace(/\x1B\[[\?]?[0-9;]*[a-zA-Z]/g, '')
    .replace(/[\x00-\x09\x0B-\x1F\x7F]/g, '');
}

function feed(terminalId, terminalName, data) {
  if (!buffers.has(terminalId)) {
    buffers.set(terminalId, { name: terminalName, lines: [] });
  }
  const buf = buffers.get(terminalId);
  const clean = stripAnsi(data);
  const newLines = clean.split('\n').filter(l => l.trim().length > 0);
  if (newLines.length === 0) return;

  buf.lines.push(...newLines);
  if (buf.lines.length > BUFFER_MAX_LINES) {
    buf.lines = buf.lines.slice(-BUFFER_MAX_LINES);
  }
}

function removeTerminal(terminalId) {
  buffers.delete(terminalId);
}

function getJournalPath(date) {
  const d = date || new Date();
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  const monthDir = path.join(JOURNAL_DIR, `${year}-${month}`);
  return path.join(monthDir, `${year}-${month}-${day}.md`);
}

function hasContent() {
  for (const buf of buffers.values()) {
    if (buf.lines.length > 0) return true;
  }
  return false;
}

function collectAndClear() {
  const sections = [];
  for (const [, buf] of buffers) {
    if (buf.lines.length === 0) continue;
    // Dedupe consecutive identical lines (common with progress bars etc.)
    const deduped = [];
    let prev = null;
    for (const line of buf.lines) {
      if (line !== prev) { deduped.push(line); prev = line; }
    }
    sections.push(`[${buf.name}]\n${deduped.slice(-200).join('\n')}`);
    buf.lines = [];
  }
  return sections;
}

function callClaude(prompt) {
  return new Promise((resolve, reject) => {
    const proc = spawn('claude', ['-p', prompt], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env },
    });

    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (d) => { stdout += d.toString(); });
    proc.stderr.on('data', (d) => { stderr += d.toString(); });

    const timeout = setTimeout(() => {
      proc.kill();
      reject(new Error('Claude timed out'));
    }, 60000);

    proc.on('close', (code) => {
      clearTimeout(timeout);
      if (code === 0) resolve(stdout);
      else reject(new Error(`Claude exited ${code}: ${stderr}`));
    });

    proc.on('error', (err) => {
      clearTimeout(timeout);
      reject(err);
    });
  });
}

async function summarize() {
  if (!hasContent()) return;

  const sections = collectAndClear();
  if (sections.length === 0) return;

  const context = sections.join('\n\n---\n\n');
  const now = new Date();
  const time = now.toLocaleTimeString('en-US', { hour12: true, hour: 'numeric', minute: '2-digit' });

  const prompt = `You are a concise dev journal writer. Given terminal activity from a coding session, write a brief summary of what was worked on. Rules:
- 2-5 bullet points max, each starting with "- "
- Focus on what was accomplished or attempted, not raw commands
- Mention file names and features when relevant
- If nothing meaningful happened (just idle, navigation, etc.), respond with exactly: "- Idle"
- No headers, no timestamps, no markdown formatting beyond bullet points

Terminal activity:
${context}`;

  try {
    const journalPath = getJournalPath();
    fs.mkdirSync(path.dirname(journalPath), { recursive: true });

    // Create file with date header if new
    if (!fs.existsSync(journalPath)) {
      const dateStr = now.toLocaleDateString('en-US', {
        weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
      });
      fs.writeFileSync(journalPath, `# ${dateStr}\n\n`);
    }

    const result = await callClaude(prompt);
    if (result && result.trim() && result.trim() !== '- Idle') {
      const entry = `### ${time}\n\n${result.trim()}\n\n---\n\n`;
      fs.appendFileSync(journalPath, entry);
    }
  } catch (err) {
    console.error('Journal summarize failed:', err.message);
  }
}

let intervalId = null;

function start() {
  if (intervalId) return;
  intervalId = setInterval(() => {
    summarize().catch(err => console.error('Journal error:', err.message));
  }, SUMMARIZE_INTERVAL);
}

function stop() {
  if (intervalId) {
    clearInterval(intervalId);
    intervalId = null;
  }
  // Final flush on exit
  summarize().catch(() => {});
}

module.exports = { feed, removeTerminal, start, stop, summarize, getJournalPath, JOURNAL_DIR };
