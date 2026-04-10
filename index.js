require("dotenv").config();
const express = require("express");
const axios = require("axios");
const sharp = require("sharp");
const { google } = require("googleapis");
const crypto = require("crypto");
const path = require("path");
const fs = require("fs");
const PDFDocument = require("pdfkit");
const { PDFDocument: PDFLib, PDFName, PDFRef } = require("pdf-lib");
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

// ─── Recorte de rostro desde imagen de carnet usando detección facial ────────
const { detectFace } = require("./lib/face-detector");

async function cropFaceFromCarnet(imageBuffer) {
  const meta = await sharp(imageBuffer, { failOn: "none" }).metadata();
  console.log(`📐 Imagen original: ${meta.width}×${meta.height}px`);

  // Detectar rostro automáticamente (prueba rotaciones si es necesario)
  const face = await detectFace(imageBuffer);

  if (!face) {
    console.warn("⚠️ No se detectó rostro, usando recorte por posición fija (fallback)");
    return cropFaceByPosition(imageBuffer);
  }

  console.log(`🎯 Rostro detectado: confianza=${face.confidence.toFixed(2)}, rotación=${face.rotation}°, pos=(${face.left},${face.top}) ${face.width}×${face.height}px`);

  // Expandir el recorte un 30% alrededor de la cara para incluir cabeza completa
  const faceMeta = await sharp(face.buffer, { failOn: "none" }).metadata();
  const padX = Math.round(face.width * 0.3);
  const padY = Math.round(face.height * 0.3);
  const left = Math.max(0, face.left - padX);
  const top = Math.max(0, face.top - padY);
  const right = Math.min(faceMeta.width, face.left + face.width + padX);
  const bottom = Math.min(faceMeta.height, face.top + face.height + padY);

  const faceRegion = await sharp(face.buffer, { failOn: "none" })
    .extract({ left, top, width: right - left, height: bottom - top })
    .toBuffer();

  const outW = FACE_PX;
  const outH = Math.round(FACE_PX * 1.33); // ratio 3:4 (retrato)

  const processedImage = await sharp(faceRegion)
    .resize(outW, outH, { fit: "cover", position: "centre" })
    .grayscale()
    .linear(0.85, 30)
    .jpeg({ quality: 95 })
    .toBuffer();

  console.log(`✂️  Rostro recortado a ${outW}×${outH}px (retrato 3:4, escala de grises)`);
  return processedImage;
}

// Fallback: recorte por posición fija (layout original: logo + frente + reverso)
async function cropFaceByPosition(imageBuffer) {
  const meta = await sharp(imageBuffer, { failOn: "none" }).metadata();
  const w = meta.width;
  const h = meta.height;

  const carnetTop = Math.round(h * 0.13);
  const carnetHeight = Math.round(h * 0.40);

  const carnetFront = await sharp(imageBuffer, { failOn: "none" })
    .extract({ left: 0, top: carnetTop, width: w, height: Math.min(carnetHeight, h - carnetTop) })
    .toBuffer();

  const carnetMeta = await sharp(carnetFront, { failOn: "none" }).metadata();
  const cw = carnetMeta.width;
  const ch = carnetMeta.height;

  const faceRegion = await sharp(carnetFront, { failOn: "none" })
    .extract({
      left: Math.round(cw * 0.12),
      top: Math.round(ch * 0.05),
      width: Math.min(Math.round(cw * 0.22), cw - Math.round(cw * 0.12)),
      height: Math.min(Math.round(ch * 0.70), ch - Math.round(ch * 0.05)),
    })
    .toBuffer();

  const outW = FACE_PX;
  const outH = Math.round(FACE_PX * 1.33);

  return sharp(faceRegion)
    .resize(outW, outH, { fit: "cover", position: "centre" })
    .grayscale()
    .linear(0.85, 30)
    .jpeg({ quality: 95 })
    .toBuffer();
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
  let { presentation_id, numero_id_proceso, nombre_candidato } = body;

  if (!presentation_id) {
    return res.status(400).json({ error: "Falta parámetro requerido: presentation_id" });
  }

  if (!numero_id_proceso || !nombre_candidato) {
    return res.status(400).json({ error: "Faltan parámetros requeridos: numero_id_proceso y nombre_candidato" });
  }

  // ── 0. Buscar carnet en Documentos por ID proceso + nombre ──────────────
  console.log(`🔍 Buscando carnet: ID=${numero_id_proceso}, Nombre=${nombre_candidato}`);
  let imageBuffer;
  try {
    const docBaseId = process.env.AIRTABLE_BASE_ID_DOCUMENTS || "appowVIrRtsBBMKUg";
    const docTableId = process.env.AIRTABLE_TABLE_ID_DOCUMENTS || "tblwulQitACgXEdya";
    const docApiKey = process.env.AIRTABLE_API_KEY_DOCUMENTS || AIRTABLE_API_KEY;

    // 1) Buscar por ID + nombre exacto
    let formula = `AND({ID} = "${numero_id_proceso}", {Nombre y Apellido} = "${nombre_candidato}")`;
    const searchOpts = {
      headers: { Authorization: `Bearer ${docApiKey}` },
      timeout: 15000,
    };
    let searchRes = await axios.get(
      `https://api.airtable.com/v0/${docBaseId}/${docTableId}`,
      { ...searchOpts, params: { filterByFormula: formula, maxRecords: 1 } }
    );

    // 2) Si no encuentra, buscar por ID + apellidos parciales (FIND en Airtable)
    if (searchRes.data.records.length === 0) {
      const palabras = nombre_candidato.split(/\s+/).filter((p) => p.length >= 4);
      if (palabras.length > 0) {
        // Usar las últimas 2 palabras (apellidos) o todas si son pocas
        const apellidos = palabras.slice(-2);
        const findConditions = apellidos.map((p) => `FIND("${p}", {Nombre y Apellido})`).join(", ");
        formula = `AND({ID} = "${numero_id_proceso}", ${findConditions})`;
        console.log(`⚠️ No encontrado con nombre exacto, buscando con apellidos: ${apellidos.join(", ")}`);
        searchRes = await axios.get(
          `https://api.airtable.com/v0/${docBaseId}/${docTableId}`,
          { ...searchOpts, params: { filterByFormula: formula, maxRecords: 5 } }
        );
      }
    }

    if (searchRes.data.records.length === 0) {
      return res.status(404).json({
        error: `No se encontró registro con ID=${numero_id_proceso} y Nombre="${nombre_candidato}"`,
      });
    }

    const record = searchRes.data.records[0];
    console.log(`✅ Registro encontrado: ${record.id}`);

    const carnetField = record.fields["Frente Carnet Extraido"];
    if (!carnetField || !Array.isArray(carnetField) || carnetField.length === 0) {
      return res.status(422).json({
        error: `El registro ID=${numero_id_proceso} no tiene carnet en "Frente Carnet Extraido"`,
      });
    }

    const carnetAtt = carnetField[0];
    console.log(`📎 Carnet: ${carnetAtt.filename} (${carnetAtt.type})`);

    if (carnetAtt.type === "application/pdf") {
      console.log("📄 Carnet es PDF, convirtiendo a imagen...");
      const pdfResponse = await axios.get(carnetAtt.url, {
        responseType: "arraybuffer",
        timeout: 30000,
      });
      const pdfBuffer = Buffer.from(pdfResponse.data);

      try {
        imageBuffer = await sharp(pdfBuffer, { density: 300, page: 0 })
          .jpeg({ quality: 95 })
          .toBuffer();
        console.log(`✅ PDF convertido a imagen: ${imageBuffer.length} bytes`);
      } catch (sharpErr) {
        console.error(`⚠️ Sharp no puede convertir PDF: ${sharpErr.message}`);
        const thumbUrl = carnetAtt.thumbnails?.full?.url || carnetAtt.thumbnails?.large?.url;
        if (thumbUrl) {
          const thumbRes = await axios.get(thumbUrl, { responseType: "arraybuffer", timeout: 15000 });
          imageBuffer = Buffer.from(thumbRes.data);
          console.log(`📎 Usando thumbnail de Airtable: ${imageBuffer.length} bytes`);
        } else {
          return res.status(422).json({
            error: "No se pudo convertir el PDF del carnet a imagen",
            details: sharpErr.message,
          });
        }
      }
    } else {
      const imgRes = await axios.get(carnetAtt.url, { responseType: "arraybuffer", timeout: 15000 });
      imageBuffer = Buffer.from(imgRes.data);
      console.log(`✅ Imagen descargada: ${imageBuffer.length} bytes`);
    }
  } catch (err) {
    if (err.response?.status) {
      console.error("❌ Error buscando carnet:", err.response?.status, err.response?.data);
    } else {
      console.error("❌ Error buscando carnet:", err.message);
    }
    return res.status(502).json({
      error: "Error buscando carnet en base de Documentos",
      details: err.message,
    });
  }

  try {
    console.log(`📥 Presentación: ${presentation_id}`);

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
      underline: true,
    });
    doc.moveDown(2);

    // Función para dibujar una tabla con bordes
    const tableX = 72;
    const labelW = 150;
    const valueW = 310;
    const tableW = labelW + valueW;
    const cellPadding = 6;

    function drawTable(rows) {
      let y = doc.y;
      for (const row of rows) {
        doc.font("Helvetica").fontSize(11);
        const valueText = row.value || "";
        const textH = Math.max(
          doc.heightOfString(row.label, { width: labelW - cellPadding * 2 }),
          doc.heightOfString(valueText, { width: valueW - cellPadding * 2 })
        );
        const rowH = textH + cellPadding * 2;

        // Bordes de celdas
        doc.lineWidth(0.5).strokeColor("#000000");
        doc.rect(tableX, y, labelW, rowH).stroke();
        doc.rect(tableX + labelW, y, valueW, rowH).stroke();

        // Texto label (izquierda)
        doc.text(row.label, tableX + cellPadding, y + cellPadding, {
          width: labelW - cellPadding * 2,
        });
        // Texto value (derecha)
        doc.text(valueText, tableX + labelW + cellPadding, y + cellPadding, {
          width: valueW - cellPadding * 2,
        });

        y += rowH;
      }
      doc.y = y;
    }

    // Bloque 1: Nombre y Rut
    drawTable([
      { label: "Nombre completo", value: data.nombre },
      { label: "Rut", value: data.rut },
    ]);

    doc.moveDown(1);

    // Bloque 2: Cargo, ID, División
    drawTable([
      { label: "Cargo al que postula", value: data.cargo },
      { label: "ID", value: data.id },
      { label: "División", value: data.division },
    ]);

    doc.moveDown(1);

    // Bloque 3: Título, Establecimiento, Estado, Contacto
    drawTable([
      { label: "Título", value: data.titulo },
      { label: "Establecimiento Educacional", value: data.establecimiento },
      { label: "Estado", value: data.estado || "" },
      { label: "Contacto de Validación", value: data.contacto || "" },
    ]);

    // Fecha
    doc.moveDown(3);
    const now = new Date();
    const dateStr = `Santiago, ${now.getDate()} de ${MONTHS_ES[now.getMonth()]} de ${now.getFullYear()}`;
    doc.font("Helvetica").fontSize(11).text(dateStr, tableX);

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
// Genera un PDF de 1 sola página con 2 imágenes (frente arriba, reverso abajo) + logo centrado
async function generateSinglePageWithLogo(files, logoBytes) {
  const doc = await PDFLib.create();
  const page = doc.addPage([612, 792]); // Letter size
  const { width: pw, height: ph } = page.getSize();

  // Reservar espacio para logo arriba
  const logo = logoBytes ? await doc.embedPng(logoBytes) : null;
  const logoW = 120;
  const logoH = logo ? (logo.height / logo.width) * logoW : 0;
  const logoMarginTop = 15;
  const logoSpace = logo ? logoH + logoMarginTop + 10 : 0;

  // Espacio disponible para las imágenes
  const margin = 20;
  const gap = 10;
  const availableHeight = ph - logoSpace - margin;
  const halfHeight = (availableHeight - gap) / 2;
  const availableWidth = pw - margin * 2;

  // Embeber imágenes
  const images = [];
  for (const file of files) {
    try {
      const header = file.buffer.slice(0, 4).toString("hex");
      let img;
      if (header.startsWith("89504e47")) {
        img = await doc.embedPng(file.buffer);
      } else if (header.startsWith("ffd8ff")) {
        img = await doc.embedJpg(file.buffer);
      } else {
        // Es un PDF, extraer primera página como imagen embebida
        const srcPdf = await PDFLib.load(file.buffer, { ignoreEncryption: true });
        const embeddedPage = await doc.embedPage(srcPdf.getPage(0));
        images.push({ type: "page", embed: embeddedPage, width: embeddedPage.width, height: embeddedPage.height });
        continue;
      }
      images.push({ type: "image", embed: img, width: img.width, height: img.height });
    } catch (err) {
      console.error(`  ⚠️ No se pudo procesar archivo: ${err.message}`);
    }
  }

  // Dibujar imágenes: primera arriba, segunda abajo
  for (let idx = 0; idx < images.length && idx < 2; idx++) {
    const item = images[idx];
    const scale = Math.min(availableWidth / item.width, halfHeight / item.height, 1);
    const iw = item.width * scale;
    const ih = item.height * scale;

    // y: primera imagen arriba (justo debajo del logo), segunda abajo
    const yBase = idx === 0
      ? ph - logoSpace - ih - (halfHeight - ih) / 2
      : margin + (halfHeight - ih) / 2;
    const x = (pw - iw) / 2;

    if (item.type === "image") {
      page.drawImage(item.embed, { x, y: yBase, width: iw, height: ih });
    } else {
      page.drawPage(item.embed, { x, y: yBase, width: iw, height: ih });
    }
  }

  // Dibujar logo centrado arriba
  if (logo) {
    page.drawImage(logo, {
      x: (pw - logoW) / 2,
      y: ph - logoH - logoMarginTop,
      width: logoW,
      height: logoH,
    });
  }

  return Buffer.from(await doc.save());
}

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
    const logoMarginTop = 15;
    const logoTotalHeight = logoH + logoMarginTop + 10; // espacio logo + margen inferior

    for (let i = 0; i < srcDoc.getPageCount(); i++) {
      const srcPage = srcDoc.getPage(i);
      const { width: srcW, height: srcH } = srcPage.getSize();

      const newPage = destDoc.addPage([srcW, srcH]);

      // Embeber página original y escalarla para dejar espacio al logo arriba
      const embeddable = await destDoc.embedPage(srcPage);
      const availableHeight = srcH - logoTotalHeight;
      const scale = availableHeight / srcH;
      const contentW = srcW * scale;
      const contentH = srcH * scale;

      // Contenido redimensionado en la parte inferior
      newPage.drawPage(embeddable, {
        x: (srcW - contentW) / 2,
        y: 0,
        width: contentW,
        height: contentH,
      });

      // Logo centrado arriba
      newPage.drawImage(logo, {
        x: (srcW - logoW) / 2,
        y: srcH - logoH - logoMarginTop,
        width: logoW,
        height: logoH,
      });
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
  let documentId, documentName, recipientEmail, recipientName, pdfUrl;

  if (body.documentId) {
    // Formato Zapier simple: { documentId, documentName, recipientEmail, recipientFirstName, pdfUrl }
    documentId = body.documentId;
    documentName = body.documentName;
    recipientEmail = body.recipientEmail;
    recipientName = body.recipientFirstName || "";
    pdfUrl = body.pdfUrl || "";
  } else {
    // Formato PandaDoc crudo: array con [{ event, data: { id, name, ... } }]
    const event = Array.isArray(body) ? body[0] : body;
    const data = event.data || event;
    documentId = data.id || event.id;
    documentName = data.name || event.name;
    // Buscar email y nombre del recipient
    const recipients = data.recipients || [];
    recipientEmail = recipients.length > 0
      ? recipients[0].email
      : (data.recipient?.email || "");
    recipientName = recipients.length > 0
      ? [recipients[0].first_name, recipients[0].last_name].filter(Boolean).join(" ")
      : "";
  }

  if (!documentId) {
    console.error("❌ [PANDADOC-DOCS] No se encontró documentId en el body");
    return;
  }

  console.log(`📄 Document ID: ${documentId}`);
  console.log(`📝 Document Name: ${documentName}`);
  console.log(`👤 Recipient Name: ${recipientName || "(no disponible)"}`);
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

  // ── 5b. Buscar registro en Airtable (por ID + Correo del recipient) ──
  console.log(`🔍 Buscando en Airtable: ID=${procesoId}, Email=${recipientEmail || "(sin email)"}`);
  let recordId;
  let nombreCompleto = recipientName || "";
  let vtData = {};
  try {
    const formula = recipientEmail
      ? `AND({ID} = "${procesoId}", LOWER({Correo}) = "${recipientEmail.toLowerCase()}")`
      : `{ID} = "${procesoId}"`;
    console.log(`📐 Fórmula: ${formula}`);

    const searchRes = await axios.get(
      `https://api.airtable.com/v0/${airtableBaseId}/${airtableTableId}`,
      {
        headers: { Authorization: `Bearer ${airtableApiKey}` },
        params: { filterByFormula: formula, maxRecords: 1 },
        timeout: 15000,
      }
    );
    if (searchRes.data.records.length > 0) {
      const fields = searchRes.data.records[0].fields || {};
      recordId = searchRes.data.records[0].id;
      nombreCompleto = fields["Nombre y Apellido"] || nombreCompleto;
      // Guardar datos para la portada VT
      vtData = {
        nombre: nombreCompleto,
        rut: fields["Rut"] || "",
        cargo: fields["Cargo"] || "",
        id: fields["ID"] || procesoId,
        division: fields["División"] || "",
        titulo: fields["Título"] || "",
        establecimiento: (fields["Establecimiento"] || [])[0] || "",
      };
      console.log(`✅ Registro encontrado: ${recordId} (${nombreCompleto})`);
    } else {
      console.error(`❌ No se encontró registro con ID=${procesoId}${recipientEmail ? ` y Correo="${recipientEmail}"` : ""}`);
      return;
    }
  } catch (err) {
    console.error("❌ Error buscando en Airtable:", err.response?.data || err.message);
    return;
  }

  // ── 6. Generar PDFs con logo ──
  const logoBytes = fs.existsSync(LOGO_PATH) ? fs.readFileSync(LOGO_PATH) : null;
  if (!logoBytes) console.warn("⚠️ Logo no encontrado");

  const generatedPdfs = [];
  const prefix = `${procesoId} - `;
  const suffix = ` - ${nombreCompleto}`;

  if (classified.ciFront || classified.ciBack) {
    const pdf = await generateSinglePageWithLogo([classified.ciFront, classified.ciBack].filter(Boolean), logoBytes);
    generatedPdfs.push({ filename: `${prefix}CI${suffix}.pdf`, buffer: pdf });
    console.log(`📄 ${prefix}CI${suffix}.pdf generado`);
  }
  if (classified.titulo) {
    // Validar título automáticamente si la universidad es soportada
    try {
      const tituloData = await extractTituloData(classified.titulo.buffer);
      // Rellenar datos de la portada desde el PDF si vienen vacíos de Airtable
      if (!vtData.titulo && tituloData.titulo) vtData.titulo = tituloData.titulo;
      if (!vtData.establecimiento && tituloData.universidad) vtData.establecimiento = tituloData.universidad;
      console.log(`   📝 Datos del PDF: título="${tituloData.titulo || '-'}" universidad="${tituloData.universidad || '-'}"`);
      if (tituloData.universidad_key && !tituloData.es_documento_fisico) {
        console.log(`   🔍 Validando título en ${tituloData.universidad}...`);
        const verificacion = await validarTitulo(tituloData.universidad_key, tituloData);
        if (verificacion.valido === true) {
          vtData.estado = "Validado";
        } else if (verificacion.valido === false) {
          vtData.estado = "Rechazado";
        }
        console.log(`   📋 Resultado validación: ${vtData.estado || "REQUIERE REVISIÓN"}`);
      }
    } catch (err) {
      console.warn(`   ⚠️ Error validando título: ${err.message}`);
    }

    // Generar portada con tabla de datos + título con logo
    const coverBytes = await buildCoverPage(vtData);
    const tituloWithLogo = await generateCombinedPdfWithLogo([classified.titulo], logoBytes);

    // Combinar portada + título en un solo PDF
    const vtDoc = await PDFLib.create();
    const coverPdf = await PDFLib.load(coverBytes);
    const coverPages = await vtDoc.copyPages(coverPdf, coverPdf.getPageIndices());
    for (const p of coverPages) vtDoc.addPage(p);
    const tituloPdf = await PDFLib.load(tituloWithLogo);
    const tituloPages = await vtDoc.copyPages(tituloPdf, tituloPdf.getPageIndices());
    for (const p of tituloPages) vtDoc.addPage(p);

    generatedPdfs.push({ filename: `${prefix}VT${suffix}.pdf`, buffer: Buffer.from(await vtDoc.save()) });
    console.log(`📄 ${prefix}VT${suffix}.pdf generado (portada + título)`);
  }
  if (classified.licFront || classified.licBack) {
    const pdf = await generateSinglePageWithLogo([classified.licFront, classified.licBack].filter(Boolean), logoBytes);
    generatedPdfs.push({ filename: `${prefix}LC${suffix}.pdf`, buffer: pdf });
    console.log(`📄 ${prefix}LC${suffix}.pdf generado`);
  }
  if (classified.hvc) {
    // Validar HVC automáticamente contra el Registro Civil
    let hvcValidado = false;
    try {
      console.log(`   🔍 Validando HVC contra Registro Civil...`);
      const extracted = await extractLicenseData(classified.hvc.buffer);
      console.log(`   📝 Datos HVC: Folio=${extracted.folio || '-'}, RUT=${extracted.rut || '-'}, CVE=${extracted.codigo_verificacion || '-'}`);

      if (extracted.folio && extracted.codigo_verificacion) {
        const verificacion = await verificarCertificado(extracted.folio, extracted.codigo_verificacion);
        console.log(`   📋 Resultado RC: ${verificacion.mensaje}`);
        if (verificacion.valido === true) {
          hvcValidado = true;
          console.log(`   ✅ HVC VALIDADO`);
        } else {
          console.log(`   ❌ HVC no validado`);
        }
      } else {
        console.log(`   ⚠️ No se pudo extraer folio/CVE del HVC, no se puede validar`);
      }
    } catch (err) {
      console.warn(`   ⚠️ Error validando HVC: ${err.message}`);
    }

    const hvcLabel = hvcValidado ? `${prefix}HVC VALIDADO${suffix}.pdf` : `${prefix}HVC${suffix}.pdf`;
    const pdf = await generateCombinedPdfWithLogo([classified.hvc], logoBytes);
    generatedPdfs.push({ filename: hvcLabel, buffer: pdf });
    console.log(`📄 ${hvcLabel} generado`);
  }
  for (let i = 0; i < classified.otros.length; i++) {
    const pdf = await generateCombinedPdfWithLogo([classified.otros[i]], logoBytes);
    generatedPdfs.push({ filename: `${prefix}Otro_${i + 1}${suffix}.pdf`, buffer: pdf });
    console.log(`📄 ${prefix}Otro_${i + 1}${suffix}.pdf generado`);
  }

  // ── 6b. Descargar PDF original (declaraciones firmadas) sin logo ──
  if (pdfUrl) {
    console.log("📥 Descargando PDF original de declaraciones...");
    try {
      const pdfRes = await axios.get(pdfUrl, { responseType: "arraybuffer", timeout: 60000 });
      const srcPdf = await PDFLib.load(pdfRes.data, { ignoreEncryption: true });
      const pageCount = srcPdf.getPageCount();
      console.log(`📄 PDF original: ${pageCount} páginas`);

      // Detectar la página de "ADJUNTAR DOCUMENTOS" (collect files).
      // El texto de PandaDoc está embebido con font encoding custom, no se puede leer directo.
      // Heurística: la página de collect files es la primera página (después de las declaraciones)
      // cuyo content stream principal es corto (~12k) seguida de páginas con streams muy cortos
      // (<2k), que son las previsualizaciones de los archivos adjuntos.
      // Las páginas de declaraciones tienen streams de 8k-50k.
      const zlib = require("zlib");
      let collectPageIndex = -1;

      for (let i = 0; i < pageCount; i++) {
        const page = srcPdf.getPage(i);
        const contentsRef = page.node.get(PDFName.of("Contents"));
        if (!contentsRef || contentsRef.constructor.name !== "PDFArray") continue;

        let fullText = "";
        for (let j = 0; j < contentsRef.size(); j++) {
          const ref = contentsRef.get(j);
          const stream = ref instanceof PDFRef ? page.node.context.lookup(ref) : ref;
          try {
            const raw = stream.contents;
            if (raw) {
              try { fullText += zlib.inflateSync(Buffer.from(raw)).toString("utf-8"); }
              catch { fullText += Buffer.from(raw).toString("latin1"); }
            }
          } catch {}
        }

        // Buscar texto "ADJUNTAR" en el content stream o en XObjects
        if (fullText.includes("ADJUNTAR") || fullText.includes("DOCUMENTO SOLICITADO")) {
          collectPageIndex = i;
          console.log(`🔍 Página de collect files detectada por texto: ${i + 1}`);
          break;
        }

        // Heurística: detectar la página de collect files por su patrón
        // Es la primera página cuyo stream tiene <15k y la siguiente tiene <2k
        if (i > 5 && fullText.length < 15000 && i + 1 < pageCount) {
          const nextPage = srcPdf.getPage(i + 1);
          const nextContents = nextPage.node.get(PDFName.of("Contents"));
          if (nextContents && nextContents.constructor.name === "PDFArray") {
            let nextText = "";
            for (let j = 0; j < nextContents.size(); j++) {
              const ref = nextContents.get(j);
              const stream = ref instanceof PDFRef ? nextPage.node.context.lookup(ref) : ref;
              try {
                const raw = stream.contents;
                if (raw) {
                  try { nextText += zlib.inflateSync(Buffer.from(raw)).toString("utf-8"); }
                  catch { nextText += Buffer.from(raw).toString("latin1"); }
                }
              } catch {}
            }
            if (nextText.length < 2000) {
              collectPageIndex = i;
              console.log(`🔍 Página de collect files detectada por heurística: ${i + 1} (stream=${fullText.length}, siguiente=${nextText.length})`);
              break;
            }
          }
        }
      }

      // Crear nuevo PDF excluyendo solo la página de collect files
      const cleanPdf = await PDFLib.create();
      const indicesToKeep = [];
      for (let i = 0; i < pageCount; i++) {
        if (i !== collectPageIndex) indicesToKeep.push(i);
      }
      const pagesToKeep = await cleanPdf.copyPages(srcPdf, indicesToKeep);
      for (const p of pagesToKeep) cleanPdf.addPage(p);

      const cleanedPdfBytes = await cleanPdf.save();
      generatedPdfs.push({ filename: `${prefix}Declaraciones${suffix}.pdf`, buffer: Buffer.from(cleanedPdfBytes) });
      console.log(`📄 ${prefix}Declaraciones${suffix}.pdf generado (${cleanPdf.getPageCount()} de ${pageCount} páginas, sin logo)`);
    } catch (err) {
      console.error("⚠️ Error descargando PDF original:", err.message);
    }
  }

  if (generatedPdfs.length === 0) {
    console.error("❌ No se generaron PDFs");
    return;
  }
  console.log(`✅ Total PDFs generados: ${generatedPdfs.length}`);

  // ── 7. Subir PDFs a Airtable ──
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

// ─── Test: explorar qué devuelve PandaDoc /details para Collect files ───────
app.get("/test/pandadoc-details/:documentId", async (req, res) => {
  const documentId = req.params.documentId;
  const pandadocApiKey = process.env.PANDADOC_API_KEY_DOCUMENTS;

  const results = { documentId, endpoints: {} };

  // 1. /details
  try {
    const r = await axios.get(
      `https://api.pandadoc.com/public/v1/documents/${documentId}/details`,
      { headers: { Authorization: `API-Key ${pandadocApiKey}` }, timeout: 30000 }
    );
    const data = r.data;
    results.endpoints.details = {
      keys: Object.keys(data),
      fields_count: (data.fields || []).length,
      fields: (data.fields || []).map((f) => ({
        field_id: f.field_id,
        type: f.type,
        name: f.name,
        placeholder: f.placeholder,
        value: f.value,
        merge_field: f.merge_field,
      })),
      images_count: (data.images || []).length,
      images: (data.images || []).slice(0, 10),
      tokens_count: (data.tokens || []).length,
      tokens: (data.tokens || []).slice(0, 10),
    };
  } catch (err) {
    results.endpoints.details = { error: err.response?.status, data: err.response?.data || err.message };
  }

  // 2. /fields
  try {
    const r = await axios.get(
      `https://api.pandadoc.com/public/v1/documents/${documentId}/fields`,
      { headers: { Authorization: `API-Key ${pandadocApiKey}` }, timeout: 30000 }
    );
    results.endpoints.fields = r.data;
  } catch (err) {
    results.endpoints.fields = { error: err.response?.status, data: err.response?.data || err.message };
  }

  // 3. /content
  try {
    const r = await axios.get(
      `https://api.pandadoc.com/public/v1/documents/${documentId}/content`,
      { headers: { Authorization: `API-Key ${pandadocApiKey}` }, timeout: 30000 }
    );
    results.endpoints.content = typeof r.data === "string" ? r.data.substring(0, 2000) : r.data;
  } catch (err) {
    results.endpoints.content = { error: err.response?.status, data: err.response?.data || err.message };
  }

  // 4. /linked-objects
  try {
    const r = await axios.get(
      `https://api.pandadoc.com/public/v1/documents/${documentId}/linked-objects`,
      { headers: { Authorization: `API-Key ${pandadocApiKey}` }, timeout: 30000 }
    );
    results.endpoints.linked_objects = r.data;
  } catch (err) {
    results.endpoints.linked_objects = { error: err.response?.status, data: err.response?.data || err.message };
  }

  // 5. /download con separate_files
  try {
    const r = await axios.get(
      `https://api.pandadoc.com/public/v1/documents/${documentId}/download`,
      {
        headers: { Authorization: `API-Key ${pandadocApiKey}` },
        timeout: 30000,
        responseType: "arraybuffer",
        params: { separate_files: true },
      }
    );
    const contentType = r.headers["content-type"] || "";
    results.endpoints.download_separate = {
      content_type: contentType,
      size_bytes: r.data.length,
      is_zip: contentType.includes("zip") || r.data.slice(0, 4).toString("hex") === "504b0304",
      is_pdf: contentType.includes("pdf"),
    };
  } catch (err) {
    results.endpoints.download_separate = { error: err.response?.status, data: err.response?.data?.toString?.()?.substring(0, 500) || err.message };
  }

  res.json(results);
});

// ─── Sync "Retirado" entre 3 bases de Airtable ─────────────────────────────
const SYNC_API_KEY = process.env.AIRTABLE_SYNC_API_KEY || process.env.AIRTABLE_API_KEY;

const BASES_CONFIG = {
  documentos: {
    baseId: "appowVIrRtsBBMKUg",
    tableId: "tblwulQitACgXEdya",
    idField: "ID",
    rutField: "Rut",
    retiradoFieldId: "fld2iqLEBu8Kv4fM9",
    retiradoFieldName: "Retirado",
    // Campos que indican retiro
    triggers: [
      { field: "Categoría", fieldId: "fldA9ccZcN6IYcAwh", values: ["DESISTE", "DESCARTADO/A"] },
      { field: "Estado", fieldId: "fldGGIWOrl2XNFRxF", values: ["Cancelado"] },
      { field: "Correo de Cierre", fieldId: "fldI0SvMeKzynmyTR", contains: ["Desiste", "Descarte"] },
      { field: "Estado de avance", fieldId: "fld3yAvCeaY2el5Ug", contains: ["Desiste", "Descarte", "ADULTERACION"] },
    ],
    watchFieldIds: ["fldA9ccZcN6IYcAwh", "fldGGIWOrl2XNFRxF", "fldI0SvMeKzynmyTR", "fld3yAvCeaY2el5Ug"],
  },
  psicolaborales: {
    baseId: "apph3dXyQoZBhK8Zl",
    tableId: "tblihdKgunXnyXJmZ",
    idField: "ID",
    rutField: "RUT",
    retiradoFieldId: "fldFn9pQBHOS4VQ3F",
    retiradoFieldName: "Retirado",
    triggers: [
      { field: "Categoría", fieldId: "fldpPpLALxg8RAvLi", values: ["DESISTE", "No Recomendado", "Homologado No Recomendado"] },
    ],
    watchFieldIds: ["fldpPpLALxg8RAvLi"],
  },
  examenes: {
    baseId: "appTDqX5xPNm7uUqU",
    tableId: "tblbXWtnhMuc54XkO",
    idField: "ID",
    rutField: "Rut",
    retiradoFieldId: null, // Pendiente: crear cuando se desactive sandbox
    retiradoFieldName: "Retirado",
    triggers: [
      { field: "Estado", fieldId: "fld0ZPsshHZOtpgLN", values: ["Descarte", "Desiste", "CANCELADO", "No se gestiona"] },
      { field: "Categoría", fieldId: "fldUF5rKa0dx04ntq", values: ["No avanza"] },
    ],
    watchFieldIds: ["fld0ZPsshHZOtpgLN", "fldUF5rKa0dx04ntq"],
  },
};

function normalizeRut(rut) {
  if (!rut) return "";
  return String(rut).replace(/[.\-\s]/g, "").toLowerCase().trim();
}

function isRetiradoTriggered(fields, triggers) {
  for (const t of triggers) {
    const val = fields[t.field];
    if (!val) continue;
    const valStr = Array.isArray(val) ? val.join(", ") : String(val);
    if (t.values && t.values.includes(valStr)) return true;
    if (t.contains && t.contains.some((kw) => valStr.includes(kw))) return true;
  }
  return false;
}

// Buscar y marcar "Retirado" en una base por ID + RUT
async function markRetiradoInBase(config, procesoId, rut) {
  if (!config.retiradoFieldId) {
    console.log(`   ⏭️ ${config.baseId}: sin campo Retirado configurado`);
    return;
  }
  const normalRut = normalizeRut(rut);
  try {
    // Buscar por ID
    const searchRes = await axios.get(
      `https://api.airtable.com/v0/${config.baseId}/${config.tableId}`,
      {
        headers: { Authorization: `Bearer ${SYNC_API_KEY}` },
        params: {
          filterByFormula: `{${config.idField}} = "${procesoId}"`,
          maxRecords: 10,
        },
        timeout: 15000,
      }
    );
    for (const record of searchRes.data.records) {
      const recordRut = normalizeRut(record.fields[config.rutField]);
      if (recordRut && normalRut && recordRut !== normalRut) continue; // RUT distinto, saltar

      if (record.fields[config.retiradoFieldName]) continue; // Ya marcado

      await axios.patch(
        `https://api.airtable.com/v0/${config.baseId}/${config.tableId}/${record.id}`,
        { fields: { [config.retiradoFieldName]: true } },
        {
          headers: { Authorization: `Bearer ${SYNC_API_KEY}`, "Content-Type": "application/json" },
          timeout: 15000,
        }
      );
      console.log(`   ✅ Marcado Retirado en ${config.baseId} record=${record.id}`);
    }
  } catch (err) {
    console.error(`   ❌ Error marcando en ${config.baseId}: ${err.response?.data?.error?.message || err.message}`);
  }
}

// Endpoint que recibe notificaciones de Airtable Webhook
app.post("/webhook/sync-retirado", async (req, res) => {
  console.log("\n🔴 [SYNC-RETIRADO] Notificación recibida");
  res.status(200).json({ ok: true });

  const { base, cursor } = req.body || {};
  if (!base?.id) {
    console.log("   ⚠️ Sin base.id en el body, ignorando");
    return;
  }

  // Identificar qué base envió la notificación
  const origen = Object.entries(BASES_CONFIG).find(([, c]) => c.baseId === base.id);
  if (!origen) {
    console.log(`   ⚠️ Base ${base.id} no configurada`);
    return;
  }
  const [origenKey, origenConfig] = origen;
  console.log(`   📍 Origen: ${origenKey}`);

  // Obtener payloads del webhook
  try {
    // Buscar el webhook activo para esta base
    const whRes = await axios.get(
      `https://api.airtable.com/v0/bases/${base.id}/webhooks`,
      { headers: { Authorization: `Bearer ${SYNC_API_KEY}` }, timeout: 15000 }
    );
    const webhook = whRes.data.webhooks?.find((w) => w.notificationUrl?.includes("sync-retirado"));
    if (!webhook) {
      console.log("   ⚠️ No se encontró webhook activo");
      return;
    }

    // Obtener payloads pendientes
    const payloadsRes = await axios.get(
      `https://api.airtable.com/v0/bases/${base.id}/webhooks/${webhook.id}/payloads`,
      {
        headers: { Authorization: `Bearer ${SYNC_API_KEY}` },
        params: cursor ? { cursor } : {},
        timeout: 15000,
      }
    );

    const payloads = payloadsRes.data.payloads || [];
    console.log(`   📦 ${payloads.length} payload(s)`);

    for (const payload of payloads) {
      const changedRecords = payload.changedTablesById?.[origenConfig.tableId]?.changedRecordsById || {};

      for (const [recordId, changes] of Object.entries(changedRecords)) {
        const changedFields = changes.current?.cellValuesByFieldId || {};

        // Verificar si algún campo trigger cambió a valor de retiro
        let triggered = false;
        for (const trigger of origenConfig.triggers) {
          const newVal = changedFields[trigger.fieldId];
          if (newVal === undefined) continue;
          const valStr = newVal?.name || (Array.isArray(newVal) ? newVal.map((v) => v.name || v).join(", ") : String(newVal || ""));
          if (trigger.values && trigger.values.includes(valStr)) triggered = true;
          if (trigger.contains && trigger.contains.some((kw) => valStr.includes(kw))) triggered = true;
        }

        if (!triggered) continue;

        console.log(`   🔴 Record ${recordId} → RETIRADO detectado`);

        // Obtener ID y RUT del record
        const recordRes = await axios.get(
          `https://api.airtable.com/v0/${origenConfig.baseId}/${origenConfig.tableId}/${recordId}`,
          { headers: { Authorization: `Bearer ${SYNC_API_KEY}` }, timeout: 15000 }
        );
        const fields = recordRes.data.fields;
        const procesoId = fields[origenConfig.idField];
        const rut = fields[origenConfig.rutField];

        if (!procesoId) {
          console.log(`   ⚠️ Record sin ID, saltando`);
          continue;
        }
        console.log(`   📋 ID=${procesoId}, RUT=${rut}`);

        // Marcar Retirado en TODAS las bases (incluyendo la de origen)
        for (const [key, config] of Object.entries(BASES_CONFIG)) {
          console.log(`   🔄 Sincronizando → ${key}...`);
          await markRetiradoInBase(config, procesoId, rut);
        }
      }
    }
  } catch (err) {
    console.error(`   ❌ Error procesando payloads: ${err.response?.data || err.message}`);
  }
});

// Endpoint manual para marcar Retirado por ID + RUT en todas las bases
app.post("/webhook/marcar-retirado", async (req, res) => {
  const { id, rut } = req.body;
  if (!id) return res.status(400).json({ error: "Falta campo: id" });

  console.log(`\n🔴 [MARCAR-RETIRADO] Manual: ID=${id}, RUT=${rut}`);
  for (const [key, config] of Object.entries(BASES_CONFIG)) {
    console.log(`   🔄 → ${key}...`);
    await markRetiradoInBase(config, id, rut);
  }
  res.json({ ok: true, message: `Retirado marcado para ID=${id}` });
});

// ─── Configurar webhooks nativos de Airtable ────────────────────────────────
app.get("/setup-retirado-webhooks", async (req, res) => {
  const baseUrl = process.env.RAILWAY_PUBLIC_DOMAIN
    ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`
    : process.env.PUBLIC_URL || `http://localhost:${PORT}`;
  const notificationUrl = `${baseUrl}/webhook/sync-retirado`;

  const results = {};
  for (const [key, config] of Object.entries(BASES_CONFIG)) {
    try {
      // Verificar si ya existe un webhook
      const existing = await axios.get(
        `https://api.airtable.com/v0/bases/${config.baseId}/webhooks`,
        { headers: { Authorization: `Bearer ${SYNC_API_KEY}` }, timeout: 15000 }
      );
      const active = existing.data.webhooks?.find(
        (w) => w.notificationUrl === notificationUrl && !w.isHookExpired
      );
      if (active) {
        results[key] = { status: "already_active", id: active.id, expires: active.expirationTime };
        continue;
      }

      // Crear webhook nuevo
      const whRes = await axios.post(
        `https://api.airtable.com/v0/bases/${config.baseId}/webhooks`,
        {
          notificationUrl,
          specification: {
            options: {
              filters: {
                dataTypes: ["tableData"],
                recordChangeScope: config.tableId,
                watchDataInFieldIds: config.watchFieldIds,
              },
            },
          },
        },
        {
          headers: { Authorization: `Bearer ${SYNC_API_KEY}`, "Content-Type": "application/json" },
          timeout: 15000,
        }
      );
      results[key] = { status: "created", id: whRes.data.id, expires: whRes.data.expirationTime };
    } catch (err) {
      results[key] = { status: "error", message: err.response?.data?.error?.message || err.message };
    }
  }
  console.log("🔧 [SETUP WEBHOOKS]", JSON.stringify(results, null, 2));
  res.json({ notificationUrl, webhooks: results });
});

// Renovar webhooks (deben renovarse cada 7 días)
app.get("/refresh-retirado-webhooks", async (req, res) => {
  const results = {};
  for (const [key, config] of Object.entries(BASES_CONFIG)) {
    try {
      const existing = await axios.get(
        `https://api.airtable.com/v0/bases/${config.baseId}/webhooks`,
        { headers: { Authorization: `Bearer ${SYNC_API_KEY}` }, timeout: 15000 }
      );
      for (const wh of existing.data.webhooks || []) {
        if (wh.notificationUrl?.includes("sync-retirado")) {
          await axios.post(
            `https://api.airtable.com/v0/bases/${config.baseId}/webhooks/${wh.id}/refresh`,
            {},
            { headers: { Authorization: `Bearer ${SYNC_API_KEY}` }, timeout: 15000 }
          );
          results[key] = { status: "refreshed", id: wh.id };
        }
      }
    } catch (err) {
      results[key] = { status: "error", message: err.response?.data?.error?.message || err.message };
    }
  }
  res.json({ webhooks: results });
});

// ─── Arranque del servidor ───────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () =>
  console.log(`✅ Webhook Transearch listo en http://localhost:${PORT}`)
);
