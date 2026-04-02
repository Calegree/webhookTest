const { chromium } = require("playwright");

const VERIFICATION_URL =
  "https://www.registrocivil.cl/OficinaInternet/verificacion/verificacioncertificado.srcei";

/**
 * Verifica la autenticidad de un certificado en el Registro Civil
 * ingresando folio + código de verificación en el portal público.
 *
 * @param {string} folio - Número de folio del documento
 * @param {string} codigoVerificacion - Código de verificación del documento
 * @returns {Object} { valido: boolean, mensaje: string, detalles: string }
 */
async function verificarCertificado(folio, codigoVerificacion) {
  let browser;
  try {
    browser = await chromium.launch({
      headless: true,
      args: ["--no-sandbox", "--disable-setuid-sandbox"],
    });

    const context = await browser.newContext({
      userAgent:
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    });

    const page = await context.newPage();

    // Navegar a la página de verificación
    await page.goto(VERIFICATION_URL, {
      waitUntil: "networkidle",
      timeout: 30000,
    });

    // Espera aleatoria para parecer humano
    await page.waitForTimeout(1000 + Math.random() * 1500);

    // Llenar campo Folio (id exacto del formulario)
    await page.fill("#ver_inputFolio", String(folio));
    console.log(`   ✏️  Folio ingresado: ${folio}`);

    await page.waitForTimeout(500 + Math.random() * 500);

    // Llenar campo Código de Verificación
    await page.fill("#ver_inputCodVerificador", String(codigoVerificacion));
    console.log(`   ✏️  CVE ingresado: ${codigoVerificacion}`);

    await page.waitForTimeout(500 + Math.random() * 500);

    // Click en Consultar
    await page.click("#ver_btnConsultar");
    console.log("   🖱️  Click en Consultar...");

    // Esperar a que el loader desaparezca y aparezca un resultado
    await page.waitForTimeout(5000);

    // Revisar si el mensaje de error está visible
    const errorVisible = await page.locator("#ver_msgError").isVisible();
    const errorText = errorVisible ? await page.locator("#ver_msgError").textContent() : "";

    // Revisar si el mensaje de éxito está visible
    const successVisible = await page.locator("#ver_msgExito, .ver_classMsgExito, .alert-success").first().isVisible().catch(() => false);

    // Revisar contenido visible de la página
    const visibleText = await page.evaluate(() => {
      const elements = document.querySelectorAll('[style*="display: block"], [style*="display:block"], .alert:not([style*="display: none"]), .ver_classMsgError:not([style*="display: none"]), .ver_classMsgExito:not([style*="display: none"])');
      return Array.from(elements).map(el => el.textContent.trim()).join(' | ');
    });

    console.log(`   📊 Error visible: ${errorVisible} | Success visible: ${successVisible}`);
    console.log(`   📊 Texto visible: ${visibleText || "(vacío)"}`);

    // También capturar el texto completo como fallback
    const fullText = await page.textContent("body");
    const allVisible = visibleText || fullText;
    const contentLower = allVisible.toLowerCase();

    // Verificar si hay error (no existe certificado, expirado, etc.)
    if (
      errorVisible ||
      contentLower.includes("no existe un certificado") ||
      contentLower.includes("ha ocurrido un error") && !contentLower.includes("certificado es válido")
    ) {
      // Revisar si dentro del error está la razón específica
      if (contentLower.includes("más de 60 días") || contentLower.includes("60 d")) {
        return {
          valido: false,
          mensaje: "DOCUMENTO EXPIRADO (más de 60 días desde emisión)",
          detalles: visibleText || errorText,
        };
      }
      return {
        valido: false,
        mensaje: "DOCUMENTO NO VÁLIDO",
        detalles: visibleText || errorText || "No existe certificado asociado",
      };
    }

    // Verificar éxito
    if (
      successVisible ||
      contentLower.includes("certificado es válido") ||
      contentLower.includes("certificado válido")
    ) {
      return {
        valido: true,
        mensaje: "DOCUMENTO VERIFICADO - AUTÉNTICO",
        detalles: visibleText || "El certificado es válido",
      };
    }

    return {
      valido: null,
      mensaje: "REQUIERE REVISIÓN MANUAL",
      detalles: allVisible.substring(0, 500).trim(),
    };
  } catch (err) {
    console.error("❌ Error en verificación Registro Civil:", err.message);
    return {
      valido: null,
      mensaje: "ERROR EN VERIFICACIÓN",
      detalles: err.message,
    };
  } finally {
    if (browser) await browser.close();
  }
}

module.exports = { verificarCertificado };
