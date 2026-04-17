const { chromium } = require("playwright");

const VERIFICATION_URL =
  "https://www.registrocivil.cl/OficinaInternet/verificacion/verificacioncertificado.srcei";

/**
 * Verifica la autenticidad de un certificado en el Registro Civil
 * ingresando folio + código de verificación en el portal público.
 * Si es válido, descarga el PDF generado por la página.
 *
 * @param {string} folio - Número de folio del documento
 * @param {string} codigoVerificacion - Código de verificación del documento
 * @returns {Object} { valido: boolean, mensaje: string, detalles: string, pdfBuffer: Buffer|null }
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

    // Interceptar descargas de PDF
    let pdfBuffer = null;
    const page = await context.newPage();

    // Capturar responses de PDF
    page.on("response", async (response) => {
      try {
        const contentType = response.headers()["content-type"] || "";
        if (contentType.includes("application/pdf")) {
          const body = await response.body();
          if (body && body.length > 100) {
            pdfBuffer = body;
            console.log(`   📄 PDF interceptado: ${body.length} bytes`);
          }
        }
      } catch {}
    });

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
      if (contentLower.includes("más de 60 días") || contentLower.includes("60 d")) {
        return {
          valido: false,
          mensaje: "DOCUMENTO EXPIRADO (más de 60 días desde emisión)",
          detalles: visibleText || errorText,
          pdfBuffer: null,
        };
      }
      return {
        valido: false,
        mensaje: "DOCUMENTO NO VÁLIDO",
        detalles: visibleText || errorText || "No existe certificado asociado",
        pdfBuffer: null,
      };
    }

    // Verificar éxito
    if (
      successVisible ||
      contentLower.includes("certificado es válido") ||
      contentLower.includes("certificado válido")
    ) {
      console.log(`   ✅ Certificado válido, intentando descargar PDF...`);

      // Esperar a que el visor de PDF se cargue
      await page.waitForTimeout(3000);

      // Estrategia 1: Interceptar response ya capturado
      if (pdfBuffer) {
        console.log(`   📄 PDF capturado por interceptor: ${pdfBuffer.length} bytes`);
      }

      // Estrategia 2: Buscar URL del PDF en iframe/embed y descargar via download event
      if (!pdfBuffer) {
        try {
          const pdfUrl = await page.evaluate(() => {
            const iframe = document.querySelector("iframe[src], embed[src]");
            if (iframe && iframe.src) return iframe.src;
            const obj = document.querySelector("object[data]");
            if (obj && obj.data) return obj.data;
            return null;
          });
          if (pdfUrl && pdfUrl.startsWith("http")) {
            console.log(`   🔗 URL iframe/embed: ${pdfUrl.substring(0, 120)}...`);
            // La URL dispara descarga, interceptar con download event
            const fs = require("fs");
            const downloadPage = await context.newPage();
            try {
              const [download] = await Promise.all([
                downloadPage.waitForEvent("download", { timeout: 15000 }),
                downloadPage.goto(pdfUrl, { timeout: 15000 }).catch(() => {}),
              ]);
              const downloadPath = await download.path();
              if (downloadPath) {
                pdfBuffer = fs.readFileSync(downloadPath);
                console.log(`   📄 PDF descargado via download event: ${pdfBuffer.length} bytes`);
              }
            } catch (err2) {
              console.warn(`   ⚠️ Download event falló, intentando fetch directo...`);
              // Fallback: usar fetch HTTP directo con las cookies de la sesión
              const cookies = await context.cookies();
              const cookieStr = cookies.map(c => `${c.name}=${c.value}`).join("; ");
              const axios = require("axios");
              const resp = await axios.get(pdfUrl, {
                responseType: "arraybuffer",
                timeout: 15000,
                headers: {
                  "Cookie": cookieStr,
                  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
                },
              });
              if (resp.data && resp.data.length > 500) {
                pdfBuffer = Buffer.from(resp.data);
                console.log(`   📄 PDF descargado via axios con cookies: ${pdfBuffer.length} bytes`);
              }
            }
            await downloadPage.close();
          }
        } catch (err) {
          console.warn(`   ⚠️ Estrategia iframe/download falló: ${err.message}`);
        }
      }

      // Estrategia 3: Buscar blob URL y extraer el PDF via JS
      if (!pdfBuffer) {
        try {
          const blobData = await page.evaluate(async () => {
            const iframe = document.querySelector("iframe[src^='blob:']");
            if (!iframe) return null;
            try {
              const resp = await fetch(iframe.src);
              const blob = await resp.blob();
              const reader = new FileReader();
              return new Promise((resolve) => {
                reader.onload = () => resolve(reader.result.split(",")[1]);
                reader.readAsDataURL(blob);
              });
            } catch { return null; }
          });
          if (blobData) {
            pdfBuffer = Buffer.from(blobData, "base64");
            console.log(`   📄 PDF extraído desde blob: ${pdfBuffer.length} bytes`);
          }
        } catch (err) {
          console.warn(`   ⚠️ Estrategia blob falló: ${err.message}`);
        }
      }

      // Estrategia 4: Click en botón de descarga del visor PDF
      if (!pdfBuffer) {
        try {
          const [download] = await Promise.all([
            page.waitForEvent("download", { timeout: 10000 }),
            page.click("button[aria-label*='ownload'], button[title*='ownload'], a[download], button.download, [id*='download']"),
          ]);
          const path = await download.path();
          if (path) {
            const fs = require("fs");
            pdfBuffer = fs.readFileSync(path);
            console.log(`   📄 PDF descargado via botón: ${pdfBuffer.length} bytes`);
          }
        } catch (err) {
          console.warn(`   ⚠️ Estrategia download button falló: ${err.message}`);
        }
      }

      // Estrategia 5: Reconstruir URL directa del certificado
      if (!pdfBuffer) {
        try {
          const directUrl = `https://www.registrocivil.cl/OficinaInternet/verificacion/verpdf.srcei?folio=${folio}&codigoVerificacion=${codigoVerificacion}`;
          console.log(`   🔗 Intentando URL directa: ${directUrl}`);
          const pdfPage = await context.newPage();
          const pdfRes = await pdfPage.goto(directUrl, { timeout: 15000, waitUntil: "networkidle" });
          if (pdfRes) {
            const ct = pdfRes.headers()["content-type"] || "";
            if (ct.includes("pdf")) {
              pdfBuffer = await pdfRes.body();
              console.log(`   📄 PDF descargado directo: ${pdfBuffer.length} bytes`);
            }
          }
          await pdfPage.close();
        } catch (err) {
          console.warn(`   ⚠️ Estrategia URL directa falló: ${err.message}`);
        }
      }

      if (!pdfBuffer) {
        console.warn(`   ⚠️ No se pudo descargar el PDF del Registro Civil`);
      }

      return {
        valido: true,
        mensaje: "DOCUMENTO VERIFICADO - AUTÉNTICO",
        detalles: visibleText || "El certificado es válido",
        pdfBuffer,
      };
    }

    return {
      valido: null,
      mensaje: "REQUIERE REVISIÓN MANUAL",
      detalles: allVisible.substring(0, 500).trim(),
      pdfBuffer: null,
    };
  } catch (err) {
    console.error("❌ Error en verificación Registro Civil:", err.message);
    return {
      valido: null,
      mensaje: "ERROR EN VERIFICACIÓN",
      detalles: err.message,
      pdfBuffer: null,
    };
  } finally {
    if (browser) await browser.close();
  }
}

module.exports = { verificarCertificado };
