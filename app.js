/**
 * =============================================================================
 * CONTROLADOR DE INTERFAZ — v2
 * Estado central, renderizado por módulos y delegación de eventos.
 * La lógica de negocio vive en engine.js; la persistencia en db.js.
 * =============================================================================
 */

'use strict';

/* Preferencias locales: no se envían a Supabase, sólo viven en este navegador. */
function leerPreferencia(clave, defecto) {
  try {
    const valor = localStorage.getItem(clave);
    return valor === null ? defecto : (Number(valor) || defecto);
  } catch {
    return defecto;
  }
}

function guardarPreferencia(clave, valor) {
  try { localStorage.setItem(clave, String(valor)); } catch { /* navegador privado */ }
}

const estado = {
  datos: {
    parametros: [], articulos: [], mediciones: [], registro: [], combos: [], pedidos: [],
    clientes: [], filamentos: [], movimientos: []
  },
  parametros: {},
  filasCalculadas: [],
  combo: { presupuesto: 3278, factor: '2', lineas: [], opciones: [], items: [] },
  borradorPedido: [{ tipo: 'articulo', refId: '', cantidad: 1, precioUnitario: 0 }],
  comboInicializado: false,
  grafico: null,
  ultimaCotizacion: null,
  clienteEditando: null,
  confirmacion: null,
  capacidadHoras: leerPreferencia('printlab.horasImpresora', 40),
  importacion: null,
  filtros: {
    clientes: { texto: '', orden: 'nombre', dir: 1 },
    pedidos: { texto: '', estado: '', orden: 'fecha', dir: -1 },
    movimientos: { texto: '', orden: 'fecha', dir: -1 }
  }
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

/* ==================== filtros, búsqueda y orden ========================== */

function textoBusqueda(valor) {
  return String(valor ?? '').toLocaleLowerCase('es');
}

function aplicarFiltro(lista, filtro, campos) {
  const q = textoBusqueda(filtro.texto).trim();
  const filtrados = lista.filter(item => {
    if (filtro.estado && item.estado !== filtro.estado) return false;
    if (!q) return true;
    return campos.some(campo => textoBusqueda(item[campo]).includes(q));
  });

  const { orden, dir } = filtro;
  return filtrados.sort((a, b) => {
    const va = a[orden], vb = b[orden];
    const resultado = (typeof va === 'number' && typeof vb === 'number')
      ? va - vb
      : String(va ?? '').localeCompare(String(vb ?? ''), 'es',
          { numeric: true, sensitivity: 'base' });
    return resultado * dir;
  });
}

function actualizarFlechas(tabla, filtro) {
  document.querySelectorAll(`.orden[data-tabla="${tabla}"]`).forEach(boton => {
    const activo = boton.dataset.orden === filtro.orden;
    boton.classList.toggle('activo', activo);
    boton.querySelector('.flecha-orden').textContent =
      activo ? (filtro.dir === 1 ? '▲' : '▼') : '↕';
  });
}

function actualizarConteo(id, visibles, totales, etiqueta) {
  const el = document.getElementById(id);
  if (!el) return;
  const singular = {
    clientes: 'cliente', pedidos: 'pedido', movimientos: 'movimiento'
  }[etiqueta] || etiqueta;
  const palabra = totales === 1 ? singular : etiqueta;
  el.textContent = visibles === totales
    ? `${totales} ${palabra}`
    : `${visibles} de ${totales} ${palabra}`;
}

function redibujarTabla(tabla) {
  const tablas = {
    clientes: dibujarTablaClientes,
    pedidos: dibujarTablaPedidos,
    movimientos: dibujarTablaMovimientos
  };
  tablas[tabla]?.();
}

/** Cambia de módulo y vuelve arriba (lo usa el menú y el alerta de stock). */
function activarPestana(nombre) {
  const boton = document.querySelector(`.pestana[data-tab="${nombre}"]`);
  if (!boton) return;
  document.querySelectorAll('.pestana').forEach(b => b.classList.remove('activa'));
  document.querySelectorAll('.panel').forEach(p => p.classList.remove('activa'));
  boton.classList.add('activa');
  document.getElementById(`tab-${nombre}`)?.classList.add('activa');
  if (nombre === 'cotizador' && estado.grafico) estado.grafico.resize();
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

/* ============== importación de 3MF cortado (Bambu Studio) ================ */

const PALETA_COLORES = [
  ['Negro', '#000000'], ['Blanco', '#FFFFFF'], ['Gris', '#808080'],
  ['Rojo', '#FF0000'], ['Azul', '#0000FF'], ['Verde', '#008000'],
  ['Amarillo', '#FFFF00'], ['Naranja', '#FFA500'], ['Morado', '#800080'],
  ['Rosa', '#FF69B4'], ['Marrón', '#8B4513'], ['Cian', '#00FFFF'],
  ['Plata', '#C0C0C0'], ['Oro', '#D4AF37'], ['Transparente', '#E6F4F1']
];

function sinAcentos(valor) {
  return String(valor ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

function rgbDeHex(hex) {
  const limpio = String(hex || '').replace('#', '').trim();
  if (!/^[0-9a-f]{6}$/i.test(limpio)) return null;
  return [0, 2, 4].map(i => parseInt(limpio.slice(i, i + 2), 16));
}

function distanciaColor(hexA, hexB) {
  const a = rgbDeHex(hexA), b = rgbDeHex(hexB);
  if (!a || !b) return Infinity;
  return Math.sqrt(a.reduce((suma, valor, i) => suma + (valor - b[i]) ** 2, 0));
}

function nombreColorCercano(hex) {
  if (!rgbDeHex(hex)) return '';
  let mejor = '', menor = Infinity;
  for (const [nombre, referencia] of PALETA_COLORES) {
    const distancia = distanciaColor(hex, referencia);
    if (distancia < menor) { menor = distancia; mejor = nombre; }
  }
  return menor <= 120 ? mejor : '';
}

function atributoDe(bloque, nombre) {
  const hallazgo = String(bloque).match(new RegExp(`${nombre}="([^"]*)"`));
  return hallazgo ? hallazgo[1] : '';
}

function metaDe(bloque, clave) {
  const hallazgo = String(bloque).match(
    new RegExp(`<metadata\\s+key="${clave}"\\s+value="([^"]*)"`));
  return hallazgo ? hallazgo[1] : '';
}

/** Extrae plataformas, tiempo (s), peso (g) y filamentos de slice_info.config. */
function parsearSliceInfo(xml) {
  const placas = [];
  const bloques = String(xml).match(/<plate>[\s\S]*?<\/plate>/g) || [];
  for (const bloque of bloques) {
    const filamentos = [];
    const expresion = /<filament\s+([^>]*)\/>/g;
    let coincidencia;
    while ((coincidencia = expresion.exec(bloque)) !== null) {
      const atributos = coincidencia[1];
      filamentos.push({
        id: Number(atributoDe(atributos, 'id')) || 0,
        tipo: atributoDe(atributos, 'type'),
        color: atributoDe(atributos, 'color'),
        gramos: Number(atributoDe(atributos, 'used_g')) || 0,
        metros: Number(atributoDe(atributos, 'used_m')) || 0,
        perfil: atributoDe(atributos, 'tray_info_idx')
      });
    }
    placas.push({
      index: Number(metaDe(bloque, 'index')) || placas.length + 1,
      nombre: metaDe(bloque, 'plater_name'),
      segundos: Number(metaDe(bloque, 'prediction')) || 0,
      gramos: Number(metaDe(bloque, 'weight')) || 0,
      filamentos
    });
  }
  return placas;
}

function nombresPlacasDe3mf(xml) {
  const mapa = {};
  const expresion = /<plate>([\s\S]*?)<\/plate>/g;
  let coincidencia;
  while ((coincidencia = expresion.exec(String(xml || ''))) !== null) {
    const id = (coincidencia[1].match(
      /<metadata\s+key="plater_id"\s+value="(\d+)"/) || [])[1];
    const nombre = (coincidencia[1].match(
      /<metadata\s+key="plater_name"\s+value="([^"]*)"/) || [])[1] || '';
    if (id) mapa[Number(id)] = nombre;
  }
  return mapa;
}

/** Bobina existente que mejor coincide con material + color del 3MF. */
function sugerirFilamento(tipo, colorHex) {
  const lista = estado.datos.filamentos || [];
  if (!lista.length) return null;

  const tipoBase = sinAcentos(textoBusqueda(String(tipo || '').split(/[-_\s]/)[0]));
  const colorNormalizado = sinAcentos(textoBusqueda(nombreColorCercano(colorHex)));
  const hexNormalizado = String(colorHex || '').toLowerCase();

  const puntajes = lista.map(f => {
    const material = sinAcentos(textoBusqueda(f.material));
    const colorBobina = String(f.color || '').trim();
    let puntos = 0;

    if (tipoBase) {
      if (material === tipoBase) puntos += 3;
      else if (material && (material.includes(tipoBase) || tipoBase.includes(material))) puntos += 1;
    }

    if (colorBobina.startsWith('#')) {
      if (colorBobina.toLowerCase() === hexNormalizado) puntos += 3;
      else if (distanciaColor(colorBobina, colorHex) < 70) puntos += 2;
    } else if (colorNormalizado && colorBobina) {
      const cf = sinAcentos(textoBusqueda(colorBobina));
      if (cf === colorNormalizado) puntos += 3;
      else if (cf.includes(colorNormalizado) || colorNormalizado.includes(cf)) puntos += 2;
    }

    return { filamento: f, puntos, kg: Number(f.kg) || 0 };
  }).sort((a, b) => b.puntos - a.puntos || b.kg - a.kg);

  const umbral = (hexNormalizado || colorNormalizado) ? 4 : 3;
  return puntajes[0]?.puntos >= umbral ? puntajes[0].filamento : null;
}

async function leerArchivo3MF(archivo) {
  if (typeof JSZip === 'undefined') {
    throw new Error('No se pudo cargar JSZip. Revisá la conexión y recargá con Ctrl+F5.');
  }
  if (!/\.3mf$/i.test(archivo.name)) {
    throw new Error('El archivo debe ser .3mf o .gcode.3mf de Bambu Studio.');
  }
  if (archivo.size > 120 * 1024 * 1024) {
    throw new Error('El archivo supera los 120 MB. Probá con una sola plataforma.');
  }

  const zip = await JSZip.loadAsync(archivo);
  const nombres = Object.keys(zip.files);
  const buscar = sufijo => nombres.find(n => n.toLowerCase().endsWith(sufijo));

  const rutaSlice = buscar('slice_info.config');
  if (!rutaSlice) {
    throw new Error('El 3MF no está cortado. En Bambu Studio apretá «Slice plate» y exportá el .gcode.3mf.');
  }

  const sliceXML = await zip.files[rutaSlice].async('text');
  const placas = parsearSliceInfo(sliceXML);
  if (!placas.length) throw new Error('No se encontraron plataformas cortadas en el archivo.');

  const rutaSettings = buscar('project_settings.config');
  const rutaModelo = nombres.find(n => /^3d\/3dmodel\.model$/i.test(n));
  const rutaPlacas = buscar('model_settings.config');

  let settings = {};
  if (rutaSettings) {
    try { settings = JSON.parse(await zip.files[rutaSettings].async('text')); }
    catch { settings = {}; }
  }
  const modeloXML = rutaModelo ? await zip.files[rutaModelo].async('text') : '';
  const piezasModelo = (modeloXML.match(/<item\s+[^>]*objectid\s*=/gi) || []).length;
  const placasXML = rutaPlacas ? await zip.files[rutaPlacas].async('text') : '';
  const nombresPlacas = nombresPlacasDe3mf(placasXML);

  for (const placa of placas) {
    if (nombresPlacas[placa.index]) placa.nombre = nombresPlacas[placa.index];
    for (const filamento of placa.filamentos) {
      const ranura = filamento.id - 1;
      if (!filamento.tipo && Array.isArray(settings.filament_type)) {
        filamento.tipo = settings.filament_type[ranura] || '';
      }
      if (!filamento.color && Array.isArray(settings.filament_colour)) {
        filamento.color = settings.filament_colour[ranura] || '';
      }
    }
  }

  const version = (sliceXML.match(
    /<header_item\s+key="X-BBL-Client-Version"\s+value="([^"]+)"/) || [])[1]
    || (modeloXML.match(/<metadata\s+name="Application">([^<]+)<\/metadata>/) || [])[1]
    || '';

  return {
    nombre: archivo.name.replace(/\.gcode\.3mf$/i, '').replace(/\.3mf$/i, ''),
    version,
    impresora: settings.printer_model || '',
    boquilla: settings.printer_variant || '',
    piezas: placas.length === 1 ? Math.max(1, piezasModelo) : 1,
    placas
  };
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
  renderizarClientes();
  renderizarFilamentos();
  renderizarPedidos();
  renderizarCapacidad();
  renderizarMediciones();
  renderizarParametros();

  document.getElementById('lista-articulos').innerHTML = estado.datos.articulos
    .map(a => `<option value="${esc(a.nombre)}">`).join('');
  document.getElementById('lista-clientes').innerHTML = estado.datos.clientes
    .map(c => `<option value="${esc(c.nombre)}">`).join('');
  actualizarSelectorFilamentos();

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

/* ==================== MÓDULO 4: CLIENTES ================================= */

function renderizarClientes() {
  dibujarTablaClientes();
}

function dibujarTablaClientes() {
  const tbody = document.getElementById('body-clientes');
  if (!tbody) return;

  const filtro = estado.filtros.clientes;
  const clientes = estado.datos.clientes.map(c => ({
    ...c,
    pedidos: estado.datos.pedidos.filter(p =>
      p.clienteId === c.id || p.cliente === c.nombre).length
  }));
  const visibles = aplicarFiltro(clientes, filtro,
    ['nombre', 'rut', 'razonSocial', 'telefono', 'email']);

  actualizarConteo('conteo-clientes', visibles.length, clientes.length, 'clientes');
  actualizarFlechas('clientes', filtro);

  tbody.innerHTML = visibles.map(c => {
    return `
    <tr>
      <td><strong>${esc(c.nombre)}</strong>${c.razonSocial && c.razonSocial !== c.nombre
        ? `<br><small class="texto-suave">${esc(c.razonSocial)}</small>` : ''}</td>
      <td>${c.rut ? esc(c.rut) : '<span class="texto-suave">—</span>'}</td>
      <td>${c.telefono ? esc(c.telefono) : '<span class="texto-suave">—</span>'}</td>
      <td>${c.email ? esc(c.email) : '<span class="texto-suave">—</span>'}</td>
      <td class="num">${c.pedidos}</td>
      <td class="centrado">
        <button type="button" class="boton boton-suave boton-pequeno"
                data-action="editar-cliente" data-id="${c.id}" title="Editar">✎</button>
        <button type="button" class="boton boton-peligro boton-pequeno"
                data-action="pedir-borrar-cliente" data-id="${c.id}" title="Eliminar">🗑</button>
      </td>
    </tr>`;
  }).join('') || `<tr><td colspan="6" class="vacio">${
    clientes.length ? 'No hay clientes que coincidan con la búsqueda.' : 'No hay clientes registrados.'
  }</td></tr>`;
}

function renderizarFilamentos() {
  const tbody = document.getElementById('body-filamentos');
  if (!tbody) return;

  tbody.innerHTML = estado.datos.filamentos.map(f => {
    const bajo = f.kg <= f.kgAlerta;
    return `
    <tr>
      <td><strong>${esc(f.codigo)}</strong></td>
      <td>${esc(f.nombre)}</td>
      <td><span class="etiqueta etiqueta-azul">${esc(f.material)}</span>
          <span class="texto-suave">${esc(f.color)}</span></td>
      <td class="num ${bajo ? 'stock-bajo' : 'stock-ok'}">
        <strong>${f.kg.toFixed(3)} kg</strong>
        ${bajo ? '<br><small>⚠️ Stock bajo</small>' : ''}
      </td>
      <td class="num">${dinero(f.costoKg)}</td>
      <td>
        <div class="grupo-botones">
          <input type="number" class="entrada-inline corta" min="0.001" step="0.001"
                 placeholder="kg" data-campo="fil-entrada" data-id="${f.id}"
                 title="Kilogramos a agregar">
          <button type="button" class="boton boton-contorno boton-pequeno"
                  data-action="entrada-filamento" data-id="${f.id}" title="Registrar entrada">＋</button>
          <button type="button" class="boton boton-peligro boton-pequeno"
                  data-action="pedir-borrar-filamento" data-id="${f.id}" title="Eliminar">🗑</button>
        </div>
      </td>
    </tr>`;
  }).join('') || `<tr><td colspan="6" class="vacio">No hay filamentos registrados.</td></tr>`;

  dibujarTablaMovimientos();
  renderizarAlertaStock();
}

function dibujarTablaMovimientos() {
  const movBody = document.getElementById('body-movimientos');
  if (!movBody) return;

  const filtro = estado.filtros.movimientos;
  const movimientos = estado.datos.movimientos.map(m => {
    const fil = estado.datos.filamentos.find(f => f.id === m.filamentoId);
    return { ...m, filamentoNombre: fil ? fil.nombre : `Filamento ${m.filamentoId}` };
  });
  const visibles = aplicarFiltro(movimientos, filtro,
    ['fecha', 'filamentoNombre', 'tipo', 'motivo']);

  actualizarConteo('conteo-movimientos', visibles.length, movimientos.length, 'movimientos');
  actualizarFlechas('movimientos', filtro);

  movBody.innerHTML = visibles.map(m => {
    const signo = m.kg > 0 ? '+' : '';
    const tipo = { entrada: '⬆ Entrada', consumo: '⬇ Consumo', ajuste: '↔ Ajuste' }[m.tipo] || m.tipo;
    return `
      <tr>
        <td>${esc(m.fecha)}</td>
        <td>${esc(m.filamentoNombre)}</td>
        <td>${tipo}</td>
        <td class="num ${m.kg < 0 ? 'stock-bajo' : 'stock-ok'}">${signo}${m.kg.toFixed(3)} kg</td>
        <td>${esc(m.motivo)}</td>
      </tr>`;
  }).join('') || `<tr><td colspan="5" class="vacio">${
    movimientos.length ? 'No hay movimientos que coincidan con la búsqueda.' : 'Sin movimientos todavía.'
  }</td></tr>`;
}

/** Badge global: avisa cuántas bobinas están en o por debajo de su alerta. */
function renderizarAlertaStock() {
  const badge = document.getElementById('alerta-stock');
  if (!badge) return;
  const bajos = estado.datos.filamentos.filter(f =>
    Number(f.kg) <= Number(f.kgAlerta)).length;
  badge.hidden = bajos === 0;
  document.getElementById('alerta-stock-num').textContent = bajos;
  badge.title = bajos
    ? `${bajos} bobina(s) con stock en o por debajo del nivel de alerta`
    : 'Stock de filamento dentro de los niveles normales';
}

function actualizarSelectorFilamentos() {
  const select = document.getElementById('med-filamento');
  if (!select) return;
  const anterior = select.value;
  select.innerHTML = `<option value="">— Sin descontar stock —</option>` +
    estado.datos.filamentos.map(f =>
      `<option value="${f.id}" ${String(anterior) === String(f.id) ? 'selected' : ''}>` +
      `${esc(f.nombre)} (${f.kg.toFixed(3)} kg)</option>`).join('');
  actualizarStockFilamento();
}

function actualizarStockFilamento() {
  const label = document.getElementById('med-stock');
  const select = document.getElementById('med-filamento');
  if (!label) return;
  const f = estado.datos.filamentos.find(x => String(x.id) === String(select?.value));
  label.textContent = f
    ? `Disponible: ${f.kg.toFixed(3)} kg${f.kg <= f.kgAlerta ? ' ⚠️ stock bajo' : ''}`
    : 'Selectivo: si elegís un filamento, el consumo se descuenta al guardar.';
}

/* ===================== MÓDULO 5: PEDIDOS ================================= */

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
  dibujarTablaPedidos();
}

function dibujarTablaPedidos() {
  const tbody = document.getElementById('body-pedidos');
  if (!tbody) return;

  const filtro = estado.filtros.pedidos;
  const pedidos = estado.datos.pedidos.map(p => {
    const descripciones = (p.items || []).map(it => {
      const combo = it.comboId != null ? comboPorId(it.comboId) : null;
      return [
        it.descripcion,
        it.articuloId != null ? articuloPorId(it.articuloId)?.nombre : '',
        combo?.nombre || '',
        combo?.composicion || '',
        (combo?.items || []).map(ci =>
          articuloPorId(ci.articuloId)?.nombre || ci.descripcion || '').join(' ')
      ].filter(Boolean).join(' ');
    }).join(' ');
    return { ...p, ...totalesPedido(p.items, p.conFactura), busqueda: descripciones };
  });
  const visibles = aplicarFiltro(pedidos, filtro,
    ['codigo', 'cliente', 'rut', 'estado', 'fecha', 'numeroFactura', 'busqueda']);

  actualizarConteo('conteo-pedidos', visibles.length, pedidos.length, 'pedidos');
  actualizarFlechas('pedidos', filtro);

  tbody.innerHTML = visibles.map(p => {
    const t = p;
    return `
    <tr>
      <td><strong>${esc(p.codigo)}</strong></td>
      <td>${esc(p.fecha)}</td>
      <td><strong>${esc(p.cliente)}</strong>
        ${p.rut ? `<br><small class="texto-suave">${esc(p.rut)}</small>` : ''}
      </td>
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
      <td>${p.numeroFactura
        ? `<strong>${esc(p.numeroFactura)}</strong>${p.fechaFactura ? `<br><small class="texto-suave">${esc(p.fechaFactura)}</small>` : ''}`
        : '<span class="texto-suave">—</span>'}</td>
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
      <td class="centrado"><button type="button" class="boton boton-peligro"
          data-action="pedir-borrar-pedido" data-id="${p.id}"
          title="Anular o eliminar el pedido">🗑</button></td>
    </tr>`;
  }).join('') || `<tr><td colspan="10" class="vacio">${
    pedidos.length ? 'No hay pedidos que coincidan con la búsqueda.' : 'No hay pedidos registrados.'
  }</td></tr>`;
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
  const fiscal = {
    rut: document.getElementById('ped-rut')?.value.trim() || '',
    razonSocial: document.getElementById('ped-razon')?.value.trim() || '',
    numeroFactura: document.getElementById('ped-num-factura')?.value.trim() || '',
    fechaFactura: document.getElementById('ped-fecha-factura')?.value || ''
  };
  const lineas = estado.borradorPedido.filter(l => l.refId && l.cantidad >= 1);

  if (!cliente) { avisar('⚠️ Ingresá el nombre del cliente', 'error'); return; }
  if (!lineas.length) { avisar('⚠️ Agregá al menos un artículo o combo', 'error'); return; }
  if (conFactura && !fiscal.rut) {
    avisar('⚠️ Un pedido con factura necesita el RUT', 'error');
    document.getElementById('ped-rut').focus();
    return;
  }

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
    const clienteBD = await DataStore.obtenerOCrearCliente({
      nombre: cliente, rut: fiscal.rut, razonSocial: fiscal.razonSocial
    });
    const codigo = await DataStore.crearPedido({
      fecha, cliente, clienteId: clienteBD.id, estado: estadoPedido, conFactura, ...fiscal
    }, items);
    const t = totalesPedido(items, conFactura);
    document.getElementById('ped-cliente').value = '';
    document.getElementById('ped-factura').checked = false;
    ['ped-rut', 'ped-razon', 'ped-num-factura', 'ped-fecha-factura']
      .forEach(id => { const el = document.getElementById(id); if (el) el.value = ''; });
    alternarCamposFactura();
    estado.borradorPedido = [{ tipo: 'articulo', refId: '', cantidad: 1, precioUnitario: 0 }];
    await recargar();
    avisar(`✅ Pedido ${codigo} creado para ${cliente} — total ${dinero(t.total)}` +
           (conFactura ? ` (incluye ${dinero(t.iva)} de IVA)` : ''), 'exito');
  } catch (error) {
    avisar(`❌ ${error.message}`, 'error');
  }
}

/* ================ IMPORTADOR 3MF — VISTA PREVIA Y CONFIRMACIÓN ============ */

function placaImportada() {
  const importacion = estado.importacion;
  if (!importacion) return null;
  return importacion.placas.find(
    p => p.index === Number(document.getElementById('imp-placa')?.value)
  ) || importacion.placas[0];
}

function renderizarImportacion() {
  const caja = document.getElementById('imp-resultado');
  if (!caja) return;
  const importacion = estado.importacion;
  if (!importacion) { caja.hidden = true; return; }
  caja.hidden = false;

  document.getElementById('imp-nombre').textContent = importacion.nombre;
  const origen = [
    importacion.version ? `BambuStudio ${importacion.version}` : '',
    importacion.impresora,
    importacion.boquilla ? `boquilla ${importacion.boquilla} mm` : ''
  ].filter(Boolean).join(' · ');
  document.getElementById('imp-origen').textContent = origen || '3MF importado';

  document.getElementById('imp-placa').innerHTML = importacion.placas.map(p =>
    `<option value="${p.index}">Plataforma ${p.index}` +
    `${p.nombre ? ' — ' + esc(p.nombre) : ''} · ` +
    `${Calc.aReloj(p.segundos / 3600)} · ${p.gramos.toFixed(2)} g</option>`).join('');
  document.getElementById('imp-placa').value = importacion.indice;

  dibujarDetalleImportacion();
}

function dibujarDetalleImportacion() {
  const placa = placaImportada();
  if (!placa) return;

  document.getElementById('imp-gramos').textContent = `${placa.gramos.toFixed(2)} g`;
  document.getElementById('imp-tiempo').textContent = Calc.aReloj(placa.segundos / 3600);

  const principal = placa.filamentos.slice().sort((a, b) => b.gramos - a.gramos)[0] || {};
  const materiales = placa.filamentos.map(f =>
    [f.tipo, f.color].filter(Boolean).join(' / ') || '—').join(' + ');
  document.getElementById('imp-material').textContent = materiales || '—';

  const sugerido = sugerirFilamento(principal.tipo, principal.color);
  const selector = document.getElementById('imp-filamento');
  selector.innerHTML = `<option value="">— Sin descontar stock —</option>` +
    estado.datos.filamentos.map(f =>
      `<option value="${f.id}">${esc(f.codigo)} · ${esc(f.nombre)}` +
      `${sugerido && f.id === sugerido.id ? '  ⭐ sugerida' : ''}</option>`).join('');
  selector.value = sugerido ? String(sugerido.id) : '';

  const texto = document.getElementById('imp-sugerencia-texto');
  if (!estado.datos.filamentos.length) {
    texto.textContent = 'Todavía no cargaste bobinas. Podés continuar sin descontar stock.';
  } else if (sugerido) {
    texto.textContent = `Sugerencia: ${sugerido.codigo} · ${sugerido.nombre} ` +
      `(${sugerido.material} ${sugerido.color}). Ya viene preseleccionada, pero confirmala ` +
      `abajo o elegí otra antes de cargar el formulario.`;
  } else {
    texto.textContent = 'No hay una bobina que coincida con el material/color del archivo. ' +
      'Elegí una manualmente o dejá sin descontar stock.';
  }
}

async function importar3MF() {
  const archivo = document.getElementById('imp-archivo')?.files?.[0];
  if (!archivo) {
    avisar('⚠️ Elegí un archivo .gcode.3mf de Bambu Studio', 'error');
    return;
  }
  try {
    avisar('⌁ Leyendo archivo 3MF…');
    const datos = await leerArchivo3MF(archivo);
    datos.indice = datos.placas[0].index;
    estado.importacion = datos;
    document.getElementById('imp-cantidad').value = datos.piezas;
    renderizarImportacion();
    avisar(`✅ ${datos.placas.length} plataforma(s) leídas. Confirmá los datos.`, 'exito');
  } catch (error) {
    estado.importacion = null;
    renderizarImportacion();
    avisar(`❌ ${error.message}`, 'error');
  }
}

function confirmarImportacion() {
  const placa = placaImportada();
  if (!placa) return;
  if (placa.segundos <= 0 || placa.gramos <= 0) {
    avisar('⚠️ La plataforma no tiene tiempo o peso válido. Probá con otra plataforma.', 'error');
    return;
  }

  const cantidad = Math.max(1, Math.floor(
    Number(document.getElementById('imp-cantidad').value) || 1));
  actualizarSelectorFilamentos();
  document.getElementById('med-articulo').value = estado.importacion.nombre;
  document.getElementById('med-cantidad').value = cantidad;
  document.getElementById('med-gramos').value = placa.gramos.toFixed(2);
  document.getElementById('med-impresion').value = Calc.aReloj(placa.segundos / 3600);
  const bobinaElegida = document.getElementById('imp-filamento').value;
  document.getElementById('med-filamento').value = bobinaElegida;
  if (bobinaElegida && document.getElementById('med-filamento').value !== bobinaElegida) {
    avisar('⚠️ La bobina elegida ya no existe en el inventario. Elegí una manualmente.', 'error');
  }
  actualizarStockFilamento();

  cancelarImportacion();
  document.getElementById('form-medicion')
    .scrollIntoView({ behavior: 'smooth', block: 'center' });
  avisar('✅ Datos cargados. Revisá el formulario y apretá «Guardar medición».', 'exito');
}

function cancelarImportacion() {
  estado.importacion = null;
  renderizarImportacion();
  const archivo = document.getElementById('imp-archivo');
  if (archivo) archivo.value = '';
}

/* ==================== MÓDULO 7: MEDICIONES =============================== */

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
      factor: Number(document.getElementById('med-factor').value) || 2.5,
      filamentoId: Number(document.getElementById('med-filamento')?.value) || null
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

/* =================== MÓDULO 6: PANEL DE CAPACIDAD ======================== */

const ESTADOS_EN_CURSO = ['Pendiente', 'En Producción', 'Listo para Entrega'];

/** Horas de impresión por unidad, desde la fila calculada o desde el historial. */
function horasImpresionPorUnidad(articuloId) {
  if (articuloId == null) return 0;
  const fila = estado.filasCalculadas.find(f => String(f.articuloId) === String(articuloId));
  if (fila) {
    return Math.max(0, Number(fila.impresionLoteH) || 0) /
           Math.max(1, Number(fila.cantidad) || 1);
  }
  const referencia = estado.datos.mediciones.find(
    m => String(m.articuloId) === String(articuloId));
  return referencia
    ? Math.max(0, Number(referencia.impresionH) || 0) /
      Math.max(1, Number(referencia.cantidad) || 1)
    : 0;
}

/** Horas de impresión y piezas de un pedido (los combos se expanden). */
function horasPedido(pedido) {
  let horas = 0, piezas = 0;
  for (const it of pedido.items || []) {
    const cantidad = Math.max(0, Number(it.cantidad) || 0);
    if (it.tipo === 'combo' && it.comboId != null) {
      const combo = comboPorId(it.comboId);
      for (const ci of combo?.items || []) {
        horas += horasImpresionPorUnidad(ci.articuloId) *
                 Math.max(0, Number(ci.cantidad) || 0) * cantidad;
      }
      piezas += (combo?.items || []).reduce(
        (suma, ci) => suma + (Number(ci.cantidad) || 0), 0) * cantidad;
    } else if (it.articuloId != null) {
      horas += horasImpresionPorUnidad(it.articuloId) * cantidad;
      piezas += cantidad;
    }
  }
  return { horas, piezas };
}

function renderizarCapacidad() {
  const activos = estado.datos.pedidos
    .filter(p => ESTADOS_EN_CURSO.includes(p.estado))
    .map(p => ({ pedido: p, ...horasPedido(p) }));
  const totalHoras = activos.reduce((suma, fila) => suma + fila.horas, 0);
  const disponibles = Math.max(1, Number(estado.capacidadHoras) || 40);
  const porcentaje = (totalHoras / disponibles) * 100;

  document.getElementById('cap-horas-curso').textContent = Calc.aReloj(totalHoras);
  document.getElementById('cap-horas-disponibles').value = disponibles;
  document.getElementById('cap-porcentaje').textContent = `${Math.round(porcentaje)} %`;

  const barra = document.getElementById('cap-barra');
  barra.style.width = `${Math.min(100, porcentaje)}%`;
  barra.className = 'relleno-progreso' +
    (porcentaje > 100 ? ' alta' : porcentaje > 70 ? ' media' : '');
  document.getElementById('cap-estado').textContent = !activos.length
    ? 'Sin pedidos en curso'
    : porcentaje > 100 ? '⚠️ Por encima de la capacidad semanal'
    : porcentaje > 70 ? '🟡 Capacidad ajustada'
    : '🟢 Dentro de la capacidad';

  const valorStock = estado.datos.filamentos.reduce(
    (suma, f) => suma + Number(f.kg || 0) * Number(f.costoKg || 0), 0);
  document.getElementById('cap-valor-stock').textContent = dinero(valorStock);

  /* Top 5: se cuentan los artículos dentro de combos y se ignoran cancelados. */
  const conteo = new Map();
  const sumar = (articuloId, unidades, pedidoId) => {
    if (articuloId == null || unidades <= 0) return;
    const clave = String(articuloId);
    const actual = conteo.get(clave) || { unidades: 0, horas: 0, pedidos: new Set() };
    actual.unidades += unidades;
    actual.horas += horasImpresionPorUnidad(articuloId) * unidades;
    actual.pedidos.add(pedidoId);
    conteo.set(clave, actual);
  };

  for (const p of estado.datos.pedidos) {
    if (p.estado === 'Cancelado') continue;
    for (const it of p.items || []) {
      const cantidad = Math.max(0, Number(it.cantidad) || 0);
      if (it.tipo === 'combo' && it.comboId != null) {
        const combo = comboPorId(it.comboId);
        for (const ci of combo?.items || []) {
          sumar(ci.articuloId, (Number(ci.cantidad) || 0) * cantidad, p.id);
        }
      } else if (it.articuloId != null) {
        sumar(it.articuloId, cantidad, p.id);
      }
    }
  }

  const top = [...conteo.entries()]
    .map(([id, datos]) => ({ id, ...datos, articulo: articuloPorId(id) }))
    .sort((a, b) => b.unidades - a.unidades)
    .slice(0, 5);

  document.getElementById('cap-top-articulos').innerHTML = top.map((fila, i) => `
    <tr>
      <td class="num">${i + 1}</td>
      <td><strong>${esc(fila.articulo?.codigo || '—')}</strong>
          ${esc(fila.articulo?.nombre || `Artículo ${fila.id}`)}</td>
      <td class="num">${fila.unidades}</td>
      <td class="num">${Calc.aReloj(fila.horas)}</td>
      <td class="num">${fila.pedidos.size}</td>
    </tr>`).join('') ||
    `<tr><td colspan="5" class="vacio">Todavía no hay artículos en pedidos.</td></tr>`;

  document.getElementById('cap-detalle-pedidos').innerHTML = activos
    .sort((a, b) => b.horas - a.horas).map(({ pedido, horas, piezas }) => `
    <tr>
      <td><strong>${esc(pedido.codigo)}</strong>
          <br><small class="texto-suave">${esc(pedido.fecha)}</small></td>
      <td>${esc(pedido.cliente)}</td>
      <td><span class="etiqueta etiqueta-azul">${esc(pedido.estado)}</span></td>
      <td class="num">${piezas}</td>
      <td class="num">${Calc.aReloj(horas)}</td>
      <td class="num">${totalHoras ? Math.round(horas / totalHoras * 100) : 0} %</td>
    </tr>`).join('') ||
    `<tr><td colspan="6" class="vacio">No hay pedidos pendientes ni en producción.</td></tr>`;
}

/* ==================== MÓDULO 9: PARÁMETROS =============================== */

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

/* ================== CONFIRMACIONES (modal, sin confirm()) ================= */

function pedirConfirmacion({ titulo, mensaje, etiqueta = 'Eliminar', anular = null,
                             onConfirmar, onAnular }) {
  estado.confirmacion = { onConfirmar, onAnular };
  document.getElementById('modal-titulo').textContent = titulo;
  document.getElementById('modal-mensaje').textContent = mensaje;
  const botonAnular = document.getElementById('modal-anular');
  botonAnular.hidden = !anular;
  botonAnular.textContent = anular || 'Anular pedido';
  document.getElementById('modal-confirmar-btn').textContent = etiqueta;
  document.getElementById('modal-confirmar').classList.add('visible');
}

function cerrarConfirmacion() {
  estado.confirmacion = null;
  document.getElementById('modal-confirmar').classList.remove('visible');
}

async function ejecutarConfirmacion(tipo) {
  const callback = estado.confirmacion?.[tipo];
  cerrarConfirmacion();
  if (callback) await callback();
}

function alternarCamposFactura() {
  const conFactura = document.getElementById('ped-factura')?.checked || false;
  const bloque = document.getElementById('campos-factura');
  if (bloque) bloque.hidden = !conFactura;
  const rut = document.getElementById('ped-rut');
  if (rut) rut.required = conFactura;
}

async function borrarPedido(id) {
  await DataStore.eliminarPedido(id);
  await recargar();
  avisar('🗑 Pedido eliminado', 'exito');
}

async function anularPedido(id) {
  await DataStore.cambiarEstadoPedido(id, 'Cancelado');
  await recargar();
  avisar('⊘ Pedido anulado (el histórico se conserva)', 'exito');
}

async function borrarCliente(id) {
  await DataStore.eliminarCliente(id);
  await recargar();
  avisar('🗑 Cliente eliminado', 'exito');
}

async function borrarFilamento(id) {
  await DataStore.eliminarFilamento(id);
  await recargar();
  avisar('🗑 Filamento eliminado', 'exito');
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

    case 'ir-inventario':
      activarPestana('filamentos');
      break;

    case 'limpiar-filtro': {
      const tabla = boton.dataset.tabla;
      const filtro = estado.filtros[tabla];
      filtro.texto = '';
      filtro.estado = '';
      const entrada = document.querySelector(`[data-filtro-texto="${tabla}"]`);
      if (entrada) entrada.value = '';
      const selector = document.querySelector(`[data-filtro-estado="${tabla}"]`);
      if (selector) selector.value = '';
      redibujarTabla(tabla);
      break;
    }

    case 'guardar-medicion-cotizador':
      await guardarMedicionDelCotizador();
      break;

    case 'importar-3mf':
      await importar3MF();
      break;

    case 'confirmar-importacion':
      confirmarImportacion();
      break;

    case 'cancelar-importacion':
      cancelarImportacion();
      avisar('Importación descartada', 'info');
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
      pedirConfirmacion({
        titulo: 'Eliminar fila del catálogo',
        mensaje: '¿Eliminar esta fila del catálogo de costos? Esta acción no se puede deshacer.',
        onConfirmar: async () => {
          await DataStore.eliminarRegistro(id);
          await recargar();
          avisar('🗑 Fila eliminada', 'exito');
        }
      });
      break;

    case 'borrar-combo':
      pedirConfirmacion({
        titulo: 'Eliminar combo',
        mensaje: '¿Eliminar este combo del historial? Los pedidos que lo usen se conservan.',
        onConfirmar: async () => {
          await DataStore.eliminarCombo(id);
          await recargar();
          avisar('🗑 Combo eliminado', 'exito');
        }
      });
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

    case 'pedir-borrar-pedido': {
      const pedido = estado.datos.pedidos.find(p => p.id === id);
      pedirConfirmacion({
        titulo: `Pedido ${pedido?.codigo || ''}`,
        mensaje: 'Anularlo conserva el histórico y solo lo marca como Cancelado. ' +
                 'Eliminarlo borra el pedido y todos sus ítems definitivamente.',
        etiqueta: 'Eliminar definitivamente',
        anular: 'Anular pedido',
        onConfirmar: () => borrarPedido(id),
        onAnular: () => anularPedido(id)
      });
      break;
    }

    case 'modal-cancelar':
      cerrarConfirmacion();
      break;

    case 'modal-confirmar':
      await ejecutarConfirmacion('onConfirmar');
      break;

    case 'modal-anular':
      await ejecutarConfirmacion('onAnular');
      break;

    case 'borrar-item-pedido':
      await DataStore.eliminarItemPedido(id);
      await recargar();
      avisar('🗑 Ítem quitado del pedido', 'exito');
      break;

    case 'borrar-medicion':
      pedirConfirmacion({
        titulo: 'Eliminar medición real',
        mensaje: '¿Eliminar esta medición del slicer? Se recalcularán los costos.',
        onConfirmar: async () => {
          await DataStore.eliminarMedicion(id);
          await recargar();
          avisar('🗑 Medición eliminada', 'exito');
        }
      });
      break;

    case 'editar-cliente': {
      const c = estado.datos.clientes.find(x => x.id === id);
      if (!c) break;
      estado.clienteEditando = c.id;
      document.getElementById('cli-nombre').value = c.nombre;
      document.getElementById('cli-rut').value = c.rut;
      document.getElementById('cli-razon').value = c.razonSocial;
      document.getElementById('cli-telefono').value = c.telefono;
      document.getElementById('cli-email').value = c.email;
      document.getElementById('cli-direccion').value = c.direccion;
      document.getElementById('cli-notas').value = c.notas;
      document.getElementById('form-cliente-titulo').textContent = 'Editar cliente';
      document.getElementById('cli-nombre').focus();
      break;
    }

    case 'pedir-borrar-cliente': {
      const c = estado.datos.clientes.find(x => x.id === id);
      const usos = estado.datos.pedidos.filter(p => p.clienteId === id).length;
      pedirConfirmacion({
        titulo: 'Eliminar cliente',
        mensaje: usos
          ? `El cliente ${c?.nombre || ''} tiene ${usos} pedido(s) vinculado(s). ` +
            'Se desvincularán, pero los pedidos se conservan.'
          : `¿Eliminar el cliente ${c?.nombre || ''}?`,
        onConfirmar: () => borrarCliente(id)
      });
      break;
    }

    case 'pedir-borrar-filamento': {
      const f = estado.datos.filamentos.find(x => x.id === id);
      pedirConfirmacion({
        titulo: 'Eliminar filamento',
        mensaje: `¿Eliminar ${f?.nombre || 'el filamento'}? Solo se puede si no tiene ` +
                 'movimientos de inventario registrados.',
        onConfirmar: () => borrarFilamento(id)
      });
      break;
    }

    case 'entrada-filamento': {
      const input = document.querySelector(`[data-campo="fil-entrada"][data-id="${id}"]`);
      const kg = Number(input?.value) || 0;
      if (kg <= 0) { avisar('⚠️ Ingresá una cantidad de kg mayor a cero', 'error'); return; }
      try {
        await DataStore.moverFilamento(id, 'entrada', kg, 'Entrada de stock registrada en la app');
        await recargar();
        avisar(`✅ Entrada de ${kg.toFixed(3)} kg registrada`, 'exito');
      } catch (error) {
        avisar(`❌ ${error.message}`, 'error');
      }
      break;
    }
  }
}

/* ====================== FORMULARIOS NUEVOS ================================ */

async function manejarCliente(evento) {
  evento.preventDefault();
  const valor = id => document.getElementById(id)?.value.trim() || '';
  const campos = {
    nombre: valor('cli-nombre'), rut: valor('cli-rut'),
    razonSocial: valor('cli-razon'), telefono: valor('cli-telefono'),
    email: valor('cli-email'), direccion: valor('cli-direccion'),
    notas: valor('cli-notas')
  };
  if (!campos.nombre) { avisar('⚠️ Ingresá el nombre del cliente', 'error'); return; }
  try {
    if (estado.clienteEditando) {
      await DataStore.actualizarCliente(estado.clienteEditando, campos);
      avisar('✅ Cliente actualizado', 'exito');
    } else {
      await DataStore.obtenerOCrearCliente(campos);
      avisar('✅ Cliente guardado', 'exito');
    }
    evento.target.reset();
    estado.clienteEditando = null;
    document.getElementById('form-cliente-titulo').textContent = 'Nuevo cliente';
    await recargar();
  } catch (error) {
    avisar(`❌ ${error.message}`, 'error');
  }
}

async function manejarFilamento(evento) {
  evento.preventDefault();
  const valor = id => document.getElementById(id)?.value.trim() || '';
  const datos = {
    nombre: valor('fil-nombre'), material: valor('fil-material'), color: valor('fil-color'),
    kg: Number(valor('fil-kg')) || 0,
    kgAlerta: Number(valor('fil-alerta')) || 0.5,
    costoKg: Number(valor('fil-costo')) || 0,
    proveedor: valor('fil-proveedor')
  };
  try {
    await DataStore.crearFilamento(datos);
    evento.target.reset();
    document.getElementById('fil-alerta').value = '0.5';
    await recargar();
    avisar(`✅ Filamento ${datos.nombre} agregado`, 'exito');
  } catch (error) {
    avisar(`❌ ${error.message}`, 'error');
  }
}

function configurarEventos() {
  // Módulos del menú lateral
  document.querySelectorAll('.pestana').forEach(boton => {
    boton.addEventListener('click', () => activarPestana(boton.dataset.tab));
  });

  // Búsqueda en clientes, pedidos y movimientos (sólo redibuja esa tabla)
  document.querySelectorAll('[data-filtro-texto]').forEach(input => {
    input.addEventListener('input', () => {
      estado.filtros[input.dataset.filtroTexto].texto = input.value;
      redibujarTabla(input.dataset.filtroTexto);
    });
  });

  document.querySelectorAll('[data-filtro-estado]').forEach(select => {
    select.addEventListener('change', () => {
      estado.filtros[select.dataset.filtroEstado].estado = select.value;
      redibujarTabla(select.dataset.filtroEstado);
    });
  });

  // Orden por columna
  document.querySelectorAll('.orden').forEach(boton => {
    boton.addEventListener('click', () => {
      const filtro = estado.filtros[boton.dataset.tabla];
      if (filtro.orden === boton.dataset.orden) filtro.dir *= -1;
      else { filtro.orden = boton.dataset.orden; filtro.dir = 1; }
      redibujarTabla(boton.dataset.tabla);
    });
  });

  // Capacidad de impresora (preferencia local)
  document.getElementById('cap-horas-disponibles')?.addEventListener('change', evento => {
    estado.capacidadHoras = Math.max(1, Number(evento.target.value) || 40);
    guardarPreferencia('printlab.horasImpresora', estado.capacidadHoras);
    renderizarCapacidad();
  });

  // Formularios
  document.getElementById('form-articulo').addEventListener('submit', manejarArticulo);
  document.getElementById('form-medicion').addEventListener('submit', manejarMedicion);
  document.getElementById('form-pedido').addEventListener('submit', crearPedido);
  document.getElementById('form-cliente').addEventListener('submit', manejarCliente);
  document.getElementById('form-filamento').addEventListener('submit', manejarFilamento);
  document.getElementById('art-nombre').addEventListener('input', actualizarPreviewId);

  document.getElementById('med-filamento')?.addEventListener('change', actualizarStockFilamento);

  // Importador 3MF de Bambu Studio
  document.getElementById('imp-placa')?.addEventListener('change', dibujarDetalleImportacion);

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
    casillaFactura.addEventListener('change', () => {
      dibujarBorradorPedido();
      alternarCamposFactura();
    });
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
  document.getElementById('ped-fecha-factura').value = hoy;
  alternarCamposFactura();
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
