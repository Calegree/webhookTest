const fs = require("fs");
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
 * Extrae datos de validación de un certificado de título chileno.
 * Detecta universidad y extrae folio, código, RUT, nombre, título.
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

  const universidad = detectarUniversidad(text);

  const data = {
    universidad: universidad ? universidad.nombre : null,
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

  // Si no hay CVE, buscar "Código de Verificación" genérico
  if (!data.codigo) {
    const codMatch = text.match(/[Cc]ódigo\s*(?:de\s*)?[Vv]erificaci[oó]n\s*:?\s*([A-Za-z0-9]{6,})/);
    if (codMatch) data.codigo = codMatch[1];
  }

  // ── URL de validación embebida en el PDF ──
  const urlValidarMatch = text.match(/(https?:\/\/[^\s]+validar\/[a-f0-9]+)/i);
  if (urlValidarMatch) {
    data.url_validacion = urlValidarMatch[1];
    // Extraer código de la URL si no se capturó antes
    const urlCode = urlValidarMatch[1].match(/validar\/([a-f0-9]+)/i);
    if (urlCode && (!data.codigo || data.codigo.length < 6)) {
      data.codigo = urlCode[1];
    }
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
  const tituloMatch = text.match(/(?:título\s*de|TÍTULO\s*DE)\s+([A-ZÁÉÍÓÚÑa-záéíóúñ\s]+?)(?:\s+y\s+el|\s+a\s+|Santiago|VIÑA|CONCEPCIÓN|$)/i);
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
