require("dotenv").config();
const fs = require("fs");
const path = require("path");
const { extractLicenseData } = require("./lib/claude-vision");
const { isValidRut, formatRut } = require("./lib/rut-utils");

async function main() {
  const pdfPath = path.join(__dirname, "88597 - HVC - María Fernández Robles.pdf");

  if (!fs.existsSync(pdfPath)) {
    console.error("❌ PDF no encontrado:", pdfPath);
    return;
  }

  console.log("📄 Leyendo PDF:", pdfPath);
  const pdfBuffer = fs.readFileSync(pdfPath);

  console.log("🔍 Extrayendo datos...\n");
  const data = await extractLicenseData(pdfBuffer);

  console.log("═══════════════════════════════════════");
  console.log("       DATOS EXTRAÍDOS DEL PDF");
  console.log("═══════════════════════════════════════");
  console.log(`📋 Folio:          ${data.folio || "❌ No encontrado"}`);
  console.log(`🔑 CVE:            ${data.codigo_verificacion || "❌ No encontrado"}`);
  console.log(`👤 Nombre:         ${data.nombre_completo || "❌ No encontrado"}`);
  console.log(`🆔 RUT:            ${data.rut || "❌ No encontrado"}`);
  if (data.rut) {
    console.log(`✅ RUT válido:     ${isValidRut(data.rut) ? "SÍ" : "NO"}`);
  }
  console.log(`🎂 Nacimiento:     ${data.fecha_nacimiento || "N/A"}`);
  console.log(`🚗 Última clase:   ${data.ultima_clase || "N/A"}`);
  console.log(`📍 Municipalidad:  ${data.ultima_municipalidad || "N/A"}`);
  console.log(`📅 Emisión:        ${data.fecha_emision || "N/A"}`);
  console.log(`📋 PRN:            ${data.antecedentes_prn || "N/A"}`);
  console.log(`📋 RNC:            ${data.antecedentes_rnc || "N/A"}`);
  console.log(`⚠️  Restricciones:  ${data.tiene_restricciones ? "SÍ" : "NO"}`);
  console.log(`📝 Anotaciones:    ${data.anotaciones?.length ? data.anotaciones.join(", ") : "Ninguna"}`);
  console.log("═══════════════════════════════════════\n");

  if (data.folio && data.codigo_verificacion) {
    console.log("✅ Datos críticos extraídos. Listo para verificar en Registro Civil.");
    console.log(`   URL: https://www.registrocivil.cl/OficinaInternet/verificacion/verificacioncertificado.srcei`);
    console.log(`   Folio: ${data.folio}`);
    console.log(`   CVE: ${data.codigo_verificacion}`);
  } else {
    console.log("⚠️ Faltan datos críticos para verificación en Registro Civil.");
  }
}

main().catch(console.error);
