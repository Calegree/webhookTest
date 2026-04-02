// Utilidades para validar y formatear RUT chileno

/**
 * Limpia un RUT: quita puntos, espacios, guiones
 * "13.564.904-K" → "13564904K"
 */
function cleanRut(rut) {
  return String(rut).replace(/[\s.\-]/g, "").toUpperCase();
}

/**
 * Valida el dígito verificador de un RUT chileno
 * Algoritmo módulo 11
 */
function isValidRut(rut) {
  const clean = cleanRut(rut);
  if (clean.length < 2) return false;

  const body = clean.slice(0, -1);
  const dv = clean.slice(-1);

  if (!/^\d+$/.test(body)) return false;

  let sum = 0;
  let multiplier = 2;
  for (let i = body.length - 1; i >= 0; i--) {
    sum += parseInt(body[i]) * multiplier;
    multiplier = multiplier === 7 ? 2 : multiplier + 1;
  }

  const remainder = 11 - (sum % 11);
  let expectedDv;
  if (remainder === 11) expectedDv = "0";
  else if (remainder === 10) expectedDv = "K";
  else expectedDv = String(remainder);

  return dv === expectedDv;
}

/**
 * Formatea un RUT limpio a formato con puntos y guión
 * "13564904K" → "13.564.904-K"
 */
function formatRut(rut) {
  const clean = cleanRut(rut);
  const body = clean.slice(0, -1);
  const dv = clean.slice(-1);
  const formatted = body.replace(/\B(?=(\d{3})+(?!\d))/g, ".");
  return `${formatted}-${dv}`;
}

module.exports = { cleanRut, isValidRut, formatRut };
