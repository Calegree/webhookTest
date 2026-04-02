require("dotenv").config();
const fs = require("fs");
const path = require("path");
const { extractLicenseData } = require("./lib/claude-vision");
const { verificarCertificado } = require("./lib/registro-civil");
const { isValidRut, formatRut } = require("./lib/rut-utils");

async function main() {
  const pdfPath = path.join(__dirname, "88597 - HVC - María Fernández Robles.pdf");

  console.log("═══════════════════════════════════════════════════");
  console.log("  TEST COMPLETO: Validación Hoja de Vida Conductor");
  console.log("═══════════════════════════════════════════════════\n");

  // ─── PASO 1: Extraer datos del PDF ────────────────────────
  console.log("📄 PASO 1: Extrayendo datos del PDF...");
  console.log(`   Archivo: ${path.basename(pdfPath)}\n`);

  const pdfBuffer = fs.readFileSync(pdfPath);
  const data = await extractLicenseData(pdfBuffer);

  console.log("\n📋 Datos extraídos:");
  console.log(`   Folio:     ${data.folio || "❌ No encontrado"}`);
  console.log(`   CVE:       ${data.codigo_verificacion || "❌ No encontrado"}`);
  console.log(`   Nombre:    ${data.nombre_completo || "❌ No encontrado"}`);
  console.log(`   RUT:       ${data.rut || "❌ No encontrado"}`);
  console.log(`   RUT válido: ${data.rut ? (isValidRut(data.rut) ? "✅ SÍ" : "❌ NO") : "N/A"}`);
  console.log(`   Clase:     ${data.ultima_clase || "N/A"}`);
  console.log(`   Emisión:   ${data.fecha_emision || "N/A"}`);
  console.log(`   PRN:       ${data.antecedentes_prn || "N/A"}`);
  console.log(`   RNC:       ${data.antecedentes_rnc || "N/A"}\n`);

  if (!data.folio || !data.codigo_verificacion) {
    console.log("❌ No se pudieron extraer folio/CVE. No se puede verificar.");
    return;
  }

  // ─── PASO 2: Verificar en Registro Civil ──────────────────
  console.log("═══════════════════════════════════════════════════");
  console.log("🔍 PASO 2: Verificando en Registro Civil...");
  console.log(`   URL: registrocivil.cl/verificacioncertificado`);
  console.log(`   Folio: ${data.folio}`);
  console.log(`   CVE:   ${data.codigo_verificacion}`);
  console.log("   Abriendo Chromium...\n");

  const resultado = await verificarCertificado(data.folio, data.codigo_verificacion);

  // ─── PASO 3: Resultado final ──────────────────────────────
  console.log("\n═══════════════════════════════════════════════════");
  console.log("📋 RESULTADO FINAL");
  console.log("═══════════════════════════════════════════════════");

  if (resultado.valido === true) {
    console.log("✅ DOCUMENTO VERIFICADO - AUTÉNTICO");
  } else if (resultado.valido === false) {
    console.log("❌ DOCUMENTO NO VÁLIDO O EXPIRADO");
  } else {
    console.log("⚠️  REQUIERE REVISIÓN MANUAL");
  }

  console.log(`\n   Mensaje: ${resultado.mensaje}`);
  console.log(`   Detalles: ${resultado.detalles}\n`);
  console.log("═══════════════════════════════════════════════════");
}

main().catch(console.error);
