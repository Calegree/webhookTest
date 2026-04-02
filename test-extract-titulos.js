const fs = require("fs");
const path = require("path");

const PDFS = [
  "unab-169900868-1418041.pdf",
  "UTarapaca.pdf",
  "U valparaiso.pdf",
  "U de las americas CertificadodeTitulo.pdf",
  "IACC - TituloTraicyMoreno.pdf",
  "U de Aconcagua CertificadoMauricioSantander.pdf",
];

async function extractText(pdfPath) {
  const pdfjsLib = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const data = new Uint8Array(fs.readFileSync(pdfPath));
  const doc = await pdfjsLib.getDocument({ data }).promise;
  let text = "";
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const content = await page.getTextContent();
    text += content.items.map(item => item.str).join(" ") + "\n";
  }
  return text;
}

async function main() {
  for (const file of PDFS) {
    const fullPath = path.join(__dirname, file);
    if (!fs.existsSync(fullPath)) {
      console.log(`\n❌ ${file} — NO ENCONTRADO`);
      continue;
    }
    console.log(`\n${"═".repeat(70)}`);
    console.log(`📄 ${file}`);
    console.log("═".repeat(70));
    try {
      const text = await extractText(fullPath);
      console.log(text.substring(0, 1500));
      console.log("...\n");
    } catch (err) {
      console.log(`❌ Error: ${err.message}`);
    }
  }
}

main().catch(console.error);
