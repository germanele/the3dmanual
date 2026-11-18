/**
 * =============================================================================
 * CAPA DE DATOS — v2  (Supabase / PostgREST)
 * -----------------------------------------------------------------------------
 * Traduce entre el modelo camelCase que usa la interfaz y el esquema SQL
 * normalizado. Toda escritura relevante pasa por constraints o RPCs
 * transaccionales definidas en supabase_schema.sql.
 * =============================================================================
 */

const DataStore = (() => {
  'use strict';

  let cliente = null;

  function bd() {
    if (!cliente) throw new Error('Base de datos no inicializada');
    return cliente;
  }

  function verificar(error, contexto) {
    if (error) throw new Error(`${contexto}: ${error.message}`);
  }

  /* --------------------------- adaptadores -------------------------------- */

  const aArticulo = a => ({
    id: Number(a.id),
    codigo: a.codigo,
    nombre: a.nombre
  });

  const aMedicion = (m, articulos) => {
    const art = articulos.get(Number(m.articulo_id));
    return {
      id: Number(m.id),
      fecha: m.fecha,
      articuloId: Number(m.articulo_id),
      codigo: art ? art.codigo : '',
      nombre: art ? art.nombre : `Artículo ${m.articulo_id}`,
      cantidad: Number(m.cantidad),
      gramos: Number(m.gramos_lote),
      impresionH: Number(m.horas_impresion_lote),
      preparacionH: Number(m.horas_preparacion_lote),
      postUnitH: Number(m.horas_postprocesado_unit),
      factor: Number(m.factor)
    };
  };

  const aRegistro = (r, articulos) => {
    const art = articulos.get(Number(r.articulo_id));
    return {
      id: Number(r.id),
      articuloId: Number(r.articulo_id),
      codigo: art ? art.codigo : '',
      nombre: art ? art.nombre : `Artículo ${r.articulo_id}`,
      cantidad: Number(r.cantidad),
      factor: Number(r.factor)
    };
  };

  const aComboItem = ci => ({
    id: Number(ci.id),
    articuloId: Number(ci.articulo_id),
    cantidad: Number(ci.cantidad),
    descripcion: ci.descripcion,
    precioUnitario: Number(ci.precio_unitario)
  });

  const aCombo = (c, itemsPorCombo) => ({
    id: Number(c.id),
    fecha: c.fecha,
    nombre: c.nombre,
    presupuesto: Number(c.presupuesto),
    opcion: c.opcion,
    composicion: c.composicion,
    precioVenta: Number(c.precio_venta),
    costoProduccion: Number(c.costo_produccion),
    saldo: Number(c.saldo),
    estado: c.estado,
    items: itemsPorCombo.get(Number(c.id)) || []
  });

  const aPedidoItem = pi => ({
    id: Number(pi.id),
    tipo: pi.tipo,
    articuloId: pi.articulo_id == null ? null : Number(pi.articulo_id),
    comboId: pi.combo_id == null ? null : Number(pi.combo_id),
    descripcion: pi.descripcion,
    cantidad: Number(pi.cantidad),
    precioUnitario: Number(pi.precio_unitario)
  });

  const aPedido = (p, itemsPorPedido) => ({
    id: Number(p.id),
    codigo: p.codigo,
    fecha: p.fecha,
    cliente: p.cliente,
    estado: p.estado,
    items: itemsPorPedido.get(Number(p.id)) || []
  });

  /* ------------------------------ ciclo de vida --------------------------- */

  async function init() {
    const config = window.APP_CONFIG || {};
    if (!window.supabase || typeof window.supabase.createClient !== 'function') {
      throw new Error('No se cargó el SDK de Supabase (revisá el <script> en index.html)');
    }
    if (!config.url || !config.anonKey || config.url.includes('TU-PROYECTO')) {
      throw new Error('Configurá url y anonKey en config.js');
    }

    cliente = window.supabase.createClient(config.url, config.anonKey, {
      auth: { persistSession: false, autoRefreshToken: false }
    });

    const { error } = await cliente.from('parametros_base').select('clave').limit(1);
    if (error) {
      throw new Error(`${error.message} — ¿Ejecutaste supabase_schema.sql en el SQL Editor?`);
    }
    return true;
  }

  /** Carga todos los datos en paralelo y arma el modelo de vista en memoria. */
  async function cargarTodo() {
    const c = bd();
    const consultas = await Promise.all([
      c.from('parametros_base').select('*').order('clave'),
      c.from('articulos').select('*').order('codigo', { ascending: true }),
      c.from('mediciones_slicer').select('*').order('fecha', { ascending: false }).order('id'),
      c.from('registro_costos').select('*').order('id'),
      c.from('combos').select('*').order('fecha', { ascending: false }).order('id', { ascending: false }),
      c.from('combo_items').select('*').order('id'),
      c.from('pedidos').select('*').order('fecha', { ascending: false }).order('id', { ascending: false }),
      c.from('pedido_items').select('*').order('id')
    ]);

    const nombres = [
      'parámetros base', 'artículos', 'mediciones', 'registro de costos',
      'combos', 'ítems de combo', 'pedidos', 'ítems de pedido'
    ];
    consultas.forEach((res, i) => verificar(res.error, `Error cargando ${nombres[i]}`));

    const [params, arts, meds, reg, combos, comboItems, pedidos, pedItems] =
      consultas.map(r => r.data || []);

    const mapaArticulos = new Map(arts.map(a => [Number(a.id), aArticulo(a)]));

    const itemsCombo = new Map();
    for (const ci of comboItems) {
      const id = Number(ci.combo_id);
      if (!itemsCombo.has(id)) itemsCombo.set(id, []);
      itemsCombo.get(id).push(aComboItem(ci));
    }

    const itemsPedido = new Map();
    for (const pi of pedItems) {
      const id = Number(pi.pedido_id);
      if (!itemsPedido.has(id)) itemsPedido.set(id, []);
      itemsPedido.get(id).push(aPedidoItem(pi));
    }

    return {
      parametros: params,
      articulos: [...mapaArticulos.values()],
      mediciones: meds.map(m => aMedicion(m, mapaArticulos)),
      registro: reg.map(r => aRegistro(r, mapaArticulos)),
      combos: combos.map(c => aCombo(c, itemsCombo)),
      pedidos: pedidos.map(p => aPedido(p, itemsPedido))
    };
  }

  /* ------------------------------- artículos ------------------------------ */

  /** Obtiene o crea un artículo por nombre. La BD genera el código ART-XXX. */
  async function obtenerOCrearArticulo(nombre) {
    const { data, error } = await bd().rpc('api_obtener_o_crear_articulo', { p_nombre: nombre });
    verificar(error, 'No se pudo resolver el artículo');
    if (!data || !data.length) throw new Error('La base de datos no devolvió el artículo');
    return aArticulo(data[0]);
  }

  async function renombrarArticulo(id, nombre) {
    const { error } = await bd().from('articulos').update({ nombre }).eq('id', id);
    verificar(error, 'No se pudo renombrar el artículo');
  }

  /* --------------------------- registro de costos ------------------------- */

  async function agregarRegistro(articuloId, cantidad, factor) {
    const { error } = await bd().from('registro_costos')
      .insert([{ articulo_id: articuloId, cantidad, factor }]);
    verificar(error, 'No se pudo agregar el artículo al catálogo');
  }

  async function actualizarRegistro(id, campos) {
    const payload = {};
    if ('cantidad' in campos) payload.cantidad = campos.cantidad;
    if ('factor' in campos) payload.factor = campos.factor;
    const { error } = await bd().from('registro_costos').update(payload).eq('id', id);
    verificar(error, 'No se pudo actualizar el registro');
  }

  async function eliminarRegistro(id) {
    const { error } = await bd().from('registro_costos').delete().eq('id', id);
    verificar(error, 'No se pudo eliminar el registro');
  }

  /* ------------------------ mediciones del slicer ------------------------- */

  async function guardarMedicion(m) {
    const payload = {
      fecha: m.fecha,
      articulo_id: m.articuloId,
      cantidad: m.cantidad,
      gramos_lote: m.gramos,
      horas_impresion_lote: m.impresionH,
      horas_preparacion_lote: m.preparacionH,
      horas_postprocesado_unit: m.postUnitH,
      factor: m.factor
    };
    const { error } = await bd().from('mediciones_slicer')
      .upsert(payload, { onConflict: 'articulo_id,cantidad' });
    verificar(error, 'No se pudo guardar la medición');
  }

  async function actualizarMedicion(id, campos) {
    const columnas = {
      gramos: 'gramos_lote',
      impresionH: 'horas_impresion_lote',
      preparacionH: 'horas_preparacion_lote',
      postUnitH: 'horas_postprocesado_unit'
    };
    const payload = {};
    for (const [clave, columna] of Object.entries(columnas)) {
      if (clave in campos) payload[columna] = campos[clave];
    }
    const { error } = await bd().from('mediciones_slicer').update(payload).eq('id', id);
    verificar(error, 'No se pudo actualizar la medición');
  }

  async function eliminarMedicion(id) {
    const { error } = await bd().from('mediciones_slicer').delete().eq('id', id);
    verificar(error, 'No se pudo eliminar la medición');
  }

  /* -------------------------------- combos -------------------------------- */

  async function guardarCombo(combo, items) {
    const { error, data } = await bd().rpc('api_guardar_combo', {
      p_nombre: combo.nombre,
      p_fecha: combo.fecha,
      p_presupuesto: combo.presupuesto,
      p_opcion: combo.opcion,
      p_composicion: combo.composicion,
      p_precio_venta: combo.precioVenta,
      p_costo: combo.costoProduccion,
      p_saldo: combo.saldo,
      p_items: items
    });
    verificar(error, 'No se pudo guardar el combo');
    return data;
  }

  async function renombrarCombo(id, nombre) {
    const { error } = await bd().from('combos').update({ nombre }).eq('id', id);
    verificar(error, 'No se pudo renombrar el combo');
  }

  async function eliminarCombo(id) {
    const { error } = await bd().from('combos').delete().eq('id', id);
    verificar(error, 'No se pudo eliminar el combo');
  }

  /* ------------------------------- pedidos -------------------------------- */

  /** Inserta pedido + ítems en una única transacción. Devuelve el código PED-XXX. */
  async function crearPedido(pedido, items) {
    const { data, error } = await bd().rpc('api_crear_pedido', {
      p_cliente: pedido.cliente,
      p_fecha: pedido.fecha,
      p_estado: pedido.estado,
      p_items: items
    });
    verificar(error, 'No se pudo crear el pedido');
    return data;
  }

  async function cambiarEstadoPedido(id, estado) {
    const { error } = await bd().from('pedidos').update({ estado }).eq('id', id);
    verificar(error, 'No se pudo cambiar el estado');
  }

  async function eliminarPedido(id) {
    const { error } = await bd().from('pedidos').delete().eq('id', id);
    verificar(error, 'No se pudo eliminar el pedido');
  }

  async function actualizarItemPedido(id, campos) {
    const payload = {};
    if ('cantidad' in campos) payload.cantidad = campos.cantidad;
    if ('precioUnitario' in campos) payload.precio_unitario = campos.precioUnitario;
    const { error } = await bd().from('pedido_items').update(payload).eq('id', id);
    verificar(error, 'No se pudo actualizar el ítem');
  }

  async function eliminarItemPedido(id) {
    const { error } = await bd().from('pedido_items').delete().eq('id', id);
    verificar(error, 'No se pudo quitar el ítem');
  }

  /* ------------------------------ parámetros ------------------------------ */

  async function actualizarParametro(clave, valor) {
    const { error } = await bd().from('parametros_base')
      .update({ valor }).eq('clave', clave);
    verificar(error, 'No se pudo actualizar el parámetro');
  }

  return {
    init,
    cargarTodo,
    obtenerOCrearArticulo,
    renombrarArticulo,
    agregarRegistro,
    actualizarRegistro,
    eliminarRegistro,
    guardarMedicion,
    actualizarMedicion,
    eliminarMedicion,
    guardarCombo,
    renombrarCombo,
    eliminarCombo,
    crearPedido,
    cambiarEstadoPedido,
    eliminarPedido,
    actualizarItemPedido,
    eliminarItemPedido,
    actualizarParametro
  };
})();
