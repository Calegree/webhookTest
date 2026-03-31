require("dotenv").config();
const express = require("express");
const axios = require("axios");
const sharp = require("sharp");
const { google } = require("googleapis");
const vision = require("@google-cloud/vision");
const { Readable } = require("stream");
const path = require("path");

const app = express();
app.use(express.json());

// ─── Airtable config ────────────────────────────────────────────────────────
const AIRTABLE_API_KEY = process.env.AIRTABLE_API_KEY;
const AIRTABLE_BASE_ID = process.env.AIRTABLE_BASE_ID;
const AIRTABLE_TABLE_NAME = process.env.AIRTABLE_TABLE_NAME || "One Page";
const AIRTABLE_PHOTO_FIELD = process.env.AIRTABLE_PHOTO_FIELD || "Foto";

// ─── Autenticación con Service Account ───────────────────────────────────────
const CREDENTIALS_PATH = path.join(__dirname, "credentials.json");

const auth = new google.auth.GoogleAuth({
  keyFile: CREDENTIALS_PATH,
  scopes: [
    "https://www.googleapis.com/auth/presentations",
    "https://www.googleapis.com/auth/drive",
  ],
});

const visionClient = new vision.ImageAnnotatorClient({
  keyFilename: CREDENTIALS_PATH,
});

// ─── Constantes de tamaño ────────────────────────────────────────────────────
// 2.8 cm en EMU (English Metric Units): 1 inch = 914400 EMU, 1 inch = 2.54 cm
const CM_2_8_IN_EMU = Math.round((2.8 / 2.54) * 914400); // ≈ 1,007,874 EMU
// Para procesado interno usamos 330px (equivale a 2.8cm @ ~300dpi)
const FACE_PX = 330;

// ─── Healthcheck ─────────────────────────────────────────────────────────────
app.get("/", (req, res) => {
  res.send("🚀 Webhook Transearch — Inserción de fotos en Google Slides activo");
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /insert-photo
//
// Body JSON:
//   { "presentation_id": "...", "record_id": "..." }
//   O bien:
//   { "presentation_id": "...", "image_url": "..." }
//
// Flujo:
//   0. Si no hay image_url, busca la foto en Airtable usando record_id
//   1. Descarga la imagen
//   2. Google Vision API → detecta el rostro y obtiene su bounding box
//   3. Sharp → recorta solo la cara + resize cuadrado 2.8×2.8 cm
//   4. Sube imagen procesada a Google Drive (pública temporalmente)
//   5. Google Slides API → detecta el primer rectángulo gris del slide
//   6. Crea la imagen en esa posición y elimina el rectángulo gris
//   7. Elimina el archivo temporal de Drive (60s de gracia)
//   8. Retorna { success: true, presentation_id }
// ─────────────────────────────────────────────────────────────────────────────
app.post("/insert-photo", async (req, res) => {
  console.log("📦 Body recibido:", JSON.stringify(req.body, null, 2));
  const body = req.body.data || req.body;
  let { image_url, presentation_id, record_id } = body;

  // Validación de entrada
  if (!presentation_id) {
    return res.status(400).json({
      error: "Falta parámetro requerido: presentation_id",
    });
  }

  if (!image_url && !record_id) {
    return res.status(400).json({
      error:
        "Falta parámetro requerido: image_url o record_id (para buscar foto en Airtable)",
    });
  }

  // ── 0. Si no hay image_url, obtenerla desde Airtable ────────────────────
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

      image_url = photoField[0].url;
      console.log(`📸 URL de foto obtenida desde Airtable: ${image_url}`);
    } catch (err) {
      console.error("❌ Error consultando Airtable:", err.message);
      return res.status(502).json({
        error: "Error consultando Airtable para obtener la foto",
        details: err.message,
      });
    }
  }

  let driveFileId = null;

  try {
    console.log(`\n📥 Nueva solicitud — presentación: ${presentation_id}`);
    console.log(`🔗 URL imagen: ${image_url}`);

    // ── 1. Descargar imagen del carnet ──────────────────────────────────────
    const imageResponse = await axios.get(image_url, {
      responseType: "arraybuffer",
      timeout: 15000,
    });
    const imageBuffer = Buffer.from(imageResponse.data);
    console.log(`✅ Imagen descargada (${imageBuffer.length} bytes)`);

    // ── 2. Detectar rostro con Vision API ───────────────────────────────────
    const [visionResult] = await visionClient.faceDetection({
      image: { content: imageBuffer.toString("base64") },
    });

    const faces = visionResult.faceAnnotations;
    if (!faces || faces.length === 0) {
      return res.status(422).json({
        error: "No se detectó ningún rostro en la imagen del carnet",
      });
    }

    // Bounding box del primer rostro detectado
    const face = faces[0];
    const vertices = face.boundingPoly.vertices;
    const faceX = vertices[0].x || 0;
    const faceY = vertices[0].y || 0;
    const faceW = (vertices[2].x || 0) - faceX;
    const faceH = (vertices[2].y || 0) - faceY;

    // Padding del 25% para no cortar el rostro justo al borde
    const padding = Math.round(Math.min(faceW, faceH) * 0.25);
    const cropX = Math.max(0, faceX - padding);
    const cropY = Math.max(0, faceY - padding);
    const cropSide = Math.round(Math.max(faceW, faceH) + padding * 2);

    console.log(
      `👤 Rostro detectado en (${faceX},${faceY}) tamaño ${faceW}×${faceH}px`
    );

    // ── 3. Recortar cara y redimensionar a cuadrado 2.8×2.8 cm ─────────────
    const imageMeta = await sharp(imageBuffer).metadata();
    const safeW = Math.min(cropSide, imageMeta.width - cropX);
    const safeH = Math.min(cropSide, imageMeta.height - cropY);

    const processedFace = await sharp(imageBuffer)
      .extract({
        left: Math.round(cropX),
        top: Math.round(cropY),
        width: Math.max(safeW, 1),
        height: Math.max(safeH, 1),
      })
      .resize(FACE_PX, FACE_PX, { fit: "cover", position: "top" })
      .jpeg({ quality: 92 })
      .toBuffer();

    console.log(`✂️  Cara recortada y redimensionada a ${FACE_PX}×${FACE_PX}px`);

    // ── 4. Subir imagen procesada a Google Drive (pública) ──────────────────
    const authClient = await auth.getClient();
    const drive = google.drive({ version: "v3", auth: authClient });

    const driveResponse = await drive.files.create({
      requestBody: {
        name: `foto-candidato-${Date.now()}.jpg`,
        mimeType: "image/jpeg",
      },
      media: {
        mimeType: "image/jpeg",
        body: Readable.from(processedFace),
      },
      fields: "id",
    });

    driveFileId = driveResponse.data.id;

    // Hacer el archivo público (necesario para que Slides API lo lea)
    await drive.permissions.create({
      fileId: driveFileId,
      requestBody: { role: "reader", type: "anyone" },
    });

    const publicImageUrl = `https://drive.google.com/uc?export=view&id=${driveFileId}`;
    console.log(`☁️  Imagen subida a Drive: ${driveFileId}`);

    // ── 5. Obtener el slide e identificar el cuadro gris ────────────────────
    const slides = google.slides({ version: "v1", auth: authClient });
    const presentation = await slides.presentations.get({
      presentationId: presentation_id,
    });

    // Busca en TODOS los slides el primer rectángulo con relleno gris
    let grayBoxId = null;
    let grayBoxTransform = null;
    let grayBoxSize = null;
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

        // Relleno gris: canales similares entre sí y en rango medio (80–220)
        const isGray =
          Math.abs(r - g) < 35 &&
          Math.abs(g - b) < 35 &&
          Math.abs(r - b) < 35 &&
          r > 80 &&
          r < 220;

        if (isGray) {
          grayBoxId = element.objectId;
          grayBoxTransform = element.transform;
          grayBoxSize = element.size;
          slideObjectId = slide.objectId;
          console.log(
            `🔲 Cuadro gris encontrado: ${grayBoxId} (RGB: ${r},${g},${b})`
          );
          break;
        }
      }
      if (grayBoxId) break;
    }

    if (!grayBoxId) {
      return res.status(404).json({
        error:
          "No se encontró un cuadro gris en la presentación. Asegúrate de que el template tiene un rectángulo de color gris como placeholder de la foto.",
      });
    }

    // ── 6. Insertar imagen en el slide y eliminar cuadro gris ───────────────
    // Forzamos tamaño 2.8×2.8 cm en EMU, manteniendo la posición del cuadro gris
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
            deleteObject: {
              objectId: grayBoxId,
            },
          },
        ],
      },
    });

    console.log(`✅ Foto insertada en la presentación ${presentation_id}`);

    // ── 7. Eliminar archivo temporal de Drive (60s de gracia) ───────────────
    setTimeout(async () => {
      try {
        await drive.files.delete({ fileId: driveFileId });
        console.log(`🗑️  Archivo temporal eliminado de Drive: ${driveFileId}`);
      } catch (e) {
        console.warn(
          `⚠️  No se pudo eliminar el archivo de Drive: ${e.message}`
        );
      }
    }, 60_000);

    // ── 8. Responder a Zapier ────────────────────────────────────────────────
    return res.json({
      success: true,
      presentation_id,
      message: "Foto del candidato insertada correctamente en la presentación",
    });
  } catch (error) {
    console.error("❌ Error en /insert-photo:", error.message);

    // Limpieza de emergencia del archivo de Drive si falló algo después de subir
    if (driveFileId) {
      try {
        const authClient = await auth.getClient();
        const drive = google.drive({ version: "v3", auth: authClient });
        await drive.files.delete({ fileId: driveFileId });
      } catch (_) {}
    }

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
