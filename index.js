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
const CM_2_8_IN_EMU = Math.round((2.8 / 2.54) * 914400);
const FACE_PX = 330;

// ─── Almacén temporal de imágenes en memoria ─────────────────────────────────
const tempImages = new Map();

// ─── Healthcheck ─────────────────────────────────────────────────────────────
app.get("/", (req, res) => {
  res.send("Webhook Transearch — Inserción de fotos en Google Slides activo");
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

    // ── 2. Redimensionar a cuadrado ────────────────────────────────────────
    const processedImage = await sharp(imageBuffer, { failOn: "none" })
      .resize(FACE_PX, FACE_PX, { fit: "cover", position: "centre" })
      .jpeg({ quality: 92 })
      .toBuffer();

    console.log(`✂️  Imagen redimensionada a ${FACE_PX}×${FACE_PX}px`);

    // ── 3. Servir imagen temporalmente desde este servidor ─────────────────
    const imageId = crypto.randomUUID();
    tempImages.set(imageId, processedImage);

    // Determinar URL pública
    const baseUrl = process.env.RAILWAY_PUBLIC_DOMAIN
      ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`
      : (process.env.PUBLIC_URL || `http://localhost:${PORT}`);
    const publicImageUrl = `${baseUrl}/tmp/${imageId}.jpg`;
    console.log(`🌐 Imagen disponible en: ${publicImageUrl}`);

    // ── 4. Obtener el slide e identificar el cuadro gris ───────────────────
    const authClient = await auth.getClient();
    const slides = google.slides({ version: "v1", auth: authClient });
    const presentation = await slides.presentations.get({
      presentationId: presentation_id,
    });

    let grayBoxId = null;
    let grayBoxTransform = null;
    let slideObjectId = null;

    for (const slide of presentation.data.slides || []) {
      for (const element of slide.pageElements || []) {
        if (!element.shape) continue;

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
          grayBoxTransform = element.transform;
          slideObjectId = slide.objectId;
          console.log(`🔲 Cuadro gris: ${grayBoxId} (RGB: ${r},${g},${b})`);
          break;
        }
      }
      if (grayBoxId) break;
    }

    if (!grayBoxId) {
      tempImages.delete(imageId);
      return res.status(404).json({
        error: "No se encontró un cuadro gris en la presentación.",
      });
    }

    // ── 5. Insertar imagen y eliminar cuadro gris ──────────────────────────
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
                  width: { magnitude: CM_2_8_IN_EMU, unit: "EMU" },
                  height: { magnitude: CM_2_8_IN_EMU, unit: "EMU" },
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

    console.log(`✅ Foto insertada en la presentación ${presentation_id}`);

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

// ─── Arranque del servidor ───────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () =>
  console.log(`✅ Webhook Transearch listo en http://localhost:${PORT}`)
);
