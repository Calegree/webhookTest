const Tesseract = require("tesseract.js");
const sharp = require("sharp");
const { PDFDocument } = require("pdf-lib");
const fs = require("fs");

/**
 * Extrae imágenes embebidas de un PDF usando pdf-lib
 * Los PDFs escaneados contienen las páginas como imágenes JPEG/PNG dentro del PDF
 */
async function extractImagesFromPdf(pdfBuffer) {
  const images = [];

  // pdf-lib no tiene extracción directa de imágenes,
  // pero podemos usar sharp para intentar leer el PDF directamente
  // Sharp soporta PDFs si tiene libvips con poppler
  try {
    // Intentar convertir primera página con sharp
    const imgBuffer = await sharp(pdfBuffer, { page: 0, density: 200 })
      .png()
      .toBuffer();
    images.push(imgBuffer);
    return images;
  } catch (err) {
    console.log(`   ⚠️ Sharp no pudo convertir PDF: ${err.message}`);
  }

  // Fallback: extraer imágenes raw del PDF
  const doc = await PDFDocument.load(pdfBuffer);
  const page = doc.getPage(0);

  // Buscar XObjects (imágenes) en la página
  const resources = page.node.Resources();
  if (resources) {
    const xObjects = resources.lookup(require("pdf-lib").PDFName.of("XObject"));
    if (xObjects) {
      const entries = xObjects.entries();
      for (const [name, ref] of entries) {
        try {
          const obj = xObjects.lookup(name);
          if (obj && obj.constructor.name === "PDFRawStream") {
            const data = obj.getContents();
            // Intentar como JPEG
            try {
              const pngBuf = await sharp(Buffer.from(data)).png().toBuffer();
              images.push(pngBuf);
            } catch {}
          }
        } catch {}
      }
    }
  }

  return images;
}

/**
 * Extrae texto de un PDF escaneado usando OCR (Tesseract)
 * @param {Buffer} pdfBuffer - El PDF como buffer
 * @returns {string} Texto extraído
 */
async function ocrFromPdf(pdfBuffer) {
  console.log("   🔍 OCR: Extrayendo imágenes del PDF...");

  const images = await extractImagesFromPdf(pdfBuffer);

  if (images.length === 0) {
    console.log("   ❌ No se pudieron extraer imágenes del PDF");
    return "";
  }

  console.log(`   📸 ${images.length} imagen(es) extraída(s)`);

  let fullText = "";
  for (let i = 0; i < images.length; i++) {
    console.log(`   🔤 Ejecutando OCR en imagen ${i + 1}...`);
    const result = await Tesseract.recognize(images[i], "spa", {
      logger: () => {},
    });
    fullText += result.data.text + "\n";
    console.log(`   ✅ Imagen ${i + 1}: ${result.data.text.length} caracteres`);
  }

  return fullText;
}

module.exports = { ocrFromPdf };
