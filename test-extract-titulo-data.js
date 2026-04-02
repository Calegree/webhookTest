const fs = require("fs");
const path = require("path");
const { extractTituloData } = require("./lib/titulo-extractor");

const PDFS = [
  "unab-169900868-1418041.pdf",
  "UTarapaca.pdf",
  "U valparaiso.pdf",
  "U de las americas CertificadodeTitulo.pdf",
  "IACC - TituloTraicyMoreno.pdf",
  "U de Aconcagua CertificadoMauricioSantander.pdf",
];

async function main() {
  for (const file of PDFS) {
    const fullPath = path.join(__dirname, file);
    if (!fs.existsSync(fullPath)) { console.log(`❌ ${file} NO ENCONTRADO`); continue; }

    console.log(`\n${"═".repeat(60)}`);
    console.log(`📄 ${file}`);
    console.log("═".repeat(60));

    const buffer = fs.readFileSync(fullPath);
    const data = await extractTituloData(buffer);

    console.log(`🏫 Universidad:  ${data.universidad || "❌ No detectada"}`);
    console.log(`👤 Nombre:       ${data.nombre || "❌"}`);
    console.log(`🆔 RUT:          ${data.rut || "❌"}`);
    console.log(`🎓 Título:       ${data.titulo || "❌"}`);
    console.log(`📋 Folio:        ${data.folio || "❌"}`);
    console.log(`🔑 ID Alumno:    ${data.id_alumno || "❌"}`);
    console.log(`🔐 Código/CVE:   ${data.codigo || "❌"}`);
    console.log(`#️  Número:       ${data.numero || "❌"}`);
    console.log(`📅 Fecha:        ${data.fecha_emision || "❌"}`);

    const campos = data.universidad_key ?
      require("./lib/universidades").UNIVERSIDADES[data.universidad_key]?.campos : null;
    if (campos) {
      const tieneTodo = campos.every(c => data[c]);
      console.log(`✅ Campos para validar: ${campos.join(", ")} → ${tieneTodo ? "COMPLETOS" : "FALTAN DATOS"}`);
    } else {
      console.log(`⚠️  Universidad no mapeada, no se puede validar automáticamente`);
    }
  }
}

main().catch(console.error);
