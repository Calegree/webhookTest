require("dotenv").config();
const express = require("express");
const axios = require("axios");
const sharp = require("sharp");
const { google } = require("googleapis");
const crypto = require("crypto");
const path = require("path");
const fs = require("fs");
const PDFDocument = require("pdfkit");
const { PDFDocument: PDFLib } = require("pdf-lib");
const FormData = require("form-data");

const app = express();
app.use(express.json());

// ─── Airtable config ────────────────────────────────────────────────────────
const AIRTABLE_API_KEY = process.env.AIRTABLE_API_KEY;
const AIRTABLE_BASE_ID = process.env.AIRTABLE_BASE_ID;
const AIRTABLE_TABLE_NAME = process.env.AIRTABLE_TABLE_NAME || "One Page";
const AIRTABLE_PHOTO_FIELD = process.env.AIRTABLE_PHOTO_FIELD || "Foto";

// ─── Autenticación con Service Account ───────────────────────────────────────
let credentials;
if (process.env.GOOGLE_CREDENTIALS) {
  credentials = JSON.parse(process.env.GOOGLE_CREDENTIALS);
}

const CREDENTIALS_PATH = path.join(__dirname, "credentials.json");

const auth = credentials
  ? new google.auth.GoogleAuth({
    credentials,
    scopes: [
      "https://www.googleapis.com/auth/presentations",
      "https://www.googleapis.com/auth/drive",
    ],
  })
  : new google.auth.GoogleAuth({
    keyFile: CREDENTIALS_PATH,
    scopes: [
      "https://www.googleapis.com/auth/presentations",
      "https://www.googleapis.com/auth/drive",
    ],
  });

// ─── Constantes de tamaño ────────────────────────────────────────────────────
const FACE_PX = 500; // resolución interna alta para buena calidad

// ─── Almacén temporal de imágenes en memoria ─────────────────────────────────
const tempImages = new Map();

// ─── Recorte de rostro desde carnet chileno ──────────────────────────────────
async function cropFaceFromCarnet(imageBuffer) {
  const meta = await sharp(imageBuffer, { failOn: "none" }).metadata();
  const w = meta.width;
  const h = meta.height;

  // Zona ajustada para capturar la cara completa (frente a barbilla)
  // Carnet chileno: foto en la zona izquierda
  const cropLeft = Math.round(w * 0.04);
  const cropTop = Math.round(h * 0.15);
  const cropWidth = Math.round(w * 0.26);
  const cropHeight = Math.round(h * 0.72);

  console.log(`📐 Imagen original: ${w}×${h}px, recortando cara: ${cropWidth}×${cropHeight}px desde (${cropLeft},${cropTop})`);

  const faceRegion = await sharp(imageBuffer, { failOn: "none" })
    .extract({
      left: cropLeft,
      top: cropTop,
      width: Math.min(cropWidth, w - cropLeft),
      height: Math.min(cropHeight, h - cropTop),
    })
    .toBuffer();

  // Usar aspect ratio de retrato (3:4) para no cortar barbilla ni frente
  // Esto hace que la imagen sea más alta que ancha, capturando cara completa
  const outW = FACE_PX;
  const outH = Math.round(FACE_PX * 1.33); // ratio 3:4 (retrato)

  const processedImage = await sharp(faceRegion)
    .resize(outW, outH, { fit: "cover", position: "centre" })
    .jpeg({ quality: 95 })
    .toBuffer();

  console.log(`✂️  Rostro recortado a ${outW}×${outH}px (retrato 3:4)`);
  return processedImage;
}

// ─── Healthcheck ─────────────────────────────────────────────────────────────
app.get("/", (req, res) => {
  res.send("Webhook Transearch — Insercion de fotos en Google Slides activo");
});

// ─── Servir imágenes temporales ──────────────────────────────────────────────
app.get("/tmp/:id.jpg", (req, res) => {
  const imageBuffer = tempImages.get(req.params.id);
  if (!imageBuffer) {
    return res.status(404).send("Imagen no encontrada o expirada");
  }
  res.set("Content-Type", "image/jpeg");
  res.send(imageBuffer);
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /insert-photo
// ─────────────────────────────────────────────────────────────────────────────
app.post("/insert-photo", async (req, res) => {
  console.log("📦 Body recibido:", JSON.stringify(req.body, null, 2));
  const raw = req.body.data || req.body;
  const body = {};
  for (const [k, v] of Object.entries(raw)) {
    body[k.trim()] = v;
  }
  let { image_url, presentation_id, record_id } = body;

  if (!presentation_id) {
    return res.status(400).json({
      error: "Falta parámetro requerido: presentation_id",
    });
  }

  if (!image_url && !record_id) {
    return res.status(400).json({
      error: "Falta parámetro requerido: image_url o record_id",
    });
  }

  // ── 0. Obtener image_url desde Airtable si no viene ─────────────────────
  if (!image_url) {
    console.log(`🔍 Buscando foto en Airtable para registro: ${record_id}`);
    try {
      const airtableUrl = `https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/${encodeURIComponent(AIRTABLE_TABLE_NAME)}/${record_id}`;
      const airtableRes = await axios.get(airtableUrl, {
        headers: { Authorization: `Bearer ${AIRTABLE_API_KEY}` },
        timeout: 10000,
      });

      const photoField = airtableRes.data.fields[AIRTABLE_PHOTO_FIELD];
      if (!photoField || !Array.isArray(photoField) || photoField.length === 0) {
        return res.status(422).json({
          error: `El registro ${record_id} no tiene foto en el campo "${AIRTABLE_PHOTO_FIELD}"`,
        });
      }

      const imageAttachment = photoField.find((att) =>
        att.type && att.type.startsWith("image/")
      );

      if (imageAttachment) {
        image_url = imageAttachment.url;
      } else {
        const att = photoField[0];
        const thumbUrl = att.thumbnails?.full?.url || att.thumbnails?.large?.url;
        if (thumbUrl) {
          image_url = thumbUrl;
          console.log(`📎 Archivo es ${att.type}, usando thumbnail de Airtable`);
        } else {
          return res.status(422).json({
            error: `El archivo es ${att.type} y no tiene thumbnails. Sube JPG/PNG o PDF.`,
          });
        }
      }
      console.log(`📸 URL de foto: ${image_url}`);
    } catch (err) {
      console.error("❌ Error consultando Airtable:", err.message);
      return res.status(502).json({
        error: "Error consultando Airtable para obtener la foto",
        details: err.message,
      });
    }
  }

  try {
    console.log(`📥 Presentación: ${presentation_id}`);

    // ── 1. Descargar imagen ────────────────────────────────────────────────
    const imageResponse = await axios.get(image_url, {
      responseType: "arraybuffer",
      timeout: 15000,
    });
    const imageBuffer = Buffer.from(imageResponse.data);
    console.log(`✅ Imagen descargada (${imageBuffer.length} bytes)`);

    // ── 2. Recortar rostro del carnet ──────────────────────────────────────
    const processedImage = await cropFaceFromCarnet(imageBuffer);

    // ── 3. Servir imagen temporalmente desde este servidor ─────────────────
    const imageId = crypto.randomUUID();
    tempImages.set(imageId, processedImage);

    const baseUrl = process.env.RAILWAY_PUBLIC_DOMAIN
      ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`
      : (process.env.PUBLIC_URL || `http://localhost:${PORT}`);
    const publicImageUrl = `${baseUrl}/tmp/${imageId}.jpg`;
    console.log(`🌐 Imagen disponible en: ${publicImageUrl}`);

    // ── 4. Buscar el placeholder gris (Shape 82) en el slide ──────────────
    const authClient = await auth.getClient();
    const slides = google.slides({ version: "v1", auth: authClient });
    const presentation = await slides.presentations.get({
      presentationId: presentation_id,
    });

    let grayBoxId = null;
    let grayBoxSize = null;
    let grayBoxTransform = null;
    let slideObjectId = null;

    for (const slide of presentation.data.slides || []) {
      for (const element of slide.pageElements || []) {
        if (!element.shape) continue;

        // Buscar por objectId exacto primero
        if (element.objectId === "g1f522768429_2_82") {
          grayBoxId = element.objectId;
          grayBoxSize = element.size;
          grayBoxTransform = element.transform;
          slideObjectId = slide.objectId;
          console.log(`🔲 Placeholder encontrado por ID: ${grayBoxId}`);
          break;
        }

        // Fallback: buscar por color gris (#BFBFBF = 191,191,191)
        const fill =
          element.shape.shapeProperties?.shapeBackgroundFill?.solidFill;
        if (!fill?.color?.rgbColor) continue;

        const r = Math.round((fill.color.rgbColor.red || 0) * 255);
        const g = Math.round((fill.color.rgbColor.green || 0) * 255);
        const b = Math.round((fill.color.rgbColor.blue || 0) * 255);

        const isGray =
          Math.abs(r - g) < 35 &&
          Math.abs(g - b) < 35 &&
          Math.abs(r - b) < 35 &&
          r > 80 &&
          r < 220;

        if (isGray) {
          grayBoxId = element.objectId;
          grayBoxSize = element.size;
          grayBoxTransform = element.transform;
          slideObjectId = slide.objectId;
          console.log(`🔲 Cuadro gris encontrado: ${grayBoxId} (RGB: ${r},${g},${b})`);
          break;
        }
      }
      if (grayBoxId) break;
    }

    if (!grayBoxId) {
      tempImages.delete(imageId);
      return res.status(404).json({
        error: "No se encontró el placeholder gris en la presentación.",
      });
    }

    // ── 5. Insertar imagen con tamaño real del placeholder ────────────────
    const boxW = grayBoxSize.width.magnitude;
    const boxH = grayBoxSize.height.magnitude;
    console.log(`📐 Placeholder size: ${boxW} × ${boxH} EMU`);

    await slides.presentations.batchUpdate({
      presentationId: presentation_id,
      requestBody: {
        requests: [
          {
            createImage: {
              url: publicImageUrl,
              elementProperties: {
                pageObjectId: slideObjectId,
                size: {
                  width: { magnitude: boxW, unit: "EMU" },
                  height: { magnitude: boxH, unit: "EMU" },
                },
                transform: grayBoxTransform,
              },
            },
          },
          {
            deleteObject: { objectId: grayBoxId },
          },
        ],
      },
    });

    console.log(`✅ Foto insertada (${boxW}×${boxH} EMU) en ${presentation_id}`);

    // ── 6. Limpiar imagen temporal (60s de gracia) ─────────────────────────
    setTimeout(() => {
      tempImages.delete(imageId);
      console.log(`🗑️  Imagen temporal eliminada: ${imageId}`);
    }, 60_000);

    return res.json({
      success: true,
      presentation_id,
      message: "Foto del candidato insertada correctamente en la presentación",
    });
  } catch (error) {
    console.error("❌ Error en /insert-photo:", error.message);
    return res.status(500).json({
      error: "Error procesando la foto",
      details: error.message,
    });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /webhook/generate-vt — Genera PDF de Validación de Título
// ─────────────────────────────────────────────────────────────────────────────
const LOGO_PATH = path.join(__dirname, "image copy.png");
const MONTHS_ES = [
  "Enero", "Febrero", "Marzo", "Abril", "Mayo", "Junio",
  "Julio", "Agosto", "Septiembre", "Octubre", "Noviembre", "Diciembre",
];

function buildCoverPage(data) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: "LETTER", margin: 50 });
    const chunks = [];
    doc.on("data", (c) => chunks.push(c));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    // Logo centrado
    if (fs.existsSync(LOGO_PATH)) {
      doc.image(LOGO_PATH, 200, 30, { width: 200 });
    }

    // Título
    doc.moveDown(5);
    doc.font("Helvetica-Bold").fontSize(18).text("VALIDACIÓN DE TÍTULO", {
      align: "center",
    });
    doc.moveDown(2);

    // Tabla de datos
    const fields = [
      { label: "Nombre completo", value: data.nombre },
      { label: "Rut", value: data.rut },
      null, // separador
      { label: "Cargo al que postula", value: data.cargo },
      { label: "ID", value: data.id },
      { label: "División", value: data.division },
      null,
      { label: "Título", value: data.titulo },
      { label: "Establecimiento Educacional", value: data.establecimiento },
      { label: "Estado", value: "Validado" },
      { label: "Contacto de Validación", value: data.contacto },
    ];

    const labelX = 90;
    const valueX = 240;
    let y = doc.y;

    for (const field of fields) {
      if (!field) {
        y += 20;
        continue;
      }
      doc.font("Helvetica").fontSize(12);
      doc.text(field.label, labelX, y);
      doc.text(field.value || "", valueX, y, { width: 300 });
      y += Math.max(20, doc.heightOfString(field.value || "", { width: 300 }) + 6);
    }

    // Fecha
    const now = new Date();
    const dateStr = `Santiago, ${now.getDate()} de ${MONTHS_ES[now.getMonth()]} del ${now.getFullYear()}`;
    doc.moveDown(4);
    doc.font("Helvetica").fontSize(11).text(dateStr, labelX - 20);

    doc.end();
  });
}

async function downloadAttachments(documentos) {
  // documentos puede ser: string JSON de array, string de URLs separadas por coma, o ya un array
  let urls = [];

  if (Array.isArray(documentos)) {
    // Array de objetos {url:...} o strings
    urls = documentos.map((d) => (typeof d === "string" ? d : d.url)).filter(Boolean);
  } else if (typeof documentos === "string") {
    try {
      const parsed = JSON.parse(documentos);
      if (Array.isArray(parsed)) {
        urls = parsed.map((d) => (typeof d === "string" ? d : d.url)).filter(Boolean);
      }
    } catch {
      // Es string plano, separar por coma
      urls = documentos.split(",").map((u) => u.trim()).filter(Boolean);
    }
  }

  const buffers = [];
  for (const url of urls) {
    try {
      console.log(`📎 Descargando documento: ${url.substring(0, 80)}...`);
      const res = await axios.get(url, { responseType: "arraybuffer", timeout: 30000 });
      buffers.push(Buffer.from(res.data));
    } catch (err) {
      console.error(`⚠️  Error descargando ${url.substring(0, 60)}: ${err.message}`);
    }
  }
  return buffers;
}

async function mergePDFs(coverBuffer, documentBuffers) {
  const merged = await PDFLib.create();

  // Agregar la portada
  const coverDoc = await PDFLib.load(coverBuffer);
  const coverPages = await merged.copyPages(coverDoc, coverDoc.getPageIndices());
  for (const p of coverPages) merged.addPage(p);

  // Agregar cada documento
  for (const buf of documentBuffers) {
    try {
      // Intentar como PDF
      const docPdf = await PDFLib.load(buf, { ignoreEncryption: true });
      const pages = await merged.copyPages(docPdf, docPdf.getPageIndices());
      for (const p of pages) merged.addPage(p);
    } catch {
      // Si no es PDF, intentar como imagen
      try {
        let img;
        const header = buf.slice(0, 4).toString("hex");
        if (header.startsWith("89504e47")) {
          img = await merged.embedPng(buf);
        } else {
          img = await merged.embedJpg(buf);
        }
        const page = merged.addPage();
        const { width: pw, height: ph } = page.getSize();
        const scale = Math.min((pw - 80) / img.width, (ph - 80) / img.height, 1);
        const iw = img.width * scale;
        const ih = img.height * scale;
        page.drawImage(img, {
          x: (pw - iw) / 2,
          y: (ph - ih) / 2,
          width: iw,
          height: ih,
        });
      } catch (imgErr) {
        console.error(`⚠️  No se pudo procesar documento: ${imgErr.message}`);
      }
    }
  }

  return Buffer.from(await merged.save());
}

// Agregar logo como header a todas las páginas del PDF final
async function addLogoHeader(pdfBuffer) {
  if (!fs.existsSync(LOGO_PATH)) return pdfBuffer;

  const srcDoc = await PDFLib.load(pdfBuffer);
  const destDoc = await PDFLib.create();

  const logoBytes = fs.readFileSync(LOGO_PATH);
  const logo = await destDoc.embedPng(logoBytes);

  const logoW = 150;
  const logoH = (logo.height / logo.width) * logoW;
  const headerSpace = logoH + 30;

  const pageCount = srcDoc.getPageCount();

  for (let i = 0; i < pageCount; i++) {
    const [copiedPage] = await destDoc.copyPages(srcDoc, [i]);

    if (i === 0) {
      // Portada: copiar tal cual
      destDoc.addPage(copiedPage);
    } else {
      // Páginas 2+: agrandar hacia arriba y poner logo en el espacio nuevo
      const { width, height } = copiedPage.getSize();
      copiedPage.setSize(width, height + headerSpace);

      copiedPage.drawImage(logo, {
        x: (width - logoW) / 2,
        y: height + (headerSpace - logoH) / 2,
        width: logoW,
        height: logoH,
      });

      destDoc.addPage(copiedPage);
    }
  }

  return Buffer.from(await destDoc.save());
}

app.post("/webhook/generate-vt", async (req, res) => {
  console.log("📦 [VT] Body recibido:", JSON.stringify(req.body, null, 2));
  const data = req.body;

  // Normalizar campos que pueden llegar como arrays (linked records)
  if (Array.isArray(data.titulo)) data.titulo = data.titulo[0] || "";
  if (Array.isArray(data.establecimiento)) data.establecimiento = data.establecimiento[0] || "";

  if (!data.nombre || !data.rut) {
    return res.status(400).json({ error: "Faltan campos requeridos: nombre, rut" });
  }

  try {
    // 1. Generar portada
    console.log(`📄 Generando VT para: ${data.nombre}`);
    const coverBuffer = await buildCoverPage(data);

    // 2. Obtener URLs reales de documentos desde Airtable API
    let documentBuffers = [];
    const vtBaseId = process.env.VT_AIRTABLE_BASE_ID || process.env.AIRTABLE_BASE_ID;
    const vtTableName = process.env.VT_AIRTABLE_TABLE_NAME || "Documentos";
    const vtDocField = process.env.VT_AIRTABLE_DOC_FIELD || "Documentos";

    if (data.recordId && AIRTABLE_API_KEY) {
      console.log(`🔍 Obteniendo attachments reales desde Airtable para: ${data.recordId}`);
      try {
        const recordUrl = `https://api.airtable.com/v0/${vtBaseId}/${encodeURIComponent(vtTableName)}/${data.recordId}`;
        const recordRes = await axios.get(recordUrl, {
          headers: { Authorization: `Bearer ${AIRTABLE_API_KEY}` },
          timeout: 15000,
        });

        const docField = recordRes.data.fields[vtDocField];
        if (docField && Array.isArray(docField)) {
          const filtered = docField.filter((att) => {
            const name = (att.filename || "").toUpperCase();
            if (name.includes("VT")) {
              console.log(`⏭️  Saltando documento VT: ${att.filename}`);
              return false;
            }
            return true;
          });
          const realUrls = filtered.map((att) => att.url).filter(Boolean);
          console.log(`📎 ${realUrls.length} documentos encontrados via API (${docField.length - filtered.length} VT excluidos)`);
          documentBuffers = await downloadAttachments(realUrls);
        }
      } catch (err) {
        console.error(`⚠️  Error obteniendo attachments de Airtable: ${err.message}`);
      }
    } else if (data.documentos) {
      // Fallback: usar URLs directas si vienen
      documentBuffers = await downloadAttachments(data.documentos);
    }
    console.log(`📎 ${documentBuffers.length} documentos descargados`);

    // 3. Merge todo en un solo PDF
    let finalPdf = await mergePDFs(coverBuffer, documentBuffers);

    // 4. Agregar logo header a las páginas de documentos
    finalPdf = await addLogoHeader(finalPdf);

    const fileName = `${data.id || "VT"}-VT-${data.nombre}.pdf`;
    console.log(`✅ PDF generado: ${fileName} (${finalPdf.length} bytes)`);

    // 5. Guardar PDF en disco
    const pdfId = crypto.randomUUID();
    const tmpDir = path.join(__dirname, "tmp-pdfs");
    if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir);
    const pdfFilePath = path.join(tmpDir, `${pdfId}.pdf`);
    fs.writeFileSync(pdfFilePath, finalPdf);
    console.log(`💾 PDF guardado en disco: ${pdfFilePath}`);

    const baseUrl = process.env.RAILWAY_PUBLIC_DOMAIN
      ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`
      : process.env.PUBLIC_URL || `http://localhost:${PORT}`;
    const pdfUrl = `${baseUrl}/tmp/${pdfId}.pdf`;

    return res.json({
      success: true,
      fileName,
      pdfUrl,
      message: `VT generada para ${data.nombre}`,
    });
  } catch (error) {
    console.error("❌ Error en /webhook/generate-vt:", error.message);
    return res.status(500).json({
      error: "Error generando VT",
      details: error.message,
    });
  }
});

// Servir PDFs desde disco
app.get("/tmp/:id.pdf", (req, res) => {
  const pdfFilePath = path.join(__dirname, "tmp-pdfs", `${req.params.id}.pdf`);
  if (!fs.existsSync(pdfFilePath)) {
    return res.status(404).send("PDF no encontrado o expirado");
  }
  res.set("Content-Type", "application/pdf");
  res.set("Content-Disposition", "inline");
  res.sendFile(pdfFilePath);
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /test/validate-hvc/:nombre — Test manual de validación HVC (sin Airtable)
// ─────────────────────────────────────────────────────────────────────────────
const { extractLicenseData } = require("./lib/claude-vision");
const { verificarCertificado } = require("./lib/registro-civil");
const { isValidRut } = require("./lib/rut-utils");

const TEST_PDFS = {
  maria: path.join(__dirname, "88597 - HVC - María Fernández Robles.pdf"),
  nelson: path.join(__dirname, "Hoja84571-HVC-NELSONDAVIDARRIAGADACORTES.pdf"),
};

app.get("/test/validate-hvc/:nombre", async (req, res) => {
  const nombre = req.params.nombre.toLowerCase();
  const pdfPath = TEST_PDFS[nombre];

  if (!pdfPath || !fs.existsSync(pdfPath)) {
    return res.status(404).json({
      error: `PDF no encontrado para "${nombre}"`,
      disponibles: Object.keys(TEST_PDFS),
    });
  }

  console.log(`\n🧪 [TEST HVC] Iniciando validación para: ${nombre}`);
  console.log(`   📄 Archivo: ${path.basename(pdfPath)}`);

  try {
    // 1. Extraer datos del PDF
    console.log("   📝 Extrayendo datos del PDF...");
    const pdfBuffer = fs.readFileSync(pdfPath);
    const data = await extractLicenseData(pdfBuffer);
    console.log(`   ✅ Extraído: Folio=${data.folio}, CVE=${data.codigo_verificacion}, RUT=${data.rut}`);

    // 2. Verificar en Registro Civil
    let verificacion = { valido: null, mensaje: "No verificado", detalles: "" };
    if (data.folio && data.codigo_verificacion) {
      console.log("   🔍 Verificando en Registro Civil...");
      verificacion = await verificarCertificado(data.folio, data.codigo_verificacion);
      console.log(`   📋 Resultado: ${verificacion.mensaje}`);
    } else {
      console.log("   ⚠️ Sin folio/CVE, no se puede verificar en RC");
    }

    // 3. Determinar estado
    let estado = "REQUIERE REVISIÓN";
    if (verificacion.valido === true) estado = "APROBADO";
    if (verificacion.valido === false) estado = "RECHAZADO";

    const resultado = {
      estado,
      datos_extraidos: {
        folio: data.folio,
        codigo_verificacion: data.codigo_verificacion,
        nombre: data.nombre_completo,
        rut: data.rut,
        rut_valido: data.rut ? isValidRut(data.rut) : null,
        clase_licencia: data.ultima_clase,
        municipalidad: data.ultima_municipalidad,
        fecha_emision: data.fecha_emision,
        antecedentes_prn: data.antecedentes_prn,
        antecedentes_rnc: data.antecedentes_rnc,
        tiene_restricciones: data.tiene_restricciones,
        anotaciones: data.anotaciones,
      },
      verificacion_registro_civil: verificacion,
    };

    console.log(`   ✅ [TEST HVC] Completado: ${estado}\n`);
    return res.json(resultado);
  } catch (err) {
    console.error(`   ❌ [TEST HVC] Error: ${err.message}`);
    return res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /test/validate-titulo/:archivo — Test manual de validación de título
// ─────────────────────────────────────────────────────────────────────────────
const { extractTituloData } = require("./lib/titulo-extractor");
const { validarTitulo } = require("./lib/titulo-validators");
const { listarUniversidades } = require("./lib/universidades");

const TEST_TITULOS = {
  unab: path.join(__dirname, "assets", "unab-169900868-1418041.pdf"),
  udla: path.join(__dirname, "assets", "U de las americas CertificadodeTitulo.pdf"),
  uta: path.join(__dirname, "assets", "U tarapaca CertificadodeTtulo.pdf"),
  ucv: path.join(__dirname, "assets", "UCV certificadoJaviera.pdf"),
  uac: path.join(__dirname, "assets", "U Aconcagua CertificadoJosSoto.pdf"),
  inacap: path.join(__dirname, "assets", "Inacap CertificadottuloING.EVELYNAGUILERA.pdf"),
  inacap2: path.join(__dirname, "assets", "Inacap 3.pdf"),
  uv: path.join(__dirname, "assets", "U de valparaiso TituloEricCarrascoCarrasco.pdf"),
  bolivariana: path.join(__dirname, "assets", "U bolivariana titulo.pdf"),
};

app.get("/test/validate-titulo/:archivo", async (req, res) => {
  const archivo = req.params.archivo.toLowerCase();
  const pdfPath = TEST_TITULOS[archivo];

  if (!pdfPath || !fs.existsSync(pdfPath)) {
    return res.status(404).json({
      error: `PDF no encontrado para "${archivo}"`,
      disponibles: Object.keys(TEST_TITULOS),
    });
  }

  console.log(`\n🧪 [TEST TÍTULO] Validando: ${archivo}`);

  try {
    // 1. Extraer datos del PDF
    console.log("   📝 Extrayendo datos del PDF...");
    const pdfBuffer = fs.readFileSync(pdfPath);
    const data = await extractTituloData(pdfBuffer);

    console.log(`   🏫 Universidad: ${data.universidad || "No detectada"}`);
    console.log(`   📋 Folio: ${data.folio || "-"} | ID: ${data.id_alumno || "-"} | CVE: ${data.codigo || "-"}`);

    // 2. Verificar si es documento físico escaneado
    if (data.es_documento_fisico) {
      console.log("   📷 Documento físico detectado (sin código digital)");
      return res.json({
        estado: "REQUIERE CERTIFICADO DIGITAL",
        datos_extraidos: {
          universidad: data.universidad,
          nombre: data.nombre,
          rut: data.rut,
          titulo: data.titulo,
          es_documento_fisico: true,
        },
        mensaje: data.mensaje,
      });
    }

    // 3. Verificar en el validador de la universidad
    let verificacion = { valido: null, mensaje: "No se pudo validar", detalles: "" };

    if (data.universidad_key) {
      const { UNIVERSIDADES } = require("./lib/universidades");
      const uni = UNIVERSIDADES[data.universidad_key];
      const camposFaltantes = uni.campos.filter((c) => !data[c]);

      if (camposFaltantes.length === 0) {
        console.log(`   🔍 Validando en ${uni.url}...`);
        verificacion = await validarTitulo(data.universidad_key, data);
        console.log(`   📋 Resultado: ${verificacion.mensaje}`);
      } else {
        verificacion.mensaje = `Faltan datos para validar: ${camposFaltantes.join(", ")}`;
        console.log(`   ⚠️ ${verificacion.mensaje}`);
      }
    } else {
      verificacion.mensaje = "Universidad no detectada o sin validador implementado";
      console.log("   ⚠️ Universidad no mapeada");
    }

    // 4. Estado final
    let estado = "REQUIERE REVISIÓN";
    if (verificacion.valido === true) estado = "APROBADO";
    if (verificacion.valido === false) estado = "RECHAZADO";

    const resultado = {
      estado,
      datos_extraidos: {
        universidad: data.universidad,
        nombre: data.nombre,
        rut: data.rut,
        titulo: data.titulo,
        folio: data.folio,
        id_alumno: data.id_alumno,
        codigo: data.codigo,
        fecha_emision: data.fecha_emision,
        es_documento_fisico: false,
      },
      verificacion_universidad: verificacion,
    };

    console.log(`   ✅ [TEST TÍTULO] Completado: ${estado}\n`);
    return res.json(resultado);
  } catch (err) {
    console.error(`   ❌ [TEST TÍTULO] Error: ${err.message}`);
    return res.status(500).json({ error: err.message });
  }
});

// Listar universidades disponibles
app.get("/test/universidades", (req, res) => {
  res.json(listarUniversidades());
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /webhook/validate-license — Valida Hoja de Vida del Conductor (Airtable)
// ─────────────────────────────────────────────────────────────────────────────
const { validateDriverLicense } = require("./lib/license-validator");

app.post("/webhook/validate-license", async (req, res) => {
  console.log("📦 [HVC] Body recibido:", JSON.stringify(req.body, null, 2));
  const { recordId, rutEsperado } = req.body;

  if (!recordId) {
    return res.status(400).json({ error: "Falta campo requerido: recordId" });
  }

  const baseId = process.env.HVC_AIRTABLE_BASE_ID || process.env.AIRTABLE_BASE_ID;
  const tableName = process.env.HVC_AIRTABLE_TABLE_NAME || "Conductores";
  const pdfField = process.env.HVC_AIRTABLE_PDF_FIELD || "HVC";
  const statusField = process.env.HVC_AIRTABLE_STATUS_FIELD || "Estado HVC";
  const resultField = process.env.HVC_AIRTABLE_RESULT_FIELD || "Resultado HVC";

  // Responder inmediatamente (el proceso puede tomar 15-30s)
  res.json({ status: "processing", recordId });

  // Procesar en background
  validateDriverLicense({
    recordId,
    baseId,
    tableName,
    pdfField,
    statusField,
    resultField,
    rutEsperado,
  }).catch((err) => {
    console.error("❌ [HVC] Error no capturado:", err.message);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /webhook/pandadoc-documents — PandaDoc → PDFs combinados → Airtable
// ─────────────────────────────────────────────────────────────────────────────

// Genera un PDF combinado con logo en esquina superior derecha
async function generateCombinedPdfWithLogo(files, logoBytes) {
  const merged = await PDFLib.create();

  for (const file of files) {
    try {
      const srcPdf = await PDFLib.load(file.buffer, { ignoreEncryption: true });
      const pages = await merged.copyPages(srcPdf, srcPdf.getPageIndices());
      for (const p of pages) merged.addPage(p);
    } catch {
      try {
        let img;
        const header = file.buffer.slice(0, 4).toString("hex");
        if (header.startsWith("89504e47")) {
          img = await merged.embedPng(file.buffer);
        } else {
          img = await merged.embedJpg(file.buffer);
        }
        const page = merged.addPage();
        const { width: pw, height: ph } = page.getSize();
        const scale = Math.min((pw - 60) / img.width, (ph - 100) / img.height, 1);
        const iw = img.width * scale;
        const ih = img.height * scale;
        page.drawImage(img, {
          x: (pw - iw) / 2,
          y: (ph - ih) / 2 - 30,
          width: iw,
          height: ih,
        });
      } catch (imgErr) {
        console.error(`  ⚠️ No se pudo procesar archivo: ${imgErr.message}`);
      }
    }
  }

  if (logoBytes && merged.getPageCount() > 0) {
    const srcDoc = await PDFLib.load(await merged.save());
    const destDoc = await PDFLib.create();
    const logo = await destDoc.embedPng(logoBytes);
    const logoW = 120;
    const logoH = (logo.height / logo.width) * logoW;

    for (let i = 0; i < srcDoc.getPageCount(); i++) {
      const [copiedPage] = await destDoc.copyPages(srcDoc, [i]);
      const { width, height } = copiedPage.getSize();
      copiedPage.drawImage(logo, {
        x: width - logoW - 20,
        y: height - logoH - 15,
        width: logoW,
        height: logoH,
      });
      destDoc.addPage(copiedPage);
    }
    return Buffer.from(await destDoc.save());
  }

  return Buffer.from(await merged.save());
}

// Clasifica archivos según el placeholder del campo de PandaDoc
function classifyDocFiles(files) {
  const result = {
    ciFront: null, ciBack: null, titulo: null,
    licFront: null, licBack: null, hvc: null, otros: [],
  };

  for (const file of files) {
    const name = (file.fieldName || "").toLowerCase();
    console.log(`  📂 Clasificando: "${file.fieldName}"`);

    if (/c[eé]dula.*frente|identidad.*frente/i.test(name)) {
      result.ciFront = file;
    } else if (/c[eé]dula.*reverso|identidad.*reverso/i.test(name)) {
      result.ciBack = file;
    } else if (/t[ií]tulo/i.test(name)) {
      result.titulo = file;
    } else if (/licencia.*frente/i.test(name)) {
      result.licFront = file;
    } else if (/licencia.*reverso/i.test(name)) {
      result.licBack = file;
    } else if (/hoja\s*de\s*vida|conductor/i.test(name)) {
      result.hvc = file;
    } else if (/otro/i.test(name) || name === "") {
      result.otros.push(file);
    } else {
      console.log(`    ⚠️ Campo no reconocido, va a "otros"`);
      result.otros.push(file);
    }
  }

  return result;
}

async function processPandaDocDocuments(body) {
  const pandadocApiKey = process.env.PANDADOC_API_KEY_DOCUMENTS;
  const airtableApiKey = process.env.AIRTABLE_API_KEY_DOCUMENTS;
  const airtableBaseId = process.env.AIRTABLE_BASE_ID_DOCUMENTS;
  const airtableTableId = process.env.AIRTABLE_TABLE_ID_DOCUMENTS;

  // ── 1. Normalizar el body (acepta formato Zapier simple o PandaDoc crudo) ──
  let documentId, documentName, recipientEmail;

  if (body.documentId) {
    // Formato Zapier simple: { documentId, documentName, recipientEmail }
    documentId = body.documentId;
    documentName = body.documentName;
    recipientEmail = body.recipientEmail;
  } else {
    // Formato PandaDoc crudo: array con [{ event, data: { id, name, ... } }]
    const event = Array.isArray(body) ? body[0] : body;
    const data = event.data || event;
    documentId = data.id || event.id;
    documentName = data.name || event.name;
    // Buscar email del recipient
    const recipients = data.recipients || [];
    recipientEmail = recipients.length > 0
      ? recipients[0].email
      : (data.recipient?.email || "");
  }

  if (!documentId) {
    console.error("❌ [PANDADOC-DOCS] No se encontró documentId en el body");
    return;
  }

  console.log(`📄 Document ID: ${documentId}`);
  console.log(`📝 Document Name: ${documentName}`);
  console.log(`📧 Recipient Email: ${recipientEmail}`);

  // ── 2. Extraer ID numérico del proceso desde documentName ──
  const idMatch = (documentName || "").match(/ID\s+(\d{4,6})/i);
  const procesoId = idMatch ? idMatch[1] : null;

  if (!procesoId) {
    console.error(`❌ No se pudo extraer ID del proceso desde: "${documentName}"`);
    return;
  }
  console.log(`🔢 ID del proceso: ${procesoId}`);

  // ── 3. Obtener detalles del documento (campos con archivos) ──
  console.log("🔍 Obteniendo detalles del documento de PandaDoc...");
  let docDetails = null;
  try {
    const detailsRes = await axios.get(
      `https://api.pandadoc.com/public/v1/documents/${documentId}/details`,
      { headers: { Authorization: `API-Key ${pandadocApiKey}` }, timeout: 30000 }
    );
    docDetails = detailsRes.data;

    // Log solo las keys de primer nivel y cantidad de fields (no todo el objeto)
    const topKeys = Object.keys(docDetails);
    const fieldsCount = (docDetails.fields || []).length;
    console.log(`📋 Details keys: [${topKeys.join(", ")}]`);
    console.log(`📋 Fields count: ${fieldsCount}`);
  } catch (err) {
    console.error("❌ Error en /details:", err.response?.status, err.response?.data || err.message);
  }

  // ── 4. Extraer campos de tipo "file upload" de los fields ──
  const uploadFields = [];

  if (docDetails && docDetails.fields) {
    for (const field of docDetails.fields) {
      // Los campos de upload en PandaDoc tienen placeholder con "subir un archivo"
      // y el value contiene la URL del archivo subido o info del archivo
      const placeholder = field.placeholder || "";
      const fieldId = field.field_id || "";
      const fieldName = field.name || "";
      const fieldType = field.type || "";
      const value = field.value;

      // Detectar campos de upload: buscar por placeholder que menciona "subir" o "archivo"
      // o por type "file" o "upload" o "image"
      const isUploadByPlaceholder = /subir.*archivo|upload|adjuntar/i.test(placeholder);
      const isUploadByType = /file|upload|image|attachment/i.test(fieldType);
      const isUploadByFieldId = /CI|Titulo|Licencia|HVC|Otro|Cedula|archivo/i.test(fieldId);

      if (isUploadByPlaceholder || isUploadByType || isUploadByFieldId) {
        console.log(`  📎 Campo upload encontrado: field_id="${fieldId}" placeholder="${placeholder}" type="${fieldType}" value_type="${typeof value}"`);

        if (value && typeof value === "string" && value.length > 0) {
          // El value podría ser una URL directa o un nombre de archivo
          if (value.startsWith("http")) {
            uploadFields.push({ fieldName: placeholder || fieldId, url: value, fileName: fieldId });
          } else {
            // Podría ser un nombre de archivo (ej: "177560287578484841286194613829​0.jpg")
            // Necesitamos construir la URL de descarga
            console.log(`    📎 Value es nombre de archivo: "${value}"`);
          }
        } else if (value && typeof value === "object") {
          const url = value.url || value.download_url || value.file_url || "";
          if (url) {
            uploadFields.push({
              fieldName: placeholder || fieldId,
              url,
              fileName: value.file_name || value.name || fieldId,
            });
          }
        }
      }
    }
  }

  // También buscar en /fields endpoint
  let fieldsData = null;
  try {
    const fieldsRes = await axios.get(
      `https://api.pandadoc.com/public/v1/documents/${documentId}/fields`,
      { headers: { Authorization: `API-Key ${pandadocApiKey}` }, timeout: 30000 }
    );
    fieldsData = fieldsRes.data;

    // Log solo campos que parecen uploads (no todo)
    const fieldsList = Array.isArray(fieldsData) ? fieldsData : (fieldsData.fields || fieldsData.results || []);
    for (const field of fieldsList) {
      const placeholder = field.placeholder || "";
      const fieldId = field.field_id || "";
      const fieldType = field.type || "";
      const value = field.value;

      if (/subir.*archivo|upload|adjuntar|file|image/i.test(placeholder + fieldType + fieldId)) {
        console.log(`  📎 [/fields] field_id="${fieldId}" placeholder="${placeholder}" type="${fieldType}" value="${typeof value === "string" ? value.substring(0, 100) : JSON.stringify(value).substring(0, 200)}"`);
      }
    }
  } catch (err) {
    console.error("⚠️ Error en /fields:", err.response?.status, err.response?.data || err.message);
  }

  // También probar endpoint de content uploads
  try {
    const contentRes = await axios.get(
      `https://api.pandadoc.com/public/v1/documents/${documentId}/content-library-items`,
      { headers: { Authorization: `API-Key ${pandadocApiKey}` }, timeout: 30000 }
    );
    console.log("📋 Content library items:", JSON.stringify(contentRes.data).substring(0, 500));
  } catch (err) {
    console.log(`⚠️ /content-library-items: ${err.response?.status || err.message}`);
  }

  // Probar descarga directa del documento completo (PDF firmado)
  try {
    const downloadRes = await axios.get(
      `https://api.pandadoc.com/public/v1/documents/${documentId}/download`,
      {
        headers: { Authorization: `API-Key ${pandadocApiKey}` },
        responseType: "arraybuffer",
        timeout: 30000,
      }
    );
    console.log(`📥 Documento PDF completo descargado: ${downloadRes.data.length} bytes`);
  } catch (err) {
    console.log(`⚠️ /download: ${err.response?.status || err.message}`);
  }

  console.log(`📎 Upload fields encontrados: ${uploadFields.length}`);

  // Si encontramos campos con URLs, descargarlos
  if (uploadFields.length > 0) {
    console.log("📥 Descargando archivos de campos upload...");
    for (const uf of uploadFields) {
      try {
        const response = await axios.get(uf.url, {
          responseType: "arraybuffer",
          headers: { Authorization: `API-Key ${pandadocApiKey}` },
          timeout: 60000,
        });
        uf.buffer = Buffer.from(response.data);
        console.log(`  ✅ "${uf.fieldName}": ${uf.buffer.length} bytes`);
      } catch (err) {
        console.error(`  ❌ Error descargando "${uf.fieldName}": ${err.message}`);
      }
    }
  }

  const validFiles = uploadFields.filter((f) => f.buffer);

  if (validFiles.length === 0) {
    // Log de diagnóstico: mostrar TODOS los fields con sus types para entender la estructura
    console.log("⚠️ No se encontraron archivos descargables");
    console.log("📋 === DIAGNÓSTICO: Todos los fields del documento ===");
    if (docDetails && docDetails.fields) {
      for (const field of docDetails.fields) {
        const p = field.placeholder || "";
        const fid = field.field_id || "";
        const ft = field.type || "";
        const v = field.value;
        const vStr = typeof v === "string" ? v.substring(0, 80) : JSON.stringify(v).substring(0, 80);
        console.log(`  field_id="${fid}" type="${ft}" placeholder="${p}" value=${vStr}`);
      }
    }
    console.log("📋 === FIN DIAGNÓSTICO ===");
    console.error("❌ No se pudieron obtener archivos del documento PandaDoc");
    return;
  }

  // ── 5. Clasificar archivos ──
  console.log("📂 Clasificando archivos...");
  const classified = classifyDocFiles(validFiles);

  // ── 6. Generar PDFs con logo ──
  const logoBytes = fs.existsSync(LOGO_PATH) ? fs.readFileSync(LOGO_PATH) : null;
  if (!logoBytes) console.warn("⚠️ Logo no encontrado");

  const generatedPdfs = [];

  if (classified.ciFront || classified.ciBack) {
    const pdf = await generateCombinedPdfWithLogo([classified.ciFront, classified.ciBack].filter(Boolean), logoBytes);
    generatedPdfs.push({ filename: "CI.pdf", buffer: pdf });
    console.log("📄 CI.pdf generado");
  }
  if (classified.titulo) {
    const pdf = await generateCombinedPdfWithLogo([classified.titulo], logoBytes);
    generatedPdfs.push({ filename: "Titulo.pdf", buffer: pdf });
    console.log("📄 Titulo.pdf generado");
  }
  if (classified.licFront || classified.licBack) {
    const pdf = await generateCombinedPdfWithLogo([classified.licFront, classified.licBack].filter(Boolean), logoBytes);
    generatedPdfs.push({ filename: "Licencia.pdf", buffer: pdf });
    console.log("📄 Licencia.pdf generado");
  }
  if (classified.hvc) {
    const pdf = await generateCombinedPdfWithLogo([classified.hvc], logoBytes);
    generatedPdfs.push({ filename: "HojaVida.pdf", buffer: pdf });
    console.log("📄 HojaVida.pdf generado");
  }
  for (let i = 0; i < classified.otros.length; i++) {
    const pdf = await generateCombinedPdfWithLogo([classified.otros[i]], logoBytes);
    generatedPdfs.push({ filename: `Otro_${i + 1}.pdf`, buffer: pdf });
    console.log(`📄 Otro_${i + 1}.pdf generado`);
  }

  if (generatedPdfs.length === 0) {
    console.error("❌ No se generaron PDFs");
    return;
  }
  console.log(`✅ Total PDFs generados: ${generatedPdfs.length}`);

  // ── 7. Buscar registro en Airtable ──
  console.log(`🔍 Buscando en Airtable: ID=${procesoId}`);
  let recordId;
  try {
    const searchRes = await axios.get(
      `https://api.airtable.com/v0/${airtableBaseId}/${airtableTableId}`,
      {
        headers: { Authorization: `Bearer ${airtableApiKey}` },
        params: { filterByFormula: `{ID} = "${procesoId}"`, maxRecords: 1 },
        timeout: 15000,
      }
    );
    if (searchRes.data.records.length > 0) {
      recordId = searchRes.data.records[0].id;
      console.log(`✅ Registro encontrado: ${recordId}`);
    } else {
      console.error(`❌ No se encontró registro con ID=${procesoId}`);
      return;
    }
  } catch (err) {
    console.error("❌ Error buscando en Airtable:", err.response?.data || err.message);
    return;
  }

  // ── 8. Subir PDFs a Airtable ──
  console.log(`📤 Subiendo ${generatedPdfs.length} PDFs a Airtable...`);

  // Guardar PDFs como temporales y usar la REST API con URLs públicas
  const baseUrl = process.env.RAILWAY_PUBLIC_DOMAIN
    ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`
    : (process.env.PUBLIC_URL || `http://localhost:${process.env.PORT || 3000}`);

  const tmpDir = path.join(__dirname, "tmp-pdfs");
  if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir);

  const pdfAttachments = [];
  const tmpPaths = [];

  for (const pdf of generatedPdfs) {
    const pdfId = crypto.randomUUID();
    const pdfPath = path.join(tmpDir, `${pdfId}.pdf`);
    fs.writeFileSync(pdfPath, pdf.buffer);
    tmpPaths.push(pdfPath);
    pdfAttachments.push({ url: `${baseUrl}/tmp/${pdfId}.pdf`, filename: pdf.filename });
    console.log(`  🌐 ${pdf.filename} → /tmp/${pdfId}.pdf`);
  }

  // Obtener attachments existentes para no sobreescribir
  let existingAttachments = [];
  try {
    const recordRes = await axios.get(
      `https://api.airtable.com/v0/${airtableBaseId}/${airtableTableId}/${recordId}`,
      { headers: { Authorization: `Bearer ${airtableApiKey}` }, timeout: 15000 }
    );
    const currentDocs = recordRes.data.fields?.Documentos;
    if (Array.isArray(currentDocs)) {
      existingAttachments = currentDocs.map((att) => ({ url: att.url }));
      console.log(`📎 ${existingAttachments.length} docs existentes en Airtable`);
    }
  } catch (err) {
    console.warn(`⚠️ Error obteniendo docs existentes: ${err.message}`);
  }

  try {
    await axios.patch(
      `https://api.airtable.com/v0/${airtableBaseId}/${airtableTableId}/${recordId}`,
      { fields: { Documentos: [...existingAttachments, ...pdfAttachments] } },
      {
        headers: {
          Authorization: `Bearer ${airtableApiKey}`,
          "Content-Type": "application/json",
        },
        timeout: 30000,
      }
    );
    console.log("🎉 [PANDADOC-DOCS] PDFs subidos a Airtable exitosamente");
  } catch (err) {
    console.error("❌ Error subiendo a Airtable:", err.response?.data || err.message);
  }

  // Limpiar temporales después de 10 minutos
  setTimeout(() => {
    for (const p of tmpPaths) { try { if (fs.existsSync(p)) fs.unlinkSync(p); } catch {} }
    console.log(`🗑️ ${tmpPaths.length} temporales eliminados`);
  }, 10 * 60 * 1000);
}

app.post("/webhook/pandadoc-documents", async (req, res) => {
  console.log("\n📨 [PANDADOC-DOCS] Webhook recibido");

  // Log compacto del body (solo keys de primer nivel, no todo el contenido)
  const bodyForLog = Array.isArray(req.body)
    ? `Array[${req.body.length}] event=${req.body[0]?.event} docId=${req.body[0]?.data?.id}`
    : `Keys: [${Object.keys(req.body).join(", ")}] docId=${req.body.documentId || req.body.data?.id}`;
  console.log(`📦 Body: ${bodyForLog}`);

  res.status(200).json({ status: "processing" });

  processPandaDocDocuments(req.body).catch((err) => {
    console.error("❌ [PANDADOC-DOCS] Error:", err.message, err.stack);
  });
});

// ─── Arranque del servidor ───────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () =>
  console.log(`✅ Webhook Transearch listo en http://localhost:${PORT}`)
);
