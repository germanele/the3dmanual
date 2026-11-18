/**
 * =============================================================================
 * MOTOR DE CÁLCULO — v2
 * Costos, escalas, cotizaciones y combos para impresión 3D (Uruguay)
 * -----------------------------------------------------------------------------
 * Implementación propia de las fórmulas de negocio. Mantiene la semántica:
 * redondeo estilo Excel, tiempos hh:mm, prorrateo por lote, semáforo N=1,
 * comparativa de 1 unidad, punto de equilibrio y optimización de combos.
 * =============================================================================
 */

const Calc = (() => {
  'use strict';

  const PARAMETROS_POR_DEFECTO = {
    energia_kwh: 11,
    desgaste_maquina_h: 10,
    tiempo_manual_h: 250,
    precio_plastico_usd_kg: 15,
    consumo_maquina_w: 110,
    factor_defecto: 2.5,
    cotizacion_dolar: 41.5
  };

  const ESCALAS_OBJETIVO = [1, 3, 5, 10, 20];

  /* ---------------------------- utilidades -------------------------------- */

  /** Redondeo "Excel" (half-up simétrico, tolerando error de coma flotante). */
  function round(valor, decimales = 2) {
    if (!Number.isFinite(valor)) return 0;
    const factor = Math.pow(10, decimales);
    return valor >= 0
      ? Math.floor(valor * factor + 0.5 + 1e-12) / factor
      : Math.ceil(valor * factor - 0.5 - 1e-12) / factor;
  }

  /** REDONDEAR ARRIBA estilo Excel, usado para el punto de equilibrio. */
  function roundUp(valor, decimales = 0) {
    if (!Number.isFinite(valor)) return 0;
    const factor = Math.pow(10, decimales);
    return valor >= 0
      ? Math.ceil(valor * factor - 1e-12) / factor
      : Math.floor(valor * factor + 1e-12) / factor;
  }

  const normalizar = valor => String(valor ?? '').trim().toLowerCase();

  /** Horas decimales → "hh:mm" (sin tope de horas: 390 h → "390:00"). */
  function aReloj(horas) {
    if (!Number.isFinite(horas) || horas <= 0) return '00:00';
    const minutos = Math.round(horas * 60);
    const hh = Math.floor(minutos / 60);
    const mm = minutos % 60;
    return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
  }

  /** "hh:mm" o "hhmm" → horas decimales. Devuelve null si está vacío, NaN si es inválido. */
  function aHoras(texto) {
    if (texto === null || texto === undefined) return null;
    const limpio = String(texto).trim();
    if (!limpio) return null;

    const conDosPuntos = limpio.match(/^(\d+):([0-5]?\d)$/);
    if (conDosPuntos) {
      const hh = parseInt(conDosPuntos[1], 10);
      const mm = parseInt(conDosPuntos[2], 10);
      return mm > 59 ? NaN : hh + mm / 60;
    }

    const compacto = limpio.match(/^(\d{2,4})([0-5]\d)$/);
    if (compacto && !limpio.includes('.') && !limpio.includes(',')) {
      return parseInt(compacto[1], 10) + parseInt(compacto[2], 10) / 60;
    }

    return NaN;
  }

  const IVA = 0.22;

  /** Aplica el IVA uruguayo (22%) cuando el pedido es con factura. */
  function conIVA(subtotal, conFactura) {
    const base = round(Number(subtotal) || 0, 2);
    if (!conFactura) return { subtotal: base, iva: 0, total: base };
    const iva = round(base * IVA, 2);
    return { subtotal: base, iva, total: round(base + iva, 2) };
  }

  function normalizarReloj(texto) {
    const h = aHoras(texto);
    if (h === null) return '';
    if (!Number.isFinite(h) || h < 0) return null;
    return aReloj(h);
  }

  /** Convierte las filas de parametros_base en un objeto de parámetros numéricos. */
  function leerParametros(filas) {
    const params = { ...PARAMETROS_POR_DEFECTO };
    for (const fila of filas || []) {
      if (Object.prototype.hasOwnProperty.call(params, fila.clave)) {
        params[fila.clave] = Number(fila.valor);
      }
    }
    return params;
  }

  /** Compara dos artículos por id numérico o, en su defecto, por código. */
  function mismoArticulo(entidad, clave) {
    if (clave === null || clave === undefined || clave === '') return false;
    const claveTxt = String(clave);
    if (entidad.articuloId != null && /^\d+$/.test(claveTxt)) {
      return String(entidad.articuloId) === claveTxt;
    }
    return normalizar(entidad.codigo) === normalizar(claveTxt);
  }

  /* --------------------------- costos base -------------------------------- */

  /**
   * Costo base unitario = plástico + electricidad + desgaste + mano de obra.
   * Los tiempos de lote se prorratean entre las unidades.
   */
  function costoUnitario(cantidad, gramosLote, impresionLoteH, preparacionLoteH, postUnitH, p) {
    if (!cantidad || cantidad < 1) return 0;

    const gramosUnit = gramosLote / cantidad;
    const impUnit = impresionLoteH / cantidad;
    const prepUnit = preparacionLoteH / cantidad;

    const plastico = (gramosUnit / 1000) * p.precio_plastico_usd_kg * p.cotizacion_dolar;
    const electricidad = impUnit * (p.consumo_maquina_w / 1000) * p.energia_kwh;
    const desgaste = impUnit * p.desgaste_maquina_h;
    const manoObra = (prepUnit + postUnitH) * p.tiempo_manual_h;

    return round(plastico + electricidad + desgaste + manoObra, 2);
  }

  /**
   * Resuelve los datos activos para un (artículo, cantidad):
   *   1) medición exacta → real
   *   2) carga manual del cotizador → real (aún no guardada)
   *   3) medición de otra cantidad → estimado lineal (preparación no se escala)
   *   4) sin historial → ceros
   */
  function resolverMedicion(articuloClave, cantidad, mediciones, cargaManual = null) {
    const cant = Math.max(1, Math.floor(Number(cantidad) || 1));

    const exacta = (mediciones || []).find(
      m => mismoArticulo(m, articuloClave) && Number(m.cantidad) === cant
    );
    if (exacta) {
      return {
        esReal: true,
        origen: '✅ Real (Historial BambuStudio)',
        estado: '✅ Medición real cargada (BambuStudio)',
        fecha: exacta.fecha,
        gramos: Number(exacta.gramos),
        impresionH: Number(exacta.impresionH),
        preparacionH: Number(exacta.preparacionH),
        postUnitH: Number(exacta.postUnitH)
      };
    }

    if (cargaManual && Number(cargaManual.gramos) > 0 && Number(cargaManual.impresionH) > 0) {
      const referencia = (mediciones || []).find(m => mismoArticulo(m, articuloClave));
      const prepManual =
        cargaManual.preparacionH !== null &&
        Number.isFinite(Number(cargaManual.preparacionH)) &&
        Number(cargaManual.preparacionH) >= 0
          ? Number(cargaManual.preparacionH)
          : (referencia ? Number(referencia.preparacionH) : 0);

      return {
        esReal: true,
        origen: '✅ Real (Carga Manual Nueva)',
        estado: '✅ Carga manual lista para guardar',
        fecha: new Date().toISOString().slice(0, 10),
        gramos: Number(cargaManual.gramos),
        impresionH: Number(cargaManual.impresionH),
        preparacionH: prepManual,
        postUnitH: referencia ? Number(referencia.postUnitH) : 0
      };
    }

    const referencia = (mediciones || []).find(m => mismoArticulo(m, articuloClave));
    if (referencia) {
      const factorEscala = cant / Number(referencia.cantidad);
      return {
        esReal: false,
        origen: '⚠️ Estimado Preliminar (Falta medir en Slicer)',
        estado: '⚠️ Cantidad no registrada: cargá Gramos y Tiempo de BambuStudio',
        fecha: referencia.fecha,
        gramos: Number(referencia.gramos) * factorEscala,
        impresionH: Number(referencia.impresionH) * factorEscala,
        preparacionH: Number(referencia.preparacionH),
        postUnitH: Number(referencia.postUnitH)
      };
    }

    return {
      esReal: false,
      origen: '⚠️ Sin mediciones en historial',
      estado: '⚠️ Artículo sin mediciones registradas',
      fecha: new Date().toISOString().slice(0, 10),
      gramos: 0,
      impresionH: 0,
      preparacionH: 0,
      postUnitH: 0
    };
  }

  /* ------------------------ registro de costos ---------------------------- */

  /** Calcula todas las columnas derivadas de una fila del catálogo. */
  function calcularFila(fila, mediciones, registroCompleto, p) {
    const cantidad = Math.max(1, Math.floor(Number(fila.cantidad) || 1));
    const factor = Number(fila.factor) || p.factor_defecto;
    const datos = resolverMedicion(fila.articuloId, cantidad, mediciones);

    const tiempoTotalH = datos.impresionH / cantidad + datos.preparacionH / cantidad + datos.postUnitH;
    const costoUnit = costoUnitario(cantidad, datos.gramos, datos.impresionH, datos.preparacionH, datos.postUnitH, p);
    const costoLote = round(costoUnit * cantidad, 2);
    const precioUnit = round(costoUnit * factor, 2);
    const gananciaUnit = round(precioUnit - costoUnit, 2);

    // Semáforo N=1: ¿tenemos costo confiable de una pieza suelta?
    const medicion1 = (mediciones || []).find(
      m => mismoArticulo(m, fila.articuloId) && Number(m.cantidad) === 1
    );
    let costo1u = 0;
    let medido1u = false;

    if (medicion1) {
      costo1u = costoUnitario(1, medicion1.gramos, medicion1.impresionH,
                              medicion1.preparacionH, medicion1.postUnitH, p);
      medido1u = true;
    } else {
      const registro1 = (registroCompleto || []).find(
        r => mismoArticulo(r, fila.articuloId) && Number(r.cantidad) === 1
      );
      if (registro1 && cantidad !== 1) {
        const d1 = resolverMedicion(registro1.articuloId, 1, mediciones);
        costo1u = costoUnitario(1, d1.gramos, d1.impresionH, d1.preparacionH, d1.postUnitH, p);
        medido1u = true;
      } else {
        // Piso mínimo: se agrega la preparación que se ahorra al hacer lote.
        costo1u = round(costoUnit + datos.preparacionH * (1 - 1 / cantidad) * p.tiempo_manual_h, 2);
        medido1u = cantidad === 1 && datos.esReal;
      }
    }

    const pe = precioUnit > 0 ? roundUp(costoLote / precioUnit, 0) : 0;

    return {
      id: fila.id,
      fecha: datos.fecha,
      articuloId: fila.articuloId,
      codigo: fila.codigo,
      nombre: fila.nombre,
      etiqueta: `${fila.codigo} | ${fila.nombre}`,
      cantidad,
      gramosLote: round(datos.gramos, 2),
      impresionLoteH: datos.impresionH,
      preparacionLoteH: datos.preparacionH,
      postUnitH: datos.postUnitH,
      tiempoTotalH,
      impresionHHMM: aReloj(datos.impresionH),
      preparacionHHMM: aReloj(datos.preparacionH),
      postHHMM: aReloj(datos.postUnitH),
      tiempoTotalHHMM: aReloj(tiempoTotalH),
      costoUnit,
      costoLote,
      factor,
      precioUnit,
      gananciaUnit,
      margen: precioUnit > 0 ? gananciaUnit / precioUnit : 0,
      costo1u,
      precio1u: round(costo1u * factor, 2),
      medido1u,
      realLote: datos.esReal,
      peUnidades: pe,
      puntoEquilibrio: `${pe} de ${cantidad} u.`
    };
  }

  /* ------------------------------ cotizador ------------------------------- */

  /** Cotización dinámica para una cantidad + factor, con tabla de escalas. */
  function cotizar(entrada, mediciones, p) {
    const cantidad = Math.max(1, Math.floor(Number(entrada.cantidad) || 1));
    const factor = Number(entrada.factor) || p.factor_defecto;

    const datos = resolverMedicion(entrada.articuloId, cantidad, mediciones, {
      gramos: entrada.gramosManual,
      impresionH: entrada.impManualH,
      preparacionH: entrada.prepManualH
    });

    const prepUnitH = datos.preparacionH / cantidad;
    const tiempoUnitH = datos.impresionH / cantidad + prepUnitH + datos.postUnitH;
    const tiempoLoteH = tiempoUnitH * cantidad;

    const costoUnit = costoUnitario(cantidad, datos.gramos, datos.impresionH, datos.preparacionH, datos.postUnitH, p);
    const costoLote = round(costoUnit * cantidad, 2);
    const precioUnit = round(costoUnit * factor, 2);
    const precioLote = round(precioUnit * cantidad, 2);
    const gananciaUnit = round(precioUnit - costoUnit, 2);

    // Comparativa: ¿cuánto costaría vender 1 unidad suelta?
    const medicion1 = (mediciones || []).find(
      m => mismoArticulo(m, entrada.articuloId) && Number(m.cantidad) === 1
    );
    let compVenta1u;
    if (medicion1) {
      const c1 = costoUnitario(1, medicion1.gramos, medicion1.impresionH,
                               medicion1.preparacionH, medicion1.postUnitH, p);
      compVenta1u = round(c1 * factor, 2);
    } else {
      compVenta1u = round((costoUnit + prepUnitH * (cantidad - 1) * p.tiempo_manual_h) * factor, 2);
    }

    const pe = precioUnit > 0 ? roundUp(costoLote / precioUnit, 0) : 0;

    const escalas = ESCALAS_OBJETIVO.map(n => {
      const d = resolverMedicion(entrada.articuloId, n, mediciones);
      const prepPieza = round((d.preparacionH / n) * p.tiempo_manual_h, 2);
      const cUnit = costoUnitario(n, d.gramos, d.impresionH, d.preparacionH, d.postUnitH, p);
      const pUnit = round(cUnit * factor, 2);
      const cLote = round(cUnit * n, 2);
      const peEsc = pUnit > 0 ? roundUp(cLote / pUnit, 0) : 0;
      return {
        unidades: n,
        esReal: d.esReal,
        origen: d.esReal ? '✅ Real' : '⚠️ Estimado',
        prepPieza,
        costoUnit: cUnit,
        precioUnit: pUnit,
        costoLote: cLote,
        puntoEquilibrio: `${peEsc} de ${n} u.`
      };
    });

    return {
      articuloId: entrada.articuloId,
      codigo: entrada.codigo,
      nombre: entrada.nombre,
      cantidad,
      factor,
      esReal: datos.esReal,
      origen: datos.origen,
      estado: datos.estado,
      gramosActivos: round(datos.gramos, 2),
      impresionActivaH: datos.impresionH,
      impresionActivaHHMM: aReloj(datos.impresionH),
      prepUnitH,
      prepUnitHHMM: aReloj(prepUnitH),
      postUnitH: datos.postUnitH,
      postUnitHHMM: aReloj(datos.postUnitH),
      tiempoUnitH,
      tiempoUnitHHMM: aReloj(tiempoUnitH),
      tiempoLoteHHMM: aReloj(tiempoLoteH),
      costoUnit,
      costoLote,
      precioUnit,
      precioLote,
      gananciaUnit,
      gananciaLote: round(gananciaUnit * cantidad, 2),
      compVenta1u,
      puntoEquilibrio: `${pe} de ${cantidad} u.`,
      escalas
    };
  }

  /* ------------------------------- combos --------------------------------- */

  /**
   * Arma 4 opciones de combo para un presupuesto:
   *   Opción 1 equilibrada, Opción 2 máxima cantidad, Opción 3 máxima ganancia
   *   y el armado manual del usuario.
   */
  function calcularCombos(presupuestoCliente, factorGlobal, lineas, filasCalculadas, mediciones, p) {
    const presupuesto = Math.max(0, Number(presupuestoCliente) || 0);

    const items = [];
    lineas.forEach((linea, idx) => {
      if (!linea || !linea.articuloId) return;
      const fila = (filasCalculadas || []).find(r => mismoArticulo(r, linea.articuloId));
      if (!fila) return;

      const factorAplicado = factorGlobal === 'Según Registro de Costos'
        ? fila.factor
        : Number(factorGlobal);

      const gramosUnit = fila.gramosLote / fila.cantidad;
      const impUnit = fila.impresionLoteH / fila.cantidad;

      // Coste variable por pieza + coste fijo de preparación del lote.
      const cVar =
        (gramosUnit / 1000) * p.precio_plastico_usd_kg * p.cotizacion_dolar +
        (p.consumo_maquina_w / 1000) * impUnit * p.energia_kwh +
        impUnit * p.desgaste_maquina_h +
        fila.postUnitH * p.tiempo_manual_h;
      const cFij = fila.preparacionLoteH * p.tiempo_manual_h;

      items.push({
        slot: idx,
        articuloId: fila.articuloId,
        codigo: fila.codigo,
        nombre: fila.nombre,
        fila,
        factorAplicado,
        costoBase1u: fila.costo1u,
        precioRef1u: round(fila.costo1u * factorAplicado, 2),
        cVar,
        cFij,
        pVar: cVar * factorAplicado,
        pFij: cFij * factorAplicado,
        gVar: (cVar * factorAplicado) - cVar,
        op1: 0, op2: 0, op3: 0,
        manual: Math.max(0, Math.floor(Number(linea.manualCant) || 0))
      });
    });

    if (!items.length) return { items: [], opciones: [] };

    const sumaPVar = items.reduce((a, x) => a + x.pVar, 0);
    const sumaPFij = items.reduce((a, x) => a + x.pFij, 0);
    const disponible = Math.max(0, presupuesto - sumaPFij);
    const base = sumaPVar > 0 ? Math.floor(disponible / sumaPVar) : 0;

    // Opción 1: reparto parejo y sobrante a quienes pueden absorberlo.
    let resto = disponible - base * sumaPVar;
    for (const item of items) {
      if (resto >= item.pVar - 1e-9) {
        item.op1 = base + 1;
        resto -= item.pVar;
      } else {
        item.op1 = base;
      }
    }

    // Opción 2: ponderación inversa al cuadrado → favorece piezas baratas.
    const pesos2 = items.reduce((a, x) => a + (x.pVar > 0 ? 1 / (x.pVar * x.pVar) : 0), 0);
    for (const item of items) {
      const w = item.pVar > 0 ? 1 / (item.pVar * item.pVar) : 0;
      item.base2 = pesos2 > 0 && item.pVar > 0
        ? Math.max(1, Math.floor((disponible * (w / pesos2)) / item.pVar))
        : 0;
    }
    resto = Math.max(0, disponible - items.reduce((a, x) => a + x.base2 * x.pVar, 0));
    for (const item of [...items].sort((a, b) => (a.pVar - b.pVar) || (a.slot - b.slot))) {
      const extra = item.pVar > 0 ? Math.floor(resto / item.pVar) : 0;
      item.op2 = item.base2 + extra;
      resto -= extra * item.pVar;
    }

    // Opción 3: ponderación por ganancia al cuadrado → favorece piezas rentables.
    const pesos3 = items.reduce((a, x) => a + x.gVar * x.gVar, 0);
    for (const item of items) {
      const w = item.gVar * item.gVar;
      item.base3 = pesos3 > 0 && item.pVar > 0
        ? Math.max(1, Math.floor((disponible * (w / pesos3)) / item.pVar))
        : 0;
    }
    resto = Math.max(0, disponible - items.reduce((a, x) => a + x.base3 * x.pVar, 0));
    for (const item of [...items].sort((a, b) => (b.gVar - a.gVar) || (a.slot - b.slot))) {
      const extra = item.pVar > 0 ? Math.floor(resto / item.pVar) : 0;
      item.op3 = item.base3 + extra;
      resto -= extra * item.pVar;
    }

    /** Evalúa una distribución de cantidades y produce la fila de resultado. */
    function evaluar(nombre, clave) {
      const partes = [];
      let totalPiezas = 0;
      let precioVenta = 0;
      let costoProduccion = 0;
      let tiempoTotal = 0;
      let faltaMedir = false;

      for (const item of items) {
        const cant = item[clave];
        if (cant <= 0) continue;

        totalPiezas += cant;
        partes.push(`${item.nombre} (${item.codigo}) x${cant}`);

        const filaReg = filasCalculadas.find(r => mismoArticulo(r, item.articuloId) && r.cantidad === cant);
        const med = (mediciones || []).find(m => mismoArticulo(m, item.articuloId) && Number(m.cantidad) === cant);

        let costoLote;
        if (filaReg) {
          costoLote = filaReg.costoLote;
        } else if (med) {
          const cU = costoUnitario(cant, med.gramos, med.impresionH, med.preparacionH, med.postUnitH, p);
          costoLote = round(cU * cant, 2);
        } else {
          // Sin lote medido: estimación lineal (marca ámbar).
          faltaMedir = true;
          const gramosUnit = item.fila.gramosLote / item.fila.cantidad;
          const impUnit = item.fila.impresionLoteH / item.fila.cantidad;
          const material = ((gramosUnit * cant) / 1000) * p.precio_plastico_usd_kg * p.cotizacion_dolar;
          const energia = (p.consumo_maquina_w / 1000) * (impUnit * cant) * p.energia_kwh;
          const desgaste = (impUnit * cant) * p.desgaste_maquina_h;
          const manoObra = (item.fila.preparacionLoteH + item.fila.postUnitH * cant) * p.tiempo_manual_h;
          costoLote = round(material + energia + desgaste + manoObra, 2);
        }

        precioVenta += item.factorAplicado * costoLote;
        costoProduccion += costoLote;
        tiempoTotal += cant * item.fila.tiempoTotalH;
      }

      const venta = round(precioVenta, 2);
      const costo = round(costoProduccion, 2);
      return {
        nombre,
        clave,
        composicion: partes.length ? partes.join(', ') : 'Sin artículos seleccionados',
        totalPiezas,
        precioVenta: venta,
        costoProduccion: costo,
        gananciaNeta: round(venta - costo, 2),
        saldo: round(presupuesto - venta, 2),
        tiempoTotalH: tiempoTotal,
        tiempoTotalHHMM: aReloj(tiempoTotal),
        esReal: totalPiezas > 0 && !faltaMedir,
        origen: totalPiezas === 0
          ? '— Sin artículos'
          : (faltaMedir ? '⚠️ Estimado Preliminar (Falta medir lote en Slicer)' : '✅ Real (Historial BambuStudio)')
      };
    }

    return {
      items,
      opciones: [
        evaluar('Opción 1 (Equilibrada)', 'op1'),
        evaluar('Opción 2 (Máx. Cantidad)', 'op2'),
        evaluar('Opción 3 (Máx. Ganancia)', 'op3'),
        evaluar('Tu Armado Manual', 'manual')
      ]
    };
  }

  return {
    round,
    roundUp,
    aReloj,
    aHoras,
    normalizarReloj,
    IVA,
    conIVA,
    leerParametros,
    costoUnitario,
    resolverMedicion,
    calcularFila,
    cotizar,
    calcularCombos
  };
})();
