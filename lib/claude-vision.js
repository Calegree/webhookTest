const Groq = require("groq-sdk");
const fs = require("fs");

// ─── Extracción por texto directo del PDF (GRATIS, sin API) ─────────────────

/**
 * Extrae texto de todas las páginas de un PDF usando pdfjs-dist
 */
async function extractTextFromPdf(pdfBuffer) {
  // pdfjs-dist requiere import dinámico para la versión ESM-compatible
  const pdfjsLib = await import("pdfjs-dist/legacy/build/pdf.mjs");

  const uint8 = new Uint8Array(pdfBuffer);
  const doc = await pdfjsLib.getDocument({ data: uint8 }).promise;

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
 * Extrae datos estructurados del texto del PDF usando regex
 */
function extractDataFromText(text) {
  const data = {
    folio: null,
    codigo_verificacion: null,
    rut: null,
    nombre_completo: null,
    fecha_nacimiento: null,
    licencias: [],
    ultima_clase: null,
    ultima_municipalidad: null,
    ultima_fecha_otorgamiento: null,
    anotaciones: [],
    antecedentes_prn: null,
    antecedentes_rnc: null,
    fecha_emision: null,
    tiene_restricciones: false,
  };

  // Folio
  const folioMatch = text.match(/FOLIO\s*:\s*(\d+)/i);
  if (folioMatch) data.folio = folioMatch[1];

  // Código de verificación
  const cveMatch = text.match(/[Cc]ódigo\s*[Vv]erificaci[oó]n\s*:?\s*([a-f0-9]+)/i);
  if (cveMatch) data.codigo_verificacion = cveMatch[1];

  // RUT / R.U.N.
  const rutMatch = text.match(/R\.?U\.?N\.?\s*:?\s*([\d]{1,2}\.[\d]{3}\.[\d]{3}-[\dKk])/i);
  if (rutMatch) data.rut = rutMatch[1];

  // Nombre (captura todo hasta "R.U.N" o "Página")
  const nombreMatch = text.match(/NOMBRE\s*:\s*(.+?)(?=\s*R\.?U\.?N|\s*P[aá]gina)/i);
  if (nombreMatch) data.nombre_completo = nombreMatch[1].replace(/\s+/g, " ").trim();

  // Fecha nacimiento
  const nacMatch = text.match(/[Ff]echa\s*nacimiento\s*:?\s*(\d{1,2}\s+\w+\s+\d{4})/);
  if (nacMatch) data.fecha_nacimiento = nacMatch[1];

  // Licencias - PRIMERA Clase
  const primeraMatch = text.match(/PRIMERA\s+[Cc]lase\s*:\s*(\w+)\s+.*?[Ff]echa\s*otorgamiento\s*:?\s*(\d{1,2}\s+\w+\s+\d{4})/);
  if (primeraMatch) {
    data.licencias.push({
      tipo: "PRIMERA",
      clase: primeraMatch[1],
      fecha_otorgamiento: primeraMatch[2],
    });
  }

  // Licencias - ULTIMA Clase
  const ultimaMatch = text.match(/ULTIMA\s+[Cc]lase\s*:\s*(\w+)\s+.*?[Ff]echa\s*otorgamiento\s*:?\s*(\d{1,2}\s+\w+\s+\d{4})/);
  if (ultimaMatch) {
    data.ultima_clase = ultimaMatch[1];
    data.ultima_fecha_otorgamiento = ultimaMatch[2];
    data.licencias.push({
      tipo: "ULTIMA",
      clase: ultimaMatch[1],
      fecha_otorgamiento: ultimaMatch[2],
    });
  }

  // Municipalidad (última)
  const muniMatch = text.match(/ULTIMA.*?Municipalidad\s*:\s*([A-ZÁÉÍÓÚÑ\s]+?)(?:\s{2,}|Fecha)/i);
  if (muniMatch) data.ultima_municipalidad = muniMatch[1].trim();

  // Antecedentes PRN
  if (text.includes("SIN ANTECEDENTES PRN")) {
    data.antecedentes_prn = "SIN ANTECEDENTES";
  } else {
    const prnMatch = text.match(/ANTECEDENTES\s+PRN\s*(.+?)(?:CONDUCTOR|$)/is);
    if (prnMatch) data.antecedentes_prn = prnMatch[1].trim();
  }

  // Antecedentes RNC
  if (text.includes("SIN ANTECEDENTES RNC")) {
    data.antecedentes_rnc = "SIN ANTECEDENTES";
  } else {
    const rncMatch = text.match(/ANTECEDENTES\s+RNC\s*(.+?)(?:CONDUCTOR|$)/is);
    if (rncMatch) data.antecedentes_rnc = rncMatch[1].trim();
  }

  // Fecha emisión
  const emisionMatch = text.match(/FECHA\s*EMISI[OÓ]N\s*:?\s*(\d{1,2}\s+\w+\s+\d{4})/i);
  if (emisionMatch) data.fecha_emision = emisionMatch[1];

  // Restricciones
  data.tiene_restricciones = /RESTRICCION\s+DE\s+LICENCIA/i.test(text);

  // Anotaciones
  const anotMatch = text.match(/FECHA\s+ANOTACION\s*:?\s*(.+?)(?=LICENCIA|R\s*U\s*N|FECHA\s*EMISI)/is);
  if (anotMatch) {
    data.anotaciones.push(anotMatch[1].trim());
  }

  return data;
}

// ─── Fallback: Groq Vision (gratis) ────────────────────────────────────────

/**
 * Extrae datos usando Groq Vision como fallback si el texto no tiene los campos críticos
 */
async function extractWithGroq(pdfBuffer) {
  const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

  // Groq no soporta PDFs directo, necesitamos enviar como texto
  const text = await extractTextFromPdf(pdfBuffer);

  const completion = await groq.chat.completions.create({
    model: "llama-3.3-70b-versatile",
    messages: [
      {
        role: "system",
        content: "Eres un experto en documentos chilenos. Extraes datos de documentos del Registro Civil.",
      },
      {
        role: "user",
        content: `Analiza este texto extraído de una "Hoja de Vida del Conductor" del Registro Civil de Chile.

Extrae los datos y responde SOLO con JSON válido:
{
  "folio": "número de folio",
  "codigo_verificacion": "código de verificación",
  "rut": "RUT formato XX.XXX.XXX-X",
  "nombre_completo": "nombre completo",
  "fecha_nacimiento": "fecha nacimiento",
  "ultima_clase": "última clase de licencia",
  "ultima_municipalidad": "municipalidad",
  "ultima_fecha_otorgamiento": "fecha otorgamiento",
  "antecedentes_prn": "SIN ANTECEDENTES o descripción",
  "antecedentes_rnc": "SIN ANTECEDENTES o descripción",
  "fecha_emision": "fecha emisión",
  "tiene_restricciones": false,
  "anotaciones": []
}

Texto del documento:
${text}`,
      },
    ],
    temperature: 0,
    max_tokens: 1000,
  });

  const responseText = completion.choices[0].message.content.trim();
  let jsonStr = responseText;
  const jsonMatch = responseText.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (jsonMatch) jsonStr = jsonMatch[1].trim();

  return JSON.parse(jsonStr);
}

// ─── Función principal ─────────────────────────────────────────────────────

/**
 * Extrae datos del PDF de HVC.
 * Intenta primero extracción directa de texto (gratis).
 * Si falta folio o CVE, usa Groq como fallback.
 */
async function extractLicenseData(pdfBuffer) {
  console.log("📝 Intentando extracción directa de texto del PDF...");

  const text = await extractTextFromPdf(pdfBuffer);
  const data = extractDataFromText(text);

  // Verificar si se extrajeron los campos críticos
  if (data.folio && data.codigo_verificacion) {
    console.log(`✅ Extracción por texto exitosa: Folio=${data.folio}, CVE=${data.codigo_verificacion}`);
    return data;
  }

  // Fallback a Groq si falta folio o CVE
  console.log("⚠️ Extracción por texto incompleta, intentando con Groq...");

  if (!process.env.GROQ_API_KEY) {
    console.log("⚠️ GROQ_API_KEY no configurada, retornando datos parciales");
    return data;
  }

  try {
    const groqData = await extractWithGroq(pdfBuffer);
    // Merge: preferir datos de texto directo, completar con Groq
    return { ...groqData, ...Object.fromEntries(Object.entries(data).filter(([_, v]) => v !== null)) };
  } catch (err) {
    console.error("❌ Error con Groq:", err.message);
    return data;
  }
}

module.exports = { extractLicenseData };
