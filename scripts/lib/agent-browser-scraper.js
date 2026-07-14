#!/usr/bin/env node
/**
 * agent-browser-scraper.js — Core del scraper de portales médicos
 * Backend: playwright-extra + puppeteer-extra-plugin-stealth
 */

const { chromium } = require('playwright');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const readline = require('readline');

const SYSTEM_CHROMIUM = '/usr/bin/chromium';
const CDP_PORT = 9355; // Puerto dedicado para medvault scrapers

// Lanzar Chromium sin flags de automatización y conectar vía CDP
async function launchRealChromium(pDir, url, headed = false) {
  fs.mkdirSync(pDir, { recursive: true });
  for (const staleName of ['SingletonLock', 'SingletonSocket', 'SingletonCookie']) {
    const stalePath = path.join(pDir, staleName);
    try {
      if (fs.existsSync(stalePath) || fs.lstatSync(stalePath)) {
        fs.rmSync(stalePath, { force: true });
      }
    } catch {
      // Ignorar locks huérfanos que ya no existan.
    }
  }

  const hasDisplay = !!process.env.DISPLAY || !!process.env.WAYLAND_DISPLAY;
  const useHeadless = !headed || !hasDisplay;

  const proc = spawn(SYSTEM_CHROMIUM, [
    `--remote-debugging-port=${CDP_PORT}`,
    `--user-data-dir=${pDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-sync',
    '--disable-gpu',
    ...(useHeadless ? ['--headless=new'] : []),
    'about:blank',
  ], { detached: false, stdio: 'ignore' });

  proc.unref();

  // Esperar a que CDP esté listo
  for (let i = 0; i < 20; i++) {
    await new Promise(r => setTimeout(r, 500));
    try {
      const res = await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`);
      if (res.ok) break;
    } catch { /* sigue esperando */ }
  }

  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${CDP_PORT}`);
  return { browser, proc };
}

// ─── Env ──────────────────────────────────────────────────────────
function loadEnv(envPath) {
  if (!fs.existsSync(envPath)) fs.writeFileSync(envPath, '', { mode: 0o600 });
  const raw = fs.readFileSync(envPath, 'utf8');
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const match = trimmed.match(/^([A-Z0-9_]+)=(.*)$/);
    if (match) process.env[match[1]] = match[2].trim();
  }
}

function updateEnvFile(envPath, values) {
  let current = fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf8') : '';
  for (const [key, value] of Object.entries(values)) {
    const safe = String(value ?? '').replace(/\r?\n/g, ' ');
    const re = new RegExp(`^${key}=.*$`, 'm');
    current = re.test(current)
      ? current.replace(re, `${key}=${safe}`)
      : `${current}${current.endsWith('\n') || current === '' ? '' : '\n'}${key}=${safe}\n`;
  }
  fs.writeFileSync(envPath, current, { mode: 0o600 });
}

async function promptCredentials({ envPath, title, urlKey, userKey, passKey }) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ask = (q) => new Promise((r) => rl.question(q, r));
  console.log(`\n[${title}] Faltan credenciales:\n`);
  const url  = (await ask(`URL del portal ${title}: `)).trim();
  const user = (await ask('Usuario: ')).trim();
  const pass = (await ask('Contrasena: ')).trim();
  rl.close();
  updateEnvFile(envPath, { [urlKey]: url, [userKey]: user, [passKey]: pass });
  process.env[urlKey] = url;
  process.env[userKey] = user;
  process.env[passKey] = pass;
}

// ─── Fechas ───────────────────────────────────────────────────────
function nextWeekday(targetWeekday) {
  const d = new Date();
  const daysUntil = (targetWeekday - d.getDay() + 7) % 7; // 0 = hoy es el día
  d.setDate(d.getDate() + daysUntil);
  return d.toISOString().split('T')[0];
}

function formatDateDMY(dateString) {
  const [year, month, day] = dateString.split('-');
  return `${day}/${month}/${year}`;
}

function formatScrapedAt(date = new Date()) {
  const off = -date.getTimezoneOffset();
  const sign = off >= 0 ? '+' : '-';
  const abs = Math.abs(off);
  const hh = String(Math.floor(abs / 60)).padStart(2, '0');
  const mm = String(abs % 60).padStart(2, '0');
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 19);
  return `${local}${sign}${hh}:${mm}`;
}

// ─── Args CLI ─────────────────────────────────────────────────────
function parseArgs(defaultDate) {
  const args = process.argv.slice(2);
  let targetDate = null;
  const flags = new Set();
  for (const arg of args) {
    if (arg.startsWith('--')) flags.add(arg);
    else if (!targetDate) targetDate = arg;
  }
  return {
    targetDate: targetDate || defaultDate,
    headed: flags.has('--headed'),
    keepSession: flags.has('--keep-session'),
    inspect: flags.has('--inspect'),
    installBrowser: flags.has('--install-browser'),
  };
}

// ─── Perfil persistente ───────────────────────────────────────────
function profileDir(slug) {
  return path.join(require('os').homedir(), '.cache', 'medvault-scrapers', `${slug}-profile`);
}

function sessionFilePath(slug) {
  return path.join(require('os').homedir(), '.cache', 'medvault-scrapers', `${slug}-session.json`);
}

function loadSession(slug) {
  const p = sessionFilePath(slug);
  return fs.existsSync(p) ? p : null;
}

function saveSession(slug, state) {
  const p = sessionFilePath(slug);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(state, null, 2));
}

function clearSession(slug) {
  const p = sessionFilePath(slug);
  if (fs.existsSync(p)) fs.unlinkSync(p);
}

// ─── Selectores ───────────────────────────────────────────────────
function selectorConfig(envPrefix, defaults = {}) {
  const toCamel = (s) => s.toLowerCase().replace(/_([a-z])/g, (_, c) => c.toUpperCase());
  const e = (k, d) => process.env[`${envPrefix}_${k}`] || defaults[k] || defaults[toCamel(k)] || d || '';
  return {
    loginUserSelector:     e('LOGIN_USER_SELECTOR', 'input[type="text"], input[name*="user"], input[name*="email"], input[id*="user"], input[id*="email"]'),
    loginPassSelector:     e('LOGIN_PASS_SELECTOR', 'input[type="password"]'),
    loginSubmitSelector:   e('LOGIN_SUBMIT_SELECTOR', ''),
    postLoginWaitMs:       Number(e('POST_LOGIN_WAIT_MS', '3000')),
    postLoginWaitSelector: e('POST_LOGIN_WAIT_SELECTOR', ''),
    dateInputSelector:     e('DATE_INPUT_SELECTOR', ''),
    dateConfirmSelector:   e('DATE_CONFIRM_SELECTOR', ''),
    dateSetScript:         e('DATE_SET_SCRIPT', ''),
    preExtractScript:      e('PRE_EXTRACT_SCRIPT', ''),
    rowSelector:           e('ROW_SELECTOR', ''),
    hourSelector:          e('HOUR_SELECTOR', ''),
    nameSelector:          e('NAME_SELECTOR', ''),
    insuranceSelector:     e('INSURANCE_SELECTOR', ''),
    reasonSelector:        e('REASON_SELECTOR', ''),
    historySelector:       e('HISTORY_SELECTOR', ''),
  };
}

// ─── Markdown ─────────────────────────────────────────────────────
function buildMarkdown({ date, patients, scrapedAt, location, title, tags }) {
  const humanDate = new Date(`${date}T12:00:00`).toLocaleDateString('es-AR', {
    weekday: 'long', year: 'numeric', month: '2-digit', day: '2-digit',
  });
  const humanDateCap = humanDate.charAt(0).toUpperCase() + humanDate.slice(1);
  const rows = patients.map((p) =>
    `| ${p.hora} | ${p.nombre} | ${p.obraSocial} | ${p.motivo} | ${p.historiaPrevia ? 'Si' : 'No'} |`
  ).join('\n');
  const histSection = patients.filter((p) => p.historiaPrevia)
    .map((p) => `### ${p.nombre}\n\n${p.historiaPrevia}\n`).join('\n');

  return `---
type: consultorio-prep
date: ${date}
location: ${location}
total_patients: ${patients.length}
source: auto-scraped
scraped_at: ${scrapedAt}
tags: [${tags.join(', ')}]
---

# Pacientes ${humanDateCap} - ${title}

| Hora | Paciente | Obra Social | Motivo | Historia previa |
|------|----------|-------------|--------|-----------------|
${rows || '| - | - | - | - | - |'}

## Historias previas

${histSection || '<!-- Sin historias previas disponibles -->'}

## Notas de preparacion

<!-- Completar antes de la consulta -->
`;
}

// ─── Login ────────────────────────────────────────────────────────
async function isLoginPage(page, loginUserSelector) {
  try {
    const sel = loginUserSelector.split(',')[0].trim(); // primer selector
    return await page.locator(sel).first().isVisible({ timeout: 3000 });
  } catch {
    return false;
  }
}

async function doLogin(page, selectors, user, pass, slug) {
  console.log(`[${slug}] Llenando credenciales...`);
  const userSel = selectors.loginUserSelector.split(',')[0].trim();
  await page.locator(userSel).first().fill(user, { timeout: 10000 });
  await page.locator(selectors.loginPassSelector).first().fill(pass);

  if (selectors.loginSubmitSelector) {
    await page.locator(selectors.loginSubmitSelector).click();
  } else {
    await page.keyboard.press('Enter');
  }

  if (selectors.postLoginWaitSelector) {
    await page.waitForSelector(selectors.postLoginWaitSelector, { timeout: 30000 });
  } else {
    await page.waitForTimeout(selectors.postLoginWaitMs);
  }
}

// ─── Extracción ───────────────────────────────────────────────────
async function extractPatients(page, selectors) {
  if (!selectors.rowSelector) return [];
  const rows = await page.locator(selectors.rowSelector).all();
  const patients = [];

  for (const row of rows) {
    const text = async (sel) => {
      if (!sel) return '';
      try {
        return (await row.locator(sel).first().textContent()).replace(/\s+/g, ' ').trim();
      } catch { return ''; }
    };

    // Extracción de nombre: solo nodos de texto (excluye tooltips ocultos)
    const extractName = async (sel) => {
      if (!sel) return '';
      try {
        return await row.locator(sel).first().evaluate(el => {
          const clone = el.cloneNode(true);
          clone.querySelectorAll('div, a').forEach(e => e.remove());
          return clone.textContent.replace(/\s+/g, ' ').trim();
        });
      } catch { return ''; }
    };

    // Obra social: extraer del tooltip oculto
    const extractObraSocial = async (sel) => {
      if (!sel) return '-';
      try {
        return await row.locator(sel).first().evaluate(el => {
          const tooltip = el.querySelector('a.tooltip div, div[style*="display:none"]');
          if (!tooltip) return '-';
          // Buscar el strong con FINANCIADOR y tomar el texto del nodo siguiente
          const strongs = tooltip.querySelectorAll('strong');
          for (const strong of strongs) {
            if (strong.textContent.trim() === 'FINANCIADOR:') {
              // El texto está en el nodo de texto que sigue al strong
              const next = strong.nextSibling;
              if (next && next.nodeType === 3) {
                const val = next.textContent.trim();
                if (val) return val;
              }
            }
          }
          return '-';
        });
      } catch { return '-'; }
    };

    const hora   = await text(selectors.hourSelector);
    const nombre = selectors.nameSelector
      ? await extractName(selectors.nameSelector)
      : '';
    const obraSocial = selectors.nameSelector && !selectors.insuranceSelector
      ? await extractObraSocial(selectors.nameSelector)
      : await text(selectors.insuranceSelector);
    const motivo = await text(selectors.reasonSelector);
    const historiaPrevia = await text(selectors.historySelector);

    if (!hora && !nombre) continue;
    if (nombre.toLowerCase().includes('libre') || nombre === '') continue;

    patients.push({
      hora: hora || '-',
      nombre: nombre || 'Paciente sin nombre',
      obraSocial: obraSocial || '-',
      motivo: motivo || '-',
      historiaPrevia: historiaPrevia || null,
    });
  }

  return patients;
}

// ─── Diagnóstico ──────────────────────────────────────────────────
async function saveDiagnostics(page, debugDir, phase) {
  fs.mkdirSync(debugDir, { recursive: true });
  await page.screenshot({ path: path.join(debugDir, `${phase}.png`), fullPage: true });
  fs.writeFileSync(path.join(debugDir, `${phase}-snapshot.html`), await page.content());
  console.log(`[diag] ${phase}.png`);
}

async function waitForSelectorState(page, selector, state = 'visible', timeout = 30000) {
  await page.locator(selector).first().waitFor({ state, timeout });
}

async function clickSelectorWithFallback(page, selector, timeout = 30000) {
  const locator = page.locator(selector).first();

  try {
    await locator.waitFor({ state: 'attached', timeout });
  } catch (err) {
    throw new Error(`No se encontro selector ${selector}: ${err.message}`);
  }

  try {
    await locator.click({ timeout: Math.min(timeout, 10000) });
    return;
  } catch {
    // Fallback para elementos cubiertos, invisibles o tabs manejados por JS legacy.
  }

  await page.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (!el) throw new Error(`No se encontró selector: ${sel}`);
    el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
    if (typeof el.click === 'function') el.click();
  }, selector);
}

// ─── Pasos configurables ──────────────────────────────────────────
async function runConfiguredSteps(page, steps, context, slug) {
  for (const step of steps || []) {
    const value = step.value === '__TARGET_DATE_DMY__' ? context.targetDateDMY : step.value;
    console.log(`[${slug}] paso: ${step.type} ${step.text || step.selector || step.label || step.ms || ''}`);

    if (step.type === 'wait') {
      await page.waitForTimeout(step.ms);
    } else if (step.type === 'waitForSelector') {
      await waitForSelectorState(page, step.selector, step.state, step.timeout);
    } else if (step.type === 'goto') {
      await page.goto(step.url, { waitUntil: step.waitUntil || 'domcontentloaded', timeout: step.timeout || 30000 });
    } else if (step.type === 'clickText') {
      await page.getByText(step.text, { exact: true }).first().click();
    } else if (step.type === 'clickTextContains') {
      await page.getByText(step.text, { exact: false }).first().click();
    } else if (step.type === 'clickSelector') {
      await clickSelectorWithFallback(page, step.selector, step.timeout);
    } else if (step.type === 'clickSelectorJs') {
      await page.evaluate((sel) => {
        const el = document.querySelector(sel);
        if (!el) throw new Error(`No se encontró selector: ${sel}`);
        el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
        if (typeof el.click === 'function') el.click();
      }, step.selector);
    } else if (step.type === 'fillSelector') {
      await page.locator(step.selector).fill(value);
    } else if (step.type === 'fillByLabel') {
      await page.getByLabel(step.label).fill(value);
    } else if (step.type === 'fillFirstTextbox') {
      await page.locator('input[type="text"]:visible, input:not([type]):visible').first().fill(value);
    } else if (step.type === 'eval') {
      const script = step.script.replaceAll('__TARGET_DATE__', context.targetDate).replaceAll('__TARGET_DATE_DMY__', context.targetDateDMY);
      await page.evaluate(script);
    } else if (step.type === 'clickTextJs') {
      // Click por JS, ignora visibilidad — útil para sidebars colapsados
      await page.evaluate((text) => {
        const el = Array.from(document.querySelectorAll('a, button, li, span, div'))
          .find(e => e.textContent.trim() === text || e.textContent.includes(text));
        if (!el) throw new Error(`No se encontró elemento con texto: ${text}`);
        el.click();
      }, step.text);
    } else {
      throw new Error(`Paso no soportado: ${step.type}`);
    }
    await page.waitForTimeout(500);
  }
}

// ─── runPortalScraper ─────────────────────────────────────────────
async function runPortalScraper(config) {
  const envPath = path.join(__dirname, '..', '.env');
  loadEnv(envPath);

  const cli = parseArgs(nextWeekday(config.targetWeekday));

  if (cli.installBrowser) {
    const { execSync } = require('child_process');
    execSync('npx playwright install chromium', { stdio: 'inherit', cwd: path.join(__dirname, '..') });
    return;
  }

  const url  = process.env[config.urlKey];
  const user = process.env[config.userKey];
  const pass = process.env[config.passKey];

  if (!url || url === 'https://' || !user || !pass) {
    if (!process.stdin.isTTY) throw new Error(`Faltan credenciales en ${envPath}`);
    await promptCredentials({ envPath, title: config.title, urlKey: config.urlKey, userKey: config.userKey, passKey: config.passKey });
  }

  const finalUrl  = process.env[config.urlKey];
  const selectors = selectorConfig(config.envPrefix, config.defaultSelectors);
  const headed    = cli.headed || process.env.HEADLESS === 'false';
  const outputDir = path.join(process.env.VAULT_ROOT || '/home/jutopa/MedVault', 'agenda', 'consultorios', config.outputDirName);
  const debugDir  = path.join(outputDir, '_debug', cli.targetDate);
  fs.mkdirSync(outputDir, { recursive: true });

  console.log(`[${config.slug}] Objetivo:  ${cli.targetDate}`);
  console.log(`[${config.slug}] Portal:    ${finalUrl}`);
  console.log(`[${config.slug}] Modo:      Chromium real via CDP (sin flags de automatizacion)`);

  const pDir = profileDir(config.slug);
  console.log(`[${config.slug}] Perfil:    ${pDir}`);

  const { browser, proc: chromeProc } = await launchRealChromium(pDir, finalUrl, headed);

  const contexts = browser.contexts();
  const browserCtx = contexts[0] || await browser.newContext();
  const pages = browserCtx.pages();
  const page = pages[0] || await browserCtx.newPage();

  // Inyectar cookies guardadas de la sesión anterior
  const savedSession = loadSession(config.slug);
  if (savedSession) {
    try {
      const state = JSON.parse(fs.readFileSync(savedSession, 'utf8'));
      if (state.cookies?.length) {
        await browserCtx.addCookies(state.cookies);
        console.log(`[${config.slug}] Cookies restauradas (${state.cookies.length})`);
      }
    } catch { /* sesión corrupta, ignorar */ }
  }

  // Navegar al portal
  await page.goto(finalUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });

  let patients = [];

  try {
    await page.waitForTimeout(2000);
    await saveDiagnostics(page, debugDir, '01-inicial');

    const needsLogin = await isLoginPage(page, selectors.loginUserSelector);

    if (needsLogin) {
      const user = process.env[config.userKey];
      const pass = process.env[config.passKey];

      if (user && pass && selectors.loginUserSelector) {
        console.log(`[${config.slug}] Intentando auto-login...`);
        await doLogin(page, selectors, user, pass, config.slug);
        const stillOnLogin = await isLoginPage(page, selectors.loginUserSelector);
        if (stillOnLogin) {
          console.log(`[${config.slug}] Auto-login falló — esperando login manual...`);
          const loginSel = selectors.loginUserSelector.split(',')[0].trim();
          await page.waitForFunction(
            (sel) => !document.querySelector(sel),
            loginSel,
            { timeout: 180000, polling: 1500 }
          );
        }
      } else {
        console.log(`[${config.slug}] Esperando login manual en el browser que se abrió...`);
        const loginSel = selectors.loginUserSelector.split(',')[0].trim();
        await page.waitForFunction(
          (sel) => !document.querySelector(sel),
          loginSel,
          { timeout: 180000, polling: 1500 }
        );
      }

      console.log(`[${config.slug}] Login exitoso`);
      await page.waitForTimeout(2000);
      await saveDiagnostics(page, debugDir, '02-post-login');
    } else {
      console.log(`[${config.slug}] Sesion activa — saltando login`);
    }

    // Guardar cookies explícitamente antes de que Chromium sea cerrado
    saveSession(config.slug, await browserCtx.storageState());
    console.log(`[${config.slug}] Sesion guardada en: ${sessionFilePath(config.slug)}`);

    // Navegación y extracción
    const stepsCtx = { targetDate: cli.targetDate, targetDateDMY: formatDateDMY(cli.targetDate) };
    await runConfiguredSteps(page, config.steps, stepsCtx, config.slug);

    if (selectors.dateSetScript) {
      await page.evaluate(selectors.dateSetScript.replaceAll('__TARGET_DATE__', cli.targetDate));
      await page.waitForTimeout(1000);
    } else if (selectors.dateInputSelector) {
      await page.locator(selectors.dateInputSelector).fill(cli.targetDate);
      if (selectors.dateConfirmSelector) await page.locator(selectors.dateConfirmSelector).click();
      await page.waitForTimeout(1000);
    }

    if (selectors.preExtractScript) {
      await page.evaluate(selectors.preExtractScript.replaceAll('__TARGET_DATE__', cli.targetDate));
      await page.waitForTimeout(1000);
    }

    await saveDiagnostics(page, debugDir, '03-grilla');

    if (!selectors.rowSelector) {
      console.warn(`[${config.slug}] Sin ${config.envPrefix}_ROW_SELECTOR — revisar snapshots en ${debugDir}`);
    } else if (!cli.inspect) {
      patients = await extractPatients(page, selectors);
    }

  } finally {
    await browser.close();
    chromeProc.kill('SIGTERM');
    await new Promise(r => setTimeout(r, 1000));
  }

  // Escribir vault
  const outFile = path.join(outputDir, `${cli.targetDate}_lista.md`);
  fs.writeFileSync(outFile, buildMarkdown({
    date: cli.targetDate, patients, scrapedAt: formatScrapedAt(),
    location: config.location, title: config.title, tags: config.tags,
  }));

  console.log(`\n[${config.slug}] Vault: ${outFile}`);
  console.log(`[${config.slug}] Diagnosticos: ${debugDir}`);

  if (patients.length === 0) {
    console.log(`[${config.slug}] Sin turnos extraidos.`);
    if (!selectors.rowSelector) console.log(`  Configurar selectores en scripts/.env`);
  } else {
    console.log(`[${config.slug}] ${patients.length} pacientes:`);
    for (const p of patients) console.log(`  ${p.hora} - ${p.nombre} (${p.obraSocial})`);
  }
}

module.exports = {
  doLogin,
  formatDateDMY,
  formatScrapedAt,
  isLoginPage,
  launchRealChromium,
  loadEnv,
  loadSession,
  nextWeekday,
  profileDir,
  runConfiguredSteps,
  runPortalScraper,
  saveSession,
  selectorConfig,
  sessionFilePath,
};
