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

// ─── Test de permisos Airtable ──────────────────────────────────────────────
app.get("/test/airtable", async (req, res) => {
  const baseId = req.query.base || AIRTABLE_BASE_ID;
  const table = req.query.table || AIRTABLE_TABLE_NAME;
  const recordId = req.query.record;
  const apiKey = req.query.token || AIRTABLE_API_KEY;

  const results = {};

  // Test 1: Listar tablas de la base (requiere schema.bases:read)
  console.log("\n🧪 === TEST AIRTABLE PERMISOS ===");
  console.log(`🔑 Token (primeros 20): ${apiKey?.substring(0, 20)}...`);
  console.log(`📦 Base ID: ${baseId}`);
  console.log(`📋 Table: ${table}`);
  console.log(`📌 Record: ${recordId || "(ninguno)"}`);

  // Test 1: Listar bases accesibles
  try {
    const basesRes = await axios.get("https://api.airtable.com/v0/meta/bases", {
      headers: { Authorization: `Bearer ${apiKey}` },
      timeout: 10000,
    });
    const bases = basesRes.data.bases || [];
    results.test1_bases = {
      status: "OK",
      count: bases.length,
      bases: bases.map((b) => ({ id: b.id, name: b.name })),
    };
    console.log(`✅ Test 1 - Bases accesibles: ${bases.length}`);
    for (const b of bases) console.log(`   ${b.id} → ${b.name}`);
  } catch (err) {
    results.test1_bases = { status: "ERROR", code: err.response?.status, error: err.response?.data || err.message };
    console.error(`❌ Test 1 - Error listando bases: ${err.response?.status} ${JSON.stringify(err.response?.data)}`);
  }

  // Test 2: Listar registros de la tabla (solo 1)
  try {
    const url = `https://api.airtable.com/v0/${baseId}/${encodeURIComponent(table)}?maxRecords=1`;
    const listRes = await axios.get(url, {
      headers: { Authorization: `Bearer ${apiKey}` },
      timeout: 10000,
    });
    const records = listRes.data.records || [];
    results.test2_list = {
      status: "OK",
      count: records.length,
      firstRecordId: records[0]?.id,
      firstRecordFields: Object.keys(records[0]?.fields || {}),
    };
    console.log(`✅ Test 2 - Listar tabla "${table}": ${records.length} registro(s)`);
    if (records[0]) console.log(`   Primer registro: ${records[0].id}`);
  } catch (err) {
    results.test2_list = { status: "ERROR", code: err.response?.status, error: err.response?.data || err.message };
    console.error(`❌ Test 2 - Error listando tabla: ${err.response?.status} ${JSON.stringify(err.response?.data)}`);
  }

  // Test 3: Leer registro específico (si se proporcionó)
  if (recordId) {
    try {
      const url = `https://api.airtable.com/v0/${baseId}/${encodeURIComponent(table)}/${recordId}`;
      const recRes = await axios.get(url, {
        headers: { Authorization: `Bearer ${apiKey}` },
        timeout: 10000,
      });
      results.test3_record = {
        status: "OK",
        id: recRes.data.id,
        fields: Object.keys(recRes.data.fields || {}),
        hasFoto: !!recRes.data.fields?.Foto,
      };
      console.log(`✅ Test 3 - Registro ${recordId}: OK`);
      console.log(`   Campos: ${Object.keys(recRes.data.fields || {}).join(", ")}`);
    } catch (err) {
      results.test3_record = { status: "ERROR", code: err.response?.status, error: err.response?.data || err.message };
      console.error(`❌ Test 3 - Error leyendo registro: ${err.response?.status} ${JSON.stringify(err.response?.data)}`);
    }
  }

  console.log("🧪 === FIN TEST ===\n");
  res.json(results);
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
      console.error("🔍 DEBUG - URL:", `https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/${encodeURIComponent(AIRTABLE_TABLE_NAME)}/${record_id}`);
      console.error("🔍 DEBUG - BASE_ID:", AIRTABLE_BASE_ID);
      console.error("🔍 DEBUG - TABLE_NAME:", AIRTABLE_TABLE_NAME);
      console.error("🔍 DEBUG - API_KEY (primeros 15 chars):", AIRTABLE_API_KEY?.substring(0, 15));
      console.error("🔍 DEBUG - Response status:", err.response?.status);
      console.error("🔍 DEBUG - Response data:", JSON.stringify(err.response?.data));
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

// Clasifica archivos según el nombre del campo de PandaDoc
// Los campos Collect files vienen como "Haz clic para subir un archivo (CI)", "(LC)", "(Título)", "(HVC)"
// Para CI y LC que aparecen 2 veces: el primero es frente, el segundo es reverso
function classifyDocFiles(files) {
  const result = {
    ciFront: null, ciBack: null, titulo: null,
    licFront: null, licBack: null, hvc: null, otros: [],
  };

  for (const file of files) {
    const name = (file.fieldName || "").toLowerCase();
    console.log(`  📂 Clasificando: "${file.fieldName}"`);

    // Patrones para campos PandaDoc: "(CI)", "(LC)", "(Título)", "(HVC)"
    // y también formatos descriptivos: "cédula frente", "licencia reverso", etc.
    if (/\(ci\)|c[eé]dula|identidad|carnet/i.test(name)) {
      if (!result.ciFront) {
        result.ciFront = file;
        console.log(`    → CI Frente`);
      } else {
        result.ciBack = file;
        console.log(`    → CI Reverso`);
      }
    } else if (/\(t[ií]tulo\)|t[ií]tulo/i.test(name)) {
      result.titulo = file;
      console.log(`    → Título`);
    } else if (/\(lc\)|licencia/i.test(name)) {
      if (!result.licFront) {
        result.licFront = file;
        console.log(`    → Licencia Frente`);
      } else {
        result.licBack = file;
        console.log(`    → Licencia Reverso`);
      }
    } else if (/\(hvc\)|hoja\s*de\s*vida|conductor/i.test(name)) {
      result.hvc = file;
      console.log(`    → Hoja de Vida Conductor`);
    } else if (/otro/i.test(name) || name === "") {
      result.otros.push(file);
      console.log(`    → Otro`);
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

  // ── 3. Obtener detalles del documento para encontrar Collect files ──
  console.log("🔍 Obteniendo detalles del documento de PandaDoc...");
  let docDetails = null;
  try {
    const detailsRes = await axios.get(
      `https://api.pandadoc.com/public/v1/documents/${documentId}/details`,
      { headers: { Authorization: `API-Key ${pandadocApiKey}` }, timeout: 30000 }
    );
    docDetails = detailsRes.data;
    const topKeys = Object.keys(docDetails);
    console.log(`📋 Details keys: [${topKeys.join(", ")}]`);

    // Log compacto de cada propiedad que sea un array (para encontrar dónde están los Collect files)
    for (const key of topKeys) {
      const val = docDetails[key];
      if (Array.isArray(val) && val.length > 0) {
        console.log(`📋 "${key}": ${val.length} items`);
        // Mostrar primer item como muestra de la estructura
        const sample = val[0];
        const sampleKeys = Object.keys(sample);
        console.log(`   Sample keys: [${sampleKeys.join(", ")}]`);
        // Para fields, images, tokens: mostrar TODOS los items de forma compacta
        if (["fields", "images", "tokens"].includes(key)) {
          for (let i = 0; i < val.length; i++) {
            const item = val[i];
            const itemStr = JSON.stringify(item).substring(0, 300);
            console.log(`   [${i}] ${itemStr}`);
          }
        }
      }
    }
  } catch (err) {
    console.error("❌ Error en /details:", err.response?.status, err.response?.data || err.message);
  }

  // ── 4. Extraer archivos de Collect files ──
  const uploadFields = [];

  if (docDetails) {
    // Buscar en TODAS las propiedades del documento que sean arrays
    for (const key of Object.keys(docDetails)) {
      const arr = docDetails[key];
      if (!Array.isArray(arr)) continue;

      for (const item of arr) {
        if (!item || typeof item !== "object") continue;

        // Buscar cualquier campo que tenga URL de archivo o sea tipo file/collect/upload/image
        const type = (item.type || "").toLowerCase();
        const placeholder = (item.placeholder || "").toLowerCase();
        const name = (item.name || "").toLowerCase();
        const fieldId = (item.field_id || "").toLowerCase();

        // Detectar campos Collect files por tipo, placeholder, o estructura
        const isFileType = /file|collect|upload|attachment|image/i.test(type);
        const isFileByPlaceholder = /subir|archivo|upload|adjuntar|haz clic/i.test(placeholder);
        const hasFileData = item.value && typeof item.value === "object" && (item.value.url || item.value.download_url || item.value.file_url);
        const hasDirectUrl = item.url || item.download_url || item.file_url || item.src;

        if (isFileType || isFileByPlaceholder || hasFileData || hasDirectUrl) {
          console.log(`  📎 Posible archivo en "${key}": ${JSON.stringify(item).substring(0, 400)}`);

          let url = "";
          let fileName = "";
          let fieldName = item.placeholder || item.name || item.field_id || item.title || key;

          // Extraer URL del archivo
          if (hasFileData) {
            url = item.value.url || item.value.download_url || item.value.file_url;
            fileName = item.value.file_name || item.value.name || "";
          } else if (hasDirectUrl) {
            url = item.url || item.download_url || item.file_url || item.src;
            fileName = item.file_name || item.name || "";
          }

          // Si el value es un string que parece nombre de archivo
          if (!url && typeof item.value === "string" && /\.(jpg|jpeg|png|pdf|doc|docx)$/i.test(item.value)) {
            fileName = item.value;
            console.log(`    📎 Value es nombre de archivo: "${fileName}" - necesitamos encontrar la URL`);
          }

          if (url) {
            uploadFields.push({ fieldName, url, fileName: fileName || fieldName });
          }
        }
      }
    }
  }

  // También buscar con el endpoint /fields
  try {
    const fieldsRes = await axios.get(
      `https://api.pandadoc.com/public/v1/documents/${documentId}/fields`,
      { headers: { Authorization: `API-Key ${pandadocApiKey}` }, timeout: 30000 }
    );
    const fieldsData = fieldsRes.data;
    const fieldsList = Array.isArray(fieldsData) ? fieldsData : (fieldsData.fields || fieldsData.results || []);
    console.log(`📋 /fields endpoint: ${fieldsList.length} campos`);
    for (const field of fieldsList) {
      const type = (field.type || "").toLowerCase();
      if (/file|collect|upload|attachment|image/i.test(type)) {
        console.log(`  📎 [/fields] tipo archivo: ${JSON.stringify(field).substring(0, 400)}`);
      }
    }
  } catch (err) {
    console.error("⚠️ Error en /fields:", err.response?.status);
  }

  // Probar endpoint de linked objects (podrían ser los archivos)
  try {
    const linkedRes = await axios.get(
      `https://api.pandadoc.com/public/v1/documents/${documentId}/linked-objects`,
      { headers: { Authorization: `API-Key ${pandadocApiKey}` }, timeout: 30000 }
    );
    console.log("📋 Linked objects:", JSON.stringify(linkedRes.data).substring(0, 500));
  } catch (err) {
    console.log(`⚠️ /linked-objects: ${err.response?.status || err.message}`);
  }

  // Probar endpoint de sections/content
  try {
    const sectionsRes = await axios.get(
      `https://api.pandadoc.com/public/v1/documents/${documentId}/sections`,
      { headers: { Authorization: `API-Key ${pandadocApiKey}` }, timeout: 30000 }
    );
    console.log("📋 Sections:", JSON.stringify(sectionsRes.data).substring(0, 500));
  } catch (err) {
    console.log(`⚠️ /sections: ${err.response?.status || err.message}`);
  }

  console.log(`📎 Upload fields encontrados: ${uploadFields.length}`);

  // Si encontramos campos con URLs, descargarlos
  if (uploadFields.length > 0) {
    console.log("📥 Descargando archivos...");
    for (const uf of uploadFields) {
      try {
        const response = await axios.get(uf.url, {
          responseType: "arraybuffer",
          headers: { Authorization: `API-Key ${pandadocApiKey}` },
          timeout: 60000,
        });
        uf.buffer = Buffer.from(response.data);
        console.log(`  ✅ "${uf.fieldName}": ${uf.fileName} (${uf.buffer.length} bytes)`);
      } catch (err) {
        console.error(`  ❌ Error descargando "${uf.fieldName}": ${err.response?.status} ${err.message}`);
      }
    }
  }

  const validFiles = uploadFields.filter((f) => f.buffer);

  if (validFiles.length === 0) {
    console.error("❌ No se encontraron archivos Collect files descargables");
    console.log("💡 Revisa los logs de arriba - busca items en 'images', 'fields' o 'tokens' que contengan URLs de archivos");
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
