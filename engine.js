/**
 * ============================================================================
 * MOTOR DE CÁLCULO Y LÓGICA DE NEGOCIO (Conversión exacta de fórmulas Excel)
 * Gestión Impresión 3D - Costos y Combos (Uruguay)
 * ============================================================================
 */

const Engine3D = (() => {
  function excelRound(val, decimals = 2) {
    if (!Number.isFinite(val)) return 0;
    const factor = Math.pow(10, decimals);
    if (val >= 0) {
      return Math.floor(val * factor + 0.5 + 1e-12) / factor;
    }
    return Math.ceil(val * factor - 0.5 - 1e-12) / factor;
  }

  function excelRoundUp(val, decimals = 0) {
    if (!Number.isFinite(val)) return 0;
    const factor = Math.pow(10, decimals);
    if (val >= 0) {
      return Math.ceil(val * factor - 1e-12) / factor;
    }
    return Math.floor(val * factor + 1e-12) / factor;
  }

  function normStr(s) {
    return String(s || '').trim().toLowerCase();
  }

  function hoursToHHMM(hours) {
    if (!Number.isFinite(hours) || hours <= 0) return '00:00';
    const totalMinutes = Math.round(hours * 60);
    const hh = Math.floor(totalMinutes / 60);
    const mm = totalMinutes % 60;
    return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
  }

  function hhmmToHours(str) {
    if (str === null || str === undefined) return null;
    const clean = String(str).trim();
    if (!clean) return null;

    const match = clean.match(/^(\d+):([0-5]?\d)$/);
    if (match) {
      const hh = parseInt(match[1], 10);
      const mm = parseInt(match[2], 10);
      if (mm > 59) return NaN;
      return hh + (mm / 60.0);
    }

    const compact = clean.match(/^(\d{2,4})([0-5]\d)$/);
    if (compact && !clean.includes('.') && !clean.includes(',')) {
      const hh = parseInt(compact[1], 10);
      const mm = parseInt(compact[2], 10);
      if (mm <= 59) return hh + (mm / 60.0);
    }

    return NaN;
  }

  function normalizeHHMM(str) {
    const h = hhmmToHours(str);
    if (h === null) return '';
    if (!Number.isFinite(h) || h < 0) return null;
    return hoursToHHMM(h);
  }

  function mapParametros(paramRows) {
    const p = {
      energia_kwh: 11.0,
      desgaste_maquina_h: 10.0,
      tiempo_manual_h: 250.0,
      precio_plastico_usd_kg: 15.0,
      consumo_maquina_w: 110.0,
      factor_defecto: 2.5,
      cotizacion_dolar: 41.5
    };
    for (const row of paramRows) {
      if (row.clave in p) {
        p[row.clave] = Number(row.valor);
      }
    }
    return p;
  }

  function calcularCostoBaseUnitario(cantidad, gramosLote, impLoteH, prepLoteH, postUnitH, params) {
    if (!cantidad || cantidad < 1) return 0;
    const gramosUnit = gramosLote / cantidad;
    const impUnitH = impLoteH / cantidad;
    const prepUnitH = prepLoteH / cantidad;

    const costoPlastico = (gramosUnit / 1000.0) * params.precio_plastico_usd_kg * params.cotizacion_dolar;
    const costoElectricidad = impUnitH * (params.consumo_maquina_w / 1000.0) * params.energia_kwh;
    const costoDesgaste = impUnitH * params.desgaste_maquina_h;
    const costoManoObra = (prepUnitH + postUnitH) * params.tiempo_manual_h;

    return excelRound(costoPlastico + costoElectricidad + costoDesgaste + costoManoObra, 2);
  }

  function resolverDatosArticulo(idArticulo, cantidad, escalasReales, manualOverride = null) {
    const idNorm = normStr(idArticulo);
    const cant = Math.max(1, Math.floor(Number(cantidad) || 1));

    const exacta = escalasReales.find(
      e => normStr(e.id_articulo) === idNorm && Number(e.cantidad) === cant
    );
    if (exacta) {
      return {
        esReal: true,
        origenTexto: '✅ Real (Historial BambuStudio)',
        estadoHistorial: '✅ Medición real cargada (BambuStudio)',
        fecha: exacta.fecha,
        gramosLote: Number(exacta.gramos_lote),
        impLoteH: Number(exacta.tiempo_impresion_lote_h),
        prepLoteH: Number(exacta.tiempo_preparacion_lote_h),
        postUnitH: Number(exacta.tiempo_postprocesado_unit_h)
      };
    }

    const ref = escalasReales.find(e => normStr(e.id_articulo) === idNorm);

    if (manualOverride && Number(manualOverride.gramos) > 0 && Number(manualOverride.impH) > 0) {
      const prepH = (manualOverride.prepH !== null && Number.isFinite(Number(manualOverride.prepH)) && Number(manualOverride.prepH) >= 0)
        ? Number(manualOverride.prepH)
        : (ref ? Number(ref.tiempo_preparacion_lote_h) : 0);
      const postH = ref ? Number(ref.tiempo_postprocesado_unit_h) : 0;
      return {
        esReal: true,
        origenTexto: '✅ Real (Carga Manual Nueva)',
        estadoHistorial: '✅ Carga manual lista para guardar',
        fecha: new Date().toISOString().slice(0, 10),
        gramosLote: Number(manualOverride.gramos),
        impLoteH: Number(manualOverride.impH),
        prepLoteH: prepH,
        postUnitH: postH
      };
    }

    if (ref) {
      const factorEscala = cant / Number(ref.cantidad);
      return {
        esReal: false,
        origenTexto: '⚠️ Estimado Preliminar (Falta medir en Slicer)',
        estadoHistorial: '⚠️ Cantidad no registrada: cargá Gramos y Tiempo de BambuStudio',
        fecha: ref.fecha,
        gramosLote: Number(ref.gramos_lote) * factorEscala,
        impLoteH: Number(ref.tiempo_impresion_lote_h) * factorEscala,
        prepLoteH: Number(ref.tiempo_preparacion_lote_h),
        postUnitH: Number(ref.tiempo_postprocesado_unit_h)
      };
    }

    return {
      esReal: false,
      origenTexto: '⚠️ Sin mediciones en historial',
      estadoHistorial: '⚠️ Artículo sin mediciones registradas',
      fecha: new Date().toISOString().slice(0, 10),
      gramosLote: 0,
      impLoteH: 0,
      prepLoteH: 0,
      postUnitH: 0
    };
  }

  function calcularFilaRegistroCostos(fila, escalasReales, todasFilasRegistro, params) {
    const cant = Math.max(1, Math.floor(Number(fila.cantidad) || 1));
    const factor = Number(fila.factor_multiplicador) || params.factor_defecto;
    const datos = resolverDatosArticulo(fila.id_articulo, cant, escalasReales);

    const tiempoTotalUnitH = (datos.impLoteH / cant) + (datos.prepLoteH / cant) + datos.postUnitH;

    const costoBaseUnit = calcularCostoBaseUnitario(
      cant,
      datos.gramosLote,
      datos.impLoteH,
      datos.prepLoteH,
      datos.postUnitH,
      params
    );

    const costoBaseLote = excelRound(costoBaseUnit * cant, 2);
    const precioVentaUnit = excelRound(costoBaseUnit * factor, 2);
    const gananciaNetaUnit = excelRound(precioVentaUnit - costoBaseUnit, 2);
    const margenPct = precioVentaUnit > 0 ? (gananciaNetaUnit / precioVentaUnit) : 0;

    const idNorm = normStr(fila.id_articulo);
    const esc1 = escalasReales.find(
      e => normStr(e.id_articulo) === idNorm && Number(e.cantidad) === 1
    );

    let costoBase1u = 0;
    let esMedido1u = false;

    if (esc1) {
      costoBase1u = calcularCostoBaseUnitario(
        1,
        Number(esc1.gramos_lote),
        Number(esc1.tiempo_impresion_lote_h),
        Number(esc1.tiempo_preparacion_lote_h),
        Number(esc1.tiempo_postprocesado_unit_h),
        params
      );
      esMedido1u = true;
    } else {
      const reg1 = todasFilasRegistro.find(
        r => normStr(r.id_articulo) === idNorm && Number(r.cantidad) === 1
      );
      if (reg1 && cant !== 1) {
        const d1 = resolverDatosArticulo(reg1.id_articulo, 1, escalasReales);
        costoBase1u = calcularCostoBaseUnitario(
          1, d1.gramosLote, d1.impLoteH, d1.prepLoteH, d1.postUnitH, params
        );
        esMedido1u = true;
      } else {
        costoBase1u = excelRound(
          costoBaseUnit + (datos.prepLoteH * (1 - 1 / cant) * params.tiempo_manual_h),
          2
        );
        esMedido1u = (cant === 1 && datos.esReal);
      }
    }

    const precioVenta1u = excelRound(costoBase1u * factor, 2);
    const peUnidades = precioVentaUnit > 0 ? excelRoundUp(costoBaseLote / precioVentaUnit, 0) : 0;

    return {
      id: fila.id,
      fecha: datos.fecha,
      id_articulo: fila.id_articulo,
      nombre_articulo: fila.nombre_articulo,
      articuloLabel: `${fila.id_articulo} | ${fila.nombre_articulo}`,
      cantidad: cant,
      gramosLote: excelRound(datos.gramosLote, 2),
      impLoteH: datos.impLoteH,
      prepLoteH: datos.prepLoteH,
      postUnitH: datos.postUnitH,
      tiempoTotalUnitH,
      impLoteHHMM: hoursToHHMM(datos.impLoteH),
      prepLoteHHMM: hoursToHHMM(datos.prepLoteH),
      postUnitHHMM: hoursToHHMM(datos.postUnitH),
      tiempoTotalUnitHHMM: hoursToHHMM(tiempoTotalUnitH),
      costoBaseUnit,
      costoBaseLote,
      factor,
      precioVentaUnit,
      gananciaNetaUnit,
      margenPct,
      costoBase1u,
      precioVenta1u,
      esMedido1u,
      esRealLote: datos.esReal,
      puntoEquilibrio: `${peUnidades} de ${cant} u.`,
      peUnidades
    };
  }

  function cotizarDinamico({ idArticulo, nombreArticulo, cantidad, factor, manualGramos, manualImpH, manualPrepH }, escalasReales, params) {
    const cant = Math.max(1, Math.floor(Number(cantidad) || 1));
    const fact = Number(factor) || params.factor_defecto;

    const datos = resolverDatosArticulo(idArticulo, cant, escalasReales, {
      gramos: manualGramos,
      impH: manualImpH,
      prepH: manualPrepH
    });

    const prepUnitH = datos.prepLoteH / cant;
    const tiempoTotalUnitH = (datos.impLoteH / cant) + prepUnitH + datos.postUnitH;
    const tiempoTotalLoteH = tiempoTotalUnitH * cant;

    const costoBaseUnit = calcularCostoBaseUnitario(
      cant, datos.gramosLote, datos.impLoteH, datos.prepLoteH, datos.postUnitH, params
    );
    const costoBaseLote = excelRound(costoBaseUnit * cant, 2);
    const precioVentaUnit = excelRound(costoBaseUnit * fact, 2);
    const precioVentaLote = excelRound(precioVentaUnit * cant, 2);
    const gananciaNetaUnit = excelRound(precioVentaUnit - costoBaseUnit, 2);
    const gananciaNetaLote = excelRound(gananciaNetaUnit * cant, 2);

    const idNorm = normStr(idArticulo);
    const esc1 = escalasReales.find(
      e => normStr(e.id_articulo) === idNorm && Number(e.cantidad) === 1
    );
    let compVenta1u = 0;
    if (esc1) {
      const c1 = calcularCostoBaseUnitario(
        1, esc1.gramos_lote, esc1.tiempo_impresion_lote_h, esc1.tiempo_preparacion_lote_h, esc1.tiempo_postprocesado_unit_h, params
      );
      compVenta1u = excelRound(c1 * fact, 2);
    } else {
      compVenta1u = excelRound((costoBaseUnit + (prepUnitH * (cant - 1) * params.tiempo_manual_h)) * fact, 2);
    }

    const peUnidades = precioVentaUnit > 0 ? excelRoundUp(costoBaseLote / precioVentaUnit, 0) : 0;

    const escalasObjetivo = [1, 3, 5, 10, 20];
    const tablaEscalas = escalasObjetivo.map(n => {
      const dEsc = resolverDatosArticulo(idArticulo, n, escalasReales);
      const prepPorPieza = excelRound((dEsc.prepLoteH / n) * params.tiempo_manual_h, 2);
      const cBaseU = calcularCostoBaseUnitario(
        n, dEsc.gramosLote, dEsc.impLoteH, dEsc.prepLoteH, dEsc.postUnitH, params
      );
      const pVentaU = excelRound(cBaseU * fact, 2);
      const cTotalLote = excelRound(cBaseU * n, 2);
      const pe = pVentaU > 0 ? excelRoundUp(cTotalLote / pVentaU, 0) : 0;
      return {
        unidades: n,
        esReal: dEsc.esReal,
        origen: dEsc.esReal ? '✅ Real' : '⚠️ Estimado',
        prepPorPieza,
        costoBaseUnit: cBaseU,
        precioVentaUnit: pVentaU,
        costoTotalLote: cTotalLote,
        puntoEquilibrio: `${pe} de ${n} u.`
      };
    });

    return {
      idArticulo,
      nombreArticulo,
      cantidad: cant,
      factor: fact,
      esReal: datos.esReal,
      origenTexto: datos.origenTexto,
      estadoHistorial: datos.estadoHistorial,
      gramosActivos: excelRound(datos.gramosLote, 2),
      impActivoH: datos.impLoteH,
      impActivoHHMM: hoursToHHMM(datos.impLoteH),
      prepUnitH,
      prepUnitHHMM: hoursToHHMM(prepUnitH),
      postUnitH: datos.postUnitH,
      postUnitHHMM: hoursToHHMM(datos.postUnitH),
      tiempoTotalUnitH,
      tiempoTotalUnitHHMM: hoursToHHMM(tiempoTotalUnitH),
      tiempoTotalLoteH,
      tiempoTotalLoteHHMM: hoursToHHMM(tiempoTotalLoteH),
      costoBaseUnit,
      costoBaseLote,
      precioVentaUnit,
      precioVentaLote,
      gananciaNetaUnit,
      gananciaNetaLote,
      compVenta1u,
      puntoEquilibrio: `${peUnidades} de ${cant} u.`,
      tablaEscalas
    };
  }

  function calcularCombos(presupuestoCliente, factorComboGlobal, lineasSeleccionadas, filasRegistroCalculadas, escalasReales, params) {
    const presupuesto = Math.max(0, Number(presupuestoCliente) || 0);

    const items = [];
    for (let idx = 0; idx < lineasSeleccionadas.length; idx++) {
      const linea = lineasSeleccionadas[idx];
      if (!linea || !linea.id_articulo) continue;

      const idNorm = normStr(linea.id_articulo);
      const reg = filasRegistroCalculadas.find(r => normStr(r.id_articulo) === idNorm);
      if (!reg) continue;

      const factorAplicado = (factorComboGlobal === 'Según Registro de Costos')
        ? reg.factor
        : Number(factorComboGlobal);

      const gramosUnit = reg.gramosLote / reg.cantidad;
      const tiempoImpUnit = reg.impLoteH / reg.cantidad;
      const tiempoPostUnit = reg.postUnitH;

      const costoMat = (gramosUnit / 1000.0) * params.precio_plastico_usd_kg * params.cotizacion_dolar;
      const costoElec = (params.consumo_maquina_w / 1000.0) * tiempoImpUnit * params.energia_kwh;
      const costoDesg = tiempoImpUnit * params.desgaste_maquina_h;
      const costoMOpost = tiempoPostUnit * params.tiempo_manual_h;

      const c_var = costoMat + costoElec + costoDesg + costoMOpost;
      const c_fix = reg.prepLoteH * params.tiempo_manual_h;
      const p_var = c_var * factorAplicado;
      const p_fix = c_fix * factorAplicado;
      const g_var = p_var - c_var;

      items.push({
        slotIndex: idx,
        id_articulo: reg.id_articulo,
        nombre_articulo: reg.nombre_articulo,
        reg,
        factorAplicado,
        costoRef1u: reg.costoBase1u,
        precioRef1u: excelRound(reg.costoBase1u * factorAplicado, 2),
        c_var,
        c_fix,
        p_var,
        p_fix,
        g_var,
        op1: 0,
        op2: 0,
        op3: 0,
        manual: Math.max(0, Math.floor(Number(linea.manualCant) || 0))
      });
    }

    if (items.length === 0) {
      return { items: [], opciones: [] };
    }

    const sumPvar = items.reduce((acc, x) => acc + x.p_var, 0);
    const sumPfix = items.reduce((acc, x) => acc + x.p_fix, 0);
    const k2 = Math.max(0, presupuesto - sumPfix);
    const j2 = sumPvar > 0 ? Math.floor(k2 / sumPvar) : 0;

    let remOp1 = k2 - j2 * sumPvar;
    for (const x of items) {
      if (remOp1 >= x.p_var - 1e-9) {
        x.op1 = j2 + 1;
        remOp1 -= x.p_var;
      } else {
        x.op1 = j2;
      }
    }

    const sumW2 = items.reduce((acc, x) => acc + (x.p_var > 0 ? 1 / (x.p_var * x.p_var) : 0), 0);
    for (const x of items) {
      const w2 = x.p_var > 0 ? 1 / (x.p_var * x.p_var) : 0;
      x.base_op2 = (sumW2 > 0 && x.p_var > 0)
        ? Math.max(1, Math.floor((k2 * (w2 / sumW2)) / x.p_var))
        : 0;
    }
    const sumBaseP2 = items.reduce((acc, x) => acc + x.base_op2 * x.p_var, 0);
    let rem2 = Math.max(0, k2 - sumBaseP2);
    const ordenOp2 = items
      .map((x, i) => ({ x, i }))
      .sort((a, b) => (a.x.p_var - b.x.p_var) || (a.i - b.i));
    for (const { x } of ordenOp2) {
      const ext = x.p_var > 0 ? Math.floor(rem2 / x.p_var) : 0;
      x.op2 = x.base_op2 + ext;
      rem2 -= ext * x.p_var;
    }

    const sumW3 = items.reduce((acc, x) => acc + (x.g_var * x.g_var), 0);
    for (const x of items) {
      const w3 = x.g_var * x.g_var;
      x.base_op3 = (sumW3 > 0 && x.p_var > 0)
        ? Math.max(1, Math.floor((k2 * (w3 / sumW3)) / x.p_var))
        : 0;
    }
    const sumBaseP3 = items.reduce((acc, x) => acc + x.base_op3 * x.p_var, 0);
    let rem3 = Math.max(0, k2 - sumBaseP3);
    const ordenOp3 = items
      .map((x, i) => ({ x, i }))
      .sort((a, b) => (b.x.g_var - a.x.g_var) || (a.i - b.i));
    for (const { x } of ordenOp3) {
      const ext = x.p_var > 0 ? Math.floor(rem3 / x.p_var) : 0;
      x.op3 = x.base_op3 + ext;
      rem3 -= ext * x.p_var;
    }

    const evaluar = (nombre, key) => {
      const partes = [];
      let totalPiezas = 0;
      let precioVenta = 0;
      let costoProd = 0;
      let tiempoTotal = 0;
      let faltaMedir = false;

      for (const x of items) {
        const cant = x[key];
        if (cant <= 0) continue;
        totalPiezas += cant;
        partes.push(`${x.nombre_articulo} (${x.id_articulo}) x${cant}`);

        const idNorm = normStr(x.id_articulo);
        const matchReg = filasRegistroCalculadas.find(
          r => normStr(r.id_articulo) === idNorm && r.cantidad === cant
        );
        const matchEsc = escalasReales.find(
          e => normStr(e.id_articulo) === idNorm && Number(e.cantidad) === cant
        );

        let costoLote = 0;
        if (matchReg) {
          costoLote = matchReg.costoBaseLote;
        } else if (matchEsc) {
          const cU = calcularCostoBaseUnitario(
            cant, matchEsc.gramos_lote, matchEsc.tiempo_impresion_lote_h, matchEsc.tiempo_preparacion_lote_h, matchEsc.tiempo_postprocesado_unit_h, params
          );
          costoLote = excelRound(cU * cant, 2);
        } else {
          faltaMedir = true;
          const gramosUnit = x.reg.gramosLote / x.reg.cantidad;
          const impUnit = x.reg.impLoteH / x.reg.cantidad;
          const cMat = ((gramosUnit * cant) / 1000.0) * params.precio_plastico_usd_kg * params.cotizacion_dolar;
          const cElec = (params.consumo_maquina_w / 1000.0) * (impUnit * cant) * params.energia_kwh;
          const cDesg = (impUnit * cant) * params.desgaste_maquina_h;
          const cMO = (x.reg.prepLoteH + (x.reg.postUnitH * cant)) * params.tiempo_manual_h;
          costoLote = excelRound(cMat + cElec + cDesg + cMO, 2);
        }

        precioVenta += x.factorAplicado * costoLote;
        costoProd += costoLote;
        tiempoTotal += cant * x.reg.tiempoTotalUnitH;
      }

      const ventaRound = excelRound(precioVenta, 2);
      const costoRound = excelRound(costoProd, 2);
      return {
        nombre,
        key,
        composicion: partes.length ? partes.join(', ') : 'Sin artículos seleccionados',
        totalPiezas,
        precioVenta: ventaRound,
        costoProduccion: costoRound,
        gananciaNeta: excelRound(ventaRound - costoRound, 2),
        saldoPresupuesto: excelRound(presupuesto - ventaRound, 2),
        tiempoTotalH: tiempoTotal,
        tiempoTotalHHMM: hoursToHHMM(tiempoTotal),
        esReal: totalPiezas > 0 && !faltaMedir,
        origen: totalPiezas === 0
          ? '— Sin artículos'
          : (faltaMedir ? '⚠️ Estimado Preliminar (Falta medir lote en Slicer)' : '✅ Real (Historial BambuStudio)')
      };
    };

    const opciones = [
      evaluar('Opción 1 (Equilibrada)', 'op1'),
      evaluar('Opción 2 (Máx. Cantidad)', 'op2'),
      evaluar('Opción 3 (Máx. Ganancia)', 'op3'),
      evaluar('Tu Armado Manual', 'manual')
    ];

    return { items, opciones };
  }

  return {
    excelRound,
    excelRoundUp,
    hoursToHHMM,
    hhmmToHours,
    normalizeHHMM,
    mapParametros,
    calcularCostoBaseUnitario,
    resolverDatosArticulo,
    calcularFilaRegistroCostos,
    cotizarDinamico,
    calcularCombos
  };
})();
