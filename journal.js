const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

const JOURNAL_DIR = path.join(os.homedir(), 'Documents', 'journal');
const BUFFER_MAX_LINES = 400;
const SUMMARIZE_INTERVAL = 5 * 60 * 1000; // 5 minutes

// Per-terminal ring buffers: id -> { name, collection, lines[] }
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

function feed(terminalId, terminalName, collectionName, data) {
  if (!buffers.has(terminalId)) {
    buffers.set(terminalId, { name: terminalName, collection: collectionName || 'unknown', lines: [] });
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

function collect() {
  // Group terminal output by collection (project)
  const byCollection = new Map(); // collection -> [{ name, lines }]
  const snapshotCounts = new Map();
  for (const [id, buf] of buffers) {
    if (buf.lines.length === 0) continue;
    // Dedupe consecutive identical lines (common with progress bars etc.)
    const deduped = [];
    let prev = null;
    for (const line of buf.lines) {
      if (line !== prev) { deduped.push(line); prev = line; }
    }
    const col = buf.collection || 'unknown';
    if (!byCollection.has(col)) byCollection.set(col, []);
    byCollection.get(col).push({ name: buf.name, lines: deduped.slice(-200) });
    snapshotCounts.set(id, buf.lines.length);
  }

  // Build sections grouped by collection
  const sections = [];
  const collections = [];
  for (const [col, terminals] of byCollection) {
    collections.push(col);
    const parts = terminals.map(t => `[${t.name}]\n${t.lines.join('\n')}`);
    sections.push(`## Project: ${col}\n\n${parts.join('\n\n')}`);
  }
  return { sections, collections, snapshotCounts };
}

function clearCollected(snapshotCounts) {
  for (const [id, count] of snapshotCounts) {
    const buf = buffers.get(id);
    if (buf) {
      // Only remove the lines we snapshotted; keep any new lines that arrived since
      buf.lines = buf.lines.slice(count);
    }
  }
}

function callClaude(prompt) {
  return new Promise((resolve, reject) => {
    const cleanEnv = { ...process.env };
    delete cleanEnv.CLAUDECODE;
    delete cleanEnv.CLAUDE_CODE_ENTRYPOINT;

    const proc = spawn('claude', ['-p'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: cleanEnv,
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

    // Pipe prompt via stdin instead of CLI argument to handle large output
    proc.stdin.write(prompt);
    proc.stdin.end();
  });
}

async function summarize() {
  if (!hasContent()) return;

  const { sections, collections, snapshotCounts } = collect();
  if (sections.length === 0) return;

  const context = sections.join('\n\n---\n\n');
  const now = new Date();
  const time = now.toLocaleTimeString('en-US', { hour12: true, hour: 'numeric', minute: '2-digit' });
  const multiProject = collections.length > 1;

  const prompt = `You are a concise dev journal writer. Given terminal activity from a coding session, write a brief summary of what was worked on. Rules:
- 2-5 bullet points per project, each starting with "- "
- Focus on what was accomplished or attempted, not raw commands
- Mention file names and features when relevant
${multiProject ? '- Group bullets under each project using the format: **ProjectName** on its own line, followed by bullet points\n- Keep the **ProjectName** headers exactly as given in the "Project:" labels below' : '- Start your response with **ProjectName** (using the project name from below) on its own line, followed by bullet points'}
- If nothing meaningful happened for a project (just idle, navigation, etc.), omit that project entirely
- No headers beyond the project names, no timestamps, no other markdown formatting

Terminal activity:
${context}`;

  const journalPath = getJournalPath();
  fs.mkdirSync(path.dirname(journalPath), { recursive: true });

  // Create file with date header if new
  if (!fs.existsSync(journalPath)) {
    const dateStr = now.toLocaleDateString('en-US', {
      weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
    });
    fs.writeFileSync(journalPath, `# ${dateStr}\n\n`);
  }

  try {
    const result = await callClaude(prompt);
    if (result && result.trim() && result.trim() !== '- Idle') {
      const entry = `### ${time}\n\n${result.trim()}\n\n---\n\n`;
      fs.appendFileSync(journalPath, entry);
    }
    // Only clear buffers after successful summarization
    clearCollected(snapshotCounts);
  } catch (err) {
    console.error('Journal summarize failed:', err.message);
    // Fallback: write a raw activity note so the day isn't empty
    const fallbackLines = collections.map(c => `**${c}**\n- Active (auto-summary unavailable)`).join('\n\n');
    const fallback = `### ${time}\n\n${fallbackLines}\n\n---\n\n`;
    try {
      fs.appendFileSync(journalPath, fallback);
    } catch (_) {}
    // Still clear buffers to avoid infinite retry of the same failing data
    clearCollected(snapshotCounts);
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

function getBufferLines(terminalId) {
  const buf = buffers.get(terminalId);
  if (!buf || buf.lines.length === 0) return null;
  return buf.lines.slice(-100);
}

module.exports = { feed, removeTerminal, start, stop, summarize, getJournalPath, getBufferLines, callClaude, JOURNAL_DIR };
