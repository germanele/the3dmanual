/**
 * ============================================================================
 * CAPA DE PERSISTENCIA SUPABASE (PostgreSQL Cloud + Caché Local Síncrona)
 * Gestión Impresión 3D - Costos, Artículos, Combos y Clientes (Uruguay)
 * ============================================================================
 */

const SUPABASE_URL = 'https://the3dmanual.supabase.co';      // <-- PEGA TU URL AQUÍ
const SUPABASE_ANON_KEY = 'sb_publishable_N4mvfO4IoRFph4FK9s3eYg_mjL1OWQo';               // <-- PEGA TU ANON KEY AQUÍ

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
    supabaseClient = supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
    await reloadCache();
  }

  async function reloadCache() {
    const [p, a, er, rc, cg, ped, pi] = await Promise.all([
      supabaseClient.from('parametros_base').select('*'),
      supabaseClient.from('articulos').select('*').order('id_articulo', { ascending: true }),
      supabaseClient.from('escalas_reales').select('*').order('id', { ascending: true }),
      supabaseClient.from('registro_costos').select('*').order('id', { ascending: true }),
      supabaseClient.from('combos_guardados').select('*').order('id', { ascending: false }),
      supabaseClient.from('pedidos').select('*').order('fecha', { ascending: false }),
      supabaseClient.from('pedido_items').select('*').order('id', { ascending: true })
    ]);

    cache.parametros_base = p.data || [];
    cache.articulos = a.data || [];
    cache.escalas_reales = er.data || [];
    cache.registro_costos = rc.data || [];
    cache.combos_guardados = cg.data || [];
    cache.pedidos = ped.data || [];
    cache.pedido_items = pi.data || [];
  }

  function queryAll(sql, params = []) {
    const cleanSql = sql.trim().toLowerCase();

    if (cleanSql.includes('from parametros_base')) return [...cache.parametros_base];
    if (cleanSql.includes('from articulos')) return [...cache.articulos].sort((x, y) => x.id_articulo.localeCompare(y.id_articulo));
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
      return cache.articulos.filter(a => a.nombre.toLowerCase().trim() === target);
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
    const s = sql.trim().toLowerCase();
    try {
      if (s.startsWith('update articulos set nombre')) {
        await supabaseClient.from('articulos').update({ nombre: params[0] }).eq('id_articulo', params[1]);
      } else if (s.startsWith('update registro_costos set cantidad')) {
        await supabaseClient.from('registro_costos').update({ cantidad: params[0] }).eq('id', params[1]);
      } else if (s.startsWith('update registro_costos set factor_multiplicador')) {
        await supabaseClient.from('registro_costos').update({ factor_multiplicador: params[0] }).eq('id', params[1]);
      } else if (s.startsWith('delete from registro_costos')) {
        await supabaseClient.from('registro_costos').delete().eq('id', params[0]);
      } else if (s.startsWith('insert into registro_costos')) {
        await supabaseClient.from('registro_costos').insert({ id_articulo: params[0], cantidad: params[1], factor_multiplicador: params[2] });
      } else if (s.startsWith('update escalas_reales set')) {
        if (s.includes('gramos_lote')) {
          await supabaseClient.from('escalas_reales').update({ gramos_lote: params[0] }).eq('id', params[1]);
        } else if (s.includes('tiempo_impresion_lote_h')) {
          await supabaseClient.from('escalas_reales').update({ tiempo_impresion_lote_h: params[0] }).eq('id', params[1]);
        } else if (s.includes('tiempo_preparacion_lote_h')) {
          await supabaseClient.from('escalas_reales').update({ tiempo_preparacion_lote_h: params[0] }).eq('id', params[1]);
        } else if (s.includes('tiempo_postprocesado_unit_h')) {
          await supabaseClient.from('escalas_reales').update({ tiempo_postprocesado_unit_h: params[0] }).eq('id', params[1]);
        } else {
          await supabaseClient.from('escalas_reales').update({
            fecha: params[0], gramos_lote: params[1], tiempo_impresion_lote_h: params[2],
            tiempo_preparacion_lote_h: params[3], factor_multiplicador: params[4]
          }).eq('id', params[5]);
        }
      } else if (s.startsWith('insert into escalas_reales')) {
        await supabaseClient.from('escalas_reales').insert({
          fecha: params[0], id_articulo: params[1], cantidad: params[2],
          gramos_lote: params[3], tiempo_impresion_lote_h: params[4],
          tiempo_preparacion_lote_h: params[5], tiempo_postprocesado_unit_h: params[6],
          factor_multiplicador: params[7]
        });
      } else if (s.startsWith('delete from escalas_reales')) {
        await supabaseClient.from('escalas_reales').delete().eq('id', params[0]);
      } else if (s.startsWith('update combos_guardados set nombre_combo')) {
        await supabaseClient.from('combos_guardados').update({ nombre_combo: params[0] }).eq('id', params[1]);
      } else if (s.startsWith('delete from combos_guardados')) {
        await supabaseClient.from('combos_guardados').delete().eq('id', params[0]);
      } else if (s.startsWith('insert into combos_guardados')) {
        await supabaseClient.from('combos_guardados').insert({
          fecha: params[0], nombre_combo: params[1], presupuesto: params[2],
          opcion_elegida: params[3], composicion: params[4], precio_venta: params[5],
          costo_produccion: params[6], saldo_presupuesto: params[7], estado: params[8]
        });
      } else if (s.startsWith('insert into pedidos')) {
        await supabaseClient.from('pedidos').insert({ id: params[0], fecha: params[1], cliente: params[2], estado: params[3] });
      } else if (s.startsWith('insert into pedido_items')) {
        await supabaseClient.from('pedido_items').insert({
          pedido_id: params[0], tipo_item: params[1], ref_id: params[2],
          descripcion: params[3], cantidad: params[4], precio_unitario: params[5]
        });
      } else if (s.startsWith('update pedido_items set cantidad')) {
        await supabaseClient.from('pedido_items').update({ cantidad: params[0] }).eq('id', params[1]);
      } else if (s.startsWith('update pedido_items set precio_unitario')) {
        await supabaseClient.from('pedido_items').update({ precio_unitario: params[0] }).eq('id', params[1]);
      } else if (s.startsWith('delete from pedido_items where id')) {
        await supabaseClient.from('pedido_items').delete().eq('id', params[0]);
      } else if (s.startsWith('update pedidos set estado')) {
        await supabaseClient.from('pedidos').update({ estado: params[0] }).eq('id', params[1]);
      } else if (s.startsWith('delete from pedido_items where pedido_id')) {
        await supabaseClient.from('pedido_items').delete().eq('pedido_id', params[0]);
      } else if (s.startsWith('delete from pedidos')) {
        await supabaseClient.from('pedidos').delete().eq('id', params[0]);
      } else if (s.startsWith('update parametros_base set valor')) {
        await supabaseClient.from('parametros_base').update({ valor: params[0] }).eq('clave', params[1]);
      }
      await reloadCache();
    } catch (err) {
      console.error('Error sincronizando con Supabase:', err);
    }
  }

  function execRaw(sql) {
    const s = sql.trim().toLowerCase();
    
    function formatResult(arr) {
      if (!arr || arr.length === 0) return [];
      const columns = Object.keys(arr[0]);
      const values = arr.map(row => columns.map(col => row[col]));
      return [{ columns, values }];
    }

    if (s.includes('from articulos')) return formatResult(cache.articulos);
    if (s.includes('from parametros_base')) return formatResult(cache.parametros_base);
    if (s.includes('from escalas_reales')) return formatResult(cache.escalas_reales);
    if (s.includes('from registro_costos')) return formatResult(cache.registro_costos);
    if (s.includes('from combos_guardados')) return formatResult(cache.combos_guardados);
    if (s.includes('from pedidos')) return formatResult(cache.pedidos);
    if (s.includes('from pedido_items')) return formatResult(cache.pedido_items);
    
    return [];
  }

  function getNextArticuloId() {
    let maxNum = 0;
    for (const a of cache.articulos) {
      const m = String(a.id_articulo || '').match(/^ART-(\d+)$/i);
      if (m) maxNum = Math.max(maxNum, parseInt(m[1], 10));
    }
    return 'ART-' + String(maxNum + 1).padStart(3, '0');
  }

  async function getOrCreateArticulo(nombreRaw) {
    const cleanName = String(nombreRaw || '').replace(/^ART-\d+\s*\|\s*/i, '').trim();
    if (!cleanName) throw new Error('Nombre vacío');

    const existing = cache.articulos.find(a => a.nombre.toLowerCase().trim() === cleanName.toLowerCase().trim());
    if (existing) return existing;

    const nextId = getNextArticuloId();
    await supabaseClient.from('articulos').insert({ id_articulo: nextId, nombre: cleanName });
    await reloadCache();
    return { id_articulo: nextId, nombre: cleanName };
  }

  async function updateArticuloNombre(idArticulo, nuevoNombreRaw) {
    const cleanName = String(nuevoNombreRaw || '').replace(/^ART-\d+\s*\|\s*/i, '').trim();
    if (!cleanName) return false;
    await supabaseClient.from('articulos').update({ nombre: cleanName }).eq('id_articulo', idArticulo);
    await reloadCache();
    return true;
  }

  return {
    init,
    queryAll,
    run,
    execRaw,
    exportBinary: () => new Uint8Array(),
    importBinary: () => {},
    resetToExcelSeed: async () => {},
    getNextArticuloId,
    getOrCreateArticulo,
    updateArticuloNombre
  };
})();