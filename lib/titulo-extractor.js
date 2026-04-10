const fs = require("fs");
const sharp = require("sharp");
const Tesseract = require("tesseract.js");
const { detectarUniversidad } = require("./universidades");
const { ocrFromPdf } = require("./ocr");

/**
 * Extrae texto de un PDF usando pdfjs-dist
 */
async function extractTextFromPdf(pdfBuffer) {
  const pdfjsLib = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const uint8 = new Uint8Array(pdfBuffer);
  const doc = await pdfjsLib.getDocument({ data: uint8 }).promise;

  let fullText = "";
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const content = await page.getTextContent();
    fullText += content.items.map((item) => item.str).join(" ") + "\n";
  }
  return fullText;
}

/**
 * Intenta OCR con rotaciones (0°, 90°, -90°, 180°) hasta detectar una universidad.
 * Útil para títulos escaneados que fueron subidos rotados.
 */
async function ocrWithRotations(pdfBuffer) {
  const rotations = [0, 90, -90, 180];
  let imgBuffer;

  // Convertir PDF a imagen
  try {
    imgBuffer = await sharp(pdfBuffer, { page: 0, density: 200, failOn: "none" }).png().toBuffer();
  } catch {
    // Si sharp no puede, extraer imágenes del PDF
    const { PDFDocument } = require("pdf-lib");
    const doc = await PDFDocument.load(pdfBuffer);
    const page = doc.getPage(0);
    const resources = page.node.Resources();
    if (resources) {
      const xObjects = resources.lookup(require("pdf-lib").PDFName.of("XObject"));
      if (xObjects) {
        for (const [name] of xObjects.entries()) {
          try {
            const obj = xObjects.lookup(name);
            if (obj && obj.constructor.name === "PDFRawStream") {
              imgBuffer = await sharp(Buffer.from(obj.getContents())).png().toBuffer();
              break;
            }
          } catch {}
        }
      }
    }
  }

  if (!imgBuffer) return { text: "", rotation: 0 };

  for (const angle of rotations) {
    let rotated = imgBuffer;
    if (angle !== 0) {
      rotated = await sharp(imgBuffer, { failOn: "none" }).rotate(angle).toBuffer();
    }

    const result = await Tesseract.recognize(rotated, "spa", { logger: () => {} });
    const text = result.data.text;

    if (detectarUniversidad(text)) {
      console.log(`   🔄 Universidad detectada con rotación ${angle}°`);
      return { text, rotation: angle };
    }

    // Si es la primera iteración (sin rotar), guardar el texto por si ninguna rotación detecta universidad
    if (angle === 0 && text.length > 50) {
      var fallbackText = text;
    }
  }

  return { text: fallbackText || "", rotation: 0 };
}

/**
 * Extrae datos de validación de un certificado de título chileno.
 * Detecta universidad y extrae folio, código, RUT, nombre, título.
 * Si el documento está rotado, intenta OCR con rotaciones.
 */
async function extractTituloData(pdfBuffer) {
  let text = await extractTextFromPdf(pdfBuffer);

  // Si el texto está vacío o muy corto, el PDF es una imagen → usar OCR
  const cleanText = text.replace(/\s+/g, "").trim();
  if (cleanText.length < 50) {
    console.log("   ⚠️ PDF sin texto seleccionable, activando OCR...");
    text = await ocrFromPdf(pdfBuffer, [1]);
    console.log(`   📝 OCR extrajo ${text.length} caracteres`);
  }

  let universidad = detectarUniversidad(text);

  // Si no se detectó universidad, intentar OCR con rotaciones
  if (!universidad && cleanText.length < 50) {
    console.log("   🔄 Universidad no detectada, intentando con rotaciones...");
    const rotResult = await ocrWithRotations(pdfBuffer);
    if (rotResult.text.length > 0) {
      text = rotResult.text;
      universidad = detectarUniversidad(text);
      if (universidad) {
        console.log(`   ✅ Universidad detectada tras rotar ${rotResult.rotation}°: ${universidad.nombre}`);
      }
    }
  }

  // Si no se detectó universidad en el registro, intentar extraer el nombre del texto
  let uniNombre = universidad ? universidad.nombre : null;
  if (!uniNombre) {
    // Buscar patrones: "UNIVERSIDAD ...", "INSTITUTO PROFESIONAL ...", "CENTRO DE FORMACIÓN ..."
    const uniPatterns = [
      /(?:la\s+|el\s+)?(UNIVERSIDAD\s+(?:DE\s+|TECNOL[ÓO]GICA\s+(?:DE\s+)?)?[A-ZÁÉÍÓÚÑ\s]+?)(?:\s+y\s+ha|\s+certific|\s+confier|\s+otorg|\s*\n)/i,
      /(?:la\s+|el\s+)?(INSTITUTO\s+PROFESIONAL\s+[A-ZÁÉÍÓÚÑ\s]+?)(?:\s+y\s+ha|\s+certific|\s+confier|\s+otorg|\s*\n)/i,
      /(?:la\s+|el\s+)?(CENTRO\s+DE\s+FORMACI[ÓO]N\s+T[ÉE]CNICA\s+[A-ZÁÉÍÓÚÑ\s]+?)(?:\s+y\s+ha|\s+certific|\s+confier|\s+otorg|\s*\n)/i,
    ];
    for (const pattern of uniPatterns) {
      const match = text.match(pattern);
      if (match) {
        // Capitalizar: "UNIVERSIDAD DE SANTIAGO DE CHILE" → "Universidad de Santiago de Chile"
        uniNombre = match[1].replace(/\s+/g, " ").trim()
          .replace(/\b[A-ZÁÉÍÓÚÑ]{2,}\b/g, (w) => w.charAt(0) + w.slice(1).toLowerCase())
          .replace(/^(Universidad|Instituto|Centro)/, (w) => w.charAt(0).toUpperCase() + w.slice(1));
        console.log(`   🏫 Universidad extraída del texto: ${uniNombre}`);
        break;
      }
    }
  }

  const data = {
    universidad: uniNombre,
    universidad_key: universidad ? universidad.key : null,
    nombre: null,
    rut: null,
    titulo: null,
    folio: null,
    id_alumno: null,
    codigo: null,
    numero: null,
    fecha_emision: null,
    texto_crudo: text,
  };

  // ── Folio (varias universidades lo usan) ──
  const folioMatch = text.match(/Folio\s*:?\s*(\d+)/i);
  if (folioMatch) data.folio = folioMatch[1];

  // ── ID Alumno (UNAB, UDLA) ──
  const idAlumnoMatch = text.match(/ID\s*Alumno\s*:?\s*(\d+)/i);
  if (idAlumnoMatch) data.id_alumno = idAlumnoMatch[1];

  // ── CVE / Código de verificación ──
  const cveMatch = text.match(/CVE\s*:?\s*([a-f0-9]{16,})/i);
  if (cveMatch) data.codigo = cveMatch[1];

  // Si no hay CVE, buscar "Código de Verificación" genérico (puede tener salto de línea)
  if (!data.codigo) {
    const codMatch = text.match(/[Cc][OÓoó]DIGO\s*(?:DE\s*)?[Vv]ERIFICACI[OÓoó]N\s*:?\s*([A-Fa-f0-9]{6,})/i);
    if (codMatch) data.codigo = codMatch[1];
  }
  // Fallback: buscar con salto de línea/espacio entre label y código
  if (!data.codigo) {
    const codMatch2 = text.match(/VERIFICACI[OÓ]N[\s\n:]+([A-Fa-f0-9]{8,})/i);
    if (codMatch2) data.codigo = codMatch2[1];
  }

  // ── Verificador (UCV: "Verificador c444cdab23") ──
  if (!data.codigo) {
    const verifMatch = text.match(/[Vv]erificador\s+([a-f0-9]{6,})/i);
    if (verifMatch) data.codigo = verifMatch[1];
  }

  // ── Código de Validación (UAC: "Código de Validación 83798479836311") ──
  if (!data.codigo) {
    const codValMatch = text.match(/[Cc]ódigo\s*(?:de\s*)?[Vv]alidaci[oó]n\s*:?\s*(\d{6,})/i);
    if (codValMatch) data.codigo = codValMatch[1];
  }

  // ── Certificado n° (UCV: "Certificado n°1.460.172") ──
  const certNumMatch = text.match(/[Cc]ertificado\s*n[°º]\s*([\d.]+)/);
  if (certNumMatch && !data.numero) data.numero = certNumMatch[1];

  // ── UV: código de barras largo + URL verificacertificado.uv.cl ──
  if (!data.codigo) {
    const uvUrlMatch = text.match(/verificacertificado\.uv\.cl/i);
    if (uvUrlMatch) {
      // El código es el número largo antes de la URL
      const uvCodeMatch = text.match(/(\d{15,})\s*.*?verificacertificado/i);
      if (uvCodeMatch) data.codigo = uvCodeMatch[1];
      data.url_validacion = "https://verificacertificado.uv.cl";
    }
  }

  // ── U Bolivariana: URL en el texto ──
  if (!data.url_validacion) {
    const ubolMatch = text.match(/(https?:\/\/certificados\.ubolivariana\.cl\/[^\s]+)/i);
    if (ubolMatch) data.url_validacion = ubolMatch[1];
  }

  // ── URL de validación embebida en el PDF ──
  const urlValidarMatch = text.match(/(https?:\/\/[^\s]+validar\/[a-f0-9]+)/i);
  if (urlValidarMatch) {
    data.url_validacion = urlValidarMatch[1];
    const urlCode = urlValidarMatch[1].match(/validar\/([a-f0-9]+)/i);
    if (urlCode && (!data.codigo || data.codigo.length < 6)) {
      data.codigo = urlCode[1];
    }
  }

  // ── URL de validación genérica (certificados.xxx.cl) ──
  if (!data.url_validacion) {
    const urlCertMatch = text.match(/(https?:\/\/certificados\.[a-z.]+\.cl)/i);
    if (urlCertMatch) data.url_validacion = urlCertMatch[1];
  }

  // ── Nro. Registro (UTA y otras) ──
  const nroRegistroMatch = text.match(/Nro\.?\s*Registro\s*:?\s*([\d\-\/]+)/i);
  if (nroRegistroMatch) data.numero = nroRegistroMatch[1];

  // ── RUT / Cédula de Identidad ──
  const rutMatch = text.match(/(?:C\.?\s*IDENTIDAD|R\.?U\.?[TN]\.?|[Cc]édula\s*(?:de\s*)?[Ii]dentidad)\s*(?:Nº|N°|:)?\s*([\d]{1,2}\.[\d]{3}\.[\d]{3}-[\dKk])/i);
  if (rutMatch) data.rut = rutMatch[1];

  // Fallback RUT: buscar patrón XX.XXX.XXX-X directamente
  if (!data.rut) {
    const rutFallback = text.match(/(\d{1,2}\.\d{3}\.\d{3}-[\dKk])/);
    if (rutFallback) data.rut = rutFallback[1];
  }

  // ── Nombre del titulado ──
  // Patrones comunes: "certifica que ... confirió el título ... a NOMBRE"
  // o "don/doña NOMBRE , Cédula"
  const nombreMatch = text.match(/(?:don(?:ña)?|DON(?:ÑA)?)\s+([A-ZÁÉÍÓÚÑ\s]+?)(?:\s*,|\s*Cédula|\s*C\.?\s*IDENTIDAD|\s*ha\s+rendido|\s*Ha\s+completado)/i);
  if (nombreMatch) data.nombre = nombreMatch[1].replace(/\s+/g, " ").trim();

  // ── Título profesional ──
  const tituloMatch = text.match(/[Tt]ítulo\s+(?:[Pp]rofesional\s+|[Dd]e\s+)?([A-ZÁÉÍÓÚÑa-záéíóúñ\s]+?)(?:\s+y\s+el|\s+a\s+|Santiago|VIÑA|CONCEPCIÓN|Número|N[°º]|$)/i);
  // Filtrar matches falsos (ej: "Título Establecimiento" de la portada)
  const tituloInvalidos = ["establecimiento", "educacional", "contacto", "validación"];
  if (tituloMatch && tituloInvalidos.some((t) => tituloMatch[1].toLowerCase().includes(t))) {
    tituloMatch[1] = null;
  }
  if (tituloMatch) data.titulo = tituloMatch[1].replace(/\s+/g, " ").trim();

  // ── Número de documento (UdeC, UCV) ──
  const numMatch = text.match(/(?:N[°º]|Número)\s*(?:de\s*)?(?:documento|certificado)\s*:?\s*(\d+)/i);
  if (numMatch) data.numero = numMatch[1];

  // ── Fecha de emisión ──
  const fechaMatch = text.match(/(\d{1,2}\s+de\s+\w+\s+(?:de\s+)?\d{4})/i);
  if (fechaMatch) data.fecha_emision = fechaMatch[1];

  // ── IACC: URL de validación diferente ──
  if (data.universidad_key === "iacc" && data.codigo) {
    const iaccUrl = text.match(/(https:\/\/services10\.idok\.cl\/[^\s]+)/);
    if (iaccUrl) data.url_validacion = iaccUrl[1];
  }

  // ── Detectar si es documento escaneado (foto) vs certificado digital ──
  const tieneCodigoDigital = !!(data.folio || data.codigo || data.id_alumno || data.numero);
  const esEscaneado = cleanText.length < 50; // texto extraído por OCR, no nativo
  const indicadoresFoto = [
    /escaneado/i.test(text),
    /camscanner/i.test(text),
    /notari/i.test(text),
    /firma\s*electr[oó]nica/i.test(text) === false && /firma/i.test(text),
  ].filter(Boolean).length;

  if (!tieneCodigoDigital) {
    data.es_documento_fisico = true;
    data.mensaje = "REQUIERE CERTIFICADO DIGITAL - Este documento es un escaneo/foto de un documento físico sin código de verificación digital. Solicite al candidato un certificado digital emitido por la universidad con código de verificación.";
  } else {
    data.es_documento_fisico = false;
  }

  return data;
}

module.exports = { extractTituloData, extractTextFromPdf };
