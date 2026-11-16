/**
 * ============================================================================
 * CONTROLADOR PRINCIPAL DE INTERFAZ Y OPERACIONES CRUD EN TIEMPO REAL (SUPABASE)
 * ============================================================================
 */

let escalaChart = null;

// Estado inicial del Armador de Combos
let comboState = {
  presupuesto: 3278,
  factorGlobal: '2',
  lineas: [
    { id_articulo: 'ART-002', manualCant: 15 },
    { id_articulo: 'ART-003', manualCant: 10 },
    { id_articulo: 'ART-004', manualCant: 12 },
    { id_articulo: 'ART-005', manualCant: 3 }
  ]
};

// Borrador de ítems para Nuevo Pedido de Cliente (permite múltiples artículos y combos guardados)
let pedidoDraftLineas = [
  { tipo: 'articulo', refId: '', cantidad: 1, precioUnitario: 0 }
];

function escHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function showToast(msg) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(window.__toastTimer);
  window.__toastTimer = setTimeout(() => el.classList.remove('show'), 2900);
}

function fmtUYU(val) {
  return '$' + Number(val || 0).toLocaleString('es-UY', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  });
}

function fmtPct(val) {
  return (Number(val || 0) * 100).toFixed(1) + '%';
}

/**
 * Normaliza un campo de entrada hh:mm al perder el foco
 */
function handleHHMMBlur(inputEl) {
  const raw = inputEl.value.trim();
  if (!raw) return;
  const norm = Engine3D.normalizeHHMM(raw);
  if (norm === null) {
    showToast('⚠️ Formato de tiempo inválido. Usá hh:mm (ej: 02:30 o 00:05)');
    inputEl.focus();
  } else {
    inputEl.value = norm;
  }
}

/**
 * Previsualiza el ID automático ART-XXX según el nombre ingresado
 */
async function previewNextArticuloId(nombreVal) {
  const badge = document.getElementById('reg-next-id');
  if (!badge) return;
  try {
    const clean = String(nombreVal || '').replace(/^ART-\d+\s*\|\s*/i, '').trim();
    if (clean) {
      const existing = await DB3D.findArticuloByName(clean);
      if (existing) {
        badge.textContent = `🔒 ${existing.id_articulo} (Existente)`;
        return;
      }
    }
    const nextId = await DB3D.getNextArticuloId();
    badge.textContent = `🔒 ${nextId}`;
  } catch (err) {
    console.warn(err);
  }
}

/**
 * Recalcula y renderiza TODAS las vistas de la aplicación desde Supabase
 */
async function refreshAll() {
  try {
    const {
      paramRows,
      articulos,
      escalasReales,
      registroRaw,
      combosGuardados,
      pedidos,
      pedidoItems
    } = await DB3D.getAllData();

    const params = Engine3D.mapParametros(paramRows);
    const registroCalc = registroRaw.map(r =>
      Engine3D.calcularFilaRegistroCostos(r, escalasReales, registroRaw, params)
    );

    // Actualizar datalist de nombres de artículos
    const datalist = document.getElementById('catalogo-nombres-list');
    datalist.innerHTML = articulos.map(a => `<option value="${escHtml(a.nombre)}">`).join('');

    // Actualizar datalist de clientes históricos
    const clientesUnicos = [...new Set(pedidos.map(p => p.cliente).filter(Boolean))];
    const clientesList = document.getElementById('clientes-list');
    if (clientesList) {
      clientesList.innerHTML = clientesUnicos.map(c => `<option value="${escHtml(c)}">`).join('');
    }

    // Actualizar vista previa de siguiente ID ART-XXX
    const regArtInput = document.getElementById('reg-art');
    await previewNextArticuloId(regArtInput ? regArtInput.value : '');

    renderRegistroCostos(registroCalc);
    renderCotizador(articulos, escalasReales, params);
    renderCombos(registroCalc, escalasReales, params, combosGuardados);
    renderPedidos(pedidos, pedidoItems, registroCalc, combosGuardados);
    renderEscalasReales(escalasReales, params);
    renderParametros(paramRows);
  } catch (err) {
    console.error(err);
    showToast('❌ Error sincronizando con Supabase: ' + err.message);
  }
}

/* ============================================================================
   1. TAB: ARTÍCULOS (Catálogo + Costos + Semáforo N=1)
   ============================================================================ */
function renderRegistroCostos(registroCalc) {
  const factoresDisponibles = [1.5, 2, 2.5, 3, 4, 5];
  const tbody = document.getElementById('tbody-registro');
  tbody.innerHTML = registroCalc.map(row => {
    const optsFactor = factoresDisponibles.includes(row.factor)
      ? factoresDisponibles
      : [...factoresDisponibles, row.factor].sort((a, b) => a - b);

    return `
      <tr>
        <td>${escHtml(row.fecha)}</td>
        <td><span class="badge badge-blue" title="Identificador único de base de datos (no modificable)">${escHtml(row.id_articulo)}</span></td>
        <td>
          <input type="text" class="inline-name-input" value="${escHtml(row.nombre_articulo)}"
            onchange="updateArticuloNombre('${escHtml(row.id_articulo)}', this.value)"
            title="Editar nombre del artículo">
        </td>
        <td class="num">
          <input type="number" class="inline-input" min="1" step="1" value="${row.cantidad}"
            onchange="updateRegistroCantidad(${row.id}, this.value)">
        </td>
        <td class="num">${row.gramosLote.toFixed(2)} g</td>
        <td class="num">${row.impLoteHHMM}</td>
        <td class="num">${row.prepLoteHHMM}</td>
        <td class="num">${row.postUnitHHMM}</td>
        <td class="num">${row.tiempoTotalUnitHHMM}</td>
        <td class="num"><strong>${fmtUYU(row.costoBaseUnit)}</strong></td>
        <td class="num">${fmtUYU(row.costoBaseLote)}</td>
        <td class="num">
          <select class="inline-select" onchange="updateRegistroFactor(${row.id}, this.value)">
            ${optsFactor.map(f => `<option value="${f}" ${row.factor === f ? 'selected' : ''}>${f.toFixed(1)}x</option>`).join('')}
          </select>
        </td>
        <td class="num" style="color: var(--accent); font-weight: 700;">${fmtUYU(row.precioVentaUnit)}</td>
        <td class="num" style="color: var(--green-text);">${fmtUYU(row.gananciaNetaUnit)}</td>
        <td class="num">${fmtPct(row.margenPct)}</td>
        <td class="num">
          <span class="badge ${row.esMedido1u ? 'badge-green' : 'badge-amber'}" title="${row.esMedido1u ? 'Medido real en N=1' : 'Piso mínimo estimado (100% prep.)'}">
            ${row.esMedido1u ? '🟢' : '🟠'} ${fmtUYU(row.costoBase1u)}
          </span>
        </td>
        <td class="num">${fmtUYU(row.precioVenta1u)}</td>
        <td class="center"><span class="badge badge-blue">${escHtml(row.puntoEquilibrio)}</span></td>
        <td class="center">
          <button class="btn btn-danger" onclick="deleteRegistro(${row.id})" title="Eliminar fila">🗑️</button>
        </td>
      </tr>
    `;
  }).join('');
}

async function updateArticuloNombre(idArticulo, nuevoNombre) {
  const clean = String(nuevoNombre || '').trim();
  if (!clean) {
    showToast('⚠️ El nombre del artículo no puede quedar vacío');
    await refreshAll();
    return;
  }
  try {
    await DB3D.updateArticuloNombre(idArticulo, clean);
    await refreshAll();
    showToast(`Nombre de ${idArticulo} actualizado`);
  } catch (err) {
    showToast('⚠️ Ya existe otro artículo con ese nombre');
    await refreshAll();
  }
}

async function updateRegistroCantidad(id, nuevaCant) {
  try {
    const cant = Math.max(1, Math.floor(Number(nuevaCant) || 1));
    await DB3D.updateRegistroCosto(id, { cantidad: cant });
    await refreshAll();
    showToast('Cantidad actualizada en Supabase');
  } catch (err) {
    showToast('❌ Error: ' + err.message);
  }
}

async function updateRegistroFactor(id, nuevoFactor) {
  try {
    await DB3D.updateRegistroCosto(id, { factor_multiplicador: Number(nuevoFactor) });
    await refreshAll();
    showToast('Factor multiplicador actualizado');
  } catch (err) {
    showToast('❌ Error: ' + err.message);
  }
}

async function deleteRegistro(id) {
  try {
    await DB3D.deleteRegistroCosto(id);
    await refreshAll();
    showToast('Fila eliminada de Artículos');
  } catch (err) {
    showToast('❌ Error: ' + err.message);
  }
}

async function handleAddRegistro(e) {
  e.preventDefault();
  const nombreRaw = document.getElementById('reg-art').value.trim();
  const cantidad = Math.max(1, Math.floor(Number(document.getElementById('reg-cant').value) || 1));
  const factor = Number(document.getElementById('reg-factor').value) || 2.5;
  const gramos = Number(document.getElementById('reg-gramos').value) || 0;

  const impStr = document.getElementById('reg-imp').value.trim();
  const prepStr = document.getElementById('reg-prep').value.trim();
  const postStr = document.getElementById('reg-post').value.trim();

  const impH = Engine3D.hhmmToHours(impStr);
  const prepH = Engine3D.hhmmToHours(prepStr);
  const postH = Engine3D.hhmmToHours(postStr);

  if (!nombreRaw) return;
  if (impStr && !Number.isFinite(impH)) {
    showToast('⚠️ Tiempo de impresión inválido. Usá formato hh:mm');
    return;
  }
  if (prepStr && !Number.isFinite(prepH)) {
    showToast('⚠️ Tiempo de preparación inválido. Usá formato hh:mm');
    return;
  }
  if (postStr && !Number.isFinite(postH)) {
    showToast('⚠️ Tiempo de postprocesado inválido. Usá formato hh:mm');
    return;
  }

  try {
    const artObj = await DB3D.getOrCreateArticulo(nombreRaw);

    if (gramos > 0 && Number.isFinite(impH) && impH > 0) {
      const fecha = new Date().toISOString().slice(0, 10);
      await DB3D.insertEscalaReal({
        fecha,
        id_articulo: artObj.id_articulo,
        cantidad,
        gramos_lote: gramos,
        tiempo_impresion_lote_h: impH,
        tiempo_preparacion_lote_h: Number.isFinite(prepH) ? prepH : 0,
        tiempo_postprocesado_unit_h: Number.isFinite(postH) ? postH : 0,
        factor_multiplicador: factor
      });
    }

    await DB3D.insertRegistroCosto(artObj.id_articulo, cantidad, factor);

    e.target.reset();
    document.getElementById('reg-cant').value = 1;
    document.getElementById('reg-factor').value = '2.5';
    await refreshAll();
    showToast(`✅ Artículo ${artObj.id_articulo} (${artObj.nombre}) guardado en Supabase`);
  } catch (err) {
    showToast('❌ Error al guardar: ' + err.message);
  }
}

/* ============================================================================
   2. TAB: COTIZADOR DINÁMICO Y CURVA DE ESCALA
   ============================================================================ */
function renderCotizador(articulos, escalasReales, params) {
  const selArt = document.getElementById('cot-articulo');
  const prevVal = selArt.value;
  selArt.innerHTML = articulos.map(a =>
    `<option value="${escHtml(a.id_articulo)}">${escHtml(a.id_articulo)} | ${escHtml(a.nombre)}</option>`
  ).join('');

  const ids = articulos.map(a => a.id_articulo);
  if (prevVal && ids.includes(prevVal)) {
    selArt.value = prevVal;
  } else if (ids.includes('ART-006')) {
    selArt.value = 'ART-006';
  }

  const idArticulo = selArt.value;
  const artObj = articulos.find(a => a.id_articulo === idArticulo);
  const nombreArticulo = artObj ? artObj.nombre : '';
  const cantidad = Math.max(1, Math.floor(Number(document.getElementById('cot-cantidad').value) || 1));
  const factor = Number(document.getElementById('cot-factor').value) || 3.0;
  const manualGramos = Number(document.getElementById('cot-manual-gramos').value) || 0;

  const impParsed = Engine3D.hhmmToHours(document.getElementById('cot-manual-imp').value);
  const prepParsed = Engine3D.hhmmToHours(document.getElementById('cot-manual-prep').value);
  const manualImpH = Number.isFinite(impParsed) ? impParsed : 0;
  const manualPrepH = Number.isFinite(prepParsed) ? prepParsed : null;

  const res = Engine3D.cotizarDinamico(
    { idArticulo, nombreArticulo, cantidad, factor, manualGramos, manualImpH, manualPrepH },
    escalasReales,
    params
  );

  const estadoBox = document.getElementById('cot-estado-historial');
  estadoBox.className = 'badge ' + (res.esReal ? 'badge-green' : 'badge-amber');
  estadoBox.textContent = res.estadoHistorial;

  const origenBox = document.getElementById('cot-origen-datos');
  origenBox.className = 'badge ' + (res.esReal ? 'badge-green' : 'badge-amber');
  origenBox.textContent = res.origenTexto;

  document.getElementById('cot-gramos').textContent = `${res.gramosActivos.toFixed(2)} g`;
  document.getElementById('cot-imp-h').textContent = res.impActivoHHMM;
  document.getElementById('cot-prep-u').textContent = `${res.prepUnitHHMM} / u.`;
  document.getElementById('cot-post-u').textContent = `${res.postUnitHHMM} / u.`;
  document.getElementById('cot-tiempo-total').textContent = `${res.tiempoTotalUnitHHMM} / u. (${res.tiempoTotalLoteHHMM} lote)`;
  document.getElementById('cot-costo-unit').textContent = fmtUYU(res.costoBaseUnit);
  document.getElementById('cot-costo-lote').textContent = fmtUYU(res.costoBaseLote);
  document.getElementById('cot-precio-unit').textContent = fmtUYU(res.precioVentaUnit);
  document.getElementById('cot-precio-lote').textContent = fmtUYU(res.precioVentaLote);
  document.getElementById('cot-ganancia').textContent = `${fmtUYU(res.gananciaNetaUnit)} / u. (${fmtUYU(res.gananciaNetaLote)} lote)`;
  document.getElementById('cot-comp-1u').textContent = `${fmtUYU(res.compVenta1u)} (ref. suelta)`;
  document.getElementById('cot-pe').textContent = res.puntoEquilibrio;

  // Tabla de escalas 1, 3, 5, 10, 20
  const tbodyEsc = document.getElementById('tbody-cot-escalas');
  tbodyEsc.innerHTML = res.tablaEscalas.map(s => `
    <tr>
      <td class="num"><strong>${s.unidades} u.</strong></td>
      <td><span class="badge ${s.esReal ? 'badge-green' : 'badge-amber'}">${s.origen}</span></td>
      <td class="num">${fmtUYU(s.prepPorPieza)}</td>
      <td class="num"><strong>${fmtUYU(s.costoBaseUnit)}</strong></td>
      <td class="num" style="color: var(--accent); font-weight:700;">${fmtUYU(s.precioVentaUnit)}</td>
      <td class="num">${fmtUYU(s.costoTotalLote)}</td>
      <td class="center"><span class="badge badge-blue">${s.puntoEquilibrio}</span></td>
    </tr>
  `).join('');

  renderEscalaChart(res.tablaEscalas, `${idArticulo} | ${nombreArticulo}`);
}

async function guardarMedicionDesdeCotizador() {
  const idArticulo = document.getElementById('cot-articulo').value;
  const cantidad = Math.max(1, Math.floor(Number(document.getElementById('cot-cantidad').value) || 1));
  const factor = Number(document.getElementById('cot-factor').value) || 2.5;
  const gramos = Number(document.getElementById('cot-manual-gramos').value);
  const impH = Engine3D.hhmmToHours(document.getElementById('cot-manual-imp').value);
  const prepParsed = Engine3D.hhmmToHours(document.getElementById('cot-manual-prep').value);
  const prepH = Number.isFinite(prepParsed) ? prepParsed : 0;

  if (!idArticulo || gramos <= 0 || !Number.isFinite(impH) || impH <= 0) {
    showToast('⚠️ Ingresá Gramos y Tiempo de Impresión (hh:mm) válidos');
    return;
  }

  try {
    const fecha = new Date().toISOString().slice(0, 10);
    await DB3D.upsertEscalaReal({
      fecha,
      id_articulo: idArticulo,
      cantidad,
      gramos_lote: gramos,
      tiempo_impresion_lote_h: impH,
      tiempo_preparacion_lote_h: prepH,
      tiempo_postprocesado_unit_h: 0,
      factor_multiplicador: factor
    });

    document.getElementById('cot-manual-gramos').value = '';
    document.getElementById('cot-manual-imp').value = '';
    document.getElementById('cot-manual-prep').value = '';
    await refreshAll();
    showToast(`✅ Medición real guardada para ${idArticulo} (${cantidad} u.)`);
  } catch (err) {
    showToast('❌ Error: ' + err.message);
  }
}

function renderEscalaChart(tablaEscalas, articuloLabel) {
  const ctx = document.getElementById('chart-escalas');
  if (!ctx || typeof Chart === 'undefined') return;

  const labels = tablaEscalas.map(s => `${s.unidades} u.`);
  const costos = tablaEscalas.map(s => s.costoBaseUnit);
  const precios = tablaEscalas.map(s => s.precioVentaUnit);

  if (escalaChart) {
    escalaChart.destroy();
  }

  escalaChart = new Chart(ctx, {
    type: 'line',
    data: {
      labels,
      datasets: [
        {
          label: 'Costo Base Unitario ($ UYU)',
          data: costos,
          borderColor: '#f59e0b',
          backgroundColor: 'rgba(245, 158, 11, 0.15)',
          tension: 0.25,
          fill: true,
          borderWidth: 2.5
        },
        {
          label: 'Precio de Venta Unitario ($ UYU)',
          data: precios,
          borderColor: '#06b6d4',
          backgroundColor: 'rgba(6, 182, 212, 0.15)',
          tension: 0.25,
          fill: true,
          borderWidth: 2.5
        }
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { labels: { color: '#f1f5f9' } },
        title: {
          display: true,
          text: `Curva de Costo Base vs. Precio de Venta (${articuloLabel})`,
          color: '#f1f5f9'
        }
      },
      scales: {
        x: { ticks: { color: '#94a3b8' }, grid: { color: 'rgba(51,65,85,0.4)' } },
        y: { ticks: { color: '#94a3b8' }, grid: { color: 'rgba(51,65,85,0.4)' } }
      }
    }
  });
}

/* ============================================================================
   3. TAB: ARMADOR DINÁMICO DE COMBOS POR PRESUPUESTO
   ============================================================================ */
function renderCombos(registroCalc, escalasReales, params, combosGuardados) {
  const calc = Engine3D.calcularCombos(
    comboState.presupuesto,
    comboState.factorGlobal,
    comboState.lineas,
    registroCalc,
    escalasReales,
    params
  );

  // Tabla de artículos incluidos en el combo
  const tbodyItems = document.getElementById('tbody-combo-items');
  tbodyItems.innerHTML = comboState.lineas.map((linea, idx) => {
    const itemCalc = calc.items.find(x => x.slotIndex === idx);
    return `
      <tr>
        <td>
          <select class="inline-select" style="min-width: 220px;" onchange="updateComboLineaArt(${idx}, this.value)">
            <option value="">-- Seleccionar artículo --</option>
            ${registroCalc.map(r => `<option value="${escHtml(r.id_articulo)}" ${linea.id_articulo === r.id_articulo ? 'selected' : ''}>${escHtml(r.id_articulo)} | ${escHtml(r.nombre_articulo)}</option>`).join('')}
          </select>
        </td>
        <td class="num">${itemCalc ? itemCalc.factorAplicado.toFixed(1) + 'x' : '-'}</td>
        <td class="num">${itemCalc ? fmtUYU(itemCalc.costoRef1u) : '-'}</td>
        <td class="num">${itemCalc ? fmtUYU(itemCalc.precioRef1u) : '-'}</td>
        <td class="num"><span class="badge badge-blue">${itemCalc ? itemCalc.op1 : 0}</span></td>
        <td class="num"><span class="badge badge-green">${itemCalc ? itemCalc.op2 : 0}</span></td>
        <td class="num"><span class="badge badge-amber">${itemCalc ? itemCalc.op3 : 0}</span></td>
        <td class="num">
          <input type="number" class="inline-input" min="0" step="1" value="${linea.manualCant}"
            onchange="updateComboLineaManual(${idx}, this.value)">
        </td>
        <td class="center">
          <button class="btn btn-danger" onclick="removeComboLinea(${idx})">✕</button>
        </td>
      </tr>
    `;
  }).join('');

  // Tabla de Opciones Calculadas
  window.__lastComboOpciones = calc.opciones;
  const tbodyOpc = document.getElementById('tbody-combo-opciones');
  tbodyOpc.innerHTML = calc.opciones.map((op, i) => `
    <tr>
      <td><strong>${escHtml(op.nombre)}</strong></td>
      <td style="max-width: 340px;">${escHtml(op.composicion)}</td>
      <td class="num"><strong>${op.totalPiezas} u.</strong></td>
      <td class="num" style="color: var(--accent); font-weight: 700;">${fmtUYU(op.precioVenta)}</td>
      <td class="num">${fmtUYU(op.costoProduccion)}</td>
      <td class="num" style="color: var(--green-text); font-weight: 700;">${fmtUYU(op.gananciaNeta)}</td>
      <td class="num" style="color: ${op.saldoPresupuesto >= 0 ? 'var(--green-text)' : 'var(--red-text)'};">
        ${fmtUYU(op.saldoPresupuesto)}
      </td>
      <td class="num">${op.tiempoTotalHHMM}</td>
      <td><span class="badge ${op.esReal ? 'badge-green' : 'badge-amber'}">${escHtml(op.origen)}</span></td>
      <td class="center">
        <button class="btn btn-success btn-sm" onclick="guardarComboEnHistorial(${i})">💾 Guardar</button>
      </td>
    </tr>
  `).join('');

  // Tabla de Historial de Combos Guardados
  const tbodyHist = document.getElementById('tbody-combo-historial');
  tbodyHist.innerHTML = combosGuardados.map(c => `
    <tr>
      <td>${escHtml(c.fecha)}</td>
      <td>
        <input type="text" class="inline-name-input" value="${escHtml(c.nombre_combo || c.opcion_elegida)}"
          onchange="updateComboNombre(${c.id}, this.value)" title="Editar nombre del combo">
      </td>
      <td class="num">${fmtUYU(c.presupuesto)}</td>
      <td>${escHtml(c.opcion_elegida)}</td>
      <td style="max-width: 360px;">${escHtml(c.composicion)}</td>
      <td class="num" style="color: var(--accent); font-weight: 700;">${fmtUYU(c.precio_venta)}</td>
      <td class="num">${fmtUYU(c.costo_produccion)}</td>
      <td class="num">${fmtUYU(c.saldo_presupuesto)}</td>
      <td><span class="badge badge-green">${escHtml(c.estado)}</span></td>
      <td class="center">
        <button class="btn btn-danger" onclick="deleteComboGuardado(${c.id})">🗑️</button>
      </td>
    </tr>
  `).join('');
}

async function updateComboConfig() {
  comboState.presupuesto = Math.max(0, Number(document.getElementById('cmb-presupuesto').value) || 0);
  comboState.factorGlobal = document.getElementById('cmb-factor').value;
  await refreshAll();
}

async function addComboLinea() {
  if (comboState.lineas.length >= 10) {
    showToast('Máximo 10 artículos por combo');
    return;
  }
  comboState.lineas.push({ id_articulo: '', manualCant: 1 });
  await refreshAll();
}

async function removeComboLinea(idx) {
  comboState.lineas.splice(idx, 1);
  await refreshAll();
}

async function updateComboLineaArt(idx, idArt) {
  comboState.lineas[idx].id_articulo = idArt;
  await refreshAll();
}

async function updateComboLineaManual(idx, cant) {
  comboState.lineas[idx].manualCant = Math.max(0, Math.floor(Number(cant) || 0));
  await refreshAll();
}

async function guardarComboEnHistorial(opcionIdx) {
  const op = (window.__lastComboOpciones || [])[opcionIdx];
  if (!op || op.totalPiezas <= 0) {
    showToast('⚠️ Seleccioná artículos válidos antes de guardar');
    return;
  }

  const inputNombre = document.getElementById('cmb-nombre');
  let nombreCombo = inputNombre ? inputNombre.value.trim() : '';
  if (!nombreCombo) {
    const sugerido = `Combo ${op.nombre}`;
    const ingresado = prompt('Ingresá un nombre para este combo:', sugerido);
    if (ingresado === null) return;
    nombreCombo = ingresado.trim() || sugerido;
  }

  try {
    const fecha = new Date().toISOString().slice(0, 10);
    await DB3D.insertComboGuardado({
      fecha,
      nombre_combo: nombreCombo,
      presupuesto: comboState.presupuesto,
      opcion_elegida: op.nombre,
      composicion: op.composicion,
      precio_venta: op.precioVenta,
      costo_produccion: op.costoProduccion,
      saldo_presupuesto: op.saldoPresupuesto,
      estado: '✅ Guardado'
    });

    if (inputNombre) inputNombre.value = '';
    await refreshAll();
    showToast(`✅ Combo "${nombreCombo}" guardado en Supabase`);
  } catch (err) {
    showToast('❌ Error: ' + err.message);
  }
}

async function updateComboNombre(id, nuevoNombre) {
  const clean = String(nuevoNombre || '').trim();
  if (!clean) {
    await refreshAll();
    return;
  }
  try {
    await DB3D.updateComboNombre(id, clean);
    await refreshAll();
    showToast('Nombre del combo actualizado');
  } catch (err) {
    showToast('❌ Error: ' + err.message);
  }
}

async function deleteComboGuardado(id) {
  try {
    await DB3D.deleteComboGuardado(id);
    await refreshAll();
    showToast('Combo eliminado del historial');
  } catch (err) {
    showToast('❌ Error: ' + err.message);
  }
}

/* ============================================================================
   4. TAB: GESTIÓN DE CLIENTES Y PEDIDOS (Multi-artículo + Combos Guardados)
   ============================================================================ */
function renderPedidos(pedidos, pedidoItems, registroCalc, combosGuardados) {
  window.__lastRegistroCalc = registroCalc;
  window.__lastCombosGuardados = combosGuardados;

  const itemsPorPedido = new Map();
  for (const it of pedidoItems) {
    if (!itemsPorPedido.has(it.pedido_id)) itemsPorPedido.set(it.pedido_id, []);
    itemsPorPedido.get(it.pedido_id).push(it);
  }

  let totalFacturado = 0;
  let totalEnCurso = 0;

  for (const p of pedidos) {
    const items = itemsPorPedido.get(p.id) || [];
    const totalPed = items.reduce(
      (acc, it) => acc + Engine3D.excelRound(Number(it.cantidad) * Number(it.precio_unitario), 2),
      0
    );
    if (p.estado === 'Entregado') totalFacturado += totalPed;
    if (p.estado === 'Pendiente' || p.estado === 'En Producción' || p.estado === 'Listo para Entrega') {
      totalEnCurso += totalPed;
    }
  }

  document.getElementById('kpi-ped-total').textContent = pedidos.length;
  document.getElementById('kpi-ped-entregado').textContent = fmtUYU(totalFacturado);
  document.getElementById('kpi-ped-curso').textContent = fmtUYU(totalEnCurso);

  renderPedidoDraft(registroCalc, combosGuardados);

  const estados = ['Pendiente', 'En Producción', 'Listo para Entrega', 'Entregado', 'Cancelado'];
  const tbody = document.getElementById('tbody-pedidos');
  tbody.innerHTML = pedidos.map(p => {
    const items = itemsPorPedido.get(p.id) || [];
    const totalPedido = items.reduce(
      (acc, it) => acc + Engine3D.excelRound(Number(it.cantidad) * Number(it.precio_unitario), 2),
      0
    );

    const detalleHtml = items.map(it => {
      const esCombo = it.tipo_item === 'combo';
      const badgeClass = esCombo ? 'badge-amber' : 'badge-blue';
      const badgeLabel = esCombo ? `🎁 ${escHtml(it.ref_id)}` : escHtml(it.ref_id);
      const subItem = Engine3D.excelRound(Number(it.cantidad) * Number(it.precio_unitario), 2);
      return `
        <div class="pedido-item-chip">
          <span class="badge ${badgeClass}">${badgeLabel}</span>
          <strong>${escHtml(it.descripcion)}</strong>
          <span style="color:var(--text-muted);">×</span>
          <input type="number" class="inline-input" style="width:62px;" min="1" step="1" value="${it.cantidad}"
            onchange="updatePedidoItemCant(${it.id}, this.value)" title="Cantidad">
          <span style="color:var(--text-muted);">@</span>
          <input type="number" class="inline-input" style="width:84px;" min="0" step="0.01" value="${Number(it.precio_unitario).toFixed(2)}"
            onchange="updatePedidoItemPrecio(${it.id}, this.value)" title="Precio unitario">
          <span style="color:var(--accent); font-weight:700;">= ${fmtUYU(subItem)}</span>
          ${items.length > 1 ? `<button type="button" class="btn btn-danger" style="padding:0.15rem 0.4rem;" onclick="deletePedidoItem(${it.id})" title="Quitar ítem">✕</button>` : ''}
        </div>
      `;
    }).join('');

    return `
      <tr>
        <td><strong>${escHtml(p.id)}</strong></td>
        <td>${escHtml(p.fecha)}</td>
        <td><strong>${escHtml(p.cliente)}</strong></td>
        <td><div class="pedido-items-list">${detalleHtml || '<span style="color:var(--text-muted);">Sin ítems</span>'}</div></td>
        <td class="num" style="color: var(--accent); font-weight: 800; font-size:0.95rem;">${fmtUYU(totalPedido)}</td>
        <td>
          <select class="inline-select" onchange="updatePedidoEstado('${escHtml(p.id)}', this.value)">
            ${estados.map(est => `<option value="${est}" ${p.estado === est ? 'selected' : ''}>${est}</option>`).join('')}
          </select>
        </td>
        <td class="center">
          <button class="btn btn-danger" onclick="deletePedido('${escHtml(p.id)}')">🗑️</button>
        </td>
      </tr>
    `;
  }).join('');
}

function renderPedidoDraft(registroCalc, combosGuardados) {
  const tbody = document.getElementById('tbody-ped-draft');
  if (!tbody) return;

  let totalDraft = 0;
  let totalPiezas = 0;
  let validos = 0;

  tbody.innerHTML = pedidoDraftLineas.map((linea, idx) => {
    const sub = Engine3D.excelRound(Number(linea.cantidad || 1) * Number(linea.precioUnitario || 0), 2);
    if (linea.refId) {
      totalDraft += sub;
      totalPiezas += Number(linea.cantidad || 1);
      validos += 1;
    }

    const opcionesHtml = linea.tipo === 'combo'
      ? `<option value="">-- Elegir combo guardado --</option>` +
        combosGuardados.map(c => {
          const val = `CMB-${c.id}`;
          const label = `🎁 ${c.nombre_combo || c.opcion_elegida} (${fmtUYU(c.precio_venta)}) — ${c.composicion}`;
          return `<option value="${val}" ${linea.refId === val ? 'selected' : ''}>${escHtml(label)}</option>`;
        }).join('')
      : `<option value="">-- Elegir artículo del catálogo --</option>` +
        registroCalc.map(r => {
          const label = `${r.id_articulo} | ${r.nombre_articulo} (${fmtUYU(r.precioVentaUnit)} / u.)`;
          return `<option value="${escHtml(r.id_articulo)}" ${linea.refId === r.id_articulo ? 'selected' : ''}>${escHtml(label)}</option>`;
        }).join('');

    return `
      <tr>
        <td>
          <select class="inline-select" onchange="changePedidoDraftTipo(${idx}, this.value)">
            <option value="articulo" ${linea.tipo === 'articulo' ? 'selected' : ''}>📦 Artículo</option>
            <option value="combo" ${linea.tipo === 'combo' ? 'selected' : ''}>🎁 Combo</option>
          </select>
        </td>
        <td>
          <select style="width:100%;" onchange="selectPedidoDraftItem(${idx}, this.value)">
            ${opcionesHtml}
          </select>
        </td>
        <td class="num">
          <input type="number" class="inline-input" min="1" step="1" value="${linea.cantidad}"
            onchange="updatePedidoDraftCant(${idx}, this.value)">
        </td>
        <td class="num">
          <input type="number" class="inline-input" style="width:105px;" min="0" step="0.01" value="${Number(linea.precioUnitario).toFixed(2)}"
            onchange="updatePedidoDraftPrecio(${idx}, this.value)">
        </td>
        <td class="num" style="color:var(--accent); font-weight:700;">${fmtUYU(sub)}</td>
        <td class="center">
          <button type="button" class="btn btn-danger" onclick="removePedidoDraftLinea(${idx})" title="Quitar línea">✕</button>
        </td>
      </tr>
    `;
  }).join('');

  document.getElementById('ped-draft-resumen').textContent = `${validos} ítem(s) / ${totalPiezas} unidad(es)`;
  document.getElementById('ped-draft-total').textContent = `Total: ${fmtUYU(totalDraft)}`;
}

function addPedidoDraftLinea(tipo = 'articulo') {
  if (tipo === 'combo' && (!window.__lastCombosGuardados || window.__lastCombosGuardados.length === 0)) {
    showToast('⚠️ Aún no tenés combos guardados. Creá y guardá uno en "Armador de Combos".');
    return;
  }
  pedidoDraftLineas.push({ tipo, refId: '', cantidad: 1, precioUnitario: 0 });
  renderPedidoDraft(window.__lastRegistroCalc || [], window.__lastCombosGuardados || []);
}

function removePedidoDraftLinea(idx) {
  if (pedidoDraftLineas.length <= 1) {
    pedidoDraftLineas = [{ tipo: 'articulo', refId: '', cantidad: 1, precioUnitario: 0 }];
  } else {
    pedidoDraftLineas.splice(idx, 1);
  }
  renderPedidoDraft(window.__lastRegistroCalc || [], window.__lastCombosGuardados || []);
}

function changePedidoDraftTipo(idx, nuevoTipo) {
  pedidoDraftLineas[idx] = { tipo: nuevoTipo, refId: '', cantidad: 1, precioUnitario: 0 };
  renderPedidoDraft(window.__lastRegistroCalc || [], window.__lastCombosGuardados || []);
}

function selectPedidoDraftItem(idx, refId) {
  const linea = pedidoDraftLineas[idx];
  linea.refId = refId;
  if (!refId) {
    linea.precioUnitario = 0;
  } else if (linea.tipo === 'combo') {
    const idNum = Number(String(refId).replace('CMB-', ''));
    const cmb = (window.__lastCombosGuardados || []).find(c => Number(c.id) === idNum);
    if (cmb) {
      linea.precioUnitario = Number(cmb.precio_venta);
    }
  } else {
    const art = (window.__lastRegistroCalc || []).find(r => r.id_articulo === refId);
    if (art) {
      linea.precioUnitario = Number(art.precioVentaUnit);
    }
  }
  renderPedidoDraft(window.__lastRegistroCalc || [], window.__lastCombosGuardados || []);
}

function updatePedidoDraftCant(idx, val) {
  pedidoDraftLineas[idx].cantidad = Math.max(1, Math.floor(Number(val) || 1));
  renderPedidoDraft(window.__lastRegistroCalc || [], window.__lastCombosGuardados || []);
}

function updatePedidoDraftPrecio(idx, val) {
  pedidoDraftLineas[idx].precioUnitario = Math.max(0, Number(val) || 0);
  renderPedidoDraft(window.__lastRegistroCalc || [], window.__lastCombosGuardados || []);
}

async function handleAddPedido(e) {
  e.preventDefault();
  const fecha = document.getElementById('ped-fecha').value || new Date().toISOString().slice(0, 10);
  const cliente = document.getElementById('ped-cliente').value.trim();
  const estado = document.getElementById('ped-estado').value;

  const lineasValidas = pedidoDraftLineas.filter(l => l.refId && l.cantidad >= 1);
  if (!cliente) {
    showToast('⚠️ Ingresá el nombre del cliente');
    return;
  }
  if (lineasValidas.length === 0) {
    showToast('⚠️ Agregá al menos un artículo o combo guardado al pedido');
    return;
  }

  try {
    const nextId = await DB3D.getNextPedidoId();
    const itemsToInsert = lineasValidas.map(l => {
      let descripcion = l.refId;
      if (l.tipo === 'combo') {
        const idNum = Number(String(l.refId).replace('CMB-', ''));
        const cmb = (window.__lastCombosGuardados || []).find(c => Number(c.id) === idNum);
        if (cmb) {
          descripcion = `${cmb.nombre_combo || cmb.opcion_elegida} [${cmb.composicion}]`;
        }
      } else {
        const art = (window.__lastRegistroCalc || []).find(r => r.id_articulo === l.refId);
        if (art) {
          descripcion = art.nombre_articulo;
        }
      }

      return {
        pedido_id: nextId,
        tipo_item: l.tipo,
        ref_id: l.refId,
        descripcion,
        cantidad: l.cantidad,
        precio_unitario: l.precioUnitario
      };
    });

    await DB3D.insertPedidoWithItems({ id: nextId, fecha, cliente, estado }, itemsToInsert);

    e.target.reset();
    document.getElementById('ped-fecha').value = new Date().toISOString().slice(0, 10);
    pedidoDraftLineas = [{ tipo: 'articulo', refId: '', cantidad: 1, precioUnitario: 0 }];
    await refreshAll();
    showToast(`✅ Pedido ${nextId} para ${cliente} (${lineasValidas.length} ítem/s) creado`);
  } catch (err) {
    showToast('❌ Error: ' + err.message);
  }
}

async function updatePedidoItemCant(itemId, cant) {
  try {
    const c = Math.max(1, Math.floor(Number(cant) || 1));
    await DB3D.updatePedidoItem(itemId, { cantidad: c });
    await refreshAll();
    showToast('Cantidad del ítem actualizada');
  } catch (err) {
    showToast('❌ Error: ' + err.message);
  }
}

async function updatePedidoItemPrecio(itemId, precio) {
  try {
    const p = Math.max(0, Number(precio) || 0);
    await DB3D.updatePedidoItem(itemId, { precio_unitario: p });
    await refreshAll();
    showToast('Precio del ítem actualizado');
  } catch (err) {
    showToast('❌ Error: ' + err.message);
  }
}

async function deletePedidoItem(itemId) {
  try {
    await DB3D.deletePedidoItem(itemId);
    await refreshAll();
    showToast('Ítem quitado del pedido');
  } catch (err) {
    showToast('❌ Error: ' + err.message);
  }
}

async function updatePedidoEstado(id, estado) {
  try {
    await DB3D.updatePedidoEstado(id, estado);
    await refreshAll();
    showToast(`Estado de ${id}: ${estado}`);
  } catch (err) {
    showToast('❌ Error: ' + err.message);
  }
}

async function deletePedido(id) {
  try {
    await DB3D.deletePedido(id);
    await refreshAll();
    showToast(`Pedido ${id} eliminado`);
  } catch (err) {
    showToast('❌ Error: ' + err.message);
  }
}

/* ============================================================================
   5. TAB: MEDICIONES REALES (_EscalasReales)
   ============================================================================ */
function renderEscalasReales(escalasReales, params) {
  const tbody = document.getElementById('tbody-escalas-reales');
  tbody.innerHTML = escalasReales.map(e => {
    const cUnit = Engine3D.calcularCostoBaseUnitario(
      e.cantidad, e.gramos_lote, e.tiempo_impresion_lote_h,
      e.tiempo_preparacion_lote_h, e.tiempo_postprocesado_unit_h, params
    );
    const pVenta = Engine3D.excelRound(cUnit * e.factor_multiplicador, 2);
    return `
      <tr>
        <td>${escHtml(e.fecha)}</td>
        <td><span class="badge badge-blue">${escHtml(e.id_articulo)}</span></td>
        <td><strong>${escHtml(e.nombre_articulo)}</strong></td>
        <td class="num">${e.cantidad} u.</td>
        <td class="num">
          <input type="number" class="inline-input" step="0.01" value="${Number(e.gramos_lote).toFixed(2)}"
            onchange="updateEscalaReal(${e.id}, 'gramos_lote', this.value)">
        </td>
        <td class="num">
          <input type="text" class="hhmm-input inline-hhmm" value="${Engine3D.hoursToHHMM(e.tiempo_impresion_lote_h)}"
            onchange="updateEscalaRealTime(${e.id}, 'tiempo_impresion_lote_h', this)">
        </td>
        <td class="num">
          <input type="text" class="hhmm-input inline-hhmm" value="${Engine3D.hoursToHHMM(e.tiempo_preparacion_lote_h)}"
            onchange="updateEscalaRealTime(${e.id}, 'tiempo_preparacion_lote_h', this)">
        </td>
        <td class="num">
          <input type="text" class="hhmm-input inline-hhmm" value="${Engine3D.hoursToHHMM(e.tiempo_postprocesado_unit_h)}"
            onchange="updateEscalaRealTime(${e.id}, 'tiempo_postprocesado_unit_h', this)">
        </td>
        <td class="num"><strong>${fmtUYU(cUnit)}</strong></td>
        <td class="num" style="color: var(--accent); font-weight: 700;">${fmtUYU(pVenta)}</td>
        <td class="center">
          <button class="btn btn-danger" onclick="deleteEscalaReal(${e.id})">🗑️</button>
        </td>
      </tr>
    `;
  }).join('');
}

async function handleAddEscalaReal(e) {
  e.preventDefault();
  const fecha = document.getElementById('esc-fecha').value || new Date().toISOString().slice(0, 10);
  const nombreRaw = document.getElementById('esc-art').value.trim();
  const cantidad = Math.max(1, Math.floor(Number(document.getElementById('esc-cant').value) || 1));
  const gramos = Number(document.getElementById('esc-gramos').value) || 0;
  const impH = Engine3D.hhmmToHours(document.getElementById('esc-imp').value);
  const prepParsed = Engine3D.hhmmToHours(document.getElementById('esc-prep').value);
  const postParsed = Engine3D.hhmmToHours(document.getElementById('esc-post').value);
  const factor = Number(document.getElementById('esc-factor').value) || 2.5;

  if (!nombreRaw || gramos <= 0 || !Number.isFinite(impH) || impH <= 0) {
    showToast('⚠️ Verificá el artículo, gramos y tiempo de impresión en formato hh:mm');
    return;
  }

  try {
    const artObj = await DB3D.getOrCreateArticulo(nombreRaw);

    await DB3D.insertEscalaReal({
      fecha,
      id_articulo: artObj.id_articulo,
      cantidad,
      gramos_lote: gramos,
      tiempo_impresion_lote_h: impH,
      tiempo_preparacion_lote_h: Number.isFinite(prepParsed) ? prepParsed : 0,
      tiempo_postprocesado_unit_h: Number.isFinite(postParsed) ? postParsed : 0,
      factor_multiplicador: factor
    });

    e.target.reset();
    document.getElementById('esc-fecha').value = new Date().toISOString().slice(0, 10);
    document.getElementById('esc-cant').value = 1;
    document.getElementById('esc-prep').value = '00:05';
    document.getElementById('esc-post').value = '00:00';
    document.getElementById('esc-factor').value = '2.5';
    await refreshAll();
    showToast(`✅ Medición BambuStudio guardada (${artObj.id_articulo} | ${artObj.nombre} x${cantidad})`);
  } catch (err) {
    showToast('❌ Error: ' + err.message);
  }
}

async function updateEscalaReal(id, col, val) {
  const allowed = ['gramos_lote'];
  if (!allowed.includes(col)) return;
  try {
    await DB3D.updateEscalaRealField(id, { [col]: Math.max(0, Number(val) || 0) });
    await refreshAll();
    showToast('Medición actualizada en Supabase');
  } catch (err) {
    showToast('❌ Error: ' + err.message);
  }
}

async function updateEscalaRealTime(id, col, inputEl) {
  const allowed = ['tiempo_impresion_lote_h', 'tiempo_preparacion_lote_h', 'tiempo_postprocesado_unit_h'];
  if (!allowed.includes(col)) return;
  const h = Engine3D.hhmmToHours(inputEl.value);
  if (!Number.isFinite(h) || h < 0) {
    showToast('⚠️ Formato inválido. Usá hh:mm (ej: 01:30)');
    await refreshAll();
    return;
  }
  try {
    await DB3D.updateEscalaRealField(id, { [col]: h });
    await refreshAll();
    showToast('Tiempo actualizado (hh:mm)');
  } catch (err) {
    showToast('❌ Error: ' + err.message);
  }
}

async function deleteEscalaReal(id) {
  try {
    await DB3D.deleteEscalaReal(id);
    await refreshAll();
    showToast('Medición eliminada');
  } catch (err) {
    showToast('❌ Error: ' + err.message);
  }
}

/* ============================================================================
   6. TAB: PARÁMETROS BASE (URUGUAY)
   ============================================================================ */
function renderParametros(paramRows) {
  const tbody = document.getElementById('tbody-parametros');
  tbody.innerHTML = paramRows.map(p => `
    <tr>
      <td><strong>${escHtml(p.parametro)}</strong></td>
      <td class="num">
        <input type="number" class="inline-input" style="width: 110px; font-weight: 700;" step="any" value="${p.valor}"
          onchange="updateParametro('${escHtml(p.clave)}', this.value)">
      </td>
      <td>${escHtml(p.unidad)}</td>
      <td><span class="badge badge-blue">${escHtml(p.base)}</span></td>
      <td style="color: var(--text-muted);">${escHtml(p.notas || '')}</td>
    </tr>
  `).join('');
}

async function updateParametro(clave, valor) {
  try {
    await DB3D.updateParametro(clave, Number(valor) || 0);
    await refreshAll();
    showToast('Parámetro actualizado — Todos los costos recalculados');
  } catch (err) {
    showToast('❌ Error: ' + err.message);
  }
}

/* ============================================================================
   NAVEGACIÓN DE PESTAÑAS E INICIALIZACIÓN
   ============================================================================ */
document.addEventListener('DOMContentLoaded', async () => {
  // Tabs
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
      document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
      btn.classList.add('active');
      document.getElementById(btn.dataset.target).classList.add('active');
    });
  });

  // Fechas por defecto
  const hoy = new Date().toISOString().slice(0, 10);
  document.getElementById('ped-fecha').value = hoy;
  document.getElementById('esc-fecha').value = hoy;

  // Inicializar Supabase
  try {
    await DB3D.init();
    document.getElementById('db-status-badge').textContent = '🟢 Supabase Conectado (PostgreSQL)';
    await refreshAll();
  } catch (err) {
    console.error(err);
    document.getElementById('db-status-badge').textContent = '🔴 Error conectando a Supabase';
    showToast('⚠️ Configurá SUPABASE_URL y SUPABASE_ANON_KEY en db.js');
  }
});
