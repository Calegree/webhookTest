const { chromium } = require("playwright");

/**
 * Abre un browser, navega a la URL, llena campos y lee resultado.
 * Función genérica usada por todos los validadores.
 */
async function withBrowser(fn) {
  let browser;
  try {
    browser = await chromium.launch({
      headless: true,
      args: ["--no-sandbox", "--disable-setuid-sandbox"],
    });
    const context = await browser.newContext({
      userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    });
    const page = await context.newPage();
    return await fn(page);
  } finally {
    if (browser) await browser.close();
  }
}

// ─── UNAB ────────────────────────────────────────────────────────────────────
async function validarUNAB(folio, idAlumno) {
  return withBrowser(async (page) => {
    console.log("   🌐 Navegando a certificados.unab.cl...");
    await page.goto("https://certificados.unab.cl", { waitUntil: "networkidle", timeout: 30000 });
    await page.waitForTimeout(1000 + Math.random() * 1000);

    // Obtener CSRF token
    const token = await page.locator('input[name="token"]').getAttribute("value");

    // Llenar formulario de verificación
    await page.fill('input[name="folio"]', String(folio));
    console.log(`   ✏️  Folio: ${folio}`);
    await page.waitForTimeout(300 + Math.random() * 500);

    await page.fill('input[name="rut"]', String(idAlumno));
    console.log(`   ✏️  ID Alumno: ${idAlumno}`);
    await page.waitForTimeout(300 + Math.random() * 500);

    await page.click('input[name="boton"]');
    console.log("   🖱️  Click en Aceptar...");

    await page.waitForTimeout(5000);

    const bodyText = await page.textContent("body");
    return analizarResultado(bodyText, "UNAB");
  });
}

// ─── UDLA ────────────────────────────────────────────────────────────────────
async function validarUDLA(folio, idAlumno) {
  return withBrowser(async (page) => {
    console.log("   🌐 Navegando a certificados.udla.cl/Validar...");
    await page.goto("https://certificados.udla.cl/Validar", { waitUntil: "networkidle", timeout: 30000 });
    await page.waitForTimeout(1000 + Math.random() * 1000);

    await page.fill("#id_alumno", String(idAlumno));
    console.log(`   ✏️  ID Alumno: ${idAlumno}`);
    await page.waitForTimeout(300 + Math.random() * 500);

    await page.fill("#cer_folio", String(folio));
    console.log(`   ✏️  Folio: ${folio}`);
    await page.waitForTimeout(300 + Math.random() * 500);

    // El botón es un <a> con texto "Validar"
    await page.click('a:has-text("Validar")');
    console.log("   🖱️  Click en Validar...");

    await page.waitForTimeout(5000);

    const bodyText = await page.textContent("body");
    return analizarResultado(bodyText, "UDLA");
  });
}

// ─── IACC ────────────────────────────────────────────────────────────────────
// IACC usa dos validadores: portales.iacc.cl/certificados O services10.idok.cl
async function validarIACC(codigo) {
  return withBrowser(async (page) => {
    // Primero intentar con el validador idok.cl (firma electrónica avanzada)
    const idokUrl = `https://services10.idok.cl/IACC_CERT/VERIFIER`;
    console.log("   🌐 Navegando a idok.cl/IACC_CERT/VERIFIER...");
    await page.goto(idokUrl, { waitUntil: "networkidle", timeout: 30000 });
    await page.waitForTimeout(1000 + Math.random() * 1000);

    // Buscar input de texto y llenarlo
    const input = page.locator('input[type="text"]').first();
    const inputExists = await input.count();

    if (inputExists > 0) {
      await input.fill(String(codigo));
      console.log(`   ✏️  Código: ${codigo}`);
      await page.waitForTimeout(300 + Math.random() * 500);

      await page.click('button[type="submit"], input[type="submit"], button:has-text("Verificar"), button:has-text("Validar"), a:has-text("Verificar")');
      console.log("   🖱️  Click en Verificar...");
    } else {
      // Si no hay input, la URL puede requerir el código en la ruta
      console.log("   ⚠️ No se encontró input, intentando con portales.iacc.cl...");
      await page.goto("https://portales.iacc.cl/certificados", { waitUntil: "networkidle", timeout: 30000 });
      await page.waitForTimeout(1000);
      await page.fill('input[name="codcertif"]', String(codigo));
      console.log(`   ✏️  Código: ${codigo}`);
      await page.click('input[type="submit"]');
      console.log("   🖱️  Click en Validar...");
    }

    await page.waitForTimeout(5000);

    const bodyText = await page.textContent("body");
    return analizarResultado(bodyText, "IACC");
  });
}

// ─── UTA ─────────────────────────────────────────────────────────────────────
// UTA tiene URL de validación embebida en el PDF (portal.uta.cl/validar/CODIGO)
async function validarUTA(codigo, urlValidacion) {
  return withBrowser(async (page) => {
    // Si hay URL de validación directa del PDF, usarla
    const url = urlValidacion || `https://portal.uta.cl/validar/${codigo}`;
    console.log(`   🌐 Navegando a ${url}...`);
    await page.goto(url, { waitUntil: "networkidle", timeout: 30000 });
    await page.waitForTimeout(3000);

    const bodyText = await page.textContent("body");
    console.log(`   📋 Contenido: ${bodyText.substring(0, 200)}`);
    return analizarResultado(bodyText, "UTA");
  });
}

// ─── UCV ─────────────────────────────────────────────────────────────────────
// UCV tiene API directa que retorna JSON - no necesita Playwright
const axios = require("axios");

async function validarUCV(numero, codigo) {
  const numLimpio = String(numero).replaceAll(".", "");
  console.log(`   🌐 Llamando API certificados.ucv.cl...`);
  console.log(`   ✏️  Código: ${numLimpio} | Verificador: ${codigo}`);

  try {
    const res = await axios.post(
      "https://certificados.ucv.cl/validador_nuevo/validar_certificado.php",
      `is_accion=validar_formato_nuevo&ii_codigo_certificado=${numLimpio}&is_codigo_verificador=${codigo}`,
      {
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        timeout: 15000,
      }
    );

    const body = typeof res.data === "string" ? res.data : JSON.stringify(res.data);
    console.log(`   📋 Respuesta: ${body}`);

    if (body.includes("success")) {
      return {
        valido: true,
        mensaje: "TÍTULO VERIFICADO - UCV",
        detalles: "El certificado fue validado exitosamente por certificados.ucv.cl",
      };
    }

    return {
      valido: false,
      mensaje: "TÍTULO NO VERIFICADO - UCV",
      detalles: body.substring(0, 500),
    };
  } catch (err) {
    return {
      valido: null,
      mensaje: "ERROR EN VERIFICACIÓN - UCV",
      detalles: err.message,
    };
  }
}

// ─── UAC ─────────────────────────────────────────────────────────────────────
async function validarUAC(codigo) {
  return withBrowser(async (page) => {
    console.log("   🌐 Navegando a certificados.uac.cl...");
    await page.goto("https://certificados.uac.cl", { waitUntil: "networkidle", timeout: 30000 });
    await page.waitForTimeout(1000 + Math.random() * 1000);

    await page.fill('input[type="text"]', String(codigo));
    console.log(`   ✏️  Código: ${codigo}`);
    await page.waitForTimeout(300 + Math.random() * 500);

    await page.click('button[type="submit"], input[type="submit"]');
    console.log("   🖱️  Click en Validar...");

    await page.waitForTimeout(5000);

    const bodyText = await page.textContent("body");
    return analizarResultado(bodyText, "UAC");
  });
}

// ─── Analizador de resultado genérico ────────────────────────────────────────
function analizarResultado(bodyText, universidad) {
  const text = bodyText.toLowerCase();

  // Indicadores de éxito
  const exito = [
    "válido", "valido", "verificado", "auténtico", "autentico",
    "certificado encontrado", "datos del certificado", "título",
    "titulo conferido", "título profesional", "aprobado",
    "ingenier", "licenciad", "técnico", "magíster",
  ];

  // Indicadores de fallo
  const fallo = [
    "no se encontr", "no existe", "no válido", "no valido",
    "inválido", "invalido", "error", "no se pudo",
    "datos incorrectos", "folio no", "código no",
    "caducado", "expirado", "vencido", "no corresponde",
  ];

  const esExito = exito.some((kw) => text.includes(kw));
  const esFallo = fallo.some((kw) => text.includes(kw));

  // Fallo tiene prioridad (evita falsos positivos por keywords genéricas en el HTML)
  if (esFallo) {
    return {
      valido: false,
      mensaje: `TÍTULO NO VERIFICADO - ${universidad}`,
      detalles: bodyText.substring(0, 500).trim(),
    };
  }

  if (esExito) {
    return {
      valido: true,
      mensaje: `TÍTULO VERIFICADO - ${universidad}`,
      detalles: bodyText.substring(0, 500).trim(),
    };
  }

  return {
    valido: null,
    mensaje: `REQUIERE REVISIÓN MANUAL - ${universidad}`,
    detalles: bodyText.substring(0, 500).trim(),
  };
}

// ─── Router principal ────────────────────────────────────────────────────────
/**
 * Valida un título según la universidad detectada
 * @param {string} universidadKey - Clave de la universidad (unab, udla, iacc, etc.)
 * @param {Object} datos - Datos extraídos del PDF
 * @returns {Object} { valido, mensaje, detalles }
 */
async function validarTitulo(universidadKey, datos) {
  switch (universidadKey) {
    case "unab":
      return validarUNAB(datos.folio, datos.id_alumno);
    case "udla":
      return validarUDLA(datos.folio, datos.id_alumno);
    case "iacc":
      return validarIACC(datos.codigo);
    case "uta":
      return validarUTA(datos.codigo, datos.url_validacion);
    case "ucv":
      return validarUCV(datos.numero, datos.codigo);
    case "uac":
      return validarUAC(datos.codigo);
    case "inacap":
      return {
        valido: null,
        mensaje: "VALIDACIÓN MANUAL REQUERIDA - INACAP",
        detalles: `El validador de INACAP (siga.inacap.cl) requiere resolver un CAPTCHA de imagen. Código extraído: ${datos.codigo}. Valide manualmente en: https://siga.inacap.cl/Inacap.VerificacionCertificados`,
      };
    case "uv":
      return {
        valido: null,
        mensaje: "VALIDACIÓN MANUAL REQUERIDA - U. de Valparaíso",
        detalles: `El validador de UV (verificacertificado.uv.cl) tiene protección anti-bot. Código extraído: ${datos.codigo}. Valide manualmente en: https://verificacertificado.uv.cl`,
      };
    case "ubolivariana":
      return {
        valido: null,
        mensaje: "VALIDACIÓN MANUAL REQUERIDA - U. Bolivariana",
        detalles: `El validador de U. Bolivariana está temporalmente fuera de servicio. Código extraído: ${datos.codigo}. Intente en: http://certificados.ubolivariana.cl/validacertificado.aspx`,
      };
    default:
      return {
        valido: null,
        mensaje: `Universidad "${universidadKey}" no tiene validador implementado`,
        detalles: "",
      };
  }
}

module.exports = { validarTitulo, validarUNAB, validarUDLA, validarIACC, validarUTA, validarUCV, validarUAC };
