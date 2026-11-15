/**
 * ============================================================================
 * CAPA DE PERSISTENCIA SUPABASE (PostgreSQL Cloud + Caché Local Síncrona)
 * ============================================================================
 */

// 1. CONFIGURACIÓN DE CREDENCIALES
const SUPABASE_URL_RAW = 'https://tqxxtzugwojsxyefungm.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_N4mvfO4IoRFph4FK9s3eYg_mjL1OWQo';

// Limpieza estricta de la URL para evitar duplicación de rutas en la API
const SUPABASE_URL = SUPABASE_URL_RAW.split('/rest/v1')[0].replace(/\/+$/, '');

const DB3D = (() => {
  let supabaseClient = null;
  
  let cache = {
    parametros_base: [],
    articulos: [],
    escalas_reales: [],
    registro_costos: [],
    combos_guardados: [],
    pedidos: [],
    pedido_items: []
  };

  async function init() {
    if (typeof supabase === 'undefined') {
      throw new Error('No se pudo cargar la librería de Supabase.');
    }
    
    supabaseClient = supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      db: { schema: 'public' },
      auth: { persistSession: false }
    });

    await reloadCache();
  }

  async function reloadCache() {
    try {
      const [pBase, arts, escalas, costos, combos, peds, pItems] = await Promise.all([
        supabaseClient.from('parametros_base').select('*'),
        supabaseClient.from('articulos').select('*'),
        supabaseClient.from('escalas_reales').select('*'),
        supabaseClient.from('registro_costos').select('*'),
        supabaseClient.from('combos_guardados').select('*'),
        supabaseClient.from('pedidos').select('*'),
        supabaseClient.from('pedido_items').select('*')
      ]);

      if (pBase.error) console.error('Error cargando parametros_base:', pBase.error);
      if (arts.error) console.error('Error cargando articulos:', arts.error);

      cache.parametros_base = pBase.data || [];
      cache.articulos = arts.data || [];
      cache.escalas_reales = escalas.data || [];
      cache.registro_costos = costos.data || [];
      cache.combos_guardados = combos.data || [];
      cache.pedidos = peds.data || [];
      cache.pedido_items = pItems.data || [];

      console.log('DB3D: Caché sincronizada con Supabase correctamente.');
    } catch (err) {
      console.error('DB3D: Error crítico sincronizando caché con Supabase:', err);
    }
  }

  function queryAll(sql, params = []) {
    const cleanSql = sql.trim().toLowerCase();

    if (cleanSql.includes('from parametros_base')) return [...cache.parametros_base];
    
    if (cleanSql.includes('from articulos')) {
      return [...cache.articulos].sort((x, y) => String(x.id_articulo).localeCompare(String(y.id_articulo)));
    }

    if (cleanSql.includes('from escalas_reales') && cleanSql.includes('join articulos')) {
      return cache.escalas_reales.map(e => {
        const art = cache.articulos.find(a => a.id_articulo === e.id_articulo);
        return { ...e, nombre_articulo: art ? art.nombre : '' };
      });
    }
    if (cleanSql.includes('from escalas_reales')) return [...cache.escalas_reales];
    
    if (cleanSql.includes('from registro_costos') && cleanSql.includes('join articulos')) {
      return cache.registro_costos.map(r => {
        const art = cache.articulos.find(a => a.id_articulo === r.id_articulo);
        return { ...r, nombre_articulo: art ? art.nombre : '' };
      });
    }
    if (cleanSql.includes('from registro_costos')) return [...cache.registro_costos];
    if (cleanSql.includes('from combos_guardados')) return [...cache.combos_guardados].sort((x, y) => y.id - x.id);
    if (cleanSql.includes('from pedidos')) return [...cache.pedidos].sort((x, y) => new Date(y.fecha) - new Date(x.fecha));
    if (cleanSql.includes('from pedido_items')) return [...cache.pedido_items];
    
    if (cleanSql.includes('select id_articulo from articulos where lower(trim(nombre))')) {
      const target = params[0] ? params[0].toLowerCase().trim() : '';
      return cache.articulos.filter(a => a.nombre && a.nombre.toLowerCase().trim() === target);
    }
    if (cleanSql.includes('select id from escalas_reales where id_articulo')) {
      return cache.escalas_reales.filter(e => e.id_articulo === params[0] && e.cantidad === params[1]);
    }
    if (cleanSql.includes('select id from pedidos')) {
      return cache.pedidos.map(p => ({ id: p.id }));
    }
    return [];
  }

  async function run(sql, params = []) {
    const cleanSql = sql.trim().toLowerCase();

    try {
      // Inserción en parámetros base
      if (cleanSql.startsWith('insert into parametros_base')) {
        const [clave, parametro, valor, unidad, base, notas] = params;
        const { error } = await supabaseClient
          .from('parametros_base')
          .upsert({ clave, parametro, valor, unidad, base, notas }, { onConflict: 'clave' });
        if (error) throw error;
      }
      // Inserción en artículos
      else if (cleanSql.startsWith('insert into articulos')) {
        const [id_articulo, nombre] = params;
        const { error } = await supabaseClient
          .from('articulos')
          .upsert({ id_articulo, nombre }, { onConflict: 'id_articulo' });
        if (error) throw error;
      }
      // Inserción en registro de costos
      else if (cleanSql.startsWith('insert into registro_costos')) {
        const [id_articulo, peso_g, tiempo_h, costo_material, costo_maquina, costo_mano_obra, costo_total, precio_sugerido] = params;
        const { error } = await supabaseClient
          .from('registro_costos')
          .insert({ id_articulo, peso_g, tiempo_h, costo_material, costo_maquina, costo_mano_obra, costo_total, precio_sugerido });
        if (error) throw error;
      }
      // Inserción en escalas reales
      else if (cleanSql.startsWith('insert into escalas_reales')) {
        const [id_articulo, cantidad, precio_sugerido, costo_total] = params;
        const { error } = await supabaseClient
          .from('escalas_reales')
          .insert({ id_articulo, cantidad, precio_sugerido, costo_total });
        if (error) throw error;
      }
      // Inserción en combos
      else if (cleanSql.startsWith('insert into combos_guardados')) {
        const [nombre_combo, items_json, costo_total, precio_sugerido] = params;
        const { error } = await supabaseClient
          .from('combos_guardados')
          .insert({ nombre_combo, items_json, costo_total, precio_sugerido });
        if (error) throw error;
      }
      // Inserción en pedidos
      else if (cleanSql.startsWith('insert into pedidos')) {
        const [cliente, total] = params;
        const { data, error } = await supabaseClient
          .from('pedidos')
          .insert({ cliente, total })
          .select('id')
          .single();
        if (error) throw error;
        await reloadCache();
        return data ? data.id : null;
      }
      // Inserción en ítem de pedido
      else if (cleanSql.startsWith('insert into pedido_items')) {
        const [id_pedido, descripcion, cantidad, precio_unitario] = params;
        const { error } = await supabaseClient
          .from('pedido_items')
          .insert({ id_pedido, descripcion, cantidad, precio_unitario });
        if (error) throw error;
      }
      // Eliminaciones
      else if (cleanSql.startsWith('delete from articulos')) {
        const { error } = await supabaseClient.from('articulos').delete().eq('id_articulo', params[0]);
        if (error) throw error;
      }
      else if (cleanSql.startsWith('delete from registro_costos')) {
        const { error } = await supabaseClient.from('registro_costos').delete().eq('id', params[0]);
        if (error) throw error;
      }
      else if (cleanSql.startsWith('delete from combos_guardados')) {
        const { error } = await supabaseClient.from('combos_guardados').delete().eq('id', params[0]);
        if (error) throw error;
      }
      else if (cleanSql.startsWith('delete from pedidos')) {
        const { error } = await supabaseClient.from('pedidos').delete().eq('id', params[0]);
        if (error) throw error;
      }

      await reloadCache();
    } catch (err) {
      console.error('DB3D Error en ejecución SQL (run):', err);
      throw err;
    }
  }

  return {
    init,
    reloadCache,
    queryAll,
    run,
    execRaw: async (sql) => {
      console.warn('execRaw simulado:', sql);
      return [];
    }
  };
})();