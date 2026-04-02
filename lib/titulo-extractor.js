const fs = require("fs");
const { detectarUniversidad } = require("./universidades");

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
  const text = await extractTextFromPdf(pdfBuffer);
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
    const codMatch = text.match(/[Cc]ódigo\s*(?:de\s*)?[Vv]erificaci[oó]n\s*:?\s*([A-Za-z0-9-]+)/);
    if (codMatch) data.codigo = codMatch[1];
  }

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
    // IACC usa su propio validador en services10.idok.cl
    const iaccUrl = text.match(/(https:\/\/services10\.idok\.cl\/[^\s]+)/);
    if (iaccUrl) data.url_validacion = iaccUrl[1];
  }

  return data;
}

module.exports = { extractTituloData, extractTextFromPdf };
