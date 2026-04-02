const axios = require("axios");
const { extractLicenseData } = require("./claude-vision");
const { verificarCertificado } = require("./registro-civil");
const { isValidRut, formatRut } = require("./rut-utils");

const AIRTABLE_API_KEY = process.env.AIRTABLE_API_KEY;

/**
 * Orquestador principal: descarga PDF, extrae datos, verifica en RC, escribe resultado en Airtable.
 *
 * @param {Object} config
 * @param {string} config.recordId - ID del registro en Airtable
 * @param {string} config.baseId - Base ID de Airtable
 * @param {string} config.tableName - Nombre de la tabla
 * @param {string} config.pdfField - Nombre del campo con el PDF adjunto
 * @param {string} config.statusField - Campo donde escribir el estado
 * @param {string} config.resultField - Campo donde escribir el resultado detallado
 * @param {string} config.rutEsperado - RUT esperado del candidato (opcional, para cruce)
 */
async function validateDriverLicense(config) {
  const {
    recordId,
    baseId,
    tableName,
    pdfField = "HVC",
    statusField = "Estado HVC",
    resultField = "Resultado HVC",
    rutEsperado,
  } = config;

  const result = {
    status: "PROCESANDO",
    extracted: null,
    verificacion_rc: null,
    validaciones: {},
    observaciones: [],
  };

  try {
    // 1. Actualizar estado a "Procesando"
    await updateAirtable(baseId, tableName, recordId, {
      [statusField]: "Procesando...",
    });

    // 2. Obtener URL del PDF desde Airtable
    console.log(`📄 [HVC] Obteniendo PDF para registro: ${recordId}`);
    const record = await getAirtableRecord(baseId, tableName, recordId);
    const attachments = record.fields[pdfField];

    if (!attachments || !Array.isArray(attachments) || attachments.length === 0) {
      throw new Error(`No se encontró PDF en el campo "${pdfField}"`);
    }

    // Buscar el PDF de HVC (excluir otros documentos)
    const hvcAttachment = attachments.find((att) => {
      const name = (att.filename || "").toUpperCase();
      return name.includes("HVC") || name.includes("HOJA") || name.includes("VIDA");
    }) || attachments[0];

    // 3. Descargar PDF
    console.log(`📥 Descargando: ${hvcAttachment.filename}`);
    const pdfResponse = await axios.get(hvcAttachment.url, {
      responseType: "arraybuffer",
      timeout: 30000,
    });
    const pdfBuffer = Buffer.from(pdfResponse.data);

    // 4. Extraer datos con Claude Vision
    console.log(`🤖 Extrayendo datos con Claude...`);
    const extracted = await extractLicenseData(pdfBuffer);
    result.extracted = extracted;
    console.log(`✅ Datos extraídos: Folio=${extracted.folio}, RUT=${extracted.rut}`);

    // 5. Validar RUT
    if (extracted.rut) {
      const rutValid = isValidRut(extracted.rut);
      result.validaciones.rut_valido = rutValid;
      if (!rutValid) {
        result.observaciones.push("⚠️ El RUT del documento no pasa validación de dígito verificador");
      }

      // Cruzar con RUT esperado si viene
      if (rutEsperado) {
        const rutMatch = formatRut(extracted.rut) === formatRut(rutEsperado);
        result.validaciones.rut_coincide = rutMatch;
        if (!rutMatch) {
          result.observaciones.push(
            `❌ RUT no coincide: documento=${formatRut(extracted.rut)}, esperado=${formatRut(rutEsperado)}`
          );
        }
      }
    }

    // 6. Verificar en Registro Civil
    if (extracted.folio && extracted.codigo_verificacion) {
      console.log(`🔍 Verificando en Registro Civil: Folio=${extracted.folio}`);
      const verificacion = await verificarCertificado(
        extracted.folio,
        extracted.codigo_verificacion
      );
      result.verificacion_rc = verificacion;
      console.log(`📋 Resultado RC: ${verificacion.mensaje}`);

      if (verificacion.valido === true) {
        result.observaciones.push("✅ Documento verificado como auténtico por el Registro Civil");
      } else if (verificacion.valido === false) {
        result.observaciones.push("❌ Documento NO verificado por el Registro Civil (inválido o expirado)");
      } else {
        result.observaciones.push("⚠️ Verificación en Registro Civil requiere revisión manual");
      }
    } else {
      result.observaciones.push("⚠️ No se pudo extraer folio/código de verificación del PDF");
    }

    // 7. Determinar estado final
    if (result.verificacion_rc?.valido === true && result.validaciones.rut_valido !== false) {
      result.status = "APROBADO";
      if (result.validaciones.rut_coincide === false) {
        result.status = "REQUIERE REVISIÓN";
      }
    } else if (result.verificacion_rc?.valido === false) {
      result.status = "RECHAZADO";
    } else {
      result.status = "REQUIERE REVISIÓN";
    }

    // 8. Construir resumen legible
    const resumen = [
      `📋 VALIDACIÓN HVC - ${result.status}`,
      ``,
      `👤 Nombre: ${extracted.nombre_completo || "N/A"}`,
      `🆔 RUT: ${extracted.rut || "N/A"}`,
      `🚗 Última clase: ${extracted.ultima_clase || "N/A"}`,
      `📍 Municipalidad: ${extracted.ultima_municipalidad || "N/A"}`,
      `📅 Emisión documento: ${extracted.fecha_emision || "N/A"}`,
      ``,
      `🔐 Folio: ${extracted.folio || "N/A"}`,
      `🔑 CVE: ${extracted.codigo_verificacion || "N/A"}`,
      ``,
      `--- Resultado Registro Civil ---`,
      result.verificacion_rc?.mensaje || "No verificado",
      ``,
      `--- Observaciones ---`,
      ...result.observaciones,
    ].join("\n");

    // 9. Escribir resultado en Airtable
    await updateAirtable(baseId, tableName, recordId, {
      [statusField]: result.status,
      [resultField]: resumen,
    });

    console.log(`✅ [HVC] Validación completada: ${result.status} para ${extracted.nombre_completo}`);
    return result;
  } catch (err) {
    console.error(`❌ [HVC] Error validando: ${err.message}`);
    result.status = "ERROR";
    result.observaciones.push(`Error: ${err.message}`);

    try {
      await updateAirtable(baseId, tableName, recordId, {
        [statusField]: "ERROR",
        [resultField]: `Error en validación: ${err.message}`,
      });
    } catch (writeErr) {
      console.error(`❌ Error escribiendo en Airtable: ${writeErr.message}`);
    }

    return result;
  }
}

// --- Helpers de Airtable ---

async function getAirtableRecord(baseId, tableName, recordId) {
  const url = `https://api.airtable.com/v0/${baseId}/${encodeURIComponent(tableName)}/${recordId}`;
  const res = await axios.get(url, {
    headers: { Authorization: `Bearer ${AIRTABLE_API_KEY}` },
    timeout: 15000,
  });
  return res.data;
}

async function updateAirtable(baseId, tableName, recordId, fields) {
  const url = `https://api.airtable.com/v0/${baseId}/${encodeURIComponent(tableName)}/${recordId}`;
  await axios.patch(
    url,
    { fields },
    {
      headers: {
        Authorization: `Bearer ${AIRTABLE_API_KEY}`,
        "Content-Type": "application/json",
      },
      timeout: 15000,
    }
  );
}

module.exports = { validateDriverLicense };
