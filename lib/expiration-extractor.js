const Tesseract = require("tesseract.js");
const sharp = require("sharp");
const { PDFDocument, PDFName, PDFRef } = require("pdf-lib");
const { execSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const MESES = {
  enero: "01", febrero: "02", marzo: "03", abril: "04",
  mayo: "05", junio: "06", julio: "07", agosto: "08",
  septiembre: "09", octubre: "10", noviembre: "11", diciembre: "12",
  ene: "01", feb: "02", mar: "03", abr: "04",
  may: "05", jun: "06", jul: "07", ago: "08",
  sep: "09", oct: "10", nov: "11", dic: "12",
};

function parseDateFromText(text) {
  if (!text) return null;
  const normalized = text.toLowerCase().replace(/\s+/g, " ");

  // Patrón: "12 MAYO 2026" o "12 MAY 2026"
  const p1 = normalized.match(/(\d{1,2})\s+(enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|octubre|noviembre|diciembre|ene|feb|mar|abr|may|jun|jul|ago|sep|oct|nov|dic)\s+(\d{4})/);
  if (p1) {
    const mes = MESES[p1[2]];
    if (mes) return `${p1[3]}-${mes}-${p1[1].padStart(2, "0")}`;
  }

  // Patrón: "12/05/2026" o "12-05-2026"
  const p2 = normalized.match(/(\d{2})[\/\-](\d{2})[\/\-](\d{4})/);
  if (p2) return `${p2[3]}-${p2[2]}-${p2[1]}`;

  return null;
}

function findExpirationInLines(lines) {
  // Buscar línea con "vencimiento" y extraer fecha
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].toLowerCase();
    if (line.includes("vencimiento") || line.includes("venc")) {
      let fecha = parseDateFromText(lines[i]);
      if (!fecha && i + 1 < lines.length) {
        fecha = parseDateFromText(lines[i + 1]);
      }
      if (fecha) return fecha;
    }
  }

  // Fallback: tomar la fecha más futura del documento (suele ser el vencimiento)
  const allDates = [];
  for (const line of lines) {
    const fecha = parseDateFromText(line);
    if (fecha) allDates.push(fecha);
  }
  if (allDates.length > 0) {
    allDates.sort();
    return allDates[allDates.length - 1];
  }

  return null;
}

async function extractTextFromPdf(buffer) {
  const pdfjsLib = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const uint8 = new Uint8Array(buffer);
  const doc = await pdfjsLib.getDocument({ data: uint8, verbosity: 0 }).promise;
  let fullText = "";
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const content = await page.getTextContent();
    const pageText = content.items.map((item) => item.str).join(" ");
    fullText += pageText + "\n";
  }
  return fullText;
}

/**
 * Extrae imágenes embebidas de un PDF usando pdf-lib
 */
async function extractImagesFromPdf(buffer) {
  const images = [];
  try {
    const doc = await PDFDocument.load(buffer, { ignoreEncryption: true });
    for (let p = 0; p < doc.getPageCount(); p++) {
      const page = doc.getPage(p);
      const resources = page.node.Resources();
      if (!resources) continue;
      const xObjects = resources.lookup(PDFName.of("XObject"));
      if (!xObjects) continue;
      for (const [, ref] of xObjects.entries()) {
        try {
          const obj = ref instanceof PDFRef ? xObjects.context.lookup(ref) : ref;
          if (!obj || !obj.contents) continue;
          const data = Buffer.from(obj.contents);
          // Intentar convertir a PNG con sharp
          const pngBuf = await sharp(data).png().toBuffer();
          if (pngBuf.length > 1000) images.push(pngBuf);
        } catch {}
      }
    }
  } catch (err) {
    console.warn(`   ⚠️ Error extrayendo imágenes del PDF: ${err.message}`);
  }
  return images;
}

/**
 * Extrae la fecha de vencimiento de un CI o LC chileno.
 * Intenta: texto PDF directo → sharp PDF→imagen → imágenes embebidas → OCR
 * @param {Buffer} buffer - imagen o PDF del documento
 * @returns {string|null} fecha en formato YYYY-MM-DD o null
 */
async function extractExpirationDate(buffer) {
  const header = buffer.slice(0, 4).toString("hex");
  const isPdf = header === "25504446";

  // Estrategia 1: Si es PDF, extraer texto directo (rápido, sin OCR)
  if (isPdf) {
    try {
      const text = await extractTextFromPdf(buffer);
      if (text && text.trim().length > 20) {
        const lines = text.split("\n").map(l => l.trim()).filter(Boolean);
        const fecha = findExpirationInLines(lines);
        if (fecha) {
          console.log(`   📅 Fecha extraída via texto PDF directo`);
          return fecha;
        }
      }
    } catch (err) {
      console.warn(`   ⚠️ Extracción texto PDF falló: ${err.message}`);
    }
  }

  // Estrategia 2: Convertir PDF a imagen con pdftoppm (disponible en VPS)
  if (isPdf) {
    try {
      const tmpId = crypto.randomUUID();
      const tmpPdf = path.join("/tmp", `exp_${tmpId}.pdf`);
      const tmpImg = path.join("/tmp", `exp_${tmpId}`);
      fs.writeFileSync(tmpPdf, buffer);
      execSync(`pdftoppm -png -r 300 -f 1 -l 1 "${tmpPdf}" "${tmpImg}"`, { timeout: 15000 });
      // pdftoppm genera -1.png, -01.png o -001.png según versión
      const pngFiles = fs.readdirSync("/tmp").filter(f => f.startsWith(`exp_${tmpId}`) && f.endsWith(".png"));
      const pngFile = pngFiles.length > 0 ? path.join("/tmp", pngFiles[0]) : null;
      fs.unlinkSync(tmpPdf);
      if (pngFile && fs.existsSync(pngFile)) {
        console.log(`   🔍 pdftoppm generó: ${pngFiles[0]}`);
        const imgBuffer = fs.readFileSync(pngFile);
        const result = await Tesseract.recognize(imgBuffer, "spa", { logger: () => {} });
        const text = result.data.text || "";
        console.log(`   🔤 OCR extrajo ${text.length} caracteres del CI/LC`);
        const lines = text.split("\n").map(l => l.trim()).filter(Boolean);
        const fecha = findExpirationInLines(lines);
        fs.unlinkSync(pngFile);
        if (fecha) {
          console.log(`   📅 Fecha extraída via pdftoppm + OCR`);
          return fecha;
        }
      }
    } catch (err) {
      console.warn(`   ⚠️ pdftoppm falló: ${err.message}`);
    }
  }

  // Estrategia 3: Convertir PDF a imagen con sharp (requiere poppler en vips)
  if (isPdf) {
    try {
      const imgBuffer = await sharp(buffer, { page: 0, density: 200 }).png().toBuffer();
      const result = await Tesseract.recognize(imgBuffer, "spa", { logger: () => {} });
      const lines = (result.data.text || "").split("\n").map(l => l.trim()).filter(Boolean);
      const fecha = findExpirationInLines(lines);
      if (fecha) {
        console.log(`   📅 Fecha extraída via sharp + OCR`);
        return fecha;
      }
    } catch {
      // sharp sin poppler, intentar siguiente estrategia
    }
  }

  // Estrategia 4: Extraer imágenes embebidas del PDF y OCR sobre ellas
  if (isPdf) {
    try {
      const images = await extractImagesFromPdf(buffer);
      console.log(`   🔍 ${images.length} imagen(es) extraída(s) del PDF`);
      for (const img of images) {
        try {
          const result = await Tesseract.recognize(img, "spa", { logger: () => {} });
          const lines = (result.data.text || "").split("\n").map(l => l.trim()).filter(Boolean);
          const fecha = findExpirationInLines(lines);
          if (fecha) {
            console.log(`   📅 Fecha extraída via imagen embebida + OCR`);
            return fecha;
          }
        } catch {}
      }
    } catch (err) {
      console.warn(`   ⚠️ Extracción imágenes PDF falló: ${err.message}`);
    }
  }

  // Estrategia 5: Buffer es imagen directamente (no PDF)
  if (!isPdf) {
    try {
      const result = await Tesseract.recognize(buffer, "spa", { logger: () => {} });
      const lines = (result.data.text || "").split("\n").map(l => l.trim()).filter(Boolean);
      const fecha = findExpirationInLines(lines);
      if (fecha) {
        console.log(`   📅 Fecha extraída via OCR directo`);
        return fecha;
      }
    } catch (err) {
      console.warn(`   ⚠️ OCR directo falló: ${err.message}`);
    }
  }

  return null;
}

module.exports = { extractExpirationDate };
