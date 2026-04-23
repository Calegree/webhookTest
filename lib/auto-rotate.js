const sharp = require("sharp");
const { detectFace } = require("./face-detector");

function isPdf(buffer) {
  return buffer && buffer.length >= 4 && buffer.slice(0, 4).toString("hex") === "25504446";
}

async function bufferToImage(buffer) {
  if (isPdf(buffer)) {
    return sharp(buffer, { page: 0, density: 200 }).png().toBuffer();
  }
  return buffer;
}

// Aplica rotación EXIF y, si la imagen sigue en portrait, gira 90° para landscape.
async function rotateByExifAndAspect(imgBuffer) {
  const exifRotated = await sharp(imgBuffer).rotate().png().toBuffer();
  const meta = await sharp(exifRotated).metadata();
  const w = meta.width || 0;
  const h = meta.height || 0;
  if (h > w * 1.1) {
    console.log(`   🔄 Imagen en portrait (${w}x${h}), rotando 90° para dejarla landscape`);
    return sharp(exifRotated).rotate(90).png().toBuffer();
  }
  console.log(`   ✅ Imagen ya en landscape (${w}x${h})`);
  return exifRotated;
}

// Rotación para CI / LC: intenta orientar por detección facial (UltraFace prueba
// 0°, 90°, -90° y 180° y devuelve la rotación con mejor confianza). Si no detecta
// rostro, cae al método EXIF + aspect ratio. Si el buffer es PDF, lo devuelve tal
// cual (las páginas ya están orientadas por el generador).
async function autoRotateCarnet(buffer) {
  if (isPdf(buffer)) return buffer;
  try {
    const imgBuffer = await bufferToImage(buffer);
    const face = await detectFace(imgBuffer);
    if (face && face.buffer) {
      console.log(`   🎯 Carnet orientado por rostro (rot=${face.rotation}°, conf=${face.confidence.toFixed(2)})`);
      return face.buffer;
    }
    console.log(`   ⚠️ Rostro no detectado, usando EXIF + aspect ratio`);
    return await rotateByExifAndAspect(imgBuffer);
  } catch (err) {
    console.warn(`   ⚠️ No se pudo rotar carnet: ${err.message}`);
    return buffer;
  }
}

// Rotación para documentos sin rostro esperado (VT, HVC imagen, Otros):
// solo EXIF + aspect ratio. Si el buffer es PDF, se devuelve tal cual.
async function autoRotateDocument(buffer) {
  if (isPdf(buffer)) return buffer;
  try {
    const imgBuffer = await bufferToImage(buffer);
    return await rotateByExifAndAspect(imgBuffer);
  } catch (err) {
    console.warn(`   ⚠️ No se pudo rotar documento: ${err.message}`);
    return buffer;
  }
}

module.exports = { autoRotateCarnet, autoRotateDocument };
