# Webhook Transearch

Sistema de webhooks para automatización de procesos de Transearch Chile. Incluye generación de reportes PDF (Validación de Título) y validación de Hojas de Vida del Conductor contra el Registro Civil.

## Arquitectura

```
                         ┌─────────────────┐
                         │    Airtable      │
                         │  (Base de datos) │
                         └────────┬─────────┘
                                  │ Webhook / Trigger
                                  ▼
                         ┌─────────────────┐
                         │  Express.js API  │
                         │   (Railway)      │
                         └──┬──────┬───────┘
                            │      │
         ┌──────────────────┼──────┘
         │                  │
         ▼                  ▼                       
┌──────────────────┐ ┌──────────────────┐ ┌──────────────────┐
│ Módulo One Page  │ │  Módulo VT (PDF) │ │   Módulo HVC     │
│ - Google Slides  │ │  - pdfkit        │ │  - pdfjs-dist    │
│ - sharp          │ │  - pdf-lib       │ │  - playwright    │
│ - Inserta fotos  │ │  - Genera report │ │  - Registro Civil│
└──────────────────┘ └──────────────────┘ └──────────────────┘
```

### Stack tecnológico

| Componente | Tecnología |
|---|---|
| Runtime | Node.js 20 |
| Framework | Express.js |
| PDF generación | pdfkit + pdf-lib |
| PDF lectura | pdfjs-dist |
| Scraping | Playwright (Chromium) |
| IA (fallback) | Groq API (Llama 3.3, gratuito) |
| Hosting | Railway |
| Base de datos | Airtable |

---

## Instalación

```bash
# Clonar repositorio
git clone <repo-url>
cd webhookTest

# Instalar dependencias
npm install

# Instalar Chromium para Playwright
npx playwright install chromium

# Configurar variables de entorno
cp .env.example .env
# Editar .env con tus credenciales

# Iniciar servidor
node index.js
```

### Variables de entorno

```env
# Airtable
AIRTABLE_API_KEY=pat...
AIRTABLE_BASE_ID=app...

# Google (para insert-photo)
GOOGLE_CREDENTIALS_JSON=...
GOOGLE_SLIDES_TEMPLATE_ID=...

# Groq (opcional, fallback para PDFs escaneados)
GROQ_API_KEY=gsk_...

# Railway (automático)
RAILWAY_PUBLIC_DOMAIN=webhooktest-production-fd2a.up.railway.app
PORT=3000
```

---

## Endpoints

### 1. Validación de Título (VT)

Genera un PDF de Validación de Título con portada + documentos adjuntos + logo en encabezado.

#### `POST /webhook/generate-vt`

**Request:**

```json
{
  "nombre": "string (requerido) - Nombre completo del candidato",
  "rut": "string (requerido) - RUT del candidato",
  "cargo": "string - Cargo al que postula",
  "id": "string - ID del proceso",
  "division": "string - División de la empresa",
  "titulo": "string - Título profesional",
  "establecimiento": "string - Institución educativa",
  "contacto": "string - Contacto de verificación",
  "documentos": "string[] - URLs de documentos adjuntos",
  "recordId": "string - ID del registro en Airtable"
}
```

**Response (200):**

```json
{
  "success": true,
  "fileName": "88686-VT-María José Soto Bustos.pdf",
  "pdfUrl": "https://webhooktest-production-fd2a.up.railway.app/tmp/uuid.pdf",
  "message": "VT generada para María José Soto Bustos"
}
```

**Response (400):**

```json
{
  "error": "Faltan campos requeridos: nombre, rut"
}
```

**Response (500):**

```json
{
  "error": "Error generando VT",
  "details": "mensaje de error"
}
```

---

### 2. Validación de Hoja de Vida del Conductor (HVC)

Extrae datos de un PDF de HVC del Registro Civil chileno y verifica su autenticidad en el portal público de verificación de certificados.

#### `GET /test/validate-hvc/:nombre`

Endpoint de test manual. Valida PDFs almacenados en el servidor.

**Parámetros:**

| Parámetro | Tipo | Valores | Descripción |
|---|---|---|---|
| `nombre` | path | `maria`, `nelson` | Nombre del PDF de prueba |

**Request:**

```
GET /test/validate-hvc/maria
GET /test/validate-hvc/nelson
```

**Response (200) - Documento válido:**

```json
{
  "estado": "APROBADO",
  "datos_extraidos": {
    "folio": "500686942102",
    "codigo_verificacion": "04e55480c2d1",
    "nombre": "MARÍA BELÉN FERNÁNDEZ ROBLES",
    "rut": "17.655.295-6",
    "rut_valido": true,
    "clase_licencia": "B",
    "municipalidad": "ANTOFAGASTA",
    "fecha_emision": "22 Marzo 2026",
    "antecedentes_prn": "SIN ANTECEDENTES",
    "antecedentes_rnc": "SIN ANTECEDENTES",
    "tiene_restricciones": true,
    "anotaciones": ["08 Mayo 2025"]
  },
  "verificacion_registro_civil": {
    "valido": true,
    "mensaje": "DOCUMENTO VERIFICADO - AUTÉNTICO",
    "detalles": "El certificado es válido"
  }
}
```

**Response (200) - Documento rechazado (expirado):**

```json
{
  "estado": "RECHAZADO",
  "datos_extraidos": {
    "folio": "500581933545",
    "codigo_verificacion": "d3a8914173cf",
    "nombre": "NELSON DAVID ARRIAGADA CORTÉS",
    "rut": "13.564.904-K",
    "rut_valido": true,
    "clase_licencia": "B",
    "municipalidad": "CALERA DE",
    "fecha_emision": "21 Agosto 2024",
    "antecedentes_prn": "SIN ANTECEDENTES",
    "antecedentes_rnc": "SIN ANTECEDENTES",
    "tiene_restricciones": false,
    "anotaciones": ["08 Septiembre 2001"]
  },
  "verificacion_registro_civil": {
    "valido": false,
    "mensaje": "DOCUMENTO EXPIRADO (más de 60 días desde emisión)",
    "detalles": "No existe un certificado asociado al folio y código verificador, o bien el certificado tiene más de 60 días desde la fecha de emisión."
  }
}
```

**Response (200) - Requiere revisión:**

```json
{
  "estado": "REQUIERE REVISIÓN",
  "datos_extraidos": { "..." },
  "verificacion_registro_civil": {
    "valido": null,
    "mensaje": "REQUIERE REVISIÓN MANUAL",
    "detalles": "..."
  }
}
```

**Response (404):**

```json
{
  "error": "PDF no encontrado para \"juan\"",
  "disponibles": ["maria", "nelson"]
}
```

**Response (500):**

```json
{
  "error": "mensaje de error"
}
```

---

#### `POST /webhook/validate-license`

Endpoint para automatización desde Airtable. Descarga el PDF del registro, lo valida y escribe el resultado de vuelta.

**Request:**

```json
{
  "recordId": "string (requerido) - ID del registro en Airtable",
  "rutEsperado": "string (opcional) - RUT esperado para cruce"
}
```

**Response (200):**

```json
{
  "status": "processing",
  "recordId": "recXXXXXX"
}
```

> Nota: Este endpoint responde inmediatamente con `processing` y ejecuta la validación en background. Los resultados se escriben directamente en los campos de Airtable configurados.

---

### 3. Otros endpoints

#### `POST /insert-photo`

Inserta foto de candidato en presentación de Google Slides.

#### `GET /tmp/:id.pdf`

Sirve PDFs generados temporalmente.

---

## Contrato de datos HVC

### Campos de `datos_extraidos`

| Campo | Tipo | Descripción | Ejemplo |
|---|---|---|---|
| `folio` | `string\|null` | Número de folio del certificado | `"500686942102"` |
| `codigo_verificacion` | `string\|null` | Código de verificación (CVE) | `"04e55480c2d1"` |
| `nombre` | `string\|null` | Nombre completo del conductor | `"MARÍA BELÉN FERNÁNDEZ ROBLES"` |
| `rut` | `string\|null` | RUT en formato XX.XXX.XXX-X | `"17.655.295-6"` |
| `rut_valido` | `boolean\|null` | Validación dígito verificador | `true` |
| `clase_licencia` | `string\|null` | Última clase de licencia | `"B"` |
| `municipalidad` | `string\|null` | Municipalidad emisora | `"ANTOFAGASTA"` |
| `fecha_emision` | `string\|null` | Fecha de emisión del documento | `"22 Marzo 2026"` |
| `antecedentes_prn` | `string\|null` | Antecedentes PRN | `"SIN ANTECEDENTES"` |
| `antecedentes_rnc` | `string\|null` | Antecedentes RNC | `"SIN ANTECEDENTES"` |
| `tiene_restricciones` | `boolean` | Si tiene restricciones de licencia | `true` |
| `anotaciones` | `string[]` | Lista de fechas de anotaciones | `["08 Mayo 2025"]` |

### Campos de `verificacion_registro_civil`

| Campo | Tipo | Descripción |
|---|---|---|
| `valido` | `true\|false\|null` | `true` = auténtico, `false` = inválido/expirado, `null` = indeterminado |
| `mensaje` | `string` | Mensaje legible del resultado |
| `detalles` | `string` | Texto completo de la respuesta del Registro Civil |

### Valores posibles de `estado`

| Estado | Significado |
|---|---|
| `APROBADO` | Documento verificado como auténtico por el Registro Civil |
| `RECHAZADO` | Documento no válido o expirado (más de 60 días desde emisión) |
| `REQUIERE REVISIÓN` | No se pudo determinar automáticamente, requiere revisión humana |
| `ERROR` | Error técnico durante el procesamiento |

---

## Flujo de validación HVC

```
1. Se recibe el PDF (local o desde Airtable)
         │
2. pdfjs-dist extrae el texto del PDF (gratis, sin API)
         │
3. Regex extrae: Folio, CVE, RUT, nombre, licencias, etc.
         │
4. Si falta folio/CVE → Groq AI como fallback (gratis)
         │
5. Se valida el dígito verificador del RUT (algoritmo módulo 11)
         │
6. Playwright abre registrocivil.cl/verificacion
         │
7. Ingresa Folio + CVE → click "Consultar"
         │
8. Lee resultado: válido / inválido / expirado
         │
9. Retorna JSON con datos + resultado verificación
```

### Limitaciones

- La verificación en registrocivil.cl solo funciona hasta **60 días** después de la emisión del certificado
- PDFs escaneados (sin texto seleccionable) requieren la API de Groq como fallback
- Playwright necesita Chromium instalado (incluido en el Dockerfile)

---

## Deploy en Railway

El proyecto incluye un `Dockerfile` que instala Chromium para Playwright:

```bash
# Push a GitHub → Railway despliega automáticamente
git add .
git commit -m "feat: nuevo feature"
git push
```

Railway detecta el Dockerfile y construye la imagen con las dependencias de Chromium.
