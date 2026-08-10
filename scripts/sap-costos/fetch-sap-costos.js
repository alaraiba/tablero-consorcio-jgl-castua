// Lee GASTOS TOTALES (USD) de 8 PEPs del reporte SAP "Costos de Proyecto"
// (story de SAP Analytics Cloud embebido en Fiori Launchpad) y hace upsert
// en la tabla sap_costos_diarios de Supabase.
//
// Corre en GitHub Actions vía .github/workflows/sap-costos.yml, con las
// credenciales como GitHub Secrets (nunca hardcodeadas acá).
//
// NOTA IMPORTANTE PARA LA PRIMERA CORRIDA:
// Los selectores del login y del diálogo "Editar peticiones" fueron
// verificados a mano paso a paso. La extracción del valor de GASTOS
// TOTALES, en cambio, se escribió sin poder inspeccionar el DOM interno
// del story (el iframe de SAP Analytics Cloud es cross-origin y bloqueó
// la lectura directa durante el diseño de este script) — se basa en leer
// el texto plano visible de la fila y ubicar el 4to número de la fila
// (el orden de columnas SÍ fue confirmado visualmente: PRESUPUESTO |
// GASTOS ANTES DEL GO LIVE | GASTOS DESDE EL GO LIVE | GASTOS TOTALES |
// SALDO). Si esto falla, el workflow sube como artifact una captura y el
// texto crudo de la fila para poder ajustarlo.

const { chromium } = require('playwright');

const SAP_URL =
  'https://my421909.s4hana.cloud.sap/ui#ActualCosting-analyze?StoryId=5B306A8565D5053322AA4B1A4D82E20B';

const PEPS = [
  { pep_id: 'O.000003', nombre: 'Cosmopolitan' },
  { pep_id: 'O.000004', nombre: 'Artemio' },
  { pep_id: 'O.000005', nombre: 'Met del Sol' },
  { pep_id: 'O.000006', nombre: 'Torre Matter' },
  { pep_id: 'O.000007', nombre: 'Casagrande' },
  { pep_id: 'O.000022', nombre: 'Ledix' },
  { pep_id: 'O.000042', nombre: 'Blu' },
  { pep_id: 'O.000039', nombre: 'Mood Office' },
];

const NUMBER_RE = /-?\d{1,3}(?:\.\d{3})*,\d{2}/g;

function parseSapNumber(token) {
  if (!token) return null;
  const cleaned = token.trim().replace(/\./g, '').replace(',', '.');
  const value = parseFloat(cleaned);
  return Number.isFinite(value) ? value : null;
}

function todayInAsuncion() {
  // America/Asuncion -> YYYY-MM-DD
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Asuncion',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date());
  const get = (type) => parts.find((p) => p.type === type).value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}

function nowHHMMInAsuncion() {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'America/Asuncion',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(new Date());
  const get = (type) => parts.find((p) => p.type === type).value;
  return `${get('hour')}:${get('minute')}`;
}

async function loginToSap(page) {
  await page.goto(SAP_URL, { waitUntil: 'domcontentloaded' });

  const userField = page.locator('#j_username, input[name="j_username"], input[type="text"]').first();
  const passField = page.locator('#j_password, input[name="j_password"], input[type="password"]').first();

  await userField.waitFor({ timeout: 30000 });
  await userField.fill(process.env.SAP_USERNAME);
  await passField.fill(process.env.SAP_PASSWORD);
  await passField.press('Enter');

  // No usamos "networkidle": el Fiori Launchpad mantiene conexiones de
  // fondo abiertas (notificaciones, polling) que nunca llegan a estar
  // inactivas, así que ese wait nunca se cumple y siempre da timeout.
  // En cambio esperamos que exista un elemento de la pantalla ya logueada.
  // "attached" en vez de "visible" (default) porque el primer match de
  // este texto es un <h1 class="sapUiPseudoInvisibleText"> -- accesibilidad
  // para lectores de pantalla, oculto a propósito -- que nunca sería visible.
  await page.getByText('Costos de Proyecto').first().waitFor({ state: 'attached', timeout: 60000 });
}

async function handleSacLoginIfPresent(page) {
  // SAP Analytics Cloud (el story embebido, dominio analytics.cloud.sap)
  // a veces pide un segundo login propio ("Sign In" / SAC_OEM_...) además
  // del login normal de SAP S/4HANA -- pasó recién en la 6ta iteración de
  // 8 durante la primera corrida real, no en la primera carga. Se resuelve
  // con las mismas credenciales de SAP_USERNAME/SAP_PASSWORD. Se llama
  // antes de cada PEP porque puede aparecer en cualquier momento.
  const emailField = page.getByPlaceholder('Email or User Name');
  const present = await emailField.isVisible({ timeout: 3000 }).catch(() => false);
  if (!present) return false;

  await emailField.fill(process.env.SAP_USERNAME);
  await page.getByPlaceholder('Password').fill(process.env.SAP_PASSWORD);
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.waitForTimeout(4000);
  return true;
}

async function dismissInitialPromptIfPresent(page) {
  // A veces el story pide "Definir variables" apenas carga, antes de poder
  // filtrar por PEP. Si aparece, la cerramos con Cancelar — cada PEP se
  // filtra después, uno por uno, con filterByPep().
  const cancelBtn = page.getByRole('button', { name: 'Cancelar' });
  try {
    await cancelBtn.waitFor({ timeout: 15000 });
    await cancelBtn.click();
  } catch {
    // No apareció el diálogo inicial, seguimos normalmente.
  }
}

async function openVariableDialog(page) {
  await page.getByText('Herramientas', { exact: true }).click();
  await page.getByText('Editar peticiones', { exact: true }).click();
  await page.getByText('YY1_GASTOSPROYECTOS', { exact: true }).click();
  await page.getByText('Definir variables para YY1_GASTOSPROYECTOS').waitFor({ timeout: 15000 });
}

async function filterByPep(page, pepId) {
  await openVariableDialog(page);

  // Si hay un valor previo cargado, lo limpiamos con el botón "x".
  const clearBtn = page.getByRole('button', { name: '×' }).first();
  if (await clearBtn.isVisible().catch(() => false)) {
    await clearBtn.click();
  }

  const input = page.locator('input[type="text"]').last();
  await input.click();
  await input.fill(pepId);

  await page.getByRole('button', { name: 'Definir' }).click();

  // Esperar a que el story re-renderice con el filtro nuevo.
  await page.waitForTimeout(7000);
}

async function getSacFrame(page) {
  const frame = page.frames().find((f) => f.url().includes('analytics.cloud.sap'));
  if (!frame) throw new Error('No se encontró el iframe de SAP Analytics Cloud');
  return frame;
}

async function readGastosTotales(page, pepId) {
  const frame = await getSacFrame(page);
  const bodyText = await frame.locator('body').innerText({ timeout: 20000 });

  const lines = bodyText.split('\n').map((l) => l.trim()).filter(Boolean);
  const row = lines.find((l) => l.startsWith(pepId));

  if (!row) {
    throw new Error(`No se encontró una fila que empiece con "${pepId}". Primeras líneas: ${lines.slice(0, 10).join(' | ')}`);
  }

  const numbers = row.match(NUMBER_RE);
  if (!numbers || numbers.length < 4) {
    throw new Error(`Fila encontrada pero no se pudieron leer 4+ números. Fila cruda: "${row}"`);
  }

  // Orden confirmado visualmente: PRESUPUESTO, GASTOS ANTES DEL GO LIVE,
  // GASTOS DESDE EL GO LIVE, GASTOS TOTALES, SALDO.
  const gastosTotales = parseSapNumber(numbers[3]);
  if (gastosTotales === null) {
    throw new Error(`No se pudo parsear el número de GASTOS TOTALES. Fila cruda: "${row}"`);
  }
  return gastosTotales;
}

async function upsertToSupabase(rows) {
  const url = `${process.env.SUPABASE_URL}/rest/v1/sap_costos_diarios?on_conflict=fecha,pep_id`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      apikey: process.env.SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
      Prefer: 'resolution=merge-duplicates,return=minimal',
    },
    body: JSON.stringify(rows),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Supabase upsert falló (${res.status}): ${body}`);
  }
}

async function main() {
  const required = ['SAP_USERNAME', 'SAP_PASSWORD', 'SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY'];
  for (const key of required) {
    if (!process.env[key]) throw new Error(`Falta la variable de entorno ${key}`);
  }

  const fecha = todayInAsuncion();
  const hora = nowHHMMInAsuncion();

  const browser = await chromium.launch();
  // Viewport bien ancho para que las 5 columnas (PRESUPUESTO ... SALDO)
  // rendericen sin necesitar scroll horizontal -- la tabla del story
  // puede virtualizar filas/columnas fuera de vista y no traerlas al DOM.
  const page = await browser.newPage({ viewport: { width: 2200, height: 1200 } });
  const rows = [];

  try {
    await loginToSap(page);
    await handleSacLoginIfPresent(page);
    await dismissInitialPromptIfPresent(page);

    for (const { pep_id, nombre } of PEPS) {
      try {
        await handleSacLoginIfPresent(page);
        try {
          await filterByPep(page, pep_id);
        } catch (err) {
          // Si "Herramientas" no se pudo clickear, probablemente apareció
          // el login de SAC justo en este momento y bloqueó la pantalla.
          // Lo resolvemos y reintentamos este PEP una sola vez.
          const wasSacLogin = await handleSacLoginIfPresent(page);
          if (!wasSacLogin) throw err;
          await filterByPep(page, pep_id);
        }
        const gastosTotales = await readGastosTotales(page, pep_id);
        rows.push({
          fecha,
          pep_id,
          gastos_totales_usd: gastosTotales,
          estado: 'OK',
          nota: null,
        });
        console.log(`OK  ${pep_id} (${nombre}): ${gastosTotales}`);
      } catch (err) {
        rows.push({
          fecha,
          pep_id,
          gastos_totales_usd: null,
          estado: 'ERROR',
          nota: String(err.message || err).slice(0, 500),
        });
        console.error(`ERROR ${pep_id} (${nombre}):`, err.message || err);
        // Guardamos una captura para debug en el artifact del workflow.
        await page.screenshot({ path: `error-${pep_id}.png` }).catch(() => {});
      }
    }
  } finally {
    await browser.close();
  }

  console.log(`Guardando ${rows.length} filas para ${fecha} ${hora} (America/Asuncion)...`);
  await upsertToSupabase(rows);
  console.log('Listo.');

  const failed = rows.filter((r) => r.estado === 'ERROR');
  if (failed.length > 0) {
    console.error(`${failed.length} de ${rows.length} PEPs fallaron.`);
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error('Error fatal:', err);
  process.exitCode = 1;
});
