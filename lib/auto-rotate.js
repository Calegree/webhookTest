const sharp = require("sharp");

// Convierte un PDF a imagen PNG (primera página). Si ya es imagen, lo devuelve.
async function bufferToImage(buffer) {
  const header = buffer.slice(0, 4).toString("hex");
  if (header === "25504446") {
    return sharp(buffer, { page: 0, density: 200 }).png().toBuffer();
  }
  return buffer;
}

// Rota un carnet a orientación landscape usando:
// 1) Auto-rotación EXIF (sharp lee el flag de orientación que pone el celular)
// 2) Heurística de aspect ratio: si después sigue en portrait (alto > ancho),
//    giramos 90° CW. Los carnets chilenos siempre son landscape, así que esto
//    cubre los casos donde no hay EXIF (capturas de pantalla, scans, etc).
async function autoRotateCarnet(buffer) {
  try {
    const imgBuffer = await bufferToImage(buffer);

    // Paso 1: aplicar rotación EXIF (sharp.rotate() sin args = usa EXIF)
    const exifRotated = await sharp(imgBuffer).rotate().png().toBuffer();
    const meta = await sharp(exifRotated).metadata();
    const w = meta.width || 0;
    const h = meta.height || 0;

    // Paso 2: si aún está en portrait, rotar 90° para dejarlo landscape.
    // Umbral: alto > ancho con margen del 10% para no rotar imágenes casi cuadradas.
    if (h > w * 1.1) {
      console.log(`   🔄 Carnet en portrait (${w}x${h}), rotando 90° para dejarlo landscape`);
      return sharp(exifRotated).rotate(90).png().toBuffer();
    }

    console.log(`   ✅ Carnet ya está en landscape (${w}x${h})`);
    return exifRotated;
  } catch (err) {
    console.warn(`   ⚠️ No se pudo rotar carnet: ${err.message}`);
    return buffer;
  }
}

module.exports = { autoRotateCarnet };
