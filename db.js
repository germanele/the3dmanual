/**
 * ============================================================================
 * CAPA DE PERSISTENCIA SUPABASE / POSTGRESQL
 * Gestión Impresión 3D - Costos, Artículos, Combos y Clientes (Uruguay)
 * ============================================================================
 */

// Reemplaza estos valores con las credenciales de tu proyecto Supabase (Project Settings -> API)
const SUPABASE_URL = 'https://ffpwwfhtpgciizigkvbe.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_ju6QdIHOgPo9VT10klGxtw_Z6jCPBaZ';

let supabaseClient = null;

const DB3D = (() => {
  async function init() {
    if (typeof window.supabase === 'undefined') {
      throw new Error('El SDK de Supabase no está cargado. Verifica la etiqueta <script> en index.html.');
    }
    if (SUPABASE_URL.includes('TU-PROYECTO') || SUPABASE_ANON_KEY.includes('TU-SUPABASE')) {
      throw new Error('Configura SUPABASE_URL y SUPABASE_ANON_KEY en db.js antes de iniciar.');
    }

    supabaseClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

    // Verificar conexión
    const { error } = await supabaseClient.from('parametros_base').select('clave').limit(1);
    if (error) {
      throw new Error('Error conectando a Supabase: ' + error.message);
    }
  }

  function getClient() {
    if (!supabaseClient) throw new Error('Supabase no inicializado.');
    return supabaseClient;
  }

  async function getAllData() {
    const client = getClient();
    const [
      { data: paramRows, error: e1 },
      { data: articulos, error: e2 },
      { data: escalasRaw, error: e3 },
      { data: registroRaw, error: e4 },
      { data: combosGuardados, error: e5 },
      { data: pedidos, error: e6 },
      { data: pedidoItems, error: e7 }
    ] = await Promise.all([
      client.from('parametros_base').select('*'),
      client.from('articulos').select('id_articulo, nombre').order('id_articulo', { ascending: true }),
      client.from('escalas_reales').select('*').order('id', { ascending: true }),
      client.from('registro_costos').select('*').order('id', { ascending: true }),
      client.from('combos_guardados').select('*').order('id', { ascending: false }),
      client.from('pedidos').select('*').order('fecha', { ascending: false }).order('id', { ascending: false }),
      client.from('pedido_items').select('*').order('id', { ascending: true })
    ]);

    const firstErr = e1 || e2 || e3 || e4 || e5 || e6 || e7;
    if (firstErr) {
      throw new Error('Error cargando datos desde Supabase: ' + firstErr.message);
    }

    const artMap = new Map((articulos || []).map(a => [a.id_articulo, a.nombre]));

    const escalasReales = (escalasRaw || []).map(e => ({
      ...e,
      nombre_articulo: artMap.get(e.id_articulo) || e.id_articulo
    }));

    const registroCostos = (registroRaw || []).map(r => ({
      ...r,
      nombre_articulo: artMap.get(r.id_articulo) || r.id_articulo
    }));

    return {
      paramRows: paramRows || [],
      articulos: articulos || [],
      escalasReales,
      registroRaw: registroCostos,
      combosGuardados: combosGuardados || [],
      pedidos: pedidos || [],
      pedidoItems: pedidoItems || []
    };
  }

  async function getNextArticuloId() {
    const { data, error } = await getClient()
      .from('articulos')
      .select('id_articulo')
      .order('id_articulo', { ascending: false })
      .limit(1);

    if (error || !data || data.length === 0) return 'ART-001';
    const m = String(data[0].id_articulo || '').match(/^ART-(\d+)$/i);
    const nextNum = m ? parseInt(m[1], 10) + 1 : 1;
    return 'ART-' + String(nextNum).padStart(3, '0');
  }

  async function findArticuloByName(nombreRaw) {
    const cleanName = String(nombreRaw || '').replace(/^ART-\d+\s*\|\s*/i, '').trim();
    if (!cleanName) return null;

    const { data, error } = await getClient()
      .from('articulos')
      .select('id_articulo, nombre')
      .ilike('nombre', cleanName)
      .limit(1);

    if (error || !data || data.length === 0) return null;
    return data[0];
  }

  async function getOrCreateArticulo(nombreRaw) {
    const cleanName = String(nombreRaw || '').replace(/^ART-\d+\s*\|\s*/i, '').trim();
    if (!cleanName) {
      throw new Error('El nombre del artículo no puede estar vacío.');
    }

    const existing = await findArticuloByName(cleanName);
    if (existing) return existing;

    const nextId = await getNextArticuloId();
    const { data, error } = await getClient()
      .from('articulos')
      .insert([{ id_articulo: nextId, nombre: cleanName }])
      .select()
      .single();

    if (error) throw new Error(error.message);
    return data;
  }

  async function updateArticuloNombre(idArticulo, nuevoNombreRaw) {
    const cleanName = String(nuevoNombreRaw || '').replace(/^ART-\d+\s*\|\s*/i, '').trim();
    if (!cleanName) return false;

    const { error } = await getClient()
      .from('articulos')
      .update({ nombre: cleanName })
      .eq('id_articulo', idArticulo);

    if (error) throw new Error(error.message);
    return true;
  }

  // --- CRUD Registro de Costos ---
  async function insertRegistroCosto(id_articulo, cantidad, factor_multiplicador) {
    const { error } = await getClient()
      .from('registro_costos')
      .insert([{ id_articulo, cantidad, factor_multiplicador }]);
    if (error) throw new Error(error.message);
  }

  async function updateRegistroCosto(id, fields) {
    const { error } = await getClient()
      .from('registro_costos')
      .update(fields)
      .eq('id', id);
    if (error) throw new Error(error.message);
  }

  async function deleteRegistroCosto(id) {
    const { error } = await getClient()
      .from('registro_costos')
      .delete()
      .eq('id', id);
    if (error) throw new Error(error.message);
  }

  // --- CRUD Escalas Reales ---
  async function upsertEscalaReal(payload) {
    const client = getClient();
    const { data: existing } = await client
      .from('escalas_reales')
      .select('id')
      .eq('id_articulo', payload.id_articulo)
      .eq('cantidad', payload.cantidad)
      .limit(1);

    if (existing && existing.length > 0) {
      const { error } = await client
        .from('escalas_reales')
        .update({
          fecha: payload.fecha,
          gramos_lote: payload.gramos_lote,
          tiempo_impresion_lote_h: payload.tiempo_impresion_lote_h,
          tiempo_preparacion_lote_h: payload.tiempo_preparacion_lote_h,
          factor_multiplicador: payload.factor_multiplicador
        })
        .eq('id', existing[0].id);
      if (error) throw new Error(error.message);
    } else {
      const { error } = await client
        .from('escalas_reales')
        .insert([payload]);
      if (error) throw new Error(error.message);
    }
  }

  async function insertEscalaReal(payload) {
    const { error } = await getClient()
      .from('escalas_reales')
      .insert([payload]);
    if (error) throw new Error(error.message);
  }

  async function updateEscalaRealField(id, fields) {
    const { error } = await getClient()
      .from('escalas_reales')
      .update(fields)
      .eq('id', id);
    if (error) throw new Error(error.message);
  }

  async function deleteEscalaReal(id) {
    const { error } = await getClient()
      .from('escalas_reales')
      .delete()
      .eq('id', id);
    if (error) throw new Error(error.message);
  }

  // --- CRUD Combos Guardados ---
  async function insertComboGuardado(payload) {
    const { error } = await getClient()
      .from('combos_guardados')
      .insert([payload]);
    if (error) throw new Error(error.message);
  }

  async function updateComboNombre(id, nombre_combo) {
    const { error } = await getClient()
      .from('combos_guardados')
      .update({ nombre_combo })
      .eq('id', id);
    if (error) throw new Error(error.message);
  }

  async function deleteComboGuardado(id) {
    const { error } = await getClient()
      .from('combos_guardados')
      .delete()
      .eq('id', id);
    if (error) throw new Error(error.message);
  }

  // --- CRUD Pedidos y Pedido Items ---
  async function getNextPedidoId() {
    const { data, error } = await getClient()
      .from('pedidos')
      .select('id');

    let maxNum = 0;
    if (!error && data) {
      for (const r of data) {
        const m = String(r.id).match(/(\d+)/);
        if (m) maxNum = Math.max(maxNum, Number(m[1]));
      }
    }
    return 'PED-' + String(maxNum + 1).padStart(3, '0');
  }

  async function insertPedidoWithItems(pedido, items) {
    const client = getClient();
    const { error: errPed } = await client.from('pedidos').insert([pedido]);
    if (errPed) throw new Error(errPed.message);

    const { error: errItems } = await client.from('pedido_items').insert(items);
    if (errItems) throw new Error(errItems.message);
  }

  async function updatePedidoEstado(id, estado) {
    const { error } = await getClient()
      .from('pedidos')
      .update({ estado })
      .eq('id', id);
    if (error) throw new Error(error.message);
  }

  async function deletePedido(id) {
    const { error } = await getClient()
      .from('pedidos')
      .delete()
      .eq('id', id);
    if (error) throw new Error(error.message);
  }

  async function updatePedidoItem(id, fields) {
    const { error } = await getClient()
      .from('pedido_items')
      .update(fields)
      .eq('id', id);
    if (error) throw new Error(error.message);
  }

  async function deletePedidoItem(id) {
    const { error } = await getClient()
      .from('pedido_items')
      .delete()
      .eq('id', id);
    if (error) throw new Error(error.message);
  }

  // --- CRUD Parámetros Base ---
  async function updateParametro(clave, valor) {
    const { error } = await getClient()
      .from('parametros_base')
      .update({ valor })
      .eq('clave', clave);
    if (error) throw new Error(error.message);
  }

  return {
    init,
    getAllData,
    getNextArticuloId,
    findArticuloByName,
    getOrCreateArticulo,
    updateArticuloNombre,
    insertRegistroCosto,
    updateRegistroCosto,
    deleteRegistroCosto,
    upsertEscalaReal,
    insertEscalaReal,
    updateEscalaRealField,
    deleteEscalaReal,
    insertComboGuardado,
    updateComboNombre,
    deleteComboGuardado,
    getNextPedidoId,
    insertPedidoWithItems,
    updatePedidoEstado,
    deletePedido,
    updatePedidoItem,
    deletePedidoItem,
    updateParametro
  };
})();
