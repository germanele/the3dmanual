/**
 * ============================================================================
 * CAPA DE PERSISTENCIA SQLITE EN NAVEGADOR (sql.js WebAssembly + localStorage)
 * Gestión Impresión 3D - Costos, Artículos, Combos y Clientes (Uruguay)
 * ============================================================================
 */

const SEED_DATA = {
  "schema": `PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS parametros_base (
    clave TEXT PRIMARY KEY,
    parametro TEXT NOT NULL,
    valor REAL NOT NULL,
    unidad TEXT NOT NULL,
    base TEXT NOT NULL,
    notas TEXT
);

CREATE TABLE IF NOT EXISTS articulos (
    id_articulo TEXT PRIMARY KEY,
    nombre TEXT NOT NULL UNIQUE
);

CREATE TRIGGER IF NOT EXISTS trg_articulos_no_update_id
BEFORE UPDATE OF id_articulo ON articulos
BEGIN
    SELECT RAISE(ABORT, 'El identificador id_articulo (ART-XXX) es generado por la base de datos y no es modificable.');
END;

CREATE TABLE IF NOT EXISTS escalas_reales (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    fecha TEXT NOT NULL,
    id_articulo TEXT NOT NULL REFERENCES articulos(id_articulo),
    cantidad INTEGER NOT NULL CHECK(cantidad >= 1),
    gramos_lote REAL NOT NULL CHECK(gramos_lote >= 0),
    tiempo_impresion_lote_h REAL NOT NULL CHECK(tiempo_impresion_lote_h >= 0),
    tiempo_preparacion_lote_h REAL NOT NULL CHECK(tiempo_preparacion_lote_h >= 0),
    tiempo_postprocesado_unit_h REAL NOT NULL CHECK(tiempo_postprocesado_unit_h >= 0),
    factor_multiplicador REAL NOT NULL DEFAULT 2.5
);

CREATE TABLE IF NOT EXISTS registro_costos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    id_articulo TEXT NOT NULL REFERENCES articulos(id_articulo),
    cantidad INTEGER NOT NULL CHECK(cantidad >= 1),
    factor_multiplicador REAL NOT NULL DEFAULT 2.5
);

CREATE TABLE IF NOT EXISTS combos_guardados (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    fecha TEXT NOT NULL,
    nombre_combo TEXT NOT NULL,
    presupuesto REAL NOT NULL,
    opcion_elegida TEXT NOT NULL,
    composicion TEXT NOT NULL,
    precio_venta REAL NOT NULL,
    costo_produccion REAL NOT NULL,
    saldo_presupuesto REAL NOT NULL,
    estado TEXT NOT NULL DEFAULT '✅ Guardado'
);

CREATE TABLE IF NOT EXISTS pedidos (
    id TEXT PRIMARY KEY,
    fecha TEXT NOT NULL,
    cliente TEXT NOT NULL,
    estado TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS pedido_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    pedido_id TEXT NOT NULL REFERENCES pedidos(id) ON DELETE CASCADE,
    tipo_item TEXT NOT NULL DEFAULT 'articulo',
    ref_id TEXT NOT NULL,
    descripcion TEXT NOT NULL,
    cantidad INTEGER NOT NULL CHECK(cantidad >= 1),
    precio_unitario REAL NOT NULL CHECK(precio_unitario >= 0)
);

CREATE VIEW IF NOT EXISTS v_catalogo_articulos AS
SELECT
    a.id_articulo,
    a.nombre,
    (a.id_articulo || ' | ' || a.nombre) AS articulo
FROM articulos a
ORDER BY a.id_articulo ASC;

CREATE VIEW IF NOT EXISTS v_pedidos AS
SELECT
    p.id,
    p.fecha,
    p.cliente,
    p.estado,
    COUNT(pi.id) AS cant_items,
    COALESCE(SUM(pi.cantidad), 0) AS total_piezas,
    ROUND(COALESCE(SUM(pi.cantidad * pi.precio_unitario), 0), 2) AS total_uyu
FROM pedidos p
LEFT JOIN pedido_items pi ON pi.pedido_id = p.id
GROUP BY p.id, p.fecha, p.cliente, p.estado;
`,
  "parametros_base": [
    [
      "energia_kwh",
      "Energía eléctrica",
      11.0,
      "$ UYU / kWh",
      "UYU",
      "Tarifa media residencial / comercial UTE en Uruguay"
    ],
    [
      "desgaste_maquina_h",
      "Desgaste de máquina",
      10.0,
      "$ UYU / h",
      "UYU",
      "Amortización de equipo, boquillas y mantenimiento preventivo"
    ],
    [
      "tiempo_manual_h",
      "Tiempo manual",
      250.0,
      "$ UYU / h",
      "UYU",
      "Mano de obra técnica: preparación, calibración y post-procesado"
    ],
    [
      "precio_plastico_usd_kg",
      "Precio plástico por defecto",
      15.0,
      "USD / kg",
      "USD",
      "Costo promedio de bobina estándar (PLA / PETG) en plaza local"
    ],
    [
      "consumo_maquina_w",
      "Consumo de máquina por defecto",
      110.0,
      "W",
      "Watts",
      "Potencia eléctrica media consumida por la impresora 3D"
    ],
    [
      "factor_defecto",
      "Factor multiplicador por defecto",
      2.5,
      "x",
      "Ratio",
      "Multiplicador estándar sobre costo base para venta minorista"
    ],
    [
      "cotizacion_dolar",
      "Cotización Dólar (Venta)",
      41.5,
      "$ UYU / USD",
      "UYU",
      "Tipo de cambio de referencia editable (el asistente lo actualiza con la cotización vigente al calcular)"
    ]
  ],
  "articulos": [
    ["ART-001", "Mate Autocebante"],
    ["ART-002", "Fidget Manzana"],
    ["ART-003", "Fidget Hexagonal"],
    ["ART-004", "Fidget Cubo Infinito"],
    ["ART-005", "Fidget Bola"],
    ["ART-006", "Llavero Sindicato"]
  ],
  "escalas_reales": [
    ["2024-05-15", "ART-001", 1, 45.0, 2.5, 0.25, 0.1, 1.5],
    ["2026-11-13", "ART-002", 1, 19.7, 1.233333333, 0.08333333333, 0.0, 2.5],
    ["2026-11-13", "ART-003", 1, 44.08, 1.616667, 0.083333, 0.0, 3.0],
    ["2026-11-13", "ART-004", 1, 28.16, 1.383333333, 0.08333333333, 0.0, 2.0],
    ["2026-11-14", "ART-005", 1, 77.89, 4.3, 0.08333333333, 0.0, 2.0],
    ["2026-11-14", "ART-001", 5, 225.0, 12.5, 0.25, 0.1, 1.5],
    ["2026-11-14", "ART-005", 3, 233.55, 12.35, 0.08333333333, 0.0, 2.0],
    ["2026-11-14", "ART-006", 13, 73.31, 5.333333333, 0.08333333333, 0.0, 2.0]
  ],
  "registro_costos": [
    ["ART-001", 1, 1.5],
    ["ART-002", 1, 2.5],
    ["ART-003", 1, 3.0],
    ["ART-004", 1, 3.0],
    ["ART-005", 3, 1.5],
    ["ART-006", 13, 3.0]
  ],
  "combos_guardados": [
    [
      "2026-11-13",
      "Combo Variado Mix",
      3278.0,
      "Opción 2 (Máx. Cantidad)",
      "Fidget Cubo Infinito (ART-004) x8, Fidget Manzana (ART-002) x7, Mate Autocebante (ART-001) x5, Fidget Hexagonal (ART-003) x3",
      3273.89,
      1676.82,
      4.11,
      "✅ Guardado"
    ],
    [
      "2026-11-13",
      "Pack Fidgets Alta Rentabilidad",
      3278.0,
      "Opción 3 (Máx. Ganancia)",
      "Fidget Manzana (ART-002) x11, Fidget Hexagonal (ART-003) x5, Fidget Cubo Infinito (ART-004) x11",
      3269.78,
      1440.69,
      8.22,
      "✅ Guardado"
    ]
  ],
  "pedidos": [
    ["PED-001", "2024-05-18", "Juan Pérez", "Entregado"],
    ["PED-002", "2024-05-20", "Lucía Silva", "En Producción"],
    ["PED-003", "2024-05-22", "Martín Rodríguez", "Pendiente"],
    ["PED-004", "2024-05-25", "Valentina Gómez", "Listo para Entrega"],
    ["PED-005", "2024-05-28", "Tech Solutions UY", "Entregado"],
    ["PED-006", "2024-05-30", "Estudio Creativo", "En Producción"]
  ],
  "pedido_items": [
    ["PED-001", "articulo", "ART-001", "Mate Autocebante", 2, 215.31],
    ["PED-002", "articulo", "ART-003", "Fidget Hexagonal", 5, 199.2],
    ["PED-003", "articulo", "ART-006", "Llavero Sindicato", 20, 28.92],
    ["PED-004", "articulo", "ART-004", "Fidget Cubo Infinito", 3, 161.61],
    ["PED-005", "articulo", "ART-002", "Fidget Manzana", 10, 117.3],
    ["PED-006", "articulo", "ART-005", "Fidget Bola", 4, 151.92]
  ]
};

const DB3D = (() => {
  const STORAGE_KEY = 'gestion_impresion_3d_sqlite_b64_v2';
  let SQL = null;
  let db = null;

  function uint8ToBase64(bytes) {
    let binary = '';
    const chunkSize = 0x8000;
    for (let i = 0; i < bytes.length; i += chunkSize) {
      binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize));
    }
    return btoa(binary);
  }

  function base64ToUint8(base64) {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
  }

  function saveToStorage() {
    if (!db) return;
    const data = db.export();
    localStorage.setItem(STORAGE_KEY, uint8ToBase64(data));
  }

  function queryAllOn(database, sql, params = []) {
    const stmt = database.prepare(sql);
    stmt.bind(params);
    const rows = [];
    while (stmt.step()) {
      rows.push(stmt.getAsObject());
    }
    stmt.free();
    return rows;
  }

  function seedDatabase(database) {
    database.run(SEED_DATA.schema);

    const stmtParam = database.prepare(
      'INSERT INTO parametros_base (clave, parametro, valor, unidad, base, notas) VALUES (?, ?, ?, ?, ?, ?)'
    );
    for (const r of SEED_DATA.parametros_base) {
      stmtParam.run(r);
    }
    stmtParam.free();

    const stmtArt = database.prepare(
      'INSERT INTO articulos (id_articulo, nombre) VALUES (?, ?)'
    );
    for (const r of SEED_DATA.articulos) {
      stmtArt.run(r);
    }
    stmtArt.free();

    const stmtEsc = database.prepare(`
      INSERT INTO escalas_reales (
        fecha, id_articulo, cantidad, gramos_lote, tiempo_impresion_lote_h,
        tiempo_preparacion_lote_h, tiempo_postprocesado_unit_h, factor_multiplicador
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const r of SEED_DATA.escalas_reales) {
      stmtEsc.run(r);
    }
    stmtEsc.free();

    const stmtReg = database.prepare(
      'INSERT INTO registro_costos (id_articulo, cantidad, factor_multiplicador) VALUES (?, ?, ?)'
    );
    for (const r of SEED_DATA.registro_costos) {
      stmtReg.run(r);
    }
    stmtReg.free();

    const stmtCmb = database.prepare(`
      INSERT INTO combos_guardados (
        fecha, nombre_combo, presupuesto, opcion_elegida, composicion,
        precio_venta, costo_produccion, saldo_presupuesto, estado
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const r of SEED_DATA.combos_guardados) {
      stmtCmb.run(r);
    }
    stmtCmb.free();

    const stmtPed = database.prepare(
      'INSERT INTO pedidos (id, fecha, cliente, estado) VALUES (?, ?, ?, ?)'
    );
    for (const r of SEED_DATA.pedidos) {
      stmtPed.run(r);
    }
    stmtPed.free();

    const stmtPedItem = database.prepare(`
      INSERT INTO pedido_items (pedido_id, tipo_item, ref_id, descripcion, cantidad, precio_unitario)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    for (const r of SEED_DATA.pedido_items) {
      stmtPedItem.run(r);
    }
    stmtPedItem.free();
  }

  /**
   * Calcula el siguiente identificador secuencial ART-XXX a nivel de base de datos
   */
  function getNextArticuloIdOn(database) {
    let maxNum = 0;
    const tablas = [
      { sql: 'SELECT id_articulo AS code FROM articulos' }
    ];
    for (const t of tablas) {
      try {
        const rows = queryAllOn(database, t.sql);
        for (const r of rows) {
          const m = String(r.code || '').match(/^ART-(\d+)$/i);
          if (m) maxNum = Math.max(maxNum, parseInt(m[1], 10));
        }
      } catch (_) {}
    }
    return 'ART-' + String(maxNum + 1).padStart(3, '0');
  }

  /**
   * Resuelve un artículo por nombre o lo inserta generando ART-XXX secuencial en la BD.
   * Nunca permite modificar id_articulo desde la aplicación.
   */
  function getOrCreateArticulo(nombreRaw) {
    const cleanName = String(nombreRaw || '').replace(/^ART-\d+\s*\|\s*/i, '').trim();
    if (!cleanName) {
      throw new Error('El nombre del artículo no puede estar vacío.');
    }

    const existing = queryAll(
      'SELECT id_articulo, nombre FROM articulos WHERE LOWER(TRIM(nombre)) = LOWER(TRIM(?))',
      [cleanName]
    );
    if (existing.length > 0) {
      return existing[0];
    }

    const nextId = getNextArticuloIdOn(db);
    db.run('INSERT INTO articulos (id_articulo, nombre) VALUES (?, ?)', [nextId, cleanName]);
    saveToStorage();
    return { id_articulo: nextId, nombre: cleanName };
  }

  /**
   * Actualiza únicamente el nombre de un artículo existente sin tocar su id_articulo
   */
  function updateArticuloNombre(idArticulo, nuevoNombreRaw) {
    const cleanName = String(nuevoNombreRaw || '').replace(/^ART-\d+\s*\|\s*/i, '').trim();
    if (!cleanName) return false;
    db.run('UPDATE articulos SET nombre = ? WHERE id_articulo = ?', [cleanName, idArticulo]);
    saveToStorage();
    return true;
  }

  /**
   * Migra bases .sqlite antiguas (v1) al esquema actual (articulos, pedido_items, nombre_combo)
   */
  function ensureSchemaUpgraded(database) {
    const artTable = queryAllOn(database, "SELECT name FROM sqlite_master WHERE type='table' AND name='articulos'");
    if (artTable.length === 0) {
      // Migrar desde esquema v1
      database.run(`
        CREATE TABLE articulos (
          id_articulo TEXT PRIMARY KEY,
          nombre TEXT NOT NULL UNIQUE
        );
        CREATE TRIGGER IF NOT EXISTS trg_articulos_no_update_id
        BEFORE UPDATE OF id_articulo ON articulos
        BEGIN
          SELECT RAISE(ABORT, 'El identificador id_articulo (ART-XXX) es generado por la base de datos y no es modificable.');
        END;
      `);

      const mapArt = new Map();
      const registerLegacy = (rawStr) => {
        const s = String(rawStr || '').trim();
        if (!s) return 'ART-001';
        const parts = s.split('|').map(x => x.trim());
        let id = parts.length > 1 ? parts[0] : '';
        let nombre = parts.length > 1 ? parts.slice(1).join(' | ') : parts[0];
        if (mapArt.has(nombre.toLowerCase())) return mapArt.get(nombre.toLowerCase());
        if (!/^ART-\d+$/i.test(id)) {
          id = getNextArticuloIdOn(database);
        }
        database.run('INSERT OR IGNORE INTO articulos (id_articulo, nombre) VALUES (?, ?)', [id, nombre]);
        mapArt.set(nombre.toLowerCase(), id);
        return id;
      };

      const oldEsc = queryAllOn(database, 'SELECT * FROM escalas_reales');
      const oldReg = queryAllOn(database, 'SELECT * FROM registro_costos');
      database.run('DROP TABLE escalas_reales; DROP TABLE registro_costos;');
      database.run(`
        CREATE TABLE escalas_reales (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          fecha TEXT NOT NULL,
          id_articulo TEXT NOT NULL REFERENCES articulos(id_articulo),
          cantidad INTEGER NOT NULL CHECK(cantidad >= 1),
          gramos_lote REAL NOT NULL CHECK(gramos_lote >= 0),
          tiempo_impresion_lote_h REAL NOT NULL CHECK(tiempo_impresion_lote_h >= 0),
          tiempo_preparacion_lote_h REAL NOT NULL CHECK(tiempo_preparacion_lote_h >= 0),
          tiempo_postprocesado_unit_h REAL NOT NULL CHECK(tiempo_postprocesado_unit_h >= 0),
          factor_multiplicador REAL NOT NULL DEFAULT 2.5
        );
        CREATE TABLE registro_costos (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          id_articulo TEXT NOT NULL REFERENCES articulos(id_articulo),
          cantidad INTEGER NOT NULL CHECK(cantidad >= 1),
          factor_multiplicador REAL NOT NULL DEFAULT 2.5
        );
      `);

      for (const r of oldEsc) {
        const idArt = registerLegacy(r.articulo);
        database.run(
          'INSERT INTO escalas_reales (fecha, id_articulo, cantidad, gramos_lote, tiempo_impresion_lote_h, tiempo_preparacion_lote_h, tiempo_postprocesado_unit_h, factor_multiplicador) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
          [r.fecha, idArt, r.cantidad, r.gramos_lote, r.tiempo_impresion_lote_h, r.tiempo_preparacion_lote_h, r.tiempo_postprocesado_unit_h, r.factor_multiplicador]
        );
      }
      for (const r of oldReg) {
        const idArt = registerLegacy(r.articulo);
        database.run(
          'INSERT INTO registro_costos (id_articulo, cantidad, factor_multiplicador) VALUES (?, ?, ?)',
          [idArt, r.cantidad, r.factor_multiplicador]
        );
      }
    }

    // Verificar columna nombre_combo en combos_guardados
    const cmbCols = queryAllOn(database, 'PRAGMA table_info(combos_guardados)').map(c => c.name);
    if (!cmbCols.includes('nombre_combo')) {
      database.run("ALTER TABLE combos_guardados ADD COLUMN nombre_combo TEXT NOT NULL DEFAULT 'Combo Guardado'");
      database.run("UPDATE combos_guardados SET nombre_combo = opcion_elegida WHERE nombre_combo = 'Combo Guardado'");
    }

    // Verificar tabla pedido_items
    const pedItemsTable = queryAllOn(database, "SELECT name FROM sqlite_master WHERE type='table' AND name='pedido_items'");
    if (pedItemsTable.length === 0) {
      const oldPeds = queryAllOn(database, 'SELECT * FROM pedidos');
      database.run('DROP TABLE pedidos;');
      database.run(`
        CREATE TABLE pedidos (
          id TEXT PRIMARY KEY,
          fecha TEXT NOT NULL,
          cliente TEXT NOT NULL,
          estado TEXT NOT NULL
        );
        CREATE TABLE pedido_items (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          pedido_id TEXT NOT NULL REFERENCES pedidos(id) ON DELETE CASCADE,
          tipo_item TEXT NOT NULL DEFAULT 'articulo',
          ref_id TEXT NOT NULL,
          descripcion TEXT NOT NULL,
          cantidad INTEGER NOT NULL CHECK(cantidad >= 1),
          precio_unitario REAL NOT NULL CHECK(precio_unitario >= 0)
        );
      `);
      for (const p of oldPeds) {
        database.run('INSERT INTO pedidos (id, fecha, cliente, estado) VALUES (?, ?, ?, ?)', [p.id, p.fecha, p.cliente, p.estado]);
        database.run(
          'INSERT INTO pedido_items (pedido_id, tipo_item, ref_id, descripcion, cantidad, precio_unitario) VALUES (?, ?, ?, ?, ?, ?)',
          [p.id, 'articulo', p.id_articulo || 'ART-001', p.nombre_articulo || 'Artículo', p.cantidad || 1, p.precio_unitario || 0]
        );
      }
    }

    // Recrear vistas actualizadas
    database.run(`
      DROP VIEW IF EXISTS v_catalogo_articulos;
      CREATE VIEW v_catalogo_articulos AS
      SELECT a.id_articulo, a.nombre, (a.id_articulo || ' | ' || a.nombre) AS articulo
      FROM articulos a
      ORDER BY a.id_articulo ASC;

      DROP VIEW IF EXISTS v_pedidos;
      CREATE VIEW v_pedidos AS
      SELECT
          p.id,
          p.fecha,
          p.cliente,
          p.estado,
          COUNT(pi.id) AS cant_items,
          COALESCE(SUM(pi.cantidad), 0) AS total_piezas,
          ROUND(COALESCE(SUM(pi.cantidad * pi.precio_unitario), 0), 2) AS total_uyu
      FROM pedidos p
      LEFT JOIN pedido_items pi ON pi.pedido_id = p.id
      GROUP BY p.id, p.fecha, p.cliente, p.estado;
    `);
  }

  async function init() {
    SQL = await initSqlJs({
      locateFile: file => `https://cdnjs.cloudflare.com/ajax/libs/sql.js/1.10.3/${file}`
    });

    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved) {
      try {
        db = new SQL.Database(base64ToUint8(saved));
        db.exec('SELECT COUNT(*) FROM parametros_base');
        ensureSchemaUpgraded(db);
        saveToStorage();
        return;
      } catch (e) {
        console.warn('Base guardada corrupta, restaurando semilla...', e);
      }
    }

    db = new SQL.Database();
    seedDatabase(db);
    saveToStorage();
  }

  function queryAll(sql, params = []) {
    return queryAllOn(db, sql, params);
  }

  function run(sql, params = []) {
    db.run(sql, params);
    saveToStorage();
  }

  function execRaw(sql) {
    const results = db.exec(sql);
    saveToStorage();
    return results;
  }

  function exportBinary() {
    return db.export();
  }

  function importBinary(arrayBuffer) {
    const bytes = new Uint8Array(arrayBuffer);
    const testDb = new SQL.Database(bytes);
    testDb.exec('SELECT COUNT(*) FROM parametros_base');
    ensureSchemaUpgraded(testDb);
    db.close();
    db = testDb;
    saveToStorage();
  }

  function resetToExcelSeed() {
    if (db) db.close();
    db = new SQL.Database();
    seedDatabase(db);
    saveToStorage();
  }

  function getNextArticuloId() {
    return getNextArticuloIdOn(db);
  }

  return {
    init,
    queryAll,
    run,
    execRaw,
    exportBinary,
    importBinary,
    resetToExcelSeed,
    getNextArticuloId,
    getOrCreateArticulo,
    updateArticuloNombre
  };
})();
