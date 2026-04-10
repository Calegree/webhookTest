// Registro de universidades chilenas con sus validadores online
// Cada entrada define: URL, campos requeridos, selectores de Playwright

const UNIVERSIDADES = {
  unab: {
    nombre: "Universidad Andrés Bello",
    aliases: ["UNAB", "U. ANDRÉS BELLO", "UNIVERSIDAD ANDRES BELLO", "ANDRÉS BELLO"],
    tipo: "online",
    url: "https://certificados.unab.cl",
    campos: ["folio", "id_alumno"],
    selectores: {
      folio: 'input[name="folio"]',
      id_alumno: 'input[name="rut"]',
      submit: 'input[name="boton"]',
    },
  },

  uta: {
    nombre: "Universidad de Tarapacá",
    aliases: ["UTA", "U. DE TARAPACÁ", "UNIVERSIDAD DE TARAPACA", "TARAPACÁ"],
    tipo: "online",
    url: "https://zapahuira.uta.cl/vd",
    campos: ["codigo"],
    selectores: {
      codigo: "input[type=text]",
      submit: "button[type=submit], input[type=submit]",
    },
  },

  ucv: {
    nombre: "Universidad Católica de Valparaíso",
    aliases: ["UCV", "PUCV", "U. CATÓLICA DE VALPARAÍSO", "PONTIFICIA UNIVERSIDAD CATÓLICA DE VALPARAÍSO", "CATÓLICA DE VALPARAÍSO"],
    tipo: "online",
    url: "https://certificados.ucv.cl",
    campos: ["numero", "codigo"],
    selectores: {
      numero: 'input[name="numero"], input[placeholder*="mero"]',
      codigo: 'input[name="codigo"], input[placeholder*="digo"]',
      submit: 'button[type=submit], input[type=submit]',
    },
  },

  udla: {
    nombre: "Universidad De Las Américas",
    aliases: ["UDLA", "U. DE LAS AMÉRICAS", "UNIVERSIDAD DE LAS AMERICAS", "LAS AMÉRICAS"],
    tipo: "online",
    url: "https://certificados.udla.cl/Validar",
    campos: ["folio", "id_alumno"],
    selectores: {
      folio: 'input[name="folio"], input[placeholder*="olio"]',
      id_alumno: 'input[name="id_alumno"], input[placeholder*="lumno"], input[placeholder*="ID"]',
      submit: 'button[type=submit], input[type=submit]',
    },
  },

  iacc: {
    nombre: "Instituto Profesional IACC",
    aliases: ["IACC", "IP IACC", "INSTITUTO PROFESIONAL IACC"],
    tipo: "online",
    url: "https://portales.iacc.cl/certificados",
    campos: ["codigo"],
    selectores: {
      codigo: 'input[type=text], input[name="codigo"]',
      submit: 'button[type=submit], input[type=submit]',
    },
  },

  uac: {
    nombre: "Universidad de Aconcagua",
    aliases: ["UAC", "U. DE ACONCAGUA", "UNIVERSIDAD DE ACONCAGUA", "ACONCAGUA"],
    tipo: "online",
    url: "https://certificados.uac.cl",
    campos: ["codigo"],
    selectores: {
      codigo: 'input[type=text], input[name="codigo"]',
      submit: 'button[type=submit], input[type=submit]',
    },
  },

};

/**
 * Detecta la universidad a partir del texto del PDF
 */
function detectarUniversidad(texto) {
  const upper = texto.toUpperCase();
  for (const [key, uni] of Object.entries(UNIVERSIDADES)) {
    for (const alias of uni.aliases) {
      if (upper.includes(alias.toUpperCase())) {
        return { key, ...uni };
      }
    }
  }
  return null;
}

/**
 * Obtiene una universidad por clave
 */
function getUniversidad(key) {
  return UNIVERSIDADES[key] ? { key, ...UNIVERSIDADES[key] } : null;
}

/**
 * Lista todas las universidades disponibles
 */
function listarUniversidades() {
  return Object.entries(UNIVERSIDADES).map(([key, uni]) => ({
    key,
    nombre: uni.nombre,
    tipo: uni.tipo,
    url: uni.url,
    campos: uni.campos,
  }));
}

module.exports = { UNIVERSIDADES, detectarUniversidad, getUniversidad, listarUniversidades };
