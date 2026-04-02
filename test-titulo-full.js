require("dotenv").config();
const fs = require("fs");
const path = require("path");
const { extractTituloData } = require("./lib/titulo-extractor");
const { validarTitulo } = require("./lib/titulo-validators");
const { UNIVERSIDADES } = require("./lib/universidades");

const TESTS = [
  { file: "unab-169900868-1418041.pdf", key: "unab" },
  { file: "U de las americas CertificadodeTitulo.pdf", key: "udla" },
  { file: "IACC - TituloTraicyMoreno.pdf", key: "iacc" },
];

async function main() {
  for (const test of TESTS) {
    const fullPath = path.join(__dirname, test.file);
    console.log(`\n${"═".repeat(60)}`);
    console.log(`🧪 TEST: ${test.file}`);
    console.log("═".repeat(60));

    const buffer = fs.readFileSync(fullPath);
    const data = await extractTituloData(buffer);

    console.log(`🏫 ${data.universidad} | Folio: ${data.folio || "-"} | ID: ${data.id_alumno || "-"} | CVE: ${data.codigo || "-"}`);

    const uni = UNIVERSIDADES[test.key];
    const faltantes = uni.campos.filter(c => !data[c]);
    if (faltantes.length > 0) {
      console.log(`❌ Faltan: ${faltantes.join(", ")}`);
      continue;
    }

    console.log("🔍 Validando...");
    const resultado = await validarTitulo(test.key, data);
    console.log(`\n📋 RESULTADO: ${resultado.valido === true ? "✅ VÁLIDO" : resultado.valido === false ? "❌ NO VÁLIDO" : "⚠️ REQUIERE REVISIÓN"}`);
    console.log(`   ${resultado.mensaje}`);
    console.log(`   ${resultado.detalles.substring(0, 200)}`);
  }
}

main().catch(console.error);
