const ort = require("onnxruntime-node");
const sharp = require("sharp");
const path = require("path");

const MODEL_PATH = path.join(__dirname, "..", "models", "ultraface-320.onnx");
const INPUT_W = 320;
const INPUT_H = 240;
const CONFIDENCE_THRESHOLD = 0.5;

let session = null;

async function getSession() {
  if (!session) {
    session = await ort.InferenceSession.create(MODEL_PATH, {
      logSeverityLevel: 3, // suprimir warnings
    });
  }
  return session;
}

/**
 * Detecta el rostro más grande en una imagen.
 * Prueba la imagen original y rotaciones de 90°, -90° y 180° para cubrir carnets subidos en cualquier orientación.
 * @param {Buffer} imageBuffer - Imagen en cualquier formato (jpg, png, etc.)
 * @returns {Object|null} { left, top, width, height, confidence, rotation } en píxeles originales, o null
 */
async function detectFace(imageBuffer) {
  // Probar sin rotar primero, luego rotaciones
  const rotations = [0, 90, -90, 180];

  let bestResult = null;

  for (const angle of rotations) {
    let buf = imageBuffer;
    if (angle !== 0) {
      buf = await sharp(imageBuffer, { failOn: "none" }).rotate(angle).toBuffer();
    }

    const result = await detectInBuffer(buf);
    if (result && (!bestResult || result.confidence > bestResult.confidence)) {
      bestResult = { ...result, rotation: angle, buffer: buf };
    }
  }

  if (!bestResult) return null;

  return {
    left: bestResult.left,
    top: bestResult.top,
    width: bestResult.width,
    height: bestResult.height,
    confidence: bestResult.confidence,
    rotation: bestResult.rotation,
    buffer: bestResult.buffer, // imagen ya rotada donde se encontró la cara
  };
}

/**
 * Detecta rostros en un buffer de imagen.
 */
async function detectInBuffer(imageBuffer) {
  const sess = await getSession();

  const meta = await sharp(imageBuffer, { failOn: "none" }).metadata();
  const origW = meta.width;
  const origH = meta.height;

  const resized = await sharp(imageBuffer, { failOn: "none" })
    .resize(INPUT_W, INPUT_H, { fit: "fill" })
    .removeAlpha()
    .raw()
    .toBuffer();

  // Normalización UltraFace: (pixel - 127) / 128
  const float32 = new Float32Array(3 * INPUT_H * INPUT_W);
  for (let i = 0; i < INPUT_H * INPUT_W; i++) {
    float32[i] = (resized[i * 3] - 127) / 128;
    float32[INPUT_H * INPUT_W + i] = (resized[i * 3 + 1] - 127) / 128;
    float32[2 * INPUT_H * INPUT_W + i] = (resized[i * 3 + 2] - 127) / 128;
  }

  const inputTensor = new ort.Tensor("float32", float32, [1, 3, INPUT_H, INPUT_W]);
  const results = await sess.run({ input: inputTensor });

  const scores = results.scores.data;
  const boxes = results.boxes.data;

  let bestScore = 0;
  let bestBox = null;
  const numDetections = scores.length / 2;

  for (let i = 0; i < numDetections; i++) {
    const faceScore = scores[i * 2 + 1];
    if (faceScore > CONFIDENCE_THRESHOLD && faceScore > bestScore) {
      bestScore = faceScore;
      bestBox = {
        x1: boxes[i * 4],
        y1: boxes[i * 4 + 1],
        x2: boxes[i * 4 + 2],
        y2: boxes[i * 4 + 3],
      };
    }
  }

  if (!bestBox) return null;

  const left = Math.max(0, Math.round(bestBox.x1 * origW));
  const top = Math.max(0, Math.round(bestBox.y1 * origH));
  const right = Math.min(origW, Math.round(bestBox.x2 * origW));
  const bottom = Math.min(origH, Math.round(bestBox.y2 * origH));

  return {
    left,
    top,
    width: right - left,
    height: bottom - top,
    confidence: bestScore,
  };
}

module.exports = { detectFace };
