/**
 * =============================================================================
 * CONTROLADOR DE INTERFAZ — v2
 * Estado central, renderizado por módulos y delegación de eventos.
 * La lógica de negocio vive en engine.js; la persistencia en db.js.
 * =============================================================================
 */

'use strict';

const estado = {
  datos: { parametros: [], articulos: [], mediciones: [], registro: [], combos: [], pedidos: [] },
  parametros: {},
  filasCalculadas: [],
  combo: { presupuesto: 3278, factor: '2', lineas: [], opciones: [], items: [] },
  borradorPedido: [{ tipo: 'articulo', refId: '', cantidad: 1, precioUnitario: 0 }],
  comboInicializado: false,
  grafico: null,
  ultimaCotizacion: null
};

const ESTADOS_PEDIDO = ['Pendiente', 'En Producción', 'Listo para Entrega', 'Entregado', 'Cancelado'];

/* ============================ utilidades ================================= */

function esc(valor) {
  return String(valor ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function dinero(valor) {
  const n = new Intl.NumberFormat('es-UY', {
    minimumFractionDigits: 2, maximumFractionDigits: 2
  }).format(Number(valor || 0));
  return `$ ${n}`;
}

function porcentaje(valor) {
  return `${(Number(valor || 0) * 100).toFixed(1)} %`;
}

let timerToast;
function avisar(mensaje, tipo = 'info') {
  const el = document.getElementById('toast');
  el.textContent = mensaje;
  el.className = `toast visible ${tipo}`;
  clearTimeout(timerToast);
  timerToast = setTimeout(() => { el.className = 'toast'; }, 3200);
}

function fijarEstadoBD(texto, clase) {
  const el = document.getElementById('estado-bd');
  el.textContent = texto;
  el.className = `estado-bd ${clase}`;
}

function hoyISO() {
  return new Date().toISOString().slice(0, 10);
}

/** Desglose de un pedido: subtotal, IVA (22 % si es con factura) y total. */
function totalesPedido(items, conFactura) {
  const subtotal = (items || []).reduce((suma, it) =>
    suma + Calc.round(Number(it.cantidad) * Number(it.precioUnitario), 2), 0);
  return Calc.conIVA(subtotal, conFactura);
}

function articuloPorId(id) {
  return estado.datos.articulos.find(a => String(a.id) === String(id));
}

function comboPorId(id) {
  return estado.datos.combos.find(c => String(c.id) === String(id));
}

/** Resuelve un código ART-XXX o un id numérico a id numérico. */
function idArticuloDesde(valor) {
  if (valor === '' || valor === null || valor === undefined) return '';
  const porCodigo = estado.datos.articulos.find(a => a.codigo === valor);
  if (porCodigo) return porCodigo.id;
  const porId = articuloPorId(valor);
  return porId ? porId.id : '';
}

/* ============================ carga general ============================== */

async function recargar() {
  estado.datos = await DataStore.cargarTodo();
  estado.parametros = Calc.leerParametros(estado.datos.parametros);
  estado.filasCalculadas = estado.datos.registro.map(fila =>
    Calc.calcularFila(fila, estado.datos.mediciones, estado.datos.registro, estado.parametros)
  );
  sembrarCombo();
  renderizarTodo();
}

function sembrarCombo() {
  if (estado.comboInicializado) return;
  const semilla = [
    ['ART-002', 15], ['ART-003', 10], ['ART-004', 12], ['ART-005', 3]
  ];
  estado.combo.lineas = semilla.map(([codigo, manual]) => ({
    articuloId: idArticuloDesde(codigo),
    manualCant: manual
  }));
  estado.comboInicializado = true;
}

function renderizarTodo() {
  renderizarCatalogo();
  renderizarCotizador();
  renderizarCombos();
  renderizarPedidos();
  renderizarMediciones();
  renderizarParametros();

  document.getElementById('lista-articulos').innerHTML = estado.datos.articulos
    .map(a => `<option value="${esc(a.nombre)}">`).join('');
  document.getElementById('lista-clientes').innerHTML = [...new Set(
    estado.datos.pedidos.map(p => p.cliente).filter(Boolean)
  )].map(c => `<option value="${esc(c)}">`).join('');

  actualizarPreviewId();
}

async function actualizarPreviewId() {
  const badge = document.getElementById('next-art-id');
  if (!badge) return;
  const nombre = (document.getElementById('art-nombre')?.value || '')
    .replace(/^ART-\d+\s*\|\s*/i, '').trim();
  if (nombre && estado.datos.articulos.some(a => a.nombre.toLowerCase() === nombre.toLowerCase())) {
    const existente = estado.datos.articulos.find(a => a.nombre.toLowerCase() === nombre.toLowerCase());
    badge.textContent = `🔒 ${existente.codigo} (existente)`;
    return;
  }
  const max = estado.datos.articulos.reduce((m, a) => Math.max(m, Number(a.id) || 0), 0);
  badge.textContent = `🔒 ART-${String(max + 1).padStart(3, '0')}`;
}

/* ====================== MÓDULO 1: CATÁLOGO =============================== */

function renderizarCatalogo() {
  const tbody = document.getElementById('body-catalogo');
  const factores = [1.5, 2, 2.5, 3, 4, 5];

  tbody.innerHTML = estado.filasCalculadas.map(fila => {
    const opciones = factores.includes(fila.factor)
      ? factores
      : [...factores, fila.factor].sort((a, b) => a - b);
    return `
      <tr>
        <td>${esc(fila.fecha)}</td>
        <td><span class="etiqueta etiqueta-azul" title="Generado por PostgreSQL">${esc(fila.codigo)}</span></td>
        <td><input class="entrada-inline nombre-inline" value="${esc(fila.nombre)}"
              data-campo="reg-nombre" data-id="${fila.id}" title="Editar nombre"></td>
        <td class="num"><input type="number" class="entrada-inline" min="1" step="1" value="${fila.cantidad}"
              data-campo="reg-cantidad" data-id="${fila.id}"></td>
        <td class="num">${fila.gramosLote.toFixed(2)} g</td>
        <td class="num">${fila.impresionHHMM}</td>
        <td class="num">${fila.preparacionHHMM}</td>
        <td class="num">${fila.postHHMM}</td>
        <td class="num">${fila.tiempoTotalHHMM}</td>
        <td class="num"><strong>${dinero(fila.costoUnit)}</strong></td>
        <td class="num">${dinero(fila.costoLote)}</td>
        <td class="num">
          <select class="entrada-inline" data-campo="reg-factor" data-id="${fila.id}">
            ${opciones.map(f => `<option value="${f}" ${fila.factor === f ? 'selected' : ''}>${f.toFixed(1)}×</option>`).join('')}
          </select>
        </td>
        <td class="num texto-acento negrita">${dinero(fila.precioUnit)}</td>
        <td class="num texto-verde">${dinero(fila.gananciaUnit)}</td>
        <td class="num">${porcentaje(fila.margen)}</td>
        <td class="num">
          <span class="etiqueta ${fila.medido1u ? 'etiqueta-verde' : 'etiqueta-alerta'}">
            ${fila.medido1u ? '🟢' : '🟠'} ${dinero(fila.costo1u)}
          </span>
        </td>
        <td class="num">${dinero(fila.precio1u)}</td>
        <td class="centrado"><span class="etiqueta etiqueta-azul">${esc(fila.puntoEquilibrio)}</span></td>
        <td class="centrado"><button type="button" class="boton boton-peligro" data-action="borrar-registro" data-id="${fila.id}" title="Eliminar fila">✕</button></td>
      </tr>`;
  }).join('') || `<tr><td colspan="19" class="vacio">No hay artículos en el catálogo.</td></tr>`;
}

async function manejarArticulo(evento) {
  evento.preventDefault();
  const nombre = document.getElementById('art-nombre').value.trim();
  const cantidad = Math.max(1, Math.floor(Number(document.getElementById('art-cantidad').value) || 1));
  const factor = Number(document.getElementById('art-factor').value) || 2.5;
  const gramos = Number(document.getElementById('art-gramos').value) || 0;

  const tiempos = {
    impresion: Calc.aHoras(document.getElementById('art-impresion').value),
    preparacion: Calc.aHoras(document.getElementById('art-preparacion').value),
    post: Calc.aHoras(document.getElementById('art-post').value)
  };
  for (const [nombreTiempo, horas] of Object.entries(tiempos)) {
    if (horas === null) continue;
    if (!Number.isFinite(horas) || horas < 0) {
      avisar(`⚠️ Tiempo de ${nombreTiempo} inválido. Usá hh:mm (ej: 02:30)`, 'error');
      return;
    }
  }
  if (!nombre) return;

  try {
    const articulo = await DataStore.obtenerOCrearArticulo(nombre);
    if (gramos > 0 && Number.isFinite(tiempos.impresion) && tiempos.impresion > 0) {
      await DataStore.guardarMedicion({
        fecha: hoyISO(),
        articuloId: articulo.id,
        cantidad,
        gramos,
        impresionH: tiempos.impresion,
        preparacionH: Number.isFinite(tiempos.preparacion) ? tiempos.preparacion : 0,
        postUnitH: Number.isFinite(tiempos.post) ? tiempos.post : 0,
        factor
      });
    }
    await DataStore.agregarRegistro(articulo.id, cantidad, factor);
    evento.target.reset();
    document.getElementById('art-cantidad').value = 1;
    document.getElementById('art-factor').value = '2.5';
    await recargar();
    avisar(`✅ ${articulo.codigo} — ${articulo.nombre} agregado al catálogo`, 'exito');
  } catch (error) {
    avisar(`❌ ${error.message}`, 'error');
  }
}

/* ====================== MÓDULO 2: COTIZADOR ============================== */

function cotizacionActual() {
  const id = document.getElementById('cot-articulo').value;
  const articulo = articuloPorId(id);
  if (!articulo) return null;

  const imp = Calc.aHoras(document.getElementById('cot-impresion').value);
  const prep = Calc.aHoras(document.getElementById('cot-preparacion').value);

  return Calc.cotizar({
    articuloId: articulo.id,
    codigo: articulo.codigo,
    nombre: articulo.nombre,
    cantidad: Number(document.getElementById('cot-cantidad').value) || 1,
    factor: Number(document.getElementById('cot-factor').value) || 2.5,
    gramosManual: Number(document.getElementById('cot-gramos').value) || 0,
    impManualH: Number.isFinite(imp) ? imp : 0,
    prepManualH: Number.isFinite(prep) ? prep : null
  }, estado.datos.mediciones, estado.parametros);
}

function renderizarCotizador() {
  const select = document.getElementById('cot-articulo');
  const anterior = select.value;
  select.innerHTML = estado.datos.articulos.map(a =>
    `<option value="${a.id}">${esc(a.codigo)} | ${esc(a.nombre)}</option>`
  ).join('');

  if (anterior && articuloPorId(anterior)) {
    select.value = anterior;
  } else {
    const preferido = estado.datos.articulos.find(a => a.codigo === 'ART-006') || estado.datos.articulos[0];
    if (preferido) select.value = preferido.id;
  }
  actualizarCotizador();
}

function actualizarCotizador() {
  const cot = cotizacionActual();
  if (!cot) return;
  estado.ultimaCotizacion = cot;

  const cls = cot.esReal ? 'etiqueta-verde' : 'etiqueta-alerta';
  const estadoEl = document.getElementById('cot-estado');
  estadoEl.textContent = cot.estado;
  estadoEl.className = `etiqueta ${cls}`;
  const origenEl = document.getElementById('cot-origen');
  origenEl.textContent = cot.origen;
  origenEl.className = `etiqueta ${cls}`;

  const poner = (id, texto) => { document.getElementById(id).textContent = texto; };
  poner('cot-gramos-activos', `${cot.gramosActivos.toFixed(2)} g`);
  poner('cot-impresion-activa', cot.impresionActivaHHMM);
  poner('cot-prep-unit', `${cot.prepUnitHHMM} / u.`);
  poner('cot-post-unit', `${cot.postUnitHHMM} / u.`);
  poner('cot-tiempos', `${cot.tiempoUnitHHMM} / u. (${cot.tiempoLoteHHMM} lote)`);
  poner('cot-costo-unit', dinero(cot.costoUnit));
  poner('cot-costo-lote', dinero(cot.costoLote));
  poner('cot-precio-unit', dinero(cot.precioUnit));
  poner('cot-precio-lote', dinero(cot.precioLote));
  poner('cot-ganancia', `${dinero(cot.gananciaUnit)} / u. (${dinero(cot.gananciaLote)} lote)`);
  poner('cot-comp-1u', `${dinero(cot.compVenta1u)} (ref. suelta)`);
  poner('cot-pe', cot.puntoEquilibrio);

  document.getElementById('body-escalas').innerHTML = cot.escalas.map(e => `
    <tr>
      <td class="num"><strong>${e.unidades} u.</strong></td>
      <td><span class="etiqueta ${e.esReal ? 'etiqueta-verde' : 'etiqueta-alerta'}">${e.origen}</span></td>
      <td class="num">${dinero(e.prepPieza)}</td>
      <td class="num"><strong>${dinero(e.costoUnit)}</strong></td>
      <td class="num texto-acento negrita">${dinero(e.precioUnit)}</td>
      <td class="num">${dinero(e.costoLote)}</td>
      <td class="centrado"><span class="etiqueta etiqueta-azul">${e.puntoEquilibrio}</span></td>
    </tr>`).join('');

  dibujarGrafico(cot.escalas, `${cot.codigo} | ${cot.nombre}`);
}

function dibujarGrafico(escalas, etiqueta) {
  if (typeof Chart === 'undefined') return;
  const lienzo = document.getElementById('grafico-escalas');
  if (!lienzo) return;
  if (estado.grafico) estado.grafico.destroy();

  estado.grafico = new Chart(lienzo, {
    type: 'line',
    data: {
      labels: escalas.map(e => `${e.unidades} u.`),
      datasets: [
        {
          label: 'Costo base unitario ($ UYU)',
          data: escalas.map(e => e.costoUnit),
          borderColor: '#f0a742',
          backgroundColor: 'rgba(240,167,66,.14)',
          tension: .28, fill: true, borderWidth: 2.5, pointRadius: 3
        },
        {
          label: 'Precio de venta unitario ($ UYU)',
          data: escalas.map(e => e.precioUnit),
          borderColor: '#31d1e8',
          backgroundColor: 'rgba(49,209,232,.12)',
          tension: .28, fill: true, borderWidth: 2.5, pointRadius: 3
        }
      ]
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      interaction: { intersect: false, mode: 'index' },
      plugins: {
        legend: { labels: { color: '#cbd5e1', usePointStyle: true } },
        title: { display: true, text: `Costo vs. precio por escala — ${etiqueta}`, color: '#e2e8f0' }
      },
      scales: {
        x: { ticks: { color: '#94a3b8' }, grid: { color: 'rgba(148,163,184,.12)' } },
        y: { ticks: { color: '#94a3b8' }, grid: { color: 'rgba(148,163,184,.12)' } }
      }
    }
  });
}

async function guardarMedicionDelCotizador() {
  const cot = estado.ultimaCotizacion;
  if (!cot) return;
  const gramos = Number(document.getElementById('cot-gramos').value) || 0;
  const imp = Calc.aHoras(document.getElementById('cot-impresion').value);
  if (gramos <= 0 || !Number.isFinite(imp) || imp <= 0) {
    avisar('⚠️ Ingresá gramos y tiempo de impresión válidos', 'error');
    return;
  }
  try {
    await DataStore.guardarMedicion({
      fecha: hoyISO(),
      articuloId: cot.articuloId,
      cantidad: cot.cantidad,
      gramos,
      impresionH: imp,
      preparacionH: Number.isFinite(Calc.aHoras(document.getElementById('cot-preparacion').value))
        ? Calc.aHoras(document.getElementById('cot-preparacion').value) : 0,
      postUnitH: 0,
      factor: cot.factor
    });
    ['cot-gramos', 'cot-impresion', 'cot-preparacion'].forEach(id => { document.getElementById(id).value = ''; });
    await recargar();
    avisar(`✅ Medición guardada para ${cot.codigo} (${cot.cantidad} u.)`, 'exito');
  } catch (error) {
    avisar(`❌ ${error.message}`, 'error');
  }
}

/* ======================== MÓDULO 3: COMBOS =============================== */

function calcularCombos() {
  const resultado = Calc.calcularCombos(
    estado.combo.presupuesto,
    estado.combo.factor,
    estado.combo.lineas,
    estado.filasCalculadas,
    estado.datos.mediciones,
    estado.parametros
  );
  estado.combo.opciones = resultado.opciones;
  estado.combo.items = resultado.items;
  return resultado;
}

function renderizarCombos() {
  const resultado = calcularCombos();

  document.getElementById('body-combo-lineas').innerHTML = estado.combo.lineas.map((linea, i) => {
    const item = resultado.items.find(x => x.slot === i);
    return `
      <tr>
        <td>
          <select class="entrada-inline ancho-220" data-campo="combo-linea-art" data-indice="${i}">
            <option value="">— Seleccionar artículo —</option>
            ${estado.filasCalculadas.map(f =>
              `<option value="${f.articuloId}" ${String(linea.articuloId) === String(f.articuloId) ? 'selected' : ''}>${esc(f.etiqueta)}</option>`
            ).join('')}
          </select>
        </td>
        <td class="num">${item ? item.factorAplicado.toFixed(1) + '×' : '—'}</td>
        <td class="num">${item ? dinero(item.costoBase1u) : '—'}</td>
        <td class="num">${item ? dinero(item.precioRef1u) : '—'}</td>
        <td class="num"><span class="etiqueta etiqueta-azul">${item ? item.op1 : 0}</span></td>
        <td class="num"><span class="etiqueta etiqueta-verde">${item ? item.op2 : 0}</span></td>
        <td class="num"><span class="etiqueta etiqueta-alerta">${item ? item.op3 : 0}</span></td>
        <td class="num"><input type="number" class="entrada-inline" min="0" step="1" value="${linea.manualCant}"
              data-campo="combo-linea-manual" data-indice="${i}"></td>
        <td class="centrado"><button type="button" class="boton boton-peligro" data-action="quitar-linea-combo" data-indice="${i}">✕</button></td>
      </tr>`;
  }).join('') || `<tr><td colspan="9" class="vacio">Agregá artículos al combo.</td></tr>`;

  document.getElementById('body-combo-opciones').innerHTML = resultado.opciones.map((op, i) => `
    <tr>
      <td><strong>${esc(op.nombre)}</strong></td>
      <td class="composicion">${esc(op.composicion)}</td>
      <td class="num"><strong>${op.totalPiezas} u.</strong></td>
      <td class="num texto-acento negrita">${dinero(op.precioVenta)}</td>
      <td class="num">${dinero(op.costoProduccion)}</td>
      <td class="num texto-verde negrita">${dinero(op.gananciaNeta)}</td>
      <td class="num" style="color:${op.saldo >= 0 ? 'var(--verde)' : 'var(--rojo)'}">${dinero(op.saldo)}</td>
      <td class="num">${op.tiempoTotalHHMM}</td>
      <td><span class="etiqueta ${op.esReal ? 'etiqueta-verde' : 'etiqueta-alerta'}">${esc(op.origen)}</span></td>
      <td class="centrado"><button type="button" class="boton boton-exito boton-pequeno" data-action="guardar-combo" data-indice="${i}">💾 Guardar</button></td>
    </tr>`).join('');

  document.getElementById('body-combo-historial').innerHTML = estado.datos.combos.map(c => `
    <tr>
      <td>${esc(c.fecha)}</td>
      <td><input class="entrada-inline nombre-inline" value="${esc(c.nombre)}"
            data-campo="combo-nombre" data-id="${c.id}"></td>
      <td class="num">${dinero(c.presupuesto)}</td>
      <td>${esc(c.opcion)}</td>
      <td class="composicion">${esc(c.composicion)}</td>
      <td class="num texto-acento negrita">${dinero(c.precioVenta)}</td>
      <td class="num">${dinero(c.costoProduccion)}</td>
      <td class="num">${dinero(c.saldo)}</td>
      <td><span class="etiqueta etiqueta-verde">${esc(c.estado)}</span></td>
      <td class="centrado"><button type="button" class="boton boton-peligro" data-action="borrar-combo" data-id="${c.id}">✕</button></td>
    </tr>`).join('') || `<tr><td colspan="10" class="vacio">Todavía no guardaste combos.</td></tr>`;
}

function actualizarCombos() {
  estado.combo.presupuesto = Math.max(0, Number(document.getElementById('cmb-presupuesto').value) || 0);
  estado.combo.factor = document.getElementById('cmb-factor').value;
  renderizarCombos();
}

async function guardarComboEnHistorial(indice) {
  const op = estado.combo.opciones[indice];
  if (!op || op.totalPiezas <= 0) {
    avisar('⚠️ Seleccioná artículos válidos antes de guardar', 'error');
    return;
  }
  const campoNombre = document.getElementById('cmb-nombre');
  let nombre = campoNombre.value.trim();
  if (!nombre) {
    const sugerido = `Combo ${op.nombre}`;
    const ingresado = prompt('Nombre para este combo:', sugerido);
    if (ingresado === null) return;
    nombre = ingresado.trim() || sugerido;
  }

  const items = estado.combo.items
    .filter(x => x[op.clave] > 0)
    .map(x => ({
      articuloId: x.articuloId,
      cantidad: x[op.clave],
      descripcion: `${x.nombre} (${x.codigo})`,
      precioUnitario: Calc.round(x.fila.costoUnit * x.factorAplicado, 2)
    }));

  try {
    await DataStore.guardarCombo({
      nombre, fecha: hoyISO(), presupuesto: estado.combo.presupuesto,
      opcion: op.nombre, composicion: op.composicion,
      precioVenta: op.precioVenta, costoProduccion: op.costoProduccion, saldo: op.saldo
    }, items);
    campoNombre.value = '';
    await recargar();
    avisar(`✅ Combo "${nombre}" guardado`, 'exito');
  } catch (error) {
    avisar(`❌ ${error.message}`, 'error');
  }
}

/* ===================== MÓDULO 4: PEDIDOS ================================= */

function renderizarPedidos() {
  let facturado = 0, enCurso = 0;
  for (const p of estado.datos.pedidos) {
    const total = totalesPedido(p.items, p.conFactura).total;
    if (p.estado === 'Entregado') facturado += total;
    if (['Pendiente', 'En Producción', 'Listo para Entrega'].includes(p.estado)) enCurso += total;
  }
  document.getElementById('kpi-total').textContent = estado.datos.pedidos.length;
  document.getElementById('kpi-entregado').textContent = dinero(facturado);
  document.getElementById('kpi-curso').textContent = dinero(enCurso);

  dibujarBorradorPedido();

  document.getElementById('body-pedidos').innerHTML = estado.datos.pedidos.map(p => {
    const t = totalesPedido(p.items, p.conFactura);
    return `
    <tr>
      <td><strong>${esc(p.codigo)}</strong></td>
      <td>${esc(p.fecha)}</td>
      <td><strong>${esc(p.cliente)}</strong></td>
      <td>
        <div class="lista-items">
          ${p.items.map(it => `
            <div class="chip-item">
              <span class="etiqueta ${it.tipo === 'combo' ? 'etiqueta-alerta' : 'etiqueta-azul'}">
                ${it.tipo === 'combo' ? '◈' : '▣'} ${esc(it.articuloId ? (articuloPorId(it.articuloId)?.codigo || it.descripcion) : (comboPorId(it.comboId)?.nombre || it.descripcion))}
              </span>
              <strong>${esc(it.descripcion)}</strong> ×
              <input type="number" class="entrada-inline corta" min="1" step="1" value="${it.cantidad}"
                     data-campo="ped-item-cant" data-id="${it.id}" title="Cantidad">
              @
              <input type="number" class="entrada-inline media" min="0" step="0.01" value="${Number(it.precioUnitario).toFixed(2)}"
                     data-campo="ped-item-precio" data-id="${it.id}" title="Precio unitario">
              <span class="texto-acento negrita">= ${dinero(it.cantidad * it.precioUnitario)}</span>
              ${p.items.length > 1 ? `<button type="button" class="boton boton-peligro" data-action="borrar-item-pedido" data-id="${it.id}">✕</button>` : ''}
            </div>`).join('') || '<span class="texto-suave">Sin ítems</span>'}
        </div>
      </td>
      <td class="centrado">
        <label class="interruptor-tabla ${p.conFactura ? 'etiqueta-factura' : 'etiqueta-sin-factura'}"
               title="Marcá si se factura: suma 22 % de IVA al precio final">
          <input type="checkbox" data-campo="ped-factura" data-id="${p.id}" ${p.conFactura ? 'checked' : ''}>
          ${p.conFactura ? 'Sí' : 'No'}
        </label>
      </td>
      <td class="num">${dinero(t.subtotal)}</td>
      <td class="num negrita texto-acento"
          title="${p.conFactura ? `Incluye ${dinero(t.iva)} de IVA (22 %)` : 'Sin IVA — subtotal y total coinciden'}">
        ${dinero(t.total)}
      </td>
      <td>
        <select class="entrada-inline" data-campo="ped-estado" data-id="${p.id}">
          ${ESTADOS_PEDIDO.map(e => `<option ${p.estado === e ? 'selected' : ''}>${e}</option>`).join('')}
        </select>
      </td>
      <td class="centrado"><button type="button" class="boton boton-peligro" data-action="borrar-pedido" data-id="${p.id}">🗑</button></td>
    </tr>`;
  }).join('') || `<tr><td colspan="9" class="vacio">No hay pedidos registrados.</td></tr>`;
}

function dibujarBorradorPedido() {
  const tbody = document.getElementById('body-ped-draft');
  if (!tbody) return;
  let suma = 0, piezas = 0, validos = 0;

  tbody.innerHTML = estado.borradorPedido.map((linea, i) => {
    const subtotal = Calc.round((linea.cantidad || 1) * (linea.precioUnitario || 0), 2);
    if (linea.refId) { suma += subtotal; piezas += Number(linea.cantidad || 1); validos++; }

    const opciones = linea.tipo === 'combo'
      ? `<option value="">— Elegir combo guardado —</option>` + estado.datos.combos.map(c => {
          const valor = `CMB-${c.id}`;
          const texto = `◈ ${c.nombre} (${dinero(c.precioVenta)}) — ${c.composicion}`;
          return `<option value="${valor}" ${linea.refId === valor ? 'selected' : ''}>${esc(texto)}</option>`;
        }).join('')
      : `<option value="">— Elegir artículo del catálogo —</option>` + estado.filasCalculadas.map(f => {
          const texto = `${f.codigo} | ${f.nombre} (${dinero(f.precioUnit)} / u.)`;
          return `<option value="${f.articuloId}" ${String(linea.refId) === String(f.articuloId) ? 'selected' : ''}>${esc(texto)}</option>`;
        }).join('');

    return `
      <tr>
        <td>
          <select class="entrada-inline" data-campo="ped-tipo" data-indice="${i}">
            <option value="articulo" ${linea.tipo === 'articulo' ? 'selected' : ''}>▣ Artículo</option>
            <option value="combo" ${linea.tipo === 'combo' ? 'selected' : ''}>◈ Combo</option>
          </select>
        </td>
        <td><select class="ancho-total" data-campo="ped-ref" data-indice="${i}">${opciones}</select></td>
        <td class="num"><input type="number" class="entrada-inline" min="1" step="1" value="${linea.cantidad}"
              data-campo="ped-cant" data-indice="${i}"></td>
        <td class="num"><input type="number" class="entrada-inline media" min="0" step="0.01" value="${Number(linea.precioUnitario).toFixed(2)}"
              data-campo="ped-precio" data-indice="${i}"></td>
        <td class="num texto-acento negrita">${dinero(subtotal)}</td>
        <td class="centrado"><button type="button" class="boton boton-peligro" data-action="quitar-linea-pedido" data-indice="${i}">✕</button></td>
      </tr>`;
  }).join('');

  const conFactura = document.getElementById('ped-factura')?.checked || false;
  const t = Calc.conIVA(suma, conFactura);
  document.getElementById('ped-resumen').textContent = `${validos} ítem(s) / ${piezas} unidad(es)`;
  document.getElementById('ped-subtotal').textContent = `Subtotal: ${dinero(t.subtotal)}`;
  document.getElementById('ped-iva').textContent = `IVA (22 %): ${dinero(t.iva)}`;
  document.getElementById('ped-total').textContent = `Total: ${dinero(t.total)}`;
}

function agregarLineaPedido(tipo) {
  if (tipo === 'combo' && estado.datos.combos.length === 0) {
    avisar('⚠️ Aún no hay combos guardados. Creá uno en el módulo Armador de combos.', 'error');
    return;
  }
  estado.borradorPedido.push({ tipo, refId: '', cantidad: 1, precioUnitario: 0 });
  dibujarBorradorPedido();
}

function seleccionarItemPedido(indice, refId) {
  const linea = estado.borradorPedido[indice];
  linea.refId = refId;
  if (!refId) {
    linea.precioUnitario = 0;
  } else if (linea.tipo === 'combo') {
    const combo = comboPorId(String(refId).replace('CMB-', ''));
    linea.precioUnitario = combo ? Number(combo.precioVenta) : 0;
  } else {
    const fila = estado.filasCalculadas.find(f => String(f.articuloId) === String(refId));
    linea.precioUnitario = fila ? Number(fila.precioUnit) : 0;
  }
  dibujarBorradorPedido();
}

async function crearPedido(evento) {
  evento.preventDefault();
  const fecha = document.getElementById('ped-fecha').value || hoyISO();
  const cliente = document.getElementById('ped-cliente').value.trim();
  const estadoPedido = document.getElementById('ped-estado').value;
  const conFactura = document.getElementById('ped-factura')?.checked || false;
  const lineas = estado.borradorPedido.filter(l => l.refId && l.cantidad >= 1);

  if (!cliente) { avisar('⚠️ Ingresá el nombre del cliente', 'error'); return; }
  if (!lineas.length) { avisar('⚠️ Agregá al menos un artículo o combo', 'error'); return; }

  const items = lineas.map(l => {
    if (l.tipo === 'combo') {
      const combo = comboPorId(String(l.refId).replace('CMB-', ''));
      return {
        tipo: 'combo',
        comboId: combo ? combo.id : Number(String(l.refId).replace('CMB-', '')),
        descripcion: combo ? `${combo.nombre} [${combo.composicion}]` : `Combo ${l.refId}`,
        cantidad: l.cantidad,
        precioUnitario: l.precioUnitario
      };
    }
    const fila = estado.filasCalculadas.find(f => String(f.articuloId) === String(l.refId));
    return {
      tipo: 'articulo',
      articuloId: Number(l.refId),
      descripcion: fila ? fila.nombre : (articuloPorId(l.refId)?.nombre || l.refId),
      cantidad: l.cantidad,
      precioUnitario: l.precioUnitario
    };
  });

  try {
    const codigo = await DataStore.crearPedido({ fecha, cliente, estado: estadoPedido, conFactura }, items);
    const t = totalesPedido(items, conFactura);
    document.getElementById('ped-cliente').value = '';
    document.getElementById('ped-factura').checked = false;
    estado.borradorPedido = [{ tipo: 'articulo', refId: '', cantidad: 1, precioUnitario: 0 }];
    await recargar();
    avisar(`✅ Pedido ${codigo} creado para ${cliente} — total ${dinero(t.total)}` +
           (conFactura ? ` (incluye ${dinero(t.iva)} de IVA)` : ''), 'exito');
  } catch (error) {
    avisar(`❌ ${error.message}`, 'error');
  }
}

/* ==================== MÓDULO 5: MEDICIONES =============================== */

function renderizarMediciones() {
  document.getElementById('body-mediciones').innerHTML = estado.datos.mediciones.map(m => {
    const costo = Calc.costoUnitario(m.cantidad, m.gramos, m.impresionH, m.preparacionH, m.postUnitH, estado.parametros);
    return `
      <tr>
        <td>${esc(m.fecha)}</td>
        <td><span class="etiqueta etiqueta-azul">${esc(m.codigo)}</span></td>
        <td><strong>${esc(m.nombre)}</strong></td>
        <td class="num">${m.cantidad} u.</td>
        <td class="num"><input type="number" class="entrada-inline" step="0.01" value="${Number(m.gramos).toFixed(2)}"
              data-campo="med-gramos" data-id="${m.id}"></td>
        <td class="num"><input class="entrada-inline entrada-hora" value="${Calc.aReloj(m.impresionH)}"
              data-campo="med-impresion" data-tiempo data-id="${m.id}"></td>
        <td class="num"><input class="entrada-inline entrada-hora" value="${Calc.aReloj(m.preparacionH)}"
              data-campo="med-preparacion" data-tiempo data-id="${m.id}"></td>
        <td class="num"><input class="entrada-inline entrada-hora" value="${Calc.aReloj(m.postUnitH)}"
              data-campo="med-post" data-tiempo data-id="${m.id}"></td>
        <td class="num"><strong>${dinero(costo)}</strong></td>
        <td class="num texto-acento negrita">${dinero(Calc.round(costo * m.factor, 2))}</td>
        <td class="centrado"><button type="button" class="boton boton-peligro" data-action="borrar-medicion" data-id="${m.id}">✕</button></td>
      </tr>`;
  }).join('') || `<tr><td colspan="11" class="vacio">No hay mediciones registradas.</td></tr>`;
}

async function manejarMedicion(evento) {
  evento.preventDefault();
  const nombre = document.getElementById('med-articulo').value.trim();
  const cantidad = Math.max(1, Math.floor(Number(document.getElementById('med-cantidad').value) || 1));
  const gramos = Number(document.getElementById('med-gramos').value) || 0;
  const imp = Calc.aHoras(document.getElementById('med-impresion').value);
  const prep = Calc.aHoras(document.getElementById('med-preparacion').value);
  const post = Calc.aHoras(document.getElementById('med-post').value);

  if (!nombre || gramos <= 0 || !Number.isFinite(imp) || imp <= 0) {
    avisar('⚠️ Verificá artículo, gramos y tiempo de impresión (hh:mm)', 'error');
    return;
  }
  try {
    const articulo = await DataStore.obtenerOCrearArticulo(nombre);
    await DataStore.guardarMedicion({
      fecha: document.getElementById('med-fecha').value || hoyISO(),
      articuloId: articulo.id,
      cantidad,
      gramos,
      impresionH: imp,
      preparacionH: Number.isFinite(prep) ? prep : 0,
      postUnitH: Number.isFinite(post) ? post : 0,
      factor: Number(document.getElementById('med-factor').value) || 2.5
    });
    evento.target.reset();
    document.getElementById('med-fecha').value = hoyISO();
    document.getElementById('med-cantidad').value = 1;
    document.getElementById('med-preparacion').value = '00:05';
    document.getElementById('med-post').value = '00:00';
    document.getElementById('med-factor').value = '2.5';
    await recargar();
    avisar(`✅ Medición guardada (${articulo.codigo} × ${cantidad})`, 'exito');
  } catch (error) {
    avisar(`❌ ${error.message}`, 'error');
  }
}

/* ==================== MÓDULO 6: PARÁMETROS =============================== */

function renderizarParametros() {
  document.getElementById('body-parametros').innerHTML = estado.datos.parametros.map(p => `
    <tr>
      <td><strong>${esc(p.etiqueta)}</strong></td>
      <td class="num"><input type="number" class="entrada-inline ancho-valor" step="any" value="${p.valor}"
            data-campo="param-valor" data-clave="${esc(p.clave)}"></td>
      <td>${esc(p.unidad)}</td>
      <td><span class="etiqueta etiqueta-azul">${esc(p.base)}</span></td>
      <td class="texto-suave">${esc(p.notas || '')}</td>
    </tr>`).join('');
}

/* ==================== MANEJO DE EVENTOS ================================== */

async function manejarCampo(elemento) {
  const campo = elemento.dataset.campo;
  const id = elemento.dataset.id;
  const indice = Number(elemento.dataset.indice);

  try {
    switch (campo) {
      case 'reg-nombre': {
        const nombre = elemento.value.trim();
        if (!nombre) { avisar('⚠️ El nombre no puede quedar vacío', 'error'); await recargar(); return; }
        await DataStore.renombrarArticulo(Number(id), nombre);
        await recargar();
        avisar('✅ Nombre actualizado', 'exito');
        break;
      }
      case 'reg-cantidad': {
        const cantidad = Math.max(1, Math.floor(Number(elemento.value) || 1));
        await DataStore.actualizarRegistro(Number(id), { cantidad });
        await recargar();
        break;
      }
      case 'reg-factor': {
        await DataStore.actualizarRegistro(Number(id), { factor: Number(elemento.value) });
        await recargar();
        break;
      }
      case 'combo-linea-art':
        estado.combo.lineas[indice].articuloId = idArticuloDesde(elemento.value);
        renderizarCombos();
        break;
      case 'combo-linea-manual':
        estado.combo.lineas[indice].manualCant = Math.max(0, Math.floor(Number(elemento.value) || 0));
        renderizarCombos();
        break;
      case 'combo-nombre': {
        const nombre = elemento.value.trim();
        if (!nombre) { await recargar(); return; }
        await DataStore.renombrarCombo(Number(id), nombre);
        await recargar();
        break;
      }
      case 'ped-tipo':
        estado.borradorPedido[indice] = { tipo: elemento.value, refId: '', cantidad: 1, precioUnitario: 0 };
        dibujarBorradorPedido();
        break;
      case 'ped-ref':
        seleccionarItemPedido(indice, elemento.value);
        break;
      case 'ped-cant':
        estado.borradorPedido[indice].cantidad = Math.max(1, Math.floor(Number(elemento.value) || 1));
        dibujarBorradorPedido();
        break;
      case 'ped-precio':
        estado.borradorPedido[indice].precioUnitario = Math.max(0, Number(elemento.value) || 0);
        dibujarBorradorPedido();
        break;
      case 'ped-item-cant':
        await DataStore.actualizarItemPedido(Number(id), {
          cantidad: Math.max(1, Math.floor(Number(elemento.value) || 1))
        });
        await recargar();
        break;
      case 'ped-item-precio':
        await DataStore.actualizarItemPedido(Number(id), {
          precioUnitario: Math.max(0, Number(elemento.value) || 0)
        });
        await recargar();
        break;
      case 'ped-estado':
        await DataStore.cambiarEstadoPedido(Number(id), elemento.value);
        await recargar();
        avisar(`✅ Estado actualizado: ${elemento.value}`, 'exito');
        break;
      case 'ped-factura': {
        await DataStore.cambiarFacturaPedido(Number(id), elemento.checked);
        await recargar();
        const pedido = estado.datos.pedidos.find(p => p.id === Number(id));
        avisar(`✅ ${pedido?.codigo || 'Pedido'} ${elemento.checked ? 'ahora es con factura (+22 % IVA)' : 'ahora es sin factura'}`, 'exito');
        break;
      }
      case 'med-gramos':
        await DataStore.actualizarMedicion(Number(id), { gramos: Math.max(0, Number(elemento.value) || 0) });
        await recargar();
        break;
      case 'med-impresion':
      case 'med-preparacion':
      case 'med-post': {
        const mapa = {
          'med-impresion': 'impresionH',
          'med-preparacion': 'preparacionH',
          'med-post': 'postUnitH'
        };
        const horas = Calc.aHoras(elemento.value);
        if (!Number.isFinite(horas) || horas < 0) {
          avisar('⚠️ Formato inválido. Usá hh:mm (ej: 01:30)', 'error');
          await recargar();
          return;
        }
        await DataStore.actualizarMedicion(Number(id), { [mapa[campo]]: horas });
        await recargar();
        break;
      }
      case 'param-valor':
        await DataStore.actualizarParametro(elemento.dataset.clave, Number(elemento.value) || 0);
        await recargar();
        avisar('✅ Parámetro actualizado — costos recalculados', 'exito');
        break;
    }
  } catch (error) {
    avisar(`❌ ${error.message}`, 'error');
    await recargar().catch(() => {});
  }
}

async function manejarAccion(accion, boton) {
  const id = Number(boton.dataset.id);
  const indice = Number(boton.dataset.indice);

  switch (accion) {
    case 'sincronizar':
      await recargar();
      avisar('↻ Datos sincronizados con Supabase', 'exito');
      break;

    case 'cerrar-sesion':
      await DataStore.cerrarSesion();
      break;

    case 'guardar-medicion-cotizador':
      await guardarMedicionDelCotizador();
      break;

    case 'agregar-linea-combo':
      if (estado.combo.lineas.length >= 10) { avisar('⚠️ Máximo 10 artículos por combo', 'error'); break; }
      estado.combo.lineas.push({ articuloId: '', manualCant: 1 });
      renderizarCombos();
      break;

    case 'quitar-linea-combo':
      estado.combo.lineas.splice(indice, 1);
      renderizarCombos();
      break;

    case 'guardar-combo':
      await guardarComboEnHistorial(indice);
      break;

    case 'borrar-registro':
      if (!confirm('¿Eliminar esta fila del catálogo?')) break;
      await DataStore.eliminarRegistro(id);
      await recargar();
      avisar('🗑 Fila eliminada', 'exito');
      break;

    case 'borrar-combo':
      if (!confirm('¿Eliminar este combo del historial?')) break;
      await DataStore.eliminarCombo(id);
      await recargar();
      avisar('🗑 Combo eliminado', 'exito');
      break;

    case 'agregar-linea-pedido':
      agregarLineaPedido(boton.dataset.tipo);
      break;

    case 'quitar-linea-pedido':
      if (estado.borradorPedido.length <= 1) {
        estado.borradorPedido = [{ tipo: 'articulo', refId: '', cantidad: 1, precioUnitario: 0 }];
      } else {
        estado.borradorPedido.splice(indice, 1);
      }
      dibujarBorradorPedido();
      break;

    case 'borrar-pedido':
      if (!confirm('¿Eliminar el pedido y todos sus ítems?')) break;
      await DataStore.eliminarPedido(id);
      await recargar();
      avisar('🗑 Pedido eliminado', 'exito');
      break;

    case 'borrar-item-pedido':
      await DataStore.eliminarItemPedido(id);
      await recargar();
      avisar('🗑 Ítem quitado del pedido', 'exito');
      break;

    case 'borrar-medicion':
      if (!confirm('¿Eliminar esta medición real?')) break;
      await DataStore.eliminarMedicion(id);
      await recargar();
      avisar('🗑 Medición eliminada', 'exito');
      break;
  }
}

function configurarEventos() {
  // Pestañas
  document.querySelectorAll('.pestana').forEach(boton => {
    boton.addEventListener('click', () => {
      document.querySelectorAll('.pestana').forEach(b => b.classList.remove('activa'));
      document.querySelectorAll('.panel').forEach(p => p.classList.remove('activa'));
      boton.classList.add('activa');
      document.getElementById(`tab-${boton.dataset.tab}`).classList.add('activa');
      if (boton.dataset.tab === 'cotizador' && estado.grafico) estado.grafico.resize();
    });
  });

  // Formularios
  document.getElementById('form-articulo').addEventListener('submit', manejarArticulo);
  document.getElementById('form-medicion').addEventListener('submit', manejarMedicion);
  document.getElementById('form-pedido').addEventListener('submit', crearPedido);
  document.getElementById('art-nombre').addEventListener('input', actualizarPreviewId);

  // Controles del cotizador (recalc local, sin viaje a la BD)
  ['cot-articulo', 'cot-cantidad', 'cot-factor', 'cot-gramos', 'cot-impresion', 'cot-preparacion']
    .forEach(id => {
      const el = document.getElementById(id);
      el.addEventListener('input', actualizarCotizador);
      el.addEventListener('change', actualizarCotizador);
    });

  // Controles del armador de combos (recalc local)
  ['cmb-presupuesto', 'cmb-factor'].forEach(id => {
    const el = document.getElementById(id);
    el.addEventListener('input', actualizarCombos);
    el.addEventListener('change', actualizarCombos);
  });

  // Normalización de tiempos hh:mm al perder el foco
  document.addEventListener('focusout', evento => {
    const el = evento.target;
    if (!el.matches('[data-normalizar-tiempo], [data-tiempo]')) return;
    if (!el.value.trim()) return;
    const normalizado = Calc.normalizarReloj(el.value);
    if (normalizado === null) {
      avisar('⚠️ Formato de tiempo inválido. Usá hh:mm (ej: 02:30 o 390:00)', 'error');
      el.focus();
    } else {
      el.value = normalizado;
    }
  });

  const casillaFactura = document.getElementById('ped-factura');
  if (casillaFactura) {
    casillaFactura.addEventListener('change', dibujarBorradorPedido);
    casillaFactura.addEventListener('input', dibujarBorradorPedido);
  }

  //Delegación: clics
  document.addEventListener('click', async evento => {
    const boton = evento.target.closest('[data-action]');
    if (!boton) return;
    try {
      await manejarAccion(boton.dataset.action, boton);
    } catch (error) {
      avisar(`❌ ${error.message}`, 'error');
    }
  });

  // Delegación: cambios en campos editables
  document.addEventListener('change', async evento => {
    const elemento = evento.target.closest('[data-campo]');
    if (elemento) await manejarCampo(elemento);
  });
}

/* ====================== AUTENTICACIÓN Y ARRANQUE ======================== */

function mostrarLogin(mensaje = '') {
  const pantalla = document.getElementById('pantalla-login');
  if (pantalla) pantalla.classList.add('visible');
  document.getElementById('login-error').textContent = mensaje;
}

function ocultarLogin() {
  document.getElementById('pantalla-login').classList.remove('visible');
  document.getElementById('login-error').textContent = '';
}

async function iniciarApp() {
  try {
    fijarEstadoBD('⏳ Verificando acceso…', 'estado-cargando');
    await DataStore.verificarAutorizacion();
    const user = await DataStore.usuario();
    document.getElementById('usuario-actual').textContent = user?.email || '';
    ocultarLogin();
    fijarEstadoBD('🟢 Supabase conectado', 'estado-ok');
    await recargar();
  } catch (error) {
    console.error(error);
    fijarEstadoBD('🔴 Acceso denegado', 'estado-error');
    await DataStore.cerrarSesion().catch(() => {});
    mostrarLogin(error.message);
  }
}

async function manejarLogin(evento) {
  evento.preventDefault();
  const email = document.getElementById('login-email').value.trim();
  const password = document.getElementById('login-password').value;
  const boton = evento.target.querySelector('button[type="submit"]');
  boton.disabled = true;
  try {
    await DataStore.iniciarSesion(email, password);
    await iniciarApp();
  } catch (error) {
    mostrarLogin(error.message);
  } finally {
    boton.disabled = false;
  }
}

document.addEventListener('DOMContentLoaded', async () => {
  configurarEventos();
  const hoy = hoyISO();
  document.getElementById('ped-fecha').value = hoy;
  document.getElementById('med-fecha').value = hoy;
  document.getElementById('form-login').addEventListener('submit', manejarLogin);

  try {
    fijarEstadoBD('⏳ Conectando a Supabase…', 'estado-cargando');
    await DataStore.init();
  } catch (error) {
    console.error(error);
    fijarEstadoBD('🔴 Sin conexión con Supabase', 'estado-error');
    mostrarLogin(error.message);
    return;
  }

  DataStore.alCambiarAuth(evento => {
    if (evento === 'SIGNED_OUT') {
      document.getElementById('usuario-actual').textContent = '';
      fijarEstadoBD('⏳ Sesión cerrada', 'estado-cargando');
      mostrarLogin();
    }
  });

  const sesion = await DataStore.sesion();
  if (!sesion) {
    fijarEstadoBD('🔒 Ingresá para continuar', 'estado-cargando');
    mostrarLogin();
    return;
  }
  await iniciarApp();
});
