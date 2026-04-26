// Selectores PrimeFaces SEACE. Confirmados con HTML real 2026-04.

export const SEL = {
  // navegación
  tabBuscador: "a[href='#tbBuscador\\:tab1']",

  // filtros del form
  objetoDropdown: "#tbBuscador\\:idFormBuscarProceso\\:j_idt188", // select one menu "Objeto de Contratación"
  objetoLabel: "#tbBuscador\\:idFormBuscarProceso\\:j_idt188_label",
  objetoPanel: "#tbBuscador\\:idFormBuscarProceso\\:j_idt188_panel",

  anioConvocatoria: "#tbBuscador\\:idFormBuscarProceso\\:j_idt198", // año (requerido)
  versionSeace: "#tbBuscador\\:idFormBuscarProceso\\:j_idt192", // "Seace 3" default

  // búsqueda avanzada (fieldset colapsable)
  avanzadaToggle: "#tbBuscador\\:idFormBuscarProceso\\:fieldsetAvanzada .ui-fieldset-toggler, " +
                   "#tbBuscador\\:idFormBuscarProceso legend.ui-fieldset-legend",
  fechaInicioInput: "#tbBuscador\\:idFormBuscarProceso\\:dfechaInicio_input",
  fechaFinInput: "#tbBuscador\\:idFormBuscarProceso\\:dfechaFin_input",

  // acción buscar
  btnBuscar: "#tbBuscador\\:idFormBuscarProceso\\:btnBuscarSelToken",

  // resultados
  resultsPanel: "#tbBuscador\\:idFormBuscarProceso\\:pnlGrdResultadosProcesos",
  resultsTable: "#tbBuscador\\:idFormBuscarProceso\\:dtProcesos",
  resultsHead: "#tbBuscador\\:idFormBuscarProceso\\:dtProcesos thead",
  resultsRows: "#tbBuscador\\:idFormBuscarProceso\\:dtProcesos tbody tr",
  paginatorInfo: "#tbBuscador\\:idFormBuscarProceso\\:dtProcesos_paginator_bottom .ui-paginator-current",
  paginatorNext: "#tbBuscador\\:idFormBuscarProceso\\:dtProcesos_paginator_bottom .ui-paginator-next:not(.ui-state-disabled)",
  paginatorRpp: "#tbBuscador\\:idFormBuscarProceso\\:dtProcesos_paginator_bottom .ui-paginator-rpp-options",

  // ficha
  fichaBtn: "a:has(img[src*='fichaSeleccion'])",
  fichaReady: "td:has-text('Entidad Convocante')",

  // descargas
  descargaAnchor: "a[onclick*='descargaDocGeneral']",
};

export const T = {
  goto: 60_000,
  selector: 60_000,
  results: 25_000,
  ficha: 20_000,
  download: 60_000,
};

// valores válidos del dropdown "Objeto de Contratación"
export const OBJETO = {
  BIEN: "Bien",
  SERVICIO: "Servicio",
  CONSULTORIA: "Consultoría",
  OBRA: "Obra",
};
