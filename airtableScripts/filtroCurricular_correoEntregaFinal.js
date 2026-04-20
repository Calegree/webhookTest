/**
 * Airtable Automation Script — Filtro Curricular · Correo Entrega Final
 *
 * Base: Filtro Curricular (appmOtSJu26VLNgD4)
 * Trigger: Requerimientos → Estado Final = "Entrega Final"
 *
 * INPUT VARIABLES (configurar en la UI del Script action):
 *   recordId → Airtable record ID del registro que disparó el trigger
 *
 * OUTPUT:
 *   html            → cuerpo HTML del correo (usar en Gmail action)
 *   asunto          → asunto sugerido
 *   idRequerimiento → el ID del proceso (para logging / asunto)
 *   requerimiento   → nombre del cargo
 *   emailDestino    → email del especialista Codelco (lookup)
 */

const { recordId } = input.config();

const reqTable = base.getTable('Requerimientos');
const clasTable = base.getTable('Clasificación Curricular');

const req = await reqTable.selectRecordAsync(recordId, {
    fields: [
        'ID',
        'Requerimiento',
        'CV Alto',
        'CV Medio',
        'CV Bajo',
        'Sobrecalificados',
        'Clas. en Validación',
        'Email (from Especialista)',
    ],
});

if (!req) {
    throw new Error(`No se encontró el requerimiento con recordId=${recordId}`);
}

const reqId = req.getCellValueAsString('ID');
const reqNombre = req.getCellValueAsString('Requerimiento');
const cvAlto = Number(req.getCellValue('CV Alto') ?? 0);
const cvMedio = Number(req.getCellValue('CV Medio') ?? 0);
const cvBajo = Number(req.getCellValue('CV Bajo') ?? 0);
const sobrecal = Number(req.getCellValue('Sobrecalificados') ?? 0);
const enValidacion = Number(req.getCellValue('Clas. en Validación') ?? 0);
const total = cvAlto + cvMedio + cvBajo + sobrecal + enValidacion;

const emailLookup = req.getCellValue('Email (from Especialista)');
const emailDestino = Array.isArray(emailLookup) ? emailLookup.join(', ') : (emailLookup || '');

const clasQuery = await clasTable.selectRecordsAsync({
    fields: [
        'ID',
        'Nombres',
        'Apellidos',
        'Clasificación',
        'Comentarios revisión',
        'Etiquetas',
        'Candidatos TOP',
        'Referido',
    ],
});

const candidatos = clasQuery.records.filter(
    (r) => r.getCellValueAsString('ID') === reqId,
);

const CLASIF_ORDER = {
    'CV Alto': 1,
    'CV Medio': 2,
    'CV Bajo': 3,
    'CV Sobrecalificado': 4,
    'Clasificación en Validación': 5,
    'PENDIENTE': 6,
};

const sortByClasif = (a, b) => {
    const oa = CLASIF_ORDER[a.getCellValueAsString('Clasificación')] ?? 99;
    const ob = CLASIF_ORDER[b.getCellValueAsString('Clasificación')] ?? 99;
    if (oa !== ob) return oa - ob;
    return a.getCellValueAsString('Apellidos').localeCompare(b.getCellValueAsString('Apellidos'));
};

const topSi = candidatos
    .filter((r) => r.getCellValueAsString('Candidatos TOP') === 'Si')
    .sort(sortByClasif);

const CLASIF_TABLA_3 = new Set(['CV Alto', 'CV Medio', 'CV Bajo']);

const topNo = candidatos
    .filter(
        (r) =>
            r.getCellValueAsString('Candidatos TOP') !== 'Si' &&
            CLASIF_TABLA_3.has(r.getCellValueAsString('Clasificación')),
    )
    .sort(sortByClasif);

const enValList = candidatos
    .filter((r) => r.getCellValueAsString('Clasificación') === 'Clasificación en Validación')
    .sort(sortByClasif);

const nombreCompleto = (r) => {
    const nombres = r.getCellValueAsString('Nombres').trim();
    const apellidos = r.getCellValueAsString('Apellidos').trim();
    return [nombres, apellidos].filter(Boolean).join(' ');
};

const referidos = candidatos
    .filter((r) => r.getCellValueAsString('Referido') === 'Si')
    .sort(sortByClasif);

const esc = (s) =>
    String(s ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');

const nl2br = (s) => esc(s).replace(/\r?\n/g, '<br/>');

const TABLE_ATTRS = 'cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;border:1px solid #000;font-family:Arial,sans-serif;font-size:13px;margin:10px 0;"';
const TABLE_ATTRS_NESTED = 'cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;border:1px solid #000;font-family:Arial,sans-serif;font-size:13px;margin:0;"';
const TABLE_WRAP_ATTRS = 'cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;font-family:Arial,sans-serif;font-size:13px;margin:10px 0;"';
const BORDER = 'border:1px solid #000;';
const CELL_PAD = 'padding:8px 14px;';
const TH = `style="${BORDER}${CELL_PAD}background:#F4B41A;color:#000;text-align:center;font-weight:bold;"`;
const TH_TITLE = `style="border:1px solid #000;border-bottom:none;padding:10px 14px;background:#F4B41A;color:#000;text-align:center;font-weight:bold;"`;
const TD = `style="${BORDER}${CELL_PAD}vertical-align:top;"`;
const TD_CENTER = `style="${BORDER}${CELL_PAD}text-align:center;vertical-align:top;"`;
const TD_TOTAL = `style="${BORDER}${CELL_PAD}font-weight:bold;vertical-align:top;"`;
const TD_TOTAL_CENTER = `style="${BORDER}${CELL_PAD}font-weight:bold;text-align:center;vertical-align:top;"`;
const HIGHLIGHT = 'style="background:#FFF200;padding:2px 4px;font-weight:bold;"';

const tablaResumen =
    `<table ${TABLE_ATTRS}>` +
    `<tr><th ${TH}>Categoría</th><th ${TH}>Cantidad</th></tr>` +
    `<tr><td ${TD}>CV Alto</td><td ${TD_CENTER}>${cvAlto}</td></tr>` +
    `<tr><td ${TD}>CV Medio</td><td ${TD_CENTER}>${cvMedio}</td></tr>` +
    `<tr><td ${TD}>CV Bajo</td><td ${TD_CENTER}>${cvBajo}</td></tr>` +
    `<tr><td ${TD}>CV Sobrecalificados</td><td ${TD_CENTER}>${sobrecal}</td></tr>` +
    `<tr><td ${TD}>Clasificación en Validación</td><td ${TD_CENTER}>${enValidacion}</td></tr>` +
    `<tr><td ${TD_TOTAL}>Total</td><td ${TD_TOTAL_CENTER}>${total}</td></tr>` +
    `</table>`;

const renderTablaCandidatos = (titulo, registros, columnas) => {
    const colspan = columnas.length;
    const headerRow =
        `<tr>` +
        columnas.map((c) => `<th ${TH}>${esc(c.label)}</th>`).join('') +
        `</tr>`;

    const getValue = (r, c) =>
        typeof c.getValue === 'function'
            ? c.getValue(r)
            : r.getCellValueAsString(c.field);

    const bodyRows = registros.length === 0
        ? `<tr><td colspan="${colspan}" style="${BORDER}${CELL_PAD}text-align:center;font-style:italic;color:#666;">Sin registros</td></tr>`
        : registros
            .map((r) => {
                const cells = columnas
                    .map((c) => `<td ${TD}>${nl2br(getValue(r, c))}</td>`)
                    .join('');
                return `<tr>${cells}</tr>`;
            })
            .join('');

    if (!titulo) {
        return `<table ${TABLE_ATTRS}>` + headerRow + bodyRows + `</table>`;
    }

    const nestedDataTable = `<table ${TABLE_ATTRS_NESTED}>` + headerRow + bodyRows + `</table>`;

    return (
        `<table ${TABLE_WRAP_ATTRS}>` +
        `<tr><td ${TH_TITLE}>${esc(titulo)}</td></tr>` +
        `<tr><td style="padding:0;border:0;">${nestedDataTable}</td></tr>` +
        `</table>`
    );
};

const columnasTOP = [
    { label: 'Nombre', getValue: nombreCompleto },
    { label: 'Clasificación', field: 'Clasificación' },
    { label: 'Comentarios revisión', field: 'Comentarios revisión' },
];

const columnasNoTOP = columnasTOP;

const columnasValidacion = [
    { label: 'Nombre', getValue: nombreCompleto },
    { label: 'Clasificación', field: 'Clasificación' },
    { label: 'Etiquetas', field: 'Etiquetas' },
];

const tablaTOP = renderTablaCandidatos(`Lista de Candidatos TOP ID ${reqId}`, topSi, columnasTOP);
const tablaNoTOP = renderTablaCandidatos(null, topNo, columnasNoTOP);
const tablaValidacion = renderTablaCandidatos(null, enValList, columnasValidacion);

const observacionesHtml = referidos.length === 0
    ? `<div style="margin:6px 0 0 20px;font-style:italic;color:#666;">Sin candidatos referidos.</div>`
    : (
        `<div style="margin:6px 0 0 20px;">- Estatus candidatos referidos:</div>` +
        `<ul style="margin:4px 0 0 40px;padding:0;list-style-type:circle;">` +
        referidos
            .map(
                (r) =>
                    `<li style="margin:2px 0;"><strong>${esc(nombreCompleto(r))}: ${esc(r.getCellValueAsString('Clasificación'))}</strong></li>`,
            )
            .join('') +
        `</ul>`
    );

const html =
    `<div style="font-family:Arial,sans-serif;font-size:13px;color:#000;line-height:1.5;">` +
    `<p>Hola,</p>` +
    `<p>Espero que te encuentres bien.</p>` +
    `<p>Te comento que ya se encuentra terminada la revisión del proceso <strong>${esc(reqNombre)} (${esc(reqId)})</strong> y te envío a continuación el detalle de clasificación:</p>` +
    tablaResumen +
    `<p><span ${HIGHLIGHT}>Observaciones:</span></p>` +
    observacionesHtml +
    tablaTOP +
    tablaNoTOP +
    tablaValidacion +
    `<p>Saludos,</p>` +
    `</div>`;

output.set('html', html);
output.set('asunto', `Entrega Final — ${reqNombre} (ID ${reqId})`);
output.set('idRequerimiento', reqId);
output.set('requerimiento', reqNombre);
output.set('emailDestino', emailDestino);
