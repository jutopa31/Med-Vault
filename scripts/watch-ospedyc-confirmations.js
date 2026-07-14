#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { formatScrapedAt, loadEnv, sessionFilePath } = require('./lib/agent-browser-scraper');

const SCRIPT_DIR = __dirname;
const ENV_PATH = path.join(SCRIPT_DIR, '.env');
const SESSION_SLUG = 'scrape-ospedyc-session';
const WATCHER_SLUG = 'watch-ospedyc-confirmations';

loadEnv(ENV_PATH);

const VAULT_ROOT = process.env.VAULT_ROOT || '/home/jutopa/MedVault';
const STATE_DIR = path.join(SCRIPT_DIR, 'state');
const REPORT_DIR = path.join(VAULT_ROOT, 'agenda', 'consultorios', 'ospedyc');

function parseArgs() {
  const args = process.argv.slice(2);
  let targetDate = null;
  const flags = new Set();
  for (const arg of args) {
    if (arg.startsWith('--')) flags.add(arg);
    else if (!targetDate) targetDate = arg;
  }
  return {
    headed: flags.has('--headed'),
    resetState: flags.has('--reset-state'),
    targetDate: targetDate || localDateISO(),
  };
}

function localDateISO(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function formatDateDMY(dateString) {
  const [year, month, day] = dateString.split('-');
  return `${day}/${month}/${year}`;
}

function normalizeText(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function commandExists(command) {
  const result = spawnSync('bash', ['-lc', `command -v ${command}`], { encoding: 'utf8' });
  return result.status === 0;
}

function runtime() {
  if (process.env.AGENT_BROWSER_BIN && fs.existsSync(process.env.AGENT_BROWSER_BIN)) {
    return { cmd: process.env.AGENT_BROWSER_BIN, baseArgs: [] };
  }
  if (commandExists('agent-browser')) return { cmd: 'agent-browser', baseArgs: [] };
  return { cmd: 'npx', baseArgs: ['-y', 'agent-browser'] };
}

function run(args, options = {}) {
  const rt = runtime();
  const result = spawnSync(rt.cmd, [...rt.baseArgs, ...args], {
    encoding: 'utf8',
    cwd: options.cwd || SCRIPT_DIR,
    env: { ...process.env, ...(options.env || {}) },
    maxBuffer: 20 * 1024 * 1024,
  });

  if (result.status !== 0 && !options.allowFailure) {
    throw new Error((result.stderr || result.stdout || 'Fallo agent-browser').trim());
  }

  return (result.stdout || '').trim();
}

function sleepMs(ms) {
  spawnSync('bash', ['-lc', `sleep ${Math.max(ms, 0) / 1000}`], { stdio: 'ignore' });
}

function snapshotInteractive() {
  return run(['--session', SESSION_SLUG, 'snapshot', '-i']);
}

function findButtonRef(snapshot, label) {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = snapshot.match(new RegExp(`button "${escaped}" \\[ref=(e\\d+)\\]`));
  return match ? `@${match[1]}` : null;
}

function findLinkRef(snapshot, label) {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = snapshot.match(new RegExp(`link "${escaped}" \\[ref=(e\\d+)\\]`));
  return match ? `@${match[1]}` : null;
}

function findTextboxRefs(snapshot) {
  return [...snapshot.matchAll(/textbox \[ref=(e\d+)\]/g)].map((match) => `@${match[1]}`);
}

function fillSelectDialog(consultorioValue) {
  const snapshot = snapshotInteractive();
  const textboxes = findTextboxRefs(snapshot);
  if (!snapshot.includes('Seleccione') || !textboxes.length) {
    throw new Error('No se pudo resolver el dialogo Seleccione');
  }
  run(['--session', SESSION_SLUG, 'fill', textboxes[textboxes.length - 1], consultorioValue]);
  const saveRef = findButtonRef(snapshot, 'GUARDAR');
  if (!saveRef) throw new Error('No se encontro boton GUARDAR en dialogo Seleccione');
  run(['--session', SESSION_SLUG, 'click', saveRef]);
}

function fillVisibleDateAndSearch(dateValue) {
  const snapshot = snapshotInteractive();
  const textboxRefs = findTextboxRefs(snapshot);
  const dateRef = textboxRefs[0];
  const changeDateRef = findButtonRef(snapshot, 'change date');
  if (!dateRef || !changeDateRef) {
    throw new Error('No se pudieron resolver fecha/change date');
  }

  run(['--session', SESSION_SLUG, 'fill', dateRef, dateValue]);
  run(['--session', SESSION_SLUG, 'click', changeDateRef]);
  sleepMs(800);

  const pickerSnapshot = snapshotInteractive();
  const okRef = findButtonRef(pickerSnapshot, 'OK');
  if (okRef) {
    run(['--session', SESSION_SLUG, 'click', okRef]);
    sleepMs(800);
  }

  const postPickerSnapshot = snapshotInteractive();
  const searchRef = findButtonRef(postPickerSnapshot, 'Buscar');
  if (!searchRef) throw new Error('No se encontro boton Buscar');
  run(['--session', SESSION_SLUG, 'click', searchRef]);
}

function ensureLoggedIn() {
  run(['--session', SESSION_SLUG, 'open', process.env.OSPEDYC_URL]);
  sleepMs(2000);

  const snapshot = snapshotInteractive();
  if (!snapshot.includes('Ingreso al Sistema')) return;

  run(['--session', SESSION_SLUG, 'fill', '#dni', process.env.OSPEDYC_USER]);
  run(['--session', SESSION_SLUG, 'fill', 'input[name="password"]', process.env.OSPEDYC_PASS]);
  run(['--session', SESSION_SLUG, 'click', 'button[type="submit"]']);
  sleepMs(3000);
}

function clickByExactText(text) {
  const snapshot = snapshotInteractive();
  const ref = findButtonRef(snapshot, text) || findLinkRef(snapshot, text);
  if (ref) {
    run(['--session', SESSION_SLUG, 'click', ref]);
    return;
  }

  run(['--session', SESSION_SLUG, 'eval', `(() => {
    const normalize = (value) => (value || '').replace(/\\s+/g, ' ').trim();
    const nodes = Array.from(document.querySelectorAll('button, a, [role="button"], span, div'));
    const found = nodes.find(el => normalize(el.innerText) === ${JSON.stringify(text)});
    if (!found) throw new Error('No se encontro: ' + ${JSON.stringify(text)});
    (found.closest('button, a, [role="button"]') || found).click();
    return 'ok';
  })()`]);
}

function navigateToList(targetDate) {
  clickByExactText('menu');
  sleepMs(800);
  clickByExactText('Historia Clínica Electrónica');
  sleepMs(1800);
  clickByExactText('Menu');
  sleepMs(800);
  clickByExactText('LISTADO DE PACIENTES');
  sleepMs(1200);

  let snapshot = snapshotInteractive();
  if (snapshot.includes('Seleccione')) {
    fillSelectDialog('5');
    sleepMs(2400);
    snapshot = snapshotInteractive();
  }

  fillVisibleDateAndSearch(formatDateDMY(targetDate));
  sleepMs(1800);
}

function classifyStatus(statusText, rowText) {
  const normalized = normalizeText(statusText || rowText);
  if (normalized.includes('sin confirmar')) return 'sin confirmar';
  if (normalized.includes('confirmado') || normalized.includes('confirmada') || normalized.includes('confirmados')) return 'confirmado';
  if (normalized.includes('cancelad')) return 'cancelado';
  if (normalized.includes('ausente')) return 'ausente';
  return normalized || 'desconocido';
}

function rowKey(row) {
  const carnet = normalizeText(row.carnet);
  if (carnet) return `carnet:${carnet}`;
  return `slot:${normalizeText(row.hora)}|${normalizeText(row.nombre)}`;
}

function isConfirmed(status) {
  return normalizeText(status) === 'confirmado';
}

function extractRows() {
  const raw = run(['--session', SESSION_SLUG, 'eval', `(() => {
    const normalize = (value) => (value || '').replace(/\\s+/g, ' ').trim();
    const extractName = (cell) => {
      if (!cell) return '';
      const clone = cell.cloneNode(true);
      clone.querySelectorAll('div, a').forEach((node) => node.remove());
      return normalize(clone.textContent);
    };

    const rows = Array.from(document.querySelectorAll('table tr')).map((tr) => {
      const cells = Array.from(tr.querySelectorAll('td'));
      if (!cells.length) return null;
      const rowText = normalize(tr.innerText);
      const hora = normalize(cells[1]?.innerText);
      const statusRaw = normalize(cells[2]?.innerText);
      const carnet = normalize(cells[3]?.innerText);
      const nombre = extractName(cells[4]);
      const motivo = normalize(cells[6]?.innerText);
      return { hora, statusRaw, carnet, nombre, motivo, rowText };
    }).filter(Boolean);

    return JSON.stringify(rows);
  })()`]);

  const parsed = JSON.parse(raw);
  const rows = typeof parsed === 'string' ? JSON.parse(parsed) : parsed;

  return rows
    .filter((row) => row.hora || row.nombre)
    .filter((row) => !normalizeText(row.nombre).includes('libre'))
    .map((row) => ({
      carnet: row.carnet || '',
      hora: row.hora || '-',
      key: '',
      motivo: row.motivo || '-',
      nombre: row.nombre || 'Paciente sin nombre',
      raw_status: row.statusRaw || '',
      row_text: row.rowText || '',
      status: classifyStatus(row.statusRaw, row.rowText),
    }))
    .map((row) => ({ ...row, key: rowKey(row) }));
}

function statePath(targetDate) {
  return path.join(STATE_DIR, `ospedyc-confirmations-${targetDate}.json`);
}

function reportPath(targetDate) {
  return path.join(REPORT_DIR, `${targetDate}_confirmaciones.md`);
}

function loadState(targetDate, resetState) {
  const filePath = statePath(targetDate);
  if (resetState || !fs.existsSync(filePath)) return null;
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function saveState(targetDate, rows) {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  const payload = {
    date: targetDate,
    scraped_at: formatScrapedAt(),
    rows,
    rows_by_key: Object.fromEntries(rows.map((row) => [row.key, row])),
  };
  fs.writeFileSync(statePath(targetDate), JSON.stringify(payload, null, 2));
  return payload;
}

function detectArrivals(previousState, rows) {
  if (!previousState?.rows_by_key) return [];
  return rows
    .map((row) => ({ previous: previousState.rows_by_key[row.key], row }))
    .filter(({ previous }) => previous)
    .filter(({ previous, row }) => !isConfirmed(previous.status) && isConfirmed(row.status))
    .map(({ previous, row }) => ({
      carnet: row.carnet,
      from: previous.status,
      hora: row.hora,
      motivo: row.motivo,
      nombre: row.nombre,
      to: row.status,
    }));
}

function buildReport(targetDate, rows, arrivals) {
  const lines = [
    '---',
    'type: ospedyc-confirmation-watch',
    `date: ${targetDate}`,
    `scraped_at: ${formatScrapedAt()}`,
    `arrivals: ${arrivals.length}`,
    '---',
    '',
    `# Confirmaciones OSPEDYC ${targetDate}`,
    '',
  ];

  if (arrivals.length) {
    lines.push('## Llegaron desde el ultimo control', '');
    arrivals.forEach((row) => lines.push(`- ${row.hora} | ${row.nombre} | ${row.carnet || '-'} | ${row.from} -> ${row.to}`));
    lines.push('');
  } else {
    lines.push('## Llegaron desde el ultimo control', '', '- Ninguno', '');
  }

  lines.push('## Estado actual', '');
  lines.push('| Hora | Paciente | Carnet | Estado | Motivo |');
  lines.push('|------|----------|--------|--------|--------|');
  rows.forEach((row) => lines.push(`| ${row.hora} | ${row.nombre} | ${row.carnet || '-'} | ${row.status} | ${row.motivo} |`));
  if (!rows.length) lines.push('| - | - | - | - | - |');

  return `${lines.join('\n')}\n`;
}

function sendViaOpenClaw(targetDate, arrivals) {
  const target = process.env.OSPEDYC_NOTIFY_TELEGRAM_TARGET || '681234802';
  const account = process.env.OSPEDYC_NOTIFY_TELEGRAM_ACCOUNT || 'default';
  const openclawBin = process.env.OPENCLAW_BIN || '/home/jutopa/.local/bin/openclaw';
  const cli = fs.existsSync(openclawBin) ? openclawBin : (commandExists('openclaw') ? 'openclaw' : null);
  if (!cli || !arrivals.length) return false;

  const lines = [
    `OSPEDYC ${targetDate}`,
    'Pasaron a confirmado:',
    ...arrivals.map((row) => `- ${row.hora} ${row.nombre} (${row.carnet || '-'})`),
  ];

  const result = spawnSync(cli, [
    'message', 'send',
    '--channel', 'telegram',
    '--account', account,
    '--target', target,
    '--message', lines.join('\n'),
  ], {
    encoding: 'utf8',
    cwd: SCRIPT_DIR,
    env: process.env,
  });

  if (result.status !== 0) {
    throw new Error((result.stderr || result.stdout || 'Fallo openclaw message send').trim());
  }
  return true;
}

async function notifyTelegram(targetDate, arrivals) {
  return sendViaOpenClaw(targetDate, arrivals);
}

async function main() {
  const cli = parseArgs();
  if (!process.env.OSPEDYC_URL || !process.env.OSPEDYC_USER || !process.env.OSPEDYC_PASS) {
    throw new Error(`Faltan credenciales OSPEDYC en ${ENV_PATH}`);
  }

  fs.mkdirSync(REPORT_DIR, { recursive: true });

  console.log(`[${WATCHER_SLUG}] Objetivo: ${cli.targetDate}`);
  console.log(`[${WATCHER_SLUG}] Sesion compartida: ${sessionFilePath('scrape-ospedyc')}`);

  ensureLoggedIn();
  navigateToList(cli.targetDate);
  const rows = extractRows();

  const previousState = loadState(cli.targetDate, cli.resetState);
  const arrivals = detectArrivals(previousState, rows);
  saveState(cli.targetDate, rows);
  fs.writeFileSync(reportPath(cli.targetDate), buildReport(cli.targetDate, rows, arrivals));

  if (!previousState) {
    console.log(`[${WATCHER_SLUG}] Baseline inicial guardada (${rows.length} filas).`);
    return;
  }

  if (!arrivals.length) {
    console.log(`[${WATCHER_SLUG}] Sin nuevos confirmados. Filas actuales: ${rows.length}.`);
    return;
  }

  console.log(`[${WATCHER_SLUG}] Nuevos confirmados: ${arrivals.length}`);
  arrivals.forEach((row) => console.log(`- ${row.hora} | ${row.nombre} | ${row.carnet || '-'} | ${row.from} -> ${row.to}`));

  try {
    const sent = await notifyTelegram(cli.targetDate, arrivals);
    if (sent) console.log(`[${WATCHER_SLUG}] Notificacion enviada a Telegram`);
  } catch (error) {
    console.warn(`[${WATCHER_SLUG}] No se pudo notificar Telegram: ${error.message}`);
  }
}

main().catch((error) => {
  console.error(`[${WATCHER_SLUG}] Error: ${error.message}`);
  process.exit(1);
});
