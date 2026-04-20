const Tesseract = require("tesseract.js");
const sharp = require("sharp");

let osdWorker = null;

// worker.detect() requiere el engine Legacy de Tesseract, que por defecto
// tesseract.js v7 no carga (solo trae el WASM LSTM, más chico). Hay que pedir
// explícitamente legacyCore + legacyLang y usar OEM=0 (TESSERACT_ONLY).
async function getWorker() {
  if (!osdWorker) {
    osdWorker = await Tesseract.createWorker("osd", 0, {
      legacyCore: true,
      legacyLang: true,
    });
  }
  return osdWorker;
}

async function bufferToImage(buffer) {
  const header = buffer.slice(0, 4).toString("hex");
  if (header === "25504446") {
    return sharp(buffer, { page: 0, density: 200 }).png().toBuffer();
  }
  return buffer;
}

async function autoRotateCarnet(buffer) {
  try {
    const imgBuffer = await bufferToImage(buffer);
    const worker = await getWorker();
    const { data } = await worker.detect(imgBuffer);
    const angle = data?.orientation_degrees ?? 0;
    if (angle === 0) {
      console.log(`   🔄 Carnet ya está derecho (0°)`);
      return imgBuffer;
    }
    console.log(`   🔄 Rotando carnet ${angle}° (confianza ${data?.orientation_confidence?.toFixed?.(1) ?? "?"})`);
    return sharp(imgBuffer).rotate(angle).png().toBuffer();
  } catch (err) {
    console.warn(`   ⚠️ No se pudo rotar carnet: ${err.message}`);
    return buffer;
  }
}

module.exports = { autoRotateCarnet };
