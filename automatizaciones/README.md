---
type: guide
last_updated: 2026-03-21
tags: [automatizaciones, ia]
---

# Automatizaciones Clinicas

Carpetas:

- `prompts/`: instrucciones para LLMs.
- `logs/`: ejecucion de pipelines.
- `outputs/`: artefactos intermedios si hicieran falta.

Flujo recomendado:

1. `scrape-ospedyc.js` genera agenda del dia.
2. `watch-ospedyc-confirmations.js` vigila cambios de estado en la lista.
3. `scrape-ospedyc-paciente.js` descarga HCE por paciente.
4. `normalize-patient-history.js` consolida historia.
5. `generate-patient-summary-claude.js` genera resumen y borrador.

Watcher OSPEDYC:

- Comando: `node /home/jutopa/MedVault/scripts/watch-ospedyc-confirmations.js`
- Wrapper cron: `/home/jutopa/MedVault/scripts/run-ospedyc-confirmations-cron.sh`
- Estado persistido: `scripts/state/ospedyc-confirmations-YYYY-MM-DD.json`
- Reporte: `agenda/consultorios/ospedyc/YYYY-MM-DD_confirmaciones.md`
- Prioridad de notificacion: `openclaw message send` a Telegram usando `OSPEDYC_NOTIFY_TELEGRAM_ACCOUNT` y `OSPEDYC_NOTIFY_TELEGRAM_TARGET`; si eso no existe, usa `OSPEDYC_NOTIFY_TELEGRAM_BOT_TOKEN` y `OSPEDYC_NOTIFY_TELEGRAM_CHAT_ID`.

Todos los pasos deben escribir archivos dentro del vault.

## Estado actual de scrapers

### `scrape-pilar.js`

Estado al 2026-03-21: funcionando.

- Comando validado: `DISPLAY=:0 node /home/jutopa/MedVault/scripts/scrape-pilar.js --headed`
- Flujo actual: entra directo a `Historia Clinica Web`, abre `Mis Agendas`, selecciona `NEUROLOGIA - DR ALONSO JULIAN` y extrae solo la fecha objetivo.
- Ultima verificacion funcional: genero `/home/jutopa/MedVault/agenda/consultorios/pilar/2026-03-18_lista.md` con 17 pacientes.
- Diagnosticos: `/home/jutopa/MedVault/agenda/consultorios/pilar/_debug/{YYYY-MM-DD}/`

Notas operativas:

- El portal devuelve multiples miercoles futuros; el scraper los filtra por la fecha objetivo antes de extraer.
- Si falla la navegacion visual, el motor comun usa espera explicita de selectores y fallback a click por JS para tabs legacy.
