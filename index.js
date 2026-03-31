require("dotenv").config();
const express = require("express");
const axios = require("axios");
const sharp = require("sharp");
const { google } = require("googleapis");
const crypto = require("crypto");
const path = require("path");

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
async function cropFaceFromCarnet(imageBuffer, targetAspect) {
  const meta = await sharp(imageBuffer, { failOn: "none" }).metadata();
  const w = meta.width;
  const h = meta.height;

  // Zona ajustada para capturar solo la cara sin letras ni números
  // Carnet chileno: foto en la zona izquierda, bajar el inicio y recortar derecha
  const cropLeft = Math.round(w * 0.04);
  const cropTop = Math.round(h * 0.18);
  const cropWidth = Math.round(w * 0.26);
  const cropHeight = Math.round(h * 0.55);

  console.log(`📐 Imagen original: ${w}×${h}px, recortando cara: ${cropWidth}×${cropHeight}px desde (${cropLeft},${cropTop})`);

  const faceRegion = await sharp(imageBuffer, { failOn: "none" })
    .extract({
      left: cropLeft,
      top: cropTop,
      width: Math.min(cropWidth, w - cropLeft),
      height: Math.min(cropHeight, h - cropTop),
    })
    .toBuffer();

  // Calcular dimensiones de salida según el aspect ratio del placeholder
  const aspect = targetAspect || 1;
  const outW = FACE_PX;
  const outH = Math.round(FACE_PX / aspect);

  const processedImage = await sharp(faceRegion)
    .resize(outW, outH, { fit: "cover", position: "centre" })
    .jpeg({ quality: 95 })
    .toBuffer();

  console.log(`✂️  Rostro recortado a ${outW}×${outH}px (aspect: ${aspect.toFixed(2)})`);
  return processedImage;
}

// ─── Auto-ajustar texto en la presentación ──────────────────────────────────
// EMU por punto tipográfico: 1pt = 12700 EMU
const PT_TO_EMU = 12700;
// Ancho promedio de un carácter como fracción del font size (aprox para sans-serif)
const CHAR_WIDTH_RATIO = 0.55;

async function fixTextOverflow(slides, presentationId) {
  const presentation = await slides.presentations.get({
    presentationId: presentationId,
  });

  const requests = [];

  for (const slide of presentation.data.slides || []) {
    for (const element of slide.pageElements || []) {
      if (!element.shape || !element.shape.text) continue;

      // Obtener dimensiones de la caja en EMU
      const boxWidthEmu = (element.size?.width?.magnitude || 0) *
        Math.abs(element.transform?.scaleX || 1);

      if (boxWidthEmu === 0) continue;

      // Márgenes internos de la caja (en EMU)
      const marginLeft = element.shape.shapeProperties?.contentAlignment ? 0 :
        (element.shape.text?.textElements?.[0]?.paragraphMarker?.bullet ? 45720 : 0);

      const usableWidth = boxWidthEmu - marginLeft;

      // Analizar cada línea de texto del shape
      const textElements = element.shape.text.textElements || [];

      for (const te of textElements) {
        if (!te.textRun || !te.textRun.content) continue;

        const text = te.textRun.content.replace(/\n$/, "");
        if (text.length === 0) continue;

        const currentFontSize = te.textRun.style?.fontSize?.magnitude || 10;
        const currentFontEmu = currentFontSize * PT_TO_EMU;

        // Estimar ancho del texto: caracteres * ancho_promedio_char * font_size_emu
        const estimatedTextWidth = text.length * CHAR_WIDTH_RATIO * currentFontEmu;

        if (estimatedTextWidth > usableWidth) {
          // Calcular font size que cabe
          const ratio = usableWidth / estimatedTextWidth;
          let newFontSize = Math.floor(currentFontSize * ratio * 10) / 10;
          // No reducir más del 50% del tamaño original
          newFontSize = Math.max(newFontSize, currentFontSize * 0.5);

          console.log(`📏 Texto "${text.substring(0, 30)}..." ${currentFontSize}pt → ${newFontSize}pt (${text.length} chars)`);

          requests.push({
            updateTextStyle: {
              objectId: element.objectId,
              textRange: {
                type: "ALL",
              },
              style: {
                fontSize: {
                  magnitude: newFontSize,
                  unit: "PT",
                },
              },
              fields: "fontSize",
            },
          });
          // Solo un ajuste por shape (evitar múltiples updates al mismo)
          break;
        }
      }
    }
  }

  if (requests.length > 0) {
    await slides.presentations.batchUpdate({
      presentationId: presentationId,
      requestBody: { requests },
    });
    console.log(`📏 Font size ajustado en ${requests.length} cajas de texto`);
  }

  return requests.length;
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

    // ── 5b. Auto-ajustar textos que se desbordan ──────────────────────────
    const fixedCount = await fixTextOverflow(slides, presentation_id);
    console.log(`📏 ${fixedCount} cajas de texto ajustadas`);

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
// POST /fix-text — Endpoint independiente para ajustar textos desbordados
// ─────────────────────────────────────────────────────────────────────────────
app.post("/fix-text", async (req, res) => {
  const { presentation_id } = req.body.data || req.body;

  if (!presentation_id) {
    return res.status(400).json({ error: "Falta presentation_id" });
  }

  try {
    const authClient = await auth.getClient();
    const slides = google.slides({ version: "v1", auth: authClient });
    const fixedCount = await fixTextOverflow(slides, presentation_id);

    return res.json({
      success: true,
      presentation_id,
      fixed_text_boxes: fixedCount,
      message: `Auto-fit aplicado a ${fixedCount} cajas de texto`,
    });
  } catch (error) {
    console.error("❌ Error en /fix-text:", error.message);
    return res.status(500).json({
      error: "Error ajustando textos",
      details: error.message,
    });
  }
});

// ─── Arranque del servidor ───────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () =>
  console.log(`✅ Webhook Transearch listo en http://localhost:${PORT}`)
);
