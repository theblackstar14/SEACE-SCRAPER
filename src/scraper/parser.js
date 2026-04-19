import { load } from "cheerio";

export function parseTable(html) {
  const $ = load(html);

  const resultados = [];

  $("#tbBuscador\\:idFormBuscarProceso\\:dtProcesos tbody tr").each((i, el) => {
    const cols = $(el).find("td");

    if (cols.length < 7) return;

    // extraer nidProceso/nidConvocatoria desde el onclick del link de detalle
    let nidProceso = "";
    let nidConvocatoria = "";
    $(el).find("a").each((_, a) => {
      const oc = $(a).attr("onclick") || "";
      if (!nidProceso) {
        const mP = oc.match(/'nidProceso'\s*:\s*'([^']+)'/);
        if (mP) nidProceso = mP[1];
      }
      if (!nidConvocatoria) {
        const mC = oc.match(/'nidConvocatoria'\s*:\s*'([^']+)'/);
        if (mC) nidConvocatoria = mC[1];
      }
    });
    if (!nidProceso && i === 0) {
      console.log("⚠️ row 0 sin nidProceso. HTML:", $(el).html()?.slice(0, 500));
    }

    const fila = {
      nro: $(cols[0]).text().trim(),
      entidad: $(cols[1]).text().trim(),
      fecha_publicacion: $(cols[2]).text().trim(),
      nomenclatura: $(cols[3]).text().trim(),
      etapa: $(cols[4]).text().trim(),
      objeto: $(cols[5]).text().trim(),
      descripcion: $(cols[6]).text().trim(),
      nidProceso,
      nidConvocatoria,
    };

    resultados.push(fila);
  });

  return resultados;
}